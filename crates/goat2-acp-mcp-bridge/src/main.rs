use goat2_acp_mcp_bridge::run_stdio_bridge;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let (Ok(endpoint), Ok(authorization)) = (
        std::env::var("GOAT_ACP_MCP_ENDPOINT"),
        std::env::var("GOAT_ACP_MCP_AUTHORIZATION"),
    ) else {
        eprintln!("acp-mcp-bridge requires GOAT_ACP_MCP_ENDPOINT and GOAT_ACP_MCP_AUTHORIZATION.");
        std::process::exit(2);
    };
    let _ = run_stdio_bridge(
        endpoint,
        authorization,
        tokio::io::stdin(),
        tokio::io::stdout(),
    )
    .await;
}
