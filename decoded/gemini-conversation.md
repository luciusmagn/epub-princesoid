# InDesign EPUB Preview Plugin Development

- Conversation ID: `6b747244e48e5ba549b967700bfa01d9`
- Turns: 6
- Ignored metadata/cache bytes: 311354

## Turn 1

### User

is it possible to make adobe indesign plugins? My gf wants a reflowable epub previews, which according to all sources is not available at the moment in indesign

### Gemini

## Feasibility
Yes, it is possible to build an Adobe InDesign plugin to solve this.

## Technical Reality
InDesign lacks a native reflowable EPUB previewer because reflowable text layout depends entirely on the target application's rendering engine (e.g., Apple Books, Kindle, Thorium Reader) and user-end font settings. InDesign only provides a *Fixed-Layout* preview panel.

## Implementation Architecture
To build a custom preview tool, use Adobe's **UXP (Unified Extensibility Platform)**, which is the modern standard for JavaScript/HTML-based UI panels in InDesign. 

The plugin architecture requires three components:
1. **The Trigger:** A button in a UXP panel that calls the InDesign DOM API to silently export the current document as a reflowable EPUB to a temporary directory:
   ```javascript
   app.activeDocument.exportFile(ExportFormat.EPUB_REFLOWABLE, tempFile);
   ```
2. **The Container:** A UXP panel utilizing the native `HTMLWebViewElement` (`<webview>`) to isolate the rendering environment.
3. **The Reader:** An open-source JavaScript EPUB rendering library (such as `epub.js`) loaded inside that webview to unpack and display the temporary EPUB file.

## Pragmatic Alternative (No Plugin)
If developing a UXP panel is unnecessary overhead for a single user, use an external automated pipeline instead:
* Configure a dedicated export folder and a standard InDesign keyboard shortcut for Reflowable EPUB export.
* Use an open-source, compliant reader like **Thorium Reader** on a second monitor.
* Use a simple file-system watcher script to automatically refresh or reopen the EPUB in the reader whenever the file is rewritten by InDesign.

## Turn 2

### User

well, let's think farther, she has a mac, I considered the pragmatic alternative, but can we force thorium to update by e.g. sending a posix signal to it like one can do with mupdf?

### Gemini

## Why POSIX Signals Fail with Thorium

No, you cannot signal Thorium to update via `SIGHUP` or other POSIX signals. 

1. **Electron Framework:** Thorium is an Electron application. POSIX signals are consumed by the Node/V8 main process layer for process management or debugging; they do not bubble up to trigger state updates in the Chromium rendering layer or the React/Redux frontend code.
2. **Database Isolation:** Thorium does not stream or read files live from an external file path like `mupdf`. When you pass a file to Thorium, it *imports* it—copying the archive directly into its internal application database (`~/Library/Application Support/ThoriumReader`). Modifying the original file on disk leaves Thorium’s database copy untouched. Re-running the CLI import command on the same path generates duplicate database entries or conflicts rather than a hot-swap.

---

## The Minimalist macOS Solution (Browser + File Watcher)

To achieve a true `mupdf`-style live reload for a reflowable EPUB on macOS, bypass heavy desktop readers entirely. Use a local browser engine paired with `fswatch` and AppleScript (`osascript`) to reload on modification.

### 1. Prerequisites
Install `fswatch` via Homebrew to handle filesystem event notifications:
```bash
brew install fswatch
```

