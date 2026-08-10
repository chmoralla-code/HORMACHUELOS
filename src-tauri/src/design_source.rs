use crate::{state::AppState, workspace};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};
use tauri::WebviewWindow;

const MAX_INDEX_FILES: usize = 8_000;
const MAX_INDEX_BYTES: usize = 32 * 1024 * 1024;
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TARGET_TEXT: usize = 180;
const MAX_TARGET_HTML: usize = 1_200;
const MAX_SOURCE_RESULTS: usize = 5;

const SOURCE_EXTENSIONS: &[&str] = &[
    "html", "htm", "xhtml", "css", "scss", "sass", "less", "js", "mjs", "cjs", "ts", "tsx", "jsx",
    "vue", "svelte", "astro", "php", "erb", "razor", "cshtml", "rs", "py", "go", "java", "kt",
    "kts", "cs", "rb", "ex", "exs", "scala",
];
const STYLE_EXTENSIONS: &[&str] = &["css", "scss", "sass", "less"];
const BACKEND_ONLY_EXTENSIONS: &[&str] = &[
    "rs", "py", "go", "java", "kt", "kts", "cs", "rb", "ex", "exs", "scala",
];
const IGNORED_DIRECTORIES: &[&str] = &[
    ".git",
    ".next",
    ".cache",
    ".turbo",
    ".svelte-kit",
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
    "vendor",
    "__pycache__",
];

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignDomContext {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub classes: Vec<String>,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub aria_label: String,
    #[serde(default)]
    pub test_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub href: String,
    #[serde(default)]
    pub html: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignTargetProbe {
    #[serde(default)]
    pub preview_url: String,
    #[serde(default)]
    pub point: Option<DesignPoint>,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub selector: String,
    #[serde(default)]
    pub dom_context: Option<DesignDomContext>,
    #[serde(default)]
    pub style_selectors: Vec<String>,
    #[serde(default)]
    pub source_file: String,
    #[serde(default)]
    pub source_line: Option<u32>,
    #[serde(default)]
    pub source_column: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DesignSourceKind {
    Frontend,
    Style,
    Backend,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum DesignSourceConfidence {
    Likely,
    Strong,
    Exact,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignSourceLocation {
    pub path: String,
    pub line: u32,
    pub column: Option<u32>,
    pub kind: DesignSourceKind,
    pub confidence: DesignSourceConfidence,
    pub symbol: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignTargetResolution {
    pub tag: String,
    pub text: String,
    pub selector: String,
    pub dom_context: DesignDomContext,
    pub rect: Option<DesignRect>,
    pub sources: Vec<DesignSourceLocation>,
    pub inspected_by: String,
    pub index_partial: bool,
}

#[derive(Default)]
pub struct DesignSourceState {
    index: Mutex<Option<Arc<DesignSourceIndex>>>,
}

#[derive(Debug)]
struct IndexedSourceFile {
    path: String,
    lower_path: String,
    extension: String,
    content: String,
    lower_content: String,
    line_offsets: Vec<usize>,
    modified_ms: u64,
}

impl IndexedSourceFile {
    fn line_for_offset(&self, offset: usize) -> u32 {
        self.line_offsets
            .partition_point(|start| *start <= offset)
            .max(1) as u32
    }

    fn offset_for_line(&self, line: u32) -> usize {
        self.line_offsets
            .get(line.saturating_sub(1) as usize)
            .copied()
            .unwrap_or(0)
    }

    fn find(&self, needle: &str) -> Option<usize> {
        let needle = needle.trim().to_ascii_lowercase();
        (!needle.is_empty())
            .then(|| self.lower_content.find(&needle))
            .flatten()
    }

    fn is_style(&self) -> bool {
        STYLE_EXTENSIONS.contains(&self.extension.as_str())
    }

    fn is_frontend(&self) -> bool {
        !self.is_style() && !BACKEND_ONLY_EXTENSIONS.contains(&self.extension.as_str())
    }
}

#[derive(Debug)]
struct DesignSourceIndex {
    root: PathBuf,
    files: Vec<IndexedSourceFile>,
    partial: bool,
}

#[derive(Debug)]
struct RankedCandidate {
    file_index: usize,
    score: i32,
    line: u32,
    exact_runtime: bool,
    strong_match: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeTarget {
    #[serde(default)]
    tag: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    selector: String,
    #[serde(default)]
    dom_context: DesignDomContext,
    #[serde(default)]
    rect: DesignRect,
    #[serde(default)]
    style_selectors: Vec<String>,
    #[serde(default)]
    source_file: String,
    #[serde(default)]
    source_line: Option<u32>,
    #[serde(default)]
    source_column: Option<u32>,
}

fn project_root(state: &AppState) -> Result<PathBuf, String> {
    let root = state
        .project_root
        .lock()
        .map_err(|_| "Project state is unavailable.".to_string())?
        .clone()
        .ok_or_else(|| "Open a project before using Source Lens.".to_string())?;
    workspace::canonical_project_root(Path::new(&root)).map_err(|error| error.to_string())
}

fn should_enter(entry: &walkdir::DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    if !entry.file_type().is_dir() {
        return true;
    }
    let name = entry.file_name().to_string_lossy();
    !IGNORED_DIRECTORIES
        .iter()
        .any(|ignored| name.eq_ignore_ascii_case(ignored))
}

fn source_extension(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    if name.ends_with(".blade.php") {
        return Some("php".into());
    }
    let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
    SOURCE_EXTENSIONS
        .contains(&extension.as_str())
        .then_some(extension)
}

fn line_offsets(content: &str) -> Vec<usize> {
    let mut offsets = vec![0];
    offsets.extend(content.match_indices('\n').map(|(offset, _)| offset + 1));
    offsets
}

fn modified_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn build_index(root: &Path) -> Result<DesignSourceIndex, String> {
    let root = workspace::canonical_project_root(root).map_err(|error| error.to_string())?;
    let mut files = Vec::new();
    let mut indexed_bytes = 0usize;
    let mut partial = false;

    for entry in walkdir::WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(should_enter)
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if files.len() >= MAX_INDEX_FILES || indexed_bytes >= MAX_INDEX_BYTES {
            partial = true;
            break;
        }
        let path = entry.path();
        let Some(extension) = source_extension(path) else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.len() == 0 || metadata.len() > MAX_SOURCE_BYTES {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        if indexed_bytes.saturating_add(content.len()) > MAX_INDEX_BYTES {
            partial = true;
            break;
        }
        let Ok(relative) = path.strip_prefix(&root) else {
            continue;
        };
        let display = relative.to_string_lossy().replace('\\', "/");
        if display.starts_with('.') && display.contains("/.env") {
            continue;
        }
        indexed_bytes += content.len();
        files.push(IndexedSourceFile {
            lower_path: display.to_ascii_lowercase(),
            path: display,
            extension,
            lower_content: content.to_ascii_lowercase(),
            line_offsets: line_offsets(&content),
            modified_ms: modified_ms(&metadata),
            content,
        });
    }

    Ok(DesignSourceIndex {
        root,
        files,
        partial,
    })
}

async fn ensure_index(
    source_state: &DesignSourceState,
    root: PathBuf,
) -> Result<Arc<DesignSourceIndex>, String> {
    if let Some(index) = source_state
        .index
        .lock()
        .map_err(|_| "Source index is unavailable.".to_string())?
        .as_ref()
        .filter(|index| index.root == root)
        .cloned()
    {
        return Ok(index);
    }

    let build_root = root.clone();
    let index = tokio::task::spawn_blocking(move || build_index(&build_root))
        .await
        .map_err(|error| format!("Source indexing stopped unexpectedly: {error}"))??;
    let index = Arc::new(index);
    *source_state
        .index
        .lock()
        .map_err(|_| "Source index is unavailable.".to_string())? = Some(index.clone());
    Ok(index)
}

#[tauri::command]
pub async fn warm_design_source_index(
    state: tauri::State<'_, AppState>,
    source_state: tauri::State<'_, DesignSourceState>,
) -> Result<usize, String> {
    let root = project_root(&state)?;
    Ok(ensure_index(&source_state, root).await?.files.len())
}

#[tauri::command]
pub fn invalidate_design_source_index(
    source_state: tauri::State<'_, DesignSourceState>,
) -> Result<(), String> {
    *source_state
        .index
        .lock()
        .map_err(|_| "Source index is unavailable.".to_string())? = None;
    Ok(())
}

fn clip(value: &str, max: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= max {
        compact
    } else {
        compact.chars().take(max).collect()
    }
}

fn normalize_probe(mut probe: DesignTargetProbe, runtime: Option<RuntimeTarget>) -> RuntimeTarget {
    if let Some(mut live) = runtime {
        live.tag = clip(&live.tag, 40);
        live.text = clip(&live.text, MAX_TARGET_TEXT);
        live.selector = clip(&live.selector, 400);
        live.dom_context.html = clip(&live.dom_context.html, MAX_TARGET_HTML);
        live.dom_context.classes.truncate(16);
        live.style_selectors.truncate(16);
        return live;
    }
    let mut dom = probe.dom_context.take().unwrap_or_default();
    dom.html = clip(&dom.html, MAX_TARGET_HTML);
    dom.classes.truncate(16);
    probe.style_selectors.truncate(16);
    RuntimeTarget {
        tag: clip(&probe.tag, 40),
        text: clip(&probe.text, MAX_TARGET_TEXT),
        selector: clip(&probe.selector, 400),
        dom_context: dom,
        rect: DesignRect::default(),
        style_selectors: probe.style_selectors,
        source_file: clip(&probe.source_file, 500),
        source_line: probe.source_line,
        source_column: probe.source_column,
    }
}

fn tokens(value: &str) -> Vec<String> {
    let mut normalized = String::with_capacity(value.len());
    let mut previous_lower = false;
    for ch in value.chars() {
        if ch.is_ascii_uppercase() && previous_lower {
            normalized.push(' ');
        }
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            normalized.push(ch.to_ascii_lowercase());
        } else {
            normalized.push(' ');
        }
        previous_lower = ch.is_ascii_lowercase() || ch.is_ascii_digit();
    }
    let noise: HashSet<&str> = [
        "button",
        "class",
        "current",
        "element",
        "feature",
        "html",
        "http",
        "https",
        "main",
        "preview",
        "selected",
        "source",
        "style",
        "target",
        "visual",
        "localhost",
    ]
    .into_iter()
    .collect();
    let mut seen = HashSet::new();
    normalized
        .split_whitespace()
        .filter(|token| token.len() >= 3 && !noise.contains(*token))
        .filter(|token| seen.insert((*token).to_string()))
        .map(str::to_string)
        .collect()
}

fn route_tokens(value: &str) -> Vec<String> {
    let route = value
        .split_once("://")
        .map(|(_, rest)| rest.split_once('/').map(|(_, path)| path).unwrap_or(""))
        .unwrap_or(value);
    tokens(route)
}

fn source_hint_path(value: &str) -> String {
    let mut value = value.replace('\\', "/");
    if let Some((_, after)) = value.split_once("/src/") {
        value = format!("src/{after}");
    } else if let Some((_, after)) = value.split_once("/app/") {
        value = format!("app/{after}");
    }
    value
        .split(['?', '#'])
        .next()
        .unwrap_or(&value)
        .trim_start_matches("file:///")
        .trim_start_matches('/')
        .to_ascii_lowercase()
}

fn quoted_attribute_needles(name: &str, value: &str) -> Vec<String> {
    if value.trim().is_empty() {
        return Vec::new();
    }
    vec![
        format!("{name}=\"{}\"", value.trim()),
        format!("{name}='{}'", value.trim()),
    ]
}

fn earliest_find(file: &IndexedSourceFile, needles: &[String]) -> Option<usize> {
    needles.iter().filter_map(|needle| file.find(needle)).min()
}

fn component_symbol(file: &IndexedSourceFile, line: u32) -> Option<String> {
    static SYMBOL_RE: OnceLock<Regex> = OnceLock::new();
    let regex = SYMBOL_RE.get_or_init(|| {
        Regex::new(r"(?m)(?:export\s+default\s+)?(?:async\s+)?(?:function|class|const|let)\s+([A-Z][A-Za-z0-9_$]*)")
            .expect("valid component symbol regex")
    });
    let end = file
        .offset_for_line(line.saturating_add(1))
        .min(file.content.len());
    regex
        .captures_iter(&file.content[..end])
        .last()
        .and_then(|capture| capture.get(1))
        .map(|value| value.as_str().to_string())
}

fn frontend_candidates(
    index: &DesignSourceIndex,
    target: &RuntimeTarget,
    preview_url: &str,
) -> Vec<RankedCandidate> {
    let route = route_tokens(preview_url);
    let source_hint = source_hint_path(&target.source_file);
    let id_needles = quoted_attribute_needles("id", &target.dom_context.id);
    let test_needles = quoted_attribute_needles("data-testid", &target.dom_context.test_id);
    let aria_needles = quoted_attribute_needles("aria-label", &target.dom_context.aria_label);
    let text = clip(&target.text, 100).to_ascii_lowercase();
    let selector_tokens = tokens(&format!(
        "{} {} {} {} {}",
        target.selector,
        target.dom_context.classes.join(" "),
        target.dom_context.role,
        target.dom_context.name,
        target.dom_context.href
    ));

    let mut candidates = Vec::new();
    for (file_index, file) in index.files.iter().enumerate() {
        if !file.is_frontend() {
            continue;
        }
        let mut score = 0;
        let mut line = 1;
        let mut strong_match = false;
        let exact_runtime = !source_hint.is_empty()
            && (file.lower_path == source_hint
                || file.lower_path.ends_with(&format!("/{source_hint}")));
        if exact_runtime {
            score += 2_000;
            line = target.source_line.unwrap_or(1).max(1);
            strong_match = true;
        }
        for token in &route {
            if file
                .lower_path
                .split('/')
                .any(|segment| segment.contains(token))
            {
                score += 70;
            }
        }
        if let Some(offset) = earliest_find(file, &test_needles) {
            score += 900;
            line = file.line_for_offset(offset);
            strong_match = true;
        } else if let Some(offset) = earliest_find(file, &id_needles) {
            score += 760;
            line = file.line_for_offset(offset);
            strong_match = true;
        } else if let Some(offset) = earliest_find(file, &aria_needles) {
            score += 520;
            line = file.line_for_offset(offset);
            strong_match = true;
        }
        if text.len() >= 4 {
            if let Some(offset) = file.lower_content.find(&text) {
                score += 360;
                if !strong_match {
                    line = file.line_for_offset(offset);
                }
            }
        }
        for token in &selector_tokens {
            if let Some(offset) = file.lower_content.find(token) {
                score += 28;
                if line == 1 {
                    line = file.line_for_offset(offset);
                }
            }
        }
        if score > 0 {
            candidates.push(RankedCandidate {
                file_index,
                score,
                line,
                exact_runtime,
                strong_match,
            });
        }
    }
    candidates.sort_by(|a, b| {
        b.score.cmp(&a.score).then_with(|| {
            index.files[a.file_index]
                .path
                .len()
                .cmp(&index.files[b.file_index].path.len())
        })
    });
    candidates
}

fn style_candidates(
    index: &DesignSourceIndex,
    target: &RuntimeTarget,
    preview_url: &str,
) -> Vec<RankedCandidate> {
    let mut selectors = target.style_selectors.clone();
    if !target.dom_context.id.is_empty() {
        selectors.push(format!("#{}", target.dom_context.id));
    }
    selectors.extend(
        target
            .dom_context
            .classes
            .iter()
            .filter(|class_name| !class_name.trim().is_empty())
            .map(|class_name| format!(".{}", class_name.trim())),
    );
    selectors.sort();
    selectors.dedup();
    let route = route_tokens(preview_url);
    let mut candidates = Vec::new();
    for (file_index, file) in index.files.iter().enumerate() {
        if !file.is_style() {
            continue;
        }
        let mut score = 0;
        let mut line = 1;
        let mut strong_match = false;
        for selector in &selectors {
            if let Some(offset) = file.find(selector) {
                score += if target.style_selectors.contains(selector) {
                    600
                } else {
                    300
                };
                line = file.line_for_offset(offset);
                strong_match = true;
                break;
            }
        }
        for token in &route {
            if file.lower_path.contains(token) {
                score += 35;
            }
        }
        if score > 0 {
            candidates.push(RankedCandidate {
                file_index,
                score,
                line,
                exact_runtime: false,
                strong_match,
            });
        }
    }
    candidates.sort_by(|a, b| b.score.cmp(&a.score));
    candidates
}

fn endpoint_regex() -> &'static Regex {
    static ENDPOINT_RE: OnceLock<Regex> = OnceLock::new();
    ENDPOINT_RE.get_or_init(|| {
        Regex::new(
            r#"(?i)(?:fetch|axios\.(?:get|post|put|patch|delete)|(?:api|client)\.(?:get|post|put|patch|delete))\s*\(\s*["'`]([^"'`]+)["'`]"#,
        )
        .expect("valid endpoint regex")
    })
}

fn endpoint_near(file: &IndexedSourceFile, line: u32, dom: &DesignDomContext) -> Option<String> {
    if dom.href.starts_with("/api/") {
        return Some(dom.href.clone());
    }
    let start_line = line.saturating_sub(120).max(1);
    let end_line = line.saturating_add(160);
    let start = file.offset_for_line(start_line);
    let end = file
        .offset_for_line(end_line)
        .max(start)
        .min(file.content.len());
    let window = &file.content[start..end];
    let captures = endpoint_regex()
        .captures_iter(window)
        .filter_map(|capture| capture.get(1).map(|value| value.as_str().to_string()))
        .collect::<Vec<_>>();
    if captures.len() == 1 {
        return captures.into_iter().next();
    }
    let all = endpoint_regex()
        .captures_iter(&file.content)
        .filter_map(|capture| capture.get(1).map(|value| value.as_str().to_string()))
        .collect::<Vec<_>>();
    (all.len() == 1).then(|| all[0].clone())
}

fn backend_for_endpoint(index: &DesignSourceIndex, endpoint: &str) -> Option<DesignSourceLocation> {
    let clean = endpoint
        .split(['?', '#'])
        .next()
        .unwrap_or(endpoint)
        .trim_matches('/');
    if clean.is_empty() {
        return None;
    }
    let segments = clean
        .split('/')
        .filter(|part| !part.is_empty() && *part != "api")
        .map(|part| part.trim_matches(|ch: char| ch == '{' || ch == '}' || ch == '[' || ch == ']'))
        .filter(|part| part.len() >= 2)
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    if segments.is_empty() {
        return None;
    }
    let endpoint_lower = endpoint.to_ascii_lowercase();
    let mut matches = index
        .files
        .iter()
        .filter(|file| !file.is_style())
        .filter_map(|file| {
            let route_shaped = file.lower_path.contains("/api/")
                || file.lower_path.contains("/routes/")
                || file.lower_path.contains("/controllers/")
                || file.lower_path.contains("/handlers/")
                || file.lower_path.contains("/endpoints/")
                || file.lower_path.ends_with("route.ts")
                || file.lower_path.ends_with("route.js")
                || file.lower_path.ends_with("route.py")
                || file.lower_path.ends_with("routes.rs")
                || file.lower_path.contains("server");
            if !route_shaped {
                return None;
            }
            let path_hits = segments
                .iter()
                .filter(|segment| file.lower_path.contains(segment.as_str()))
                .count() as i32;
            let content_offset = file.lower_content.find(&endpoint_lower);
            let score = path_hits * 120 + if content_offset.is_some() { 260 } else { 0 };
            (score > 0).then_some((file, score, content_offset))
        })
        .collect::<Vec<_>>();
    matches.sort_by(|a, b| b.1.cmp(&a.1));
    let (file, score, offset) = matches.into_iter().next()?;
    Some(DesignSourceLocation {
        path: file.path.clone(),
        line: offset.map(|value| file.line_for_offset(value)).unwrap_or(1),
        column: None,
        kind: DesignSourceKind::Backend,
        confidence: if score >= 360 {
            DesignSourceConfidence::Strong
        } else {
            DesignSourceConfidence::Likely
        },
        symbol: None,
    })
}

fn resolve_sources(
    index: &DesignSourceIndex,
    target: &RuntimeTarget,
    preview_url: &str,
) -> Vec<DesignSourceLocation> {
    let frontend = frontend_candidates(index, target, preview_url);
    let styles = style_candidates(index, target, preview_url);
    let strong_frontend_count = frontend
        .iter()
        .filter(|candidate| candidate.strong_match)
        .count();
    let mut locations = Vec::new();

    for candidate in frontend.iter().take(2) {
        let file = &index.files[candidate.file_index];
        let confidence = if candidate.exact_runtime {
            DesignSourceConfidence::Exact
        } else if candidate.strong_match && strong_frontend_count == 1 {
            DesignSourceConfidence::Strong
        } else {
            DesignSourceConfidence::Likely
        };
        locations.push(DesignSourceLocation {
            path: file.path.clone(),
            line: candidate.line.max(1),
            column: candidate
                .exact_runtime
                .then_some(target.source_column.unwrap_or(1).max(1)),
            kind: DesignSourceKind::Frontend,
            confidence,
            symbol: component_symbol(file, candidate.line),
        });
    }

    if let Some(candidate) = styles.first() {
        let file = &index.files[candidate.file_index];
        locations.push(DesignSourceLocation {
            path: file.path.clone(),
            line: candidate.line.max(1),
            column: None,
            kind: DesignSourceKind::Style,
            confidence: if candidate.strong_match {
                DesignSourceConfidence::Strong
            } else {
                DesignSourceConfidence::Likely
            },
            symbol: None,
        });
    }

    if let Some(candidate) = frontend.first() {
        let file = &index.files[candidate.file_index];
        if let Some(endpoint) = endpoint_near(file, candidate.line, &target.dom_context) {
            if let Some(backend) = backend_for_endpoint(index, &endpoint) {
                locations.push(backend);
            }
        }
    }

    locations.truncate(MAX_SOURCE_RESULTS);
    locations
}

fn index_needs_refresh(index: &DesignSourceIndex, root: &Path) -> bool {
    if index.root != root {
        return true;
    }
    index.files.iter().take(12).any(|file| {
        let path = root.join(file.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        std::fs::metadata(path)
            .map(|metadata| modified_ms(&metadata) != file.modified_ms)
            .unwrap_or(true)
    })
}

#[tauri::command]
pub async fn resolve_design_target(
    window: WebviewWindow,
    probe: DesignTargetProbe,
    state: tauri::State<'_, AppState>,
    source_state: tauri::State<'_, DesignSourceState>,
) -> Result<DesignTargetResolution, String> {
    let root = project_root(&state)?;
    let cached = source_state
        .index
        .lock()
        .map_err(|_| "Source index is unavailable.".to_string())?
        .clone();
    if cached
        .as_ref()
        .is_some_and(|index| index_needs_refresh(index, &root))
    {
        *source_state
            .index
            .lock()
            .map_err(|_| "Source index is unavailable.".to_string())? = None;
    }

    let runtime = if probe.point.is_some() && is_local_preview_url(&probe.preview_url) {
        inspect_live_target(&window, &probe.preview_url, probe.point.unwrap())
            .await
            .ok()
    } else {
        None
    };
    let inspected_by = if runtime.is_some() {
        "webview"
    } else if probe.dom_context.is_some() {
        "dom"
    } else {
        "visual"
    };
    let preview_url = probe.preview_url.clone();
    let target = normalize_probe(probe, runtime);
    let index = ensure_index(&source_state, root).await?;
    let sources = resolve_sources(&index, &target, &preview_url);
    let rect = (target.rect.width > 0.0 && target.rect.height > 0.0).then_some(target.rect);
    Ok(DesignTargetResolution {
        tag: target.tag,
        text: target.text,
        selector: target.selector,
        dom_context: target.dom_context,
        rect,
        sources,
        inspected_by: inspected_by.into(),
        index_partial: index.partial,
    })
}

fn is_local_preview_url(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with("http://localhost")
        || lower.starts_with("https://localhost")
        || lower.starts_with("http://127.0.0.1")
        || lower.starts_with("https://127.0.0.1")
}

#[cfg(not(windows))]
async fn inspect_live_target(
    _window: &WebviewWindow,
    _preview_url: &str,
    _point: DesignPoint,
) -> Result<RuntimeTarget, String> {
    Err("Live Source Lens inspection is currently available on Windows only.".into())
}

#[cfg(windows)]
async fn call_devtools(
    window: &WebviewWindow,
    method: &str,
    parameters: Value,
) -> Result<Value, String> {
    use tokio::sync::oneshot;
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR};

    let (sender, receiver) = oneshot::channel::<Result<Value, String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let callback_sender = sender.clone();
    let method = method.to_string();
    let parameters = parameters.to_string();
    window
        .with_webview(move |webview| {
            let result = (|| -> Result<(), String> {
                let core = unsafe { webview.controller().CoreWebView2() }
                    .map_err(|error| format!("Could not access WebView2: {error}"))?;
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |status, result_json| {
                        let result = status
                            .map_err(|error| format!("WebView2 inspection failed: {error}"))
                            .and_then(|_| {
                                serde_json::from_str::<Value>(&result_json)
                                    .map_err(|error| format!("Invalid WebView2 response: {error}"))
                            });
                        if let Ok(mut guard) = callback_sender.lock() {
                            if let Some(sender) = guard.take() {
                                let _ = sender.send(result);
                            }
                        }
                        Ok(())
                    },
                ));
                let method = CoTaskMemPWSTR::from(method.as_str());
                let parameters = CoTaskMemPWSTR::from(parameters.as_str());
                unsafe {
                    core.CallDevToolsProtocolMethod(
                        *method.as_ref().as_pcwstr(),
                        *parameters.as_ref().as_pcwstr(),
                        &handler,
                    )
                }
                .map_err(|error| format!("Could not start WebView2 inspection: {error}"))?;
                Ok(())
            })();
            if let Err(error) = result {
                if let Ok(mut guard) = sender.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(Err(error));
                    }
                }
            }
        })
        .map_err(|error| format!("Could not schedule WebView2 inspection: {error}"))?;

    tokio::time::timeout(Duration::from_millis(850), receiver)
        .await
        .map_err(|_| "Source Lens inspection timed out.".to_string())?
        .map_err(|_| "Source Lens inspection was cancelled.".to_string())?
}

