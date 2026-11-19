use crate::{
    Shared, profiles,
    store::{
        self, Account, ApiKey, Config, Group, RequestAttempt, RequestLog, Settings, StickyBinding,
        Usage,
    },
};
use axum::{
    Json,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashSet},
    time::{Duration, Instant},
};

const MAX_EVENT_BYTES: usize = 256 * 1024;
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
const MAX_TRACKED_CHAT_CHOICES: u64 = 1024;
const MAX_ERROR_BYTES: usize = 2048;
const MAGPIE_CACHE_WORTH_TOKENS: u64 = 1024;
const MAGPIE_COLD_WINDOW_SECS: i64 = 300;
const HEAVY_COLD_PROMPT_TOKENS: u64 = 16_000;
const CACHE_SETTLING_TTL: Duration = Duration::from_secs(60);
const SSE_KEEPALIVE_INTERVAL_SECS: u64 = 10;

#[cfg(test)]
static TEST_SSE_KEEPALIVE_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn sse_keepalive_interval() -> Duration {
    #[cfg(test)]
    {
        let override_ms = TEST_SSE_KEEPALIVE_MS.load(std::sync::atomic::Ordering::Relaxed);
        if override_ms > 0 {
            return Duration::from_millis(override_ms);
        }
    }
    Duration::from_secs(SSE_KEEPALIVE_INTERVAL_SECS)
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn parse_retry_after_seconds(value: &str, now: i64) -> Option<u64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(seconds) = trimmed.parse::<u64>() {
        return Some(seconds.clamp(1, 600));
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc2822(trimmed) {
        let delta = dt.timestamp().saturating_sub(now);
        return Some(delta.clamp(1, 600) as u64);
    }
    None
}

mod cyber;

fn route_for(protocol: &str) -> &'static str {
    match protocol {
        "compact" => "responses/compact",
        "anthropic" => "messages",
        "chat" => "chat/completions",
        _ => "responses",
    }
}

fn error_summary(message: &str, secrets: &[String]) -> String {
    let mut message = message.to_owned();
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        message = message.replace(secret, "[redacted]");
        if let Ok(encoded) = serde_json::to_string(secret) {
            message = message.replace(&encoded[1..encoded.len() - 1], "[redacted]");
        }
    }
    if message.len() > MAX_ERROR_BYTES {
        let mut end = MAX_ERROR_BYTES - '…'.len_utf8();
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
        message.push('…');
    }
    message
}

/// Endpoint roots may include /v1, but must not contain credentials or fragments.
pub fn upstream_url(endpoint: &str, route: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(endpoint.trim()).map_err(|_| "Invalid upstream endpoint")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err(
            "Endpoint must be an HTTP(S) URL without credentials, query, or fragment".into(),
        );
    }
    let root = url.path().trim_end_matches('/');
    let root = if root.ends_with("/v1") {
        root.to_owned()
    } else {
        format!("{root}/v1")
    };
    url.set_path(&format!(
        "{root}/{}",
        route.trim_start_matches('/').trim_start_matches("v1/")
    ));
    Ok(url)
}

fn error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(json!({"error":{"message":message,"type":"proxy_error"}})),
    )
        .into_response()
}

fn authorize(
    state: &Shared,
    headers: &HeaderMap,
) -> Result<(Config, ApiKey, Group), (StatusCode, &'static str)> {
    authorize_with_uri(state, headers, None)
}

fn authorize_with_uri(
    state: &Shared,
    headers: &HeaderMap,
    uri: Option<&Uri>,
) -> Result<(Config, ApiKey, Group), (StatusCode, &'static str)> {
    let query_key = uri
        .and_then(|u| u.query())
        .and_then(|q| {
            url::form_urlencoded::parse(q.as_bytes())
                .find(|(k, _)| k == "key")
                .map(|(_, v)| v.into_owned())
        })
        .filter(|v| !v.is_empty());
    let raw_owned = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, value)| value.to_owned())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            headers
                .get("x-api-key")
                .and_then(|v| v.to_str().ok())
                .filter(|v| !v.is_empty())
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            headers
                .get("x-goog-api-key")
                .and_then(|v| v.to_str().ok())
                .filter(|v| !v.is_empty())
                .map(ToOwned::to_owned)
        })
        .or(query_key)
        .ok_or((
            StatusCode::UNAUTHORIZED,
            "A valid proxy API key is required",
        ))?;
    let raw = raw_owned.as_str();
    let config = state.store.config().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Configuration unavailable",
        )
    })?;
    let hash = store::digest(raw);
    let key = config
        .keys
        .iter()
        .find(|key| key.enabled && key.hash == hash)
        .cloned()
        .ok_or((
            StatusCode::UNAUTHORIZED,
            "A valid proxy API key is required",
        ))?;
    let group = config
        .groups
        .iter()
        .find(|group| group.id == key.group_id)
        .cloned()
        .ok_or((
            StatusCode::SERVICE_UNAVAILABLE,
            "The API key has no available group",
        ))?;
    Ok((config, key, group))
}

pub async fn models(State(state): State<Shared>, headers: HeaderMap) -> Response {
    let (config, _, group) = match authorize(&state, &headers) {
        Ok(value) => value,
        Err((status, message)) => return error(status, message),
    };
    let models: BTreeSet<_> = config
        .accounts
        .iter()
        .filter(|account| {
            account.enabled && account.provider_available() && account.group_ids.contains(&group.id)
        })
        .flat_map(|account| {
            account
                .models
                .iter()
                .chain(account.model_mappings.keys())
                .filter(|requested| account.actual_model(requested).is_some())
                .cloned()
        })
        .collect();
    Json(json!({"object":"list", "data":models.into_iter().map(|id| json!({"id":id,"object":"model","owned_by":"upstream"})).collect::<Vec<_>>()})).into_response()
}

pub async fn responses(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    forward(state, headers, body, "responses").await
}

pub async fn compact(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    forward(state, headers, body, "compact").await
}

pub async fn chat_completions(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    forward(state, headers, body, "chat").await
}

pub async fn messages(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    forward(state, headers, body, "anthropic").await
}

pub async fn gemini_models(
    State(state): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let (config, _, group) = match authorize_with_uri(&state, &headers, Some(&uri)) {
        Ok(value) => value,
        Err((status, message)) => return error(status, message),
    };
    let models: BTreeSet<_> = config
        .accounts
        .iter()
        .filter(|account| {
            account.enabled && account.provider_available() && account.group_ids.contains(&group.id)
        })
        .flat_map(|account| {
            account
                .models
                .iter()
                .chain(account.model_mappings.keys())
                .filter(|requested| account.actual_model(requested).is_some())
                .cloned()
        })
        .collect();
    let items: Vec<Value> = models
        .into_iter()
        .map(|id| {
            json!({
                "name": format!("models/{id}"),
                "displayName": id,
                "supportedGenerationMethods": ["generateContent", "streamGenerateContent"]
            })
        })
        .collect();
    Json(json!({"models": items})).into_response()
}

pub async fn gemini_generate(
    State(state): State<Shared>,
    headers: HeaderMap,
    uri: Uri,
    Path(rest): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let rest = rest.trim_start_matches('/');
    let Some((model, action)) = rest.rsplit_once(':') else {
        return error(
            StatusCode::BAD_REQUEST,
            "Gemini path must be /v1beta/models/{model}:{action}",
        );
    };
    if model.is_empty()
        || !matches!(
            action,
            "generateContent" | "streamGenerateContent" | "countTokens"
        )
    {
        return error(StatusCode::BAD_REQUEST, "Unsupported Gemini model action");
    }
    forward_inner(
        state,
        headers,
        Some(uri),
        body,
        "gemini",
        Some(model.to_owned()),
        Some(action.to_owned()),
    )
    .await
}

fn gemini_upstream_url(
    endpoint: &str,
    actual_model: &str,
    action: &str,
    query: Option<&str>,
) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(endpoint.trim()).map_err(|_| "Invalid upstream endpoint")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err(
            "Endpoint must be an HTTP(S) URL without credentials, query, or fragment".into(),
        );
    }
    let root = url.path().trim_end_matches('/');
    let root = root
        .strip_suffix("/v1beta")
        .or_else(|| root.strip_suffix("/v1"))
        .unwrap_or(root);
    url.set_path(&format!("{root}/v1beta/models/{actual_model}:{action}"));
    if let Some(q) = query {
        let kept: Vec<(String, String)> = url::form_urlencoded::parse(q.as_bytes())
            .filter(|(k, _)| k != "key")
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        if !kept.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (k, v) in kept {
                pairs.append_pair(&k, &v);
            }
        }
    }
    Ok(url)
}

fn replace_case_insensitive(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return haystack.to_owned();
    }
    let hay_lower = haystack.to_lowercase();
    let needle_lower = needle.to_lowercase();
    if hay_lower.len() != haystack.len() || needle_lower.len() != needle.len() {
        // Fallback when Unicode case-folding changes UTF-8 byte length
        return haystack.replace(needle, replacement);
    }
    let mut out = String::with_capacity(haystack.len());
    let mut last = 0;
    for (idx, _) in hay_lower.match_indices(&needle_lower) {
        out.push_str(&haystack[last..idx]);
        out.push_str(replacement);
        last = idx + needle.len();
    }
    out.push_str(&haystack[last..]);
    out
}

fn filter_text_with_rules(text: &str, rules: &[crate::store::SensitiveWordRule]) -> String {
    let mut out = text.to_owned();
    for rule in rules {
        if !rule.enabled || rule.pattern.is_empty() {
            continue;
        }
        if rule.case_insensitive {
            out = replace_case_insensitive(&out, &rule.pattern, &rule.replace);
        } else {
            out = out.replace(&rule.pattern, &rule.replace);
        }
    }
    out
}

fn filter_value_text_fields(val: &mut Value, rules: &[crate::store::SensitiveWordRule]) {
    match val {
        Value::String(s) => {
            let next = filter_text_with_rules(s, rules);
            if next != *s {
                *s = next;
            }
        }
        Value::Array(items) => {
            for item in items {
                filter_value_text_fields(item, rules);
            }
        }
        Value::Object(map) => {
            for key in ["text", "content", "instructions", "system"] {
                if let Some(v) = map.get_mut(key) {
                    filter_value_text_fields(v, rules);
                }
            }
            if let Some(parts) = map.get_mut("parts") {
                filter_value_text_fields(parts, rules);
            }
        }
        _ => {}
    }
}

fn apply_sensitive_filter(body: &mut Value, settings: &Settings) {
    if !settings.sensitive_filter_enabled || settings.sensitive_words.is_empty() {
        return;
    }
    for field in [
        "messages",
        "contents",
        "input",
        "instructions",
        "system",
        "systemInstruction",
    ] {
        if let Some(val) = body.get_mut(field) {
            filter_value_text_fields(val, &settings.sensitive_words);
        }
    }
}

fn resolve_instruction_with_settings<'a>(
    key_policy: &Group,
    group: &Group,
    model: &str,
    settings: &'a Settings,
) -> Option<std::borrow::Cow<'a, str>> {
    if settings.armor_mode == "pure_cache" || group.strategy_template_id == "none" {
        return None;
    }
    if !group.strategy_template_id.is_empty() {
        if let Some(custom) = settings.custom_template_prompts.get(&group.strategy_template_id) {
            if !custom.trim().is_empty() {
                return Some(std::borrow::Cow::Borrowed(custom.as_str()));
            }
        }
    }
    if !settings.global_prompt.trim().is_empty() {
        return Some(std::borrow::Cow::Borrowed(settings.global_prompt.as_str()));
    }
    resolve_instruction(key_policy, group, model).map(std::borrow::Cow::Borrowed)
}

fn resolve_instruction(key_policy: &Group, group: &Group, model: &str) -> Option<&'static str> {
    if group.strategy_template_id == "none" {
        return None;
    }
    if let Some(explicit) = profiles::instruction(
        &Group {
            profile_ids: key_policy.profile_ids.clone(),
            default_strategy_enabled: false,
            ..Default::default()
        },
        model,
    ) {
        return Some(explicit);
    }
    if !group.strategy_template_id.is_empty() {
        return profiles::template_instruction_by_id(&group.strategy_template_id, model);
    }
    profiles::instruction(key_policy, model)
}

fn apply_gemini_cleaning(body: &mut Value, group: &Group) {
    if group.safety_block_none {
        let safety_missing = match body.get("safetySettings") {
            None | Some(Value::Null) => true,
            Some(Value::Array(items)) => items.is_empty(),
            _ => false,
        };
        if safety_missing {
            body["safetySettings"] = json!([
                {"category": "HARM_CATEGORY_CIVIC_INTEGRITY", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"}
            ]);
        }
    }
    if group.suppress_thinking {
        let cfg_key = if body.get("config").is_some() {
            "config"
        } else {
            "generationConfig"
        };
        if !body.get(cfg_key).is_some_and(Value::is_object) {
            body[cfg_key] = json!({});
        }
        if let Some(cfg) = body.get_mut(cfg_key).and_then(Value::as_object_mut) {
            cfg.remove("thinkingBudget");
            cfg.remove("thinking_budget");
            cfg.insert(
                "thinkingConfig".into(),
                json!({"thinkingBudget": 0, "thinkingLevel": "minimal", "includeThoughts": false}),
            );
        }
    }
}

fn apply_gemini_instruction(
    body: &mut Value,
    instruction: Option<&str>,
    group: &Group,
) -> Result<(), &'static str> {
    apply_gemini_cleaning(body, group);
    let Some(instruction) = instruction.filter(|s| !s.trim().is_empty()) else {
        return Ok(());
    };
    match body.get_mut("systemInstruction") {
        None | Some(Value::Null) => {
            body["systemInstruction"] = json!({
                "role": "user",
                "parts": [{"text": instruction}]
            });
        }
        Some(Value::Object(obj)) => {
            if let Some(parts) = obj.get_mut("parts").and_then(Value::as_array_mut) {
                parts.insert(0, json!({"text": instruction}));
            } else {
                obj.insert("parts".into(), json!([{"text": instruction}]));
            }
        }
        Some(_) => {
            return Err("systemInstruction must be an object when a group instruction is applied");
        }
    }
    Ok(())
}

fn apply_system_text(body: &mut Value, instruction: Option<&str>) -> Result<(), &'static str> {
    let Some(instruction) = instruction.filter(|s| !s.trim().is_empty()) else {
        return Ok(());
    };
    let system = match body.get("system") {
        None => json!(instruction),
        Some(Value::String(existing)) if existing.is_empty() => json!(instruction),
        Some(Value::String(existing)) => json!(format!("{instruction}\n\n{existing}")),
        Some(Value::Array(blocks)) => {
            let mut blocks = blocks.clone();
            blocks.insert(0, json!({"type":"text", "text":instruction}));
            json!(blocks)
        }
        Some(_) => {
            return Err("system must be a string or an array when a group instruction is applied");
        }
    };
    body["system"] = system;
    Ok(())
}

#[cfg(test)]
fn apply_instruction(body: &mut Value, group: &Group, model: &str) -> Result<(), &'static str> {
    apply_instruction_text(body, profiles::instruction(group, model))
}

fn apply_instruction_text(body: &mut Value, instruction: Option<&str>) -> Result<(), &'static str> {
    let Some(instruction) = instruction.filter(|s| !s.trim().is_empty()) else {
        return Ok(());
    };
    let instructions = match body.get("instructions") {
        None => instruction.to_owned(),
        Some(Value::String(existing)) if existing.is_empty() => instruction.to_owned(),
        Some(Value::String(existing)) => format!("{instruction}\n\n{existing}"),
        Some(_) => return Err("instructions must be a string when a group instruction is applied"),
    };
    body["instructions"] = Value::String(instructions);
    Ok(())
}

fn apply_chat_instruction_text(
    body: &mut Value,
    instruction: Option<&str>,
) -> Result<(), &'static str> {
    let Some(instruction) = instruction.filter(|s| !s.trim().is_empty()) else {
        return Ok(());
    };
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return Err("messages must be an array when a group instruction is applied");
    };
    messages.insert(0, json!({"role":"system", "content":instruction}));
    Ok(())
}

