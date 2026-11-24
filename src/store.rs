use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, sync::Mutex};

pub type Result<T> = std::result::Result<T, String>;
pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn token(prefix: &str) -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{prefix}{}", hex::encode(bytes))
}
pub fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn default_true() -> bool {
    true
}

fn default_routing_strategy() -> String {
    "fill-first".into()
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(from = "GroupInput")]
pub struct Group {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing)]
    pub profile_ids: Vec<String>,
    #[serde(default, skip_serializing)]
    pub default_strategy_enabled: bool,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub strategy_template_id: String,
    #[serde(default)]
    pub injection_mode: String,
    #[serde(default = "default_true")]
    pub safety_block_none: bool,
    #[serde(default)]
    pub suppress_thinking: bool,
    #[serde(default = "default_routing_strategy")]
    pub routing_strategy: String,
    #[serde(default = "default_true")]
    pub staged_timeout_enabled: bool,
    #[serde(default)]
    pub sse_keepalive_enabled: bool,
    #[serde(default)]
    pub smart_cooldown_enabled: bool,
}

#[derive(Deserialize)]
struct GroupInput {
    #[serde(default)]
    id: String,
    name: String,
    #[serde(default, deserialize_with = "explicit_profile_ids")]
    profile_ids: Option<Vec<String>>,
    #[serde(default)]
    default_strategy_enabled: bool,
    #[serde(default)]
    description: String,
    #[serde(default)]
    models: Vec<String>,
    #[serde(default)]
    instruction: String,
    #[serde(default)]
    strategy_template_id: String,
    #[serde(default)]
    injection_mode: String,
    #[serde(default = "default_true")]
    safety_block_none: bool,
    #[serde(default)]
    suppress_thinking: bool,
    #[serde(default = "default_routing_strategy")]
    routing_strategy: String,
    #[serde(default = "default_true")]
    staged_timeout_enabled: bool,
    #[serde(default)]
    sse_keepalive_enabled: bool,
    #[serde(default)]
    smart_cooldown_enabled: bool,
}

fn explicit_profile_ids<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Vec::<String>::deserialize(deserializer).map(Some)
}