#[cfg(windows)]
fn find_frame_id(tree: &Value, preview_url: &str) -> Option<String> {
    let frame = tree.get("frame")?;
    let frame_url = frame.get("url").and_then(Value::as_str).unwrap_or("");
    let requested = preview_url.trim_end_matches('/');
    if frame_url.trim_end_matches('/') == requested
        || frame_url.starts_with(&format!("{requested}?"))
        || frame_url.starts_with(&format!("{requested}#"))
    {
        return frame.get("id").and_then(Value::as_str).map(str::to_string);
    }
    tree.get("childFrames")
        .and_then(Value::as_array)
        .and_then(|children| {
            children
                .iter()
                .find_map(|child| find_frame_id(child, preview_url))
        })
}

#[cfg(windows)]
fn runtime_expression(point: DesignPoint) -> String {
    let x = point.x.clamp(0.0, 20_000.0);
    let y = point.y.clamp(0.0, 20_000.0);
    format!(
        r#"(() => {{
  const clip = (value, max) => String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
  const interactive = "a,button,input,select,textarea,[role='button'],[role='link'],[tabindex]";
  const raw = document.elementFromPoint({x:.2}, {y:.2});
  if (!raw) return null;
  let node = raw;
  for (let current = raw; current && current !== document.body; current = current.parentElement) {{
    if (current.matches && current.matches(interactive)) {{ node = current; break; }}
    const rect = current.getBoundingClientRect();
    const display = getComputedStyle(current).display || '';
    if (!display.startsWith('inline') && rect.width >= 24 && rect.height >= 18 && clip(current.innerText, 120)) {{
      node = current;
      break;
    }}
  }}
  const cssPath = (element) => {{
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    for (let current = element; current && current !== document.body && parts.length < 6; current = current.parentElement) {{
      let part = current.tagName.toLowerCase();
      const classes = Array.from(current.classList || []).filter(Boolean).slice(0, 2);
      if (classes.length) part += classes.map((name) => '.' + CSS.escape(name)).join('');
      const parent = current.parentElement;
      if (parent) {{
        const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
        if (siblings.length > 1 && !classes.length) part += `:nth-of-type(${{siblings.indexOf(current) + 1}})`;
      }}
      parts.unshift(part);
    }}
    return parts.join(' > ');
  }};
  const styleSelectors = [];
  let visitedRules = 0;
  for (const sheet of Array.from(document.styleSheets || [])) {{
    let rules;
    try {{ rules = Array.from(sheet.cssRules || []); }} catch {{ continue; }}
    for (const rule of rules) {{
      if (++visitedRules > 2500 || styleSelectors.length >= 16) break;
      const selector = rule.selectorText;
      if (!selector) continue;
      try {{ if (node.matches(selector)) styleSelectors.push(clip(selector, 240)); }} catch {{}}
    }}
    if (visitedRules > 2500 || styleSelectors.length >= 16) break;
  }}
  let sourceFile = '';
  let sourceLine = null;
  let sourceColumn = null;
  try {{
    const vue = node.__vueParentComponent;
    sourceFile = clip(vue && vue.type && vue.type.__file, 500);
  }} catch {{}}
  try {{
    const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
    let fiber = key ? node[key] : null;
    for (let depth = 0; fiber && depth < 12; depth++, fiber = fiber.return) {{
      const source = fiber._debugSource;
      if (source && source.fileName) {{
        sourceFile = clip(source.fileName, 500);
        sourceLine = Number(source.lineNumber) || null;
        sourceColumn = Number(source.columnNumber) || null;
        break;
      }}
    }}
  }} catch {{}}
  const rect = node.getBoundingClientRect();
  const clone = node.cloneNode(true);
  clone.classList && clone.classList.remove('horma-design-selected', 'horma-design-hover');
  return {{
    tag: clip(node.tagName, 40).toLowerCase(),
    text: clip(node.innerText || node.textContent, 180),
    selector: cssPath(node),
    domContext: {{
      id: clip(node.id, 100),
      classes: Array.from(node.classList || []).map((value) => clip(value, 100)).filter(Boolean).slice(0, 16),
      role: clip(node.getAttribute('role'), 80),
      ariaLabel: clip(node.getAttribute('aria-label'), 180),
      testId: clip(node.getAttribute('data-testid'), 120),
      name: clip(node.getAttribute('name'), 120),
      href: clip(node.getAttribute('href') || node.getAttribute('action'), 240),
      html: clip(clone.outerHTML, 1200)
    }},
    rect: {{ x: rect.left, y: rect.top, width: rect.width, height: rect.height }},
    styleSelectors: Array.from(new Set(styleSelectors)),
    sourceFile,
    sourceLine,
    sourceColumn
  }};
}})()"#
    )
}

