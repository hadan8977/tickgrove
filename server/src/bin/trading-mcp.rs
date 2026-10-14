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
    #[tool(
        description = "Execute an authenticated trading.commands.v1 command against the same service used by Web and CLI. Discover commands with system.capabilities. Backtests return persistent job IDs; read progress/events/results or cancel explicitly."
    )]
    async fn trading_command(
        &self,
        Parameters(request): Parameters<Request>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
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
#[tool_handler]
impl ServerHandler for Bridge {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions=Some("Trading service bridge; authorization and persistence occur at the application service.".into());
        info
    }
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
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
