use serde_json::Value;
pub fn permission(method: &str) -> &'static str {
    if method == "pine.host.feedback" {
        return "broker.feedback";
    }
    if method.starts_with("pine.host.")
        && ![
            "pine.host.list",
            "pine.host.status",
            "pine.host.events",
            "pine.host.render",
        ]
        .contains(&method)
    {
        return "paper.manage";
    }
    if method == "pine.prepareData" {
        return "data.write";
    }
    if method == "pine.library.createVersion" {
        return "pine.library.write";
    }
    if method.starts_with("account.") && !["account.state", "account.events"].contains(&method) {
        "paper.manage"
    } else if method.starts_with("alerts.")
        && !["alerts.list", "alerts.history", "alerts.strategyHistory"].contains(&method)
    {
        "alerts.manage"
    } else if method == "workspace.save" {
        "workspace.write"
    } else if [
        "market.history",
        "market.bundle",
        "market.subscribe",
        "market.stop",
    ]
    .contains(&method)
    {
        "data.write"
    } else if method.starts_with("strategy.create") {
        "strategy.write"
    } else if method == "data.import" || method == "data.fetch" {
        "data.write"
    } else if method == "backtest.start" || method == "backtest.cancel" {
        "backtest.run"
    } else if method.starts_with("paper.") && method != "paper.list" {
        "paper.manage"
    } else if ["orders.submit", "orders.cancel", "orders.reconcile"].contains(&method) {
        "broker.paper"
    } else if method.starts_with("plugins.") && method != "plugins.list" {
        "plugins.manage"
    } else {
        "read"
    }
}
pub fn scopes(owner: &str, provided: &str) -> anyhow::Result<Vec<String>> {
    if let Ok(path) = std::env::var("TRADING_TOKENS_FILE") {
        let config: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        let entries = config
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Token configuration must be array"))?;
        for entry in entries {
            if entry["token"].as_str() == Some(provided) && provided.len() >= 24 {
                let scopes = entry["permissions"]
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("Invalid token permissions"))?
                    .iter()
                    .map(|v| v.as_str().unwrap_or("").to_string())
                    .collect();
                return Ok(scopes);
            }
        }
        anyhow::bail!("Unknown/revoked token")
    }
    anyhow::ensure!(provided == owner, "Invalid token");
    Ok(vec![
        "read",
        "workspace.write",
        "pine.library.write",
        "broker.feedback",
        "alerts.manage",
        "strategy.write",
        "data.write",
        "backtest.run",
        "paper.manage",
        "broker.paper",
        "plugins.manage",
    ]
    .into_iter()
    .map(String::from)
    .collect())
}