impl From<GroupInput> for Group {
    fn from(input: GroupInput) -> Self {
        let profile_ids = input.profile_ids.unwrap_or_else(|| {
            crate::profiles::legacy_profile(&input.models, &input.instruction)
                .map(|profile| vec![profile.id.clone()])
                .unwrap_or_default()
        });
        Self {
            id: input.id,
            name: input.name,
            profile_ids,
            default_strategy_enabled: input.default_strategy_enabled,
            description: input.description,
            strategy_template_id: input.strategy_template_id,
            injection_mode: input.injection_mode,
            safety_block_none: input.safety_block_none,
            suppress_thinking: input.suppress_thinking,
            routing_strategy: input.routing_strategy,
            staged_timeout_enabled: input.staged_timeout_enabled,
            sse_keepalive_enabled: input.sse_keepalive_enabled,
            smart_cooldown_enabled: input.smart_cooldown_enabled,
        }
    }
}
#[derive(Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ProviderBinding {
    pub provider_id: String,
    pub key_id: String,
    pub key_name: String,
    pub group_name: String,
    pub group_multiplier: Option<f64>,
    pub status: String,
    pub last_synced_at: i64,
}
#[derive(Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Account {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub provider_binding: Option<ProviderBinding>,
    /// Encrypted SOCKS proxy URL; never returned by account APIs.
    #[serde(default)]
    pub proxy_url: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub model_mappings: BTreeMap<String, String>,
    #[serde(default)]
    pub group_ids: Vec<String>,
    #[serde(default)]
    pub rpm: u32,
    #[serde(default)]
    pub concurrency: u32,
    #[serde(default)]
    pub priority: i32,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(default = "protocols")]
    pub protocols: Vec<String>,
}
impl Account {
    pub fn provider_available(&self) -> bool {
        self.provider_binding
            .as_ref()
            .is_none_or(|binding| binding.status == "active" && !self.api_key.is_empty())
    }
    pub fn actual_model<'a>(&'a self, requested: &'a str) -> Option<&'a str> {
        let actual = self
            .model_mappings
            .get(requested)
            .map(String::as_str)
            .unwrap_or(requested);
        self.models
            .iter()
            .any(|model| model == actual)
            .then_some(actual)
    }
}
fn enabled() -> bool {
    true
}
fn protocols() -> Vec<String> {
    vec![
        "responses".into(),
        "compact".into(),
        "chat".into(),
        "anthropic".into(),
        "gemini".into(),
    ]
}
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct ApiKey {
    pub id: String,
    pub name: String,
    pub group_id: String,
    #[serde(default)]
    pub profile_ids: Vec<String>,
    #[serde(default)]
    pub default_strategy_enabled: bool,
    #[serde(default)]
    pub prefill_enabled: bool,
    #[serde(default)]
    pub secret: String,
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct SensitiveWordRule {
    #[serde(default)]
    pub pattern: String,
    #[serde(default)]
    pub replace: String,
    #[serde(default)]
    pub case_insensitive: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_armor_mode() -> String {
    "standard".into()
}

fn default_cache_settling_delay_ms() -> u32 {
    1000
}

fn default_autostart_enabled() -> bool {
    true
}

pub(crate) const MAX_CACHE_SETTLING_DELAY_MS: u32 = 5000;

#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    pub security_path: String,
    pub max_retries: u32,
    pub failure_threshold: u32,
    pub cooldown_seconds: u32,
    pub request_timeout_seconds: u32,
    pub retention_days: u32,
    #[serde(default = "default_cache_settling_delay_ms")]
    pub cache_settling_delay_ms: u32,
    #[serde(default = "default_autostart_enabled")]
    pub autostart_enabled: bool,
    #[serde(default = "default_armor_mode")]
    pub armor_mode: String,
    #[serde(default)]
    pub global_prompt: String,
    #[serde(default)]
    pub custom_template_prompts: BTreeMap<String, String>,
    #[serde(default)]
    pub sensitive_filter_enabled: bool,
    #[serde(default)]
    pub sensitive_words: Vec<SensitiveWordRule>,
    #[serde(default)]
    pub auto_update_enabled: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            security_path: String::new(),
            max_retries: 2,
            failure_threshold: 2,
            cooldown_seconds: 60,
            request_timeout_seconds: 120,
            retention_days: 7,
            cache_settling_delay_ms: default_cache_settling_delay_ms(),
            autostart_enabled: default_autostart_enabled(),
            armor_mode: "standard".into(),
            global_prompt: String::new(),
            custom_template_prompts: BTreeMap::new(),
            sensitive_filter_enabled: false,
            sensitive_words: Vec::new(),
            auto_update_enabled: false,
        }
    }
}
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct Config {
    pub username: String,
    pub password_hash: String,
    pub settings: Settings,
    pub groups: Vec<Group>,
    pub accounts: Vec<Account>,
    pub keys: Vec<ApiKey>,
    #[serde(default)]
    pub providers: Vec<crate::providers::Provider>,
    #[serde(default)]
    key_strategy_schema: u8,
}

