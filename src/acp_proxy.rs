use crate::{ApiError, Shared};
use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use futures_util::TryStreamExt;
use std::{
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

const DEFAULT_ACP_UPSTREAM_BASE: &str = "http://127.0.0.1:8048";
const DEFAULT_AISTUDIO_UPSTREAM_BASE: &str = "http://127.0.0.1:2048";
const AISTUDIO_GATEWAY_LABEL: &str = "2048 AIStudio gateway";
const AISTUDIO_PRE_REFRESH_BUFFER: Duration = Duration::from_secs(60);
const AISTUDIO_AUTH_MODE_HEADER: &str = "x-aistudio-auth-mode";
const AISTUDIO_LOGOUT_CLEAR_COOKIE: &str =
    "aistudio_admin=; Path=/aistudio-api; Max-Age=0; HttpOnly; SameSite=Strict";

#[derive(Debug, Clone)]
struct CachedAistudioCookie {
    upstream_base: String,
    cookie: String,
    generation: u64,
    expires_at: Option<Instant>,
}

static ACP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static AISTUDIO_ADMIN_COOKIE: OnceLock<tokio::sync::RwLock<Option<CachedAistudioCookie>>> =
    OnceLock::new();
static AISTUDIO_LOGIN_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static AISTUDIO_COOKIE_GEN: AtomicU64 = AtomicU64::new(0);

fn aistudio_cookie_cache() -> &'static tokio::sync::RwLock<Option<CachedAistudioCookie>> {
    AISTUDIO_ADMIN_COOKIE.get_or_init(|| tokio::sync::RwLock::new(None))
}

fn aistudio_login_lock() -> &'static tokio::sync::Mutex<()> {
    AISTUDIO_LOGIN_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn client() -> &'static reqwest::Client {
    ACP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("failed to build ACP proxy reqwest client")
    })
}

fn upstream_base_from_env(env_key: &str, default_base: &str) -> String {
    std::env::var(env_key)
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_base.to_owned())
}

fn is_hop_by_hop_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "trailers"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn should_strip_request_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "host" | "cookie" | "x-console-path"
    ) || is_hop_by_hop_header(&lower)
}

fn build_target_url(base: &str, prefix: &str, uri: &Uri) -> String {
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or_else(|| uri.path());
    let stripped = path_and_query
        .strip_prefix(prefix)
        .unwrap_or(path_and_query);
    if stripped.is_empty() {
        format!("{base}/")
    } else if stripped.starts_with('?') {
        format!("{base}/{stripped}")
    } else {
        format!("{base}{stripped}")
    }
}

fn forward_request_headers(headers: &HeaderMap, method: &Method) -> reqwest::header::HeaderMap {
    let strip_content_length = *method == Method::GET || *method == Method::HEAD;
    let mut out = reqwest::header::HeaderMap::new();
    for (name, value) in headers {
        if should_strip_request_header(name.as_str()) {
            continue;
        }
        if strip_content_length && name.as_str().eq_ignore_ascii_case("content-length") {
            continue;
        }
        if let (Ok(req_name), Ok(req_val)) = (
            reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes()),
            reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            out.append(req_name, req_val);
        }
    }
    out
}

async fn proxy_with_config(
    state: Shared,
    req: Request,
    prefix: &str,
    env_key: &str,
    default_base: &str,
    gateway_label: &str,
) -> Result<Response, ApiError> {
    if let Err(err) = crate::api::auth(&state, req.headers()) {
        let mut resp = err.into_response();
        if resp.status() == StatusCode::UNAUTHORIZED {
            resp.headers_mut().insert(
                HeaderName::from_static("x-zako-auth-error"),
                HeaderValue::from_static("session_expired"),
            );
        }
        return Ok(resp);
    }

    let base = upstream_base_from_env(env_key, default_base);
    let target_url = build_target_url(&base, prefix, req.uri());
    let method = reqwest::Method::from_bytes(req.method().as_str().as_bytes())
        .unwrap_or(reqwest::Method::GET);
    let headers = forward_request_headers(req.headers(), req.method());

    let mut builder = client().request(method, &target_url).headers(headers);
    if *req.method() != Method::GET && *req.method() != Method::HEAD {
        let stream = req
            .into_body()
            .into_data_stream()
            .map_err(std::io::Error::other);
        builder = builder.body(reqwest::Body::wrap_stream(stream));
    }

    let upstream_resp = builder.send().await.map_err(|err| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            format!("{gateway_label} unreachable: {err}"),
        )
    })?;

    let status = StatusCode::from_u16(upstream_resp.status().as_u16())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let mut resp_headers = HeaderMap::new();
    for (name, value) in upstream_resp.headers() {
        if is_hop_by_hop_header(name.as_str()) {
            continue;
        }
        if let (Ok(axum_name), Ok(axum_val)) = (
            HeaderName::from_bytes(name.as_str().as_bytes()),
            HeaderValue::from_bytes(value.as_bytes()),
        ) {
            resp_headers.append(axum_name, axum_val);
        }
    }

    let body = Body::from_stream(upstream_resp.bytes_stream());
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = resp_headers;
    Ok(response)
}

