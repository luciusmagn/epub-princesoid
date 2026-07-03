use anyhow::{anyhow, Context, Result};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    fs::{self, File},
    io,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, UNIX_EPOCH},
};
use wry::{
    application::{
        dpi::LogicalSize,
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoop, EventLoopProxy},
        window::{Window, WindowBuilder},
    },
    http::{header::CONTENT_TYPE, Request, Response, StatusCode},
    webview::{FileDropEvent, WebView, WebViewBuilder},
};

const INDEX_HTML: &str = include_str!("../assets/index.html");
const APP_JS: &str = include_str!("../assets/app.js");
const STYLES_CSS: &str = include_str!("../assets/styles.css");
const JSZIP_JS: &[u8] = include_bytes!("../assets/vendor/jszip.min.js");
const EPUB_JS: &[u8] = include_bytes!("../assets/vendor/epub.min.js");
static UNPACK_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
enum UserEvent {
    OpenDialog,
    OpenFile(PathBuf),
    FileChanged,
    DropVisible(bool),
    NativeError(String),
}

#[derive(Debug, Deserialize)]
struct IpcMessage {
    command: String,
    level: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
struct OpenPayload {
    name: String,
    path: String,
    size: u64,
    url: String,
}

#[derive(Clone, Debug)]
struct OpenBook {
    path: PathBuf,
    root: PathBuf,
}

type SharedBook = Arc<Mutex<Option<OpenBook>>>;

fn main() -> Result<()> {
    let event_loop = EventLoop::<UserEvent>::with_user_event();
    let proxy = event_loop.create_proxy();
    let current_book: SharedBook = Arc::new(Mutex::new(None));
    let initial_path = std::env::args().skip(1).find_map(|arg| {
        let path = PathBuf::from(arg);
        path.extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("epub"))
            .then_some(path)
    });

    let window = WindowBuilder::new()
        .with_title("Princeznoid EPUB Preview")
        .with_inner_size(LogicalSize::new(1320.0, 860.0))
        .with_min_inner_size(LogicalSize::new(960.0, 640.0))
        .build(&event_loop)
        .context("failed to create window")?;

    let webview = build_webview(window, proxy.clone(), current_book.clone())?;
    let mut watcher: Option<RecommendedWatcher> = None;

    if let Some(path) = initial_path {
        open_epub_path(
            path,
            &webview,
            &proxy,
            &current_book,
            &mut watcher,
            "openFromNative",
            true,
        );
    }

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            Event::UserEvent(UserEvent::OpenDialog) => {
                eprintln!("open dialog requested");
                if let Some(path) = pick_epub_file() {
                    eprintln!("open dialog selected {}", path.display());
                    open_epub_path(
                        path,
                        &webview,
                        &proxy,
                        &current_book,
                        &mut watcher,
                        "openFromNative",
                        true,
                    );
                } else {
                    eprintln!("open dialog returned no file");
                }
            }
            Event::UserEvent(UserEvent::OpenFile(path)) => {
                eprintln!("open file requested {}", path.display());
                open_epub_path(
                    path,
                    &webview,
                    &proxy,
                    &current_book,
                    &mut watcher,
                    "openFromNative",
                    true,
                );
            }
            Event::UserEvent(UserEvent::FileChanged) => {
                if let Some(path) = current_book
                    .lock()
                    .ok()
                    .and_then(|guard| guard.as_ref().map(|book| book.path.clone()))
                {
                    open_epub_path(
                        path,
                        &webview,
                        &proxy,
                        &current_book,
                        &mut watcher,
                        "reloadFromNative",
                        false,
                    );
                }
            }
            Event::UserEvent(UserEvent::DropVisible(visible)) => {
                let script = format!("window.Princeznoid.setDropVisible({visible});");
                let _ = webview.evaluate_script(&script);
            }
            Event::UserEvent(UserEvent::NativeError(message)) => {
                let escaped =
                    serde_json::to_string(&message).unwrap_or_else(|_| "\"Native error\"".into());
                let _ =
                    webview.evaluate_script(&format!("window.Princeznoid.showError({escaped});"));
            }
            _ => {}
        }
    });
}