fn migrate_key_strategies(config: &mut Config, raw: &Value) {
    if config.key_strategy_schema > 0 {
        return;
    }
    for group in &mut config.groups {
        for (index, key) in config
            .keys
            .iter_mut()
            .enumerate()
            .filter(|(_, key)| key.group_id == group.id)
        {
            let original = &raw["keys"][index];
            if original.get("profile_ids").is_none() {
                key.profile_ids = group.profile_ids.clone();
            }
            if original.get("default_strategy_enabled").is_none() {
                key.default_strategy_enabled = group.default_strategy_enabled;
            }
        }
        group.profile_ids.clear();
        group.default_strategy_enabled = false;
    }
    config.key_strategy_schema = 1;
}
#[derive(Clone, Serialize, Deserialize, Default, Debug)]
#[serde(from = "UsageInput")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
}
#[derive(Deserialize)]
struct UsageInput {
    input_tokens: u64,
    output_tokens: u64,
    cached_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: Option<u64>,
}
impl From<UsageInput> for Usage {
    fn from(input: UsageInput) -> Self {
        Self {
            input_tokens: input.input_tokens,
            output_tokens: input.output_tokens,
            cached_tokens: input.cached_tokens,
            cache_creation_input_tokens: input.cache_creation_input_tokens,
            cache_read_input_tokens: input.cache_read_input_tokens.unwrap_or(input.cached_tokens),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct RequestAttempt {
    pub index: u32,
    pub account_id: String,
    #[serde(default)]
    pub model: String,
    pub outcome: String, // "success" | "failed" | "cancelled"
    #[serde(default)]
    pub upstream_status: Option<u16>,
    #[serde(default)]
    pub error_stage: Option<String>, // "connect" | "headers" | "stream" | "http_status"
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub headers_ms: Option<u64>,
    #[serde(default)]
    pub first_byte_ms: Option<u64>,
    pub total_ms: u64,
}
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct RequestLog {
    pub id: String,
    pub timestamp: i64,
    pub key_id: String,
    pub account_id: String,
    pub model: String,
    pub protocol: String,
    pub status: u16,
    pub latency_ms: u64,
    #[serde(default)]
    pub first_token_ms: Option<u64>,
    pub usage: Usage,
    pub cyber: bool,
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attempt_details: Vec<RequestAttempt>,
    #[serde(default)]
    pub request_path: String,
    #[serde(default)]
    pub error: Option<String>,
}
pub const LOG_PAGE_SIZE: u64 = 20;
pub const STICKY_AFFINITY_MAX_AGE_SECS: i64 = 30 * 86400;
pub const STICKY_AFFINITY_MAX_ENTRIES: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct StickyBinding {
    pub account_id: String,
    pub last_used_at: i64,
    pub cached_tokens: u64,
    pub cache_written_at: i64,
}
pub struct LogPage {
    pub items: Vec<RequestLog>,
    pub page: u64,
    pub total: u64,
    pub total_pages: u64,
    pub retention_days: u32,
}
pub struct Store {
    db: Mutex<Connection>,
    cipher: Aes256Gcm,
}
fn read_config(db: &Connection) -> Result<Config> {
    let raw = db
        .query_row("SELECT value FROM config WHERE id=1", [], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|e| e.to_string())?
        .map(|value| serde_json::from_str::<Value>(&value).map_err(|e| e.to_string()))
        .transpose()?;
    let mut config = raw
        .as_ref()
        .map(|value| serde_json::from_value::<Config>(value.clone()).map_err(|e| e.to_string()))
        .transpose()?
        .unwrap_or_default();
    migrate_key_strategies(&mut config, raw.as_ref().unwrap_or(&Value::Null));
    Ok(config)
}
fn write_config(db: &Connection, config: &Config) -> Result<()> {
    db.execute(
        "INSERT INTO config(id,value) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        [serde_json::to_string(config).map_err(|e| e.to_string())?],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn clear_legacy_turnstile_settings(db: &Connection) -> Result<()> {
    let Some(value) = db
        .query_row("SELECT value FROM config WHERE id=1", [], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|e| e.to_string())?
    else {
        return Ok(());
    };
    let mut config: Value = serde_json::from_str(&value).map_err(|e| e.to_string())?;
    let removed = config
        .get_mut("settings")
        .and_then(Value::as_object_mut)
        .map(|settings| {
            let site_removed = settings.remove("turnstile_site_key").is_some();
            let secret_removed = settings.remove("turnstile_secret_key").is_some();
            site_removed || secret_removed
        })
        .unwrap_or(false);
    if removed {
        db.execute(
            "UPDATE config SET value=?1 WHERE id=1",
            [serde_json::to_string(&config).map_err(|e| e.to_string())?],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn insert_session(db: &Connection, raw: &str) -> Result<()> {
    db.execute("DELETE FROM sessions WHERE expires <= ?1", [now()])
        .map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO sessions VALUES(?1,?2)",
        params![digest(raw), now() + 86400],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn prune_logs(db: &Connection, retention_days: u32) -> Result<()> {
    db.execute(
        "DELETE FROM requests WHERE timestamp < ?1",
        [now() - i64::from(retention_days.max(1)) * 86400],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
impl Store {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let path = dir.join("master.key");
        let key = if path.exists() {
            std::fs::read(&path).map_err(|e| e.to_string())?
        } else {
            let mut key = vec![0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options
                .open(&path)
                .and_then(|mut f| f.write_all(&key))
                .map_err(|e| e.to_string())?;
            key
        };
        let cipher =
            Aes256Gcm::new_from_slice(&key).map_err(|_| "Invalid master.key".to_owned())?;
        let mut db = Connection::open(dir.join("zako.db")).map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, value TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS requests_time ON requests(timestamp);
            CREATE TABLE IF NOT EXISTS sticky_affinity (
                sticky_key TEXT PRIMARY KEY,
                account_id TEXT NOT NULL,
                last_used_at INTEGER NOT NULL,
                cached_tokens INTEGER NOT NULL DEFAULT 0,
                cache_written_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS sticky_affinity_last_used ON sticky_affinity(last_used_at);") .map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        clear_legacy_turnstile_settings(&tx)?;
        let config = read_config(&tx)?;
        write_config(&tx, &config)?;
        prune_logs(&tx, config.settings.retention_days)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(Self {
            db: Mutex::new(db),
            cipher,
        })
    }
    pub fn seal(&self, plain: &str) -> Result<String> {
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let data = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
            .map_err(|_| "Encryption failed")?;
        Ok(STANDARD.encode([nonce.to_vec(), data].concat()))
    }
    pub fn unseal(&self, encrypted: &str) -> Result<String> {
        if encrypted.is_empty() {
            return Ok(String::new());
        }
        let bytes = STANDARD
            .decode(encrypted)
            .map_err(|_| "Invalid encrypted secret")?;
        if bytes.len() < 28 {
            return Err("Invalid encrypted secret".into());
        }
        let plain = self
            .cipher
            .decrypt(Nonce::from_slice(&bytes[..12]), &bytes[12..])
            .map_err(|_| "Secret authentication failed")?;
        String::from_utf8(plain).map_err(|e| e.to_string())
    }
    pub fn config(&self) -> Result<Config> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        read_config(&db)
    }
    pub fn update<T>(&self, change: impl FnOnce(&mut Config) -> Result<T>) -> Result<T> {
        let mut db = self.db.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let mut cfg = read_config(&tx)?;
        let result = change(&mut cfg)?;
        write_config(&tx, &cfg)?;
        prune_logs(&tx, cfg.settings.retention_days)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(result)
    }
    pub fn session(&self, raw: &str) -> Result<()> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        insert_session(&db, raw)
    }
    pub fn session_for_credentials(&self, raw: &str, username: &str, hash: &str) -> Result<bool> {
        let mut db = self.db.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let cfg = read_config(&tx)?;
        if hash.is_empty() || cfg.username != username || cfg.password_hash != hash {
            return Ok(false);
        }
        insert_session(&tx, raw)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(true)
    }
    pub fn change_password(&self, session: &str, old_hash: &str, new_hash: String) -> Result<bool> {
        let mut db = self.db.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let mut cfg = read_config(&tx)?;
        let authenticated = tx
            .query_row(
                "SELECT 1 FROM sessions WHERE hash=?1 AND expires>?2",
                params![digest(session), now()],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .is_some();
        // Credential replacement and revocation share one transaction with session creation.
        if cfg.password_hash != old_hash || !authenticated {
            return Ok(false);
        }
        cfg.password_hash = new_hash;
        write_config(&tx, &cfg)?;
        tx.execute("DELETE FROM sessions", [])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(true)
    }
    pub fn authenticated(&self, raw: &str) -> bool {
        self.db
            .lock()
            .ok()
            .and_then(|db| {
                db.query_row(
                    "SELECT 1 FROM sessions WHERE hash=?1 AND expires>?2",
                    params![digest(raw), now()],
                    |_| Ok(()),
                )
                .ok()
            })
            .is_some()
    }
    pub fn logout(&self, raw: &str) {
        if let Ok(db) = self.db.lock() {
            let _ = db.execute("DELETE FROM sessions WHERE hash=?1", [digest(raw)]);
        }
    }
    pub fn revoke_sessions(&self) -> Result<()> {
        self.db
            .lock()
            .map_err(|e| e.to_string())?
            .execute("DELETE FROM sessions", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn log(&self, entry: &RequestLog, _retention: u32) -> Result<()> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        db.execute(
            "INSERT INTO requests VALUES(?1,?2,?3)",
            params![
                entry.id,
                entry.timestamp,
                serde_json::to_string(entry).map_err(|e| e.to_string())?
            ],
        )
        .map_err(|e| e.to_string())?;
        // An in-flight request may have captured an older retention setting.
        prune_logs(&db, read_config(&db)?.settings.retention_days)?;
        Ok(())
    }
    pub fn logs(&self, from: i64, to: i64) -> Result<Vec<RequestLog>> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        prune_logs(&db, read_config(&db)?.settings.retention_days)?;
        let mut query = db.prepare("SELECT value FROM requests WHERE timestamp>=?1 AND timestamp<=?2 ORDER BY timestamp DESC, id DESC").map_err(|e| e.to_string())?;
        query
            .query_map(params![from, to], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|row| {
                serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect()
    }
    pub fn logs_page(&self, requested_page: u64) -> Result<LogPage> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        let retention_days = read_config(&db)?.settings.retention_days.max(1);
        prune_logs(&db, retention_days)?;
        let total: u64 = db
            .query_row("SELECT COUNT(*) FROM requests", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let total_pages = total.div_ceil(LOG_PAGE_SIZE).max(1);
        let page = requested_page.clamp(1, total_pages);
        let mut query = db
            .prepare(
                "SELECT value FROM requests ORDER BY timestamp DESC, id DESC LIMIT ?1 OFFSET ?2",
            )
            .map_err(|e| e.to_string())?;
        let items = query
            .query_map(params![LOG_PAGE_SIZE, (page - 1) * LOG_PAGE_SIZE], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?
            .map(|row| {
                serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<RequestLog>>>()?;
        Ok(LogPage {
            items,
            page,
            total,
            total_pages,
            retention_days,
        })
    }
    pub fn export_logs(&self) -> Result<(u32, Vec<RequestLog>)> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        let retention_days = read_config(&db)?.settings.retention_days.max(1);
        prune_logs(&db, retention_days)?;
        let mut query = db
            .prepare("SELECT value FROM requests ORDER BY timestamp DESC, id DESC")
            .map_err(|e| e.to_string())?;
        let logs = query
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|row| {
                serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<RequestLog>>>()?;
        Ok((retention_days, logs))
    }
    pub fn delete_logs(&self) -> Result<usize> {
        self.db
            .lock()
            .map_err(|e| e.to_string())?
            .execute("DELETE FROM requests", [])
            .map_err(|e| e.to_string())
    }
    pub fn load_sticky_affinities(
        &self,
        max_age_secs: i64,
        limit: usize,
    ) -> Result<Vec<(String, StickyBinding)>> {
        let mut db = self.db.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let cutoff = now().saturating_sub(max_age_secs.max(0));
        tx.execute(
            "DELETE FROM sticky_affinity WHERE last_used_at < ?1",
            [cutoff],
        )
        .map_err(|e| e.to_string())?;
        let limit_i64 = i64::try_from(limit).unwrap_or(i64::MAX);
        let items = {
            let mut query = tx
                .prepare(
                    "SELECT sticky_key, account_id, last_used_at, cached_tokens, cache_written_at
                     FROM sticky_affinity
                     ORDER BY last_used_at DESC, sticky_key DESC
                     LIMIT ?1",
                )
                .map_err(|e| e.to_string())?;
            query
                .query_map([limit_i64], |row| {
                    let key = row.get::<_, String>(0)?;
                    let cached_raw = row.get::<_, i64>(3)?;
                    Ok((
                        key,
                        StickyBinding {
                            account_id: row.get::<_, String>(1)?,
                            last_used_at: row.get::<_, i64>(2)?,
                            cached_tokens: u64::try_from(cached_raw.max(0)).unwrap_or(0),
                            cache_written_at: row.get::<_, i64>(4)?,
                        },
                    ))
                })
                .map_err(|e| e.to_string())?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        tx.commit().map_err(|e| e.to_string())?;
        Ok(items)
    }
    pub fn upsert_sticky_affinity(
        &self,
        key: &str,
        account_id: &str,
        last_used_at: i64,
        cached_tokens: u64,
        cache_written_at: i64,
    ) -> Result<()> {
        let cached_tokens_i64 = i64::try_from(cached_tokens)
            .map_err(|_| "cached_tokens exceeds i64::MAX".to_owned())?;
        let mut db = self.db.lock().map_err(|e| e.to_string())?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO sticky_affinity (
                sticky_key, account_id, last_used_at, cached_tokens, cache_written_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(sticky_key) DO UPDATE SET
                account_id = excluded.account_id,
                last_used_at = excluded.last_used_at,
                cached_tokens = excluded.cached_tokens,
                cache_written_at = excluded.cache_written_at",
            params![
                key,
                account_id,
                last_used_at,
                cached_tokens_i64,
                cache_written_at
            ],
        )
        .map_err(|e| e.to_string())?;
        let count: i64 = tx
            .query_row("SELECT COUNT(*) FROM sticky_affinity", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if count > STICKY_AFFINITY_MAX_ENTRIES as i64 {
            tx.execute(
                "DELETE FROM sticky_affinity WHERE sticky_key NOT IN (
                    SELECT sticky_key FROM sticky_affinity
                    ORDER BY last_used_at DESC, sticky_key DESC
                    LIMIT ?1
                )",
                [STICKY_AFFINITY_MAX_ENTRIES as i64],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn delete_sticky_affinity(&self, key: &str) -> Result<usize> {
        self.db
            .lock()
            .map_err(|e| e.to_string())?
            .execute("DELETE FROM sticky_affinity WHERE sticky_key = ?1", [key])
            .map_err(|e| e.to_string())
    }
}
fn parse_standard_usage(u: &Value) -> Usage {
    let cache_read_input_tokens = [
        "/cache_read_input_tokens",
        "/input_tokens_details/cached_tokens",
        "/prompt_tokens_details/cached_tokens",
        "/cached_tokens",
    ]
    .iter()
    .find_map(|path| u.pointer(path).and_then(Value::as_u64))
    .unwrap_or(0);
    let cache_creation_input_tokens = [
        "/cache_creation_input_tokens",
        "/input_tokens_details/cache_creation_tokens",
        "/input_tokens_details/cache_write_tokens",
        "/prompt_tokens_details/cache_creation_tokens",
        "/prompt_tokens_details/cache_write_tokens",
        "/cache_creation_tokens",
        "/cache_write_tokens",
    ]
    .iter()
    .find_map(|path| u.pointer(path).and_then(Value::as_u64))
    .unwrap_or(0);
    Usage {
        input_tokens: u["input_tokens"]
            .as_u64()
            .or(u["prompt_tokens"].as_u64())
            .unwrap_or(0)
            .saturating_add(u["cache_read_input_tokens"].as_u64().unwrap_or(0))
            .saturating_add(u["cache_creation_input_tokens"].as_u64().unwrap_or(0)),
        output_tokens: u["output_tokens"]
            .as_u64()
            .or(u["completion_tokens"].as_u64())
            .unwrap_or(0),
        cached_tokens: cache_read_input_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
    }
}
pub fn usage(value: &Value) -> Usage {
    if let Some(u) = value
        .get("usage")
        .or_else(|| value.pointer("/response/usage"))
        .or_else(|| value.pointer("/message/usage"))
    {
        return parse_standard_usage(u);
    }
    if let Some(gm) = value
        .get("usageMetadata")
        .or_else(|| value.pointer("/response/usageMetadata"))
    {
        let cached = gm
            .get("cachedContentTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let candidates = gm
            .get("candidatesTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let thoughts = gm
            .get("thoughtsTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        return Usage {
            input_tokens: gm
                .get("promptTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            output_tokens: candidates.saturating_add(thoughts),
            cached_tokens: cached,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: cached,
        };
    }
    parse_standard_usage(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_mappings_default_empty_and_resolve_only_once_with_allowlist() {
        let mut account: Account = serde_json::from_value(serde_json::json!({
            "name":"Legacy", "endpoint":"https://example.com", "models":["actual", "alias"]
        }))
        .unwrap();
        assert!(account.model_mappings.is_empty());
        assert_eq!(account.actual_model("actual"), Some("actual"));
        account.model_mappings = BTreeMap::from([
            ("public".into(), "alias".into()),
            ("alias".into(), "actual".into()),
            ("another".into(), "actual".into()),
            ("invalid".into(), "unselected".into()),
        ]);
        assert_eq!(account.actual_model("public"), Some("alias"));
        assert_eq!(account.actual_model("alias"), Some("actual"));
        assert_eq!(account.actual_model("another"), Some("actual"));
        assert_eq!(account.actual_model("invalid"), None);
        assert_eq!(account.actual_model("unknown"), None);
        account.models.clear();
        assert_eq!(account.actual_model("alias"), None);
    }
    #[test]
    fn encrypted_storage_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let encrypted = store.seal("secret-upstream-token").unwrap();
        assert!(!encrypted.contains("secret-upstream-token"));
        assert_eq!(store.unseal(&encrypted).unwrap(), "secret-upstream-token");
        assert!(store.unseal("bad").is_err());
        drop(store);
        let store = Store::open(dir.path()).unwrap();
        assert_eq!(store.unseal(&encrypted).unwrap(), "secret-upstream-token");
    }
    #[test]
    fn sessions_are_revocable() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path()).unwrap();
        s.session("abc").unwrap();
        assert!(s.authenticated("abc"));
        s.logout("abc");
        assert!(!s.authenticated("abc"));
    }
    #[test]
    fn credential_changes_atomically_revoke_and_reject_stale_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path()).unwrap();
        s.update(|c| {
            c.username = "admin".into();
            c.password_hash = "first-password-hash".into();
            Ok(())
        })
        .unwrap();
        assert!(
            s.session_for_credentials("first", "admin", "first-password-hash")
                .unwrap()
        );
        assert!(
            s.change_password(
                "first",
                "first-password-hash",
                "second-password-hash".into()
            )
            .unwrap()
        );
        assert!(!s.authenticated("first"));
        assert!(
            !s.session_for_credentials("stale", "admin", "first-password-hash")
                .unwrap()
        );
        assert!(!s.authenticated("stale"));
        assert!(
            !s.change_password("first", "first-password-hash", "stale-replacement".into())
                .unwrap()
        );
        assert!(
            s.session_for_credentials("second", "admin", "second-password-hash")
                .unwrap()
        );
        s.logout("second");
        assert!(
            !s.change_password(
                "second",
                "second-password-hash",
                "revoked-replacement".into()
            )
            .unwrap()
        );
        assert_eq!(s.config().unwrap().password_hash, "second-password-hash");
    }
    #[test]
    fn usage_includes_cache() {
        let u = usage(
            &serde_json::json!({"response":{"usage":{"input_tokens":100,"output_tokens":10,"input_tokens_details":{"cached_tokens":80}}}}),
        );
        assert_eq!(u.cached_tokens, 80);
        assert_eq!(u.cache_read_input_tokens, 80);
        assert_eq!(u.cache_creation_input_tokens, 0);
        assert_eq!(u.input_tokens, 100);
    }
    #[test]
    fn usage_preserves_anthropic_cache_creation_and_read_counts() {
        let u = usage(&serde_json::json!({"message":{"usage":{
            "input_tokens":20,"cache_creation_input_tokens":30,
            "cache_read_input_tokens":50,"output_tokens":7
        }}}));
        assert_eq!(u.input_tokens, 100);
        assert_eq!(u.cache_creation_input_tokens, 30);
        assert_eq!(u.cache_read_input_tokens, 50);
        assert_eq!(u.cached_tokens, 50);
        let old: Usage = serde_json::from_value(serde_json::json!({
            "input_tokens":100,"output_tokens":7,"cached_tokens":50
        }))
        .unwrap();
        assert_eq!(old.cache_creation_input_tokens, 0);
        assert_eq!(old.cache_read_input_tokens, 50);
        assert_eq!(old.cached_tokens, 50);
    }
    #[test]
    fn usage_parses_gemini_usage_metadata() {
        let u = usage(&serde_json::json!({
            "usageMetadata": {
                "promptTokenCount": 1200,
                "candidatesTokenCount": 340,
                "cachedContentTokenCount": 900,
                "thoughtsTokenCount": 60,
                "totalTokenCount": 1600
            }
        }));
        assert_eq!(u.input_tokens, 1200);
        assert_eq!(u.output_tokens, 400);
        assert_eq!(u.cached_tokens, 900);
        assert_eq!(u.cache_read_input_tokens, 900);
        assert_eq!(u.cache_creation_input_tokens, 0);

        let wrapped = usage(&serde_json::json!({
            "response": {
                "usageMetadata": {
                    "promptTokenCount": 500,
                    "candidatesTokenCount": 80
                }
            }
        }));
        assert_eq!(wrapped.input_tokens, 500);
        assert_eq!(wrapped.output_tokens, 80);
        assert_eq!(wrapped.cached_tokens, 0);
        assert_eq!(wrapped.cache_read_input_tokens, 0);
    }
    #[test]
    fn sticky_affinity_crud_and_age_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let current = now();
        store
            .upsert_sticky_affinity("k-old", "acc-1", current - STICKY_AFFINITY_MAX_AGE_SECS - 10, 100, current - 100)
            .unwrap();
        store
            .upsert_sticky_affinity("k-fresh-1", "acc-1", current - 10, 200, current - 10)
            .unwrap();
        store
            .upsert_sticky_affinity("k-fresh-2", "acc-2", current - 5, 300, current - 5)
            .unwrap();
        // Upsert existing key updates fields in place.
        store
            .upsert_sticky_affinity("k-fresh-1", "acc-3", current, 450, current)
            .unwrap();

        drop(store);
        let reopened = Store::open(dir.path()).unwrap();
        let loaded = reopened
            .load_sticky_affinities(STICKY_AFFINITY_MAX_AGE_SECS, STICKY_AFFINITY_MAX_ENTRIES)
            .unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].0, "k-fresh-1");
        assert_eq!(
            loaded[0].1,
            StickyBinding {
                account_id: "acc-3".into(),
                last_used_at: current,
                cached_tokens: 450,
                cache_written_at: current,
            }
        );
        assert_eq!(loaded[1].0, "k-fresh-2");
        assert_eq!(reopened.delete_sticky_affinity("k-fresh-2").unwrap(), 1);
        assert_eq!(reopened.delete_sticky_affinity("k-fresh-2").unwrap(), 0);
        let after_delete = reopened
            .load_sticky_affinities(STICKY_AFFINITY_MAX_AGE_SECS, STICKY_AFFINITY_MAX_ENTRIES)
            .unwrap();
        assert_eq!(after_delete.len(), 1);
        assert_eq!(after_delete[0].0, "k-fresh-1");
    }
    #[test]
    fn sticky_affinity_evicts_oldest_over_4096() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let base = now();
        for i in 0..=STICKY_AFFINITY_MAX_ENTRIES {
            let key = format!("k-{i:04}");
            store
                .upsert_sticky_affinity(&key, "acc-1", base + i as i64, i as u64, base)
                .unwrap();
        }
        let loaded = store
            .load_sticky_affinities(STICKY_AFFINITY_MAX_AGE_SECS, STICKY_AFFINITY_MAX_ENTRIES + 100)
            .unwrap();
        assert_eq!(loaded.len(), STICKY_AFFINITY_MAX_ENTRIES);
        assert_eq!(loaded.first().unwrap().0, format!("k-{:04}", STICKY_AFFINITY_MAX_ENTRIES));
        assert_eq!(loaded.last().unwrap().0, "k-0001");
        assert!(!loaded.iter().any(|(k, _)| k == "k-0000"));
    }
}
