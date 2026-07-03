# Princeznoid EPUB Preview

Rust/Wry EPUB previewer for reflowable InDesign exports. It opens an EPUB in a desktop reader, watches the same file on disk, and reloads the reader when the file is overwritten.

## Commands

```bash
cargo run -- /path/to/preview.epub
cargo build --release
```

On Linux, Wry uses WebKitGTK. Debian/Ubuntu packages are typically:

```bash
sudo apt install build-essential libgtk-3-dev libwebkit2gtk-4.0-dev
```

On macOS, Wry uses the system `WKWebView`.

## Workflow

1. Export the InDesign document to a stable path, for example `preview.epub`.
2. Open that file in Princeznoid.
3. Keep exporting to the same path. The reader reloads after the file write settles and keeps the current reading location when possible.

## Notes

The native app is Rust. The webview contains a small bundled HTML/CSS/JS reader layer because EPUB layout is delegated to `epub.js` running inside WebKit. The vendored reader runtime is pinned to `epub.js` 0.3.93 with `JSZip` 3.7.1.
