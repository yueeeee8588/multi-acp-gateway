use std::path::{Path, PathBuf};

pub const GATEWAY_8046_SCRIPT: &str = "Gateway-8046-Autostart.vbs";
pub const ACP_8048_SCRIPT: &str = "AGY-8048-Autostart.vbs";

pub fn is_supported() -> bool {
    cfg!(windows)
}

pub fn vbs_string_expr(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".to_string();
    }

    let mut parts: Vec<String> = Vec::new();
    let mut ascii_buf = String::new();

    for ch in value.chars() {
        if ch.is_ascii() && !ch.is_ascii_control() {
            if ch == '"' {
                ascii_buf.push_str("\"\"");
            } else {
                ascii_buf.push(ch);
            }
        } else {
            if !ascii_buf.is_empty() {
                parts.push(format!("\"{ascii_buf}\""));
                ascii_buf.clear();
            }
            let mut units = [0u16; 2];
            for unit in ch.encode_utf16(&mut units) {
                parts.push(format!("ChrW(&H{unit:04X})"));
            }
        }
    }

    if !ascii_buf.is_empty() {
        parts.push(format!("\"{ascii_buf}\""));
    }

    parts.join(" & ")
}

fn clean_windows_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        raw.into_owned()
    }
}

fn env_non_empty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn resolve_acp_8048_dir(work_dir: &Path) -> Option<PathBuf> {
    if let Some(dir) = env_non_empty("ACP_GATEWAY_DIR") {
        let candidate = PathBuf::from(dir);
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    for name in ["acp-gateway-8048", "agy-gemini-8048"] {
        let candidate = work_dir.join(name);
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_bun_executable() -> String {
    if let Some(bun) = env_non_empty("AGY_8048_BUN") {
        return bun;
    }
    if let Some(bun) = env_non_empty("BUN_PATH") {
        return bun;
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for bin in ["bun.exe", "bun"] {
                let candidate = dir.join(bin);
                if candidate.is_file() {
                    return clean_windows_path(&candidate);
                }
            }
        }
    }
    "bun".to_string()
}

fn build_8046_vbs(
    work_dir: &Path,
    exe_path: &Path,
    bind_addr: &str,
    data_dir: &str,
    web_dir: &str,
) -> String {
    let work_dir_str = clean_windows_path(work_dir);
    let exe_str = clean_windows_path(exe_path);
    let run_cmd = format!("\"{exe_str}\"");

    [
        "Option Explicit".to_string(),
        "Dim shell, env".to_string(),
        "Set shell = CreateObject(\"WScript.Shell\")".to_string(),
        "Set env = shell.Environment(\"Process\")".to_string(),
        format!("env(\"BIND_ADDR\") = {}", vbs_string_expr(bind_addr)),
        format!("env(\"DATA_DIR\") = {}", vbs_string_expr(data_dir)),
        format!("env(\"WEB_DIR\") = {}", vbs_string_expr(web_dir)),
        format!("shell.CurrentDirectory = {}", vbs_string_expr(&work_dir_str)),
        format!("shell.Run {}, 0, False", vbs_string_expr(&run_cmd)),
        String::new(),
    ]
    .join("\r\n")
}

fn build_8048_vbs(acp_dir: &Path) -> String {
    let acp_dir_str = clean_windows_path(acp_dir);
    let silent_vbs = acp_dir.join("launch_8048_silent.vbs");
    let run_cmd = if silent_vbs.is_file() {
        let silent_str = clean_windows_path(&silent_vbs);
        format!("wscript.exe \"{silent_str}\"")
    } else {
        let bun = resolve_bun_executable();
        format!("\"{bun}\" run src/server.ts")
    };

    [
        "Option Explicit".to_string(),
        "Dim shell".to_string(),
        "Set shell = CreateObject(\"WScript.Shell\")".to_string(),
        format!("shell.CurrentDirectory = {}", vbs_string_expr(&acp_dir_str)),
        format!("shell.Run {}, 0, False", vbs_string_expr(&run_cmd)),
        String::new(),
    ]
    .join("\r\n")
}

pub fn default_startup_dir() -> Result<PathBuf, String> {
    if let Some(dir) = env_non_empty("GATEWAY_STARTUP_DIR") {
        return Ok(PathBuf::from(dir));
    }
    if let Some(dir) = env_non_empty("ZAKO_STARTUP_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let appdata = env_non_empty("APPDATA")
        .ok_or_else(|| "APPDATA environment variable is not set".to_string())?;
    Ok(PathBuf::from(appdata)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Startup"))
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove {}: {error}", path.display())),
    }
}

pub fn apply_in_dir(enabled: bool, startup_dir: &Path) -> Result<(), String> {
    if !enabled {
        remove_if_exists(&startup_dir.join(GATEWAY_8046_SCRIPT))?;
        remove_if_exists(&startup_dir.join(ACP_8048_SCRIPT))?;
        return Ok(());
    }

    std::fs::create_dir_all(startup_dir)
        .map_err(|error| format!("Failed to create startup directory: {error}"))?;

    let work_dir = std::env::current_dir()
        .map_err(|error| format!("Failed to resolve current directory: {error}"))?;
    let exe_path = std::env::current_exe()
        .map_err(|error| format!("Failed to resolve current executable: {error}"))?;
    let bind_addr = env_non_empty("BIND_ADDR").unwrap_or_else(|| "127.0.0.1:8046".to_string());
    let data_dir = env_non_empty("DATA_DIR").unwrap_or_else(|| "data".to_string());
    let web_dir = env_non_empty("WEB_DIR").unwrap_or_else(|| r"web\dist".to_string());

    let vbs_8046 = build_8046_vbs(&work_dir, &exe_path, &bind_addr, &data_dir, &web_dir);
    std::fs::write(startup_dir.join(GATEWAY_8046_SCRIPT), vbs_8046)
        .map_err(|error| format!("Failed to write {GATEWAY_8046_SCRIPT}: {error}"))?;

    if let Some(acp_dir) = resolve_acp_8048_dir(&work_dir) {
        let vbs_8048 = build_8048_vbs(&acp_dir);
        std::fs::write(startup_dir.join(ACP_8048_SCRIPT), vbs_8048)
            .map_err(|error| format!("Failed to write {ACP_8048_SCRIPT}: {error}"))?;
    }

    Ok(())
}

pub fn apply(enabled: bool) -> Result<(), String> {
    if !is_supported() {
        return Ok(());
    }
    let dir = default_startup_dir()?;
    apply_in_dir(enabled, &dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vbs_string_expr_encodes_quotes_and_unicode() {
        assert_eq!(vbs_string_expr(""), "\"\"");
        assert_eq!(
            vbs_string_expr(r#"C:\Program Files\"app".exe"#),
            r#""C:\Program Files\""app"".exe""#
        );
        assert_eq!(
            vbs_string_expr(r"C:\测试\app.exe"),
            r#""C:\" & ChrW(&H6D4B) & ChrW(&H8BD5) & "\app.exe""#
        );
    }

    #[test]
    fn clean_windows_path_strips_verbatim_prefix() {
        assert_eq!(
            clean_windows_path(Path::new(r"\\?\C:\workspace\gateway.exe")),
            r"C:\workspace\gateway.exe"
        );
        assert_eq!(
            clean_windows_path(Path::new(r"\\?\UNC\server\share\app.exe")),
            r"\\server\share\app.exe"
        );
    }

    #[test]
    fn build_8046_vbs_contains_env_and_hidden_run() {
        let content = build_8046_vbs(
            Path::new(r"\\?\C:\网关目录"),
            Path::new(r"\\?\C:\网关目录\multi-acp-gateway.exe"),
            "127.0.0.1:8046",
            "data",
            r"web\dist",
        );
        assert!(content.contains("env(\"BIND_ADDR\") = \"127.0.0.1:8046\""));
        assert!(content.contains("env(\"DATA_DIR\") = \"data\""));
        assert!(content.contains(r#"env("WEB_DIR") = "web\dist""#));
        assert!(content.contains("ChrW(&H7F51) & ChrW(&H5173)"));
        assert!(content.contains(", 0, False"));
    }

    #[test]
    fn build_8048_vbs_prefers_silent_vbs_and_falls_back_to_bun() {
        let temp = tempfile::tempdir().unwrap();
        let acp_dir = temp.path().join("acp-gateway-8048");
        std::fs::create_dir_all(&acp_dir).unwrap();

        let fallback = build_8048_vbs(&acp_dir);
        assert!(fallback.contains("run src/server.ts"));
        assert!(fallback.contains(", 0, False"));

        std::fs::write(acp_dir.join("launch_8048_silent.vbs"), "' silent").unwrap();
        let silent = build_8048_vbs(&acp_dir);
        assert!(silent.contains("wscript.exe"));
        assert!(silent.contains("launch_8048_silent.vbs"));
        assert!(silent.contains(", 0, False"));
    }

    #[test]
    fn apply_in_dir_creates_and_removes_scripts_in_temp_dir() {
        let temp = tempfile::tempdir().unwrap();
        let startup_dir = temp.path().join("Startup");

        apply_in_dir(true, &startup_dir).unwrap();
        assert!(startup_dir.join(GATEWAY_8046_SCRIPT).is_file());

        // Simulate an 8048 script also present, then disable and verify both are removed.
        std::fs::write(startup_dir.join(ACP_8048_SCRIPT), "' 8048").unwrap();
        apply_in_dir(false, &startup_dir).unwrap();
        assert!(!startup_dir.join(GATEWAY_8046_SCRIPT).exists());
        assert!(!startup_dir.join(ACP_8048_SCRIPT).exists());

        // Disabling again when already absent must succeed (ignore NotFound).
        apply_in_dir(false, &startup_dir).unwrap();
    }
}