#[cfg(windows)]
async fn inspect_live_target(
    window: &WebviewWindow,
    preview_url: &str,
    point: DesignPoint,
) -> Result<RuntimeTarget, String> {
    if !point.x.is_finite() || !point.y.is_finite() {
        return Err("Source Lens pointer coordinates are invalid.".into());
    }
    let tree = call_devtools(window, "Page.getFrameTree", json!({})).await?;
    let frame_tree = tree
        .get("frameTree")
        .ok_or_else(|| "WebView2 did not return the preview frame tree.".to_string())?;
    let frame_id = find_frame_id(frame_tree, preview_url)
        .ok_or_else(|| "The active live-preview frame was not found.".to_string())?;
    let world = call_devtools(
        window,
        "Page.createIsolatedWorld",
        json!({
            "frameId": frame_id,
            "worldName": "hormachuelos-source-lens",
            "grantUniveralAccess": false
        }),
    )
    .await?;
    let context_id = world
        .get("executionContextId")
        .and_then(Value::as_u64)
        .ok_or_else(|| "WebView2 did not create a preview inspection context.".to_string())?;
    let evaluated = call_devtools(
        window,
        "Runtime.evaluate",
        json!({
            "expression": runtime_expression(point),
            "contextId": context_id,
            "returnByValue": true,
            "awaitPromise": false,
            "silent": true
        }),
    )
    .await?;
    if evaluated.get("exceptionDetails").is_some() {
        return Err("The live preview rejected element inspection.".into());
    }
    let value = evaluated
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| "No preview element was found at that point.".to_string())?;
    serde_json::from_value(value).map_err(|error| format!("Invalid preview target data: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TestProject(PathBuf);

    impl TestProject {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("hormachuelos-source-lens-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn write(&self, relative: &str, content: &str) {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
    }

    impl Drop for TestProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn target() -> RuntimeTarget {
        RuntimeTarget {
            tag: "button".into(),
            text: "Publish order".into(),
            selector: "#publish-order".into(),
            dom_context: DesignDomContext {
                id: "publish-order".into(),
                classes: vec!["primary-action".into()],
                test_id: "publish-order".into(),
                ..Default::default()
            },
            style_selectors: vec![".primary-action".into()],
            ..Default::default()
        }
    }

    #[test]
    fn resolves_frontend_style_and_direct_backend_route() {
        let project = TestProject::new();
        project.write(
            "src/components/PublishButton.tsx",
            r#"export function PublishButton() {
  async function publish() {
    await fetch('/api/orders/publish', { method: 'POST' });
  }
  return <button id="publish-order" data-testid="publish-order" className="primary-action" onClick={publish}>Publish order</button>;
}"#,
        );
        project.write(
            "src/styles/actions.css",
            ".primary-action { padding: 12px 18px; }",
        );
        project.write(
            "app/api/orders/publish/route.ts",
            "export async function POST() { return Response.json({ ok: true }); }",
        );
        let index = build_index(&project.0).unwrap();
        let locations = resolve_sources(&index, &target(), "http://localhost:3000/orders");
        assert!(locations.iter().any(|location| {
            location.kind == DesignSourceKind::Frontend
                && location.path == "src/components/PublishButton.tsx"
                && location.confidence == DesignSourceConfidence::Strong
        }));
        assert!(locations.iter().any(|location| {
            location.kind == DesignSourceKind::Style && location.path == "src/styles/actions.css"
        }));
        assert!(locations.iter().any(|location| {
            location.kind == DesignSourceKind::Backend
                && location.path == "app/api/orders/publish/route.ts"
        }));
    }

    #[test]
    fn maps_direct_endpoints_to_non_javascript_backends() {
        let project = TestProject::new();
        project.write(
            "src/components/PublishButton.tsx",
            r#"export const PublishButton = () => <button id="publish-order" onClick={() => fetch('/api/orders/publish')}>Publish order</button>;"#,
        );
        project.write(
            "backend/controllers/orders.py",
            "@router.post('/api/orders/publish')\ndef publish_order():\n    return {'ok': True}\n",
        );
        let index = build_index(&project.0).unwrap();
        let locations = resolve_sources(&index, &target(), "http://localhost:3000/orders");
        assert!(locations.iter().any(|location| {
            location.kind == DesignSourceKind::Backend
                && location.path == "backend/controllers/orders.py"
        }));
        assert!(locations
            .iter()
            .filter(|location| { location.path == "backend/controllers/orders.py" })
            .all(|location| location.kind == DesignSourceKind::Backend));
    }

    #[test]
    fn ambiguous_text_matches_are_labeled_likely() {
        let project = TestProject::new();
        project.write(
            "src/One.tsx",
            "export const One = () => <button>Publish order</button>;",
        );
        project.write(
            "src/Two.tsx",
            "export const Two = () => <button>Publish order</button>;",
        );
        let mut target = target();
        target.dom_context.id.clear();
        target.dom_context.test_id.clear();
        target.dom_context.classes.clear();
        target.selector = "button".into();
        let index = build_index(&project.0).unwrap();
        let locations = resolve_sources(&index, &target, "http://localhost:3000");
        assert!(locations
            .iter()
            .filter(|location| location.kind == DesignSourceKind::Frontend)
            .all(|location| location.confidence == DesignSourceConfidence::Likely));
    }

    #[test]
    fn generated_and_dependency_directories_are_excluded() {
        let project = TestProject::new();
        project.write(
            "src/Button.tsx",
            "export const Button = () => <button id=\"publish-order\" />;",
        );
        project.write(
            "node_modules/pkg/Button.tsx",
            "<button id=\"publish-order\" />",
        );
        project.write("dist/Button.js", "document.querySelector('#publish-order')");
        let index = build_index(&project.0).unwrap();
        assert_eq!(index.files.len(), 1);
        assert_eq!(index.files[0].path, "src/Button.tsx");
    }
}
