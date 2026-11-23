use serde_json::{Map, Value};
use std::fs;
use std::path::Path;

pub fn read_aistudio_autostart(config_path: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(config_path) else {
        return false;
    };
    let Ok(val) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    val.get("aistudio_autostart")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub fn write_aistudio_autostart(config_path: &Path, enabled: bool) -> Result<(), String> {
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir {}: {e}", parent.display()))?;
    }

    let mut obj: Map<String, Value> = if config_path.exists() {
        let raw = fs::read_to_string(config_path)
            .map_err(|e| format!("Failed to read {}: {e}", config_path.display()))?;
        let parsed: Value = serde_json::from_str(&raw)
            .map_err(|e| format!("Invalid JSON in {}: {e}", config_path.display()))?;
        parsed
            .as_object()
            .cloned()
            .ok_or_else(|| format!("{} must be a JSON object", config_path.display()))?
    } else {
        Map::new()
    };

    obj.insert("aistudio_autostart".to_string(), Value::Bool(enabled));
    let serialized = serde_json::to_string_pretty(&Value::Object(obj))
        .map_err(|e| format!("Failed to serialize tray-config.json: {e}"))?;
    fs::write(config_path, serialized)
        .map_err(|e| format!("Failed to write {}: {e}", config_path.display()))
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

#[cfg(windows)]
mod win_reg {
    use super::strip_verbatim_prefix;
    use std::path::Path;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ, RegCloseKey,
        RegCreateKeyW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    };

    const RUN_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    fn to_wide_null(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn is_autostart_enabled(reg_name: &str) -> bool {
        let subkey = to_wide_null(RUN_SUBKEY);
        let value_name = to_wide_null(reg_name);
        let mut hkey: HKEY = std::ptr::null_mut();

        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                KEY_QUERY_VALUE,
                &mut hkey,
            )
        };
        if status != ERROR_SUCCESS {
            return false;
        }

        let mut data_type: u32 = 0;
        let mut data_len: u32 = 0;
        let q_status = unsafe {
            RegQueryValueExW(
                hkey,
                value_name.as_ptr(),
                std::ptr::null_mut(),
                &mut data_type,
                std::ptr::null_mut(),
                &mut data_len,
            )
        };
        unsafe { RegCloseKey(hkey) };
        q_status == ERROR_SUCCESS && data_len > 0
    }

    pub fn set_autostart_enabled(
        reg_name: &str,
        enabled: bool,
        tray_exe: &Path,
    ) -> Result<(), String> {
        let subkey = to_wide_null(RUN_SUBKEY);
        let value_name = to_wide_null(reg_name);

        if enabled {
            let command_value = format!("\"{}\" --minimized", strip_verbatim_prefix(tray_exe));
            let data = to_wide_null(&command_value);
            let mut hkey: HKEY = std::ptr::null_mut();
            let status =
                unsafe { RegCreateKeyW(HKEY_CURRENT_USER, subkey.as_ptr(), &mut hkey) };
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
            unsafe { RegCloseKey(hkey) };
            if set_status != ERROR_SUCCESS {
                return Err(format!(
                    "Failed to set HKCU\\{RUN_SUBKEY}\\{reg_name} (Win32 error {set_status})"
                ));
            }
            Ok(())
        } else {
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
            unsafe { RegCloseKey(hkey) };
            if del_status != ERROR_SUCCESS && del_status != ERROR_FILE_NOT_FOUND {
                return Err(format!(
                    "Failed to delete HKCU\\{RUN_SUBKEY}\\{reg_name} (Win32 error {del_status})"
                ));
            }
            Ok(())
        }
    }
}

#[cfg(not(windows))]
mod win_reg {
    use std::path::Path;

    pub fn is_autostart_enabled(_reg_name: &str) -> bool {
        false
    }

    pub fn set_autostart_enabled(
        _reg_name: &str,
        _enabled: bool,
        _tray_exe: &Path,
    ) -> Result<(), String> {
        Ok(())
    }
}

pub use win_reg::{is_autostart_enabled, set_autostart_enabled};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_config_preserves_unknown_fields() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("tray-config.json");
        assert!(!read_aistudio_autostart(&cfg));

        fs::write(&cfg, r#"{"custom":"keep","aistudio_autostart":false}"#).unwrap();
        write_aistudio_autostart(&cfg, true).unwrap();
        assert!(read_aistudio_autostart(&cfg));

        let parsed: Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(parsed["custom"], "keep");
        assert_eq!(parsed["aistudio_autostart"], true);
    }
}
