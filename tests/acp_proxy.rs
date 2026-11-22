use axum::{
    Router,
    body::{Body, to_bytes},
    extract::Request as AxumRequest,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use futures_util::stream;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower::ServiceExt;
use multi_acp_gateway::{Shared, app, new_app};

static ENV_LOCK: Mutex<()> = Mutex::const_new(());

fn fixture() -> (tempfile::TempDir, Shared) {
    let dir = tempfile::tempdir().unwrap();
    let state = new_app(dir.path(), dir.path().join("web")).unwrap();
    (dir, state)
}

async fn setup_cookie(state: &Shared) -> String {
    let response = app(state.clone())
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/setup")
                .header("content-type", "application/json")
                .header("x-console-path", "/")
                .body(Body::from(
                    json!({"username":"admin","password":"integration-password-123"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response
        .headers()
        .get("set-cookie")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .to_owned()
}

struct EnvGuard {
    key: &'static str,
    prev: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, val: &str) -> Self {
        let prev = std::env::var(key).ok();
        unsafe { std::env::set_var(key, val) };
        Self { key, prev }
    }

    fn unset(key: &'static str) -> Self {
        let prev = std::env::var(key).ok();
        unsafe { std::env::remove_var(key) };
        Self { key, prev }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match &self.prev {
            Some(v) => unsafe { std::env::set_var(self.key, v) },
            None => unsafe { std::env::remove_var(self.key) },
        }
    }
}

#[tokio::test]
async fn unauthenticated_request_is_rejected() {
    let (_dir, state) = fixture();
    let _ = setup_cookie(&state).await;
    let response = app(state)
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/acp-api/api/accounts")
                .header("x-console-path", "/")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn model_catalog_requires_console_session_without_gemini_key() {
    let _guard = ENV_LOCK.lock().await;
    let (_dir, state) = fixture();
    let cookie = setup_cookie(&state).await;
    let models = json!({"models": [{"name": "models/gemini-2.5-flash"}]});
    let mock_body = models.clone();
    let upstream = Router::new().route(
        "/api/models/catalog",
        axum::routing::get(move |headers: HeaderMap| async move {
            assert!(!headers.contains_key("x-goog-api-key"));
            axum::Json(mock_body)
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let _env = EnvGuard::set("ACP_UPSTREAM_BASE", &format!("http://{addr}"));
    let router = app(state);

    let request = || {
        axum::http::Request::builder()
            .uri("/acp-api/api/models/catalog")
            .header("x-console-path", "/")
    };
    let denied = router.clone().oneshot(request().body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

    let response = router
        .oneshot(request().header("cookie", &cookie).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), models);

    server.abort();
}

#[tokio::test]
async fn forwards_get_path_query_and_strips_sensitive_headers() {
    let _guard = ENV_LOCK.lock().await;
    let (_dir, state) = fixture();
    let cookie = setup_cookie(&state).await;

    let captured = Arc::new(tokio::sync::Mutex::new(None::<(String, String, HeaderMap)>));
    let captured_clone = captured.clone();

    let mock_router = Router::new().fallback(any(move |req: AxumRequest| {
        let captured = captured_clone.clone();
        async move {
            let method = req.method().to_string();
            let path_query = req
                .uri()
                .path_and_query()
                .map(|pq| pq.as_str().to_owned())
                .unwrap_or_default();
            let headers = req.headers().clone();
            *captured.lock().await = Some((method, path_query, headers));
            let mut resp = Response::new(Body::from(r#"{"ok":true}"#));
            resp.headers_mut().insert(
                "content-type",
                HeaderValue::from_static("application/json"),
            );
            resp.headers_mut()
                .insert("x-upstream-custom", HeaderValue::from_static("yes"));
            resp
        }
    }));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, mock_router).await.unwrap() });

    let _env = EnvGuard::set("ACP_UPSTREAM_BASE", &format!("http://{addr}"));

    let response = app(state)
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/acp-api/api/accounts?x=1&y=two")
                .header("cookie", &cookie)
                .header("x-console-path", "/")
                .header("x-goog-api-key", "secret-key")
                .header("accept", "application/json")
                .header("last-event-id", "42")
                .header("connection", "keep-alive")
                .header("te", "trailers")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["x-upstream-custom"], "yes");
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let json_body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json_body, json!({"ok": true}));

    let (method, path_query, req_headers) = captured.lock().await.take().unwrap();
    assert_eq!(method, "GET");
    assert_eq!(path_query, "/api/accounts?x=1&y=two");
    assert!(req_headers.get("cookie").is_none());
    assert!(req_headers.get("x-console-path").is_none());
    assert!(req_headers.get("te").is_none());
    assert_eq!(req_headers["x-goog-api-key"], "secret-key");
    assert_eq!(req_headers["accept"], "application/json");
    assert_eq!(req_headers["last-event-id"], "42");

    server.abort();
}

#[tokio::test]
async fn forwards_post_body_and_preserves_upstream_status() {
    let _guard = ENV_LOCK.lock().await;
    let (_dir, state) = fixture();
    let cookie = setup_cookie(&state).await;

    let mock_router = Router::new().fallback(any(|req: AxumRequest| async move {
        let method = req.method().clone();
        let uri = req.uri().path().to_owned();
        let ct = req
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let bytes = to_bytes(req.into_body(), 1024 * 1024).await.unwrap();
        let payload: Value = serde_json::from_slice(&bytes).unwrap();
        let mut resp = Response::new(Body::from(
            json!({
                "method": method.as_str(),
                "uri": uri,
                "content_type": ct,
                "payload": payload,
            })
            .to_string(),
        ));
        *resp.status_mut() = StatusCode::CREATED;
        resp.headers_mut().insert(
            "content-type",
            HeaderValue::from_static("application/json"),
        );
        resp
    }));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, mock_router).await.unwrap() });
    let _env = EnvGuard::set("ACP_UPSTREAM_BASE", &format!("http://{addr}"));

    let response = app(state)
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/acp-api/v1beta/models")
                .header("cookie", &cookie)
                .header("x-console-path", "/")
                .header("content-type", "application/json")
                .body(Body::from(json!({"hello": "world"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let parsed: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(parsed["method"], "POST");
    assert_eq!(parsed["uri"], "/v1beta/models");
    assert_eq!(parsed["content_type"], "application/json");
    assert_eq!(parsed["payload"], json!({"hello": "world"}));

    server.abort();
}

#[tokio::test]
async fn streams_sse_response() {
    let _guard = ENV_LOCK.lock().await;
    let (_dir, state) = fixture();
    let cookie = setup_cookie(&state).await;

    let mock_router = Router::new().fallback(any(|| async move {
        let chunks = vec![
            Ok::<_, std::io::Error>(axum::body::Bytes::from("data: one\n\n")),
            Ok::<_, std::io::Error>(axum::body::Bytes::from("data: two\n\n")),
        ];
        let mut resp = Response::new(Body::from_stream(stream::iter(chunks)));
        resp.headers_mut().insert(
            "content-type",
            HeaderValue::from_static("text/event-stream"),
        );
        resp
    }));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, mock_router).await.unwrap() });
    let _env = EnvGuard::set("ACP_UPSTREAM_BASE", &format!("http://{addr}"));

    let response = app(state)
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/acp-api/api/events")
                .header("cookie", &cookie)
                .header("x-console-path", "/")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    assert_eq!(
        std::str::from_utf8(&body).unwrap(),
        "data: one\n\ndata: two\n\n"
    );

    server.abort();
}

#[tokio::test]
async fn returns_502_json_when_upstream_unreachable() {
    let _guard = ENV_LOCK.lock().await;
    let (_dir, state) = fixture();
    let cookie = setup_cookie(&state).await;

    // Bind a port and immediately drop the listener so nothing is listening on it.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);

    let _env = EnvGuard::set("ACP_UPSTREAM_BASE", &format!("http://{addr}"));

    let response = app(state)
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/acp-api/api/accounts")
                .header("cookie", &cookie)
                .header("x-console-path", "/")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let parsed: Value = serde_json::from_slice(&body).unwrap();
    let msg = parsed["error"].as_str().unwrap();
    assert!(
        msg.starts_with("8048 ACP gateway unreachable:"),
        "unexpected error message: {msg}"
    );
}

#[tokio::test]
async fn aistudio_managed_mode_single_flight_login_and_auth_mode_header() {
    let _guard = ENV_LOCK.lock().await;
    let (_dir, state) = fixture();
    let cookie = setup_cookie(&state).await;

    let login_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let login_calls_clone = login_calls.clone();

    let mock_router = Router::new()
        .route(
            "/api/auth/login",
            axum::routing::post(move || {
                let login_calls = login_calls_clone.clone();
                async move {
                    login_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    let mut resp = Response::new(Body::from(r#"{"ok":true}"#));
                    resp.headers_mut().insert(
                        "set-cookie",
                        HeaderValue::from_static(
                            "aistudio_admin=sf_tok_1; Path=/api; Max-Age=43200; HttpOnly",
                        ),
                    );
                    resp
                }
            }),
        )
        .route(
            "/api/status",
            axum::routing::get(|headers: HeaderMap| async move {
                let has_cookie = headers
                    .get("cookie")
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|c| c.contains("aistudio_admin=sf_tok_1"));
                if !has_cookie {
                    return (StatusCode::UNAUTHORIZED, "admin_login_required").into_response();
                }
                (StatusCode::OK, "ok").into_response()
            }),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, mock_router).await.unwrap() });

    let _env_base = EnvGuard::set("AISTUDIO_UPSTREAM_BASE", &format!("http://{addr}"));
    let _env_user = EnvGuard::set("AISTUDIO_ADMIN_USERNAME", "admin");
    let _env_pass = EnvGuard::set("AISTUDIO_ADMIN_PASSWORD", "pass");

    let router = app(state);
    let mut handles = Vec::new();
    for _ in 0..5 {
        let r = router.clone();
        let c = cookie.clone();
        handles.push(tokio::spawn(async move {
            r.oneshot(
                axum::http::Request::builder()
                    .method("GET")
                    .uri("/aistudio-api/api/status")
                    .header("cookie", &c)
                    .header("x-console-path", "/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
        }));
    }

    for h in handles {
        let resp = h.await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers()["x-aistudio-auth-mode"], "managed");
    }
    assert_eq!(login_calls.load(std::sync::atomic::Ordering::SeqCst), 1);

    server.abort();
}

#[tokio::test]
async fn aistudio_managed_mode_pre_refreshes_and_never_replays_write_on_401() {
    let _guard = ENV_LOCK.lock().await;
    let (_dir, state) = fixture();
    let cookie = setup_cookie(&state).await;

    let login_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let post_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let force_write_401 = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let login_c = login_count.clone();
    let post_c = post_count.clone();
    let force_401 = force_write_401.clone();

    let mock_router = Router::new()
        .route(
            "/api/auth/login",
            axum::routing::post(move || {
                let login_c = login_c.clone();
                async move {
                    let n = login_c.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    // First login returns Max-Age=30 (within 60s pre-refresh buffer).
                    // Subsequent logins return Max-Age=43200.
                    let max_age = if n == 1 { 30 } else { 43200 };
                    let mut resp = Response::new(Body::from(r#"{"ok":true}"#));
                    resp.headers_mut().insert(
                        "set-cookie",
                        HeaderValue::from_str(&format!(
                            "aistudio_admin=tok_{n}; Path=/api; Max-Age={max_age}; HttpOnly"
                        ))
                        .unwrap(),
                    );
                    resp
                }
            }),
        )
        .route(
            "/api/status",
            axum::routing::get(|headers: HeaderMap| async move {
                let c = headers
                    .get("cookie")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("");
                (StatusCode::OK, c.to_owned()).into_response()
            }),
        )
        .route(
            "/api/action",
            axum::routing::post(move |headers: HeaderMap| {
                let post_c = post_c.clone();
                let force_401 = force_401.clone();
                async move {
                    post_c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if force_401.load(std::sync::atomic::Ordering::SeqCst) {
                        return (StatusCode::UNAUTHORIZED, "admin_login_required").into_response();
                    }
                    let c = headers
                        .get("cookie")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    (StatusCode::OK, c.to_owned()).into_response()
                }
            }),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, mock_router).await.unwrap() });

    let _env_base = EnvGuard::set("AISTUDIO_UPSTREAM_BASE", &format!("http://{addr}"));
    let _env_user = EnvGuard::set("AISTUDIO_ADMIN_USERNAME", "admin");
    let _env_pass = EnvGuard::set("AISTUDIO_ADMIN_PASSWORD", "pass");

    let router = app(state);

    // 1. Cold GET triggers login #1 (tok_1 with Max-Age=30 -> within 60s buffer).
    let r1 = router
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/aistudio-api/api/status")
                .header("cookie", &cookie)
                .header("x-console-path", "/")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r1.status(), StatusCode::OK);
    let b1 = to_bytes(r1.into_body(), 1024).await.unwrap();
    assert_eq!(std::str::from_utf8(&b1).unwrap(), "aistudio_admin=tok_1");

    // 2. Write POST sees tok_1 is within 60s buffer -> pre-refreshes to tok_2 BEFORE sending POST.
    let r2 = router
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/aistudio-api/api/action")
                .header("cookie", &cookie)
                .header("x-console-path", "/")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r2.status(), StatusCode::OK);
    let b2 = to_bytes(r2.into_body(), 1024).await.unwrap();
    assert_eq!(std::str::from_utf8(&b2).unwrap(), "aistudio_admin=tok_2");
    assert_eq!(login_count.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert_eq!(post_count.load(std::sync::atomic::Ordering::SeqCst), 1);

    // 3. Write POST hits 401 -> MUST NOT replay (post_count goes 1 -> 2, not 3), returns 401.
    force_write_401.store(true, std::sync::atomic::Ordering::SeqCst);
    let r3 = router
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/aistudio-api/api/action")
                .header("cookie", &cookie)
                .header("x-console-path", "/")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r3.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(r3.headers()["x-aistudio-auth-mode"], "managed");
    assert_eq!(post_count.load(std::sync::atomic::Ordering::SeqCst), 2);

    // 4. Subsequent GET re-logins (#3) because POST's 401 invalidated tok_2.
    let r4 = router
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/aistudio-api/api/status")
                .header("cookie", &cookie)
                .header("x-console-path", "/")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r4.status(), StatusCode::OK);
    let b4 = to_bytes(r4.into_body(), 1024).await.unwrap();
    assert_eq!(std::str::from_utf8(&b4).unwrap(), "aistudio_admin=tok_3");
    assert_eq!(login_count.load(std::sync::atomic::Ordering::SeqCst), 3);

    server.abort();
}

#[tokio::test]
async fn aistudio_manual_mode_sets_manual_header_and_skips_auto_login() {
    let _guard = ENV_LOCK.lock().await;
    let (dir, state) = fixture();
    let cookie = setup_cookie(&state).await;

    let env_file = dir.path().join("aistudio.env");
    std::fs::write(&env_file, "ADMIN_AUTH_ENABLED=false\n").unwrap();

    let login_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let login_c = login_calls.clone();

    let mock_router = Router::new()
        .route(
            "/api/auth/login",
            axum::routing::post(move || {
                let login_c = login_c.clone();
                async move {
                    login_c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    StatusCode::OK
                }
            }),
        )
        .route(
            "/api/status",
            axum::routing::get(|headers: HeaderMap| async move {
                if headers.get("cookie").is_some() {
                    return (StatusCode::BAD_REQUEST, "unexpected cookie").into_response();
                }
                (StatusCode::UNAUTHORIZED, "admin_login_required").into_response()
            }),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, mock_router).await.unwrap() });

    let _env_base = EnvGuard::set("AISTUDIO_UPSTREAM_BASE", &format!("http://{addr}"));
    let _env_user = EnvGuard::unset("AISTUDIO_ADMIN_USERNAME");
    let _env_pass = EnvGuard::unset("AISTUDIO_ADMIN_PASSWORD");
    let _env_file = EnvGuard::set("AISTUDIO_ENV_FILE", env_file.to_str().unwrap());

    let resp = app(state)
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/aistudio-api/api/status")
                .header("cookie", &cookie)
                .header("x-console-path", "/")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(resp.headers()["x-aistudio-auth-mode"], "manual");
    assert_eq!(login_calls.load(std::sync::atomic::Ordering::SeqCst), 0);

    server.abort();
}

