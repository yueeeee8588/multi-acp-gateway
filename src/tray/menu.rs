pub fn build_tray_icon_rgba() -> Vec<u8> {
    include_bytes!("icon_32x32.rgba").to_vec()
}

#[cfg(windows)]
mod win_ui {
    use super::build_tray_icon_rgba;
    use crate::tray::autostart_win::{
        is_autostart_enabled, read_aistudio_autostart, set_autostart_enabled,
        write_aistudio_autostart,
    };
    use crate::tray::brand::{APP_DISPLAY_NAME, AUTOSTART_REG_NAME};
    use crate::tray::desktop_auth::ensure_desktop_session;
    use crate::tray::diagnostics::DiagnosticsReport;
    use crate::tray::logger::RollingFileLogger;
    use crate::tray::single_instance::{open_shell_target, spawn_show_watcher, spawn_stop_watcher};
    use crate::tray::supervisor::{
        ServiceId, ServiceSnapshot, ServiceState, SupervisorCommand, SupervisorHandle, TrayPaths,
        spawn_supervisor,
    };
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tao::dpi::LogicalSize;
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tao::window::{Icon as WindowIcon, Window, WindowBuilder};
    use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
    use tray_icon::{Icon as TrayIconImage, MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use wry::cookie::{Cookie, SameSite, time::Duration as CookieDuration};
    use wry::{WebContext, WebView, WebViewBuilder};

    #[derive(Debug)]
    enum UserEvent {
        Refresh,
        ShowWindow,
        OpenInBrowser,
        Shutdown,
        Menu(MenuEvent),
        Tray(TrayIconEvent),
    }

    fn status_line(id: ServiceId, state: &ServiceState) -> String {
        format!("{}: {}", id.display_name(), state.label())
    }

    fn update_menu_items(
        snapshots: &[ServiceSnapshot],
        status_items: &[(ServiceId, MenuItem)],
        toggle_2048: &MenuItem,
    ) {
        for (id, item) in status_items {
            if let Some(snap) = snapshots.iter().find(|s| s.id == *id) {
                item.set_text(status_line(*id, &snap.state));
                if *id == ServiceId::AiStudio2048 {
                    match snap.state {
                        ServiceState::NotInstalled => {
                            toggle_2048.set_text("2048 (AI Studio) 未安装");
                            toggle_2048.set_enabled(false);
                        }
                        ServiceState::Running | ServiceState::Starting => {
                            toggle_2048.set_text("停止 2048 (AI Studio)");
                            toggle_2048.set_enabled(true);
                        }
                        _ => {
                            toggle_2048.set_text("启动 2048 (AI Studio)");
                            toggle_2048.set_enabled(true);
                        }
                    }
                }
            }
        }
    }

    fn show_main_window(window: &Window) {
        window.set_visible(true);
        window.set_minimized(false);
        window.set_focus();
    }

    fn show_webview_fallback_dialog() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONWARNING, MB_OK, MessageBoxW};

