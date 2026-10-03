use anyhow::{anyhow, Context, Result};
use hyphenation::{Hyphenator, Language, Load, Standard};
use lopdf::{Document, Object, ObjectId};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
};
use whatlang::{detect, Lang};

pub const ACCEPTED_WORDS: &[&str] = &["braiins", "frontend", "frontends", "backend", "backends"];

fn accepted_word(word: &str) -> bool {
    ACCEPTED_WORDS
        .iter()
        .any(|accepted| word.eq_ignore_ascii_case(accepted))
}

fn normalized_accepted_words(words: &[String]) -> HashSet<String> {
    words
        .iter()
        .take(1000)
        .map(|word| word.trim().to_lowercase())
        .filter(|word| {
            (2..=64).contains(&word.chars().count()) && word.chars().all(char::is_alphabetic)
        })
        .collect()
}

#[derive(Clone, Debug, Serialize)]
pub struct PdfMeta {
    pub page_count: usize,
    pub labels: Vec<String>,
    pub sizes: Vec<PageSize>,
    pub outline: Vec<OutlineEntry>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PageSize {
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, Serialize)]
pub struct OutlineEntry {
    pub title: String,
    pub page: usize,
    pub level: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, Serialize)]
pub struct Finding {
    pub id: usize,
    pub page: usize,
    pub category: &'static str,
    pub severity: &'static str,
    pub title: String,
    pub detail: String,
    pub excerpt: String,
    pub rect: Option<Rect>,
    pub locator: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScanReport {
    pub language: &'static str,
    pub findings: Vec<Finding>,
    pub checks: Vec<&'static str>,
}

#[derive(Debug, Deserialize)]
struct TextDocument {
    pages: Vec<TextPage>,
}

#[derive(Debug, Deserialize)]
struct TextPage {
    blocks: Vec<TextBlock>,
}

#[derive(Debug, Deserialize)]
struct TextBlock {
    #[serde(rename = "type")]
    kind: String,
    lines: Option<Vec<TextRun>>,
}

#[derive(Debug, Deserialize)]
struct TextRun {
    bbox: TextBox,
    text: String,
    font: Option<TextFont>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
struct TextBox {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

#[derive(Debug, Deserialize)]
struct TextFont {
    name: String,
}

#[derive(Clone, Debug)]
struct VisualLine {
    text: String,
    bbox: TextBox,
    runs: Vec<Run>,
    code: bool,
}

#[derive(Clone, Debug)]
struct Run {
    text: String,
    bbox: TextBox,
}

#[derive(Clone, Debug)]
struct PageText {
    lines: Vec<VisualLine>,
    blocks: Vec<Vec<VisualLine>>,
}

#[derive(Clone, Debug)]
struct LabelRule {
    index: usize,
    style: Vec<u8>,
    start: usize,
    prefix: String,
}

pub fn metadata(path: &Path) -> Result<PdfMeta> {
    let doc =
        Document::load(path).with_context(|| format!("could not read PDF {}", path.display()))?;
    let pages = doc.get_pages();
    if pages.is_empty() {
        return Err(anyhow!("PDF contains no pages"));
    }
    let page_count = pages.len();
    let labels = page_labels(&doc, page_count);
    let sizes = pages.values().map(|id| page_size(&doc, *id)).collect();
    let outline = read_outline(&doc);
    Ok(PdfMeta {
        page_count,
        labels,
        sizes,
        outline,
    })
}

fn read_outline(doc: &Document) -> Vec<OutlineEntry> {
    let pages: HashMap<ObjectId, usize> = doc
        .get_pages()
        .into_iter()
        .map(|(number, id)| (id, number as usize))
        .collect();
    let mut named = HashMap::new();
    if let Ok(catalog) = doc.catalog() {
        if let Ok(names) = catalog
            .get(b"Names")
            .and_then(|object| doc.dereference(object).map(|(_, value)| value))
        {
            if let Ok(tree) = names.as_dict().and_then(|dict| dict.get(b"Dests")) {
                read_named_destinations(doc, tree, &mut named, 0);
            }
        }
    }
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(catalog) = doc.catalog() {
        if let Ok(outlines) = catalog
            .get(b"Outlines")
            .and_then(|object| doc.dereference(object).map(|(_, value)| value))
        {
            if let Ok(first) = outlines
                .as_dict()
                .and_then(|dict| dict.get(b"First"))
                .and_then(Object::as_reference)
            {
                read_outline_chain(doc, first, 1, &pages, &named, &mut seen, &mut entries);
            }
        }
    }
    entries
}

fn read_named_destinations(
    doc: &Document,
    object: &Object,
    names: &mut HashMap<Vec<u8>, ObjectId>,
    depth: usize,
) {
    if depth > 16 {
        return;
    }
    let Ok((_, resolved)) = doc.dereference(object) else {
        return;
    };
    let Ok(dict) = resolved.as_dict() else {
        return;
    };
    if let Ok(entries) = dict.get(b"Names").and_then(Object::as_array) {
        for pair in entries.chunks_exact(2) {
            let Ok(key) = pair[0].as_str() else {
                continue;
            };
            if let Some(page) = destination_page(doc, &pair[1], names, 0) {
                names.insert(key.to_vec(), page);
            }
        }
    }
    if let Ok(kids) = dict.get(b"Kids").and_then(Object::as_array) {
        for kid in kids {
            read_named_destinations(doc, kid, names, depth + 1);
        }
    }
}

fn destination_page(
    doc: &Document,
    object: &Object,
    names: &HashMap<Vec<u8>, ObjectId>,
    depth: usize,
) -> Option<ObjectId> {
    if depth > 12 {
        return None;
    }
    let (_, resolved) = doc.dereference(object).ok()?;
    match resolved {
        Object::Array(values) => values.first()?.as_reference().ok(),
        Object::Dictionary(dict) => destination_page(doc, dict.get(b"D").ok()?, names, depth + 1),
        Object::String(key, _) | Object::Name(key) => names.get(key).copied(),
        _ => None,
    }
}

fn read_outline_chain(
    doc: &Document,
    first: ObjectId,
    level: usize,
    pages: &HashMap<ObjectId, usize>,
    names: &HashMap<Vec<u8>, ObjectId>,
    seen: &mut HashSet<ObjectId>,
    entries: &mut Vec<OutlineEntry>,
) {
    if level > 32 {
        return;
    }
    let mut current = Some(first);
    while let Some(id) = current {
        if !seen.insert(id) {
            break;
        }
        let Ok(node) = doc.get_dictionary(id) else {
            break;
        };
        let title = node
            .get(b"Title")
            .ok()
            .and_then(|obj| obj.as_str().ok())
            .map(decode_pdf_string);
        let destination = node.get(b"Dest").ok().or_else(|| {
            node.get(b"A")
                .ok()
                .and_then(|action| doc.dereference(action).ok())
                .and_then(|(_, action)| action.as_dict().ok())
                .and_then(|action| action.get(b"D").ok())
        });
        if let (Some(title), Some(destination)) = (title, destination) {
            if let Some(page_id) = destination_page(doc, destination, names, 0) {
                if let Some(page) = pages.get(&page_id) {
                    entries.push(OutlineEntry {
                        title,
                        page: *page,
                        level,
                    });
                }
            }
        }
        if let Ok(child) = node.get(b"First").and_then(Object::as_reference) {
            read_outline_chain(doc, child, level + 1, pages, names, seen, entries);
        }
        current = node.get(b"Next").and_then(Object::as_reference).ok();
    }
}

fn decode_pdf_string(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xfe, 0xff]) {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&units)
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn page_labels(doc: &Document, page_count: usize) -> Vec<String> {
    let mut rules = Vec::new();
    if let Ok(catalog) = doc.catalog() {
        if let Ok(object) = catalog.get(b"PageLabels") {
            read_label_rules(doc, object, &mut rules, 0);
        }
    }
    rules.sort_by_key(|rule| rule.index);
    (0..page_count)
        .map(|index| {
            let Some(rule) = rules.iter().rev().find(|rule| rule.index <= index) else {
                return (index + 1).to_string();
            };
            let value = rule.start + index - rule.index;
            let numbered = match rule.style.as_slice() {
                b"R" => roman(value).to_uppercase(),
                b"r" => roman(value),
                b"A" => alpha(value).to_uppercase(),
                b"a" => alpha(value),
                b"D" => value.to_string(),
                _ => String::new(),
            };
            format!("{}{}", rule.prefix, numbered)
        })
        .collect()
}

fn read_label_rules(doc: &Document, object: &Object, rules: &mut Vec<LabelRule>, depth: usize) {
    if depth > 16 {
        return;
    }
    let Ok((_, resolved)) = doc.dereference(object) else {
        return;
    };
    let Ok(dictionary) = resolved.as_dict() else {
        return;
    };
    if let Ok(nums) = dictionary.get(b"Nums").and_then(Object::as_array) {
        for pair in nums.chunks_exact(2) {
            let Ok(index) = pair[0].as_i64() else {
                continue;
            };
            let Ok((_, rule_obj)) = doc.dereference(&pair[1]) else {
                continue;
            };
            let Ok(rule) = rule_obj.as_dict() else {
                continue;
            };
            let style = rule
                .get(b"S")
                .ok()
                .and_then(|v| v.as_name().ok())
                .unwrap_or(b"")
                .to_vec();
            let start = rule
                .get(b"St")
                .ok()
                .and_then(|v| v.as_i64().ok())
                .unwrap_or(1)
                .max(1) as usize;
            let prefix = rule
                .get(b"P")
                .ok()
                .and_then(|v| v.as_str().ok())
                .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
                .unwrap_or_default();
            rules.push(LabelRule {
                index: index.max(0) as usize,
                style,
                start,
                prefix,
            });
        }
    }
    if let Ok(kids) = dictionary.get(b"Kids").and_then(Object::as_array) {
        for kid in kids {
            read_label_rules(doc, kid, rules, depth + 1);
        }
    }
}

fn roman(mut value: usize) -> String {
    let mut output = String::new();
    for (number, mark) in [
        (1000, "m"),
        (900, "cm"),
        (500, "d"),
        (400, "cd"),
        (100, "c"),
        (90, "xc"),
        (50, "l"),
        (40, "xl"),
        (10, "x"),
        (9, "ix"),
        (5, "v"),
        (4, "iv"),
        (1, "i"),
    ] {
        while value >= number {
            output.push_str(mark);
            value -= number;
        }
    }
    output
}

fn alpha(mut value: usize) -> String {
    let mut output = String::new();
    while value > 0 {
        value -= 1;
        output.insert(0, (b'a' + (value % 26) as u8) as char);
        value /= 26;
    }
    output
}

fn page_size(doc: &Document, id: ObjectId) -> PageSize {
    let mut current = id;
    for _ in 0..16 {
        let Ok(dict) = doc.get_dictionary(current) else {
            break;
        };
        for key in [b"CropBox".as_slice(), b"MediaBox".as_slice()] {
            if let Ok(object) = dict.get(key) {
                if let Ok((_, object)) = doc.dereference(object) {
                    if let Ok(coords) = object.as_array() {
                        if coords.len() == 4 {
                            let numbers: Option<Vec<f32>> =
                                coords.iter().map(|v| v.as_float().ok()).collect();
                            if let Some(numbers) = numbers {
                                return PageSize {
                                    width: (numbers[2] - numbers[0]).abs(),
                                    height: (numbers[3] - numbers[1]).abs(),
                                };
                            }
                        }
                    }
                }
            }
        }
        let Ok(parent) = dict.get(b"Parent").and_then(Object::as_reference) else {
            break;
        };
        current = parent;
    }
    PageSize {
        width: 612.0,
        height: 792.0,
    }
}

pub fn render_page(path: &Path, page: usize, dpi: u16) -> Result<Vec<u8>> {
    let output = Command::new("mutool")
        .args(["draw", "-q", "-F", "png", "-r", &dpi.to_string(), "-o", "-"])
        .arg(path)
        .arg(page.to_string())
        .output()
        .context("mutool is required to render PDF pages")?;
    if !output.status.success() || !output.stdout.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(anyhow!(
            "PDF page render failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(output.stdout)
}

#[derive(Serialize)]
struct CharacterPage {
    lines: Vec<CharacterLine>,
}

#[derive(Serialize)]
struct CharacterLine {
    rect: Rect,
    text: String,
    glyphs: Vec<CharacterGlyph>,
}

#[derive(Serialize)]
struct CharacterGlyph {
    c: String,
    rect: Rect,
}

pub fn character_page(path: &Path, page: usize) -> Result<Vec<u8>> {
    let output = Command::new("mutool")
        .args(["draw", "-q", "-F", "stext", "-o", "-"])
        .arg(path)
        .arg(page.to_string())
        .output()
        .context("mutool is required for character positions")?;
    if !output.status.success() {
        return Err(anyhow!(
            "PDF character extraction failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let xml = std::str::from_utf8(&output.stdout).context("PDF character output is not UTF-8")?;
    let page = parse_character_page(xml)?;
    serde_json::to_vec(&page).context("could not serialize PDF character positions")
}

fn parse_character_page(xml: &str) -> Result<CharacterPage> {
    let document =
        roxmltree::Document::parse(xml).context("could not parse PDF character geometry")?;
    let mut lines = Vec::new();
    for line in document
        .descendants()
        .filter(|node| node.has_tag_name("line"))
    {
        let Some(rect) = line.attribute("bbox").and_then(parse_xml_rect) else {
            continue;
        };
        let mut text = String::new();
        let mut glyphs = Vec::new();
        for glyph in line.descendants().filter(|node| node.has_tag_name("char")) {
            let (Some(c), Some(quad)) = (glyph.attribute("c"), glyph.attribute("quad")) else {
                continue;
            };
            let values: Vec<f32> = quad
                .split_whitespace()
                .filter_map(|value| value.parse().ok())
                .collect();
            if values.len() != 8 {
                continue;
            }
            let x0 = values
                .iter()
                .step_by(2)
                .copied()
                .fold(f32::INFINITY, f32::min);
            let y0 = values
                .iter()
                .skip(1)
                .step_by(2)
                .copied()
                .fold(f32::INFINITY, f32::min);
            let x1 = values
                .iter()
                .step_by(2)
                .copied()
                .fold(f32::NEG_INFINITY, f32::max);
            let y1 = values
                .iter()
                .skip(1)
                .step_by(2)
                .copied()
                .fold(f32::NEG_INFINITY, f32::max);
            text.push_str(c);
            glyphs.push(CharacterGlyph {
                c: c.to_owned(),
                rect: Rect {
                    x: x0,
                    y: y0,
                    width: x1 - x0,
                    height: y1 - y0,
                },
            });
        }
        if !glyphs.is_empty() {
            lines.push(CharacterLine { rect, text, glyphs });
        }
    }
    Ok(CharacterPage { lines })
}

fn parse_xml_rect(value: &str) -> Option<Rect> {
    let coords: Vec<f32> = value
        .split_whitespace()
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    (coords.len() == 4).then(|| Rect {
        x: coords[0],
        y: coords[1],
        width: coords[2] - coords[0],
        height: coords[3] - coords[1],
    })
}

pub fn scan(
    path: &Path,
    meta: &PdfMeta,
    requested_language: &str,
    accepted_words: &[String],
) -> Result<ScanReport> {
    let output = Command::new("mutool")
        .args(["draw", "-q", "-F", "stext.json", "-o", "-"])
        .arg(path)
        .arg(format!("1-{}", meta.page_count))
        .output()
        .context("mutool is required for positioned PDF text")?;
    if !output.status.success() {
        return Err(anyhow!(
            "PDF text extraction failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let extracted: TextDocument =
        serde_json::from_slice(&output.stdout).context("could not parse PDF text geometry")?;
    if extracted.pages.len() != meta.page_count {
        return Err(anyhow!(
            "PDF text extraction returned {} of {} pages",
            extracted.pages.len(),
            meta.page_count
        ));
    }
    let pages: Vec<PageText> = extracted.pages.into_iter().map(to_page_text).collect();
    let language = select_language(requested_language, &pages);
    let mut findings = Vec::new();
    for (index, page) in pages.iter().enumerate() {
        if page.lines.is_empty() {
            add(&mut findings, index + 1, "coverage", "review", "No extractable text",
                "Text checks cannot inspect lettering that is outlined, rasterized, or absent from the PDF text layer.",
                "Inspect this page visually.", None);
        }
    }
    scan_images(path, &mut findings)?;
    let toc_pages = scan_toc(&pages, meta, &mut findings);
    scan_prose(
        &pages,
        meta,
        language,
        &toc_pages,
        accepted_words,
        &mut findings,
    )?;
    scan_page_breaks(&pages, meta, &mut findings);
    for (id, finding) in findings.iter_mut().enumerate() {
        finding.id = id;
    }
    findings.sort_by_key(|finding| (finding.page, finding.id));
    Ok(ScanReport {
        language,
        findings,
        checks: vec![
            "text coverage",
            "image resolution",
            "contents",
            "hyphenation",
            "dashes",
            "quotation marks",
            "double spaces",
            "spelling",
            "language",
            "widows and orphans",
        ],
    })
}

fn to_page_text(page: TextPage) -> PageText {
    let mut all_runs = Vec::new();
    let mut blocks = Vec::new();
    for block in page.blocks {
        if block.kind != "text" {
            continue;
        }
        let mut block_runs = Vec::new();
        for run in block.lines.unwrap_or_default() {
            let code = run
                .font
                .as_ref()
                .is_some_and(|font| font.name.to_lowercase().contains("mono"));
            let item = (run.text, run.bbox, code);
            all_runs.push(item.clone());
            block_runs.push(item);
        }
        let lines = group_runs(block_runs);
        if !lines.is_empty() {
            blocks.push(lines);
        }
    }
    PageText {
        lines: group_runs(all_runs),
        blocks,
    }
}

fn group_runs(mut runs: Vec<(String, TextBox, bool)>) -> Vec<VisualLine> {
    runs.retain(|(_, bbox, _)| bbox.h > 0.5 || bbox.w > 0.5);
    runs.sort_by(|a, b| a.1.y.total_cmp(&b.1.y).then(a.1.x.total_cmp(&b.1.x)));
    let mut grouped: Vec<Vec<(String, TextBox, bool)>> = Vec::new();
    for run in runs {
        if let Some(last) = grouped.last_mut() {
            let anchor = last[0].1;
            if (run.1.y - anchor.y).abs() <= 2.0
                && (run.1.y + run.1.h - anchor.y - anchor.h).abs() <= 4.0
            {
                last.push(run);
                continue;
            }
        }
        grouped.push(vec![run]);
    }
    grouped
        .into_iter()
        .filter_map(|mut group| {
            group.sort_by(|a, b| a.1.x.total_cmp(&b.1.x));
            let mut text = String::new();
            let mut runs = Vec::new();
            let mut x0 = f32::MAX;
            let mut y0 = f32::MAX;
            let mut x1: f32 = 0.0;
            let mut y1: f32 = 0.0;
            let mut code = false;
            for (part, bbox, monospaced) in group {
                if !text.is_empty()
                    && !text.ends_with(char::is_whitespace)
                    && !part.starts_with(char::is_whitespace)
                {
                    if let Some(prev) = runs.last().map(|run: &Run| run.bbox) {
                        if bbox.x - (prev.x + prev.w) > 1.5 {
                            text.push(' ');
                        }
                    }
                }
                text.push_str(&part);
                x0 = x0.min(bbox.x);
                y0 = y0.min(bbox.y);
                x1 = x1.max(bbox.x + bbox.w);
                y1 = y1.max(bbox.y + bbox.h);
                code |= monospaced;
                runs.push(Run { text: part, bbox });
            }
            let text = text.trim().to_owned();
            (!text.is_empty()).then_some(VisualLine {
                text,
                bbox: TextBox {
                    x: x0,
                    y: y0,
                    w: x1 - x0,
                    h: y1 - y0,
                },
                runs,
                code,
            })
        })
        .collect()
}

fn select_language(requested: &str, pages: &[PageText]) -> &'static str {
    match requested {
        "en" => "en",
        "cs" => "cs",
        "es" => "es",
        "de" => "de",
        _ => {
            let sample: String = pages
                .iter()
                .take(40)
                .flat_map(|page| page.lines.iter())
                .filter(|line| !line.code && line.text.len() > 30)
                .take(140)
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            match detect(&sample).map(|info| info.lang()) {
                Some(Lang::Ces) => "cs",
                Some(Lang::Spa) => "es",
                Some(Lang::Deu) => "de",
                _ => "en",
            }
        }
    }
}

fn add<'a>(
    findings: &'a mut Vec<Finding>,
    page: usize,
    category: &'static str,
    severity: &'static str,
    title: impl Into<String>,
    detail: impl Into<String>,
    excerpt: impl Into<String>,
    bbox: Option<TextBox>,
) -> &'a mut Finding {
    findings.push(Finding {
        id: 0,
        page,
        category,
        severity,
        title: title.into(),
        detail: detail.into(),
        excerpt: excerpt.into(),
        rect: bbox.map(|b| Rect {
            x: b.x,
            y: b.y,
            width: b.w.max(1.0),
            height: b.h.max(1.0),
        }),
        locator: None,
    });
    findings.last_mut().unwrap()
}

fn approximate_text_box(bbox: TextBox, text: &str, start: usize, end: usize) -> TextBox {
    let total = text.chars().count().max(1) as f32;
    let before = text[..start].chars().count() as f32 / total;
    let through = text[..end].chars().count() as f32 / total;
    TextBox {
        x: bbox.x + bbox.w * before,
        y: bbox.y,
        w: (bbox.w * (through - before)).max(1.0),
        h: bbox.h,
    }
}

fn excerpt_around(text: &str, start: usize, end: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let start = text[..start].chars().count().saturating_sub(48);
    let end = (text[..end].chars().count() + 48).min(chars.len());
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        chars[start..end].iter().collect::<String>(),
        if end < chars.len() { "…" } else { "" }
    )
}

fn internal_double_spaces(text: &str) -> Vec<(usize, usize)> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| Regex::new(r" {2,}").unwrap());
    pattern
        .find_iter(text)
        .filter_map(|spaces| {
            let before = text[..spaces.start()].chars().last();
            let after = text[spaces.end()..].chars().next();
            (before.is_some_and(|ch| !ch.is_whitespace())
                && after.is_some_and(|ch| !ch.is_whitespace()))
            .then_some((spaces.start(), spaces.end()))
        })
        .collect()
}

fn scan_images(path: &Path, findings: &mut Vec<Finding>) -> Result<()> {
    let output = Command::new("pdfimages")
        .arg("-list")
        .arg(path)
        .output()
        .context("pdfimages is required for effective image resolution")?;
    if !output.status.success() {
        return Err(anyhow!(
            "image inspection failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    for row in String::from_utf8_lossy(&output.stdout).lines().skip(2) {
        let fields: Vec<_> = row.split_whitespace().collect();
        if fields.len() < 14 || fields[2] != "image" {
            continue;
        }
        let (Ok(page), Ok(x), Ok(y)) = (
            fields[0].parse::<usize>(),
            fields[12].parse::<f32>(),
            fields[13].parse::<f32>(),
        ) else {
            continue;
        };
        if x < 300.0 || y < 300.0 {
            add(findings, page, "image", "error", "Image below 300 ppi",
                format!("Effective resolution is {x:.0} x {y:.0} ppi at its placed size. Minimum: 300 ppi."),
                format!("{} x {} pixels", fields[3], fields[4]), None);
        }
    }
    Ok(())
}

fn scan_toc(pages: &[PageText], meta: &PdfMeta, findings: &mut Vec<Finding>) -> HashSet<usize> {
    let row_pattern = Regex::new(r"(?i)^(.{3,}?)\s+([ivxlcdm]+|\d{1,4})$").unwrap();
    let mut outline: HashMap<String, Vec<usize>> = HashMap::new();
    for entry in &meta.outline {
        outline
            .entry(normalize_heading(&entry.title))
            .or_default()
            .push(entry.page);
    }
    let label_to_page: HashMap<String, usize> = meta
        .labels
        .iter()
        .enumerate()
        .map(|(index, label)| (label.to_lowercase(), index + 1))
        .collect();
    let mut toc_mode = false;
    let mut toc_pages = HashSet::new();
    for (page_index, page) in pages.iter().enumerate().take(meta.page_count.min(35)) {
        let page_has_heading = page.lines.iter().any(|line| {
            let heading = normalize_heading(&line.text);
            matches!(
                heading.as_str(),
                "contents"
                    | "content"
                    | "tableofcontents"
                    | "obsah"
                    | "inhalt"
                    | "inhaltsverzeichnis"
                    | "índice"
                    | "indice"
            )
        });
        if page_has_heading {
            toc_mode = true;
        }
        if !toc_mode {
            continue;
        }
        let mut found_rows = 0;
        for line in &page.lines {
            let Some(captures) = row_pattern.captures(line.text.trim()) else {
                continue;
            };
            let title = captures[1].trim().trim_matches('.').trim();
            let label = captures[2].trim();
            if title.len() < 4 || title.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let Some(target) = label_to_page.get(&label.to_lowercase()).copied() else {
                add(
                    findings,
                    page_index + 1,
                    "toc",
                    "error",
                    "Contents page number has no target",
                    format!("{title} points to page {label}, which is not a PDF page label."),
                    &line.text,
                    Some(line.bbox),
                );
                found_rows += 1;
                continue;
            };
            found_rows += 1;
            let normalized = normalize_heading(title);
            if let Some(actual_pages) = outline.get(&normalized) {
                if !actual_pages.contains(&target) {
                    let actual_page = *actual_pages
                        .iter()
                        .min_by_key(|page| page.abs_diff(target))
                        .unwrap();
                    add(
                        findings,
                        page_index + 1,
                        "toc",
                        "error",
                        "Contents page number disagrees with bookmark",
                        format!(
                            "{title} says {label}; the PDF bookmark goes to {}.",
                            meta.labels[actual_page - 1]
                        ),
                        &line.text,
                        Some(line.bbox),
                    );
                }
            } else if !target_page_has_heading(&pages[target - 1], &normalized) {
                add(
                    findings,
                    page_index + 1,
                    "toc",
                    "review",
                    "Contents entry needs checking",
                    format!("Could not confirm “{title}” on page {label}."),
                    &line.text,
                    Some(line.bbox),
                );
            }
        }
        if page_has_heading || found_rows >= 2 {
            toc_pages.insert(page_index);
        }
        if toc_mode && !page_has_heading && found_rows == 0 {
            break;
        }
    }
    toc_pages
}

fn normalize_heading(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn target_page_has_heading(page: &PageText, heading: &str) -> bool {
    if heading.len() < 5 {
        return false;
    }
    page.lines.iter().take(24).any(|line| {
        let candidate = normalize_heading(&line.text);
        candidate.contains(heading) || (candidate.len() >= 8 && heading.contains(&candidate))
    })
}

fn scan_prose(
    pages: &[PageText],
    meta: &PdfMeta,
    language: &'static str,
    toc_pages: &HashSet<usize>,
    accepted_words: &[String],
    findings: &mut Vec<Finding>,
) -> Result<()> {
    let dictionary = Standard::from_embedded(match language {
        "cs" => Language::Czech,
        "es" => Language::Spanish,
        "de" => Language::German1996,
        _ => Language::EnglishUS,
    })
    .context("could not load hyphenation patterns")?;
    let word_pattern = Regex::new(r"\p{L}{3,}").unwrap();
    let accepted = normalized_accepted_words(accepted_words);
    let mut word_positions: BTreeMap<String, Vec<(usize, TextBox, String)>> = BTreeMap::new();
    let mut pending_hyphens = Vec::new();
    for (index, page) in pages.iter().enumerate() {
        let height = meta.sizes[index].height;
        let toc_page = toc_pages.contains(&index);
        for (line_index, line) in page.lines.iter().enumerate() {
            if line.code || line.bbox.y < 45.0 || line.bbox.y > height - 42.0 || toc_page {
                continue;
            }
            for run in &line.runs {
                for (start, end) in internal_double_spaces(&run.text) {
                    add(
                        findings,
                        index + 1,
                        "spacing",
                        "review",
                        "Double space",
                        "Consecutive spaces between characters in the PDF text layer.",
                        excerpt_around(&run.text, start, end),
                        Some(approximate_text_box(run.bbox, &run.text, start, end)),
                    )
                    .locator = Some(run.text[start..end].to_owned());
                }
            }
            scan_marks(line, index + 1, language, findings);
            for match_ in word_pattern.find_iter(&line.text) {
                let word = match_.as_str();
                if word.len() < 4 || word.chars().next().is_some_and(char::is_uppercase) {
                    continue;
                }
                if accepted_word(word) || accepted.contains(&word.to_lowercase()) {
                    continue;
                }
                if line.text.ends_with(['-', '\u{00ad}']) && match_.end() + 1 == line.text.len() {
                    continue;
                }
                if match_.start() == 0
                    && line_index > 0
                    && page.lines[line_index - 1].text.ends_with(['-', '\u{00ad}'])
                {
                    continue;
                }
                if line.text[match_.end()..].starts_with(['\'', '’', '‘']) {
                    continue;
                }
                if match_.start() > 0 && line.text[..match_.start()].ends_with(['/', '@', '#', '_'])
                {
                    continue;
                }
                word_positions
                    .entry(word.to_lowercase())
                    .or_default()
                    .push((
                        index + 1,
                        approximate_text_box(line.bbox, &line.text, match_.start(), match_.end()),
                        line.text.clone(),
                    ));
            }
            if let Some(next) = page.lines.get(line_index + 1) {
                if next.bbox.y - (line.bbox.y + line.bbox.h) < 22.0 {
                    if let Some(candidate) = check_hyphenation(line, next, index + 1, &dictionary) {
                        pending_hyphens.push(candidate);
                    }
                }
            }
        }
        for block in &page.blocks {
            let text = block
                .iter()
                .filter(|line| !line.code)
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            if text.chars().filter(|c| c.is_alphabetic()).count() < 100 || text.contains("http") {
                continue;
            }
            if let Some(detected) = foreign_language(&text, language) {
                let first = &block[0];
                add(
                    findings,
                    index + 1,
                    "language",
                    "review",
                    "Possible wrong-language paragraph",
                    format!(
                        "This passage looks like {} in a {} document.",
                        detected.eng_name(),
                        language_name(language)
                    ),
                    excerpt(&text),
                    Some(first.bbox),
                );
            }
        }
    }
    let spell_words: HashSet<String> = word_positions
        .keys()
        .cloned()
        .chain(pending_hyphens.iter().map(|(word, _)| word.to_lowercase()))
        .collect();
    let misspelled = hunspell_misspellings(language, spell_words.iter())?;
    for (word, finding) in pending_hyphens {
        if !misspelled.contains(&word.to_lowercase()) || accepted.contains(&word.to_lowercase()) {
            findings.push(finding);
        }
    }
    for (word, locations) in word_positions {
        if !misspelled.contains(&word) || locations.len() > 3 {
            continue;
        }
        let (page, bbox, context) = &locations[0];
        add(findings, *page, "spelling", "review", format!("Check spelling: {word}"),
            format!("Not in the {} dictionary; found {} time(s). Names and technical terms may be valid.", language_name(language), locations.len()),
            excerpt(context), Some(*bbox)).locator = Some(word.clone());
    }
    Ok(())
}

fn foreign_language(text: &str, expected: &str) -> Option<Lang> {
    let expected = match expected {
        "cs" => Lang::Ces,
        "es" => Lang::Spa,
        "de" => Lang::Deu,
        _ => Lang::Eng,
    };
    let detected = detect(text)?;
    (detected.lang() != expected && detected.confidence() >= 0.97).then_some(detected.lang())
}

fn scan_marks(line: &VisualLine, page: usize, language: &str, findings: &mut Vec<Finding>) {
    let text = &line.text;
    if let Some((start, target)) = text
        .find(" -- ")
        .map(|start| (start, " -- "))
        .or_else(|| text.find(" - ").map(|start| (start, " - ")))
    {
        add(
            findings,
            page,
            "dash",
            "review",
            "Hyphen used as a dash",
            "A spaced hyphen is usually a dash in prose. Check the intended punctuation.",
            excerpt(text),
            Some(approximate_text_box(
                line.bbox,
                text,
                start,
                start + target.len(),
            )),
        )
        .locator = Some(target.to_owned());
    }
    if language == "cs" && (text.contains('"') || text.contains('“') && !text.contains('„')) {
        let (start, target) = text
            .find('"')
            .map(|start| (start, "\""))
            .or_else(|| text.find('“').map(|start| (start, "“")))
            .unwrap();
        add(
            findings,
            page,
            "quote",
            "review",
            "Check Czech quotation marks",
            "Czech primary quotes normally open with „ and close with “; check this passage.",
            excerpt(text),
            Some(approximate_text_box(
                line.bbox,
                text,
                start,
                start + target.len(),
            )),
        )
        .locator = Some(target.to_owned());
    }
}

fn check_hyphenation(
    current: &VisualLine,
    next: &VisualLine,
    page: usize,
    dict: &Standard,
) -> Option<(String, Finding)> {
    let left = current.text.trim_end().strip_suffix(['-', '\u{00ad}'])?;
    let left: String = left
        .chars()
        .rev()
        .take_while(|c| c.is_alphabetic())
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let right: String = next
        .text
        .trim_start()
        .chars()
        .take_while(|c| c.is_alphabetic())
        .collect();
    if left.len() < 2 || right.len() < 2 || left.len() + right.len() > 45 {
        return None;
    }
    let word = format!("{left}{right}");
    let point = left.len();
    if !dict.hyphenate(&word).breaks.contains(&point) {
        let marker_start = current
            .text
            .trim_end()
            .char_indices()
            .last()
            .map(|(index, _)| index)
            .unwrap_or(0);
        let marker = &current.text[marker_start..];
        let bbox = approximate_text_box(
            current.bbox,
            &current.text,
            marker_start,
            current.text.len(),
        );
        return Some((
            word.clone(),
            Finding {
                id: 0,
                page,
                category: "hyphenation",
                severity: "review",
                title: "Check word break".into(),
                detail: format!("“{left}-{right}” is not a listed hyphenation point for “{word}”."),
                excerpt: format!("{} / {}", current.text, next.text),
                rect: Some(Rect {
                    x: bbox.x,
                    y: bbox.y,
                    width: bbox.w,
                    height: bbox.h,
                }),
                locator: Some(marker.to_owned()),
            },
        ));
    }
    None
}

fn scan_page_breaks(pages: &[PageText], meta: &PdfMeta, findings: &mut Vec<Finding>) {
    for index in 0..pages.len().saturating_sub(1) {
        let Some(last_block) = pages[index].blocks.iter().rev().find(|block| {
            block
                .iter()
                .any(|line| line.bbox.y < meta.sizes[index].height - 55.0 && line.bbox.y > 55.0)
        }) else {
            continue;
        };
        let Some(first_block) = pages[index + 1].blocks.iter().find(|block| {
            block
                .iter()
                .any(|line| line.bbox.y > 55.0 && line.bbox.y < meta.sizes[index + 1].height - 55.0)
        }) else {
            continue;
        };
        let last: Vec<_> = last_block
            .iter()
            .filter(|line| {
                !line.code && line.bbox.y > 55.0 && line.bbox.y < meta.sizes[index].height - 55.0
            })
            .collect();
        let first: Vec<_> = first_block
            .iter()
            .filter(|line| {
                !line.code
                    && line.bbox.y > 55.0
                    && line.bbox.y < meta.sizes[index + 1].height - 55.0
            })
            .collect();
        if last.len() == 1 && !first.is_empty() {
            let line = last[0];
            if line.bbox.y > meta.sizes[index].height * 0.7
                && !line.text.ends_with(['.', '!', '?', ':'])
                && first[0].text.chars().next().is_some_and(char::is_lowercase)
            {
                add(findings, index+1, "widow", "review", "Possible isolated first line",
                    "A paragraph may start with one line at the bottom of this page. Check the page break visually.",
                    excerpt(&line.text), Some(line.bbox));
            }
        }
        if first.len() == 1 && !last.is_empty() {
            let line = first[0];
            if line.bbox.y < meta.sizes[index + 1].height * 0.3
                && line.text.chars().next().is_some_and(char::is_lowercase)
                && !last.last().unwrap().text.ends_with(['.', '!', '?', ':'])
            {
                add(findings, index+2, "widow", "review", "Possible isolated last line",
                    "A paragraph may end with one line at the top of this page. Check the page break visually.",
                    excerpt(&line.text), Some(line.bbox));
            }
        }
    }
}

fn dictionary_dir() -> Result<&'static PathBuf> {
    static DIR: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    match DIR.get_or_init(|| {
        let dir =
            std::env::temp_dir().join(format!("princeznoid-dictionaries-{}", std::process::id()));
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        for (name, bytes) in [
            (
                "en_US.aff",
                include_bytes!("../assets/dictionaries/en_US.aff").as_slice(),
            ),
            (
                "en_US.dic",
                include_bytes!("../assets/dictionaries/en_US.dic").as_slice(),
            ),
            (
                "cs_CZ.aff",
                include_bytes!("../assets/dictionaries/cs_CZ.aff").as_slice(),
            ),
            (
                "cs_CZ.dic",
                include_bytes!("../assets/dictionaries/cs_CZ.dic").as_slice(),
            ),
            (
                "es_ES.aff",
                include_bytes!("../assets/dictionaries/es_ES.aff").as_slice(),
            ),
            (
                "es_ES.dic",
                include_bytes!("../assets/dictionaries/es_ES.dic").as_slice(),
            ),
            (
                "de_DE.aff",
                include_bytes!("../assets/dictionaries/de_DE.aff").as_slice(),
            ),
            (
                "de_DE.dic",
                include_bytes!("../assets/dictionaries/de_DE.dic").as_slice(),
            ),
        ] {
            fs::write(dir.join(name), bytes).map_err(|error| error.to_string())?;
        }
        Ok(dir)
    }) {
        Ok(path) => Ok(path),
        Err(message) => Err(anyhow!(message.clone())),
    }
}

fn hunspell_misspellings<'a>(
    language: &str,
    words: impl Iterator<Item = &'a String>,
) -> Result<HashSet<String>> {
    let prefix = match language {
        "cs" => "cs_CZ",
        "es" => "es_ES",
        "de" => "de_DE",
        _ => "en_US",
    };
    let path = dictionary_dir()?.join(prefix);
    let mut child = Command::new("hunspell")
        .arg("-l")
        .arg("-d")
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("hunspell is required for spelling checks")?;
    {
        let mut input = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("hunspell stdin unavailable"))?;
        for word in words {
            writeln!(input, "{word}")?;
        }
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(anyhow!(
            "spell checker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}

fn language_name(code: &str) -> &'static str {
    match code {
        "cs" => "Czech",
        "es" => "Spanish",
        "de" => "German",
        _ => "English",
    }
}

fn excerpt(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= 130 {
        trimmed.to_owned()
    } else {
        format!("{}…", trimmed.chars().take(127).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_label_numbers() {
        assert_eq!(roman(14), "xiv");
        assert_eq!(alpha(27), "aa");
    }

    #[test]
    fn groups_runs_on_the_same_visual_line() {
        let runs = vec![
            (
                "Hello".into(),
                TextBox {
                    x: 10.0,
                    y: 20.0,
                    w: 25.0,
                    h: 9.0,
                },
                false,
            ),
            (
                "world".into(),
                TextBox {
                    x: 40.0,
                    y: 20.0,
                    w: 28.0,
                    h: 9.0,
                },
                false,
            ),
        ];
        assert_eq!(group_runs(runs)[0].text, "Hello world");
    }

    #[test]
    fn detects_foreign_prose_without_flagging_english() {
        let english = "The book explains how a transaction moves through the network. Each chapter builds on the previous one, with examples that make the system easier to understand.";
        let spanish = "Este libro explica cómo funciona una transacción dentro de la red. Cada capítulo desarrolla las ideas anteriores y presenta ejemplos claros para comprender mejor todo el sistema.";
        assert_eq!(foreign_language(english, "en"), None);
        assert_eq!(foreign_language(spanish, "en"), Some(Lang::Spa));
    }

    #[test]
    fn accepts_project_vocabulary() {
        assert!(accepted_word("Braiins"));
        assert!(accepted_word("Frontend"));
        assert!(accepted_word("frontends"));
        assert!(accepted_word("BACKEND"));
        assert!(accepted_word("backends"));
        assert!(!accepted_word("frontned"));
        let custom =
            normalized_accepted_words(&[" Frontned ".into(), "two words".into(), "čtečka".into()]);
        assert!(custom.contains("frontned"));
        assert!(custom.contains("čtečka"));
        assert!(!custom.contains("two words"));
    }

    #[test]
    fn double_spaces_must_be_between_visible_characters() {
        assert_eq!(internal_double_spaces("a  b  c  "), vec![(1, 3), (4, 6)]);
        assert!(internal_double_spaces("  a ").is_empty());
        assert_eq!(internal_double_spaces("a   b"), vec![(1, 4)]);
    }

    #[test]
    fn reads_character_quads_for_exact_highlights() {
        let xml = r#"<document><page><line bbox="10 20 40 30"><font><char quad="10 21 13 21 10 29 13 29" c="a"/><char quad="13 28 16 28 13 28 16 28" c=" "/><char quad="16 28 19 28 16 28 19 28" c=" "/><char quad="19 21 24 21 19 29 24 29" c="b"/></font></line></page></document>"#;
        let page = parse_character_page(xml).unwrap();
        assert_eq!(page.lines[0].text, "a  b");
        assert_eq!(page.lines[0].glyphs[1].rect.x, 13.0);
        assert_eq!(page.lines[0].glyphs[2].rect.width, 3.0);
    }
}