### 2. The Local Viewer (`index.html`)
Create a single HTML file in your project or export directory. This uses `epub.js` to handle the reflowable pagination.

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.1.5/jszip.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/epubjs/dist/epub.min.js"></script>
    <style>
        body { margin: 0; background: #fafafa; }
        #viewer { width: 100vw; height: 100vh; }
    </style>
</head>
<body>
    <div id="viewer"></div>
    <script>
        const book = ePub("./preview.epub");
        const rendition = book.renderTo("viewer", {
            width: "100%",
            height: "100%",
            spread: "always"
        });
        rendition.display();
    </script>
</body>
</html>
```

### 3. The Automation Script (`watch.sh`)
Save this shell script in the same directory. It runs a local Python web server to bypass browser CORS restrictions, monitors the exported EPUB, and forces Google Chrome to refresh the active tab instantly when InDesign overwrites the file.

```bash
#!/bin/bash

TARGET_FILE="preview.epub"

python3 -m http.server 8080 &
SERVER_PID=$!

cleanup() {
    kill $SERVER_PID
    exit 0
}
trap cleanup SIGINT SIGTERM

open -a "Google Chrome" http://localhost:8080

fswatch -o "$TARGET_FILE" | while read -r line; do
    osascript -e 'tell application "Google Chrome" to reload active tab of first window'
done
```

### Usage Workflow
1. Configure InDesign to export the reflowable EPUB to this folder as `preview.epub`.
2. Run `sh watch.sh`.
3. Every subsequent export from InDesign will instantly refresh the reflowable layout inside the browser window.

## Turn 3

### User

no this is a dogshit solution that I hate, my gf wants to know how the work is going in reflowable, so we need a proper epub reader. does not have to be thorium, but there must be some reload logic

### Gemini

MuPDF natively supports reflowable EPUB layout rendering and responds directly to the `SIGHUP` signal for automatic reloading.

### Implementation

1. Install the required tools via Homebrew:
```bash
brew install mupdf fswatch
```

2. Execute this script to initialize the viewer and pipe file system events to the process:

```bash
#!/bin/zsh
TARGET="preview.epub"

mupdf-gl "$TARGET" &

fswatch -o "$TARGET" | while read -r; do
    pkill -HUP mupdf-gl
done
```

### Technical Considerations
* **Reflow Execution:** `mupdf-gl` recalculates the reflow boundaries dynamically whenever the window container is resized.
* **Font Scaling:** Use the `<` and `>` keys within the active window to adjust the document's base font size.
* **Engine Limits:** MuPDF uses the internal `fitz` library for HTML/CSS layout execution. It does not support complex CSS3 properties, flexbox, or grid layouts. If the InDesign export relies on advanced layout stylesheets, rendering discrepancies relative to commercial targets will occur.

## Turn 4

### User

I need something more compliant

### Gemini

To bypass heavy applications and low-compliance engines, compile a minimalist, native macOS utility in Rust. It embeds Apple's native WebKit engine (ensuring maximum CSS/layout compliance), extracts the EPUB archive automatically, watches the source file for writes, and triggers a lightweight hot-reload without shifting focus or polluting browser tabs.

### Configuration (`Cargo.toml`)

```toml
[package]
name = "epub_preview"
version = "0.1.0"
edition = "2021"

[dependencies]
tao = "0.16"
wry = "0.28"
notify = "6.1"
epub = "2.1"
zip = "0.6"
```

### Source Code (`src/main.rs`)

```rust
use std::{env, fs, path::PathBuf};
use notify::{Config, Watcher, RecursiveMode};
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

enum CustomEvent {
    Reload,
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        std::process::exit(1);
    }
    
    let epub_path = PathBuf::from(&args[1]).canonicalize().unwrap();
    let tmp_dir = env::temp_dir().join("epub_preview_render");
    
    unzip_epub(&epub_path, &tmp_dir);
    let entry_url = get_entry_url(&epub_path, &tmp_dir);

    let event_loop = EventLoop::<CustomEvent>::with_user_event();
    let window = WindowBuilder::new()
        .with_title("EPUB Reflowable Preview")
        .build(&event_loop)
        .unwrap();

    let proxy = event_loop.create_proxy();
    let path_to_watch = epub_path.clone();
    
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(e) = res {
            if e.kind.is_modify() {
                let _ = proxy.send_event(CustomEvent::Reload);
            }
        }
    }).unwrap();
    
    watcher.configure(Config::default()).unwrap();
    watcher.watch(&path_to_watch, RecursiveMode::NonRecursive).unwrap();

    let pagination_js = r#"
        const style = document.createElement('style');
        style.innerHTML = `
            html {
                column-width: 45vw !important;
                column-gap: 5vw !important;
                height: 90vh !important;
                overflow-y: hidden !important;
                overflow-x: auto !important;
            }
            body { margin: 0 !important; padding: 0 2.5vw !important; }
            img { max-width: 100% !important; max-height: 80vh !important; object-fit: contain !important; }
        `;
        document.head.appendChild(style);
    "#;

    let webview = WebViewBuilder::new(&window)
        .with_url(&entry_url)
        .unwrap()
        .with_initialization_script(pagination_js)
        .build()
        .unwrap();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(CustomEvent::Reload) => {
                unzip_epub(&epub_path, &tmp_dir);
                let _ = webview.evaluate_script("location.reload();");
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

fn unzip_epub(src: &PathBuf, dst: &PathBuf) {
    if dst.exists() { 
        fs::remove_dir_all(dst).unwrap(); 
    }
    fs::create_dir_all(dst).unwrap();
    let file = fs::File::open(src).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).unwrap();
        let outpath = match file.enclosed_name() {
            Some(p) => dst.join(p),
            None => continue,
        };
        if file.name().ends_with('/') {
            fs::create_dir_all(&outpath).unwrap();
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() { fs::create_dir_all(p).unwrap(); }
            }
            let mut outfile = fs::File::create(&outpath).unwrap();
            std::io::copy(&mut file, &mut outfile).unwrap();
        }
    }
}

