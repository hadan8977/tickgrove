use crate::{App, commands::required};
use serde_json::{Value, json};
use sqlx::Row;
use std::path::PathBuf;
fn manifest(app: &App, id: &str) -> anyhow::Result<(PathBuf, Value)> {
    anyhow::ensure!(
        id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
        "Invalid plugin ID"
    );
    let base = app.root.join("extensions").canonicalize()?;
    let dir = base.join(id);
    anyhow::ensure!(
        !std::fs::symlink_metadata(&dir)?.file_type().is_symlink(),
        "Plugin symlinks forbidden"
    );
    let dir = dir.canonicalize()?;
    anyhow::ensure!(dir.starts_with(&base), "Plugin path escape");
    let value: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("plugin.json"))?)?;
    anyhow::ensure!(
        value["id"] == id && value["api_version"] == "trading.plugin.v1",
        "Unsupported plugin manifest"
    );
    let permissions = value["permissions"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("permissions array required"))?;
    anyhow::ensure!(
        permissions.iter().all(|p| p == "input.read"),
        "Host denies requested permission"
    );
    required(&value, "version")?;
    let entry = required(&value, "entrypoint")?;
    anyhow::ensure!(
        entry == "index.cjs"
            && !std::fs::symlink_metadata(dir.join(entry))?
                .file_type()
                .is_symlink(),
        "Only regular index.cjs entrypoints supported"
    );
    Ok((dir, value))
}
pub async fn execute(app: &App, method: &str, p: &Value) -> anyhow::Result<Value> {
    match method {
        "plugins.list" => {
            let mut list = Vec::new();
            for entry in std::fs::read_dir(app.root.join("extensions"))? {
                let entry = entry?;
                let id = entry.file_name().to_string_lossy().to_string();
                if let Ok((_, m)) = manifest(app, &id) {
                    let enabled =
                        sqlx::query_scalar::<_, i64>("SELECT enabled FROM plugin_state WHERE id=?")
                            .bind(&id)
                            .fetch_optional(&app.db)
                            .await?
                            .unwrap_or(0)
                            != 0;
                    list.push(json!({"manifest":m,"enabled":enabled}));
                }
            }
            Ok(json!(list))
        }
        "plugins.validate" => {
            let (_, m) = manifest(app, required(p, "id")?)?;
            Ok(
                json!({"valid":true,"manifest":m,"isolation":"networkless read-only bubblewrap process; only caller-provided JSON input"}),
            )
        }
        "plugins.enable" | "plugins.disable" => {
            let id = required(p, "id")?;
            let (_, m) = manifest(app, id)?;
            sqlx::query("INSERT INTO plugin_state VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,version=excluded.version,manifest=excluded.manifest").bind(id).bind(i64::from(method=="plugins.enable")).bind(m["version"].as_str().unwrap()).bind(m.to_string()).execute(&app.db).await?;
            Ok(json!({"id":id,"enabled":method=="plugins.enable"}))
        }
        "plugins.call" => {
            let id = required(p, "id")?;
            let (dir, _) = manifest(app, id)?;
            let row = sqlx::query("SELECT enabled FROM plugin_state WHERE id=?")
                .bind(id)
                .fetch_optional(&app.db)
                .await?;
            anyhow::ensure!(
                row.is_some_and(|r| r.get::<i64, _>("enabled") != 0),
                "Plugin not enabled"
            );
            let _permit = app
                .execution_budget
                .try_acquire()
                .map_err(|_| anyhow::anyhow!("Execution budget busy; retry plugin later"))?;
            let command = crate::sandbox::command(
                &app.node,
                &[(dir, "/plugin".into())],
                "/plugin/index.cjs",
                64,
            );
            let bytes = p["input"].to_string();
            anyhow::ensure!(bytes.len() <= 8_000_000, "Plugin input too large");
            let output =
                crate::sandbox::execute(command, bytes.into_bytes(), 5, 16_000_000, None).await?;
            anyhow::ensure!(
                output.status == "succeeded",
                "Plugin process {}",
                output.status
            );
            let value: Value = serde_json::from_slice(&output.stdout)?;
            anyhow::ensure!(value["ok"] == true, "Plugin failed: {value}");
            Ok(value)
        }
        _ => anyhow::bail!("Unknown plugin command"),
    }
}
