use crate::tray::autostart_win::read_aistudio_autostart;
use crate::tray::brand::{ACP_8048_DIR_CANDIDATES, APP_DATA_FOLDER, AUTOSTART_REG_NAME, GATEWAY_EXE_NAME};
use crate::tray::job::{JobObject, spawn_in_job};
use crate::tray::logger::{RollingFileLogger, pipe_child_output};
use serde_json::Value;
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const BACKOFF_SCHEDULE_SECS: [u64; 5] = [3, 6, 12, 24, 30];
pub const STARTUP_GRACE_PERIOD: Duration = Duration::from_secs(20);
pub const MAX_CONSECUTIVE_FAILURES: u32 = 5;
pub const HEALTHY_RESET_DURATION: Duration = Duration::from_secs(60);
pub const PROBE_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ServiceId {
    Proxy8046,
    Acp8048,
    App2Api8049,
    AiStudio2048,
}

impl ServiceId {
    pub fn all() -> [ServiceId; 4] {
        [
            ServiceId::Proxy8046,
            ServiceId::Acp8048,
            ServiceId::App2Api8049,
            ServiceId::AiStudio2048,
        ]
    }

    pub fn port(self) -> u16 {
        match self {
            ServiceId::Proxy8046 => env_port("GATEWAY_8046_PORT", 8046),
            ServiceId::Acp8048 => 8048,
            ServiceId::App2Api8049 => env_port("GATEWAY_8049_PORT", 8049),
            ServiceId::AiStudio2048 => 2048,
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            ServiceId::Proxy8046 => "8046 主网关",
            ServiceId::Acp8048 => "8048 ACP 网关",
            ServiceId::App2Api8049 => "8049 App2API",
            ServiceId::AiStudio2048 => "2048 AI Studio",
        }
    }