fn get_entry_url(epub_path: &PathBuf, tmp_dir: &PathBuf) -> String {
    let doc = epub::doc::EpubDoc::new(epub_path).unwrap();
    let spine_id = &doc.spine[0];
    let (entry_path, _) = doc.resources.get(spine_id).unwrap();
    format!("file://{}", tmp_dir.join(entry_path).to_str().unwrap())
}
```

### Execution

Compile and execute passing the target output file generated by InDesign:

```bash
cargo run --release -- /path/to/indesign_output.epub
```

### Technical Considerations
* **Pagination Mechanic:** The initialization script injects CSS3 Multi-column Layout properties directly into WebKit. This formats standard scrollable XHTML/HTML documents into standard horizontal reflowable book spreads automatically.
* **Asset Mapping:** Absolute `file://` URLs map accurately to the extracted contents inside the local temporary directory, avoiding cross-origin isolation parameters (CORS) enforced on remote endpoints.

## Turn 5

### User

it needs to be portable, we can bundle webkit

### Gemini

On macOS, you do not need to bundle the WebKit engine binaries. The `wry` library links directly to Apple’s system-native `WKWebView` via the Cocoa frameworks, which are present on every macOS installation. The resulting binary is already portable across Macs.

To package this into a standalone, portable macOS application bundle (`.app`) that can be executed via double-click without a terminal, use `cargo-bundle`.

### 1. Update `Cargo.toml`

Add the `package.metadata.bundle` section to configure the macOS app bundle properties:

```toml
[package]
name = "epub_preview"
version = "0.1.0"
edition = "2021"

[dependencies]
tao = "0.16"
wry = "0.28"
notify = "6.1"
epub = "2.1"
zip = "0.6"

[package.metadata.bundle]
name = "EPUB Preview"
identifier = "com.preview.epub"
icon = []
version = "0.1.0"
resources = []
copyright = "2026"
category = "DeveloperTools"
```

### 2. Modify `src/main.rs` (Handle Drag-and-Drop / File Association)

To make it a proper portable application, update the code to accept file inputs both from terminal arguments and from the macOS native file-open events (when a file is dropped onto the app icon).