#[tokio::test]
async fn aistudio_respects_non_root_security_path_with_x_console_path() {
    let _guard = ENV_LOCK.lock().await;
    let (dir, state) = fixture();
    state
        .store
        .update(|config| {
            config.settings.security_path = "secret-entry".into();
            Ok(())
        })
        .unwrap();
    state.store.session("test-sec-session").unwrap();
    let cookie = "zako_session=test-sec-session";

    let env_file = dir.path().join("aistudio.env");
    std::fs::write(&env_file, "ADMIN_AUTH_ENABLED=false\n").unwrap();

    let mock_router = Router::new().route(
        "/api/status",
        axum::routing::get(|headers: HeaderMap| async move {
            assert!(headers.get("x-console-path").is_none());
            (StatusCode::OK, "ok").into_response()
        }),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, mock_router).await.unwrap() });

    let _env_base = EnvGuard::set("AISTUDIO_UPSTREAM_BASE", &format!("http://{addr}"));
    let _env_user = EnvGuard::unset("AISTUDIO_ADMIN_USERNAME");
    let _env_pass = EnvGuard::unset("AISTUDIO_ADMIN_PASSWORD");
    let _env_file = EnvGuard::set("AISTUDIO_ENV_FILE", env_file.to_str().unwrap());

    let router = app(state);

    // Missing X-Console-Path -> 404 Not Found.
    let missing_hdr = router
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/aistudio-api/api/status")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing_hdr.status(), StatusCode::NOT_FOUND);

    // Matching X-Console-Path -> 200 OK + x-aistudio-auth-mode.
    let with_hdr = router
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/aistudio-api/api/status")
                .header("cookie", cookie)
                .header("x-console-path", "/secret-entry")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(with_hdr.status(), StatusCode::OK);
    assert_eq!(with_hdr.headers()["x-aistudio-auth-mode"], "manual");

    server.abort();
}

