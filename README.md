# Princeznoid Proof

Desktop proofing for InDesign PDF exports, with the existing EPUB reader-preview mode. The native app is Rust/Wry; its bundled webview displays the page and findings. Opening a PDF runs the checks in the background. Re-exporting to the same path reloads and checks it again.

## Run

```bash
cargo run -- /path/to/export.pdf
cargo run -- /path/to/preview.epub
cargo run -- --check-pdf /path/to/export.pdf auto
cargo run -- --pdf-meta /path/to/export.pdf
cargo build --release
```

PDF proofing needs `mutool` (MuPDF), `pdfimages` (Poppler), and `hunspell` on `PATH`. The app bundles its spelling dictionaries and TeX hyphenation patterns. On Debian/Ubuntu, the native and PDF dependencies are typically:

```bash
sudo apt install build-essential libgtk-3-dev libwebkit2gtk-4.0-dev mupdf-tools poppler-utils hunspell
```

On Linux, Wry uses WebKitGTK. On macOS it uses `WKWebView`; install the three PDF command-line tools separately.

## PDF Checks

- End-of-line word breaks against TeX patterns and Hunspell spelling.
- Spelling, spaced hyphens used as dashes, Czech quotation marks, and double spaces.
- Possible widows and orphans at page boundaries.
- Contents page numbers against PDF page labels, bookmarks, and target headings.
- Placed raster images below 300 effective ppi.
- Paragraphs that appear to be in another language and pages with no extractable text.

Select a finding to jump to and zoom in on its page; the arrow buttons step through the visible findings. Text findings use character positions for a precise marker when the PDF exposes them; double spaces are shown as dots in the finding excerpt. The `+` beside a spelling finding accepts that word globally. The `Words` button opens a searchable manager for adding and removing accepted words without taking space from the findings list. The `x` button ignores one finding for the current file. Both lists persist locally. The proofing language can be auto-detected or set to English, Czech, Spanish, or German. `Braiins`, `frontend`, and `backend` (including their plurals) are built-in accepted spellings. The EPUB view still includes its reader presets, margins, and debug page logs.

Run `cargo test` and `node tools/test_pdf_ui.cjs` for the focused scanner and UI checks.

These are review candidates, not definitive typesetting errors. PDF text extraction may lose spacing or paragraph structure; outlined, rasterized, or otherwise non-extractable lettering cannot be spell-checked. This version does not OCR artwork, call an AI service, validate color space, or parse `.indd` directly. Color-space validation is deferred until the print requirement is specified. The page image is rendered on demand, so the 300 ppi check uses the image's original dimensions and placed size rather than the preview resolution.

The bundled Hunspell dictionaries come from the [LibreOffice dictionaries repository](https://github.com/LibreOffice/dictionaries); their license notices are in `assets/dictionaries/`. The EPUB renderer bundles epub.js 0.3.93 and JSZip 3.7.1.