fn build_webview(
    window: Window,
    proxy: EventLoopProxy<UserEvent>,
    current_book: SharedBook,
) -> Result<WebView> {
    let protocol_book = current_book.clone();
    let ipc_proxy = proxy.clone();
    let drop_proxy = proxy;

    let builder = WebViewBuilder::new(window)?
        .with_custom_protocol(
            "princeznoid".into(),
            move |request| match protocol_response(request, protocol_book.clone()) {
                Ok(response) => Ok(response),
                Err(error) => Ok(error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &error.to_string(),
                )),
            },
        )
        .with_ipc_handler(move |_window: &Window, request: String| {
            eprintln!("ipc message: {request}");
            match serde_json::from_str::<IpcMessage>(&request) {
                Ok(message) if message.command == "open-dialog" => {
                    let _ = ipc_proxy.send_event(UserEvent::OpenDialog);
                }
                Ok(message) if message.command == "renderer-log" => {
                    let level = message.level.as_deref().unwrap_or("log");
                    let text = message.message.as_deref().unwrap_or("");
                    eprintln!("renderer {level}: {text}");
                }
                Ok(_) => {}
                Err(error) => {
                    let _ = ipc_proxy.send_event(UserEvent::NativeError(error.to_string()));
                }
            }
        })
        .with_file_drop_handler(move |_window: &Window, event| {
            match event {
                FileDropEvent::Hovered(_) => {
                    let _ = drop_proxy.send_event(UserEvent::DropVisible(true));
                }
                FileDropEvent::Dropped(paths) => {
                    let _ = drop_proxy.send_event(UserEvent::DropVisible(false));
                    if let Some(path) = paths.into_iter().find(|path| is_epub_path(path)) {
                        let _ = drop_proxy.send_event(UserEvent::OpenFile(path));
                    }
                }
                FileDropEvent::Cancelled => {
                    let _ = drop_proxy.send_event(UserEvent::DropVisible(false));
                }
                _ => {}
            }
            true
        })
        .with_url("princeznoid://app/index.html")?;

    builder.build().context("failed to build webview")
}

fn open_epub_path(
    path: PathBuf,
    webview: &WebView,
    proxy: &EventLoopProxy<UserEvent>,
    current_book: &SharedBook,
    watcher: &mut Option<RecommendedWatcher>,
    script_method: &str,
    refresh_watcher: bool,
) {
    match open_epub_path_inner(
        path,
        webview,
        proxy,
        current_book,
        watcher,
        script_method,
        refresh_watcher,
    ) {
        Ok(()) => {}
        Err(error) => show_native_error(webview, error),
    }
}

fn open_epub_path_inner(
    path: PathBuf,
    webview: &WebView,
    proxy: &EventLoopProxy<UserEvent>,
    current_book: &SharedBook,
    watcher: &mut Option<RecommendedWatcher>,
    script_method: &str,
    refresh_watcher: bool,
) -> Result<()> {
    let path = path
        .canonicalize()
        .with_context(|| format!("failed to resolve {}", path.display()))?;

    if !is_epub_path(&path) {
        return Err(anyhow!("not an EPUB: {}", path.display()));
    }

    eprintln!("opening EPUB {}", path.display());
    let root = unpack_epub(&path)?;
    eprintln!("unpacked EPUB to {}", root.display());

    {
        let mut guard = current_book
            .lock()
            .map_err(|_| anyhow!("state lock poisoned"))?;
        *guard = Some(OpenBook {
            path: path.clone(),
            root,
        });
    }

    if refresh_watcher {
        *watcher = Some(start_watcher(path.clone(), proxy.clone())?);
    }

    let payload = payload_for(&path)?;
    webview
        .window()
        .set_title(&format!("Princeznoid - {}", payload.name));
    eval_json_call(webview, script_method, &payload)?;
    eprintln!("sent open payload for {}", payload.name);
    Ok(())
}