pub async fn handle(State(state): State<Shared>, req: Request) -> Result<Response, ApiError> {
    proxy_with_config(
        state,
        req,
        "/acp-api",
        "ACP_UPSTREAM_BASE",
        DEFAULT_ACP_UPSTREAM_BASE,
        "8048 ACP gateway",
    )
    .await
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AistudioAdminCreds {
    username: String,
    password: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AistudioEnvCreds {
    Disabled,
    Creds(AistudioAdminCreds),
    Missing,
}

fn parse_aistudio_env_contents(contents: &str) -> AistudioEnvCreds {
    let mut username: Option<String> = None;
    let mut password: Option<String> = None;
    let mut auth_enabled: Option<bool> = None;

    for item in dotenvy::from_read_iter(contents.as_bytes()) {
        let Ok((key, value)) = item else {
            continue;
        };
        let trimmed = value.trim();
        match key.as_str() {
            "ADMIN_AUTH_ENABLED" => {
                if trimmed.eq_ignore_ascii_case("false") {
                    auth_enabled = Some(false);
                } else if trimmed.eq_ignore_ascii_case("true") {
                    auth_enabled = Some(true);
                }
            }
            "ADMIN_USERNAME" if !trimmed.is_empty() => {
                username = Some(trimmed.to_owned());
            }
            "ADMIN_PASSWORD" if !trimmed.is_empty() => {
                password = Some(trimmed.to_owned());
            }
            _ => {}
        }
    }

    if auth_enabled == Some(false) {
        return AistudioEnvCreds::Disabled;
    }
    match (username, password) {
        (Some(username), Some(password)) => {
            AistudioEnvCreds::Creds(AistudioAdminCreds { username, password })
        }
        _ => AistudioEnvCreds::Missing,
    }
}

fn aistudio_env_candidate_paths() -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    if let Ok(env_file) = std::env::var("AISTUDIO_ENV_FILE") {
        let trimmed = env_file.trim();
        if !trimmed.is_empty() {
            paths.push(std::path::PathBuf::from(trimmed));
        }
    }
    if let Some(profile) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        paths.push(
            std::path::PathBuf::from(profile)
                .join(".local")
                .join("share")
                .join("magpie-ai-studio")
                .join(".env"),
        );
    }
    paths.push(
        std::path::PathBuf::from("magpie-aistudio-2048")
            .join("data")
            .join(".env"),
    );
    paths
}

fn load_aistudio_admin_creds() -> Option<AistudioAdminCreds> {
    if let (Ok(username), Ok(password)) = (
        std::env::var("AISTUDIO_ADMIN_USERNAME"),
        std::env::var("AISTUDIO_ADMIN_PASSWORD"),
    ) {
        let username = username.trim();
        let password = password.trim();
        if !username.is_empty() && !password.is_empty() {
            return Some(AistudioAdminCreds {
                username: username.to_owned(),
                password: password.to_owned(),
            });
        }
    }

    for path in aistudio_env_candidate_paths() {
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        match parse_aistudio_env_contents(&contents) {
            AistudioEnvCreds::Disabled => return None,
            AistudioEnvCreds::Creds(creds) => return Some(creds),
            AistudioEnvCreds::Missing => continue,
        }
    }
    None
}

fn extract_aistudio_admin_cookie(headers: &HeaderMap) -> Option<String> {
    for value in headers.get_all("cookie") {
        let Ok(raw) = value.to_str() else {
            continue;
        };
        for pair in raw.split(';') {
            let trimmed = pair.trim();
            if let Some((name, val)) = trimmed.split_once('=')
                && name.trim() == "aistudio_admin"
            {
                let val = val.trim();
                if !val.is_empty() {
                    return Some(format!("aistudio_admin={val}"));
                }
            }
        }
    }
    None
}