#[tokio::test]
async fn aistudio_managed_mode_ignores_stale_browser_cookie_and_clears_it() {
    let _guard = ENV_LOCK.lock().await;
    let (_dir, state) = fixture();
    let session_cookie = setup_cookie(&state).await;

    let mock_router = Router::new()
        .route(
            "/api/auth/login",
            axum::routing::post(|| async move {
                let mut resp = Response::new(Body::from(r#"{"ok":true}"#));
                resp.headers_mut().insert(
                    "set-cookie",
                    HeaderValue::from_static(
                        "aistudio_admin=fresh_managed_tok; Path=/api; Max-Age=43200; HttpOnly",
                    ),
                );
                resp
            }),
        )
        .route(
            "/api/status",
            axum::routing::get(|headers: HeaderMap| async move {
                let sent_cookie = headers
                    .get("cookie")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("");
                assert!(
                    !sent_cookie.contains("stale"),
                    "stale browser cookie must not reach upstream: {sent_cookie}"
                );
                assert_eq!(sent_cookie, "aistudio_admin=fresh_managed_tok");
                (StatusCode::OK, "ok").into_response()
            }),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, mock_router).await.unwrap() });

    let _env_base = EnvGuard::set("AISTUDIO_UPSTREAM_BASE", &format!("http://{addr}"));
    let _env_user = EnvGuard::set("AISTUDIO_ADMIN_USERNAME", "admin");
    let _env_pass = EnvGuard::set("AISTUDIO_ADMIN_PASSWORD", "pass");

    let resp = app(state)
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/aistudio-api/api/status")
                .header("cookie", format!("{session_cookie}; aistudio_admin=stale"))
                .header("x-console-path", "/")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers()["x-aistudio-auth-mode"], "managed");
    let set_cookies: Vec<&str> = resp
        .headers()
        .get_all(axum::http::header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap())
        .collect();
    assert_eq!(
        set_cookies,
        vec!["aistudio_admin=; Path=/aistudio-api; Max-Age=0; HttpOnly; SameSite=Strict"]
    );

    server.abort();
}