    pub fn log_file_name(self) -> &'static str {
        match self {
            ServiceId::Proxy8046 => "8046.log",
            ServiceId::Acp8048 => "8048.log",
            ServiceId::App2Api8049 => "8049.log",
            ServiceId::AiStudio2048 => "2048.log",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceState {
    Stopped,
    Starting,
    Running,
    PortConflict,
    NotInstalled,
    BackoffWait(u64),
    Failed(String),
}

impl ServiceState {
    pub fn label(&self) -> String {
        match self {
            ServiceState::Stopped => "已停止".to_string(),
            ServiceState::Starting => "启动中".to_string(),
            ServiceState::Running => "运行中".to_string(),
            ServiceState::PortConflict => "端口冲突(外部占用)".to_string(),
            ServiceState::NotInstalled => "未安装".to_string(),
            ServiceState::BackoffWait(secs) => format!("等待重启({secs}s)"),
            ServiceState::Failed(reason) => format!("异常: {reason}"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ServiceSnapshot {
    pub id: ServiceId,
    pub state: ServiceState,
}

#[derive(Debug, Clone)]
pub struct TrayPaths {
    pub install_dir: PathBuf,
    pub data_root: PathBuf,
    pub tray_exe: PathBuf,
    pub tray_config_path: PathBuf,
}

impl TrayPaths {
    pub fn resolve() -> Result<Self, String> {
        let tray_exe = std::env::current_exe()
            .map_err(|e| format!("Failed to resolve current_exe: {e}"))?;

        let install_dir = non_empty_env("GATEWAY_INSTALL_DIR")
            .map(PathBuf::from)
            .or_else(|| tray_exe.parent().map(Path::to_path_buf))
            .ok_or_else(|| "Failed to resolve install_dir".to_string())?;

        let data_root = non_empty_env("APP_DATA_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                non_empty_env("LOCALAPPDATA")
                    .map(|local| PathBuf::from(local).join(APP_DATA_FOLDER).join("data"))
            })
            .ok_or_else(|| "Failed to resolve data_root (APP_DATA_DIR / LOCALAPPDATA)".to_string())?;

        let tray_config_path = data_root.join("tray-config.json");

        Ok(Self {
            install_dir,
            data_root,
            tray_exe,
            tray_config_path,
        })
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn env_port(name: &str, default: u16) -> u16 {
    non_empty_env(name)
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|&p| p > 0)
        .unwrap_or(default)
}

fn is_8048_disabled() -> bool {
    matches!(
        non_empty_env("GATEWAY_DISABLE_8048").as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

pub fn ensure_data_dirs(data_root: &Path) -> Result<(), String> {
    for sub in ["8046", "8048", "8049", "2048", "2048/auth", "logs"] {
        let p = data_root.join(sub);
        fs::create_dir_all(&p)
            .map_err(|e| format!("Failed to create directory {}: {e}", p.display()))?;
    }
    Ok(())
}

pub fn ensure_2048_default_config(config_path: &Path) -> Result<(), String> {
    if config_path.exists() {
        return Ok(());
    }
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create 2048 config dir {}: {e}", parent.display()))?;
    }
    fs::write(config_path, r#"{"port":2048}"#)
        .map_err(|e| format!("Failed to write {}: {e}", config_path.display()))
}

pub fn next_backoff_secs(attempt: u32) -> u64 {
    let idx = (attempt as usize).min(BACKOFF_SCHEDULE_SECS.len() - 1);
    BACKOFF_SCHEDULE_SECS[idx]
}

pub fn should_reset_backoff(healthy_duration: Duration) -> bool {
    healthy_duration > HEALTHY_RESET_DURATION
}

pub fn is_port_in_use(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

pub fn parse_8049_status_ok(body: &str) -> bool {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("ok").and_then(Value::as_bool))
        .unwrap_or(false)
}

pub fn parse_2048_session_json(body: &str) -> bool {
    serde_json::from_str::<Value>(body).is_ok()
}

fn find_exe_on_path(names: &[&str]) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn resolve_8048_dir(install_dir: &Path) -> Option<PathBuf> {
    for candidate in ACP_8048_DIR_CANDIDATES {
        let p1 = install_dir.join("services").join(candidate);
        if p1.is_dir() {
            return Some(p1);
        }
        let p2 = install_dir.join(candidate);
        if p2.is_dir() {
            return Some(p2);
        }
    }
    None
}

fn resolve_8048_bun(install_dir: &Path) -> Option<PathBuf> {
    let bundled = install_dir.join("runtime").join("bun").join("bun.exe");
    if bundled.is_file() {
        return Some(bundled);
    }
    if let Some(env_bun) = non_empty_env("ACP_8048_BUN") {
        let p = PathBuf::from(env_bun);
        if p.is_file() {
            return Some(p);
        }
    }
    find_exe_on_path(&["bun.exe", "bun"])
}

fn resolve_8049_dir(install_dir: &Path) -> Option<PathBuf> {
    let p1 = install_dir.join("services").join("gemini-app2api-8049");
    if p1.is_dir() {
        return Some(p1);
    }
    let p2 = install_dir.join("gemini-app2api-8049");
    if p2.is_dir() {
        return Some(p2);
    }
    None
}

fn resolve_8049_node(install_dir: &Path) -> Option<PathBuf> {
    let bundled = install_dir.join("runtime").join("node").join("node.exe");
    if bundled.is_file() {
        return Some(bundled);
    }
    find_exe_on_path(&["node.exe", "node"])
}

pub fn resolve_2048_exe(install_dir: &Path) -> Option<PathBuf> {
    let candidates = [
        install_dir
            .join("services")
            .join("magpie-aistudio-2048")
            .join("bin")
            .join("aistudio2api.exe"),
        install_dir
            .join("services")
            .join("magpie-aistudio-2048")
            .join("data")
            .join("aistudio2api.exe"),
        install_dir
            .join("magpie-aistudio-2048")
            .join("data")
            .join("aistudio2api.exe"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

const JS_RUNTIME_CONFLICT_ENVS: &[&str] = &[
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "UV_THREADPOOL_SIZE",
    "BUN_OPTIONS",
];

fn build_service_command(id: ServiceId, paths: &TrayPaths) -> Result<Command, ServiceState> {
    match id {
        ServiceId::Proxy8046 => {
            let exe = paths.install_dir.join(GATEWAY_EXE_NAME);
            if !exe.is_file() {
                return Err(ServiceState::Failed(format!(
                    "未找到 {}",
                    exe.display()
                )));
            }
            let mut cmd = Command::new(&exe);
            cmd.current_dir(&paths.install_dir);
            cmd.env_remove("WEB_DIR");
            cmd.env("BIND_ADDR", format!("127.0.0.1:{}", id.port()));
            cmd.env("APP_DATA_DIR", &paths.data_root);
            cmd.env("DATA_DIR", paths.data_root.join("8046"));
            cmd.env("GATEWAY_MANAGED_BY_TRAY", "1");
            cmd.env("GATEWAY_TRAY_EXE", &paths.tray_exe);
            cmd.env("GATEWAY_TRAY_CONFIG", &paths.tray_config_path);
            cmd.env("GATEWAY_AUTOSTART_REG_NAME", AUTOSTART_REG_NAME);
            cmd.env(
                "AISTUDIO_ENV_FILE",
                paths.data_root.join("2048").join(".env"),
            );
            if let Some(exe_2048) = resolve_2048_exe(&paths.install_dir) {
                cmd.env("AISTUDIO_2048_EXE", exe_2048);
            }
            Ok(cmd)
        }
        ServiceId::Acp8048 => {
            let cwd = resolve_8048_dir(&paths.install_dir)
                .ok_or_else(|| ServiceState::Failed("未找到 8048 目录".into()))?;
            let bun = resolve_8048_bun(&paths.install_dir)
                .ok_or_else(|| ServiceState::Failed("未找到 bun".into()))?;
            let data_8048 = paths.data_root.join("8048");
            let mut cmd = Command::new(bun);
            cmd.current_dir(cwd);
            cmd.args(["run", "src/server.ts"]);
            for key in JS_RUNTIME_CONFLICT_ENVS {
                cmd.env_remove(key);
            }
            cmd.env("AGY_DB_PATH", data_8048.join("gateway.db"));
            cmd.env("AGY_8048_DATA_DIR", &data_8048);
            cmd.env("AGY_ACP_DATA_DIR", &data_8048);
            Ok(cmd)
        }
        ServiceId::App2Api8049 => {
            let cwd = resolve_8049_dir(&paths.install_dir)
                .ok_or_else(|| ServiceState::Failed("未找到 8049 目录".into()))?;
            let node = resolve_8049_node(&paths.install_dir)
                .ok_or_else(|| ServiceState::Failed("未找到 node".into()))?;
            let mut cmd = Command::new(node);
            cmd.current_dir(cwd);
            cmd.arg("src/gateway-server.mjs");
            for key in JS_RUNTIME_CONFLICT_ENVS {
                cmd.env_remove(key);
            }
            cmd.env("PORT", id.port().to_string());
            cmd.env("GATEWAY_HOST", "127.0.0.1");
            cmd.env("GATEWAY_DATA_DIR", paths.data_root.join("8049"));
            cmd.env("GATEWAY_QUOTA_FAILOVER", "1");
            cmd.env("GATEWAY_EMPTY_RESPONSE_FAILOVER", "1");
            cmd.env("GATEWAY_AUTOMATIC_RECOVERY", "1");
            Ok(cmd)
        }
        ServiceId::AiStudio2048 => {
            let exe = resolve_2048_exe(&paths.install_dir)
                .ok_or(ServiceState::NotInstalled)?;
            let dir_2048 = paths.data_root.join("2048");
            let auth_dir = dir_2048.join("auth");
            if let Err(e) = ensure_2048_default_config(&dir_2048.join("config.json")) {
                return Err(ServiceState::Failed(e));
            }
            let mut cmd = Command::new(exe);
            cmd.current_dir(&dir_2048);
            cmd.arg("-open-ui=false");
            cmd.arg(format!("-auth={}", auth_dir.display()));
            for key in [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "NO_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
                "no_proxy",
            ] {
                cmd.env_remove(key);
            }
            let mut proxy_arg: Option<String> = None;
            for (k, v) in load_dotenv_pairs(&dir_2048.join(".env")) {
                if k.eq_ignore_ascii_case("AISTUDIO_AUTH_STATES")
                    || matches!(
                        k.to_ascii_uppercase().as_str(),
                        "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY" | "NO_PROXY"
                    )
                {
                    continue;
                }
                if k == "PROXY" && !v.trim().is_empty() {
                    proxy_arg = Some(v.trim().to_string());
                }
                cmd.env(k, v);
            }
            cmd.env("AISTUDIO_AUTH_STATES", &auth_dir);
            if let Some(proxy) = proxy_arg {
                cmd.arg(format!("-proxy={proxy}"));
            }
            Ok(cmd)
        }
    }
}

fn load_dotenv_pairs(path: &Path) -> Vec<(String, String)> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut pairs = Vec::new();
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line
            .strip_prefix("export ")
            .map(str::trim_start)
            .unwrap_or(line);
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let key = k.trim();
        if key.is_empty() {
            continue;
        }
        let val = v.trim();
        let val = if (val.starts_with('"') && val.ends_with('"') && val.len() >= 2)
            || (val.starts_with('\'') && val.ends_with('\'') && val.len() >= 2)
        {
            &val[1..val.len() - 1]
        } else {
            val
        };
        pairs.push((key.to_string(), val.to_string()));
    }
    pairs
}

struct ManagedService {
    id: ServiceId,
    desired_running: bool,
    state: ServiceState,
    child: Option<Child>,
    started_at: Option<Instant>,
    healthy_since: Option<Instant>,
    consecutive_failures: u32,
    backoff_attempt: u32,
    restart_at: Option<Instant>,
    logger: RollingFileLogger,
}

impl ManagedService {
    fn new(id: ServiceId, logger: RollingFileLogger, desired_running: bool) -> Self {
        Self {
            id,
            desired_running,
            state: ServiceState::Stopped,
            child: None,
            started_at: None,
            healthy_since: None,
            consecutive_failures: 0,
            backoff_attempt: 0,
            restart_at: None,
            logger,
        }
    }

    fn stop_child(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.started_at = None;
        self.healthy_since = None;
        self.consecutive_failures = 0;
        self.restart_at = None;
    }
}

pub enum SupervisorCommand {
    RestartAll,
    Start2048,
    Stop2048,
    Shutdown(Sender<()>),
}

pub struct SupervisorHandle {
    tx: Sender<SupervisorCommand>,
    snapshots: Arc<Mutex<Vec<ServiceSnapshot>>>,
}

impl SupervisorHandle {
    pub fn snapshots(&self) -> Vec<ServiceSnapshot> {
        self.snapshots
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default()
    }

    pub fn send(&self, cmd: SupervisorCommand) {
        let _ = self.tx.send(cmd);
    }

    pub fn shutdown_blocking(&self) {
        let (done_tx, done_rx) = mpsc::channel();
        if self.tx.send(SupervisorCommand::Shutdown(done_tx)).is_ok() {
            let _ = done_rx.recv_timeout(Duration::from_secs(6));
        }
    }
}

async fn probe_service(client: &reqwest::Client, id: ServiceId) -> bool {
    let port = id.port();
    let url = match id {
        ServiceId::Proxy8046 => format!("http://127.0.0.1:{port}/health"),
        ServiceId::Acp8048 => format!("http://127.0.0.1:{port}/api/status"),
        ServiceId::App2Api8049 => format!("http://127.0.0.1:{port}/api/status"),
        ServiceId::AiStudio2048 => format!("http://127.0.0.1:{port}/api/auth/session"),
    };

    let Ok(resp) = client.get(&url).send().await else {
        return false;
    };
    if !resp.status().is_success() {
        return false;
    }

    match id {
        ServiceId::Proxy8046 | ServiceId::Acp8048 => true,
        ServiceId::App2Api8049 => resp
            .text()
            .await
            .map(|b| parse_8049_status_ok(&b))
            .unwrap_or(false),
        ServiceId::AiStudio2048 => resp
            .text()
            .await
            .map(|b| parse_2048_session_json(&b))
            .unwrap_or(false),
    }
}

fn start_one_service(svc: &mut ManagedService, paths: &TrayPaths, job: &JobObject) {
    svc.stop_child();

    if svc.id == ServiceId::Acp8048 && is_8048_disabled() {
        svc.state = ServiceState::Stopped;
        svc.desired_running = false;
        svc.logger.info("8048 disabled via GATEWAY_DISABLE_8048; skipped");
        return;
    }

    if svc.id == ServiceId::AiStudio2048 && resolve_2048_exe(&paths.install_dir).is_none() {
        svc.state = ServiceState::NotInstalled;
        svc.desired_running = false;
        svc.logger.warn("2048 executable not found; marked as 未安装");
        return;
    }

    let port = svc.id.port();
    if is_port_in_use(port) {
        svc.state = ServiceState::PortConflict;
        svc.desired_running = false;
        svc.logger.error(&format!(
            "Port 127.0.0.1:{port} is already occupied by an external process; Fail-Fast"
        ));
        return;
    }

    let mut cmd = match build_service_command(svc.id, paths) {
        Ok(c) => c,
        Err(err_state) => {
            svc.logger
                .error(&format!("Cannot start {}: {}", svc.id.display_name(), err_state.label()));
            svc.state = err_state;
            svc.desired_running = false;
            return;
        }
    };

    match spawn_in_job(job, &mut cmd) {
        Ok(mut child) => {
            pipe_child_output(&mut child, svc.logger.clone());
            svc.logger
                .info(&format!("Started {} (pid={})", svc.id.display_name(), child.id()));
            svc.child = Some(child);
            svc.started_at = Some(Instant::now());
            svc.healthy_since = None;
            svc.consecutive_failures = 0;
            svc.restart_at = None;
            svc.state = ServiceState::Starting;
        }
        Err(err) => {
            svc.logger
                .error(&format!("Failed to spawn {}: {err}", svc.id.display_name()));
            schedule_backoff_restart(svc);
        }
    }
}

fn schedule_backoff_restart(svc: &mut ManagedService) {
    let wait_secs = next_backoff_secs(svc.backoff_attempt);
    svc.backoff_attempt = svc.backoff_attempt.saturating_add(1);
    svc.restart_at = Some(Instant::now() + Duration::from_secs(wait_secs));
    svc.healthy_since = None;
    svc.consecutive_failures = 0;
    svc.state = ServiceState::BackoffWait(wait_secs);
    svc.logger.warn(&format!(
        "{} scheduled for restart in {wait_secs}s (attempt {})",
        svc.id.display_name(),
        svc.backoff_attempt
    ));
}

fn sync_snapshots(services: &[ManagedService], snapshots: &Arc<Mutex<Vec<ServiceSnapshot>>>) {
    if let Ok(mut guard) = snapshots.lock() {
        *guard = services
            .iter()
            .map(|s| ServiceSnapshot {
                id: s.id,
                state: s.state.clone(),
            })
            .collect();
    }
}

pub fn spawn_supervisor<F>(
    paths: TrayPaths,
    tray_logger: RollingFileLogger,
    on_status_change: F,
) -> Result<SupervisorHandle, String>
where
    F: Fn() + Send + 'static,
{
    ensure_data_dirs(&paths.data_root)?;
    let job = JobObject::new()?;

    let aistudio_auto = read_aistudio_autostart(&paths.tray_config_path);
    let mut services = Vec::new();
    for id in ServiceId::all() {
        let log = RollingFileLogger::open(paths.data_root.join("logs").join(id.log_file_name()))?;
        let desired = match id {
            ServiceId::AiStudio2048 => aistudio_auto,
            ServiceId::Acp8048 if is_8048_disabled() => false,
            _ => true,
        };
        services.push(ManagedService::new(id, log, desired));
    }

    let initial_snaps: Vec<ServiceSnapshot> = services
        .iter()
        .map(|s| ServiceSnapshot {
            id: s.id,
            state: s.state.clone(),
        })
        .collect();
    let snapshots = Arc::new(Mutex::new(initial_snaps));
    let snapshots_clone = snapshots.clone();

    let (tx, rx): (Sender<SupervisorCommand>, Receiver<SupervisorCommand>) = mpsc::channel();

    std::thread::Builder::new()
        .name("tray-supervisor".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    tray_logger.error(&format!("Failed to build tokio runtime: {e}"));
                    return;
                }
            };

            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_millis(1500))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new());

            // Initial startup
            for svc in &mut services {
                if svc.desired_running {
                    start_one_service(svc, &paths, &job);
                } else if svc.id == ServiceId::AiStudio2048
                    && resolve_2048_exe(&paths.install_dir).is_none()
                {
                    svc.state = ServiceState::NotInstalled;
                }
            }
            sync_snapshots(&services, &snapshots_clone);
            on_status_change();

            let mut last_probe = Instant::now() - PROBE_INTERVAL;

            loop {
                // Process commands without blocking long
                while let Ok(cmd) = rx.try_recv() {
                    match cmd {
                        SupervisorCommand::RestartAll => {
                            tray_logger.info("Restarting all services");
                            for svc in &mut services {
                                if svc.id == ServiceId::AiStudio2048 && !svc.desired_running {
                                    continue;
                                }
                                if svc.id == ServiceId::Acp8048 && is_8048_disabled() {
                                    continue;
                                }
                                svc.backoff_attempt = 0;
                                start_one_service(svc, &paths, &job);
                            }
                            sync_snapshots(&services, &snapshots_clone);
                            on_status_change();
                        }
                        SupervisorCommand::Start2048 => {
                            if let Some(svc) =
                                services.iter_mut().find(|s| s.id == ServiceId::AiStudio2048)
                            {
                                svc.desired_running = true;
                                svc.backoff_attempt = 0;
                                start_one_service(svc, &paths, &job);
                                sync_snapshots(&services, &snapshots_clone);
                                on_status_change();
                            }
                        }
                        SupervisorCommand::Stop2048 => {
                            if let Some(svc) =
                                services.iter_mut().find(|s| s.id == ServiceId::AiStudio2048)
                            {
                                svc.desired_running = false;
                                svc.stop_child();
                                svc.state = if resolve_2048_exe(&paths.install_dir).is_none() {
                                    ServiceState::NotInstalled
                                } else {
                                    ServiceState::Stopped
                                };
                                sync_snapshots(&services, &snapshots_clone);
                                on_status_change();
                            }
                        }
                        SupervisorCommand::Shutdown(done_tx) => {
                            let owns_8048 = services
                                .iter()
                                .any(|s| s.id == ServiceId::Acp8048 && s.child.is_some());
                            let owns_8049 = services
                                .iter()
                                .any(|s| s.id == ServiceId::App2Api8049 && s.child.is_some());
                            if owns_8048 || owns_8049 {
                                let url_8048 =
                                    format!("http://127.0.0.1:{}/api/drain", ServiceId::Acp8048.port());
                                let url_8049 = format!(
                                    "http://127.0.0.1:{}/api/drain",
                                    ServiceId::App2Api8049.port()
                                );
                                if owns_8048 {
                                    tray_logger.info("Graceful shutdown requested; draining 8048");
                                }
                                if owns_8049 {
                                    tray_logger.info("Graceful shutdown requested; draining 8049");
                                }
                                rt.block_on(async {
                                    let drain_8048 = async {
                                        if owns_8048 {
                                            let _ = client
                                                .post(&url_8048)
                                                .timeout(Duration::from_millis(1500))
                                                .send()
                                                .await;
                                        }
                                    };
                                    let drain_8049 = async {
                                        if owns_8049 {
                                            let _ = client
                                                .post(&url_8049)
                                                .timeout(Duration::from_millis(1500))
                                                .send()
                                                .await;
                                        }
                                    };
                                    tokio::join!(drain_8048, drain_8049);
                                    if owns_8049 {
                                        tokio::time::sleep(Duration::from_millis(300)).await;
                                    }
                                });
                            } else {
                                tray_logger.info("Graceful shutdown requested; 8048/8049 not owned by tray, skipping drain");
                            }
                            for svc in &mut services {
                                svc.desired_running = false;
                                svc.stop_child();
                                svc.state = ServiceState::Stopped;
                            }
                            drop(job);
                            sync_snapshots(&services, &snapshots_clone);
                            let _ = done_tx.send(());
                            return;
                        }
                    }
                }

                let now = Instant::now();
                let mut changed = false;

                // Check child exits & pending restarts
                for svc in &mut services {
                    if let Some(child) = svc.child.as_mut() {
                        if let Ok(Some(status)) = child.try_wait() {
                            svc.logger.warn(&format!(
                                "{} exited unexpectedly with {status}",
                                svc.id.display_name()
                            ));
                            svc.child = None;
                            svc.started_at = None;
                            if svc.desired_running {
                                schedule_backoff_restart(svc);
                            } else {
                                svc.state = ServiceState::Stopped;
                            }
                            changed = true;
                        }
                    } else if svc.desired_running {
                        if let Some(when) = svc.restart_at {
                            if now >= when {
                                svc.restart_at = None;
                                start_one_service(svc, &paths, &job);
                                changed = true;
                            }
                        }
                    }
                }

                // Periodic HTTP health probes (every 3s)
                if now.duration_since(last_probe) >= PROBE_INTERVAL {
                    last_probe = now;
                    for svc in &mut services {
                        if svc.child.is_none() {
                            continue;
                        }
                        let ok = rt.block_on(probe_service(&client, svc.id));
                        if ok {
                            svc.consecutive_failures = 0;
                            if svc.healthy_since.is_none() {
                                svc.healthy_since = Some(now);
                            }
                            if let Some(since) = svc.healthy_since {
                                if should_reset_backoff(now.duration_since(since))
                                    && svc.backoff_attempt > 0
                                {
                                    svc.backoff_attempt = 0;
                                    svc.logger.info(&format!(
                                        "{} healthy > 60s; backoff reset",
                                        svc.id.display_name()
                                    ));
                                }
                            }
                            if svc.state != ServiceState::Running {
                                svc.state = ServiceState::Running;
                                changed = true;
                            }
                        } else {
                            svc.healthy_since = None;
                            let in_grace = svc
                                .started_at
                                .is_some_and(|st| now.duration_since(st) < STARTUP_GRACE_PERIOD);
                            if !in_grace {
                                svc.consecutive_failures += 1;
                                if svc.consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                                    svc.logger.error(&format!(
                                        "{} failed {MAX_CONSECUTIVE_FAILURES} consecutive health probes; restarting",
                                        svc.id.display_name()
                                    ));
                                    svc.stop_child();
                                    if svc.desired_running {
                                        schedule_backoff_restart(svc);
                                    } else {
                                        svc.state = ServiceState::Stopped;
                                    }
                                    changed = true;
                                }
                            }
                        }
                    }
                }

                if changed {
                    sync_snapshots(&services, &snapshots_clone);
                    on_status_change();
                }

                std::thread::sleep(Duration::from_millis(250));
            }
        })
        .map_err(|e| format!("Failed to spawn supervisor thread: {e}"))?;

    Ok(SupervisorHandle { tx, snapshots })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn backoff_schedule_and_reset_logic() {
        assert_eq!(next_backoff_secs(0), 3);
        assert_eq!(next_backoff_secs(1), 6);
        assert_eq!(next_backoff_secs(2), 12);
        assert_eq!(next_backoff_secs(3), 24);
        assert_eq!(next_backoff_secs(4), 30);
        assert_eq!(next_backoff_secs(99), 30);

        assert!(!should_reset_backoff(Duration::from_secs(60)));
        assert!(should_reset_backoff(Duration::from_secs(61)));
    }

    #[test]
    fn port_conflict_detection_detects_bound_port() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(is_port_in_use(port));
        drop(listener);
        assert!(!is_port_in_use(port));
    }

    #[test]
    fn ensure_2048_default_config_creates_once_and_does_not_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("2048").join("config.json");

        ensure_2048_default_config(&cfg).unwrap();
        assert_eq!(fs::read_to_string(&cfg).unwrap(), r#"{"port":2048}"#);

        fs::write(&cfg, r#"{"port":2048,"custom":true}"#).unwrap();
        ensure_2048_default_config(&cfg).unwrap();
        assert_eq!(
            fs::read_to_string(&cfg).unwrap(),
            r#"{"port":2048,"custom":true}"#
        );
    }

    #[test]
    fn ensure_data_dirs_creates_all_subdirectories() {
        let dir = tempfile::tempdir().unwrap();
        ensure_data_dirs(dir.path()).unwrap();
        for sub in ["8046", "8048", "8049", "2048", "2048/auth", "logs"] {
            assert!(dir.path().join(sub).is_dir(), "missing {sub}");
        }
    }

    #[test]
    fn probe_response_parsers_validate_contracts() {
        assert!(parse_8049_status_ok(r#"{"ok":true}"#));
        assert!(!parse_8049_status_ok(r#"{"ok":false}"#));
        assert!(!parse_8049_status_ok("not-json"));

        assert!(parse_2048_session_json(r#"{"authenticated":false}"#));
        assert!(!parse_2048_session_json("{invalid"));
    }

    #[test]
    fn load_dotenv_pairs_parses_quotes_comments_and_proxy() {
        let dir = tempfile::tempdir().unwrap();
        let env_path = dir.path().join(".env");
        fs::write(
            &env_path,
            "# comment\n\nexport AUTO_START=\"true\"\nPROXY='http://127.0.0.1:7890'\nEMPTY=\nAISTUDIO_AUTH_STATES=C:\\old\\auth\n",
        )
        .unwrap();

        let pairs = load_dotenv_pairs(&env_path);
        assert_eq!(
            pairs,
            vec![
                ("AUTO_START".to_string(), "true".to_string()),
                ("PROXY".to_string(), "http://127.0.0.1:7890".to_string()),
                ("EMPTY".to_string(), "".to_string()),
                ("AISTUDIO_AUTH_STATES".to_string(), "C:\\old\\auth".to_string()),
            ]
        );
        assert!(load_dotenv_pairs(&dir.path().join("missing.env")).is_empty());
    }

    #[test]
    fn app2api_8049_command_removes_node_options() {
        let dir = tempfile::tempdir().unwrap();
        let install_dir = dir.path();
        fs::create_dir_all(install_dir.join("services").join("gemini-app2api-8049")).unwrap();
        let node_dir = install_dir.join("runtime").join("node");
        fs::create_dir_all(&node_dir).unwrap();
        fs::write(node_dir.join("node.exe"), b"").unwrap();

        let paths = TrayPaths {
            install_dir: install_dir.to_path_buf(),
            data_root: install_dir.join("data"),
            tray_exe: install_dir.join("gateway-tray.exe"),
            tray_config_path: install_dir.join("tray.json"),
        };

        let cmd = build_service_command(ServiceId::App2Api8049, &paths).unwrap();
        let envs: Vec<_> = cmd.get_envs().collect();
        assert!(
            envs.contains(&(std::ffi::OsStr::new("NODE_OPTIONS"), None)),
            "expected NODE_OPTIONS to be removed, got {envs:?}"
        );
        for key in [
            "GATEWAY_QUOTA_FAILOVER",
            "GATEWAY_EMPTY_RESPONSE_FAILOVER",
            "GATEWAY_AUTOMATIC_RECOVERY",
        ] {
            assert!(
                envs.contains(&(
                    std::ffi::OsStr::new(key),
                    Some(std::ffi::OsStr::new("1"))
                )),
                "expected {key}=1, got: {envs:?}"
            );
        }
    }

    #[test]
    fn proxy_8046_command_injects_aistudio_env_file_and_exe() {
        let dir = tempfile::tempdir().unwrap();
        let install_dir = dir.path();
        fs::write(install_dir.join(GATEWAY_EXE_NAME), b"").unwrap();

        let paths = TrayPaths {
            install_dir: install_dir.to_path_buf(),
            data_root: install_dir.join("data"),
            tray_exe: install_dir.join("gateway-tray.exe"),
            tray_config_path: install_dir.join("tray.json"),
        };

        let expected_env_file = paths.data_root.join("2048").join(".env");

        let cmd_without_2048 = build_service_command(ServiceId::Proxy8046, &paths).unwrap();
        let envs_without: Vec<_> = cmd_without_2048.get_envs().collect();
        assert!(envs_without.contains(&(
            std::ffi::OsStr::new("AISTUDIO_ENV_FILE"),
            Some(expected_env_file.as_os_str())
        )));
        assert!(!envs_without
            .iter()
            .any(|(k, _)| *k == std::ffi::OsStr::new("AISTUDIO_2048_EXE")));

        let exe_2048 = install_dir
            .join("services")
            .join("magpie-aistudio-2048")
            .join("bin")
            .join("aistudio2api.exe");
        fs::create_dir_all(exe_2048.parent().unwrap()).unwrap();
        fs::write(&exe_2048, b"").unwrap();

        let cmd_with_2048 = build_service_command(ServiceId::Proxy8046, &paths).unwrap();
        let envs_with: Vec<_> = cmd_with_2048.get_envs().collect();
        assert!(envs_with.contains(&(
            std::ffi::OsStr::new("AISTUDIO_ENV_FILE"),
            Some(expected_env_file.as_os_str())
        )));
        assert!(envs_with.contains(&(
            std::ffi::OsStr::new("AISTUDIO_2048_EXE"),
            Some(exe_2048.as_os_str())
        )));
    }
}
