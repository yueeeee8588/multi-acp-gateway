use serde::Serialize;
use std::path::{Path, PathBuf};

pub const GATEWAY_8046_SCRIPT: &str = "Gateway-8046-Autostart.vbs";
pub const ACP_8048_SCRIPT: &str = "ACP-8048-Autostart.vbs";
pub const APP2API_8049_SCRIPT: &str = "GeminiApp2Api-8049-Autostart.vbs";
pub const AISTUDIO_2048_SCRIPT: &str = "AiStudio-2048-Autostart.vbs";
pub const ENV_MANAGED_BY_TRAY: &str = "GATEWAY_MANAGED_BY_TRAY";
pub const DEFAULT_TRAY_REG_NAME: &str = "MultiAcpGateway";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AiStudioAutostartStatus {
    pub supported: bool,
    pub available: bool,
    pub enabled: bool,
    pub script_path: Option<String>,
}

pub fn is_supported() -> bool {
    cfg!(windows)
}

pub fn is_managed_by_tray_value(val: Option<&str>) -> bool {
    val.map(str::trim)
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
}

pub fn is_managed_by_tray() -> bool {
    is_managed_by_tray_value(non_empty_env(ENV_MANAGED_BY_TRAY).as_deref())
}

pub fn vbs_string_expr(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".to_string();
    }

    let mut parts: Vec<String> = Vec::new();
    let mut ascii_buf = String::new();

    let flush_ascii = |parts: &mut Vec<String>, buf: &mut String| {
        if !buf.is_empty() {
            parts.push(format!("\"{}\"", buf));
            buf.clear();
        }
    };

    for unit in value.encode_utf16() {
        if unit < 0x80 && unit != b'\r' as u16 && unit != b'\n' as u16 {
            let ch = unit as u8 as char;
            if ch == '"' {
                ascii_buf.push_str("\"\"");
            } else {
                ascii_buf.push(ch);
            }
        } else {
            flush_ascii(&mut parts, &mut ascii_buf);
            parts.push(format!("ChrW(&H{:04X})", unit));
        }
    }
    flush_ascii(&mut parts, &mut ascii_buf);

    parts.join(" & ")
}

fn strip_verbatim_prefix(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        raw.into_owned()
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn resolve_acp_dir(work_dir: &Path, acp_gateway_dir_env: Option<&str>) -> Option<PathBuf> {
    if let Some(env_dir) = acp_gateway_dir_env.map(str::trim).filter(|s| !s.is_empty()) {
        let candidate = PathBuf::from(env_dir);
        let resolved = if candidate.is_absolute() {
            candidate
        } else {
            work_dir.join(candidate)
        };
        if resolved.is_dir() {
            return Some(resolved);
        }
    }

    for folder in ["acp-gateway-8048"] {
        let candidate = work_dir.join(folder);
        if candidate.is_dir() {
            return Some(candidate);
        }
    }

    None
}

fn resolve_app2api_dir(
    work_dir: &Path,
    app2api_gateway_dir_env: Option<&str>,
) -> Option<PathBuf> {
    if let Some(env_dir) = app2api_gateway_dir_env
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let candidate = PathBuf::from(env_dir);
        let resolved = if candidate.is_absolute() {
            candidate
        } else {
            work_dir.join(candidate)
        };
        if resolved.is_dir() {
            return Some(resolved);
        }
    }

    let candidate = work_dir.join("gemini-app2api-8049");
    if candidate.is_dir() {
        return Some(candidate);
    }

    None
}

fn resolve_aistudio_dir(
    work_dir: &Path,
    aistudio_gateway_dir_env: Option<&str>,
) -> Option<PathBuf> {
    if let Some(env_dir) = aistudio_gateway_dir_env
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let candidate = PathBuf::from(env_dir);
        let resolved = if candidate.is_absolute() {
            candidate
        } else {
            work_dir.join(candidate)
        };
        if resolved.is_dir() {
            return Some(resolved);
        }
    }

    let candidate = work_dir.join("magpie-aistudio-2048");
    if candidate.is_dir() {
        return Some(candidate);
    }

    None
}

fn resolve_node_executable(app2api_node_env: Option<&str>) -> String {
    if let Some(trimmed) = app2api_node_env.map(str::trim).filter(|s| !s.is_empty()) {
        return trimmed.to_string();
    }

    let node_names: &[&str] = if cfg!(windows) {
        &["node.exe", "node.cmd", "node"]
    } else {
        &["node"]
    };

    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for name in node_names {
                let full = dir.join(name);
                if full.is_file() {
                    return strip_verbatim_prefix(&full);
                }
            }
        }
    }

    "node".to_string()
}

fn resolve_bun_executable(acp_bun_env: Option<&str>, bun_path_env: Option<&str>) -> String {
    for candidate in [acp_bun_env, bun_path_env].into_iter().flatten() {
        let trimmed = candidate.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let bun_names: &[&str] = if cfg!(windows) {
        &["bun.exe", "bun.cmd", "bun"]
    } else {
        &["bun"]
    };

    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for name in bun_names {
                let full = dir.join(name);
                if full.is_file() {
                    return strip_verbatim_prefix(&full);
                }
            }
        }
    }

    "bun".to_string()
}

