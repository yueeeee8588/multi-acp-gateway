use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tower::ServiceExt;
use multi_acp_gateway::{Shared, app, new_app};

const OFFICIAL_UPSTREAM_KEY: &str = "sk-test-import-secret-9201";

struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Clone, Debug)]
struct Call {
    path: String,
    headers: HeaderMap,
    body: Value,
}

#[derive(Default)]
struct Mock {
    calls: Mutex<Vec<Call>>,
    unavailable: AtomicBool,
    fail_stats: AtomicBool,
    require_turnstile: AtomicBool,
    omit_refresh_token: AtomicBool,
    expire_login_access: AtomicBool,
    minimum_token: AtomicUsize,
    refreshes: AtomicUsize,
}

async fn upstream(State(mock): State<Arc<Mock>>, req: Request<Body>) -> Response {
    let path = req.uri().path().to_owned();
    let headers = req.headers().clone();
    let bytes = to_bytes(req.into_body(), 1024 * 1024).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    mock.calls.lock().unwrap().push(Call {
        path: path.clone(),
        headers: headers.clone(),
        body: body.clone(),
    });
    if mock.unavailable.load(Ordering::SeqCst) {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({"message":"upstream unavailable"})),
        )
            .into_response();
    }
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    };
    if path == "/api/user/login" {
        if body["username"] != "new-user" || body["password"] != "new-password-secret" {
            if body["username"] == "new-user-v2" && body["password"] == "new-password-secret" {
                return Json(json!({"success":true,"data":{"access_token":"new-login-access-secret","token_type":"Bearer","user":{"id":42}}})).into_response();
            }
            return Json(json!({"success":false,"message":"invalid login"})).into_response();
        }
        let mut response = Json(json!({"success":true,"data":{"id":42}})).into_response();
        response.headers_mut().append(
            "set-cookie",
            "session=upstream-cookie-secret; HttpOnly; Path=/"
                .parse()
                .unwrap(),
        );
        response.headers_mut().append(
            "set-cookie",
            "device=upstream-device; Path=/".parse().unwrap(),
        );
        return response;
    }
    if path.starts_with("/api/") && !path.starts_with("/api/v1/") {
        if path == "/api/status" {
            return Json(json!({"success":true,"data":{"quota_per_unit":18000}})).into_response();
        }
        let valid_cookie = header("cookie").contains("session=upstream-cookie-secret")
            && header("cookie").contains("device=upstream-device");
        let modern_auth = header("new-api-user").is_empty()
            && matches!(
                header("authorization"),
                "Bearer nap_system-token-secret" | "Bearer new-login-access-secret"
            );
        if !modern_auth
            && (header("new-api-user") != "42"
                || !(valid_cookie || header("authorization") == "Bearer system-token-secret"))
        {
            return Json(json!({"success":false,"message":"invalid session"})).into_response();
        }
        return Json(match path.as_str() {
            "/api/user/self" => json!({"success":true,"data":{"id":42,"quota":36000,"used_quota":18000,"group":"default"}}),
            "/api/log/self/stat" => json!({"success":true,"data":{"quota":9000}}),
            "/api/user/self/groups" | "/api/user/groups" => json!({"success":true,"data":{"default":1}}),
            "/api/pricing" => json!({"success":true,"data":[]}),
            _ => json!({"success":false,"message":"unexpected endpoint"}),
        }).into_response();
    }
    if path == "/api/v1/auth/login" {
        if body["email"] != "sub@example.com" || body["password"] != "sub-password-secret" {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"message":"invalid login"})),
            )
                .into_response();
        }
        if mock.require_turnstile.load(Ordering::SeqCst)
            && body["turnstile_token"] != "mock-turnstile-proof-never-persist"
        {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"message":"turnstile verification required"})),
            )
                .into_response();
        }
        let access_token = if mock.require_turnstile.load(Ordering::SeqCst)
            && mock.minimum_token.load(Ordering::SeqCst) > 0
            && !mock.expire_login_access.load(Ordering::SeqCst)
        {
            format!(
                "rotated-access-secret-{}",
                mock.minimum_token.load(Ordering::SeqCst)
            )
        } else {
            "password-access-secret".into()
        };
        let mut data = json!({
            "access_token":access_token,
            "token_type":"Bearer",
            "expires_in":3600
        });
        if !mock.omit_refresh_token.load(Ordering::SeqCst) {
            data["refresh_token"] = json!("initial-refresh-secret");
        }
        return Json(json!({"code":0,"data":data})).into_response();
    }
    if path == "/api/v1/settings/public" {
        return Json(json!({
            "code": 0,
            "data": {
                "turnstile_enabled": mock.require_turnstile.load(Ordering::SeqCst),
                "turnstile_site_key": if mock.require_turnstile.load(Ordering::SeqCst) {
                    "mock-site-key-public"
                } else {
                    ""
                }
            }
        }))
        .into_response();
    }
    if path == "/api/v1/auth/refresh" {
        let count = mock.refreshes.load(Ordering::SeqCst);
        let expected = if count == 0 {
            "initial-refresh-secret".to_owned()
        } else {
            format!("rotated-refresh-secret-{count}")
        };
        if body["refresh_token"] != expected {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"message":"invalid refresh token"})),
            )
                .into_response();
        }
        let next = mock.refreshes.fetch_add(1, Ordering::SeqCst) + 1;
        return Json(json!({"code":0,"data":{"access_token":format!("rotated-access-secret-{next}"),"refresh_token":format!("rotated-refresh-secret-{next}"),"token_type":"Bearer","expires_in":3600}})).into_response();
    }
    let version = header("authorization")
        .strip_prefix("Bearer rotated-access-secret-")
        .and_then(|v| v.parse::<usize>().ok());
    let basic = matches!(
        header("authorization"),
        "Bearer password-access-secret" | "Bearer direct-access-secret"
    );
    if !(version.is_some_and(|v| v >= mock.minimum_token.load(Ordering::SeqCst))
        || (basic && mock.minimum_token.load(Ordering::SeqCst) == 0))
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"message":"expired access token"})),
        )
            .into_response();
    }
    if path == "/api/v1/usage/dashboard/stats" && mock.fail_stats.load(Ordering::SeqCst) {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({"message":"stats temporarily unavailable"})),
        )
            .into_response();
    }
    Json(match path.as_str() {
        "/api/v1/auth/me" => json!({"code":0,"data":{"id":7,"balance":12.5}}),
        "/api/v1/usage/dashboard/stats" => {
            json!({"code":0,"data":{"today_actual_cost":1.25,"total_actual_cost":7.5}})
        }
        "/api/v1/keys" => json!({"code":0,"data":{"items":[{"id":1,"name":"Official key","key":OFFICIAL_UPSTREAM_KEY,"group_id":7,"group":{"id":7,"name":"vip","rate_multiplier":1.5},"status":"active","expires_at":null,"quota":0,"quota_used":0}],"total":1}}),
        "/api/v1/groups/available" => json!({"code":0,"data":[{"id":7,"name":"vip","rate_multiplier":1.5}]}),
        "/api/v1/groups/rates" => json!({"code":0,"data":{"7":1.5}}),
        _ => json!({"code":0,"data":{}}),
    })
    .into_response()
}

