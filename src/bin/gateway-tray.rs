#![cfg_attr(windows, windows_subsystem = "windows")]

#[path = "../tray/mod.rs"]
mod tray;

#[cfg(windows)]
fn show_fatal_error_dialog(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};

    let title = format!("{} 启动失败", tray::brand::APP_DISPLAY_NAME);
    let title_w: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let msg_w: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            msg_w.as_ptr(),
            title_w.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(windows)]
fn default_tray_log_hint() -> String {
    if let Ok(app_data_dir) = std::env::var("APP_DATA_DIR")
        && !app_data_dir.trim().is_empty()
    {
        return std::path::PathBuf::from(app_data_dir)
            .join("logs")
            .join("tray.log")
            .display()
            .to_string();
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA")
        && !local_app_data.trim().is_empty()
    {
        return std::path::PathBuf::from(local_app_data)
            .join(tray::brand::APP_DATA_FOLDER)
            .join("data")
            .join("logs")
            .join("tray.log")
            .display()
            .to_string();
    }
    format!(
        "%LOCALAPPDATA%\\{}\\data\\logs\\tray.log",
        tray::brand::APP_DATA_FOLDER
    )
}

#[cfg(windows)]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--stop") {
        if let Err(err) = tray::single_instance::request_stop_and_wait(8000) {
            eprintln!("gateway-tray --stop failed: {err}");
            std::process::exit(1);
        }
        return;
    }

    let start_minimized = args.iter().any(|a| a == "--minimized");

    let guard = match tray::single_instance::acquire_or_wake(start_minimized) {
        Ok(Some(guard)) => guard,
        Ok(None) => return,
        Err(err) => {
            let log_hint = default_tray_log_hint();
            let msg = format!(
                "单实例初始化失败：{err}\n\n日志路径：{log_hint}"
            );
            eprintln!("Single-instance init failed: {err}");
            show_fatal_error_dialog(&msg);
            std::process::exit(1);
        }
    };

    let paths = match tray::supervisor::TrayPaths::resolve() {
        Ok(p) => p,
        Err(err) => {
            let log_hint = default_tray_log_hint();
            let msg = format!(
                "无法解析程序与数据目录：{err}\n\n日志路径：{log_hint}"
            );
            eprintln!("Failed to resolve tray paths: {err}");
            show_fatal_error_dialog(&msg);
            std::process::exit(1);
        }
    };

    let tray_log_path = paths.data_root.join("logs").join("tray.log");

    if let Err(err) = tray::supervisor::ensure_data_dirs(&paths.data_root) {
        let msg = format!(
            "无法创建数据目录（{}）：{err}\n\n日志路径：{}",
            paths.data_root.display(),
            tray_log_path.display()
        );
        eprintln!("Failed to prepare data dirs: {err}");
        show_fatal_error_dialog(&msg);
        std::process::exit(1);
    }

    let tray_logger = match tray::logger::RollingFileLogger::open(&tray_log_path) {
        Ok(l) => l,
        Err(err) => {
            let msg = format!(
                "无法打开托盘日志文件（{}）：{err}",
                tray_log_path.display()
            );
            eprintln!("Failed to open tray.log: {err}");
            show_fatal_error_dialog(&msg);
            std::process::exit(1);
        }
    };

    tray_logger.info(&format!(
        "Starting {} (install_dir={}, data_root={})",
        tray::brand::APP_DISPLAY_NAME,
        paths.install_dir.display(),
        paths.data_root.display()
    ));

    let diag = tray::diagnostics::run_and_save(&paths.data_root);
    tray_logger.info(&format!("Diagnostics: {}", diag.summary));

    if let Err(err) = tray::menu::run_tray_app(
        paths,
        tray_logger.clone(),
        diag,
        guard.stop_event_raw(),
        guard.show_event_raw(),
        start_minimized,
    ) {
        tray_logger.error(&format!("Tray exited with error: {err}"));
        let msg = format!(
            "托盘程序运行失败：{err}\n\n请查看日志：{}",
            tray_log_path.display()
        );
        show_fatal_error_dialog(&msg);
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("gateway-tray is only supported on Windows.");
}