fn render_8046_vbs(
    work_dir: &Path,
    exe_path: &Path,
    bind_addr: &str,
    data_dir: &str,
    web_dir: &str,
) -> String {
    let work_dir_str = strip_verbatim_prefix(work_dir);
    let exe_str = strip_verbatim_prefix(exe_path);
    let cmd = format!("\"{exe_str}\"");

    format!(
        "Set shell = CreateObject(\"WScript.Shell\")\r\n\
         Set env = shell.Environment(\"PROCESS\")\r\n\
         shell.CurrentDirectory = {}\r\n\
         env(\"BIND_ADDR\") = {}\r\n\
         env(\"DATA_DIR\") = {}\r\n\
         env(\"WEB_DIR\") = {}\r\n\
         shell.Run {}, 0, False\r\n",
        vbs_string_expr(&work_dir_str),
        vbs_string_expr(bind_addr),
        vbs_string_expr(data_dir),
        vbs_string_expr(web_dir),
        vbs_string_expr(&cmd),
    )
}

fn render_8048_vbs(acp_dir: &Path, bun_executable: &str) -> String {
    let acp_dir_str = strip_verbatim_prefix(acp_dir);
    let silent_vbs = acp_dir.join("launch_8048_silent.vbs");
    let cmd = if silent_vbs.is_file() {
        let silent_vbs_str = strip_verbatim_prefix(&silent_vbs);
        format!("wscript.exe \"{silent_vbs_str}\"")
    } else {
        format!("\"{bun_executable}\" run src/server.ts")
    };

    format!(
        "Set shell = CreateObject(\"WScript.Shell\")\r\n\
         shell.CurrentDirectory = {}\r\n\
         shell.Run {}, 0, False\r\n",
        vbs_string_expr(&acp_dir_str),
        vbs_string_expr(&cmd),
    )
}

fn render_8049_vbs(app2api_dir: &Path, node_executable: &str) -> String {
    let app2api_dir_str = strip_verbatim_prefix(app2api_dir);
    let silent_vbs = app2api_dir.join("launch_8049_silent.vbs");
    let cmd = if silent_vbs.is_file() {
        let silent_vbs_str = strip_verbatim_prefix(&silent_vbs);
        format!("wscript.exe \"{silent_vbs_str}\"")
    } else {
        format!("\"{node_executable}\" src/gateway-server.mjs")
    };

    format!(
        "Set shell = CreateObject(\"WScript.Shell\")\r\n\
         shell.CurrentDirectory = {}\r\n\
         shell.Run {}, 0, False\r\n",
        vbs_string_expr(&app2api_dir_str),
        vbs_string_expr(&cmd),
    )
}

fn render_2048_vbs(aistudio_dir: &Path) -> String {
    let aistudio_dir_str = strip_verbatim_prefix(aistudio_dir);
    let silent_vbs = aistudio_dir.join("launch_2048_silent.vbs");
    let cmd = if silent_vbs.is_file() {
        let silent_vbs_str = strip_verbatim_prefix(&silent_vbs);
        format!("wscript.exe \"{silent_vbs_str}\"")
    } else {
        let manage_ps1 = aistudio_dir.join("manage_aistudio.ps1");
        let manage_ps1_str = strip_verbatim_prefix(&manage_ps1);
        format!(
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{manage_ps1_str}\" start"
        )
    };

    format!(
        "Set shell = CreateObject(\"WScript.Shell\")\r\n\
         shell.CurrentDirectory = {}\r\n\
         shell.Run {}, 0, False\r\n",
        vbs_string_expr(&aistudio_dir_str),
        vbs_string_expr(&cmd),
    )
}

#[allow(clippy::too_many_arguments)]
fn apply_in_dir_with_context(
    enabled: bool,
    startup_dir: &Path,
    work_dir: &Path,
    exe_path: &Path,
    bind_addr: &str,
    data_dir: &str,
    web_dir: &str,
    acp_dir: Option<&Path>,
    bun_executable: &str,
    app2api_dir: Option<&Path>,
    node_executable: &str,
) -> Result<(), String> {
    if !enabled {
        for script_name in [GATEWAY_8046_SCRIPT, ACP_8048_SCRIPT, APP2API_8049_SCRIPT] {
            let target = startup_dir.join(script_name);
            match std::fs::remove_file(&target) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "Failed to remove autostart script {}: {error}",
                        target.display()
                    ));
                }
            }
        }
        return Ok(());
    }

    std::fs::create_dir_all(startup_dir).map_err(|error| {
        format!(
            "Failed to create startup directory {}: {error}",
            startup_dir.display()
        )
    })?;

    let gateway_script = render_8046_vbs(work_dir, exe_path, bind_addr, data_dir, web_dir);
    let gateway_target = startup_dir.join(GATEWAY_8046_SCRIPT);
    std::fs::write(&gateway_target, gateway_script).map_err(|error| {
        format!(
            "Failed to write autostart script {}: {error}",
            gateway_target.display()
        )
    })?;

    if let Some(acp_dir) = acp_dir {
        let acp_script = render_8048_vbs(acp_dir, bun_executable);
        let acp_target = startup_dir.join(ACP_8048_SCRIPT);
        std::fs::write(&acp_target, acp_script).map_err(|error| {
            format!(
                "Failed to write autostart script {}: {error}",
                acp_target.display()
            )
        })?;
    }

    if let Some(app2api_dir) = app2api_dir {
        let app2api_script = render_8049_vbs(app2api_dir, node_executable);
        let app2api_target = startup_dir.join(APP2API_8049_SCRIPT);
        std::fs::write(&app2api_target, app2api_script).map_err(|error| {
            format!(
                "Failed to write autostart script {}: {error}",
                app2api_target.display()
            )
        })?;
    }

    Ok(())
}

