fn resolve_data_dir_from(
    data_dir_env: Option<&str>,
    app_data_dir_env: Option<&str>,
) -> std::path::PathBuf {
    if let Some(data_dir) = data_dir_env.map(str::trim).filter(|s| !s.is_empty()) {
        return std::path::PathBuf::from(data_dir);
    }
    if let Some(app_data_dir) = app_data_dir_env.map(str::trim).filter(|s| !s.is_empty()) {
        return std::path::Path::new(app_data_dir).join("8046");
    }
    std::path::PathBuf::from("data")
}

fn resolve_web_dir_from(web_dir_env: Option<&str>) -> std::path::PathBuf {
    if let Some(web_dir) = web_dir_env.map(str::trim).filter(|s| !s.is_empty()) {
        let candidate = std::path::PathBuf::from(web_dir);
        if candidate.is_dir() {
            return candidate;
        }
    }
    std::path::PathBuf::new()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::path::Path::new(".env").exists() {
        dotenvy::dotenv()?;
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "multi_acp_gateway=info".into()),
        )
        .init();
    let data_dir = resolve_data_dir_from(
        std::env::var("DATA_DIR").ok().as_deref(),
        std::env::var("APP_DATA_DIR").ok().as_deref(),
    );
    std::fs::create_dir_all(&data_dir)?;
    let web_dir = resolve_web_dir_from(std::env::var("WEB_DIR").ok().as_deref());
    let web_source = if web_dir.as_os_str().is_empty() {
        "embedded".to_string()
    } else {
        format!("external:{}", web_dir.display())
    };
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8046".into());
    tracing::info!(
        data_dir = %data_dir.display(),
        web_source = %web_source,
        "Resolved gateway runtime paths"
    );
    let state = multi_acp_gateway::new_app(&data_dir, web_dir)?;
    state
        .autostart_sync
        .store(true, std::sync::atomic::Ordering::Relaxed);
    match state.store.config() {
        Ok(config) => {
            if let Err(error) = multi_acp_gateway::autostart::apply(config.settings.autostart_enabled) {
                tracing::warn!(error = %error, "Failed to sync autostart scripts on startup");
            }
        }
        Err(error) => {
            tracing::warn!(error = %error, "Failed to read config for autostart sync on startup");
        }
    }
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(address=%bind,"Multi-ACP Gateway is listening");
    axum::serve(listener, multi_acp_gateway::app(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn resolve_data_dir_follows_priority_data_dir_over_app_data_dir_over_default() {
        assert_eq!(
            resolve_data_dir_from(Some("custom-data"), Some("app-data-root")),
            PathBuf::from("custom-data")
        );
        assert_eq!(
            resolve_data_dir_from(Some("  "), Some("app-data-root")),
            PathBuf::from("app-data-root").join("8046")
        );
        assert_eq!(
            resolve_data_dir_from(None, Some("app-data-root")),
            PathBuf::from("app-data-root").join("8046")
        );
        assert_eq!(
            resolve_data_dir_from(None, Some("")),
            PathBuf::from("data")
        );
        assert_eq!(resolve_data_dir_from(None, None), PathBuf::from("data"));
    }

    #[test]
    fn resolve_web_dir_uses_existing_dir_else_empty_for_embedded() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_web_dir_from(Some(dir.path().to_str().unwrap())),
            dir.path().to_path_buf()
        );
        assert_eq!(
            resolve_web_dir_from(Some(dir.path().join("missing").to_str().unwrap())),
            PathBuf::new()
        );
        assert_eq!(resolve_web_dir_from(Some("  ")), PathBuf::new());
        assert_eq!(resolve_web_dir_from(None), PathBuf::new());
    }
}