async fn mock_server() -> (String, Arc<Mock>, Server) {
    let mock = Arc::new(Mock::default());
    let router = Router::new().fallback(upstream).with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = Server(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    (url, mock, server)
}

fn fixture() -> (tempfile::TempDir, Shared) {
    let dir = tempfile::tempdir().unwrap();
    let state = new_app(dir.path(), dir.path().join("web")).unwrap();
    (dir, state)
}

async fn request(
    s: &Shared,
    method: &str,
    path: &str,
    body: Value,
    cookie: &str,
) -> (StatusCode, Value, String) {
    let response = app(s.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("cookie", cookie)
                .header("x-console-path", "/")
                .body(if body.is_null() {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .to_owned();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        cookie,
    )
}

async fn setup(s: &Shared) -> String {
    let (status, body, cookie) = request(
        s,
        "POST",
        "/api/setup",
        json!({"username":"admin","password":"integration-password-123"}),
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!cookie.is_empty());
    cookie
}

fn form(url: &str, kind: &str, auth_mode: &str) -> Value {
    json!({"name":"Provider integration","kind":kind,"base_url":url,"auth_mode":auth_mode,"username":"","user_id":"","price_multiplier":7,"notes":"local review","token_type":"Bearer","password":"","access_token":"","refresh_token":""})
}

fn assert_private(value: &Value) {
    let text = value.to_string();
    for secret in [
        "new-password-secret",
        "sub-password-secret",
        "system-token-secret",
        "password-access-secret",
        "direct-access-secret",
        "initial-refresh-secret",
        "rotated-refresh-secret",
        "rotated-access-secret",
        "upstream-cookie-secret",
        "mock-turnstile-proof-never-persist",
        "invalid-turnstile-proof-never-persist",
        OFFICIAL_UPSTREAM_KEY,
    ] {
        assert!(
            !text.contains(secret),
            "public API leaked {secret}: {value}"
        );
    }
    if let Some(object) = value.as_object() {
        for field in ["password", "access_token", "refresh_token", "cookie"] {
            assert!(!object.contains_key(field), "public field {field}: {value}");
        }
    }
}

fn assert_metrics(value: &Value, balance: f64, today: f64, total: f64, recharged: f64) {
    assert_eq!(value["balance"].as_f64(), Some(balance), "{value}");
    assert_eq!(value["today_usage"].as_f64(), Some(today), "{value}");
    assert_eq!(value["total_usage"].as_f64(), Some(total), "{value}");
    assert_eq!(
        value["total_recharged"].as_f64(),
        Some(recharged),
        "{value}"
    );
    assert_eq!(value["currency"], "USD");
}

async fn create_and_refresh(state: &Shared, input: Value, cookie: &str) -> Value {
    let (status, created, _) = request(state, "POST", "/api/providers", input, cookie).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_private(&created);
    let id = created["id"].as_str().unwrap();
    let (status, refreshed, _) = request(
        state,
        "POST",
        &format!("/api/providers/{id}/refresh"),
        json!({}),
        cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{refreshed}");
    refreshed
}

#[tokio::test]
async fn newapi_password_cookie_metrics_and_provider_crud() {
    let (_dir, state) = fixture();
    let cookie = setup(&state).await;
    let (url, mock, _server) = mock_server().await;
    let mut input = form(&url, "newapi", "password");
    input["username"] = json!("new-user");
    input["password"] = json!("new-password-secret");
    let created = create_and_refresh(&state, input.clone(), &cookie).await;
    let id = created["id"].as_str().unwrap();
    assert_eq!(created["status"], "connected");
    assert_eq!(created["has_password"], true);
    assert_eq!(created["price_multiplier"].as_f64(), Some(7.0));
    assert_metrics(&created, 2.0, 0.5, 1.0, 3.0);
    assert_private(&created);
    {
        let calls = mock.calls.lock().unwrap();
        let me = calls.iter().find(|c| c.path == "/api/user/self").unwrap();
        assert_eq!(me.headers["new-api-user"], "42");
        let header = me.headers["cookie"].to_str().unwrap();
        assert!(header.contains("session=upstream-cookie-secret"));
        assert!(header.contains("device=upstream-device"));
        assert!(!header.contains("HttpOnly"));
        assert!(!header.contains("Path="));
        assert_eq!(
            calls
                .iter()
                .find(|c| c.path == "/api/user/login")
                .unwrap()
                .body["username"],
            "new-user"
        );
    }
    let (status, list, _) = request(&state, "GET", "/api/providers", Value::Null, &cookie).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_private(&list[0]);
    input["password"] = json!("");
    input["name"] = json!("Edited provider");
    input["notes"] = json!("updated notes");
    let (status, updated, _) = request(
        &state,
        "PUT",
        &format!("/api/providers/{id}"),
        input,
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["name"], "Edited provider");
    assert_eq!(updated["notes"], "updated notes");
    assert_eq!(updated["has_password"], true);
    let (status, refreshed, _) = request(
        &state,
        "POST",
        &format!("/api/providers/{id}/refresh"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{refreshed}");
    assert_metrics(&refreshed, 2.0, 0.5, 1.0, 3.0);
    assert_eq!(
        request(
            &state,
            "DELETE",
            &format!("/api/providers/{id}"),
            Value::Null,
            &cookie
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, list, _) = request(&state, "GET", "/api/providers", Value::Null, &cookie).await;
    assert_eq!(list.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn newapi_system_token_test_is_authenticated_and_does_not_persist() {
    let (_dir, state) = fixture();
    let (url, mock, _server) = mock_server().await;
    let mut input = form(&url, "newapi", "token");
    input["access_token"] = json!("system-token-secret");
    input["user_id"] = json!("42");
    for (method, path, body) in [
        ("GET", "/api/providers", Value::Null),
        ("POST", "/api/providers", input.clone()),
        ("POST", "/api/providers/test", input.clone()),
        ("PUT", "/api/providers/missing", input.clone()),
        ("POST", "/api/providers/missing/refresh", json!({})),
        ("DELETE", "/api/providers/missing", Value::Null),
    ] {
        assert_eq!(
            request(&state, method, path, body, "").await.0,
            StatusCode::UNAUTHORIZED,
            "{method} {path}"
        );
    }
    assert!(mock.calls.lock().unwrap().is_empty());
    let cookie = setup(&state).await;
    let (status, tested, _) = request(
        &state,
        "POST",
        "/api/providers/test",
        input.clone(),
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{tested}");
    assert_eq!(tested["ok"], true);
    assert_metrics(&tested, 2.0, 0.5, 1.0, 3.0);
    assert_private(&tested);
    let (_, list, _) = request(&state, "GET", "/api/providers", Value::Null, &cookie).await;
    assert_eq!(list.as_array().unwrap().len(), 0);
    let (status, created, _) = request(&state, "POST", "/api/providers", input, &cookie).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["has_access_token"], true);
    assert_private(&created);
    let calls = mock.calls.lock().unwrap();
    assert!(!calls.iter().any(|c| c.path == "/api/user/login"));
    let me = calls.iter().find(|c| c.path == "/api/user/self").unwrap();
    assert_eq!(me.headers["authorization"], "Bearer system-token-secret");
    assert_eq!(me.headers["new-api-user"], "42");
}

#[tokio::test]
async fn newapi_pat_without_user_id_and_modern_password_login_keep_legacy_path() {
    let (_dir, state) = fixture();
    let cookie = setup(&state).await;
    let (url, mock, _server) = mock_server().await;
    let mut pat = form(&url, "newapi", "token");
    pat["user_id"] = json!("");
    pat["access_token"] = json!("nap_system-token-secret");
    let (status, tested, _) =
        request(&state, "POST", "/api/providers/test", pat.clone(), &cookie).await;
    assert_eq!(status, StatusCode::OK, "{tested}");
    assert_eq!(tested["user_id"], "42");
    let provider = create_and_refresh(&state, pat, &cookie).await;
    assert_eq!(provider["status"], "connected");
    assert_eq!(provider["user_id"], "42");

    let mut password = form(&url, "newapi", "password");
    password["username"] = json!("new-user-v2");
    password["password"] = json!("new-password-secret");
    let modern = create_and_refresh(&state, password, &cookie).await;
    assert_eq!(modern["status"], "connected");
    assert_eq!(modern["user_id"], "42");

    let calls = mock.calls.lock().unwrap();
    assert!(calls.iter().any(|call| call.path == "/api/user/self"
        && call.headers.get("authorization").unwrap() == "Bearer nap_system-token-secret"
        && !call.headers.contains_key("new-api-user")));
    assert!(calls.iter().any(|call| call.path == "/api/user/self"
        && call.headers.get("authorization").unwrap() == "Bearer new-login-access-secret"
        && !call.headers.contains_key("new-api-user")));
}

#[tokio::test]
async fn sub2api_password_uses_email_and_reports_fallback_recharge() {
    let (_dir, state) = fixture();
    let cookie = setup(&state).await;
    let (url, mock, _server) = mock_server().await;
    let mut input = form(&url, "sub2api", "password");
    input["username"] = json!("sub@example.com");
    input["password"] = json!("sub-password-secret");
    let provider = create_and_refresh(&state, input, &cookie).await;
    assert_eq!(provider["status"], "connected");
    assert_metrics(&provider, 12.5, 1.25, 7.5, 20.0);
    assert_eq!(provider["total_recharged_estimated"], true);
    assert_private(&provider);
    let calls = mock.calls.lock().unwrap();
    let login = calls
        .iter()
        .find(|c| c.path == "/api/v1/auth/login")
        .unwrap();
    assert_eq!(login.body["email"], "sub@example.com");
    assert_eq!(login.body["password"], "sub-password-secret");
}

#[tokio::test]
async fn migrated_sub2api_password_sessions_without_tokens_recover_without_turnstile() {
    for previous_status in ["connected", "error"] {
        for operation in ["refresh", "keys", "groups"] {
            let (dir, state) = fixture();
            let cookie = setup(&state).await;
            let (url, mock, _server) = mock_server().await;
            let mut input = form(&url, "sub2api", "password");
            input["username"] = json!("sub@example.com");
            input["password"] = json!("sub-password-secret");
            let (status, tested, _) = request(
                &state,
                "POST",
                "/api/providers/test",
                input.clone(),
                &cookie,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{tested}");
            let (status, created, _) =
                request(&state, "POST", "/api/providers", input, &cookie).await;
            assert_eq!(status, StatusCode::OK, "{created}");
            assert_eq!(created["has_access_token"], true);
            let id = created["id"].as_str().unwrap().to_owned();

            // v0.12.1 persisted password accounts without the login session.
            state
                .store
                .update(|config| {
                    let provider = config.providers.iter_mut().find(|p| p.id == id).unwrap();
                    provider.access_token.clear();
                    provider.refresh_token.clear();
                    provider.status = previous_status.into();
                    provider.last_error =
                        (previous_status == "error").then(|| "previous refresh failed".into());
                    Ok(())
                })
                .unwrap();
            // Reopening also discards the successful preflight's in-memory cache.
            drop(state);
            let state = new_app(dir.path(), dir.path().join("web")).unwrap();
            let saved = &state.store.config().unwrap().providers[0];
            assert_eq!(saved.status, previous_status);
            assert!(saved.access_token.is_empty());
            assert!(saved.refresh_token.is_empty());
            mock.calls.lock().unwrap().clear();

            let (status, result, _) = request(
                &state,
                if operation == "refresh" {
                    "POST"
                } else {
                    "GET"
                },
                &format!("/api/providers/{id}/{operation}"),
                Value::Null,
                &cookie,
            )
            .await;
            assert_eq!(
                status,
                StatusCode::OK,
                "{previous_status}/{operation}: {result}"
            );
            if operation == "refresh" {
                assert_eq!(result["status"], "connected");
                assert_metrics(&result, 12.5, 1.25, 7.5, 20.0);
            } else if operation == "keys" {
                assert_eq!(result["keys"][0]["id"], "1");
                assert_eq!(result["keys"][0]["available"], true);
            } else {
                assert_eq!(result["groups"][0]["id"], "7");
            }
            assert_private(&result);
            assert_saved_sub_session(
                &state,
                &id,
                "password-access-secret",
                "initial-refresh-secret",
            );
            assert_eq!(mock.refreshes.load(Ordering::SeqCst), 0);
            let calls = mock.calls.lock().unwrap();
            let logins = calls
                .iter()
                .filter(|call| call.path == "/api/v1/auth/login")
                .collect::<Vec<_>>();
            assert_eq!(logins.len(), 1, "{previous_status}/{operation}");
            assert!(logins[0].body.get("turnstile_token").is_none());
            assert_eq!(calls[0].path, "/api/v1/settings/public");
        }
    }
}

fn assert_saved_sub_session(state: &Shared, id: &str, access: &str, refresh: &str) {
    let config = state.store.config().unwrap();
    let provider = config.providers.iter().find(|p| p.id == id).unwrap();
    assert_eq!(
        state.store.unseal(&provider.password).unwrap(),
        "sub-password-secret"
    );
    assert_eq!(state.store.unseal(&provider.access_token).unwrap(), access);
    assert_eq!(
        state.store.unseal(&provider.refresh_token).unwrap(),
        refresh
    );
    assert_private(&serde_json::to_value(config).unwrap());
}

async fn password_key_operations_preserve_rotations(require_turnstile: bool) {
    let (_dir, state) = fixture();
    let cookie = setup(&state).await;
    let (url, mock, _server) = mock_server().await;
    mock.require_turnstile
        .store(require_turnstile, Ordering::SeqCst);
    let mut input = form(&url, "sub2api", "password");
    input["username"] = json!("sub@example.com");
    input["password"] = json!("sub-password-secret");
    if require_turnstile {
        input["turnstile_token"] = json!("mock-turnstile-proof-never-persist");
    }
    let (status, tested, _) = request(
        &state,
        "POST",
        "/api/providers/test",
        input.clone(),
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{tested}");
    assert_private(&tested);
    let (status, created, _) = request(&state, "POST", "/api/providers", input, &cookie).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_private(&created);
    let id = created["id"].as_str().unwrap();
    assert_saved_sub_session(
        &state,
        id,
        "password-access-secret",
        "initial-refresh-secret",
    );

    for (index, operation) in ["keys", "groups", "import"].into_iter().enumerate() {
        let rotation = index + 1;
        mock.minimum_token.store(rotation, Ordering::SeqCst);
        let (method, path, body) = if operation == "import" {
            (
                "POST",
                "/api/accounts".to_owned(),
                json!({"name":"Rotated password account","provider_id":id,"provider_key_id":"1",
                    "endpoint":"","api_key":"","models":["mock-model"],"group_ids":[],"protocols":["responses"],"enabled":true}),
            )
        } else {
            (
                "GET",
                format!("/api/providers/{id}/{operation}"),
                Value::Null,
            )
        };
        let (status, result, _) = request(&state, method, &path, body, &cookie).await;
        assert_eq!(status, StatusCode::OK, "{operation}: {result}");
        assert_private(&result);
        if operation == "keys" {
            assert_eq!(result["keys"][0]["available"], true);
        } else if operation == "groups" {
            assert_eq!(result["groups"][0]["id"], "7");
        } else {
            assert_eq!(result["provider_binding"]["provider_id"], id);
            assert_eq!(result["provider_binding"]["status"], "active");
            let config = state.store.config().unwrap();
            assert_eq!(config.accounts.len(), 1);
            assert_eq!(
                state.store.unseal(&config.accounts[0].api_key).unwrap(),
                OFFICIAL_UPSTREAM_KEY
            );
        }
        assert_eq!(
            mock.refreshes.load(Ordering::SeqCst),
            rotation,
            "{operation}"
        );
        assert_saved_sub_session(
            &state,
            id,
            &format!("rotated-access-secret-{rotation}"),
            &format!("rotated-refresh-secret-{rotation}"),
        );
    }
    let calls = mock.calls.lock().unwrap();
    let logins = calls
        .iter()
        .filter(|call| call.path == "/api/v1/auth/login")
        .collect::<Vec<_>>();
    assert_eq!(
        logins.len(),
        1,
        "key operations must renew the preflight session"
    );
    if require_turnstile {
        assert_eq!(
            logins[0].body["turnstile_token"],
            "mock-turnstile-proof-never-persist"
        );
    } else {
        assert!(logins[0].body.get("turnstile_token").is_none());
    }
    let refreshes = calls
        .iter()
        .filter(|call| call.path == "/api/v1/auth/refresh")
        .collect::<Vec<_>>();
    assert_eq!(refreshes.len(), 3);
    for (index, refresh) in refreshes.iter().enumerate() {
        let expected = if index == 0 {
            "initial-refresh-secret".to_owned()
        } else {
            format!("rotated-refresh-secret-{index}")
        };
        assert_eq!(refresh.body["refresh_token"], expected);
        assert!(refresh.body.get("turnstile_token").is_none());
        assert!(refresh.body.get("password").is_none());
    }
}

#[tokio::test]
async fn sub2api_turnstile_password_keys_groups_and_import_preserve_each_rotation() {
    password_key_operations_preserve_rotations(true).await;
}

#[tokio::test]
async fn sub2api_password_keys_groups_and_import_preserve_rotations_without_turnstile() {
    password_key_operations_preserve_rotations(false).await;
}

#[tokio::test]
async fn sub2api_auth_requirements_exposes_only_public_turnstile_configuration() {
    let (_dir, state) = fixture();
    let cookie = setup(&state).await;
    let (url, mock, _server) = mock_server().await;
    mock.require_turnstile.store(true, Ordering::SeqCst);
    let mut input = form(&url, "sub2api", "token");
    input["access_token"] = json!("direct-access-secret");
    let (status, created, _) = request(&state, "POST", "/api/providers", input, &cookie).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap();

    let (status, requirements, _) = request(
        &state,
        "GET",
        &format!("/api/providers/{id}/auth-requirements"),
        Value::Null,
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{requirements}");
    assert_eq!(requirements["turnstile_required"], true);
    assert_eq!(requirements["turnstile_site_key"], "mock-site-key-public");
    assert_private(&requirements);
    let (status, unsaved_requirements, _) = request(
        &state,
        "POST",
        "/api/providers/auth-requirements",
        json!({"kind":"sub2api","base_url":url}),
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{unsaved_requirements}");
    assert_eq!(unsaved_requirements, requirements);
    {
        let calls = mock.calls.lock().unwrap();
        assert!(
            calls
                .iter()
                .any(|call| call.path == "/api/v1/settings/public")
        );
    }

    let (status, newapi_requirements, _) = request(
        &state,
        "POST",
        "/api/providers/auth-requirements",
        json!({"kind":"newapi","base_url":"https://unused.example"}),
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{newapi_requirements}");
    assert_eq!(newapi_requirements["turnstile_required"], false);
    assert_eq!(newapi_requirements["turnstile_site_key"], "");
}

#[tokio::test]
async fn sub2api_password_forwards_turnstile_proof_and_keeps_it_ephemeral() {
    const TURNSTILE_TOKEN: &str = "mock-turnstile-proof-never-persist";
    let (_dir, state) = fixture();
    let cookie = setup(&state).await;
    let (url, mock, _server) = mock_server().await;
    mock.require_turnstile.store(true, Ordering::SeqCst);
    let mut input = form(&url, "sub2api", "password");
    input["username"] = json!("sub@example.com");
    input["password"] = json!("sub-password-secret");
    input["turnstile_token"] = json!(TURNSTILE_TOKEN);

    let (status, tested, _) = request(
        &state,
        "POST",
        "/api/providers/test",
        input.clone(),
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{tested}");
    assert_eq!(tested["ok"], true);
    assert_metrics(&tested, 12.5, 1.25, 7.5, 20.0);
    assert_private(&tested);
    assert!(!tested.to_string().contains(TURNSTILE_TOKEN));
    assert!(state.store.config().unwrap().providers.is_empty());

    let (status, created, _) =
        request(&state, "POST", "/api/providers", input.clone(), &cookie).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["has_access_token"], true);
    assert_eq!(created["has_refresh_token"], true);
    assert_private(&created);
    assert!(!created.to_string().contains(TURNSTILE_TOKEN));
    assert!(
        !serde_json::to_value(state.store.config().unwrap())
            .unwrap()
            .to_string()
            .contains(TURNSTILE_TOKEN)
    );

    let id = created["id"].as_str().unwrap();
    let (status, refreshed, _) = request(
        &state,
        "POST",
        &format!("/api/providers/{id}/refresh"),
        Value::Null,
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{refreshed}");
    assert_eq!(refreshed["status"], "connected");
    assert_private(&refreshed);

    let calls = mock.calls.lock().unwrap();
    let logins = calls
        .iter()
        .filter(|call| call.path == "/api/v1/auth/login")
        .collect::<Vec<_>>();
    assert_eq!(
        logins.len(),
        1,
        "password login should be reused after preflight"
    );
    assert_eq!(logins[0].body["turnstile_token"], TURNSTILE_TOKEN);
}

#[tokio::test]
async fn rejected_turnstile_proofs_do_not_persist_tokens_or_plaintext_credentials() {
    for proof in [None, Some("invalid-turnstile-proof-never-persist")] {
        let (dir, state) = fixture();
        let cookie = setup(&state).await;
        let (url, mock, _server) = mock_server().await;
        mock.require_turnstile.store(true, Ordering::SeqCst);
        let mut input = form(&url, "sub2api", "password");
        input["username"] = json!("sub@example.com");
        input["password"] = json!("sub-password-secret");
        if let Some(proof) = proof {
            input["turnstile_token"] = json!(proof);
        }
        let before = serde_json::to_value(state.store.config().unwrap()).unwrap();
        let (status, rejected, _) = request(
            &state,
            "POST",
            "/api/providers/test",
            input.clone(),
            &cookie,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{rejected}");
        if proof.is_none() {
            assert!(rejected["error"].as_str().unwrap().contains("Turnstile"));
        } else {
            assert_eq!(rejected["error"], "站点认证失败，请检查登录信息或更新令牌");
        }
        assert_private(&rejected);
        assert_eq!(
            serde_json::to_value(state.store.config().unwrap()).unwrap(),
            before
        );

        // Saving after a failed preflight must not reuse any staged session.
        let (status, created, _) =
            request(&state, "POST", "/api/providers", input.clone(), &cookie).await;
        assert_eq!(status, StatusCode::OK, "{created}");
        assert_eq!(created["has_password"], true);
        assert_eq!(created["has_access_token"], false);
        assert_eq!(created["has_refresh_token"], false);
        assert_private(&created);
        let id = created["id"].as_str().unwrap();
        input["id"] = json!(id);
        input["password"] = json!("");
        let before = serde_json::to_value(state.store.config().unwrap()).unwrap();
        assert_private(&before);
        let (status, rejected, _) =
            request(&state, "POST", "/api/providers/test", input, &cookie).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{rejected}");
        assert_private(&rejected);
        assert_eq!(
            serde_json::to_value(state.store.config().unwrap()).unwrap(),
            before
        );
        drop(state);
        let reopened = new_app(dir.path(), dir.path().join("web")).unwrap();
        let config = reopened.store.config().unwrap();
        let saved = config.providers.iter().find(|p| p.id == id).unwrap();
        assert!(saved.access_token.is_empty());
        assert!(saved.refresh_token.is_empty());
        assert_eq!(
            reopened.store.unseal(&saved.password).unwrap(),
            "sub-password-secret"
        );
        assert_private(&serde_json::to_value(config).unwrap());
        assert_eq!(mock.refreshes.load(Ordering::SeqCst), 0);
        let calls = mock.calls.lock().unwrap();
        let logins = calls
            .iter()
            .filter(|call| call.path == "/api/v1/auth/login")
            .collect::<Vec<_>>();
        assert_eq!(logins.len(), if proof.is_some() { 2 } else { 0 });
        for login in logins {
            assert_eq!(login.body["turnstile_token"], proof.unwrap());
        }
    }
}

#[tokio::test]
async fn turnstile_proof_is_not_replayed_when_new_login_access_is_rejected() {
    let (_dir, state) = fixture();
    let cookie = setup(&state).await;
    let (url, mock, _server) = mock_server().await;
    mock.require_turnstile.store(true, Ordering::SeqCst);
    mock.omit_refresh_token.store(true, Ordering::SeqCst);
    mock.expire_login_access.store(true, Ordering::SeqCst);
    mock.minimum_token.store(1, Ordering::SeqCst);
    let mut input = form(&url, "sub2api", "password");
    input["username"] = json!("sub@example.com");
    input["password"] = json!("sub-password-secret");
    input["turnstile_token"] = json!("mock-turnstile-proof-never-persist");
    let (status, rejected, _) =
        request(&state, "POST", "/api/providers/test", input, &cookie).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{rejected}");
    assert_eq!(rejected["error"], "站点认证失败，请检查登录信息或更新令牌");
    assert_private(&rejected);
    assert!(state.store.config().unwrap().providers.is_empty());
    assert_eq!(mock.refreshes.load(Ordering::SeqCst), 0);
    let calls = mock.calls.lock().unwrap();
    let logins = calls
        .iter()
        .filter(|call| call.path == "/api/v1/auth/login")
        .collect::<Vec<_>>();
    assert_eq!(
        logins.len(),
        1,
        "a consumed proof must never authorize another login"
    );
    assert_eq!(
        logins[0].body["turnstile_token"],
        "mock-turnstile-proof-never-persist"
    );
}

#[tokio::test]
async fn expired_password_session_requires_new_turnstile_proof() {
    const TURNSTILE_TOKEN: &str = "mock-turnstile-proof-never-persist";
    let (_dir, state) = fixture();
    let cookie = setup(&state).await;
    let (url, mock, _server) = mock_server().await;
    mock.require_turnstile.store(true, Ordering::SeqCst);
    mock.omit_refresh_token.store(true, Ordering::SeqCst);
    let mut input = form(&url, "sub2api", "password");
    input["username"] = json!("sub@example.com");
    input["password"] = json!("sub-password-secret");
    input["turnstile_token"] = json!(TURNSTILE_TOKEN);
    let (status, tested, _) = request(
        &state,
        "POST",
        "/api/providers/test",
        input.clone(),
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{tested}");
    let (status, created, _) =
        request(&state, "POST", "/api/providers", input.clone(), &cookie).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap();

    mock.minimum_token.store(1, Ordering::SeqCst);
    let (status, expired, _) = request(
        &state,
        "POST",
        &format!("/api/providers/{id}/refresh"),
        Value::Null,
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{expired}");
    assert!(expired["error"].as_str().unwrap().contains("Turnstile"));
    let logins_before_reauth = mock
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|call| call.path == "/api/v1/auth/login")
        .count();
    assert_eq!(
        logins_before_reauth, 1,
        "refresh must not retry password login without proof"
    );

    let (status, reauthenticated, _) =
        request(&state, "POST", "/api/providers/test", input, &cookie).await;
    assert_eq!(status, StatusCode::OK, "{reauthenticated}");
    let logins_after_reauth = mock
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|call| call.path == "/api/v1/auth/login")
        .count();
    assert_eq!(
        logins_after_reauth, 2,
        "fresh proof should authorize one new login"
    );
}

#[tokio::test]
async fn sub2api_refresh_only_rotates_encrypted_credentials_across_reopen() {
    let (dir, state) = fixture();
    let cookie = setup(&state).await;
    let (url, mock, _server) = mock_server().await;
    let mut input = form(&url, "sub2api", "token");
    input["refresh_token"] = json!("initial-refresh-secret");
    let created = create_and_refresh(&state, input.clone(), &cookie).await;
    let id = created["id"].as_str().unwrap().to_owned();
    assert_metrics(&created, 12.5, 1.25, 7.5, 20.0);
    assert_eq!(created["has_access_token"], true);
    assert_eq!(created["has_refresh_token"], true);
    assert_eq!(mock.refreshes.load(Ordering::SeqCst), 1);
    assert_private(&created);
    assert_private(&serde_json::to_value(state.store.config().unwrap()).unwrap());

    input["refresh_token"] = json!("");
    input["name"] = json!("Renamed without credentials");
    let (status, edited, _) = request(
        &state,
        "PUT",
        &format!("/api/providers/{id}"),
        input,
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["has_refresh_token"], true);

    mock.minimum_token.store(2, Ordering::SeqCst);
    let (status, refreshed, _) = request(
        &state,
        "POST",
        &format!("/api/providers/{id}/refresh"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{refreshed}");
    assert!(mock.refreshes.load(Ordering::SeqCst) >= 2);
    assert_private(&refreshed);
    assert_private(&serde_json::to_value(state.store.config().unwrap()).unwrap());
    drop(state);

    let reopened = new_app(dir.path(), dir.path().join("web")).unwrap();
    let (status, _, cookie) = request(
        &reopened,
        "POST",
        "/api/login",
        json!({"username":"admin","password":"integration-password-123"}),
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, list, _) = request(&reopened, "GET", "/api/providers", Value::Null, &cookie).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], id);
    assert_eq!(list[0]["name"], "Renamed without credentials");
    mock.minimum_token
        .store(mock.refreshes.load(Ordering::SeqCst) + 1, Ordering::SeqCst);
    let (status, refreshed, _) = request(
        &reopened,
        "POST",
        &format!("/api/providers/{id}/refresh"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{refreshed}");
    assert!(mock.refreshes.load(Ordering::SeqCst) >= 3);
    assert_metrics(&refreshed, 12.5, 1.25, 7.5, 20.0);
    assert_private(&refreshed);
}

#[tokio::test]
async fn changing_site_requires_new_credentials_and_refresh_failure_preserves_metrics() {
    let (_dir, state) = fixture();
    let cookie = setup(&state).await;
    let (url, mock, _server) = mock_server().await;
    let (other_url, other_mock, _other_server) = mock_server().await;
    let mut input = form(&url, "newapi", "token");
    input["user_id"] = json!("42");
    input["access_token"] = json!("system-token-secret");
    let created = create_and_refresh(&state, input.clone(), &cookie).await;
    let id = created["id"].as_str().unwrap();
    input["access_token"] = json!("");
    input["base_url"] = json!(other_url);
    let (status, rejected, _) = request(
        &state,
        "PUT",
        &format!("/api/providers/{id}"),
        input,
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{rejected}");
    assert!(
        other_mock.calls.lock().unwrap().is_empty(),
        "old credentials were sent to a different site"
    );
    let (_, list, _) = request(&state, "GET", "/api/providers", Value::Null, &cookie).await;
    assert_eq!(list[0]["base_url"], url);

    mock.unavailable.store(true, Ordering::SeqCst);
    let (status, failed, _) = request(
        &state,
        "POST",
        &format!("/api/providers/{id}/refresh"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{failed}");
    assert_private(&failed);
    let (_, list, _) = request(&state, "GET", "/api/providers", Value::Null, &cookie).await;
    assert_eq!(list[0]["status"], "error");
    assert!(!list[0]["last_error"].as_str().unwrap().is_empty());
    assert_eq!(list[0]["last_synced_at"], created["last_synced_at"]);
    assert_metrics(&list[0], 2.0, 0.5, 1.0, 3.0);
    assert_private(&list[0]);

    mock.unavailable.store(false, Ordering::SeqCst);
    let (status, restored, _) = request(
        &state,
        "POST",
        &format!("/api/providers/{id}/refresh"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(restored["status"], "connected");
    assert!(restored["last_error"].is_null());
}

#[tokio::test]
async fn newapi_http_200_authentication_failure_is_not_a_successful_test() {
    let (_dir, state) = fixture();
    let cookie = setup(&state).await;
    let (url, _mock, _server) = mock_server().await;
    let mut input = form(&url, "newapi", "token");
    input["user_id"] = json!("42");
    input["access_token"] = json!("invalid-system-token");
    let (status, result, _) = request(&state, "POST", "/api/providers/test", input, &cookie).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{result}");
    assert_ne!(result["ok"], true);
    let (_, list, _) = request(&state, "GET", "/api/providers", Value::Null, &cookie).await;
    assert_eq!(list.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn testing_saved_credentials_keeps_rotated_tokens_when_statistics_fail() {
    let (_dir, state) = fixture();
    let cookie = setup(&state).await;
    let (url, mock, _server) = mock_server().await;
    let mut input = form(&url, "sub2api", "token");
    input["access_token"] = json!("direct-access-secret");
    input["refresh_token"] = json!("initial-refresh-secret");
    let created = create_and_refresh(&state, input.clone(), &cookie).await;
    let id = created["id"].as_str().unwrap();
    input["id"] = json!(id);
    input["access_token"] = json!("");
    input["refresh_token"] = json!("");
    mock.minimum_token.store(1, Ordering::SeqCst);
    mock.fail_stats.store(true, Ordering::SeqCst);
    let (status, failed, _) = request(&state, "POST", "/api/providers/test", input, &cookie).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{failed}");
    assert_eq!(mock.refreshes.load(Ordering::SeqCst), 1);
    let (_, list, _) = request(&state, "GET", "/api/providers", Value::Null, &cookie).await;
    assert_metrics(&list[0], 12.5, 1.25, 7.5, 20.0);
    assert_eq!(list[0]["last_synced_at"], created["last_synced_at"]);
    mock.fail_stats.store(false, Ordering::SeqCst);
    mock.minimum_token.store(2, Ordering::SeqCst);
    let (status, refreshed, _) = request(
        &state,
        "POST",
        &format!("/api/providers/{id}/refresh"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "rotated refresh token was lost after the failed test: {refreshed}"
    );
    assert_metrics(&refreshed, 12.5, 1.25, 7.5, 20.0);
}

#[tokio::test]
async fn testing_unsaved_refresh_only_credentials_survives_saving_the_original_form() {
    let (_dir, state) = fixture();
    let cookie = setup(&state).await;
    let (url, mock, _server) = mock_server().await;
    let mut input = form(&url, "sub2api", "token");
    input["refresh_token"] = json!("initial-refresh-secret");
    let (status, tested, _) = request(
        &state,
        "POST",
        "/api/providers/test",
        input.clone(),
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{tested}");
    assert_metrics(&tested, 12.5, 1.25, 7.5, 20.0);
    assert_private(&tested);
    assert_eq!(mock.refreshes.load(Ordering::SeqCst), 1);
    // The UI validates once more during Save after an explicit Test login click.
    let (status, retested, _) = request(
        &state,
        "POST",
        "/api/providers/test",
        input.clone(),
        &cookie,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "retesting the original form lost its rotated tokens: {retested}"
    );
    assert_private(&retested);
    assert_eq!(mock.refreshes.load(Ordering::SeqCst), 1);
    let created = create_and_refresh(&state, input, &cookie).await;
    assert_eq!(
        mock.refreshes.load(Ordering::SeqCst),
        1,
        "saving after test reused the consumed refresh token"
    );
    let id = created["id"].as_str().unwrap();
    mock.minimum_token.store(2, Ordering::SeqCst);
    let (status, refreshed, _) = request(
        &state,
        "POST",
        &format!("/api/providers/{id}/refresh"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "rotation from unsaved test was not retained: {refreshed}"
    );
    assert_eq!(mock.refreshes.load(Ordering::SeqCst), 2);
    assert_private(&refreshed);
}

#[tokio::test]
async fn testing_saved_refresh_only_form_does_not_restore_consumed_refresh_token() {
    let (_dir, state) = fixture();
    let cookie = setup(&state).await;
    let (url, mock, _server) = mock_server().await;
    let mut input = form(&url, "sub2api", "token");
    input["refresh_token"] = json!("initial-refresh-secret");
    let (status, created, _) =
        request(&state, "POST", "/api/providers", input.clone(), &cookie).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap();
    input["id"] = json!(id);
    let (status, tested, _) = request(
        &state,
        "POST",
        "/api/providers/test",
        input.clone(),
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{tested}");
    assert_eq!(mock.refreshes.load(Ordering::SeqCst), 1);
    let (status, saved, _) = request(
        &state,
        "PUT",
        &format!("/api/providers/{id}"),
        input,
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    mock.minimum_token.store(2, Ordering::SeqCst);
    let (status, refreshed, _) = request(
        &state,
        "POST",
        &format!("/api/providers/{id}/refresh"),
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "saving the tested refresh-only form restored a consumed token: {refreshed}"
    );
    assert_eq!(mock.refreshes.load(Ordering::SeqCst), 2);
    assert_private(&refreshed);
}