pub fn apply_in_dir(enabled: bool, startup_dir: &Path) -> Result<(), String> {
    if !enabled {
        return apply_in_dir_with_context(
            false,
            startup_dir,
            Path::new(""),
            Path::new(""),
            "",
            "",
            "",
            None,
            "",
            None,
            "",
        );
    }

    let work_dir = std::env::current_dir()
        .map_err(|error| format!("Failed to resolve current working directory: {error}"))?;
    let exe_path = std::env::current_exe()
        .map_err(|error| format!("Failed to resolve current executable path: {error}"))?;
    let bind_addr = non_empty_env("BIND_ADDR").unwrap_or_else(|| "127.0.0.1:8046".to_string());
    let data_dir = non_empty_env("DATA_DIR").unwrap_or_else(|| "data".to_string());
    let web_dir = non_empty_env("WEB_DIR").unwrap_or_else(|| r"web\dist".to_string());

    let acp_env = non_empty_env("ACP_GATEWAY_DIR");
    let acp_dir = resolve_acp_dir(&work_dir, acp_env.as_deref());
    let acp_bun = non_empty_env("ACP_8048_BUN");
    let bun_path = non_empty_env("BUN_PATH");
    let bun_executable = resolve_bun_executable(acp_bun.as_deref(), bun_path.as_deref());

    let app2api_env = non_empty_env("APP2API_GATEWAY_DIR");
    let app2api_dir = resolve_app2api_dir(&work_dir, app2api_env.as_deref());
    let app2api_node = non_empty_env("APP2API_8049_NODE");
    let node_executable = resolve_node_executable(app2api_node.as_deref());

    apply_in_dir_with_context(
        true,
        startup_dir,
        &work_dir,
        &exe_path,
        &bind_addr,
        &data_dir,
        &web_dir,
        acp_dir.as_deref(),
        &bun_executable,
        app2api_dir.as_deref(),
        &node_executable,
    )
}

fn resolve_startup_dir() -> Result<PathBuf, String> {
    if let Some(override_dir) = non_empty_env("GATEWAY_STARTUP_DIR") {
        return Ok(PathBuf::from(override_dir));
    }
    let appdata = non_empty_env("APPDATA")
        .ok_or_else(|| "APPDATA environment variable is not set".to_string())?;
    Ok(PathBuf::from(appdata)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Startup"))
}

fn resolve_tray_reg_name() -> String {
    non_empty_env("GATEWAY_AUTOSTART_REG_NAME")
        .unwrap_or_else(|| DEFAULT_TRAY_REG_NAME.to_string())
}

fn resolve_tray_exe_path_from(
    tray_exe_env: Option<&str>,
    current_exe: Option<&Path>,
) -> Result<PathBuf, String> {
    if let Some(env_path) = tray_exe_env.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(env_path));
    }
    let exe = current_exe.ok_or_else(|| {
        "GATEWAY_TRAY_EXE is not set and current executable path is unavailable".to_string()
    })?;
    let parent = exe.parent().ok_or_else(|| {
        format!(
            "Failed to resolve parent directory of executable {}",
            exe.display()
        )
    })?;
    Ok(parent.join("gateway-tray.exe"))
}

