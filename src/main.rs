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
    let data = std::env::var("DATA_DIR").unwrap_or_else(|_| "data".into());
    let web = std::env::var("WEB_DIR").unwrap_or_else(|_| "web/dist".into());
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8046".into());
    let state = multi_acp_gateway::new_app(std::path::Path::new(&data), web.into())?;
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(address=%bind,"Multi-ACP Gateway is listening");
    axum::serve(listener, multi_acp_gateway::app(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