#[tokio::test]
async fn aistudio_non_root_security_path_guards_sse_and_csv_endpoints() {
    let _guard = ENV_LOCK.lock().await;
    let (dir, state) = fixture();
    state
        .store
        .update(|config| {
            config.settings.security_path = "secret-entry".into();
            Ok(())
        })
        .unwrap();
    state.store.session("test-sse-csv-session").unwrap();
    let cookie = "zako_session=test-sse-csv-session";

    let env_file = dir.path().join("aistudio.env");
    std::fs::write(&env_file, "ADMIN_AUTH_ENABLED=false\n").unwrap();

    let mock_router = Router::new()
        .route(
            "/api/events",
            axum::routing::get(|headers: HeaderMap| async move {
                assert!(headers.get("x-console-path").is_none());
                let chunks = vec![Ok::<_, std::io::Error>(axum::body::Bytes::from(
                    "data: ping\n\n",
                ))];
                let mut resp = Response::new(Body::from_stream(stream::iter(chunks)));
                resp.headers_mut().insert(
                    "content-type",
                    HeaderValue::from_static("text/event-stream"),
                );
                resp
            }),
        )
        .route(
            "/api/usage/records.csv",
            axum::routing::get(|headers: HeaderMap| async move {
                assert!(headers.get("x-console-path").is_none());
                let mut resp = Response::new(Body::from("id,cost\n1,0.5\n"));
                resp.headers_mut()
                    .insert("content-type", HeaderValue::from_static("text/csv"));
                resp
            }),
        );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, mock_router).await.unwrap() });

    let _env_base = EnvGuard::set("AISTUDIO_UPSTREAM_BASE", &format!("http://{addr}"));
    let _env_user = EnvGuard::unset("AISTUDIO_ADMIN_USERNAME");
    let _env_pass = EnvGuard::unset("AISTUDIO_ADMIN_PASSWORD");
    let _env_file = EnvGuard::set("AISTUDIO_ENV_FILE", env_file.to_str().unwrap());

    let router = app(state);

    for path in ["/aistudio-api/api/events", "/aistudio-api/api/usage/records.csv"] {
        let missing = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("GET")
                    .uri(path)
                    .header("cookie", cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND, "path: {path}");
    }

    let sse_ok = router
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/aistudio-api/api/events")
                .header("cookie", cookie)
                .header("x-console-path", "/secret-entry")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(sse_ok.status(), StatusCode::OK);
    assert_eq!(sse_ok.headers()["content-type"], "text/event-stream");
    let sse_body = to_bytes(sse_ok.into_body(), 1024).await.unwrap();
    assert_eq!(std::str::from_utf8(&sse_body).unwrap(), "data: ping\n\n");

    let csv_ok = router
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/aistudio-api/api/usage/records.csv")
                .header("cookie", cookie)
                .header("x-console-path", "/secret-entry")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(csv_ok.status(), StatusCode::OK);
    assert_eq!(csv_ok.headers()["content-type"], "text/csv");
    let csv_body = to_bytes(csv_ok.into_body(), 1024).await.unwrap();
    assert_eq!(std::str::from_utf8(&csv_body).unwrap(), "id,cost\n1,0.5\n");

    server.abort();
}