        let title = format!("{APP_DISPLAY_NAME} - 浏览器模式");
        let msg = "未检测到 Microsoft Edge WebView2 Runtime，已切换为浏览器模式打开控制台（建议安装 WebView2 Runtime 以获得桌面窗口体验）";
        let title_w: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let msg_w: Vec<u16> = msg.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                msg_w.as_ptr(),
                title_w.as_ptr(),
                MB_OK | MB_ICONWARNING,
            );
        }
    }

    fn try_inject_desktop_session(
        webview: &WebView,
        db_path: &Path,
        injected: &AtomicBool,
        tray_logger: &RollingFileLogger,
    ) -> bool {
        if injected.load(Ordering::Relaxed) {
            return true;
        }
        if !db_path.exists() {
            return false;
        }
        match ensure_desktop_session(db_path) {
            Ok(token) => {
                let cookie = Cookie::build(("zako_session", token))
                    .domain("127.0.0.1")
                    .path("/")
                    .http_only(true)
                    .same_site(SameSite::Strict)
                    .max_age(CookieDuration::days(30))
                    .build();
                if let Err(e) = webview.set_cookie(&cookie) {
                    tray_logger.error(&format!("Failed to inject desktop auto-session cookie: {e}"));
                    false
                } else {
                    injected.store(true, Ordering::Relaxed);
                    tray_logger.info("Desktop auto-session cookie injected");
                    true
                }
            }
            Err(e) => {
                tray_logger.warn(&format!("Desktop auto-session skipped: {e}"));
                false
            }
        }
    }

    fn build_splash_html(title: &str, port: u16) -> String {
        let escaped_title = title
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        format!(
            r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>{escaped_title}</title>
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  html, body {{
    height: 100%;
    background: radial-gradient(circle at 50% 35%, #182238 0%, #0b101b 70%);
    color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
  }}
  .card {{
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
    padding: 36px 48px;
    border-radius: 16px;
    background: rgba(15, 23, 42, 0.72);
    border: 1px solid rgba(148, 163, 184, 0.16);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
  }}
  .spinner {{
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 3px solid rgba(56, 189, 248, 0.22);
    border-top-color: #38bdf8;
    animation: spin 0.85s linear infinite;
  }}
  @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
  h1 {{ font-size: 20px; font-weight: 600; letter-spacing: 0.3px; color: #f8fafc; }}
  p {{ font-size: 13px; color: #94a3b8; }}
</style>
</head>
<body>
  <div class="card">
    <div class="spinner" aria-hidden="true"></div>
    <h1>{escaped_title}</h1>
    <p id="status">正在连接本地网关 (127.0.0.1:{port}) ...</p>
  </div>
  <script>
    (function () {{
      var healthUrl = "http://127.0.0.1:{port}/health";
      var consoleUrl = "http://127.0.0.1:{port}/";
      var redirected = false;
      function probe() {{
        if (redirected) return;
        fetch(healthUrl, {{ mode: "no-cors", cache: "no-store" }})
          .then(function () {{
            if (redirected) return;
            redirected = true;
            window.location.replace(consoleUrl);
          }})
          .catch(function () {{
            setTimeout(probe, 300);
          }});
      }}
      probe();
    }})();
  </script>
</body>
</html>"#,
            escaped_title = escaped_title,
            port = port
        )
    }

    pub fn run_tray_app(
        paths: TrayPaths,
        tray_logger: RollingFileLogger,
        diag: DiagnosticsReport,
        stop_event_raw: isize,
        show_event_raw: isize,
        start_minimized: bool,
    ) -> Result<(), String> {
        let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
        let proxy = event_loop.create_proxy();

        let proxy_menu = event_loop.create_proxy();
        MenuEvent::set_event_handler(Some(move |event| {
            let _ = proxy_menu.send_event(UserEvent::Menu(event));
        }));

        let proxy_tray = event_loop.create_proxy();
        TrayIconEvent::set_event_handler(Some(move |event| {
            let _ = proxy_tray.send_event(UserEvent::Tray(event));
        }));

        let proxy_stop = event_loop.create_proxy();
        spawn_stop_watcher(stop_event_raw, move || {
            let _ = proxy_stop.send_event(UserEvent::Shutdown);
        });

        let proxy_show = event_loop.create_proxy();
        spawn_show_watcher(show_event_raw, move || {
            let _ = proxy_show.send_event(UserEvent::ShowWindow);
        });

        let proxy_sup = event_loop.create_proxy();
        let supervisor: SupervisorHandle =
            spawn_supervisor(paths.clone(), tray_logger.clone(), move || {
                let _ = proxy_sup.send_event(UserEvent::Refresh);
            })?;

        let port_8046 = ServiceId::Proxy8046.port();
        let console_url = format!("http://127.0.0.1:{port_8046}/");

        let icon_rgba = build_tray_icon_rgba();
        let window_icon = WindowIcon::from_rgba(icon_rgba.clone(), 32, 32)
            .map_err(|e| format!("Failed to build window icon: {e}"))?;

        let built_window = WindowBuilder::new()
            .with_title(APP_DISPLAY_NAME)
            .with_inner_size(LogicalSize::new(1360.0, 860.0))
            .with_min_inner_size(LogicalSize::new(960.0, 640.0))
            .with_window_icon(Some(window_icon))
            .with_visible(false)
            .build(&event_loop)
            .map_err(|e| format!("Failed to create main window: {e}"))?;

        let webview_dir = paths.data_root.join("webview2");
        let mut web_context = WebContext::new(Some(webview_dir));
        let splash_html = build_splash_html(APP_DISPLAY_NAME, port_8046);
        let db_8046_path = paths.data_root.join("8046").join("zako.db");
        let session_injected = AtomicBool::new(false);

        let (window, webview) = match WebViewBuilder::new_with_web_context(&mut web_context)
            .with_html(splash_html)
            .build(&built_window)
        {
            Ok(wv) => {
                if !start_minimized {
                    show_main_window(&built_window);
                }
                try_inject_desktop_session(&wv, &db_8046_path, &session_injected, &tray_logger);
                (Some(built_window), Some(wv))
            }
            Err(err) => {
                drop(built_window);
                tray_logger.error(&format!(
                    "Failed to create WebView2, falling back to browser mode: {err}"
                ));
                show_webview_fallback_dialog();
                open_shell_target(&console_url);
                (None, None)
            }
        };

        let open_window_item = MenuItem::new("打开主窗口", true, None);
        let open_browser_item = MenuItem::new("在浏览器中打开", true, None);
        let st_8046 = MenuItem::new("8046 主网关: 启动中", false, None);
        let st_8048 = MenuItem::new("8048 ACP 网关: 启动中", false, None);
        let st_8049 = MenuItem::new("8049 App2API: 启动中", false, None);
        let st_2048 = MenuItem::new("2048 AI Studio: 已停止", false, None);
        let diag_item = MenuItem::new(&diag.summary, false, None);

        let restart_all_item = MenuItem::new("重启全部服务", true, None);
        let toggle_2048_item = MenuItem::new("启动 2048 (AI Studio)", true, None);
        let aistudio_auto_item = CheckMenuItem::new(
            "2048 随托盘自动启动",
            true,
            read_aistudio_autostart(&paths.tray_config_path),
            None,
        );
        let win_autostart_item = CheckMenuItem::new(
            "开机自启动",
            true,
            is_autostart_enabled(AUTOSTART_REG_NAME),
            None,
        );
        let open_data_item = MenuItem::new("打开数据与日志目录", true, None);
        let quit_item = MenuItem::new("退出", true, None);

        let menu = Menu::new();
        let _ = menu.append(&open_window_item);
        let _ = menu.append(&open_browser_item);
        let _ = menu.append(&PredefinedMenuItem::separator());
        let _ = menu.append(&st_8046);
        let _ = menu.append(&st_8048);
        let _ = menu.append(&st_8049);
        let _ = menu.append(&st_2048);
        let _ = menu.append(&diag_item);
        let _ = menu.append(&PredefinedMenuItem::separator());
        let _ = menu.append(&restart_all_item);
        let _ = menu.append(&toggle_2048_item);
        let _ = menu.append(&aistudio_auto_item);
        let _ = menu.append(&win_autostart_item);
        let _ = menu.append(&PredefinedMenuItem::separator());
        let _ = menu.append(&open_data_item);
        let _ = menu.append(&quit_item);

        let status_items = vec![
            (ServiceId::Proxy8046, st_8046),
            (ServiceId::Acp8048, st_8048),
            (ServiceId::App2Api8049, st_8049),
            (ServiceId::AiStudio2048, st_2048),
        ];

        update_menu_items(&supervisor.snapshots(), &status_items, &toggle_2048_item);

        let tray_icon_img = TrayIconImage::from_rgba(icon_rgba, 32, 32)
            .map_err(|e| format!("Failed to build tray icon: {e}"))?;

        let mut tray_icon = Some(
            TrayIconBuilder::new()
                .with_menu(Box::new(menu))
                .with_tooltip(APP_DISPLAY_NAME)
                .with_icon(tray_icon_img)
                .build()
                .map_err(|e| format!("Failed to create tray icon: {e}"))?,
        );

        let mut shutting_down = false;

        event_loop.run(move |event, _, control_flow| {
            *control_flow = ControlFlow::Wait;
            let _keep_webview = &webview;

            match event {
                Event::WindowEvent {
                    event: WindowEvent::CloseRequested,
                    ..
                } => {
                    if let Some(ref w) = window {
                        w.set_visible(false);
                    }
                }
                Event::UserEvent(UserEvent::Refresh) => {
                    let snaps = supervisor.snapshots();
                    update_menu_items(&snaps, &status_items, &toggle_2048_item);
                    if let Some(ref wv) = webview
                        && !session_injected.load(Ordering::Relaxed)
                        && snaps
                            .iter()
                            .any(|s| s.id == ServiceId::Proxy8046 && s.state == ServiceState::Running)
                        && try_inject_desktop_session(
                            wv,
                            &db_8046_path,
                            &session_injected,
                            &tray_logger,
                        )
                    {
                        let _ = wv.load_url(&console_url);
                    }
                }
                Event::UserEvent(UserEvent::ShowWindow) => {
                    if let Some(ref w) = window {
                        show_main_window(w);
                    } else {
                        open_shell_target(&console_url);
                    }
                }
                Event::UserEvent(UserEvent::OpenInBrowser) => {
                    open_shell_target(&console_url);
                }
                Event::UserEvent(UserEvent::Shutdown) => {
                    if !shutting_down {
                        shutting_down = true;
                        if let Some(ref w) = window {
                            w.set_visible(false);
                        }
                        tray_logger.info("Tray exiting; stopping supervisor");
                        supervisor.shutdown_blocking();
                        let _ = tray_icon.take();
                    }
                    *control_flow = ControlFlow::Exit;
                }
                Event::UserEvent(UserEvent::Menu(menu_ev)) => {
                    if menu_ev.id == open_window_item.id() {
                        if let (Some(w), Some(wv)) = (&window, &webview) {
                            if !session_injected.load(Ordering::Relaxed)
                                && try_inject_desktop_session(
                                    wv,
                                    &db_8046_path,
                                    &session_injected,
                                    &tray_logger,
                                )
                            {
                                let _ = wv.load_url(&console_url);
                            }
                            show_main_window(w);
                        } else {
                            open_shell_target(&console_url);
                        }
                    } else if menu_ev.id == open_browser_item.id() {
                        let _ = proxy.send_event(UserEvent::OpenInBrowser);
                    } else if menu_ev.id == restart_all_item.id() {
                        supervisor.send(SupervisorCommand::RestartAll);
                    } else if menu_ev.id == toggle_2048_item.id() {
                        let snaps = supervisor.snapshots();
                        let is_active = snaps
                            .iter()
                            .find(|s| s.id == ServiceId::AiStudio2048)
                            .is_some_and(|s| {
                                matches!(s.state, ServiceState::Running | ServiceState::Starting)
                            });
                        if is_active {
                            supervisor.send(SupervisorCommand::Stop2048);
                        } else {
                            supervisor.send(SupervisorCommand::Start2048);
                        }
                    } else if menu_ev.id == aistudio_auto_item.id() {
                        let checked = aistudio_auto_item.is_checked();
                        if let Err(e) = write_aistudio_autostart(&paths.tray_config_path, checked) {
                            tray_logger.error(&format!("Failed to save tray-config.json: {e}"));
                            aistudio_auto_item.set_checked(!checked);
                        }
                    } else if menu_ev.id == win_autostart_item.id() {
                        let checked = win_autostart_item.is_checked();
                        if let Err(e) =
                            set_autostart_enabled(AUTOSTART_REG_NAME, checked, &paths.tray_exe)
                        {
                            tray_logger.error(&format!("Failed to update HKCU Run: {e}"));
                            win_autostart_item.set_checked(!checked);
                        }
                    } else if menu_ev.id == open_data_item.id() {
                        open_shell_target(&paths.data_root.display().to_string());
                    } else if menu_ev.id == quit_item.id() {
                        let _ = proxy.send_event(UserEvent::Shutdown);
                    }
                }
                Event::UserEvent(UserEvent::Tray(tray_ev)) => match tray_ev {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => {
                        if let Some(ref w) = window {
                            if !w.is_visible() || w.is_minimized() {
                                show_main_window(w);
                            } else {
                                w.set_focus();
                            }
                        } else {
                            open_shell_target(&console_url);
                        }
                    }
                    _ => {}
                },
                _ => {}
            }
        });
    }
}

#[cfg(windows)]
pub use win_ui::run_tray_app;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_icon_rgba_has_expected_dimensions_and_non_empty_pixels() {
        let rgba = build_tray_icon_rgba();
        assert_eq!(rgba.len(), 32 * 32 * 4);
        assert!(rgba.chunks_exact(4).any(|px| px[3] > 0));
    }
}