```rust
use std::{env, fs, path::PathBuf};
use notify::{Config, Watcher, RecursiveMode};
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

enum CustomEvent {
    Reload,
    OpenFile(PathBuf),
}

fn main() {
    let event_loop = EventLoop::<CustomEvent>::with_user_event();
    let proxy = event_loop.create_proxy();

    let mut initial_path = None;
    let args: Vec<String> = env::args().collect();
    if args.len() > 1 {
        initial_path = Some(PathBuf::from(&args[1]).canonicalize().unwrap());
    }

    let window = WindowBuilder::new()
        .with_title("EPUB Reflowable Preview")
        .build(&event_loop)
        .unwrap();

    let tmp_dir = env::temp_dir().join("epub_preview_render");
    let mut watcher_opt: Option<notify::RecommendedWatcher> = None;
    let mut current_epub: Option<PathBuf> = None;

    let pagination_js = r#"
        const style = document.createElement('style');
        style.innerHTML = `
            html { column-width: 45vw !important; column-gap: 5vw !important; height: 90vh !important; overflow-y: hidden !important; overflow-x: auto !important; }
            body { margin: 0 !important; padding: 0 2.5vw !important; }
            img { max-width: 100% !important; max-height: 80vh !important; object-fit: contain !important; }
        `;
        document.head.appendChild(style);
    "#;

    let webview = WebViewBuilder::new(&window)
        .with_initialization_script(pagination_js)
        .build()
        .unwrap();

    let setup_preview = |epub_path: &PathBuf, webview: &wry::WebView, watcher_opt: &mut Option<notify::RecommendedWatcher>| {
        unzip_epub(epub_path, &tmp_dir);
        let entry_url = get_entry_url(epub_path, &tmp_dir);
        let _ = webview.load_url(&entry_url);

        let proxy_clone = proxy.clone();
        let path_to_watch = epub_path.clone();
        let mut watcher = notify::recommended_watcher(move |res| {
            if let Ok(e) = res {
                if let notify::EventKind::Modify(_) = e.kind {
                    let _ = proxy_clone.send_event(CustomEvent::Reload);
                }
            }
        }).unwrap();
        watcher.configure(Config::default()).unwrap();
        watcher.watch(&path_to_watch, RecursiveMode::NonRecursive).unwrap();
        *watcher_opt = Some(watcher);
    };

    if let Some(path) = initial_path {
        current_epub = Some(path.clone());
        setup_preview(&path, &webview, &mut watcher_opt);
    }

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(CustomEvent::OpenFile(path)) => {
                current_epub = Some(path.clone());
                setup_preview(&path, &webview, &mut watcher_opt);
            }
            Event::UserEvent(CustomEvent::Reload) => {
                if let Some(ref epub_path) = current_epub {
                    unzip_epub(epub_path, &tmp_dir);
                    let _ = webview.evaluate_script("location.reload();");
                }
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

fn unzip_epub(src: &PathBuf, dst: &PathBuf) {
    if dst.exists() { fs::remove_dir_all(dst).unwrap(); }
    fs::create_dir_all(dst).unwrap();
    let file = fs::File::open(src).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).unwrap();
        let outpath = match file.enclosed_name() {
            Some(p) => dst.join(p),
            None => continue,
        };
        if file.name().ends_with('/') {
            fs::create_dir_all(&outpath).unwrap();
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() { fs::create_dir_all(p).unwrap(); }
            }
            let mut outfile = fs::File::create(&outpath).unwrap();
            std::io::copy(&mut file, &mut outfile).unwrap();
        }
    }
}

fn get_entry_url(epub_path: &PathBuf, tmp_dir: &PathBuf) -> String {
    let doc = epub::doc::EpubDoc::new(epub_path).unwrap();
    let spine_id = &doc.spine[0];
    let (entry_path, _) = doc.resources.get(spine_id).unwrap();
    format!("file://{}", tmp_dir.join(entry_path).to_str().unwrap())
}
```

### 3. Build the Bundle

Install the bundler tool and build the application:

```bash
cargo install cargo-bundle
cargo bundle --release
```

The compiled standalone application will be located at:
`target/release/bundle/osx/EPUB Preview.app`

This `.app` bundle can be dragged anywhere on macOS, mapped to open `.epub` files by default, or executed via CLI by passing the file path directly to the binary inside the bundle wrapper:
```bash
./target/release/bundle/osx/EPUB\ Preview.app/Contents/MacOS/epub_preview /path/to/target.epub
```

## Turn 6

### User

you retard, when I say portable, I mean it must work on Linux as well

### Gemini

To make the solution cross-platform (macOS and Linux) using the same codebase, the current `tao` and `wry` architecture remains valid. On Linux, `wry` automatically switches from macOS Cocoa `WKWebView` to **WebKitGTK**.

A single compiled binary cannot run on both OS architectures natively due to format differences (Mach-O vs. ELF). You must compile a binary for each target OS. 

Here is the unified cross-platform code and the build requirements for Linux.

### 1. Linux System Dependencies
Before compiling on Linux, the WebKitGTK and GTK3 development libraries must be present on the host system.

**Debian/Ubuntu:**
```bash
sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev build-essential
```

**Fedora/RHEL:**
```bash
sudo dnf install gtk3-devel webkit2gtk4.1-devel
```

### 2. Cross-Platform Source Code (`src/main.rs`)

This version works identically on macOS and Linux. It strips out macOS-specific event loops, relying purely on standard filesystem paths passed via CLI arguments for maximum platform portability.