fn unpack_epub(path: &Path) -> Result<PathBuf> {
    let sequence = UNPACK_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
    let root = std::env::temp_dir().join(format!(
        "epub-princeznoid-{}-{sequence}",
        std::process::id()
    ));

    if root.exists() {
        fs::remove_dir_all(&root)
            .with_context(|| format!("failed to clear {}", root.display()))?;
    }
    fs::create_dir_all(&root).with_context(|| format!("failed to create {}", root.display()))?;

    let file = File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .with_context(|| format!("failed to read EPUB zip {}", path.display()))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .with_context(|| format!("failed to read zip entry {index}"))?;
        let Some(enclosed_name) = entry.enclosed_name() else {
            continue;
        };
        let outpath = root.join(enclosed_name);

        if entry.is_dir() {
            fs::create_dir_all(&outpath)
                .with_context(|| format!("failed to create {}", outpath.display()))?;
            continue;
        }

        if let Some(parent) = outpath.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }

        let mut outfile = File::create(&outpath)
            .with_context(|| format!("failed to create {}", outpath.display()))?;
        io::copy(&mut entry, &mut outfile)
            .with_context(|| format!("failed to extract {}", outpath.display()))?;
    }

    Ok(root)
}

#[cfg(target_os = "linux")]
fn pick_epub_file() -> Option<PathBuf> {
    use gtk::prelude::*;

    if !gtk::is_initialized() {
        if let Err(error) = gtk::init() {
            eprintln!("gtk init failed for file chooser: {error}");
            return None;
        }
    }

    let dialog = gtk::FileChooserDialog::with_buttons(
        Some("Open EPUB"),
        None::<&gtk::Window>,
        gtk::FileChooserAction::Open,
        &[
            ("Cancel", gtk::ResponseType::Cancel),
            ("Open", gtk::ResponseType::Accept),
        ],
    );
    dialog.set_modal(true);

    let filter = gtk::FileFilter::new();
    filter.set_name(Some("EPUB"));
    filter.add_pattern("*.epub");
    filter.add_pattern("*.EPUB");
    filter.add_mime_type("application/epub+zip");
    dialog.add_filter(&filter);

    let selected = if dialog.run() == gtk::ResponseType::Accept {
        dialog.filename()
    } else {
        None
    };

    dialog.close();
    selected
}

#[cfg(not(target_os = "linux"))]
fn pick_epub_file() -> Option<PathBuf> {
    rfd::FileDialog::new()
        .add_filter("EPUB", &["epub"])
        .set_title("Open EPUB")
        .pick_file()
}

fn payload_for(path: &Path) -> Result<OpenPayload> {
    let stat = fs::metadata(path).with_context(|| format!("failed to stat {}", path.display()))?;
    Ok(OpenPayload {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "preview.epub".into()),
        path: path.to_string_lossy().into_owned(),
        size: stat.len(),
        url: "princeznoid://app/book/".into(),
    })
}

fn start_watcher(path: PathBuf, proxy: EventLoopProxy<UserEvent>) -> Result<RecommendedWatcher> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("cannot watch path without parent: {}", path.display()))?
        .to_path_buf();
    let target_name = path.file_name().map(|name| name.to_owned());
    let sequence = Arc::new(AtomicU64::new(0));
    let callback_sequence = sequence.clone();

    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if !is_change_event(&event.kind) {
            return;
        }
        if let Some(ref target_name) = target_name {
            let touches_target = event.paths.iter().any(|event_path| {
                event_path
                    .file_name()
                    .is_some_and(|name| name == target_name)
            });
            if !touches_target {
                return;
            }
        }

        let ticket = callback_sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let proxy = proxy.clone();
        let path = path.clone();
        let sequence = callback_sequence.clone();

        thread::spawn(move || {
            if wait_until_stable(&path).is_ok() && sequence.load(Ordering::SeqCst) == ticket {
                let _ = proxy.send_event(UserEvent::FileChanged);
            }
        });
    })
    .context("failed to create file watcher")?;

    watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .with_context(|| format!("failed to watch {}", parent.display()))?;

    Ok(watcher)
}

fn is_change_event(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) | EventKind::Any
    )
}

fn wait_until_stable(path: &Path) -> Result<()> {
    let mut previous = None;
    let mut stable_reads = 0;

    for _ in 0..30 {
        if let Ok(stat) = fs::metadata(path) {
            let signature = (
                stat.len(),
                stat.modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis())
                    .unwrap_or_default(),
            );

            if Some(signature) == previous {
                stable_reads += 1;
            } else {
                previous = Some(signature);
                stable_reads = 0;
            }

            if stable_reads >= 2 {
                return Ok(());
            }
        }

        thread::sleep(Duration::from_millis(250));
    }

    Err(anyhow!("file did not settle: {}", path.display()))
}

