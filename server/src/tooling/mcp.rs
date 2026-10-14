use rmcp::{
    ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars, tool, tool_handler, tool_router,
};
use serde_json::Value;
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct Request {
    method: String,
    #[serde(default)]
    params: Value,
    idempotency_key: Option<String>,
}
#[derive(Clone)]
struct Bridge {
    url: String,
    token: String,
    client: reqwest::Client,
    tool_router: ToolRouter<Self>,
}
#[tool_router]
impl Bridge {
    fn new(url: String, token: String) -> Self {
        Self {
            url,
            token,
            client: reqwest::Client::new(),
            tool_router: Self::tool_router(),
        }
    }
    #[tool(description = "Execute an authenticated Tickgrove command using trading.commands.v1. Discover commands with system.capabilities; jobs, progress, results and cancellation are persistent server operations.")]
    async fn tickgrove_command(&self, Parameters(request): Parameters<Request>) -> Result<CallToolResult, rmcp::ErrorData> {
        self.forward(request).await
    }
    #[tool(description = "Compatibility alias for tickgrove_command; uses the same authenticated Tickgrove command service and existing trading.commands.v1 protocol.")]
    async fn trading_command(&self, Parameters(request): Parameters<Request>) -> Result<CallToolResult, rmcp::ErrorData> {
        self.forward(request).await
    }
    async fn forward(&self, request: Request) -> Result<CallToolResult, rmcp::ErrorData> {
        let response=self.client.post(format!("{}/api/command",self.url)).bearer_auth(&self.token).json(&serde_json::json!({"method":request.method,"params":request.params,"idempotency_key":request.idempotency_key})).send().await.map_err(|e|rmcp::ErrorData::internal_error(e.to_string(),None))?;
        let ok = response.status().is_success();
        let value = response
            .text()
            .await
            .map_err(|e| rmcp::ErrorData::internal_error(e.to_string(), None))?;
        if ok {
            Ok(CallToolResult::success(vec![ContentBlock::text(value)]))
        } else {
            Ok(CallToolResult::error(vec![ContentBlock::text(value)]))
        }
    }
}
#[tool_handler(router = self.tool_router)]
impl ServerHandler for Bridge {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.server_info = Implementation::new("tickgrove-mcp", env!("CARGO_PKG_VERSION")).with_title("Tickgrove");
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions=Some("Tickgrove service bridge; authorization and persistence occur at the application service.".into());
        info
    }
}
pub async fn run() -> anyhow::Result<()> {
    let token = match std::env::var("TRADING_TOKEN") {
        Ok(value) => value,
        Err(_) => std::fs::read_to_string(
            std::env::var("TRADING_TOKEN_FILE").unwrap_or("var/auth-token".into()),
        )?
        .trim()
        .to_string(),
    };
    anyhow::ensure!(
        token.len() >= 24,
        "Token must contain at least 24 characters"
    );
    let service = Bridge::new(
        std::env::var("TRADING_URL").unwrap_or("http://127.0.0.1:8787".into()),
        token,
    )
    .serve(rmcp::transport::stdio())
    .await?;
    service.waiting().await?;
    Ok(())
}