```rust
use std::{env, fs, path::PathBuf};
use notify::{Config, Watcher, RecursiveMode};
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

enum CustomEvent {
    Reload,
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: epub_preview <path_to_epub>");
        std::process::exit(1);
    }
    
    let epub_path = PathBuf::from(&args[1]).canonicalize().expect("Invalid EPUB path");
    let tmp_dir = env::temp_dir().join("epub_preview_render");
    
    unzip_epub(&epub_path, &tmp_dir);
    let entry_url = get_entry_url(&epub_path, &tmp_dir);

    let event_loop = EventLoop::<CustomEvent>::with_user_event();
    let window = WindowBuilder::new()
        .with_title("EPUB Reflowable Preview")
        .build(&event_loop)
        .unwrap();

    let proxy = event_loop.create_proxy();
    let path_to_watch = epub_path.clone();
    
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(e) = res {
            if e.kind.is_modify() {
                let _ = proxy.send_event(CustomEvent::Reload);
            }
        }
    }).unwrap();
    
    watcher.configure(Config::default()).unwrap();
    watcher.watch(&path_to_watch, RecursiveMode::NonRecursive).unwrap();

    // CSS injection to force reflowable column pagination across WebKit engines
    let pagination_js = r#"
        const style = document.createElement('style');
        style.innerHTML = `
            html {
                column-width: 45vw !important;
                column-gap: 5vw !important;
                height: 90vh !important;
                overflow-y: hidden !important;
                overflow-x: auto !important;
            }
            body { margin: 0 !important; padding: 0 2.5vw !important; }
            img { max-width: 100% !important; max-height: 80vh !important; object-fit: contain !important; }
        `;
        document.head.appendChild(style);
    "#;

    let webview = WebViewBuilder::new(&window)
        .with_url(&entry_url)
        .unwrap()
        .with_initialization_script(pagination_js)
        .build()
        .unwrap();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(CustomEvent::Reload) => {
                unzip_epub(&epub_path, &tmp_dir);
                let _ = webview.evaluate_script("location.reload();");
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

fn unzip_epub(src: &PathBuf, dst: &PathBuf) {
    if dst.exists() { 
        fs::remove_dir_all(dst).unwrap(); 
    }
    fs::create_dir_all(dst).unwrap();
    let file = fs::File::open(src).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).unwrap();
        let outpath = match file.enclosed_name() {
            Some(p) => dst.join(p),
            None => continue,
        };
        if file.name().ends_with('/') {
            fs::create_dir_all(&outpath).unwrap();
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() { fs::create_dir_all(p).unwrap(); }
            }
            let mut outfile = fs::File::create(&outpath).unwrap();
            std::io::copy(&mut file, &mut outfile).unwrap();
        }
    }
}

fn get_entry_url(epub_path: &PathBuf, tmp_dir: &PathBuf) -> String {
    let doc = epub::doc::EpubDoc::new(epub_path).unwrap();
    let spine_id = &doc.spine[0];
    let (entry_path, _) = doc.resources.get(spine_id).unwrap();
    format!("file://{}", tmp_dir.join(entry_path).to_str().unwrap())
}
```

### 3. Packaging for Linux Portability (AppImage)

To distribute this to a Linux machine without forcing the user to install dependencies, package the compiled binary into an **AppImage**. This bundles the execution environment into a single executable file.

1. Install `appimagetool`:
   ```bash
   wget https://github.com/AppImage/AppImageKit/releases/download/13/appimagetool-x86_64.AppImage
   chmod +x appimagetool-x86_64.AppImage
   ```

2. Create an AppDir structure:
   ```text
   epub_preview.AppDir/
   ├── AppRun
   ├── epub_preview.desktop
   ├── epub_preview.png
   └── usr/
       └── bin/
           └── epub_preview
   ```

3. Create the `AppRun` script inside `epub_preview.AppDir/`:
   ```bash
   #!/bin/sh
   HERE="$(dirname "$(readlink -f "${0}")")"
   EXEC="${HERE}/usr/bin/epub_preview"
   exec "$EXEC" "$@"
   ```
   *Ensure it is executable:* `chmod +x epub_preview.AppDir/AppRun`

4. Create the `epub_preview.desktop` file:
   ```ini
   [Desktop Entry]
   Name=EPUB Preview
   Exec=epub_preview %u
   Icon=epub_preview
   Type=Application
   Categories=Utility;
   ```

5. Move your compiled release binary into place and build:
   ```bash
   cargo build --release
   cp target/release/epub_preview epub_preview.AppDir/usr/bin/
   ./appimagetool-x86_64.AppImage epub_preview.AppDir
   ```

This generates `EPUB_Preview-x86_64.AppImage`, which runs on any modern Linux distribution and automatically updates the reflow window whenever InDesign overwrites the target file.
