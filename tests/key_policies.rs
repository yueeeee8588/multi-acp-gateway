use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tower::ServiceExt;
use multi_acp_gateway::{
    Shared, app, new_app, profiles,
    store::{Account, Group, ProviderBinding},
};

fn fixture() -> (tempfile::TempDir, Shared) {
    let dir = tempfile::tempdir().unwrap();
    let state = new_app(dir.path(), dir.path().join("web")).unwrap();
    state.store.session("key-policy-session").unwrap();
    state
        .store
        .update(|config| {
            for id in ["first", "second", "alias-only"] {
                config.groups.push(Group {
                    id: id.into(),
                    name: id.into(),
                    ..Default::default()
                });
            }
            Ok(())
        })
        .unwrap();
    (dir, state)
}

async fn console(state: &Shared, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = app(state.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("x-console-path", "/")
                .header("cookie", "zako_session=key-policy-session")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))),
    )
}

#[tokio::test]
async fn group_description_defaults_persists_multiline_and_clears() {
    let (dir, state) = fixture();
    let (_, initial) = console(&state, "GET", "/api/groups", Value::Null).await;
    assert_eq!(initial[0]["description"], "");
    assert!(initial[0].get("profile_ids").is_none());
    assert!(initial[0].get("default_strategy_enabled").is_none());
    let description =
        "可用模型介绍\n第二行：支持换行与 emoji 🐾\nhttps://example.test/long-description";
    let (status, saved) = console(
        &state,
        "PUT",
        "/api/groups/first",
        json!({"name":"First group", "description":description}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["description"], description);
    drop(state);
    let state = new_app(dir.path(), dir.path().join("web")).unwrap();
    let (_, listed) = console(&state, "GET", "/api/groups", Value::Null).await;
    assert_eq!(listed[0]["description"], description);
    let (status, cleared) = console(
        &state,
        "PUT",
        "/api/groups/first",
        json!({"name":"First group", "description":""}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(cleared["description"], "");
    drop(state);
    let state = new_app(dir.path(), dir.path().join("web")).unwrap();
    assert!(
        state.store.config().unwrap().groups[0]
            .description
            .is_empty()
    );
    let (status, created) = console(
        &state,
        "POST",
        "/api/groups",
        json!({"name":"No introduction"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["description"], "");
}

#[tokio::test]
async fn malformed_descriptions_do_not_replace_existing_group() {
    let (_dir, state) = fixture();
    for invalid in [Value::Null, json!(42), json!(false), json!([]), json!({})] {
        let (status, rejected) = console(
            &state,
            "PUT",
            "/api/groups/first",
            json!({"name":"Invalid", "description":invalid}),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{rejected}");
        let group = &state.store.config().unwrap().groups[0];
        assert_eq!(group.name, "first");
        assert!(group.description.is_empty());
    }
}