struct Admission {
    state: Shared,
    account_id: String,
}
impl Drop for Admission {
    fn drop(&mut self) {
        let notify = if let Ok(mut runtime) = self.state.runtime.lock()
            && let Some(account) = runtime.get_mut(&self.account_id)
        {
            account.active = account.active.saturating_sub(1);
            Some(account.slot_notify.clone())
        } else {
            None
        };
        if let Some(notify) = notify {
            notify.notify_one();
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum AdmissionError {
    Cooldown(u64),
    Concurrency,
    Rpm(u64),
    Unavailable,
    Exhausted,
}
impl AdmissionError {
    fn retry_after(self) -> u64 {
        match self {
            Self::Cooldown(seconds) | Self::Rpm(seconds) => seconds.max(1),
            _ => 1,
        }
    }
    fn response(self) -> Response {
        let (status, code, message) = match self {
            Self::Cooldown(_) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "upstream_cooldown",
                "Upstream accounts are temporarily cooling down after failures",
            ),
            Self::Concurrency => (
                StatusCode::TOO_MANY_REQUESTS,
                "concurrency_limit_exceeded",
                "Account concurrency limit reached",
            ),
            Self::Rpm(_) => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limit_exceeded",
                "Account requests-per-minute limit reached",
            ),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "admission_unavailable",
                "Account admission is temporarily unavailable",
            ),
            Self::Exhausted => (
                StatusCode::BAD_GATEWAY,
                "upstream_unavailable",
                "Upstream request failed; no untried account is available",
            ),
        };
        let mut response = (
            status,
            Json(json!({"error":{"message":message,"type":"proxy_error","code":code}})),
        )
            .into_response();
        response.headers_mut().insert(
            "retry-after",
            HeaderValue::from_str(&self.retry_after().to_string()).unwrap(),
        );
        response
            .headers_mut()
            .insert("x-zako-error-source", HeaderValue::from_static("local"));
        response
    }
}

fn select_account<'a>(
    state: &Shared,
    accounts: &'a [Account],
    tried: &HashSet<String>,
) -> Result<(&'a Account, Admission), AdmissionError> {
    release_cooldowns_if_pool_blocked(state, accounts)?;
    let mut candidates: Vec<(&'a Account, u32)> = {
        let runtime = state
            .runtime
            .lock()
            .map_err(|_| AdmissionError::Unavailable)?;
        accounts
            .iter()
            .filter(|account| !tried.contains(&account.id))
            .map(|account| {
                let active = runtime
                    .get(&account.id)
                    .map(|status| status.active)
                    .unwrap_or(0);
                (account, active)
            })
            .collect()
    };
    candidates.sort_by(|(a, a_active), (b, b_active)| {
        a.priority
            .cmp(&b.priority)
            .then_with(|| a_active.cmp(b_active))
            .then_with(|| a.id.cmp(&b.id))
    });
    let mut blocked = None;
    for (account, _) in candidates {
        match admit(state, account) {
            Ok(admission) => return Ok((account, admission)),
            Err(reason) => {
                if blocked
                    .is_none_or(|saved: AdmissionError| reason.retry_after() < saved.retry_after())
                {
                    blocked = Some(reason);
                }
            }
        }
    }
    Err(blocked.unwrap_or(AdmissionError::Exhausted))
}

fn select_account_rr<'a>(
    state: &Shared,
    group_id: &str,
    accounts: &'a [Account],
    tried: &HashSet<String>,
) -> Result<(&'a Account, Admission), AdmissionError> {
    release_cooldowns_if_pool_blocked(state, accounts)?;
    if accounts.is_empty() {
        return Err(AdmissionError::Exhausted);
    }
    let offset = {
        let mut cursors = state
            .rr_cursors
            .lock()
            .map_err(|_| AdmissionError::Unavailable)?;
        let cursor = cursors.entry(group_id.to_owned()).or_insert(0);
        let current = *cursor;
        *cursor = current.wrapping_add(1);
        current % accounts.len()
    };
    let mut blocked = None;
    for i in 0..accounts.len() {
        let account = &accounts[(offset + i) % accounts.len()];
        if tried.contains(&account.id) {
            continue;
        }
        match admit(state, account) {
            Ok(admission) => return Ok((account, admission)),
            Err(reason) => {
                if blocked
                    .is_none_or(|saved: AdmissionError| reason.retry_after() < saved.retry_after())
                {
                    blocked = Some(reason);
                }
            }
        }
    }
    Err(blocked.unwrap_or(AdmissionError::Exhausted))
}

fn first_message_text_prefix(body: &Value) -> String {
    let extract_text = |value: &Value| -> Option<String> {
        if let Some(s) = value.as_str() {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.chars().take(128).collect());
            }
        } else if let Some(arr) = value.as_array() {
            for item in arr {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.chars().take(128).collect());
                    }
                }
            }
        }
        None
    };

    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        for msg in messages {
            if let Some(content) = msg.get("content")
                && let Some(text) = extract_text(content)
            {
                return text;
            }
        }
    }
    if let Some(input) = body.get("input") {
        if let Some(text) = extract_text(input) {
            return text;
        }
        if let Some(arr) = input.as_array() {
            for item in arr {
                if let Some(content) = item.get("content")
                    && let Some(text) = extract_text(content)
                {
                    return text;
                }
                if let Some(text) = extract_text(item) {
                    return text;
                }
            }
        }
    }
    if let Some(contents) = body.get("contents").and_then(Value::as_array) {
        for item in contents {
            if let Some(parts) = item.get("parts")
                && let Some(text) = extract_text(parts)
            {
                return text;
            }
        }
    }
    String::new()
}

fn header_value_ci(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .iter()
        .find(|(k, _)| k.as_str().eq_ignore_ascii_case(name))
        .and_then(|(_, v)| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn build_sticky_key(
    group_id: &str,
    key_id: &str,
    model: &str,
    headers: &HeaderMap,
    body: &Value,
) -> String {
    let session_id = header_value_ci(headers, "x-session-id");
    let thread_id = header_value_ci(headers, "x-thread-id");
    let claude_agent_id = header_value_ci(headers, "x-claude-code-agent-id");

    let session_part = session_id
        .as_deref()
        .or(thread_id.as_deref())
        .map(|s| format!("sid:{s}"))
        .unwrap_or_else(|| {
            let prefix = first_message_text_prefix(body);
            if prefix.is_empty() {
                "msg:empty".to_owned()
            } else {
                let hash = store::digest(&prefix);
                format!("msg:{}", &hash[..16])
            }
        });

    let subagent_id = claude_agent_id.or(thread_id);
    match subagent_id {
        Some(agent_id) => format!("{group_id}:{key_id}:{model}:{session_part}|agent:{agent_id}"),
        None => format!("{group_id}:{key_id}:{model}:{session_part}"),
    }
}

fn persist_sticky_affinity(state: &Shared, sticky_key: &str, binding: &StickyBinding) {
    if let Err(error) = state.store.upsert_sticky_affinity(
        sticky_key,
        &binding.account_id,
        binding.last_used_at,
        binding.cached_tokens,
        binding.cache_written_at,
    ) {
        tracing::error!(
            sticky_key,
            account_id = %binding.account_id,
            %error,
            "Failed to persist sticky affinity"
        );
    }
}

fn touch_sticky_last_used(state: &Shared, sticky_key: &str, now: i64) {
    let updated = state
        .sticky_bindings
        .lock()
        .ok()
        .and_then(|mut bindings| {
            bindings.get_mut(sticky_key).map(|binding| {
                binding.last_used_at = now;
                binding.clone()
            })
        });
    if let Some(binding) = updated {
        persist_sticky_affinity(state, sticky_key, &binding);
    }
}

fn settle_sticky_cache_binding(
    state: &Shared,
    sticky_key: &str,
    account_id: &str,
    usage: &Usage,
    healthy: bool,
) {
    if !healthy {
        return;
    }
    let now = store::now();
    let cache_tokens = usage
        .cached_tokens
        .max(usage.cache_read_input_tokens)
        .max(usage.cache_creation_input_tokens);
    let recorded_tokens = if cache_tokens >= MAGPIE_CACHE_WORTH_TOKENS {
        Some(cache_tokens)
    } else if usage.input_tokens >= MAGPIE_CACHE_WORTH_TOKENS {
        Some(usage.input_tokens)
    } else {
        None
    };
    let updated = if let Ok(mut bindings) = state.sticky_bindings.lock() {
        let entry = bindings
            .entry(sticky_key.to_owned())
            .or_insert_with(|| StickyBinding {
                account_id: account_id.to_owned(),
                last_used_at: now,
                cached_tokens: 0,
                cache_written_at: 0,
            });
        entry.account_id = account_id.to_owned();
        entry.last_used_at = now;
        if let Some(tokens) = recorded_tokens {
            entry.cached_tokens = entry.cached_tokens.max(tokens);
            entry.cache_written_at = now;
        }
        Some(entry.clone())
    } else {
        None
    };
    if let Some(binding) = updated {
        persist_sticky_affinity(state, sticky_key, &binding);
    }
}

fn is_magpie_cache_protected(binding: &StickyBinding, now: i64) -> bool {
    binding.cached_tokens >= MAGPIE_CACHE_WORTH_TOKENS
        && binding.cache_written_at > 0
        && now.saturating_sub(binding.cache_written_at) <= MAGPIE_COLD_WINDOW_SECS
}

async fn select_account_cache_first<'a>(
    state: &Shared,
    sticky_key: &str,
    accounts: &'a [Account],
    tried: &HashSet<String>,
) -> Result<(&'a Account, Admission), AdmissionError> {
    release_cooldowns_if_pool_blocked(state, accounts)?;
    let now = store::now();
    let bound = state
        .sticky_bindings
        .lock()
        .ok()
        .and_then(|bindings| bindings.get(sticky_key).cloned());
    if let Some(bound_binding) = bound
        && let Some(bound_account) = accounts
            .iter()
            .find(|account| account.id == bound_binding.account_id && !tried.contains(&account.id))
    {
        let cache_protected = is_magpie_cache_protected(&bound_binding, now);
        match admit(state, bound_account) {
            Ok(admission) => {
                touch_sticky_last_used(state, sticky_key, now);
                return Ok((bound_account, admission));
            }
            Err(AdmissionError::Cooldown(secs)) if secs <= 5 => {
                let wait_secs = if cache_protected {
                    secs.min(5).max(1)
                } else {
                    secs.min(3).max(1)
                };
                tokio::time::sleep(Duration::from_secs(wait_secs)).await;
                if let Ok(admission) = admit(state, bound_account) {
                    touch_sticky_last_used(state, sticky_key, store::now());
                    return Ok((bound_account, admission));
                }
            }
            Err(AdmissionError::Concurrency) => {
                let budget = if cache_protected {
                    Duration::from_millis(2000)
                } else {
                    Duration::from_millis(1000)
                };
                let deadline = tokio::time::Instant::now() + budget;
                let notify = state.runtime.lock().ok().map(|mut rt| {
                    rt.entry(bound_account.id.clone())
                        .or_default()
                        .slot_notify
                        .clone()
                });
                if let Some(notify) = notify {
                    loop {
                        let notified = notify.notified();
                        tokio::pin!(notified);
                        notified.as_mut().enable();
                        if let Ok(admission) = admit(state, bound_account) {
                            touch_sticky_last_used(state, sticky_key, store::now());
                            return Ok((bound_account, admission));
                        }
                        let Some(remaining) =
                            deadline.checked_duration_since(tokio::time::Instant::now())
                        else {
                            break;
                        };
                        if remaining.is_zero() {
                            break;
                        }
                        if tokio::time::timeout(remaining, notified).await.is_err() {
                            break;
                        }
                        if let Ok(admission) = admit(state, bound_account) {
                            touch_sticky_last_used(state, sticky_key, store::now());
                            return Ok((bound_account, admission));
                        }
                    }
                }
            }
            Err(AdmissionError::Rpm(secs)) if cache_protected && secs <= 5 => {
                tokio::time::sleep(Duration::from_secs(secs.max(1))).await;
                if let Ok(admission) = admit(state, bound_account) {
                    touch_sticky_last_used(state, sticky_key, store::now());
                    return Ok((bound_account, admission));
                }
            }
            Err(_) => {}
        }
    }
    let selected = select_account(state, accounts, tried)?;
    let binding = StickyBinding {
        account_id: selected.0.id.clone(),
        last_used_at: now,
        cached_tokens: 0,
        cache_written_at: 0,
    };
    if let Ok(mut bindings) = state.sticky_bindings.lock() {
        bindings.insert(sticky_key.to_owned(), binding.clone());
    }
    persist_sticky_affinity(state, sticky_key, &binding);
    Ok(selected)
}

fn body_has_cache_control(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            map.contains_key("cache_control") || map.values().any(body_has_cache_control)
        }
        Value::Array(arr) => arr.iter().any(body_has_cache_control),
        _ => false,
    }
}

