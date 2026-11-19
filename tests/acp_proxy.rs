use axum::{
    Router,
    body::{Body, to_bytes},
    extract::Request as AxumRequest,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::Response,
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
    prev: Option<String>,
}

impl EnvGuard {
    fn set(key: &str, val: &str) -> Self {
        let prev = std::env::var(key).ok();
        unsafe { std::env::set_var(key, val) };
        Self { prev }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match &self.prev {
            Some(v) => unsafe { std::env::set_var("ACP_UPSTREAM_BASE", v) },
            None => unsafe { std::env::remove_var("ACP_UPSTREAM_BASE") },
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