fn cleanup_legacy_startup_scripts(startup_dir: &Path) -> Result<(), String> {
    for script in [GATEWAY_8046_SCRIPT, ACP_8048_SCRIPT, APP2API_8049_SCRIPT] {
        let target = startup_dir.join(script);
        match std::fs::remove_file(&target) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to remove legacy autostart script {}: {error}",
                    target.display()
                ));
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
mod win_registry {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_SZ, RegCloseKey, RegCreateKeyW,
        RegDeleteValueW, RegOpenKeyExW, RegSetValueExW,
    };

    const RUN_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    fn to_wide_null(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn set_run_entry(reg_name: &str, command_value: &str) -> Result<(), String> {
        let subkey = to_wide_null(RUN_SUBKEY);
        let value_name = to_wide_null(reg_name);
        let data = to_wide_null(command_value);
        let mut hkey: HKEY = std::ptr::null_mut();

        let status = unsafe { RegCreateKeyW(HKEY_CURRENT_USER, subkey.as_ptr(), &mut hkey) };
        if status != ERROR_SUCCESS {
            return Err(format!(
                "Failed to open/create HKCU\\{RUN_SUBKEY} (Win32 error {status})"
            ));
        }

        let byte_len = u32::try_from(data.len().saturating_mul(2))
            .map_err(|_| "Registry value exceeds u32 byte length".to_string())?;
        let set_status = unsafe {
            RegSetValueExW(
                hkey,
                value_name.as_ptr(),
                0,
                REG_SZ,
                data.as_ptr() as *const u8,
                byte_len,
            )
        };
        unsafe {
            RegCloseKey(hkey);
        }
        if set_status != ERROR_SUCCESS {
            return Err(format!(
                "Failed to set HKCU\\{RUN_SUBKEY}\\{reg_name} (Win32 error {set_status})"
            ));
        }
        Ok(())
    }

    pub fn delete_run_entry(reg_name: &str) -> Result<(), String> {
        let subkey = to_wide_null(RUN_SUBKEY);
        let value_name = to_wide_null(reg_name);
        let mut hkey: HKEY = std::ptr::null_mut();

        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                KEY_SET_VALUE,
                &mut hkey,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(());
        }
        if status != ERROR_SUCCESS {
            return Err(format!(
                "Failed to open HKCU\\{RUN_SUBKEY} (Win32 error {status})"
            ));
        }

        let del_status = unsafe { RegDeleteValueW(hkey, value_name.as_ptr()) };
        unsafe {
            RegCloseKey(hkey);
        }
        if del_status != ERROR_SUCCESS && del_status != ERROR_FILE_NOT_FOUND {
            return Err(format!(
                "Failed to delete HKCU\\{RUN_SUBKEY}\\{reg_name} (Win32 error {del_status})"
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
fn apply_tray_managed(enabled: bool) -> Result<(), String> {
    let reg_name = resolve_tray_reg_name();
    if enabled {
        let current_exe = std::env::current_exe().ok();
        let tray_exe = resolve_tray_exe_path_from(
            non_empty_env("GATEWAY_TRAY_EXE").as_deref(),
            current_exe.as_deref(),
        )?;
        let command_value = format!("\"{}\" --minimized", strip_verbatim_prefix(&tray_exe));
        win_registry::set_run_entry(&reg_name, &command_value)?;
        if let Ok(startup_dir) = resolve_startup_dir() {
            cleanup_legacy_startup_scripts(&startup_dir)?;
        }
        Ok(())
    } else {
        win_registry::delete_run_entry(&reg_name)
    }
}

#[cfg(not(windows))]
fn apply_tray_managed(_enabled: bool) -> Result<(), String> {
    Ok(())
}

pub fn apply(enabled: bool) -> Result<(), String> {
    if !is_supported() {
        return Ok(());
    }
    if is_managed_by_tray() {
        return apply_tray_managed(enabled);
    }
    let startup_dir = resolve_startup_dir()?;
    apply_in_dir(enabled, &startup_dir)
}

fn resolve_tray_config_path_from(
    tray_config_env: Option<&str>,
    app_data_dir_env: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(config_path) = tray_config_env.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(config_path));
    }
    if let Some(app_data_dir) = app_data_dir_env.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(app_data_dir).join("tray-config.json"));
    }
    Err("Neither GATEWAY_TRAY_CONFIG nor APP_DATA_DIR is set in tray-managed mode".to_string())
}

fn resolve_tray_config_path() -> Result<PathBuf, String> {
    resolve_tray_config_path_from(
        non_empty_env("GATEWAY_TRAY_CONFIG").as_deref(),
        non_empty_env("APP_DATA_DIR").as_deref(),
    )
}

fn read_tray_aistudio_autostart(path: &Path) -> Result<bool, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Failed to read tray config {}: {error}",
                path.display()
            ));
        }
    };
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|error| {
        format!(
            "Failed to parse tray config {} as JSON: {error}",
            path.display()
        )
    })?;
    let obj = value.as_object().ok_or_else(|| {
        format!(
            "Tray config {} must contain a JSON object",
            path.display()
        )
    })?;
    match obj.get("aistudio_autostart") {
        None | Some(serde_json::Value::Null) => Ok(false),
        Some(serde_json::Value::Bool(enabled)) => Ok(*enabled),
        Some(_) => Err(format!(
            "Field 'aistudio_autostart' in {} must be a boolean",
            path.display()
        )),
    }
}