fn apply_anthropic_cache_control_boost(body: &mut Value) -> bool {
    let Some(root) = body.as_object() else {
        return false;
    };
    if body_has_cache_control(body) {
        return false;
    }
    let _ = root;
    let ephemeral = json!({"type": "ephemeral"});
    let mut injected = false;

    if let Some(system) = body.get_mut("system") {
        match system {
            Value::String(text) if !text.trim().is_empty() => {
                let text = text.clone();
                *system = json!([{
                    "type": "text",
                    "text": text,
                    "cache_control": ephemeral
                }]);
                injected = true;
            }
            Value::Array(blocks) => {
                for block in blocks.iter_mut().rev() {
                    if let Some(obj) = block.as_object_mut() {
                        let non_empty = obj
                            .get("text")
                            .and_then(Value::as_str)
                            .is_none_or(|t| !t.trim().is_empty());
                        if non_empty && !obj.is_empty() {
                            obj.insert("cache_control".into(), ephemeral.clone());
                            injected = true;
                            break;
                        }
                    } else if let Some(text) = block.as_str()
                        && !text.trim().is_empty()
                    {
                        *block = json!({
                            "type": "text",
                            "text": text,
                            "cache_control": ephemeral
                        });
                        injected = true;
                        break;
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut)
        && let Some(last_tool) = tools.iter_mut().rev().find_map(Value::as_object_mut)
        && !last_tool.is_empty()
    {
        last_tool.insert("cache_control".into(), ephemeral.clone());
        injected = true;
    }

    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        'outer: for message in messages.iter_mut().rev() {
            let Some(content) = message.get_mut("content") else {
                continue;
            };
            match content {
                Value::String(text) if !text.trim().is_empty() => {
                    let text = text.clone();
                    *content = json!([{
                        "type": "text",
                        "text": text,
                        "cache_control": ephemeral
                    }]);
                    injected = true;
                    break 'outer;
                }
                Value::Array(blocks) => {
                    for block in blocks.iter_mut().rev() {
                        if let Some(obj) = block.as_object_mut() {
                            let non_empty = obj
                                .get("text")
                                .and_then(Value::as_str)
                                .is_none_or(|t| !t.trim().is_empty());
                            if non_empty && !obj.is_empty() {
                                obj.insert("cache_control".into(), ephemeral.clone());
                                injected = true;
                                break 'outer;
                            }
                        } else if let Some(text) = block.as_str()
                            && !text.trim().is_empty()
                        {
                            *block = json!({
                                "type": "text",
                                "text": text,
                                "cache_control": ephemeral
                            });
                            injected = true;
                            break 'outer;
                        }
                    }
                }
                _ => {}
            }
        }
    }

    injected
}

fn apply_openai_prompt_cache_boost(body: &mut Value, headers: &HeaderMap) -> bool {
    let Some(obj) = body.as_object_mut() else {
        return false;
    };
    if obj.contains_key("prompt_cache_key") {
        return false;
    }
    let session_id = header_value_ci(headers, "x-session-id");
    let thread_id = header_value_ci(headers, "x-thread-id");
    let claude_agent_id = header_value_ci(headers, "x-claude-code-agent-id");

    let session_part = session_id.as_deref().or(thread_id.as_deref());
    let agent_part = claude_agent_id.as_deref().or(thread_id.as_deref());
    let raw_key = match (session_part, agent_part) {
        (Some(s), Some(a)) if s != a => format!("{s}:{a}"),
        (Some(s), Some(a)) => format!("{s}:{a}"),
        (Some(s), None) => s.to_owned(),
        (None, Some(a)) => a.to_owned(),
        (None, None) => return false,
    };
    let cache_key = if raw_key.len() <= 64 {
        raw_key
    } else {
        store::digest(&raw_key)[..32].to_owned()
    };
    obj.insert("prompt_cache_key".into(), Value::String(cache_key));
    true
}

async fn select_account_for_group<'a>(
    state: &Shared,
    group: &Group,
    sticky_key: &str,
    accounts: &'a [Account],
    tried: &HashSet<String>,
) -> Result<(&'a Account, Admission), AdmissionError> {
    match group.routing_strategy.as_str() {
        "performance-first" => select_account_rr(state, &group.id, accounts, tried),
        "cache-first" => select_account_cache_first(state, sticky_key, accounts, tried).await,
        _ => select_account(state, accounts, tried),
    }
}

fn release_cooldowns_if_pool_blocked(
    state: &Shared,
    accounts: &[Account],
) -> Result<(), AdmissionError> {
    let mut runtime = state
        .runtime
        .lock()
        .map_err(|_| AdmissionError::Unavailable)?;
    let now = store::now();
    if accounts.len() == 1 {
        let account = runtime.entry(accounts[0].id.clone()).or_default();
        if account.cooldown_until != 0 {
            account.cooldown_until = 0;
            account.failures = 0;
        }
    } else if !accounts.is_empty()
        && accounts.iter().all(|account| {
            runtime
                .get(&account.id)
                .is_some_and(|status| status.cooldown_until > now)
        })
    {
        for account in accounts {
            let status = runtime.get_mut(&account.id).unwrap();
            status.cooldown_until = 0;
            status.failures = 0;
        }
    }
    Ok(())
}

fn admit(state: &Shared, account: &Account) -> Result<Admission, AdmissionError> {
    let mut runtime = state
        .runtime
        .lock()
        .map_err(|_| AdmissionError::Unavailable)?;
    let runtime = runtime.entry(account.id.clone()).or_default();
    let now = store::now();
    if runtime.cooldown_until > now {
        return Err(AdmissionError::Cooldown(
            (runtime.cooldown_until - now) as u64,
        ));
    }
    if runtime.cooldown_until != 0 {
        runtime.cooldown_until = 0;
        runtime.failures = 0;
    }
    if runtime.window != now / 60 {
        runtime.window = now / 60;
        runtime.requests = 0;
    }
    if account.rpm > 0 && runtime.requests >= account.rpm {
        return Err(AdmissionError::Rpm((60 - now.rem_euclid(60)) as u64));
    }
    if account.concurrency > 0 && runtime.active >= account.concurrency {
        return Err(AdmissionError::Concurrency);
    }
    runtime.active = runtime.active.saturating_add(1);
    runtime.requests = runtime.requests.saturating_add(1);
    Ok(Admission {
        state: state.clone(),
        account_id: account.id.clone(),
    })
}

fn health(
    state: &Shared,
    account_id: &str,
    settings: &Settings,
    success: bool,
    cooldown_enabled: bool,
) {
    if let Ok(mut runtime) = state.runtime.lock() {
        let runtime = runtime.entry(account_id.to_owned()).or_default();
        if success {
            runtime.failures = 0;
            runtime.cooldown_until = 0;
        } else {
            runtime.failures = runtime.failures.saturating_add(1);
            if cooldown_enabled && runtime.failures >= settings.failure_threshold.max(1) {
                runtime.cooldown_until = store::now() + i64::from(settings.cooldown_seconds);
            } else if !cooldown_enabled {
                runtime.cooldown_until = 0;
            }
        }
    }
}

fn health_with_policy(
    state: &Shared,
    account_id: &str,
    settings: &Settings,
    success: bool,
    cooldown_enabled: bool,
    smart_cooldown: bool,
    status: Option<StatusCode>,
    retry_after_header: Option<&str>,
) {
    if !smart_cooldown || success {
        health(state, account_id, settings, success, cooldown_enabled);
        return;
    }
    if let Ok(mut runtime) = state.runtime.lock() {
        let runtime = runtime.entry(account_id.to_owned()).or_default();
        runtime.failures = runtime.failures.saturating_add(1);
        if !cooldown_enabled {
            runtime.cooldown_until = 0;
            return;
        }
        let now = store::now();
        match status {
            Some(StatusCode::TOO_MANY_REQUESTS) => {
                let secs = retry_after_header
                    .and_then(|value| parse_retry_after_seconds(value, now))
                    .unwrap_or_else(|| u64::from(settings.cooldown_seconds).max(1));
                runtime.cooldown_until = now + secs as i64;
            }
            Some(s) if s.is_server_error() => {
                let exp = runtime.failures.saturating_sub(1).min(4);
                let secs = (10u64 << exp).min(120);
                runtime.cooldown_until = now + secs as i64;
            }
            Some(StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) => {
                let secs = u64::from(settings.cooldown_seconds).max(300);
                runtime.cooldown_until = now + secs as i64;
            }
            _ => {
                if runtime.failures >= settings.failure_threshold.max(1) {
                    runtime.cooldown_until = now + i64::from(settings.cooldown_seconds);
                }
            }
        }
    }
}

struct LogGuard {
    state: Shared,
    entry: RequestLog,
    started: Instant,
    finished: Option<Instant>,
    active_attempt_started: Option<Instant>,
    retention: u32,
    secrets: Vec<String>,
}
impl LogGuard {
    fn new(state: &Shared, key: &ApiKey, model: &str, protocol: &str, retention: u32) -> Self {
        Self {
            state: state.clone(),
            started: Instant::now(),
            finished: None,
            active_attempt_started: None,
            retention,
            secrets: Vec::new(),
            entry: RequestLog {
                id: store::id(),
                timestamp: store::now(),
                key_id: key.id.clone(),
                model: model.into(),
                protocol: protocol.into(),
                request_path: format!("/v1/{}", route_for(protocol)),
                status: 499,
                ..Default::default()
            },
        }
    }
    fn finish(&mut self) {
        self.finished.get_or_insert_with(Instant::now);
    }
    fn set_error(&mut self, message: &str) {
        self.entry.error = Some(error_summary(message, &self.secrets));
    }
}
impl Drop for LogGuard {
    fn drop(&mut self) {
        let end = self.finished.unwrap_or_else(Instant::now);
        self.entry.latency_ms = end
            .duration_since(self.started)
            .as_millis()
            .min(u128::from(u64::MAX)) as u64;
        if let Some(attempt_started) = self.active_attempt_started
            && let Some(last) = self.entry.attempt_details.last_mut()
            && last.outcome == "cancelled"
        {
            last.total_ms = end
                .saturating_duration_since(attempt_started)
                .as_millis()
                .min(u128::from(u64::MAX)) as u64;
        }
        if self.entry.status >= 400 && self.entry.error.is_none() {
            self.set_error(if self.entry.status == 499 {
                "Request cancelled before the upstream response completed"
            } else {
                "Upstream request failed without an error detail"
            });
        }
        if let Some(message) = &self.entry.error {
            self.entry.error = Some(error_summary(message, &self.secrets));
        }
        if let Err(error) = self.state.store.log(&self.entry, self.retention) {
            tracing::error!(request_id = %self.entry.id, %error, "Could not record proxy request");
        }
    }
}

fn effective_cache_settling_delay_ms(settings: &Settings) -> u32 {
    resolve_cache_settling_delay_ms(settings, |name| std::env::var(name).ok())
}

fn resolve_cache_settling_delay_ms(
    settings: &Settings,
    read_env: impl Fn(&str) -> Option<String>,
) -> u32 {
    [
        "ZAKO_CACHE_SETTLING_DELAY_MS",
        "ANTIGRAVITY_CACHE_SETTLING_DELAY_MS",
    ]
    .into_iter()
    .filter_map(read_env)
    .filter_map(|value| value.parse::<u32>().ok())
    .find(|delay| *delay <= store::MAX_CACHE_SETTLING_DELAY_MS)
    .unwrap_or(settings.cache_settling_delay_ms)
}

fn is_local_acp_8048_upstream(url: &str) -> bool {
    matches_acp_upstream(url, || std::env::var("ZAKO_ACP_UPSTREAM").ok())
}

fn matches_acp_upstream(url: &str, configured_base: impl FnOnce() -> Option<String>) -> bool {
    let Ok(target) = url::Url::parse(url) else {
        return false;
    };
    let loopback = match target.host() {
        Some(url::Host::Domain(host)) => host.trim_end_matches('.') == "localhost",
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if loopback && target.port() == Some(8048) {
        return true;
    }
    configured_base().is_some_and(|base| {
        let base = base.trim();
        let base = if base.contains("://") {
            url::Url::parse(base)
        } else {
            url::Url::parse(&format!("http://{base}"))
        };
        base.is_ok_and(|base| {
            base.host().is_some()
                && base.host() == target.host()
                && base.port_or_known_default() == target.port_or_known_default()
        })
    })
}

fn record_cache_settling_completion(
    state: &Shared,
    account_id: &str,
    sticky_key: &str,
    usage: &Usage,
) {
    let uncached_tokens = usage.input_tokens.saturating_sub(usage.cached_tokens);
    if uncached_tokens < HEAVY_COLD_PROMPT_TOKENS {
        return;
    }
    if let Ok(mut completed) = state.cache_settling_completed.lock() {
        let now = Instant::now();
        completed.retain(|_, completed_at| now.duration_since(*completed_at) <= CACHE_SETTLING_TTL);
        completed.insert(format!("{account_id}:{sticky_key}"), now);
    }
}

async fn await_cache_settling(
    state: &Shared,
    account_id: &str,
    sticky_key: &str,
    target_url: &str,
    delay_ms: u32,
) {
    if delay_ms == 0 || is_local_acp_8048_upstream(target_url) {
        return;
    }
    let remaining = {
        let key = format!("{account_id}:{sticky_key}");
        let delay = Duration::from_millis(u64::from(delay_ms));
        state
            .cache_settling_completed
            .lock()
            .ok()
            .and_then(|completed| delay.checked_sub(completed.get(&key)?.elapsed()))
    };
    if let Some(remaining) = remaining.filter(|duration| !duration.is_zero()) {
        tracing::debug!(
            account_id,
            remaining_ms = remaining.as_millis(),
            "Waiting for upstream KV cache to settle"
        );
        tokio::time::sleep(remaining).await;
    }
}

async fn forward(state: Shared, headers: HeaderMap, body: Value, protocol: &str) -> Response {
    forward_inner(state, headers, None, body, protocol, None, None).await
}

async fn forward_inner(
    state: Shared,
    headers: HeaderMap,
    uri: Option<Uri>,
    body: Value,
    protocol: &str,
    model_override: Option<String>,
    gemini_action: Option<String>,
) -> Response {
    let (config, key, group) = match authorize_with_uri(&state, &headers, uri.as_ref()) {
        Ok(value) => value,
        Err((status, message)) => return error(status, message),
    };
    // Routing belongs to the group; instruction selection belongs only to this key.
    let policy = Group {
        profile_ids: key.profile_ids.clone(),
        default_strategy_enabled: key.default_strategy_enabled,
        ..Default::default()
    };
    let model = model_override.unwrap_or_else(|| {
        body.get("model")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    });
    let mut log = LogGuard::new(
        &state,
        &key,
        &model,
        protocol,
        config.settings.retention_days,
    );
    for name in ["authorization", "x-api-key", "x-goog-api-key"] {
        if let Some(value) = headers.get(name).and_then(|value| value.to_str().ok()) {
            let value = if name == "authorization" {
                value
                    .split_once(' ')
                    .map(|(_, token)| token)
                    .unwrap_or(value)
            } else {
                value
            };
            log.secrets.push(value.to_owned());
        }
    }
    if !body.is_object() || model.is_empty() {
        log.entry.status = 400;
        log.set_error("A JSON object with a nonempty model is required");
        return error(
            StatusCode::BAD_REQUEST,
            "A JSON object with a nonempty model is required",
        );
    }
    let mut accounts: Vec<_> = config
        .accounts
        .iter()
        .filter(|account| {
            account.enabled
                && account.provider_available()
                && account.group_ids.contains(&group.id)
                && account.protocols.iter().any(|item| item == protocol)
                && account.actual_model(&model).is_some()
        })
        .cloned()
        .collect();
    accounts.sort_by(|a, b| a.priority.cmp(&b.priority).then_with(|| a.id.cmp(&b.id)));
    if accounts.is_empty() {
        log.entry.status = 503;
        log.set_error("No account supports this group, model, and protocol");
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "No account supports this group, model, and protocol",
        );
    }
    let cooldown_enabled = accounts.len() > 1;
    let sticky_key = build_sticky_key(&group.id, &key.id, &model, &headers, &body);
    let mut tried = HashSet::new();
    let mut reserved = None;
    let attempts = config.settings.max_retries.saturating_add(1);
    let cache_settling_delay_ms = effective_cache_settling_delay_ms(&config.settings);
    for _ in 0..attempts {
        let selected = match reserved.take() {
            Some(selected) => Ok(selected),
            None => {
                select_account_for_group(&state, &group, &sticky_key, &accounts, &tried).await
            }
        };
        let (account, admission) = match selected {
            Ok(selected) => selected,
            Err(reason) => {
                let mut response = reason.response();
                log.entry.status = response.status().as_u16();
                if !matches!(reason, AdmissionError::Exhausted) || log.entry.error.is_none() {
                    log.set_error(match reason {
                        AdmissionError::Cooldown(_) => {
                            "Upstream accounts are temporarily cooling down after failures"
                        }
                        AdmissionError::Concurrency => "Account concurrency limit reached",
                        AdmissionError::Rpm(_) => "Account requests-per-minute limit reached",
                        AdmissionError::Unavailable => {
                            "Account admission is temporarily unavailable"
                        }
                        AdmissionError::Exhausted => {
                            "Upstream request failed; no untried account is available"
                        }
                    });
                }
                response.headers_mut().insert(
                    "x-request-id",
                    HeaderValue::from_str(&log.entry.id).unwrap(),
                );
                return response;
            }
        };
        let actual_model = account.actual_model(&model).unwrap();
        // Rebuild each attempt from the original request: account mappings can differ on failover.
        let mut upstream_body = body.clone();
        if protocol != "gemini" {
            upstream_body["model"] = json!(actual_model);
        }
        apply_sensitive_filter(&mut upstream_body, &config.settings);
        let resolved_instruction =
            resolve_instruction_with_settings(&policy, &group, actual_model, &config.settings);
        let instruction_str = resolved_instruction.as_deref();
        let instruction_result = match protocol {
            "anthropic" => apply_system_text(&mut upstream_body, instruction_str),
            "chat" => apply_chat_instruction_text(&mut upstream_body, instruction_str),
            "gemini" => apply_gemini_instruction(&mut upstream_body, instruction_str, &group),
            _ => apply_instruction_text(&mut upstream_body, instruction_str),
        };
        if let Err(message) = instruction_result {
            log.entry.status = 400;
            log.set_error(message);
            return error(StatusCode::BAD_REQUEST, message);
        }
        if protocol == "anthropic" {
            apply_anthropic_cache_control_boost(&mut upstream_body);
        } else if matches!(protocol, "chat" | "responses") {
            apply_openai_prompt_cache_boost(&mut upstream_body, &headers);
        }
        tried.insert(account.id.clone());
        log.entry.attempts += 1;
        log.entry.account_id = account.id.clone();
        log.entry.status = 499;
        log.entry.error = None;
        let attempt_started = Instant::now();
        let mut attempt = RequestAttempt {
            index: log.entry.attempts,
            account_id: account.id.clone(),
            model: actual_model.to_owned(),
            outcome: "cancelled".into(),
            ..Default::default()
        };
        let smart_cooldown = group.smart_cooldown_enabled;
        let staged_timeout = group.staged_timeout_enabled;
        let request_timeout = Duration::from_secs(u64::from(
            config.settings.request_timeout_seconds.max(1),
        ));
        let url_res = if protocol == "gemini" {
            let action = gemini_action.as_deref().unwrap_or("generateContent");
            let query = uri.as_ref().and_then(|u| u.query());
            gemini_upstream_url(&account.endpoint, actual_model, action, query)
        } else {
            upstream_url(&account.endpoint, route_for(protocol))
        };
        let url = match url_res {
            Ok(url) => url,
            Err(_) => {
                log.entry.status = 502;
                log.set_error("Invalid upstream endpoint configuration");
                attempt.outcome = "failed".into();
                attempt.error_stage = Some("connect".into());
                attempt.error = log.entry.error.clone();
                attempt.total_ms = elapsed_ms(attempt_started);
                log.entry.attempt_details.push(attempt);
                health_with_policy(
                    &state,
                    &account.id,
                    &config.settings,
                    false,
                    cooldown_enabled,
                    smart_cooldown,
                    None,
                    None,
                );
                continue;
            }
        };
        let secret = match state.store.unseal(&account.api_key) {
            Ok(secret) => secret,
            Err(_) => {
                log.entry.status = 502;
                log.set_error("Could not decrypt the upstream API key");
                attempt.outcome = "failed".into();
                attempt.error_stage = Some("connect".into());
                attempt.error = log.entry.error.clone();
                attempt.total_ms = elapsed_ms(attempt_started);
                log.entry.attempt_details.push(attempt);
                health_with_policy(
                    &state,
                    &account.id,
                    &config.settings,
                    false,
                    cooldown_enabled,
                    smart_cooldown,
                    None,
                    None,
                );
                continue;
            }
        };
        log.secrets.push(secret.clone());
        let client = match crate::network::account_client(&state, account) {
            Ok(client) => client,
            Err(_) => {
                log.entry.status = 502;
                log.set_error("Could not configure the upstream network client");
                attempt.outcome = "failed".into();
                attempt.error_stage = Some("connect".into());
                attempt.error = log.entry.error.clone();
                attempt.total_ms = elapsed_ms(attempt_started);
                log.entry.attempt_details.push(attempt);
                health_with_policy(
                    &state,
                    &account.id,
                    &config.settings,
                    false,
                    cooldown_enabled,
                    smart_cooldown,
                    None,
                    None,
                );
                continue;
            }
        };
        let mut request = client.post(url.clone()).json(&upstream_body);
        if !staged_timeout {
            request = request.timeout(request_timeout);
        }
        request = if protocol == "anthropic" {
            let mut r = request.header(
                "anthropic-version",
                headers
                    .get("anthropic-version")
                    .cloned()
                    .unwrap_or_else(|| HeaderValue::from_static("2023-06-01")),
            );
            if !secret.is_empty() {
                r = r.header("x-api-key", &secret);
            }
            r
        } else if protocol == "gemini" {
            if !secret.is_empty() {
                request.header("x-goog-api-key", &secret)
            } else {
                request
            }
        } else if !secret.is_empty() {
            request.bearer_auth(&secret)
        } else {
            request
        };
        if protocol == "anthropic"
            && let Some(value) = headers.get("anthropic-beta")
        {
            request = request.header("anthropic-beta", value);
        }
        for name in [
            "accept",
            "openai-beta",
            "idempotency-key",
            "x-client-request-id",
            "x-session-id",
            "x-thread-id",
            "x-claude-code-agent-id",
        ] {
            if let Some(value) = headers.get(name) {
                request = request.header(name, value);
            }
        }
        await_cache_settling(
            &state,
            &account.id,
            &sticky_key,
            url.as_str(),
            cache_settling_delay_ms,
        )
        .await;
        let send_started = Instant::now();
        let upstream_result = if staged_timeout {
            match tokio::time::timeout(request_timeout, request.send()).await {
                Ok(res) => res.map_err(|cause| (cause.is_timeout(), cause.is_connect())),
                Err(_) => Err((true, false)),
            }
        } else {
            request
                .send()
                .await
                .map_err(|cause| (cause.is_timeout(), cause.is_connect()))
        };
        let upstream = match upstream_result {
            Ok(response) => response,
            Err((is_timeout, is_connect)) => {
                log.entry.status = 502;
                log.set_error(if is_timeout {
                    "Upstream request timed out before response headers"
                } else if is_connect {
                    "Could not connect to the upstream server"
                } else {
                    "Upstream request transport failed before response headers"
                });
                attempt.outcome = "failed".into();
                attempt.error_stage = Some(if is_connect { "connect" } else { "headers" }.into());
                attempt.error = log.entry.error.clone();
                attempt.total_ms = elapsed_ms(attempt_started);
                log.entry.attempt_details.push(attempt);
                health_with_policy(
                    &state,
                    &account.id,
                    &config.settings,
                    false,
                    cooldown_enabled,
                    smart_cooldown,
                    None,
                    None,
                );
                continue;
            }
        };
        let headers_received_at = Instant::now();
        let status = upstream.status();
        let retry_after_header = upstream
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        attempt.headers_ms = Some(elapsed_ms(send_started));
        attempt.upstream_status = Some(status.as_u16());
        let retryable = matches!(
            status,
            StatusCode::UNAUTHORIZED
                | StatusCode::FORBIDDEN
                | StatusCode::REQUEST_TIMEOUT
                | StatusCode::TOO_MANY_REQUESTS
        ) || status.is_server_error();
        if retryable {
            health_with_policy(
                &state,
                &account.id,
                &config.settings,
                false,
                cooldown_enabled,
                smart_cooldown,
                Some(status),
                retry_after_header.as_deref(),
            );
            if log.entry.attempts < attempts {
                reserved =
                    select_account_for_group(&state, &group, &sticky_key, &accounts, &tried)
                        .await
                        .ok();
                if reserved.is_some() {
                    attempt.outcome = "failed".into();
                    attempt.error_stage = Some("http_status".into());
                    attempt.error = Some(format!(
                        "Upstream HTTP {} {}",
                        status.as_u16(),
                        status.canonical_reason().unwrap_or("error")
                    ));
                    attempt.total_ms = elapsed_ms(attempt_started);
                    log.entry.attempt_details.push(attempt);
                    continue;
                }
            }
        }
        let mut response_headers = HeaderMap::new();
        if !status.is_success() {
            response_headers.insert("x-zako-error-source", HeaderValue::from_static("upstream"));
        }
        for name in ["content-type", "x-request-id", "request-id", "retry-after"] {
            if let Some(value) = upstream.headers().get(name) {
                // An upstream must not reflect its credential through response headers.
                if secret.is_empty()
                    || !value
                        .as_bytes()
                        .windows(secret.len())
                        .any(|part| part == secret.as_bytes())
                {
                    response_headers.insert(name, value.clone());
                }
            }
        }
        if !response_headers.contains_key("x-request-id")
            && let Ok(request_id) = HeaderValue::from_str(&log.entry.id)
        {
            response_headers.insert("x-request-id", request_id);
        }
        let sse = upstream
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.to_ascii_lowercase().starts_with("text/event-stream"));
        let settings = config.settings.clone();
        let account_id = account.id.clone();
        let stream_state = state.clone();
        let stream_sticky_key = sticky_key.clone();
        let cache_first_routing = group.routing_strategy == "cache-first";
        let skip_cache_settling = is_local_acp_8048_upstream(url.as_str());
        log.entry.status = 499;
        let is_chat = protocol == "chat";
        let is_gemini = protocol == "gemini";
        let chat_choices =
            is_chat.then(|| body.get("n").and_then(Value::as_u64).unwrap_or(1).max(1));
        let sse_keepalive = group.sse_keepalive_enabled && sse;
        log.entry.attempt_details.push(attempt);
        let attempt_idx = log.entry.attempt_details.len() - 1;
        log.active_attempt_started = Some(attempt_started);
        let output = async_stream::stream! {
            let mut admission = Some(admission);
            let mut log = log;
            let mut observer = Observer::new(sse, chat_choices);
            observer.secrets = log.secrets.clone();
            observer.http_error = !status.is_success();
            let mut redactor = SecretFilter::new(secret);
            let mut stream = upstream.bytes_stream();
            let mut transport_failed = false;
            let mut health_recorded = None;
            let mut sticky_settled = false;
            let mut cache_completion_observed = false;
            let mut first_byte_seen = false;
            let mut keepalive = if sse_keepalive {
                let interval_dur = sse_keepalive_interval();
                let mut iv = tokio::time::interval_at(
                    tokio::time::Instant::now() + interval_dur,
                    interval_dur,
                );
                iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                Some(iv)
            } else {
                None
            };
            let idle_sleep = tokio::time::sleep(request_timeout);
            tokio::pin!(idle_sleep);
            loop {
                let next_chunk = if staged_timeout || sse_keepalive {
                    tokio::select! {
                        chunk = stream.next() => Some(chunk),
                        _ = async {
                            if let Some(iv) = keepalive.as_mut() {
                                iv.tick().await;
                            } else {
                                std::future::pending::<()>().await;
                            }
                        }, if keepalive.is_some() => {
                            yield Ok::<Bytes, std::io::Error>(Bytes::from_static(b": keepalive\n\n"));
                            continue;
                        }
                        _ = &mut idle_sleep, if staged_timeout => {
                            transport_failed = true;
                            if !(sse && (observer.completed || observer.failed)) {
                                log.set_error("Upstream response timed out");
                            }
                            break;
                        }
                    }
                } else {
                    Some(stream.next().await)
                };
                let Some(Some(chunk)) = next_chunk else {
                    break;
                };
                match chunk {
                    Ok(chunk) => {
                        if staged_timeout {
                            idle_sleep.as_mut().reset(tokio::time::Instant::now() + request_timeout);
                        }
                        if let Some(iv) = keepalive.as_mut() {
                            iv.reset();
                        }
                        if !first_byte_seen && !chunk.is_empty() {
                            first_byte_seen = true;
                            if let Some(detail) = log.entry.attempt_details.get_mut(attempt_idx) {
                                detail.first_byte_ms = Some(elapsed_ms(headers_received_at));
                            }
                        }
                        observer.feed(&chunk);
                        log.entry.usage = observer.usage.clone();
                        log.entry.cyber = observer.cyber;
                        if observer.content_seen && log.entry.first_token_ms.is_none() {
                            log.entry.first_token_ms = Some(log.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64);
                        }
                        if let Some(message) = &observer.error {
                            log.set_error(message);
                        }
                        if status.is_success() && (observer.completed || observer.failed) {
                            log.entry.status = if observer.failed { 502 } else { status.as_u16() };
                            let healthy = !observer.failed;
                            if health_recorded.is_none() || (health_recorded == Some(true) && !healthy) {
                                health_with_policy(
                                    &stream_state,
                                    &account_id,
                                    &settings,
                                    healthy,
                                    cooldown_enabled,
                                    smart_cooldown,
                                    Some(status),
                                    retry_after_header.as_deref(),
                                );
                                health_recorded = Some(healthy);
                            }
                            if cache_first_routing && healthy && !sticky_settled {
                                settle_sticky_cache_binding(
                                    &stream_state,
                                    &stream_sticky_key,
                                    &account_id,
                                    &log.entry.usage,
                                    true,
                                );
                                sticky_settled = true;
                            }
                        }
                        // Chat may send its usage after the last choice finishes.
                        if !skip_cache_settling && !cache_completion_observed && status.is_success()
                            && !observer.failed && observer.completed
                            && (!is_chat || observer.saw_done)
                        {
                            record_cache_settling_completion(&stream_state, &account_id, &stream_sticky_key, &observer.usage);
                            cache_completion_observed = true;
                        }
                        if observer.completed || observer.failed {
                            // A terminal protocol event ends model work even if the relay keeps HTTP open.
                            if !status.is_success() {
                                log.entry.status = status.as_u16();
                            }
                            log.finish();
                            admission.take();
                        }
                        let chunk = redactor.feed(&chunk);
                        if !chunk.is_empty() { yield Ok::<Bytes, std::io::Error>(chunk); }
                    }
                    Err(cause) => {
                        transport_failed = true;
                        if !(sse && (observer.completed || observer.failed)) {
                            log.set_error(if cause.is_timeout() { "Upstream response timed out" } else { "Upstream response transport failed" });
                        }
                        break;
                    }
                }
            }
            observer.finish();
            let response_read_failed = transport_failed;
            if is_gemini && sse && !response_read_failed && observer.gemini_finished {
                observer.completed = true;
            }
            log.finish();
            if observer.content_seen && log.entry.first_token_ms.is_none() {
                log.entry.first_token_ms = Some(log.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64);
            }
            if let Some(message) = &observer.error {
                log.set_error(message);
            }
            log.entry.usage = observer.usage;
            log.entry.cyber = observer.cyber;
            let transport_failed = transport_failed && !(sse && (observer.completed || observer.failed));
            let incomplete = sse && status.is_success() && !observer.completed && !observer.failed;
            log.entry.status = if transport_failed || incomplete || (status.is_success() && observer.failed) { 502 } else { status.as_u16() };
            if incomplete {
                log.set_error("Upstream event stream ended before a terminal event");
            } else if observer.failed && log.entry.error.is_none() {
                log.set_error("Upstream reported a failed response without an error detail");
            } else if !status.is_success() && log.entry.error.is_none() {
                log.set_error(&format!("Upstream HTTP {} {}", status.as_u16(), status.canonical_reason().unwrap_or("error")));
            }
            let healthy = log.entry.status < 400;
            if let Some(detail) = log.entry.attempt_details.get_mut(attempt_idx) {
                let end = log.finished.unwrap_or_else(Instant::now);
                detail.total_ms = end
                    .saturating_duration_since(attempt_started)
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64;
                if healthy {
                    detail.outcome = "success".into();
                    detail.error_stage = None;
                    detail.error = None;
                } else {
                    detail.outcome = "failed".into();
                    detail.error_stage = Some(if !status.is_success() {
                        "http_status"
                    } else {
                        "stream"
                    }.into());
                    detail.error = log.entry.error.clone();
                }
            }
            log.active_attempt_started = None;
            if !skip_cache_settling && !cache_completion_observed && status.is_success()
                && !observer.failed && !response_read_failed && !incomplete
            {
                record_cache_settling_completion(&stream_state, &account_id, &stream_sticky_key, &log.entry.usage);
            }
            if status.is_success() && (health_recorded.is_none() || (health_recorded == Some(true) && !healthy)) {
                health_with_policy(
                    &stream_state,
                    &account_id,
                    &settings,
                    healthy,
                    cooldown_enabled,
                    smart_cooldown,
                    Some(status),
                    retry_after_header.as_deref(),
                );
            }
            if cache_first_routing && healthy && !sticky_settled {
                settle_sticky_cache_binding(
                    &stream_state,
                    &stream_sticky_key,
                    &account_id,
                    &log.entry.usage,
                    true,
                );
            }
            admission.take();
            let tail = redactor.finish();
            if !tail.is_empty() { yield Ok(tail); }
            if transport_failed || incomplete {
                yield Err(std::io::Error::other("Upstream response ended before completion"));
            }
        };
        let mut response = Response::new(Body::from_stream(output));
        *response.status_mut() = status;
        *response.headers_mut() = response_headers;
        return response;
    }
    log.entry.status = 502;
    if log.entry.error.is_none() {
        log.set_error("Upstream request failed; no successful account attempt");
    }
    error(StatusCode::BAD_GATEWAY, "Upstream request failed")
}