fn protocol_response(
    request: &Request<Vec<u8>>,
    current_book: SharedBook,
) -> Result<Response<Cow<'static, [u8]>>> {
    let path = request.uri().path();

    match path {
        "/" | "/index.html" => {
            bytes_response("text/html; charset=utf-8", INDEX_HTML.as_bytes().to_vec())
        }
        "/app.js" => bytes_response("text/javascript; charset=utf-8", APP_JS.as_bytes().to_vec()),
        "/styles.css" => bytes_response("text/css; charset=utf-8", STYLES_CSS.as_bytes().to_vec()),
        "/vendor/jszip.min.js" => bytes_response("text/javascript; charset=utf-8", JSZIP_JS.to_vec()),
        "/vendor/epub.min.js" => bytes_response("text/javascript; charset=utf-8", EPUB_JS.to_vec()),
        "/book.epub" => {
            let path = current_book
                .lock()
                .map_err(|_| anyhow!("state lock poisoned"))?
                .as_ref()
                .map(|book| book.path.clone())
                .ok_or_else(|| anyhow!("no EPUB is open"))?;
            let bytes =
                fs::read(&path).with_context(|| format!("failed to read {}", path.display()))?;
            bytes_response("application/epub+zip", bytes)
        }
        _ if path.starts_with("/book/") => book_resource_response(path, current_book),
        _ => Ok(error_response(StatusCode::NOT_FOUND, "not found")),
    }
}

fn book_resource_response(
    request_path: &str,
    current_book: SharedBook,
) -> Result<Response<Cow<'static, [u8]>>> {
    let relative = decode_book_resource_path(request_path)?;
    let root = current_book
        .lock()
        .map_err(|_| anyhow!("state lock poisoned"))?
        .as_ref()
        .map(|book| book.root.clone())
        .ok_or_else(|| anyhow!("no EPUB is open"))?;
    let path = root.join(relative);

    if !path.is_file() {
        return Ok(error_response(StatusCode::NOT_FOUND, "not found"));
    }

    let bytes = fs::read(&path).with_context(|| format!("failed to read {}", path.display()))?;
    bytes_response(mime_for_path(&path), bytes)
}

fn decode_book_resource_path(request_path: &str) -> Result<PathBuf> {
    let encoded = request_path.strip_prefix("/book/").unwrap_or_default();
    let decoded = percent_decode(encoded)?;
    let path = Path::new(&decoded);

    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(anyhow!("invalid book resource path"));
    }

    Ok(path.to_path_buf())
}

fn percent_decode(value: &str) -> Result<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes
                .get(index + 1)
                .and_then(|byte| hex_value(*byte))
                .ok_or_else(|| anyhow!("invalid percent escape"))?;
            let low = bytes
                .get(index + 2)
                .and_then(|byte| hex_value(*byte))
                .ok_or_else(|| anyhow!("invalid percent escape"))?;
            output.push((high << 4) | low);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }

    String::from_utf8(output).context("book resource path is not UTF-8")
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("css") => "text/css; charset=utf-8",
        Some("gif") => "image/gif",
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("js") => "text/javascript; charset=utf-8",
        Some("ncx") | Some("opf") | Some("xml") => "application/xml; charset=utf-8",
        Some("otf") => "font/otf",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("ttf") => "font/ttf",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("xhtml") => "application/xhtml+xml; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn bytes_response(
    content_type: &str,
    bytes: impl Into<Cow<'static, [u8]>>,
) -> Result<Response<Cow<'static, [u8]>>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type)
        .header("Cache-Control", "no-store")
        .body(bytes.into())
        .map_err(Into::into)
}

fn error_response(status: StatusCode, message: &str) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Cow::Owned(message.as_bytes().to_vec()))
        .expect("static error response should build")
}

fn eval_json_call<T: Serialize>(webview: &WebView, method: &str, payload: &T) -> Result<()> {
    let payload = serde_json::to_string(payload)?;
    webview
        .evaluate_script(&format!("window.Princeznoid.{method}({payload});"))
        .map_err(Into::into)
}

fn show_native_error(webview: &WebView, error: anyhow::Error) {
    let message =
        serde_json::to_string(&error.to_string()).unwrap_or_else(|_| "\"Native error\"".into());
    let _ = webview.evaluate_script(&format!("window.Princeznoid.showError({message});"));
}

fn is_epub_path(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
}
