use chrono::Utc;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticsReport {
    pub checked_at: String,
    pub agy_found: bool,
    pub agy_path: Option<String>,
    pub browser_found: bool,
    pub browser_name: Option<String>,
    pub browser_path: Option<String>,
    pub summary: String,
}

fn find_in_path(exe_name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(exe_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.is_file()).cloned()
}

pub fn probe_agy_exe() -> Option<PathBuf> {
    if let Some(found) = find_in_path("agy.exe") {
        return Some(found);
    }
    let mut candidates = Vec::new();
    if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
        let base = PathBuf::from(local_app);
        candidates.push(base.join("Programs").join("Antigravity").join("agy.exe"));
        candidates.push(base.join("Programs").join("agy").join("agy.exe"));
        candidates.push(base.join("Antigravity").join("agy.exe"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        let base = PathBuf::from(pf);
        candidates.push(base.join("Antigravity").join("agy.exe"));
        candidates.push(base.join("agy").join("agy.exe"));
    }
    first_existing(&candidates)
}

pub fn probe_browser() -> Option<(String, PathBuf)> {
    let mut chrome_candidates = Vec::new();
    let mut edge_candidates = Vec::new();

    if let Ok(pf) = std::env::var("ProgramFiles") {
        let base = PathBuf::from(&pf);
        chrome_candidates.push(base.join("Google\\Chrome\\Application\\chrome.exe"));
        edge_candidates.push(base.join("Microsoft\\Edge\\Application\\msedge.exe"));
    }
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        let base = PathBuf::from(&pf86);
        chrome_candidates.push(base.join("Google\\Chrome\\Application\\chrome.exe"));
        edge_candidates.push(base.join("Microsoft\\Edge\\Application\\msedge.exe"));
    }
    if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
        let base = PathBuf::from(&local_app);
        chrome_candidates.push(base.join("Google\\Chrome\\Application\\chrome.exe"));
        edge_candidates.push(base.join("Microsoft\\Edge\\Application\\msedge.exe"));
    }

    if let Some(p) = first_existing(&chrome_candidates).or_else(|| find_in_path("chrome.exe")) {
        return Some(("Chrome".to_string(), p));
    }
    if let Some(p) = first_existing(&edge_candidates).or_else(|| find_in_path("msedge.exe")) {
        return Some(("Edge".to_string(), p));
    }
    None
}

pub fn run_and_save(data_root: &Path) -> DiagnosticsReport {
    let agy = probe_agy_exe();
    let browser = probe_browser();

    let agy_label = if agy.is_some() { "AGY ✓" } else { "缺 AGY" };
    let browser_label = match &browser {
        Some((name, _)) => format!("{name} ✓"),
        None => "缺浏览器".to_string(),
    };
    let summary = format!("环境诊断: {agy_label} | {browser_label}");

    let report = DiagnosticsReport {
        checked_at: Utc::now().to_rfc3339(),
        agy_found: agy.is_some(),
        agy_path: agy.map(|p| p.display().to_string()),
        browser_found: browser.is_some(),
        browser_name: browser.as_ref().map(|(n, _)| n.clone()),
        browser_path: browser.map(|(_, p)| p.display().to_string()),
        summary,
    };

    if let Ok(json) = serde_json::to_string_pretty(&report) {
        let _ = fs::create_dir_all(data_root);
        let _ = fs::write(data_root.join("diagnostics.json"), json);
    }

    report
}