fn has_content_delta(value: &Value, event_name: &str) -> bool {
    let nonempty = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty())
    };
    match value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or(event_name)
    {
        "response.output_text.delta"
        | "response.reasoning_text.delta"
        | "response.reasoning_summary_text.delta"
        | "response.function_call_arguments.delta"
        | "response.refusal.delta" => {
            return nonempty(value.get("delta"));
        }
        "content_block_delta" => {
            let delta = value.get("delta");
            return ["text", "thinking", "partial_json"]
                .iter()
                .any(|key| nonempty(delta.and_then(|delta| delta.get(*key))));
        }
        _ => {}
    }
    value
        .get("choices")
        .and_then(Value::as_array)
        .is_some_and(|choices| {
            choices.iter().any(|choice| {
                let Some(delta) = choice.get("delta") else {
                    return false;
                };
                if ["content", "reasoning", "reasoning_content", "refusal"]
                    .iter()
                    .any(|key| nonempty(delta.get(*key)))
                {
                    return true;
                }
                if delta
                    .get("content")
                    .and_then(Value::as_array)
                    .is_some_and(|blocks| blocks.iter().any(|block| nonempty(block.get("text"))))
                {
                    return true;
                }
                let function_has_content = |function: &Value| {
                    nonempty(function.get("name")) || nonempty(function.get("arguments"))
                };
                delta.get("function_call").is_some_and(function_has_content)
                    || delta
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .is_some_and(|tools| {
                            tools
                                .iter()
                                .any(|tool| tool.get("function").is_some_and(function_has_content))
                        })
            })
        })
}

