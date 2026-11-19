#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().init();
    let state = multi_acp_gateway::update::Agent::from_env().await?;
    let listener = tokio::net::TcpListener::bind("0.0.0.0:9000").await?;
    axum::serve(listener, multi_acp_gateway::update::agent_app(state)).await?;
    Ok(())
}