fn write_tray_aistudio_autostart(path: &Path, enabled: bool) -> Result<(), String> {
    let mut map = match std::fs::read_to_string(path) {
        Ok(raw) => {
            let value: serde_json::Value = serde_json::from_str(&raw).map_err(|error| {
                format!(
                    "Failed to parse tray config {} as JSON: {error}",
                    path.display()
                )
            })?;
            value
                .as_object()
                .cloned()
                .ok_or_else(|| format!("Tray config {} must contain a JSON object", path.display()))?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::Map::new(),
        Err(error) => {
            return Err(format!(
                "Failed to read tray config {}: {error}",
                path.display()
            ));
        }
    };

    map.insert(
        "aistudio_autostart".to_string(),
        serde_json::Value::Bool(enabled),
    );
    let serialized = serde_json::to_string_pretty(&serde_json::Value::Object(map))
        .map_err(|error| format!("Failed to serialize tray config: {error}"))?;

    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create tray config directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("tray-config.json");
    let tmp_path = path.with_file_name(format!(".{file_name}.{}.tmp", std::process::id()));
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp_path).map_err(|error| {
            format!(
                "Failed to create temporary tray config {}: {error}",
                tmp_path.display()
            )
        })?;
        if let Err(error) = file
            .write_all(serialized.as_bytes())
            .and_then(|()| file.sync_all())
        {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!(
                "Failed to write temporary tray config {}: {error}",
                tmp_path.display()
            ));
        }
    }
    if let Err(error) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!(
            "Failed to replace tray config {}: {error}",
            path.display()
        ));
    }
    Ok(())
}

fn aistudio_available_in_tray(
    work_dir: &Path,
    aistudio_gateway_dir_env: Option<&str>,
    aistudio_exe_env: Option<&str>,
    tray_exe_env: Option<&str>,
) -> bool {
    if let Some(exe) = aistudio_exe_env.map(str::trim).filter(|s| !s.is_empty())
        && Path::new(exe).is_file()
    {
        return true;
    }

    let candidate_dirs: Vec<PathBuf> = [
        tray_exe_env
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|p| Path::new(p).parent().map(Path::to_path_buf)),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf)),
    ]
    .into_iter()
    .flatten()
    .collect();

    for dir in candidate_dirs {
        for bin in [
            "aistudio-2048.exe",
            "magpie-aistudio-2048.exe",
            "aistudio-2048",
            "magpie-aistudio-2048",
        ] {
            if dir.join(bin).is_file() {
                return true;
            }
        }
    }

    resolve_aistudio_dir(work_dir, aistudio_gateway_dir_env)
        .is_some_and(|dir| aistudio_has_launcher(&dir))
}

fn aistudio_has_launcher(aistudio_dir: &Path) -> bool {
    aistudio_dir.join("launch_2048_silent.vbs").is_file()
        || aistudio_dir.join("manage_aistudio.ps1").is_file()
}

pub fn aistudio_status_in_dir(
    startup_dir: &Path,
    work_dir: &Path,
    aistudio_gateway_dir_env: Option<&str>,
) -> AiStudioAutostartStatus {
    let target = startup_dir.join(AISTUDIO_2048_SCRIPT);
    let available = resolve_aistudio_dir(work_dir, aistudio_gateway_dir_env)
        .is_some_and(|dir| aistudio_has_launcher(&dir));
    let enabled = target.is_file();
    AiStudioAutostartStatus {
        supported: is_supported(),
        available,
        enabled,
        script_path: Some(strip_verbatim_prefix(&target)),
    }
}

pub fn apply_aistudio_in_dir(
    enabled: bool,
    startup_dir: &Path,
    work_dir: &Path,
    aistudio_gateway_dir_env: Option<&str>,
) -> Result<AiStudioAutostartStatus, String> {
    let target = startup_dir.join(AISTUDIO_2048_SCRIPT);
    if !enabled {
        match std::fs::remove_file(&target) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to remove autostart script {}: {error}",
                    target.display()
                ));
            }
        }
        return Ok(aistudio_status_in_dir(
            startup_dir,
            work_dir,
            aistudio_gateway_dir_env,
        ));
    }

    let aistudio_dir = resolve_aistudio_dir(work_dir, aistudio_gateway_dir_env)
        .filter(|dir| aistudio_has_launcher(dir))
        .ok_or_else(|| {
            "AI Studio 2048 directory or launcher script (magpie-aistudio-2048) not found"
                .to_string()
        })?;

    std::fs::create_dir_all(startup_dir).map_err(|error| {
        format!(
            "Failed to create startup directory {}: {error}",
            startup_dir.display()
        )
    })?;

    let script = render_2048_vbs(&aistudio_dir);
    std::fs::write(&target, script).map_err(|error| {
        format!(
            "Failed to write autostart script {}: {error}",
            target.display()
        )
    })?;

    Ok(aistudio_status_in_dir(
        startup_dir,
        work_dir,
        aistudio_gateway_dir_env,
    ))
}

