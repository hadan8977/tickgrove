use crate::App;
use serde_json::{Value, json};
use sqlx::Row;
pub async fn execute(app: &App, method: &str, p: &Value) -> anyhow::Result<Value> {
    let id = p["id"].as_str().unwrap_or("default");
    anyhow::ensure!(id.len() <= 128, "Workspace id too long");
    match method {
        "workspace.get" => {
            let row = sqlx::query("SELECT * FROM workspaces WHERE id=?")
                .bind(id)
                .fetch_optional(&app.db)
                .await?;
            Ok(if let Some(row) = row {
                json!({"id":id,"revision":row.get::<i64,_>("revision"),"data":row.get::<Option<String>,_>("data").and_then(|s|serde_json::from_str::<Value>(&s).ok()),"updatedAt":row.get::<String,_>("updated_at")})
            } else {
                json!({"id":id,"revision":0,"data":Value::Null,"updatedAt":Value::Null})
            })
        }
        "workspace.save" => {
            let data = p
                .get("data")
                .ok_or_else(|| anyhow::anyhow!("Workspace data required"))?;
            anyhow::ensure!(data.is_object(), "Workspace data must be object");
            let revision = p["revision"]
                .as_i64()
                .ok_or_else(|| anyhow::anyhow!("revision required"))?;
            let payload = data.to_string();
            anyhow::ensure!(payload.len() <= 4_000_000, "Workspace exceeds limit");
            let mut tx = app.db.begin().await?;
            let current =
                sqlx::query_scalar::<_, i64>("SELECT revision FROM workspaces WHERE id=?")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?
                    .unwrap_or(0);
            anyhow::ensure!(
                current == revision,
                "revision_conflict: current={current}, received={revision}"
            );
            sqlx::query("INSERT INTO workspaces(id,revision,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=CURRENT_TIMESTAMP").bind(id).bind(current+1).bind(payload).execute(&mut *tx).await?;
            let updated: String =
                sqlx::query_scalar("SELECT updated_at FROM workspaces WHERE id=?")
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?;
            tx.commit().await?;
            Ok(json!({"id":id,"revision":current+1,"data":data,"updatedAt":updated}))
        }
        _ => anyhow::bail!("Unknown workspace command"),
    }
}
