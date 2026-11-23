#![cfg_attr(windows, windows_subsystem = "windows")]

#[path = "../tray/mod.rs"]
mod tray;

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
            eprintln!("Single-instance init failed: {err}");
            std::process::exit(1);
        }
    };

    let paths = match tray::supervisor::TrayPaths::resolve() {
        Ok(p) => p,
        Err(err) => {
            eprintln!("Failed to resolve tray paths: {err}");
            std::process::exit(1);
        }
    };

    if let Err(err) = tray::supervisor::ensure_data_dirs(&paths.data_root) {
        eprintln!("Failed to prepare data dirs: {err}");
        std::process::exit(1);
    }

    let tray_logger = match tray::logger::RollingFileLogger::open(paths.data_root.join("logs").join("tray.log")) {
        Ok(l) => l,
        Err(err) => {
            eprintln!("Failed to open tray.log: {err}");
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
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("gateway-tray is only supported on Windows.");
}