fn extract_aistudio_cookie_from_set_cookie(
    headers: &reqwest::header::HeaderMap,
) -> Option<(String, Option<Duration>)> {
    for value in headers.get_all(reqwest::header::SET_COOKIE) {
        let Ok(raw) = value.to_str() else {
            continue;
        };
        let mut parts = raw.split(';');
        let first_pair = parts.next().map(str::trim).unwrap_or("");
        if let Some((name, val)) = first_pair.split_once('=')
            && name.trim() == "aistudio_admin"
        {
            let val = val.trim();
            if !val.is_empty() {
                let mut max_age = None;
                for attr in parts {
                    let trimmed = attr.trim();
                    if let Some((attr_name, attr_val)) = trimmed.split_once('=')
                        && attr_name.trim().eq_ignore_ascii_case("max-age")
                        && let Ok(secs) = attr_val.trim().parse::<i64>()
                    {
                        max_age = Some(if secs <= 0 {
                            Duration::ZERO
                        } else {
                            Duration::from_secs(secs as u64)
                        });
                    }
                }
                return Some((format!("aistudio_admin={val}"), max_age));
            }
        }
    }
    None
}

fn rewrite_aistudio_set_cookie(raw: &str) -> String {
    let mut saw_path = false;
    let mut parts: Vec<String> = raw
        .split(';')
        .map(|part| {
            let trimmed = part.trim();
            if let Some((attr_name, attr_val)) = trimmed.split_once('=')
                && attr_name.trim().eq_ignore_ascii_case("path")
            {
                saw_path = true;
                let path_val = attr_val.trim();
                if path_val == "/api" || path_val == "/api/" {
                    return "Path=/aistudio-api".to_owned();
                }
                if let Some(rest) = path_val.strip_prefix("/api/") {
                    return format!("Path=/aistudio-api/{rest}");
                }
                return "Path=/aistudio-api".to_owned();
            }
            trimmed.to_owned()
        })
        .filter(|part| !part.is_empty())
        .collect();
    if !saw_path {
        parts.push("Path=/aistudio-api".to_owned());
    }
    parts.join("; ")
}

fn is_aistudio_admin_set_cookie(raw: &str) -> bool {
    let first_pair = raw.split(';').next().map(str::trim).unwrap_or("");
    matches!(
        first_pair.split_once('='),
        Some((name, _)) if name.trim() == "aistudio_admin"
    )
}

fn is_aistudio_logout_path(uri: &Uri) -> bool {
    let path = uri.path();
    let stripped = path.strip_prefix("/aistudio-api").unwrap_or(path);
    stripped == "/api/auth/logout"
}

fn is_aistudio_auto_auth_path(uri: &Uri) -> bool {
    let path = uri.path();
    let stripped = path.strip_prefix("/aistudio-api").unwrap_or(path);
    stripped.starts_with("/api/")
        && stripped != "/api/auth/login"
        && stripped != "/api/auth/logout"
}

fn extract_upstream_origin(upstream_base: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(upstream_base).ok()?;
    let origin = parsed.origin().ascii_serialization();
    if origin == "null" {
        None
    } else {
        Some(origin)
    }
}

fn rewrite_aistudio_origin_headers(
    headers: &mut reqwest::header::HeaderMap,
    upstream_base: &str,
) {
    headers.remove(reqwest::header::ORIGIN);
    headers.remove(reqwest::header::REFERER);
    headers.remove("sec-fetch-site");
    headers.remove("sec-fetch-mode");
    headers.remove("sec-fetch-dest");

    if let Some(origin) = extract_upstream_origin(upstream_base) {
        if let Ok(origin_val) = reqwest::header::HeaderValue::from_str(&origin) {
            headers.insert(reqwest::header::ORIGIN, origin_val);
        }
        let referer = format!("{origin}/");
        if let Ok(referer_val) = reqwest::header::HeaderValue::from_str(&referer) {
            headers.insert(reqwest::header::REFERER, referer_val);
        }
        headers.insert(
            reqwest::header::HeaderName::from_static("sec-fetch-site"),
            reqwest::header::HeaderValue::from_static("same-origin"),
        );
    }
}