pub fn aistudio_status() -> Result<AiStudioAutostartStatus, String> {
    if !is_supported() {
        return Ok(AiStudioAutostartStatus {
            supported: false,
            available: false,
            enabled: false,
            script_path: None,
        });
    }
    if is_managed_by_tray() {
        let config_path = resolve_tray_config_path()?;
        let enabled = read_tray_aistudio_autostart(&config_path)?;
        let work_dir = std::env::current_dir()
            .map_err(|error| format!("Failed to resolve current working directory: {error}"))?;
        let aistudio_env = non_empty_env("AISTUDIO_GATEWAY_DIR");
        let aistudio_exe_env =
            non_empty_env("AISTUDIO_2048_EXE").or_else(|| non_empty_env("GATEWAY_AISTUDIO_EXE"));
        let tray_exe_env = non_empty_env("GATEWAY_TRAY_EXE");
        let available = aistudio_available_in_tray(
            &work_dir,
            aistudio_env.as_deref(),
            aistudio_exe_env.as_deref(),
            tray_exe_env.as_deref(),
        );
        return Ok(AiStudioAutostartStatus {
            supported: true,
            available,
            enabled,
            script_path: Some(strip_verbatim_prefix(&config_path)),
        });
    }
    let startup_dir = resolve_startup_dir()?;
    let work_dir = std::env::current_dir()
        .map_err(|error| format!("Failed to resolve current working directory: {error}"))?;
    let aistudio_env = non_empty_env("AISTUDIO_GATEWAY_DIR");
    Ok(aistudio_status_in_dir(
        &startup_dir,
        &work_dir,
        aistudio_env.as_deref(),
    ))
}