// Retain only explicit error fields, never the whole request or successful response body.
fn response_error(value: &Value, event_name: &str, http_error: bool) -> Option<String> {
    let response = value.get("response").unwrap_or(value);
    let error = value
        .get("error")
        .filter(|error| !error.is_null())
        .or_else(|| response.get("error").filter(|error| !error.is_null()))
        .or_else(|| {
            (http_error
                || event_name == "error"
                || value.get("type").and_then(Value::as_str) == Some("error"))
            .then_some(value)
        })?;
    if let Some(message) = error.as_str().filter(|message| !message.trim().is_empty()) {
        return Some(message.to_owned());
    }
    let scalar = |key: &str| {
        error.get(key).and_then(|value| match value {
            Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
    };
    let code = scalar("code").or_else(|| scalar("type"));
    let message = scalar("message");
    match (code, message) {
        (Some(code), Some(message)) => Some(format!("{code}: {message}")),
        (Some(code), None) => Some(code),
        (None, message) => message,
    }
}

// Keep bounded parser buffers and per-channel marker state, never response content in logs.
struct Observer {
    sse: bool,
    line: Vec<u8>,
    event_name: String,
    data: Vec<u8>,
    oversized: bool,
    discard_line: bool,
    json: Vec<u8>,
    json_oversized: bool,
    marker: cyber::CyberDetector,
    cyber: bool,
    usage: Usage,
    completed: bool,
    saw_done: bool,
    gemini_finished: bool,
    failed: bool,
    content_seen: bool,
    error: Option<String>,
    secrets: Vec<String>,
    http_error: bool,
    chat_choices: Option<u64>,
    finished_choices: BTreeSet<u64>,
}
impl Observer {
    fn new(sse: bool, chat_choices: Option<u64>) -> Self {
        Self {
            sse,
            line: Vec::new(),
            event_name: String::new(),
            data: Vec::new(),
            oversized: false,
            discard_line: false,
            json: Vec::new(),
            json_oversized: false,
            marker: cyber::CyberDetector::default(),
            cyber: false,
            usage: Usage::default(),
            completed: false,
            saw_done: false,
            gemini_finished: false,
            failed: false,
            content_seen: false,
            error: None,
            secrets: Vec::new(),
            http_error: false,
            // Larger requests still use [DONE]; avoid unbounded state from arbitrary n values.
            chat_choices: chat_choices.filter(|expected| *expected <= MAX_TRACKED_CHAT_CHOICES),
            finished_choices: BTreeSet::new(),
        }
    }
    fn feed(&mut self, bytes: &[u8]) {
        if !self.sse {
            if !self.json_oversized && self.json.len().saturating_add(bytes.len()) <= MAX_JSON_BYTES
            {
                self.json.extend_from_slice(bytes);
            } else {
                self.json.clear();
                self.json_oversized = true;
            }
            return;
        }
        for byte in bytes {
            if *byte == b'\n' {
                if self.discard_line {
                    self.line.clear();
                    self.discard_line = false;
                } else {
                    self.line();
                }
            } else if !self.discard_line {
                if self.line.len() < MAX_EVENT_BYTES {
                    self.line.push(*byte);
                } else {
                    self.line.clear();
                    self.discard_line = true;
                    self.oversized = true;
                }
            }
        }
    }
    fn line(&mut self) {
        let line = std::mem::take(&mut self.line);
        let line = line.strip_suffix(b"\r").unwrap_or(&line);
        if line.is_empty() {
            match self.event_name.as_str() {
                "response.completed" | "message_stop" => self.completed = true,
                "response.failed" | "error" => self.failed = true,
                _ => {}
            }
            let event_name = std::mem::take(&mut self.event_name);
            if !self.oversized {
                let data = std::mem::take(&mut self.data);
                self.event(&data, &event_name);
            } else if event_name == "response.incomplete" {
                self.failed = true;
            }
            self.data.clear();
            self.oversized = false;
        } else if let Some(name) = line.strip_prefix(b"event:") {
            if name.len() < 128 {
                self.event_name = String::from_utf8_lossy(name).trim().to_owned();
            }
        } else if let Some(data) = line.strip_prefix(b"data:") {
            let data = data.strip_prefix(b" ").unwrap_or(data);
            if self.data.len().saturating_add(data.len()).saturating_add(1) <= MAX_EVENT_BYTES {
                self.data.extend_from_slice(data);
                self.data.push(b'\n');
            } else {
                self.data.clear();
                self.oversized = true;
            }
        }
    }
    fn event(&mut self, data: &[u8], event_name: &str) {
        if data.trim_ascii() == b"[DONE]" {
            self.saw_done = true;
            self.completed = true;
            return;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(data) {
            if !self.cyber && !self.http_error {
                self.cyber = self.marker.observe(&value, event_name, self.sse);
            }
            let usage = store::usage(&value);
            self.usage.input_tokens = self.usage.input_tokens.max(usage.input_tokens);
            self.usage.output_tokens = self.usage.output_tokens.max(usage.output_tokens);
            self.usage.cached_tokens = self.usage.cached_tokens.max(usage.cached_tokens);
            self.usage.cache_creation_input_tokens = self
                .usage
                .cache_creation_input_tokens
                .max(usage.cache_creation_input_tokens);
            self.usage.cache_read_input_tokens = self
                .usage
                .cache_read_input_tokens
                .max(usage.cache_read_input_tokens);
            if self.sse && has_content_delta(&value, event_name) {
                self.content_seen = true;
            }
            if let Some(message) = response_error(&value, event_name, self.http_error) {
                self.error = Some(error_summary(&message, &self.secrets));
            }
            match value.get("type").and_then(Value::as_str) {
                Some("response.completed" | "message_stop") => self.completed = true,
                Some("response.failed" | "error") => self.failed = true,
                _ => {}
            }
            let response = value.get("response").unwrap_or(&value);
            if let Some(candidates) = response.get("candidates").and_then(Value::as_array) {
                self.gemini_finished |= candidates.iter().any(|candidate| {
                    candidate["finishReason"]
                        .as_str()
                        .is_some_and(|reason| !matches!(reason, "" | "FINISH_REASON_UNSPECIFIED"))
                });
            }
            let incomplete = event_name == "response.incomplete"
                || value.get("type").and_then(Value::as_str) == Some("response.incomplete")
                || response.get("status").and_then(Value::as_str) == Some("incomplete");
            if incomplete {
                // Token limits and filtering terminate this response, not the account's health.
                if matches!(
                    response
                        .pointer("/incomplete_details/reason")
                        .and_then(Value::as_str),
                    Some("max_output_tokens" | "content_filter")
                ) {
                    self.completed = true;
                } else {
                    self.failed = true;
                }
            }
            if value.get("error").is_some_and(|error| !error.is_null())
                || response.get("error").is_some_and(|error| !error.is_null())
                || response.get("status").and_then(Value::as_str) == Some("failed")
            {
                self.failed = true;
            }
            if let Some(expected) = self.chat_choices
                && let Some(choices) = value.get("choices").and_then(Value::as_array)
            {
                for choice in choices {
                    if let Some(index) = choice.get("index").and_then(Value::as_u64)
                        && index < expected
                        && choice
                            .get("finish_reason")
                            .and_then(Value::as_str)
                            .is_some_and(|reason| !reason.is_empty())
                    {
                        self.finished_choices.insert(index);
                    }
                }
                if self.finished_choices.len() as u64 == expected {
                    self.completed = true;
                }
            }
        } else if event_name == "response.incomplete" {
            // A malformed terminal event must not hold a concurrency slot indefinitely.
            self.failed = true;
        }
    }
    fn finish(&mut self) {
        if self.sse {
            if !self.line.is_empty() && !self.discard_line {
                self.line();
            }
            if !self.oversized {
                let data = std::mem::take(&mut self.data);
                let event_name = std::mem::take(&mut self.event_name);
                self.event(&data, &event_name);
            }
        } else if !self.json_oversized {
            let data = std::mem::take(&mut self.json);
            self.event(&data, "");
        }
    }
}

#[cfg(test)]
#[path = "proxy/cyber_tests.rs"]
mod cyber_tests;

// A rolling suffix prevents credentials split between network chunks from leaking.
struct SecretFilter {
    secret: Vec<u8>,
    pending: Vec<u8>,
}
impl SecretFilter {
    fn new(secret: String) -> Self {
        Self {
            secret: secret.into_bytes(),
            pending: Vec::new(),
        }
    }
    fn feed(&mut self, bytes: &[u8]) -> Bytes {
        if self.secret.is_empty() {
            return Bytes::copy_from_slice(bytes);
        }
        self.pending.extend_from_slice(bytes);
        let mut output = Vec::new();
        let mut index = 0;
        while index < self.pending.len() {
            let remaining = &self.pending[index..];
            if remaining.starts_with(&self.secret) {
                output.extend_from_slice(b"[redacted]");
                index += self.secret.len();
            } else if self.secret.starts_with(remaining) {
                // Retain only a suffix that could actually be a split credential.
                break;
            } else {
                output.push(self.pending[index]);
                index += 1;
            }
        }
        self.pending.drain(..index);
        Bytes::from(output)
    }
    fn finish(&mut self) -> Bytes {
        Bytes::from(std::mem::take(&mut self.pending))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;
    #[test]
    fn endpoint_normalization_and_validation() {
        assert_eq!(
            upstream_url("https://example.com", "responses")
                .unwrap()
                .as_str(),
            "https://example.com/v1/responses"
        );
        assert_eq!(
            upstream_url("https://example.com/v1/", "responses/compact")
                .unwrap()
                .as_str(),
            "https://example.com/v1/responses/compact"
        );
        assert_eq!(
            upstream_url("http://localhost:1999/proxy", "/v1/models")
                .unwrap()
                .as_str(),
            "http://localhost:1999/proxy/v1/models"
        );
        for invalid in [
            "file:///etc/passwd",
            "https://user:pass@example.com",
            "https://example.com?token=x",
            "https://example.com/#x",
        ] {
            assert!(upstream_url(invalid, "models").is_err());
        }
    }
    #[test]
    fn instruction_changes_only_when_non_empty_and_preserves_fields() {
        let original = json!({"model":"other","instructions":"Existing","input":[{"role":"user","content":"hello"}],"tools":[{"type":"function"}],"store":false});
        let mut body = original.clone();
        apply_instruction_text(&mut body, None).unwrap();
        assert_eq!(body, original);
        apply_instruction_text(&mut body, Some("")).unwrap();
        assert_eq!(body, original);
        apply_instruction_text(&mut body, Some("   ")).unwrap();
        assert_eq!(body, original);
        apply_instruction_text(&mut body, Some("Custom system prompt")).unwrap();
        assert_eq!(body["instructions"], "Custom system prompt\n\nExisting");
        assert_eq!(body["input"], original["input"]);
        assert_eq!(body["tools"], original["tools"]);
        assert_eq!(body["store"], original["store"]);
        assert!(
            apply_instruction_text(&mut json!({"instructions":[]}), Some("Custom system prompt"))
                .is_err()
        );
    }
    #[test]
    fn empty_builtin_profiles_leave_payload_untouched() {
        let group = Group {
            profile_ids: vec!["non-existent".into()],
            default_strategy_enabled: true,
            ..Default::default()
        };
        for model in ["gpt-5.6-sol", "gpt-6-astra", "gpt-6.1-sol", "unknown"] {
            let original = json!({"model":model,"instructions":"Existing instructions","input":[{"role":"user","content":"hello"}]});
            let mut body = original.clone();
            apply_instruction(&mut body, &group, model).unwrap();
            assert_eq!(body, original);
        }
        let legacy_custom: Group = serde_json::from_value(json!({
            "name":"Custom", "models":["gpt-6.1-sol"],
            "instruction":"Old custom text must not bypass the unchecked model"
        }))
        .unwrap();
        let mut unchecked = json!({"instructions":"Existing"});
        apply_instruction(&mut unchecked, &legacy_custom, "gpt-6.1-sol").unwrap();
        assert_eq!(unchecked["instructions"], "Existing");
    }
    #[test]
    fn first_token_ignores_metadata_and_detects_content_across_chunks() {
        let metadata = b"data: {\"type\":\"response.created\"}\n\ndata: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\ndata: {\"usage\":{\"output_tokens\":4}}\n\n: heartbeat\n\n";
        for content in [
            json!({"type":"response.output_text.delta","delta":"hello"}),
            json!({"type":"response.reasoning_text.delta","delta":"think"}),
            json!({"type":"response.reasoning_summary_text.delta","delta":"think"}),
            json!({"type":"response.function_call_arguments.delta","delta":"{}"}),
            json!({"choices":[{"delta":{"content":"hello"}}]}),
            json!({"choices":[{"delta":{"reasoning_content":"think"}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{}"}}]}}]}),
            json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}),
            json!({"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"think"}}),
            json!({"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}),
        ] {
            let content = format!("data: {content}\n\n");
            for split in 0..=content.len() {
                let mut observer = Observer::new(true, None);
                observer.feed(metadata);
                assert!(!observer.content_seen);
                observer.feed(&content.as_bytes()[..split]);
                observer.feed(&content.as_bytes()[split..]);
                assert!(observer.content_seen, "{content} at {split}");
            }
        }
        for empty in [
            json!({"type":"response.output_text.delta","delta":""}),
            json!({"choices":[{"delta":{"role":"assistant","content":""}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","type":"function"}]}}]}),
            json!({"type":"content_block_delta","delta":{"type":"signature_delta","signature":"signature"}}),
        ] {
            assert!(!has_content_delta(&empty, ""));
        }
    }

    #[test]
    fn cache_usage_merges_across_anthropic_message_events() {
        let mut observer = Observer::new(true, None);
        observer.feed(b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":40,\"cache_read_input_tokens\":20}}}\n\n");
        observer.feed(b"data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n\n");
        observer.feed(b"data: {\"type\":\"message_stop\"}\n\n");
        assert_eq!(observer.usage.input_tokens, 70);
        assert_eq!(observer.usage.output_tokens, 7);
        assert_eq!(observer.usage.cached_tokens, 20);
        assert_eq!(observer.usage.cache_read_input_tokens, 20);
        assert_eq!(observer.usage.cache_creation_input_tokens, 40);
        assert!(observer.completed);
    }

    #[test]
    fn json_and_sse_errors_are_bounded_and_redact_decoded_credentials() {
        for sse in [false, true] {
            let mut observer = Observer::new(sse, None);
            observer.secrets = vec!["upstream-secret".into(), "proxy-key".into()];
            let error = r#"{"error":{"code":"invalid_api_key","message":"upstream-\u0073ecret and proxy-\u006bey rejected"}}"#;
            let bytes = if sse {
                format!("event: error\ndata: {error}\n\n")
            } else {
                error.to_owned()
            };
            for chunk in bytes.as_bytes().chunks(3) {
                observer.feed(chunk);
            }
            observer.finish();
            assert_eq!(
                observer.error.as_deref(),
                Some("invalid_api_key: [redacted] and [redacted] rejected")
            );
            assert!(observer.failed);
        }
        assert_eq!(
            response_error(
                &json!({"error":{"code":429,"message":"Rate limited"}}),
                "",
                false
            )
            .as_deref(),
            Some("429: Rate limited")
        );
        assert_eq!(
            response_error(&json!({"message":"Bad input"}), "", true).as_deref(),
            Some("Bad input")
        );
        assert!(response_error(&json!({"message":"success output"}), "", false).is_none());
        let bounded = error_summary(&"错误".repeat(MAX_ERROR_BYTES), &[]);
        assert!(bounded.len() <= MAX_ERROR_BYTES);
        assert!(bounded.ends_with('…'));
    }

    #[test]
    fn sse_usage_survives_every_byte_boundary() {
        let bytes = b"event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"CYBER\"}\r\n\r\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":100,\"output_tokens\":8,\"input_tokens_details\":{\"cached_tokens\":60}}}}\n\n";
        for split in 0..=bytes.len() {
            let mut observer = Observer::new(true, None);
            observer.feed(&bytes[..split]);
            observer.feed(&bytes[split..]);
            observer.finish();
            assert_eq!(observer.usage.input_tokens, 100);
            assert_eq!(observer.usage.cached_tokens, 60);
            assert!(observer.completed);
            assert!(observer.cyber);
        }
        let mut observer = Observer::new(true, None);
        for byte in bytes {
            observer.feed(&[*byte]);
        }
        observer.finish();
        assert_eq!(observer.usage.output_tokens, 8);
    }
    #[test]
    fn oversized_sse_events_are_bounded_and_next_event_works() {
        let mut observer = Observer::new(true, None);
        observer.feed(b"data: ");
        observer.feed(&vec![b'x'; MAX_EVENT_BYTES + 50]);
        observer.feed(b"\n\ndata: {\"type\":\"response.completed\"}\n\n");
        assert!(observer.completed);
        assert!(observer.line.len() <= MAX_EVENT_BYTES);
        assert!(observer.data.len() <= MAX_EVENT_BYTES);
    }
    #[test]
    fn credentials_are_redacted_across_all_boundaries() {
        let bytes = b"before sk-private after sk-private";
        for split in 0..=bytes.len() {
            let mut filter = SecretFilter::new("sk-private".into());
            let output = [
                filter.feed(&bytes[..split]),
                filter.feed(&bytes[split..]),
                filter.finish(),
            ]
            .concat();
            assert_eq!(output, b"before [redacted] after [redacted]");
        }
    }
    #[test]
    fn terminal_bytes_are_not_buffered_behind_an_unrelated_secret() {
        let mut filter = SecretFilter::new("upstream-secret".into());
        let terminal = b"data: [DONE]\n\n";
        assert_eq!(filter.feed(terminal).as_ref(), terminal);
        assert!(filter.finish().is_empty());
        assert_eq!(filter.feed(b"before upstream-").as_ref(), b"before ");
        assert_eq!(filter.feed(b"secret after").as_ref(), b"[redacted] after");
    }

    #[test]
    fn normal_incomplete_response_variants_are_terminal_but_errors_still_fail() {
        for sse in [false, true] {
            for reason in ["max_output_tokens", "content_filter", "unknown"] {
                let mut observer = Observer::new(sse, None);
                let response =
                    json!({"status":"incomplete","incomplete_details":{"reason":reason}});
                let bytes = if sse {
                    format!(
                        "event: response.incomplete\ndata: {}\n\n",
                        json!({"response":response})
                    )
                    .into_bytes()
                } else {
                    serde_json::to_vec(&response).unwrap()
                };
                observer.feed(&bytes);
                observer.finish();
                assert_eq!(observer.completed, reason != "unknown");
                assert_eq!(observer.failed, reason == "unknown");
            }
        }
        let mut observer = Observer::new(true, None);
        observer.feed(b"event: response.incomplete\ndata: {\"response\":{\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"error\":{\"code\":\"server_error\"}}}\n\n");
        assert!(observer.failed);
    }

    #[test]
    fn malformed_incomplete_event_is_terminal_and_choice_tracking_is_bounded() {
        for data in ["", "not-json"] {
            let mut observer = Observer::new(true, None);
            observer.feed(format!("event: response.incomplete\ndata: {data}\n\n").as_bytes());
            assert!(observer.failed);
        }
        let mut observer = Observer::new(true, Some(u64::MAX));
        observer.feed(b"data: {\"choices\":[{\"index\":0,\"finish_reason\":\"stop\"}]}\n\n");
        assert!(observer.finished_choices.is_empty());
        assert!(!observer.completed);
        observer.feed(b"data: [DONE]\n\n");
        assert!(observer.completed);
    }

    #[test]
    fn admission_is_atomic_and_drop_releases_concurrency() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::new_app(dir.path(), dir.path().into()).unwrap();
        let account = Account {
            id: "a".into(),
            concurrency: 1,
            rpm: 2,
            ..Default::default()
        };
        let guard = admit(&state, &account).unwrap();
        assert!(admit(&state, &account).is_err());
        drop(guard);
        let guard = admit(&state, &account).unwrap();
        drop(guard);
        assert!(admit(&state, &account).is_err());
        assert_eq!(state.runtime.lock().unwrap()["a"].active, 0);
        health(
            &state,
            "a",
            &Settings {
                failure_threshold: 1,
                ..Default::default()
            },
            false,
            true,
        );
        assert!(state.runtime.lock().unwrap()["a"].cooldown_until > store::now());
    }

    #[test]
    fn single_account_pool_clears_cooldown_and_never_reenters_it() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::new_app(dir.path(), dir.path().into()).unwrap();
        let account = Account {
            id: "only".into(),
            ..Default::default()
        };
        let settings = Settings {
            failure_threshold: 1,
            ..Default::default()
        };

        health(&state, "only", &settings, false, false);
        assert_eq!(state.runtime.lock().unwrap()["only"].cooldown_until, 0);

        {
            let mut runtime = state.runtime.lock().unwrap();
            runtime.get_mut("only").unwrap().cooldown_until = store::now() + 60;
        }
        let accounts = [account];
        let (selected, admission) = select_account(&state, &accounts, &HashSet::new()).unwrap();
        assert_eq!(selected.id, "only");
        let runtime = state.runtime.lock().unwrap();
        assert_eq!(runtime["only"].cooldown_until, 0);
        assert_eq!(runtime["only"].failures, 0);
        drop(runtime);
        drop(admission);
    }

    #[test]
    fn all_cooled_accounts_are_released_as_a_pool() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::new_app(dir.path(), dir.path().into()).unwrap();
        let accounts = [
            Account {
                id: "a".into(),
                ..Default::default()
            },
            Account {
                id: "b".into(),
                ..Default::default()
            },
        ];
        {
            let mut runtime = state.runtime.lock().unwrap();
            for id in ["a", "b"] {
                let status = runtime.entry(id.into()).or_default();
                status.failures = 3;
                status.cooldown_until = store::now() + 60;
            }
        }

        let (selected, admission) = select_account(&state, &accounts, &HashSet::new()).unwrap();
        assert_eq!(selected.id, "a");
        let runtime = state.runtime.lock().unwrap();
        for id in ["a", "b"] {
            assert_eq!(runtime[id].cooldown_until, 0);
            assert_eq!(runtime[id].failures, 0);
        }
        drop(runtime);
        drop(admission);
    }

    #[test]
    fn a_partially_cooled_pool_keeps_cooldown_and_selects_available_account() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::new_app(dir.path(), dir.path().into()).unwrap();
        let accounts = [
            Account {
                id: "a".into(),
                ..Default::default()
            },
            Account {
                id: "b".into(),
                ..Default::default()
            },
        ];
        state.runtime.lock().unwrap().insert(
            "a".into(),
            crate::Runtime {
                failures: 2,
                cooldown_until: store::now() + 60,
                ..Default::default()
            },
        );

        let (selected, admission) = select_account(&state, &accounts, &HashSet::new()).unwrap();
        assert_eq!(selected.id, "b");
        assert!(state.runtime.lock().unwrap()["a"].cooldown_until > store::now());
        drop(admission);
    }

    struct Server(tokio::task::JoinHandle<()>);
    impl Drop for Server {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    async fn serve(router: axum::Router) -> (String, Server) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (endpoint, Server(task))
    }
    fn fixture(endpoints: &[String]) -> (tempfile::TempDir, Shared) {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::new_app(dir.path(), dir.path().into()).unwrap();
        let secret = state.store.seal("upstream-secret").unwrap();
        state
            .store
            .update(|config| {
                config.groups.push(Group {
                    id: "group".into(),
                    ..Default::default()
                });
                config.keys.push(ApiKey {
                    id: "key".into(),
                    group_id: "group".into(),
                    hash: store::digest("proxy-key"),
                    enabled: true,
                    ..Default::default()
                });
                config.settings.failure_threshold = 1;
                for (index, endpoint) in endpoints.iter().enumerate() {
                    config.accounts.push(Account {
                        id: format!("account-{index}"),
                        endpoint: endpoint.clone(),
                        api_key: secret.clone(),
                        group_ids: vec!["group".into()],
                        models: vec!["chosen".into()],
                        protocols: vec!["responses".into(), "compact".into()],
                        enabled: true,
                        priority: index as i32,
                        ..Default::default()
                    });
                }
                Ok(())
            })
            .unwrap();
        (dir, state)
    }
    async fn call(state: Shared, path: &str, body: Value) -> Response {
        use tower::ServiceExt;
        crate::app(state)
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("authorization", "Bearer proxy-key")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    #[test]
    fn cache_settling_config_defaults_and_env_overrides() {
        let defaults = Settings::default();
        assert_eq!(defaults.cache_settling_delay_ms, 1000);
        let mut legacy = serde_json::to_value(defaults).unwrap();
        legacy.as_object_mut().unwrap().remove("cache_settling_delay_ms");
        let mut settings: Settings = serde_json::from_value(legacy).unwrap();
        assert_eq!(settings.cache_settling_delay_ms, 1000);
        settings.cache_settling_delay_ms = 775;
        for (zako, antigravity, expected) in [
            (None, None, 775),
            (Some("0"), Some("4800"), 0),
            (Some("5000"), None, 5000),
            (Some("5001"), Some("4800"), 4800),
            (Some("invalid"), Some("-1"), 775),
        ] {
            let actual = resolve_cache_settling_delay_ms(&settings, |name| {
                match name {
                    "ZAKO_CACHE_SETTLING_DELAY_MS" => zako,
                    "ANTIGRAVITY_CACHE_SETTLING_DELAY_MS" => antigravity,
                    _ => panic!("unexpected environment variable {name}"),
                }
                .map(str::to_owned)
            });
            assert_eq!(actual, expected);
        }
    }

    #[tokio::test]
    async fn heavy_cold_completion_waits_only_for_the_remaining_window() {
        let (_dir, state) = fixture(&[]);
        let delay = Duration::from_millis(500);
        let url = "https://upstream.example/v1/responses";
        state.cache_settling_completed.lock().unwrap().insert(
            "account:expired".into(),
            Instant::now() - Duration::from_secs(61),
        );
        record_cache_settling_completion(&state, "account", "session", &Usage {
            input_tokens: 20_000,
            cached_tokens: 4_000,
            cache_read_input_tokens: 4_000,
            ..Default::default()
        });
        let completed_at = {
            let mut completed = state.cache_settling_completed.lock().unwrap();
            assert!(!completed.contains_key("account:expired"));
            let instant = completed.get_mut("account:session").unwrap();
            *instant -= Duration::from_millis(300);
            *instant
        };
        let started = Instant::now();
        await_cache_settling(&state, "account", "session", url, 500).await;
        let waited = started.elapsed();
        assert!(completed_at.elapsed() >= delay);
        assert!(waited < delay, "waited {waited:?} for a partially elapsed window");
        assert!(await_cache_settling(&state, "account", "session", url, 500).now_or_never().is_some());
    }

    #[tokio::test]
    async fn hot_completion_does_not_open_or_refresh_a_wait_window() {
        let (_dir, state) = fixture(&[]);
        let url = "https://upstream.example/v1/responses";
        let hot = Usage { input_tokens: 20_000, cached_tokens: 4_001, ..Default::default() };
        record_cache_settling_completion(&state, "account", "session", &hot);
        assert!(await_cache_settling(&state, "account", "session", url, 5000).now_or_never().is_some());
        assert!(state.cache_settling_completed.lock().unwrap().is_empty());
        let previous = Instant::now() - Duration::from_millis(100);
        state.cache_settling_completed.lock().unwrap().insert("account:session".into(), previous);
        record_cache_settling_completion(&state, "account", "session", &hot);
        assert_eq!(state.cache_settling_completed.lock().unwrap()["account:session"], previous);
    }

    #[tokio::test]
    async fn cache_settling_wait_is_isolated_and_skips_local_acp() {
        let (_dir, state) = fixture(&[]);
        let url = "https://upstream.example/v1/responses";
        state.cache_settling_completed.lock().unwrap().insert("account:session".into(), Instant::now());
        let mut waiting = std::pin::pin!(await_cache_settling(&state, "account", "session", url, 5000));
        assert!(futures_util::poll!(waiting.as_mut()).is_pending());
        assert!(state.cache_settling_completed.try_lock().is_ok());
        for (account, key, target, delay) in [
            ("account", "other", url, 5000),
            ("other", "session", url, 5000),
            ("account", "session", url, 0),
            ("account", "session", "http://127.0.0.1:8048/v1/responses", 5000),
            ("account", "session", "http://localhost:8048/v1/responses", 5000),
            ("account", "session", "http://[::1]:8048/v1/responses", 5000),
        ] {
            assert!(await_cache_settling(&state, account, key, target, delay).now_or_never().is_some());
        }
        assert!(!matches_acp_upstream("http://localhost:8049/v1/responses", || None));
        assert!(!matches_acp_upstream("http://localhost.example:8048/v1/responses", || None));
        for base in ["acp.internal:9010", "http://acp.internal:9010/prefix"] {
            let configured = || Some(base.to_owned());
            assert!(matches_acp_upstream("http://acp.internal:9010/v1/responses", configured));
            assert!(!matches_acp_upstream("http://acp.internal:9011/v1/responses", configured));
        }
    }

    #[tokio::test]
    async fn forward_records_cold_completion_for_json_and_sse() {
        use axum::routing::post;
        let (endpoint, _server) = serve(axum::Router::new().route("/v1/responses", post(|Json(body): Json<Value>| async move {
            let usage = json!({"input_tokens":20000,"input_tokens_details":{"cached_tokens":4000}});
            if body["stream"] == true {
                let event = json!({"type":"response.completed","response":{"usage":usage}});
                let output = async_stream::stream! {
                    yield Ok::<_, std::io::Error>(Bytes::from(format!("data: {event}\n\n")));
                    std::future::pending::<()>().await;
                };
                ([("content-type", "text/event-stream")], Body::from_stream(output)).into_response()
            } else {
                Json(json!({"usage":usage})).into_response()
            }
        }))).await;
        let (_dir, state) = fixture(&[endpoint]);
        for streaming in [false, true] {
            let response = call(state.clone(), "/v1/responses", json!({"model":"chosen","stream":streaming})).await;
            assert_eq!(response.status(), StatusCode::OK);
            if streaming {
                let mut stream = response.into_body().into_data_stream();
                let chunk = tokio::time::timeout(Duration::from_secs(5), stream.next()).await.unwrap().unwrap().unwrap();
                assert!(String::from_utf8_lossy(&chunk).contains("response.completed"));
            } else {
                axum::body::to_bytes(response.into_body(), 1024).await.unwrap();
            }
            let mut completed = state.cache_settling_completed.lock().unwrap();
            assert_eq!(completed.len(), 1, "streaming={streaming}");
            assert!(completed.keys().next().unwrap().starts_with("account-0:"));
            completed.clear();
        }
    }

    #[tokio::test]
    async fn local_and_transport_failures_have_safe_reasons_and_request_paths() {
        let (_dir, state) = fixture(&["http://127.0.0.1:1".into()]);
        let response = call(
            state.clone(),
            "/v1/responses/compact",
            json!({"model":"chosen","input":"private prompt"}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let logs = state.store.logs(0, store::now() + 10).unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].request_path, "/v1/responses/compact");
        let reason = logs[0].error.as_deref().unwrap();
        assert!(reason.contains("connect") || reason.contains("transport"));
        assert!(!reason.contains("private prompt"));
        assert!(logs[0].first_token_ms.is_none());
        let response = call(
            state.clone(),
            "/v1/responses",
            json!({"input":"private prompt"}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let logs = state.store.logs(0, store::now() + 10).unwrap();
        let local = logs.iter().find(|log| log.status == 400).unwrap();
        assert_eq!(
            local.error.as_deref(),
            Some("A JSON object with a nonempty model is required")
        );
    }

    #[tokio::test]
    async fn streamed_first_token_excludes_metadata_and_terminal_freezes_duration() {
        use axum::routing::post;
        let (endpoint, _server) = serve(axum::Router::new().route("/v1/responses", post(|| async {
            let output = async_stream::stream! {
                yield Ok::<_, std::io::Error>(Bytes::from_static(b"data: {\"type\":\"response.created\"}\n\n"));
                tokio::time::sleep(Duration::from_millis(50)).await;
                yield Ok(Bytes::from_static(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n"));
                yield Ok(Bytes::from_static(b"data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"output_tokens\":1}}}\n\n"));
                tokio::time::sleep(Duration::from_secs(300)).await;
            };
            ([("content-type", "text/event-stream")], Body::from_stream(output))
        }))).await;
        let (_dir, state) = fixture(&[endpoint]);
        let response = call(
            state.clone(),
            "/v1/responses",
            json!({"model":"chosen","stream":true}),
        )
        .await;
        let mut stream = response.into_body().into_data_stream();
        let mut received = Vec::new();
        while let Some(chunk) = stream.next().await {
            received.extend_from_slice(&chunk.unwrap());
            if String::from_utf8_lossy(&received).contains("response.completed") {
                break;
            }
        }
        let completed_at = Instant::now();
        tokio::time::sleep(Duration::from_millis(80)).await;
        drop(stream);
        let logs = state.store.logs(0, store::now() + 10).unwrap();
        let log = &logs[0];
        assert_eq!(log.status, 200);
        assert!(log.error.is_none());
        assert!(log.first_token_ms.unwrap() >= 40);
        assert!(log.latency_ms >= log.first_token_ms.unwrap());
        assert!(
            log.latency_ms
                < log.first_token_ms.unwrap() + completed_at.elapsed().as_millis() as u64
        );
    }

    #[tokio::test]
    async fn no_selected_models_never_routes_as_wildcard() {
        let (_dir, state) = fixture(&["http://127.0.0.1:1".into()]);
        state
            .store
            .update(|config| {
                config.accounts[0].models.clear();
                config.accounts[0]
                    .model_mappings
                    .insert("chosen".into(), "unselected".into());
                Ok(())
            })
            .unwrap();
        let response = call(
            state.clone(),
            "/v1/responses",
            json!({"model":"chosen","input":"hello"}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(state.runtime.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn mapped_failover_rebuilds_actual_model_and_instruction_for_each_account() {
        use axum::routing::post;
        let captured = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed_first = captured.clone();
        let (first, _first_server) = serve(axum::Router::new().route(
            "/v1/responses/compact",
            post(move |Json(body): Json<Value>| {
                observed_first.lock().unwrap().push(body);
                async { StatusCode::SERVICE_UNAVAILABLE }
            }),
        ))
        .await;
        let observed_second = captured.clone();
        let (second, _second_server) = serve(axum::Router::new().route(
            "/v1/responses/compact",
            post(move |Json(body): Json<Value>| {
                observed_second.lock().unwrap().push(body);
                async { Json(json!({"id":"success"})) }
            }),
        ))
        .await;
        let (_dir, state) = fixture(&[first, second]);
        state
            .store
            .update(|config| {
                config.settings.global_prompt = "Custom global prompt".into();
                for (account, actual) in config
                    .accounts
                    .iter_mut()
                    .zip(["gpt-5.6-sol", "gpt-6-astra"])
                {
                    account.models = vec![actual.into()];
                    account
                        .model_mappings
                        .insert("chosen".into(), actual.into());
                }
                Ok(())
            })
            .unwrap();
        let original = json!({"model":"chosen","instructions":"Original","input":"hello","tools":[],"metadata":{"keep":true}});
        let response = call(state.clone(), "/v1/responses/compact", original.clone()).await;
        assert_eq!(response.status(), StatusCode::OK);
        axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let captured = captured.lock().unwrap();
        assert_eq!(captured.len(), 2);
        for (body, actual) in captured.iter().zip(["gpt-5.6-sol", "gpt-6-astra"]) {
            let mut expected = original.clone();
            expected["model"] = json!(actual);
            expected["instructions"] = json!("Custom global prompt\n\nOriginal");
            assert_eq!(*body, expected);
        }
        let logs = state.store.logs(0, store::now() + 10).unwrap();
        assert_eq!(logs[0].model, "chosen");
        assert_eq!(logs[0].attempts, 2);
    }

    #[tokio::test]
    async fn mock_upstream_failover_preserves_compact_payload_and_logs_usage() {
        use axum::{http::Uri, routing::post};
        let (first, _first_server) = serve(axum::Router::new().route(
            "/v1/responses/compact",
            post(|| async { StatusCode::SERVICE_UNAVAILABLE }),
        ))
        .await;
        let received = std::sync::Arc::new(std::sync::Mutex::new(None));
        let observed = received.clone();
        let (second, _second_server) = serve(axum::Router::new().route("/v1/responses/compact", post(move |uri: Uri, headers: HeaderMap, Json(body): Json<Value>| {
            let observed = observed.clone(); async move {
                assert_eq!(headers["authorization"], "Bearer upstream-secret");
                *observed.lock().unwrap() = Some((uri.path().to_owned(), body));
                ([ ("x-request-id", "upstream-request") ], Json(json!({"id":"response","usage":{"input_tokens":20,"output_tokens":3,"input_tokens_details":{"cached_tokens":8}}})))
            }
        }))).await;
        let (_dir, state) = fixture(&[first, second]);
        let input = json!({"model":"chosen","instructions":"Existing","input":[{"role":"user","content":"hello"}],"tools":[{"type":"function","name":"tool"}],"metadata":{"custom":true},"store":false});
        let response = call(state.clone(), "/v1/responses/compact", input.clone()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-request-id"], "upstream-request");
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["id"],
            "response"
        );
        let captured = received.lock().unwrap().clone().unwrap();
        assert_eq!(captured.0, "/v1/responses/compact");
        assert_eq!(captured.1["instructions"], "Existing");
        for field in ["input", "tools", "metadata", "store"] {
            assert_eq!(captured.1[field], input[field]);
        }
        let logs = state.store.logs(0, store::now() + 10).unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].status, 200);
        assert_eq!(logs[0].attempts, 2);
        assert_eq!(logs[0].usage.cached_tokens, 8);
        let runtime = state.runtime.lock().unwrap();
        assert!(runtime["account-0"].cooldown_until > store::now());
        assert_eq!(runtime["account-0"].active, 0);
        assert_eq!(runtime["account-1"].active, 0);
    }
    #[tokio::test]
    async fn client_error_is_forwarded_without_retry_or_cooldown_and_secrets_are_redacted() {
        use axum::routing::post;
        let (endpoint, _server) = serve(axum::Router::new().route(
            "/v1/responses",
            post(|| async {
                (
                    StatusCode::BAD_REQUEST,
                    [("content-type", "application/json"), ("retry-after", "7")],
                    r#"{"error":"upstream-secret invalid input"}"#,
                )
            }),
        ))
        .await;
        let (_dir, state) = fixture(&[endpoint]);
        let response = call(
            state.clone(),
            "/v1/responses",
            json!({"model":"chosen","input":"hello"}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response.headers()["retry-after"], "7");
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("upstream-secret"));
        assert!(String::from_utf8_lossy(&bytes).contains("[redacted]"));
        let runtime = state.runtime.lock().unwrap();
        assert_eq!(runtime["account-0"].failures, 0);
        assert_eq!(runtime["account-0"].active, 0);
        let logs = state.store.logs(0, store::now() + 10).unwrap();
        assert_eq!(logs[0].status, 400);
        assert_eq!(logs[0].attempts, 1);
    }
    #[tokio::test]
    async fn dropping_unconsumed_stream_releases_admission_and_records_499() {
        use axum::routing::post;
        let (endpoint, _server) = serve(axum::Router::new().route("/v1/responses", post(|| async {
            let output = async_stream::stream! {
                yield Ok::<_, std::io::Error>(Bytes::from_static(b"data: {\"type\":\"response.created\"}\n\n"));
                tokio::time::sleep(Duration::from_secs(300)).await;
            };
            ([("content-type", "text/event-stream")], Body::from_stream(output))
        }))).await;
        let (_dir, state) = fixture(&[endpoint]);
        let response = call(
            state.clone(),
            "/v1/responses",
            json!({"model":"chosen","input":"hello","stream":true}),
        )
        .await;
        assert_eq!(state.runtime.lock().unwrap()["account-0"].active, 1);
        drop(response);
        assert_eq!(state.runtime.lock().unwrap()["account-0"].active, 0);
        let logs = state.store.logs(0, store::now() + 10).unwrap();
        assert_eq!(logs[0].status, 499);
    }

    #[tokio::test]
    async fn sse_success_bytes_and_usage_are_preserved() {
        use axum::routing::post;
        const SSE: &[u8] = b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"cyber\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":40,\"output_tokens\":6,\"input_tokens_details\":{\"cached_tokens\":30}}}}\n\ndata: [DONE]\n\n";
        let (endpoint, _server) = serve(axum::Router::new().route(
            "/v1/responses",
            post(|| async {
                let stream = futures_util::stream::iter(
                    SSE.chunks(11)
                        .map(|chunk| Ok::<_, std::io::Error>(Bytes::copy_from_slice(chunk))),
                );
                (
                    [("content-type", "text/event-stream")],
                    Body::from_stream(stream),
                )
            }),
        ))
        .await;
        let (_dir, state) = fixture(&[endpoint]);
        let response = call(
            state.clone(),
            "/v1/responses",
            json!({"model":"chosen","input":"hello","stream":true}),
        )
        .await;
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        assert_eq!(&body[..], SSE);
        let logs = state.store.logs(0, store::now() + 10).unwrap();
        assert_eq!(logs[0].status, 200);
        assert_eq!(logs[0].usage.cached_tokens, 30);
        assert!(logs[0].cyber);
        assert_eq!(state.runtime.lock().unwrap()["account-0"].active, 0);
    }

    #[tokio::test]
    async fn explicit_sse_failure_preserves_events_and_counts_failure() {
        use axum::routing::post;
        const SSE: &str = "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"usage\":{\"input_tokens\":7}}}\n\n";
        let (endpoint, _server) = serve(axum::Router::new().route(
            "/v1/responses",
            post(|| async { ([("content-type", "text/event-stream")], SSE) }),
        ))
        .await;
        let (_dir, state) = fixture(&[endpoint]);
        let response = call(
            state.clone(),
            "/v1/responses",
            json!({"model":"chosen","input":"hello","stream":true}),
        )
        .await;
        assert_eq!(response.status(), 200);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        assert_eq!(&body[..], SSE.as_bytes());
        let logs = state.store.logs(0, store::now() + 10).unwrap();
        assert_eq!(logs[0].status, 502);
        assert_eq!(logs[0].usage.input_tokens, 7);
        let runtime = state.runtime.lock().unwrap();
        assert_eq!(runtime["account-0"].active, 0);
        assert_eq!(runtime["account-0"].failures, 1);
    }

    #[tokio::test]
    async fn truncated_sse_reports_transport_failure_and_releases_slot() {
        use axum::routing::post;
        let (endpoint, _server) = serve(axum::Router::new().route(
            "/v1/responses",
            post(|| async {
                (
                    [("content-type", "text/event-stream")],
                    "data: {\"type\":\"response.created\"}\n\n",
                )
            }),
        ))
        .await;
        let (_dir, state) = fixture(&[endpoint]);
        let response = call(
            state.clone(),
            "/v1/responses",
            json!({"model":"chosen","input":"hello","stream":true}),
        )
        .await;
        assert!(
            axum::body::to_bytes(response.into_body(), 4096)
                .await
                .is_err()
        );
        assert_eq!(
            state.store.logs(0, store::now() + 10).unwrap()[0].status,
            502
        );
        assert_eq!(state.runtime.lock().unwrap()["account-0"].active, 0);
    }

    #[tokio::test]
    async fn cooled_fallback_retries_unless_concurrency_blocked_and_preserves_upstream_error() {
        use axum::routing::post;
        let (endpoint, _server) = serve(axum::Router::new().route(
            "/v1/responses",
            post(|| async {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    [("retry-after", "23")],
                    "original upstream failure",
                )
            }),
        ))
        .await;
        for fallback_busy in [false, true] {
            let (_dir, state) = fixture(&[endpoint.clone(), endpoint.clone()]);
            state
                .store
                .update(|config| {
                    config.accounts[1].concurrency = 1;
                    Ok(())
                })
                .unwrap();
            state.runtime.lock().unwrap().insert(
                "account-1".into(),
                crate::Runtime {
                    active: u32::from(fallback_busy),
                    cooldown_until: store::now() + 100,
                    ..Default::default()
                },
            );
            let response = call(
                state.clone(),
                "/v1/responses",
                json!({"model":"chosen","input":"hello"}),
            )
            .await;
            assert_eq!(response.status(), 503);
            assert_eq!(response.headers()["retry-after"], "23");
            let body = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            assert_eq!(&body[..], b"original upstream failure");
            let logs = state.store.logs(0, store::now() + 10).unwrap();
            assert_eq!(logs[0].status, 503);
            assert_eq!(logs[0].attempts, if fallback_busy { 1 } else { 2 });
            assert_eq!(
                state.runtime.lock().unwrap()["account-1"].active,
                u32::from(fallback_busy)
            );
        }
    }

    #[tokio::test]
    async fn client_disconnect_after_completed_event_keeps_success_status() {
        use axum::routing::post;
        let (endpoint, _server) = serve(axum::Router::new().route("/v1/responses", post(|| async {
            let output = async_stream::stream! {
                yield Ok::<_, std::io::Error>(Bytes::from_static(b"data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":12,\"output_tokens\":2}}}\n\n"));
                tokio::time::sleep(Duration::from_secs(300)).await;
            };
            ([("content-type", "text/event-stream")], Body::from_stream(output))
        }))).await;
        let (_dir, state) = fixture(&[endpoint]);
        let response = call(
            state.clone(),
            "/v1/responses",
            json!({"model":"chosen","input":"hello","stream":true}),
        )
        .await;
        let mut stream = response.into_body().into_data_stream();
        assert!(stream.next().await.unwrap().is_ok());
        drop(stream);
        let logs = state.store.logs(0, store::now() + 10).unwrap();
        assert_eq!(logs[0].status, 200);
        assert_eq!(logs[0].usage.input_tokens, 12);
        assert_eq!(state.runtime.lock().unwrap()["account-0"].active, 0);
    }

    #[test]
    fn pure_cache_skips_instruction_and_sensitive_filter_replaces_text() {
        let mut settings = Settings::default();
        settings.armor_mode = "pure_cache".into();
        settings.global_prompt = "SHOULD_NOT_INJECT".into();
        settings.sensitive_filter_enabled = true;
        settings.sensitive_words = vec![crate::store::SensitiveWordRule {
            pattern: "SecretWord".into(),
            replace: "[FILTERED]".into(),
            case_insensitive: true,
            enabled: true,
        }];
        let group = Group {
            id: "g".into(),
            name: "g".into(),
            strategy_template_id: "default".into(),
            injection_mode: "aggressive".into(),
            ..Default::default()
        };
        assert!(resolve_instruction_with_settings(&group, &group, "gemini-4-argon", &settings).is_none());
        let mut body = json!({
            "contents": [{"role": "user", "parts": [{"text": "hello secretword world"}]}]
        });
        apply_sensitive_filter(&mut body, &settings);
        assert_eq!(
            body["contents"][0]["parts"][0]["text"],
            "hello [FILTERED] world"
        );
    }

    #[test]
    fn performance_first_round_robin_distribution() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::new_app(dir.path(), dir.path().into()).unwrap();
        let group = Group {
            id: "g-rr".into(),
            routing_strategy: "performance-first".into(),
            ..Default::default()
        };
        let accounts = vec![
            Account {
                id: "a".into(),
                priority: 0,
                ..Default::default()
            },
            Account {
                id: "b".into(),
                priority: 1,
                ..Default::default()
            },
            Account {
                id: "c".into(),
                priority: 2,
                ..Default::default()
            },
        ];

        let mut picked = Vec::new();
        for _ in 0..6 {
            let (selected, admission) =
                select_account_rr(&state, &group.id, &accounts, &HashSet::new()).unwrap();
            picked.push(selected.id.clone());
            drop(admission);
        }
        assert_eq!(picked, vec!["a", "b", "c", "a", "b", "c"]);
    }

    #[tokio::test]
    async fn cache_first_sticky_reuse_and_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::new_app(dir.path(), dir.path().into()).unwrap();
        let group = Group {
            id: "g-cache".into(),
            routing_strategy: "cache-first".into(),
            ..Default::default()
        };
        let accounts = vec![
            Account {
                id: "a".into(),
                priority: 0,
                ..Default::default()
            },
            Account {
                id: "b".into(),
                priority: 1,
                ..Default::default()
            },
        ];
        let mut headers = HeaderMap::new();
        headers.insert("x-session-id", HeaderValue::from_static("sess-1"));
        let sticky_key = build_sticky_key(
            &group.id,
            "key-1",
            "gemini-4",
            &headers,
            &json!({"messages": [{"role": "user", "content": "hello"}]}),
        );

        let (first, adm1) =
            select_account_for_group(&state, &group, &sticky_key, &accounts, &HashSet::new())
                .await
                .unwrap();
        assert_eq!(first.id, "a");
        drop(adm1);

        // Second call with same sticky_key reuses "a".
        let (second, adm2) =
            select_account_for_group(&state, &group, &sticky_key, &accounts, &HashSet::new())
                .await
                .unwrap();
        assert_eq!(second.id, "a");
        drop(adm2);

        // When "a" is in tried, cache-first falls back to "b" and updates sticky_bindings.
        let mut tried = HashSet::new();
        tried.insert("a".to_owned());
        let (fallback, adm3) =
            select_account_for_group(&state, &group, &sticky_key, &accounts, &tried)
                .await
                .unwrap();
        assert_eq!(fallback.id, "b");
        drop(adm3);

        // Subsequent call without tried now reuses "b".
        let (third, adm4) =
            select_account_for_group(&state, &group, &sticky_key, &accounts, &HashSet::new())
                .await
                .unwrap();
        assert_eq!(third.id, "b");
        drop(adm4);
    }

    #[test]
    fn subagent_sticky_isolation_and_case_insensitive_headers() {
        let body = json!({"messages": [{"role": "user", "content": "hello"}]});
        let mut main_headers = HeaderMap::new();
        main_headers.insert("X-Session-Id", HeaderValue::from_static("sess-100"));

        let mut claude_sub_headers = HeaderMap::new();
        claude_sub_headers.insert("x-session-id", HeaderValue::from_static("sess-100"));
        claude_sub_headers.insert("X-Claude-Code-Agent-Id", HeaderValue::from_static("sub-a"));

        let mut thread_sub_headers = HeaderMap::new();
        thread_sub_headers.insert("x-session-id", HeaderValue::from_static("sess-100"));
        thread_sub_headers.insert("X-Thread-Id", HeaderValue::from_static("thread-b"));

        let main_key = build_sticky_key("g1", "k1", "claude-4", &main_headers, &body);
        let claude_sub_key = build_sticky_key("g1", "k1", "claude-4", &claude_sub_headers, &body);
        let thread_sub_key = build_sticky_key("g1", "k1", "claude-4", &thread_sub_headers, &body);

        assert_eq!(main_key, "g1:k1:claude-4:sid:sess-100");
        assert_eq!(claude_sub_key, "g1:k1:claude-4:sid:sess-100|agent:sub-a");
        assert_eq!(thread_sub_key, "g1:k1:claude-4:sid:sess-100|agent:thread-b");
        assert_ne!(main_key, claude_sub_key);
        assert_ne!(claude_sub_key, thread_sub_key);
    }

    #[tokio::test]
    async fn magpie_cache_worth_1024_first_turn_and_cold_window_protection() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::new_app(dir.path(), dir.path().into()).unwrap();
        let group = Group {
            id: "g-magpie".into(),
            routing_strategy: "cache-first".into(),
            ..Default::default()
        };
        let accounts = vec![
            Account {
                id: "acc-1".into(),
                priority: 0,
                ..Default::default()
            },
            Account {
                id: "acc-2".into(),
                priority: 1,
                ..Default::default()
            },
        ];
        let mut headers = HeaderMap::new();
        headers.insert("x-session-id", HeaderValue::from_static("sess-magpie"));
        let sticky_key = build_sticky_key(
            &group.id,
            "key-1",
            "claude-4",
            &headers,
            &json!({"messages": [{"role": "user", "content": "hi"}]}),
        );

        let (first, adm1) =
            select_account_for_group(&state, &group, &sticky_key, &accounts, &HashSet::new())
                .await
                .unwrap();
        assert_eq!(first.id, "acc-1");
        drop(adm1);

        // First turn with input_tokens >= 1024 triggers implicit write protection even when cached_tokens == 0.
        settle_sticky_cache_binding(
            &state,
            &sticky_key,
            "acc-1",
            &Usage {
                input_tokens: 1500,
                output_tokens: 100,
                cached_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
            true,
        );
        let binding = state
            .sticky_bindings
            .lock()
            .unwrap()
            .get(&sticky_key)
            .cloned()
            .unwrap();
        assert_eq!(binding.cached_tokens, 1500);
        assert!(binding.cache_written_at > 0);
        assert!(is_magpie_cache_protected(&binding, store::now()));
        assert!(!is_magpie_cache_protected(
            &binding,
            binding.cache_written_at + MAGPIE_COLD_WINDOW_SECS + 1
        ));

        // Brief 1s cooldown on acc-1 should wait and preserve acc-1 instead of switching to acc-2.
        {
            let mut runtime = state.runtime.lock().unwrap();
            runtime.entry("acc-1".into()).or_default().cooldown_until = store::now() + 1;
        }
        let (reused, adm2) =
            select_account_for_group(&state, &group, &sticky_key, &accounts, &HashSet::new())
                .await
                .unwrap();
        assert_eq!(reused.id, "acc-1");
        drop(adm2);
    }

    #[tokio::test]
    async fn sticky_bindings_persist_and_recover_across_restart() {
        let dir = tempfile::tempdir().unwrap();
        let group = Group {
            id: "g-restart".into(),
            routing_strategy: "cache-first".into(),
            ..Default::default()
        };
        let accounts = vec![
            Account {
                id: "acc-b".into(),
                priority: 1,
                ..Default::default()
            },
            Account {
                id: "acc-a".into(),
                priority: 0,
                ..Default::default()
            },
        ];
        let mut headers = HeaderMap::new();
        headers.insert("x-session-id", HeaderValue::from_static("sess-persist"));
        headers.insert("x-claude-code-agent-id", HeaderValue::from_static("worker-1"));
        let sticky_key = build_sticky_key(
            &group.id,
            "key-1",
            "claude-4",
            &headers,
            &json!({"messages": [{"role": "user", "content": "persist"}]}),
        );

        {
            let state = crate::new_app(dir.path(), dir.path().into()).unwrap();
            let mut tried = HashSet::new();
            tried.insert("acc-a".to_owned());
            let (selected, adm) =
                select_account_for_group(&state, &group, &sticky_key, &accounts, &tried)
                    .await
                    .unwrap();
            assert_eq!(selected.id, "acc-b");
            drop(adm);
            settle_sticky_cache_binding(
                &state,
                &sticky_key,
                "acc-b",
                &Usage {
                    input_tokens: 2048,
                    output_tokens: 64,
                    cached_tokens: 2048,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 2048,
                },
                true,
            );
        }

        // Reopen App from same data_dir to simulate process restart.
        let restarted = crate::new_app(dir.path(), dir.path().into()).unwrap();
        let recovered = restarted
            .sticky_bindings
            .lock()
            .unwrap()
            .get(&sticky_key)
            .cloned()
            .expect("sticky binding should be recovered on startup");
        assert_eq!(recovered.account_id, "acc-b");
        assert_eq!(recovered.cached_tokens, 2048);
        assert!(recovered.cache_written_at > 0);

        // Even though acc-a has priority 0, recovered sticky binding keeps acc-b.
        let (reused, adm2) =
            select_account_for_group(&restarted, &group, &sticky_key, &accounts, &HashSet::new())
                .await
                .unwrap();
        assert_eq!(reused.id, "acc-b");
        drop(adm2);
    }

    #[test]
    fn anthropic_cache_control_boost_injects_and_preserves_existing() {
        let mut body = json!({
            "model": "claude-4",
            "system": "You are helpful.",
            "tools": [
                {"name": "read_file", "input_schema": {"type": "object"}},
                {"name": "write_file", "input_schema": {"type": "object"}}
            ],
            "messages": [
                {"role": "user", "content": "first"},
                {"role": "assistant", "content": [{"type": "text", "text": "ok"}]},
                {"role": "user", "content": [{"type": "text", "text": "second"}, {"type": "text", "text": "   "}]}
            ]
        });
        assert!(apply_anthropic_cache_control_boost(&mut body));
        assert_eq!(
            body["system"],
            json!([{"type": "text", "text": "You are helpful.", "cache_control": {"type": "ephemeral"}}])
        );
        assert!(body["tools"][0].get("cache_control").is_none());
        assert_eq!(body["tools"][1]["cache_control"], json!({"type": "ephemeral"}));
        assert_eq!(
            body["messages"][2]["content"][0]["cache_control"],
            json!({"type": "ephemeral"})
        );
        assert!(body["messages"][2]["content"][1].get("cache_control").is_none());

        // Existing cache_control anywhere in payload should skip injection.
        let mut existing = json!({
            "model": "claude-4",
            "system": [{"type": "text", "text": "sys", "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": "hi"}]
        });
        let snapshot = existing.clone();
        assert!(!apply_anthropic_cache_control_boost(&mut existing));
        assert_eq!(existing, snapshot);
    }

    #[test]
    fn openai_prompt_cache_key_boost_injects_and_preserves_existing() {
        let mut headers = HeaderMap::new();
        headers.insert("x-session-id", HeaderValue::from_static("sess-1"));
        headers.insert("x-claude-code-agent-id", HeaderValue::from_static("agent-9"));

        let mut body = json!({"model": "gpt-5", "messages": [{"role": "user", "content": "hi"}]});
        assert!(apply_openai_prompt_cache_boost(&mut body, &headers));
        assert_eq!(body["prompt_cache_key"], json!("sess-1:agent-9"));

        // Preserves caller-provided prompt_cache_key.
        let mut preset = json!({"model": "gpt-5", "prompt_cache_key": "custom-key"});
        assert!(!apply_openai_prompt_cache_boost(&mut preset, &headers));
        assert_eq!(preset["prompt_cache_key"], json!("custom-key"));

        // Does not inject when no session/subagent headers are present.
        let mut no_headers_body = json!({"model": "gpt-5"});
        assert!(!apply_openai_prompt_cache_boost(
            &mut no_headers_body,
            &HeaderMap::new()
        ));
        assert!(no_headers_body.get("prompt_cache_key").is_none());
    }

    #[test]
    fn group_legacy_json_defaults_optional_policy_flags_false() {
        let legacy = json!({
            "id": "g-legacy",
            "name": "Legacy Group",
            "routing_strategy": "priority"
        });
        let parsed: Group = serde_json::from_value(legacy).unwrap();
        assert!(!parsed.staged_timeout_enabled);
        assert!(!parsed.sse_keepalive_enabled);
        assert!(!parsed.smart_cooldown_enabled);
    }

    #[test]
    fn smart_cooldown_policy_toggle_comparison() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::new_app(dir.path(), dir.path().into()).unwrap();
        let settings = Settings {
            failure_threshold: 3,
            cooldown_seconds: 60,
            ..Default::default()
        };

        // smart_cooldown = false: single 429 / 503 / 401 does not trigger cooldown when threshold is 3.
        health_with_policy(
            &state,
            "off-429",
            &settings,
            false,
            true,
            false,
            Some(StatusCode::TOO_MANY_REQUESTS),
            Some("45"),
        );
        health_with_policy(
            &state,
            "off-503",
            &settings,
            false,
            true,
            false,
            Some(StatusCode::SERVICE_UNAVAILABLE),
            None,
        );
        health_with_policy(
            &state,
            "off-401",
            &settings,
            false,
            true,
            false,
            Some(StatusCode::UNAUTHORIZED),
            None,
        );
        {
            let rt = state.runtime.lock().unwrap();
            assert_eq!(rt["off-429"].cooldown_until, 0);
            assert_eq!(rt["off-503"].cooldown_until, 0);
            assert_eq!(rt["off-401"].cooldown_until, 0);
        }

        // smart_cooldown = true: 429 respects Retry-After (int, clamped, and HTTP-date).
        let before = store::now();
        health_with_policy(
            &state,
            "on-429-int",
            &settings,
            false,
            true,
            true,
            Some(StatusCode::TOO_MANY_REQUESTS),
            Some("45"),
        );
        health_with_policy(
            &state,
            "on-429-clamp",
            &settings,
            false,
            true,
            true,
            Some(StatusCode::TOO_MANY_REQUESTS),
            Some("9999"),
        );
        let http_date = (chrono::Utc::now() + chrono::Duration::seconds(90)).to_rfc2822();
        health_with_policy(
            &state,
            "on-429-date",
            &settings,
            false,
            true,
            true,
            Some(StatusCode::TOO_MANY_REQUESTS),
            Some(&http_date),
        );
        {
            let rt = state.runtime.lock().unwrap();
            let int_delta = rt["on-429-int"].cooldown_until - before;
            assert!((44..=47).contains(&int_delta), "int_delta={int_delta}");
            let clamp_delta = rt["on-429-clamp"].cooldown_until - before;
            assert!(
                (599..=602).contains(&clamp_delta),
                "clamp_delta={clamp_delta}"
            );
            let date_delta = rt["on-429-date"].cooldown_until - before;
            assert!((85..=92).contains(&date_delta), "date_delta={date_delta}");
        }

        // smart_cooldown = true: 503 exponential backoff 10 -> 20 -> 40 -> 80 -> 120.
        let expected_503 = [10i64, 20, 40, 80, 120];
        for expected in expected_503 {
            let t0 = store::now();
            health_with_policy(
                &state,
                "on-503",
                &settings,
                false,
                true,
                true,
                Some(StatusCode::SERVICE_UNAVAILABLE),
                None,
            );
            let delta = state.runtime.lock().unwrap()["on-503"].cooldown_until - t0;
            assert!(
                (expected - 1..=expected + 2).contains(&delta),
                "expected ~{expected}s, got {delta}s"
            );
        }

        // smart_cooldown = true: 401/403 long cooldown >= 300s.
        let t0 = store::now();
        health_with_policy(
            &state,
            "on-401",
            &settings,
            false,
            true,
            true,
            Some(StatusCode::UNAUTHORIZED),
            None,
        );
        let delta_401 = state.runtime.lock().unwrap()["on-401"].cooldown_until - t0;
        assert!((299..=302).contains(&delta_401), "delta_401={delta_401}");
    }

    #[tokio::test]
    async fn sse_keepalive_toggle_injects_comments_without_polluting_first_token_ms() {
        use axum::routing::post;
        struct ResetKeepalive;
        impl Drop for ResetKeepalive {
            fn drop(&mut self) {
                TEST_SSE_KEEPALIVE_MS.store(0, std::sync::atomic::Ordering::Relaxed);
            }
        }
        TEST_SSE_KEEPALIVE_MS.store(50, std::sync::atomic::Ordering::Relaxed);
        let _guard = ResetKeepalive;

        let (endpoint, _server) = serve(axum::Router::new().route(
            "/v1/responses",
            post(|| async {
                let output = async_stream::stream! {
                    tokio::time::sleep(Duration::from_millis(180)).await;
                    yield Ok::<_, std::io::Error>(Bytes::from_static(
                        b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n",
                    ));
                    yield Ok(Bytes::from_static(
                        b"data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"output_tokens\":1}}}\n\n",
                    ));
                };
                ([("content-type", "text/event-stream")], Body::from_stream(output))
            }),
        ))
        .await;

        // Enabled: injects `: keepalive\n\n` while keeping first_token_ms unpolluted.
        let (_dir_on, state_on) = fixture(&[endpoint.clone()]);
        state_on
            .store
            .update(|config| {
                config.groups[0].sse_keepalive_enabled = true;
                Ok(())
            })
            .unwrap();
        let resp_on = call(
            state_on.clone(),
            "/v1/responses",
            json!({"model": "chosen", "stream": true}),
        )
        .await;
        assert_eq!(resp_on.status(), StatusCode::OK);
        let body_on = axum::body::to_bytes(resp_on.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let text_on = String::from_utf8_lossy(&body_on);
        assert!(
            text_on.contains(": keepalive\n\n"),
            "expected keepalive comment in SSE body, got: {text_on}"
        );
        assert!(text_on.contains("response.completed"));
        let logs_on = state_on.store.logs(0, store::now() + 10).unwrap();
        assert_eq!(logs_on.len(), 1);
        assert!(
            logs_on[0].first_token_ms.unwrap() >= 140,
            "first_token_ms was polluted by keepalive: {:?}",
            logs_on[0].first_token_ms
        );
        assert_eq!(logs_on[0].attempt_details.len(), 1);
        assert!(
            logs_on[0].attempt_details[0].first_byte_ms.unwrap() >= 140,
            "first_byte_ms was polluted by keepalive: {:?}",
            logs_on[0].attempt_details[0].first_byte_ms
        );

        // Disabled: pure passthrough with zero keepalive comments.
        let (_dir_off, state_off) = fixture(&[endpoint]);
        state_off
            .store
            .update(|config| {
                config.groups[0].sse_keepalive_enabled = false;
                Ok(())
            })
            .unwrap();
        let resp_off = call(
            state_off.clone(),
            "/v1/responses",
            json!({"model": "chosen", "stream": true}),
        )
        .await;
        assert_eq!(resp_off.status(), StatusCode::OK);
        let body_off = axum::body::to_bytes(resp_off.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let text_off = String::from_utf8_lossy(&body_off);
        assert!(
            !text_off.contains(": keepalive"),
            "keepalive should not be injected when disabled: {text_off}"
        );
    }

    #[tokio::test]
    async fn staged_timeout_keeps_slow_chunked_stream_alive_and_records_attempt_details() {
        use axum::routing::post;
        let (ep_fail, _srv_fail) = serve(axum::Router::new().route(
            "/v1/responses",
            post(|| async { (StatusCode::SERVICE_UNAVAILABLE, "temporary outage") }),
        ))
        .await;
        let (ep_slow, _srv_slow) = serve(axum::Router::new().route(
            "/v1/responses",
            post(|| async {
                let output = async_stream::stream! {
                    tokio::time::sleep(Duration::from_millis(450)).await;
                    yield Ok::<_, std::io::Error>(Bytes::from_static(
                        b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"part1\"}\n\n",
                    ));
                    tokio::time::sleep(Duration::from_millis(450)).await;
                    yield Ok(Bytes::from_static(
                        b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"part2\"}\n\n",
                    ));
                    tokio::time::sleep(Duration::from_millis(450)).await;
                    yield Ok(Bytes::from_static(
                        b"data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"output_tokens\":2}}}\n\n",
                    ));
                };
                ([("content-type", "text/event-stream")], Body::from_stream(output))
            }),
        ))
        .await;

        let (_dir, state) = fixture(&[ep_fail, ep_slow]);
        state
            .store
            .update(|config| {
                config.settings.request_timeout_seconds = 1;
                config.settings.max_retries = 1;
                config.groups[0].staged_timeout_enabled = true;
                config.groups[0].smart_cooldown_enabled = true;
                Ok(())
            })
            .unwrap();

        let response = call(
            state.clone(),
            "/v1/responses",
            json!({"model": "chosen", "stream": true}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("part1"));
        assert!(text.contains("part2"));
        assert!(text.contains("response.completed"));

        let logs = state.store.logs(0, store::now() + 10).unwrap();
        assert_eq!(logs.len(), 1);
        let log = &logs[0];
        assert_eq!(log.status, 200);
        assert_eq!(log.attempts, 2);
        assert_eq!(log.attempt_details.len(), 2);

        let a1 = &log.attempt_details[0];
        assert_eq!(a1.index, 1);
        assert_eq!(a1.outcome, "failed");
        assert_eq!(a1.upstream_status, Some(503));
        assert_eq!(a1.error_stage.as_deref(), Some("http_status"));
        assert!(a1.headers_ms.is_some());

        let a2 = &log.attempt_details[1];
        assert_eq!(a2.index, 2);
        assert_eq!(a2.outcome, "success");
        assert_eq!(a2.upstream_status, Some(200));
        assert!(a2.headers_ms.is_some());
        assert!(a2.first_byte_ms.is_some());
        assert!(a2.error.is_none());
        assert!(a2.total_ms >= 1200, "expected slow stream total >= 1200ms, got {}", a2.total_ms);
    }
}