fn build_aistudio_response_headers(upstream_headers: &reqwest::header::HeaderMap) -> HeaderMap {
    let mut resp_headers = HeaderMap::new();
    for (name, value) in upstream_headers {
        if is_hop_by_hop_header(name.as_str()) {
            continue;
        }
        if name.as_str().eq_ignore_ascii_case("set-cookie") {
            if let Ok(raw) = value.to_str()
                && is_aistudio_admin_set_cookie(raw)
            {
                let rewritten = rewrite_aistudio_set_cookie(raw);
                if let Ok(axum_val) = HeaderValue::from_str(&rewritten) {
                    resp_headers.append(axum::http::header::SET_COOKIE, axum_val);
                }
            }
            continue;
        }
        if let (Ok(axum_name), Ok(axum_val)) = (
            HeaderName::from_bytes(name.as_str().as_bytes()),
            HeaderValue::from_bytes(value.as_bytes()),
        ) {
            resp_headers.append(axum_name, axum_val);
        }
    }
    resp_headers
}

fn is_cached_cookie_valid(entry: &CachedAistudioCookie, base: &str, now: Instant) -> bool {
    if entry.upstream_base != base {
        return false;
    }
    match entry.expires_at {
        Some(exp) => exp.saturating_duration_since(now) > AISTUDIO_PRE_REFRESH_BUFFER,
        None => true,
    }
}

async fn login_aistudio_admin_locked(
    base: &str,
    creds: &AistudioAdminCreds,
) -> Result<Option<(String, u64)>, ApiError> {
    let login_url = format!("{base}/api/auth/login");
    let resp = client()
        .post(&login_url)
        .timeout(Duration::from_secs(15))
        .json(&serde_json::json!({
            "username": creds.username,
            "password": creds.password,
        }))
        .send()
        .await
        .map_err(|err| {
            ApiError(
                StatusCode::BAD_GATEWAY,
                format!("{AISTUDIO_GATEWAY_LABEL} unreachable: {err}"),
            )
        })?;

    if !resp.status().is_success() {
        tracing::warn!(
            status = %resp.status(),
            "AIStudio admin auto-login did not succeed"
        );
        return Ok(None);
    }

    if let Some((c, max_age)) = extract_aistudio_cookie_from_set_cookie(resp.headers()) {
        let generation = AISTUDIO_COOKIE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        let now = Instant::now();
        let entry = CachedAistudioCookie {
            upstream_base: base.to_owned(),
            cookie: c.clone(),
            generation,
            expires_at: max_age.map(|d| now + d),
        };
        *aistudio_cookie_cache().write().await = Some(entry);
        Ok(Some((c, generation)))
    } else {
        Ok(None)
    }
}

async fn get_or_refresh_aistudio_cookie(
    base: &str,
    creds: &AistudioAdminCreds,
) -> Result<Option<(String, u64)>, ApiError> {
    {
        let guard = aistudio_cookie_cache().read().await;
        if let Some(entry) = guard.as_ref()
            && is_cached_cookie_valid(entry, base, Instant::now())
        {
            return Ok(Some((entry.cookie.clone(), entry.generation)));
        }
    }

    let _login_guard = aistudio_login_lock().lock().await;
    {
        let guard = aistudio_cookie_cache().read().await;
        if let Some(entry) = guard.as_ref()
            && is_cached_cookie_valid(entry, base, Instant::now())
        {
            return Ok(Some((entry.cookie.clone(), entry.generation)));
        }
    }
    login_aistudio_admin_locked(base, creds).await
}

async fn invalidate_aistudio_cookie_if_generation(used_generation: u64) {
    let mut guard = aistudio_cookie_cache().write().await;
    if let Some(entry) = guard.as_ref()
        && entry.generation == used_generation
    {
        *guard = None;
    }
}

async fn refresh_aistudio_cookie_on_unauthorized(
    base: &str,
    used_generation: u64,
    creds: &AistudioAdminCreds,
) -> Result<Option<(String, u64)>, ApiError> {
    let _login_guard = aistudio_login_lock().lock().await;
    {
        let mut guard = aistudio_cookie_cache().write().await;
        if let Some(entry) = guard.as_ref() {
            if entry.generation == used_generation {
                *guard = None;
            } else if is_cached_cookie_valid(entry, base, Instant::now()) {
                return Ok(Some((entry.cookie.clone(), entry.generation)));
            } else {
                *guard = None;
            }
        }
    }
    login_aistudio_admin_locked(base, creds).await
}