pub fn apply_aistudio(enabled: bool) -> Result<AiStudioAutostartStatus, String> {
    if !is_supported() {
        return Err("AI Studio 2048 autostart is only supported on Windows".to_string());
    }
    if is_managed_by_tray() {
        let config_path = resolve_tray_config_path()?;
        write_tray_aistudio_autostart(&config_path, enabled)?;
        let work_dir = std::env::current_dir()
            .map_err(|error| format!("Failed to resolve current working directory: {error}"))?;
        let aistudio_env = non_empty_env("AISTUDIO_GATEWAY_DIR");
        let aistudio_exe_env =
            non_empty_env("AISTUDIO_2048_EXE").or_else(|| non_empty_env("GATEWAY_AISTUDIO_EXE"));
        let tray_exe_env = non_empty_env("GATEWAY_TRAY_EXE");
        let available = aistudio_available_in_tray(
            &work_dir,
            aistudio_env.as_deref(),
            aistudio_exe_env.as_deref(),
            tray_exe_env.as_deref(),
        );
        return Ok(AiStudioAutostartStatus {
            supported: true,
            available,
            enabled,
            script_path: Some(strip_verbatim_prefix(&config_path)),
        });
    }
    let startup_dir = resolve_startup_dir()?;
    let work_dir = std::env::current_dir()
        .map_err(|error| format!("Failed to resolve current working directory: {error}"))?;
    let aistudio_env = non_empty_env("AISTUDIO_GATEWAY_DIR");
    apply_aistudio_in_dir(enabled, &startup_dir, &work_dir, aistudio_env.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vbs_string_expr_encodes_ascii_quotes_and_non_ascii() {
        assert_eq!(vbs_string_expr(""), "\"\"");
        assert_eq!(vbs_string_expr("abc"), "\"abc\"");
        assert_eq!(vbs_string_expr("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(
            vbs_string_expr(r"C:\测试\app.exe"),
            r#""C:\" & ChrW(&H6D4B) & ChrW(&H8BD5) & "\app.exe""#
        );
    }

    #[test]
    fn strip_verbatim_prefix_handles_windows_prefixes() {
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\C:\work\app.exe")),
            r"C:\work\app.exe"
        );
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\UNC\server\share\app.exe")),
            r"\\server\share\app.exe"
        );
    }

    #[test]
    fn apply_in_dir_writes_and_cleans_both_scripts() {
        let dir = tempfile::tempdir().unwrap();
        let startup_dir = dir.path().join("startup");
        let work_dir = dir.path().join("中文工作目录");
        let acp_dir = work_dir.join("acp-gateway-8048");
        std::fs::create_dir_all(&acp_dir).unwrap();
        std::fs::write(acp_dir.join("launch_8048_silent.vbs"), "' silent").unwrap();
        let app2api_dir = work_dir.join("gemini-app2api-8049");
        std::fs::create_dir_all(&app2api_dir).unwrap();
        std::fs::write(app2api_dir.join("launch_8049_silent.vbs"), "' silent 8049").unwrap();
        let exe_path = work_dir.join("multi-acp-gateway.exe");

        apply_in_dir_with_context(
            true,
            &startup_dir,
            &work_dir,
            &exe_path,
            "127.0.0.1:8046",
            "data",
            r"web\dist",
            Some(&acp_dir),
            "bun",
            Some(&app2api_dir),
            "node",
        )
        .unwrap();

        let gateway_vbs = std::fs::read_to_string(startup_dir.join(GATEWAY_8046_SCRIPT)).unwrap();
        assert!(gateway_vbs.contains("BIND_ADDR"));
        assert!(gateway_vbs.contains("127.0.0.1:8046"));
        assert!(gateway_vbs.contains("0, False"));
        assert!(gateway_vbs.contains("ChrW(&H4E2D)"));
        assert!(!gateway_vbs.contains(r"\\?\"));

        let acp_vbs = std::fs::read_to_string(startup_dir.join(ACP_8048_SCRIPT)).unwrap();
        assert!(acp_vbs.contains("wscript.exe"));
        assert!(acp_vbs.contains("launch_8048_silent.vbs"));
        assert!(acp_vbs.contains("0, False"));

        let app2api_vbs = std::fs::read_to_string(startup_dir.join(APP2API_8049_SCRIPT)).unwrap();
        assert!(app2api_vbs.contains("wscript.exe"));
        assert!(app2api_vbs.contains("launch_8049_silent.vbs"));
        assert!(app2api_vbs.contains("0, False"));

        // Fallback to bun/node when silent vbs scripts are absent
        std::fs::remove_file(acp_dir.join("launch_8048_silent.vbs")).unwrap();
        std::fs::remove_file(app2api_dir.join("launch_8049_silent.vbs")).unwrap();
        apply_in_dir_with_context(
            true,
            &startup_dir,
            &work_dir,
            &exe_path,
            "127.0.0.1:8046",
            "data",
            r"web\dist",
            Some(&acp_dir),
            r"C:\Tools\bun.exe",
            Some(&app2api_dir),
            r"C:\Program Files\nodejs\node.exe",
        )
        .unwrap();
        let acp_vbs_bun = std::fs::read_to_string(startup_dir.join(ACP_8048_SCRIPT)).unwrap();
        assert!(acp_vbs_bun.contains("bun.exe"));
        assert!(acp_vbs_bun.contains("run src/server.ts"));

        let app2api_vbs_node =
            std::fs::read_to_string(startup_dir.join(APP2API_8049_SCRIPT)).unwrap();
        assert!(app2api_vbs_node.contains("node.exe"));
        assert!(app2api_vbs_node.contains("src/gateway-server.mjs"));

        // Disable removes all scripts and is idempotent
        apply_in_dir(false, &startup_dir).unwrap();
        assert!(!startup_dir.join(GATEWAY_8046_SCRIPT).exists());
        assert!(!startup_dir.join(ACP_8048_SCRIPT).exists());
        assert!(!startup_dir.join(APP2API_8049_SCRIPT).exists());
        apply_in_dir(false, &startup_dir).unwrap();
    }

    #[test]
    fn resolve_acp_dir_checks_env_then_work_dir_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let work_dir = dir.path().join("work");
        let custom_dir = dir.path().join("custom-8048");
        let acp_dir = work_dir.join("acp-gateway-8048");
        std::fs::create_dir_all(&custom_dir).unwrap();
        std::fs::create_dir_all(&acp_dir).unwrap();

        assert_eq!(
            resolve_acp_dir(&work_dir, Some(custom_dir.to_str().unwrap())),
            Some(custom_dir)
        );
        assert_eq!(resolve_acp_dir(&work_dir, None), Some(acp_dir));
    }

    #[test]
    fn resolve_app2api_dir_checks_env_then_work_dir_candidate() {
        let dir = tempfile::tempdir().unwrap();
        let work_dir = dir.path().join("work");
        let custom_dir = dir.path().join("custom-8049");
        let default_dir = work_dir.join("gemini-app2api-8049");
        std::fs::create_dir_all(&custom_dir).unwrap();
        std::fs::create_dir_all(&default_dir).unwrap();

        assert_eq!(
            resolve_app2api_dir(&work_dir, Some(custom_dir.to_str().unwrap())),
            Some(custom_dir)
        );
        assert_eq!(resolve_app2api_dir(&work_dir, None), Some(default_dir));
    }

    #[test]
    fn aistudio_autostart_is_isolated_from_main_autostart() {
        let dir = tempfile::tempdir().unwrap();
        let startup_dir = dir.path().join("startup");
        let work_dir = dir.path().join("work");
        let aistudio_dir = work_dir.join("magpie-aistudio-2048");
        std::fs::create_dir_all(&aistudio_dir).unwrap();
        std::fs::write(aistudio_dir.join("launch_2048_silent.vbs"), "' silent 2048").unwrap();
        let exe_path = work_dir.join("multi-acp-gateway.exe");

        // Initial status: available=true, enabled=false
        let st0 = aistudio_status_in_dir(&startup_dir, &work_dir, None);
        assert!(st0.available);
        assert!(!st0.enabled);

        // Enable 2048 autostart
        let st1 = apply_aistudio_in_dir(true, &startup_dir, &work_dir, None).unwrap();
        assert!(st1.enabled);
        let aistudio_vbs = std::fs::read_to_string(startup_dir.join(AISTUDIO_2048_SCRIPT)).unwrap();
        assert!(aistudio_vbs.contains("launch_2048_silent.vbs"));
        assert!(aistudio_vbs.contains("0, False"));
        assert!(!startup_dir.join(GATEWAY_8046_SCRIPT).exists());

        // Main 8046/8048/8049 enable/disable must NOT touch AiStudio-2048-Autostart.vbs
        apply_in_dir_with_context(
            true,
            &startup_dir,
            &work_dir,
            &exe_path,
            "127.0.0.1:8046",
            "data",
            r"web\dist",
            None,
            "bun",
            None,
            "node",
        )
        .unwrap();
        assert!(startup_dir.join(GATEWAY_8046_SCRIPT).exists());
        assert!(startup_dir.join(AISTUDIO_2048_SCRIPT).exists());

        apply_in_dir(false, &startup_dir).unwrap();
        assert!(!startup_dir.join(GATEWAY_8046_SCRIPT).exists());
        assert!(startup_dir.join(AISTUDIO_2048_SCRIPT).exists());

        // Disable 2048 autostart removes only AiStudio-2048-Autostart.vbs
        apply_in_dir_with_context(
            true,
            &startup_dir,
            &work_dir,
            &exe_path,
            "127.0.0.1:8046",
            "data",
            r"web\dist",
            None,
            "bun",
            None,
            "node",
        )
        .unwrap();
        let st2 = apply_aistudio_in_dir(false, &startup_dir, &work_dir, None).unwrap();
        assert!(!st2.enabled);
        assert!(!startup_dir.join(AISTUDIO_2048_SCRIPT).exists());
        assert!(startup_dir.join(GATEWAY_8046_SCRIPT).exists());
    }

    #[test]
    fn managed_by_tray_flag_parses_1_and_true() {
        assert!(is_managed_by_tray_value(Some("1")));
        assert!(is_managed_by_tray_value(Some("true")));
        assert!(is_managed_by_tray_value(Some(" TRUE ")));
        assert!(!is_managed_by_tray_value(Some("0")));
        assert!(!is_managed_by_tray_value(Some("false")));
        assert!(!is_managed_by_tray_value(None));
    }

    #[test]
    fn tray_config_path_resolution_and_json_round_trip_preserve_unknown_fields() {
        let dir = tempfile::tempdir().unwrap();
        let explicit = dir.path().join("custom-tray.json");
        assert_eq!(
            resolve_tray_config_path_from(
                Some(explicit.to_str().unwrap()),
                Some(dir.path().to_str().unwrap())
            )
            .unwrap(),
            explicit
        );
        assert_eq!(
            resolve_tray_config_path_from(None, Some(dir.path().to_str().unwrap())).unwrap(),
            dir.path().join("tray-config.json")
        );
        assert!(resolve_tray_config_path_from(None, None).is_err());

        // Missing file reads as false
        assert!(!read_tray_aistudio_autostart(&explicit).unwrap());

        // Existing file with extra fields preserves them across writes
        std::fs::write(
            &explicit,
            r#"{"theme":"dark","custom_port":8046,"aistudio_autostart":false}"#,
        )
        .unwrap();
        write_tray_aistudio_autostart(&explicit, true).unwrap();
        assert!(read_tray_aistudio_autostart(&explicit).unwrap());

        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&explicit).unwrap()).unwrap();
        assert_eq!(parsed["theme"], "dark");
        assert_eq!(parsed["custom_port"], 8046);
        assert_eq!(parsed["aistudio_autostart"], true);

        // Toggle back to false
        write_tray_aistudio_autostart(&explicit, false).unwrap();
        assert!(!read_tray_aistudio_autostart(&explicit).unwrap());

        // Corrupted JSON fails fast instead of silently falling back
        std::fs::write(&explicit, "{invalid-json").unwrap();
        assert!(read_tray_aistudio_autostart(&explicit).is_err());
        assert!(write_tray_aistudio_autostart(&explicit, true).is_err());
    }

    #[test]
    fn tray_exe_resolution_and_legacy_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let fake_current = dir.path().join("multi-acp-gateway.exe");
        assert_eq!(
            resolve_tray_exe_path_from(None, Some(&fake_current)).unwrap(),
            dir.path().join("gateway-tray.exe")
        );
        assert_eq!(
            resolve_tray_exe_path_from(Some(r"C:\Custom\tray.exe"), Some(&fake_current)).unwrap(),
            PathBuf::from(r"C:\Custom\tray.exe")
        );

        let startup_dir = dir.path().join("startup");
        std::fs::create_dir_all(&startup_dir).unwrap();
        std::fs::write(startup_dir.join(GATEWAY_8046_SCRIPT), "x").unwrap();
        std::fs::write(startup_dir.join(ACP_8048_SCRIPT), "x").unwrap();
        std::fs::write(startup_dir.join(APP2API_8049_SCRIPT), "x").unwrap();
        std::fs::write(startup_dir.join(AISTUDIO_2048_SCRIPT), "keep").unwrap();

        cleanup_legacy_startup_scripts(&startup_dir).unwrap();
        assert!(!startup_dir.join(GATEWAY_8046_SCRIPT).exists());
        assert!(!startup_dir.join(ACP_8048_SCRIPT).exists());
        assert!(!startup_dir.join(APP2API_8049_SCRIPT).exists());
        assert!(startup_dir.join(AISTUDIO_2048_SCRIPT).exists());
    }
}