#[tokio::test]
async fn aistudio_write_request_rewrites_origin_and_referer_to_upstream_same_origin() {
    let _guard = ENV_LOCK.lock().await;
    let (dir, state) = fixture();
    let cookie = setup_cookie(&state).await;

    let env_file = dir.path().join("aistudio.env");
    std::fs::write(&env_file, "ADMIN_AUTH_ENABLED=false\n").unwrap();

    let captured = Arc::new(tokio::sync::Mutex::new(None::<HeaderMap>));
    let captured_clone = captured.clone();

    let mock_router = Router::new().route(
        "/api/accounts/123",
        axum::routing::patch(move |headers: HeaderMap| {
            let captured = captured_clone.clone();
            async move {
                *captured.lock().await = Some(headers);
                (StatusCode::OK, "updated").into_response()
            }
        }),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let expected_origin = format!("http://{addr}");
    let expected_referer = format!("http://{addr}/");
    let server = tokio::spawn(async move { axum::serve(listener, mock_router).await.unwrap() });

    let _env_base = EnvGuard::set("AISTUDIO_UPSTREAM_BASE", &expected_origin);
    let _env_user = EnvGuard::unset("AISTUDIO_ADMIN_USERNAME");
    let _env_pass = EnvGuard::unset("AISTUDIO_ADMIN_PASSWORD");
    let _env_file = EnvGuard::set("AISTUDIO_ENV_FILE", env_file.to_str().unwrap());

    let resp = app(state)
        .oneshot(
            axum::http::Request::builder()
                .method("PATCH")
                .uri("/aistudio-api/api/accounts/123")
                .header("host", "127.0.0.1:8046")
                .header("cookie", &cookie)
                .header("x-console-path", "/")
                .header("origin", "http://127.0.0.1:8046")
                .header("referer", "http://127.0.0.1:8046/")
                .header("sec-fetch-site", "cross-site")
                .header("sec-fetch-mode", "cors")
                .header("sec-fetch-dest", "empty")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"enabled":false}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let upstream_headers = captured.lock().await.take().unwrap();
    assert_eq!(upstream_headers["origin"], expected_origin);
    assert_eq!(upstream_headers["referer"], expected_referer);
    assert_eq!(upstream_headers["sec-fetch-site"], "same-origin");
    assert!(upstream_headers.get("sec-fetch-mode").is_none());
    assert!(upstream_headers.get("sec-fetch-dest").is_none());

    server.abort();
}