pub async fn handle_aistudio(
    State(state): State<Shared>,
    req: Request,
) -> Result<Response, ApiError> {
    if let Err(err) = crate::api::auth(&state, req.headers()) {
        let mut resp = err.into_response();
        if resp.status() == StatusCode::UNAUTHORIZED {
            resp.headers_mut().insert(
                HeaderName::from_static("x-zako-auth-error"),
                HeaderValue::from_static("session_expired"),
            );
        }
        return Ok(resp);
    }

    let creds = load_aistudio_admin_creds();
    let is_managed = creds.is_some();
    let auth_mode = if is_managed { "managed" } else { "manual" };

    let client_cookie = extract_aistudio_admin_cookie(req.headers());
    let clear_stale_browser_cookie = is_managed && client_cookie.is_some();

    if is_aistudio_logout_path(req.uri()) && is_managed {
        *aistudio_cookie_cache().write().await = None;
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NO_CONTENT;
        response.headers_mut().insert(
            axum::http::header::SET_COOKIE,
            HeaderValue::from_static(AISTUDIO_LOGOUT_CLEAR_COOKIE),
        );
        response.headers_mut().insert(
            HeaderName::from_static(AISTUDIO_AUTH_MODE_HEADER),
            HeaderValue::from_static(auth_mode),
        );
        return Ok(response);
    }

    let base = upstream_base_from_env("AISTUDIO_UPSTREAM_BASE", DEFAULT_AISTUDIO_UPSTREAM_BASE);
    let target_url = build_target_url(&base, "/aistudio-api", req.uri());
    let req_method = req.method().clone();
    let method = reqwest::Method::from_bytes(req_method.as_str().as_bytes())
        .unwrap_or(reqwest::Method::GET);
    let is_retryable = req_method == Method::GET || req_method == Method::HEAD;

    let mut used_server_generation: Option<u64> = None;
    let cookie_to_send = if let Some(ref c_creds) = creds {
        if is_aistudio_auto_auth_path(req.uri()) {
            if let Some((c, generation)) = get_or_refresh_aistudio_cookie(&base, c_creds).await? {
                used_server_generation = Some(generation);
                Some(c)
            } else {
                None
            }
        } else {
            None
        }
    } else {
        client_cookie
    };

    let mut base_headers = forward_request_headers(req.headers(), &req_method);
    rewrite_aistudio_origin_headers(&mut base_headers, &base);
    let mut headers = base_headers.clone();
    if let Some(ref cookie) = cookie_to_send
        && let Ok(val) = reqwest::header::HeaderValue::from_str(cookie)
    {
        headers.insert(reqwest::header::COOKIE, val);
    }

    let mut builder = client().request(method.clone(), &target_url).headers(headers);
    if req_method != Method::GET && req_method != Method::HEAD {
        let stream = req
            .into_body()
            .into_data_stream()
            .map_err(std::io::Error::other);
        builder = builder.body(reqwest::Body::wrap_stream(stream));
    }

    let mut upstream_resp = builder.send().await.map_err(|err| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            format!("{AISTUDIO_GATEWAY_LABEL} unreachable: {err}"),
        )
    })?;

    if upstream_resp.status() == reqwest::StatusCode::UNAUTHORIZED
        && let Some(used_gen) = used_server_generation
    {
        if !is_retryable {
            invalidate_aistudio_cookie_if_generation(used_gen).await;
        } else {
            let resp_headers = build_aistudio_response_headers(upstream_resp.headers());
            let body_bytes = upstream_resp.bytes().await.map_err(|err| {
                ApiError(
                    StatusCode::BAD_GATEWAY,
                    format!("{AISTUDIO_GATEWAY_LABEL} read failed: {err}"),
                )
            })?;
            let is_admin_login_required = req_method == Method::HEAD
                || body_bytes
                    .windows(b"admin_login_required".len())
                    .any(|w| w == b"admin_login_required");

            if is_admin_login_required
                && let Some(ref c_creds) = creds
                && let Some((new_cookie, _)) =
                    refresh_aistudio_cookie_on_unauthorized(&base, used_gen, c_creds).await?
            {
                let mut retry_headers = base_headers;
                if let Ok(val) = reqwest::header::HeaderValue::from_str(&new_cookie) {
                    retry_headers.insert(reqwest::header::COOKIE, val);
                }
                upstream_resp = client()
                    .request(method, &target_url)
                    .headers(retry_headers)
                    .send()
                    .await
                    .map_err(|err| {
                        ApiError(
                            StatusCode::BAD_GATEWAY,
                            format!("{AISTUDIO_GATEWAY_LABEL} unreachable: {err}"),
                        )
                    })?;
            } else {
                let mut response = Response::new(Body::from(body_bytes));
                *response.status_mut() = StatusCode::UNAUTHORIZED;
                *response.headers_mut() = resp_headers;
                response.headers_mut().insert(
                    HeaderName::from_static(AISTUDIO_AUTH_MODE_HEADER),
                    HeaderValue::from_static(auth_mode),
                );
                if clear_stale_browser_cookie {
                    response.headers_mut().append(
                        axum::http::header::SET_COOKIE,
                        HeaderValue::from_static(AISTUDIO_LOGOUT_CLEAR_COOKIE),
                    );
                }
                return Ok(response);
            }
        }
    }

    let status = StatusCode::from_u16(upstream_resp.status().as_u16())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let mut resp_headers = build_aistudio_response_headers(upstream_resp.headers());
    resp_headers.insert(
        HeaderName::from_static(AISTUDIO_AUTH_MODE_HEADER),
        HeaderValue::from_static(auth_mode),
    );
    if clear_stale_browser_cookie {
        resp_headers.append(
            axum::http::header::SET_COOKIE,
            HeaderValue::from_static(AISTUDIO_LOGOUT_CLEAR_COOKIE),
        );
    }

    let body = Body::from_stream(upstream_resp.bytes_stream());
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = resp_headers;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_target_url_for_aistudio_strips_prefix_and_preserves_query() {
        let base = DEFAULT_AISTUDIO_UPSTREAM_BASE;
        assert_eq!(
            build_target_url(base, "/aistudio-api", &"/aistudio-api".parse().unwrap()),
            "http://127.0.0.1:2048/"
        );
        assert_eq!(
            build_target_url(
                base,
                "/aistudio-api",
                &"/aistudio-api/api/status".parse().unwrap()
            ),
            "http://127.0.0.1:2048/api/status"
        );
        assert_eq!(
            build_target_url(
                base,
                "/aistudio-api",
                &"/aistudio-api/api/usage?from=2026-11-21T00:00:00Z&to=2026-11-22T00:00:00Z"
                    .parse()
                    .unwrap()
            ),
            "http://127.0.0.1:2048/api/usage?from=2026-11-21T00:00:00Z&to=2026-11-22T00:00:00Z"
        );
    }

    #[test]
    fn extract_aistudio_admin_cookie_strips_8046_and_other_cookies() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            HeaderValue::from_static("zako_session=secret8046; aistudio_admin=tok123; theme=dark"),
        );
        assert_eq!(
            extract_aistudio_admin_cookie(&headers),
            Some("aistudio_admin=tok123".to_owned())
        );

        let mut only_8046 = HeaderMap::new();
        only_8046.insert("cookie", HeaderValue::from_static("zako_session=secret8046"));
        assert_eq!(extract_aistudio_admin_cookie(&only_8046), None);
    }

    #[test]
    fn rewrite_aistudio_set_cookie_rewrites_path_case_insensitively_and_preserves_attrs() {
        let raw = "aistudio_admin=RANDOM_TOKEN; Path=/api; Max-Age=43200; HttpOnly; SameSite=Strict";
        assert_eq!(
            rewrite_aistudio_set_cookie(raw),
            "aistudio_admin=RANDOM_TOKEN; Path=/aistudio-api; Max-Age=43200; HttpOnly; SameSite=Strict"
        );

        let lower = "aistudio_admin=; path=/api; Max-Age=0; HttpOnly; SameSite=Strict";
        assert_eq!(
            rewrite_aistudio_set_cookie(lower),
            "aistudio_admin=; Path=/aistudio-api; Max-Age=0; HttpOnly; SameSite=Strict"
        );
    }

    #[test]
    fn parse_aistudio_env_contents_handles_creds_and_disabled_flag() {
        let enabled_env = "ADMIN_AUTH_ENABLED=true\nADMIN_USERNAME=magpie\nADMIN_PASSWORD=secret\n";
        assert_eq!(
            parse_aistudio_env_contents(enabled_env),
            AistudioEnvCreds::Creds(AistudioAdminCreds {
                username: "magpie".to_owned(),
                password: "secret".to_owned(),
            })
        );

        let disabled_env = "ADMIN_AUTH_ENABLED=false\nADMIN_USERNAME=magpie\nADMIN_PASSWORD=secret\n";
        assert_eq!(
            parse_aistudio_env_contents(disabled_env),
            AistudioEnvCreds::Disabled
        );
    }

    #[tokio::test]
    async fn unauthenticated_aistudio_request_returns_401_with_session_expired_header() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::new_app(dir.path(), dir.path().join("web")).unwrap();
        let req = axum::http::Request::builder()
            .method(Method::GET)
            .uri("/aistudio-api/api/status")
            .body(Body::empty())
            .unwrap();

        let resp = handle_aistudio(State(state), req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            resp.headers().get("x-zako-auth-error").unwrap(),
            "session_expired"
        );

        let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let json_body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json_body.get("error").and_then(|v| v.as_str()).is_some());
    }

    static TEST_CACHE_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

    fn test_cache_lock() -> &'static tokio::sync::Mutex<()> {
        TEST_CACHE_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
    }

    #[tokio::test]
    async fn generation_matched_401_invalidation_does_not_clear_newer_generation() {
        let _guard = test_cache_lock().lock().await;
        let gen1 = AISTUDIO_COOKIE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        let gen2 = AISTUDIO_COOKIE_GEN.fetch_add(1, Ordering::SeqCst) + 1;

        *aistudio_cookie_cache().write().await = Some(CachedAistudioCookie {
            upstream_base: "http://127.0.0.1:2048".to_owned(),
            cookie: "aistudio_admin=fresh_tok".to_owned(),
            generation: gen2,
            expires_at: Some(Instant::now() + Duration::from_secs(3600)),
        });

        // Stale 401 from gen1 must NOT clear gen2.
        invalidate_aistudio_cookie_if_generation(gen1).await;
        {
            let guard = aistudio_cookie_cache().read().await;
            let entry = guard.as_ref().expect("gen2 cache should still exist");
            assert_eq!(entry.generation, gen2);
            assert_eq!(entry.cookie, "aistudio_admin=fresh_tok");
        }

        // Refresh on 401 from gen1 should reuse gen2 without hitting upstream.
        let creds = AistudioAdminCreds {
            username: "admin".to_owned(),
            password: "pw".to_owned(),
        };
        let reused = refresh_aistudio_cookie_on_unauthorized(
            "http://127.0.0.1:2048",
            gen1,
            &creds,
        )
        .await
        .unwrap();
        assert_eq!(reused, Some(("aistudio_admin=fresh_tok".to_owned(), gen2)));

        // Matching gen2 401 DOES clear the cache.
        invalidate_aistudio_cookie_if_generation(gen2).await;
        assert!(aistudio_cookie_cache().read().await.is_none());
    }

    #[test]
    fn rewrite_aistudio_set_cookie_handles_non_ascii_attributes_without_panic() {
        let raw = "aistudio_admin=tok123; 中文属性=值; 非ASCII无等号; path=/api/sub; HttpOnly";
        assert_eq!(
            rewrite_aistudio_set_cookie(raw),
            "aistudio_admin=tok123; 中文属性=值; 非ASCII无等号; Path=/aistudio-api/sub; HttpOnly"
        );
    }

    #[test]
    fn build_aistudio_response_headers_allows_only_aistudio_admin_set_cookie() {
        let mut upstream = reqwest::header::HeaderMap::new();
        upstream.append(
            reqwest::header::SET_COOKIE,
            reqwest::header::HeaderValue::from_static(
                "aistudio_admin=tok123; Path=/api; HttpOnly; SameSite=Strict",
            ),
        );
        upstream.append(
            reqwest::header::SET_COOKIE,
            reqwest::header::HeaderValue::from_static("zako_session=secret; Path=/; HttpOnly"),
        );
        upstream.append(
            reqwest::header::SET_COOKIE,
            reqwest::header::HeaderValue::from_static("other_cookie=abc; Path=/"),
        );
        upstream.append(
            reqwest::header::SET_COOKIE,
            reqwest::header::HeaderValue::from_bytes(b"bad_cookie=\xff\xfe; Path=/").unwrap(),
        );
        upstream.insert("content-type", reqwest::header::HeaderValue::from_static("application/json"));

        let resp_headers = build_aistudio_response_headers(&upstream);
        let set_cookies: Vec<&str> = resp_headers
            .get_all(axum::http::header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect();
        assert_eq!(
            set_cookies,
            vec!["aistudio_admin=tok123; Path=/aistudio-api; HttpOnly; SameSite=Strict"]
        );
        assert_eq!(
            resp_headers.get("content-type").unwrap(),
            "application/json"
        );
    }

    #[test]
    fn rewrite_aistudio_set_cookie_forces_aistudio_api_path_when_root_or_missing() {
        assert_eq!(
            rewrite_aistudio_set_cookie("aistudio_admin=tok123; Path=/; HttpOnly"),
            "aistudio_admin=tok123; Path=/aistudio-api; HttpOnly"
        );
        assert_eq!(
            rewrite_aistudio_set_cookie("aistudio_admin=tok123; HttpOnly"),
            "aistudio_admin=tok123; HttpOnly; Path=/aistudio-api"
        );
    }

    #[test]
    fn extract_aistudio_cookie_parses_max_age_and_validates_pre_refresh_buffer() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.append(
            reqwest::header::SET_COOKIE,
            reqwest::header::HeaderValue::from_static(
                "aistudio_admin=tok_abc; Path=/api; max-age=43200; HttpOnly",
            ),
        );
        let parsed = extract_aistudio_cookie_from_set_cookie(&headers);
        assert_eq!(
            parsed,
            Some((
                "aistudio_admin=tok_abc".to_owned(),
                Some(Duration::from_secs(43200))
            ))
        );

        let now = Instant::now();
        let fresh = CachedAistudioCookie {
            upstream_base: "http://127.0.0.1:2048".to_owned(),
            cookie: "aistudio_admin=tok_abc".to_owned(),
            generation: 1,
            expires_at: Some(now + Duration::from_secs(120)),
        };
        assert!(is_cached_cookie_valid(&fresh, "http://127.0.0.1:2048", now));

        let near_expiry = CachedAistudioCookie {
            upstream_base: "http://127.0.0.1:2048".to_owned(),
            cookie: "aistudio_admin=tok_abc".to_owned(),
            generation: 1,
            expires_at: Some(now + Duration::from_secs(60)),
        };
        assert!(!is_cached_cookie_valid(
            &near_expiry,
            "http://127.0.0.1:2048",
            now
        ));

        let no_max_age = CachedAistudioCookie {
            upstream_base: "http://127.0.0.1:2048".to_owned(),
            cookie: "aistudio_admin=tok_abc".to_owned(),
            generation: 1,
            expires_at: None,
        };
        assert!(is_cached_cookie_valid(
            &no_max_age,
            "http://127.0.0.1:2048",
            now
        ));
    }

    #[test]
    fn rewrite_aistudio_origin_headers_enforces_upstream_same_origin() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::ORIGIN,
            reqwest::header::HeaderValue::from_static("http://127.0.0.1:8046"),
        );
        headers.insert(
            reqwest::header::REFERER,
            reqwest::header::HeaderValue::from_static("http://127.0.0.1:8046/secret-entry"),
        );
        headers.insert(
            "sec-fetch-site",
            reqwest::header::HeaderValue::from_static("cross-site"),
        );
        headers.insert(
            "sec-fetch-mode",
            reqwest::header::HeaderValue::from_static("cors"),
        );
        headers.insert(
            "sec-fetch-dest",
            reqwest::header::HeaderValue::from_static("empty"),
        );
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json"),
        );

        rewrite_aistudio_origin_headers(&mut headers, "http://127.0.0.1:2048/subpath");

        assert_eq!(
            headers.get(reqwest::header::ORIGIN).unwrap(),
            "http://127.0.0.1:2048"
        );
        assert_eq!(
            headers.get(reqwest::header::REFERER).unwrap(),
            "http://127.0.0.1:2048/"
        );
        assert_eq!(headers.get("sec-fetch-site").unwrap(), "same-origin");
        assert!(headers.get("sec-fetch-mode").is_none());
        assert!(headers.get("sec-fetch-dest").is_none());
        assert_eq!(
            headers.get(reqwest::header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
    }
}
