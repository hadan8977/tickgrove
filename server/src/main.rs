mod account;
mod alerts;
mod alpaca;
mod auth;
mod commands;
mod market;
mod paper;
mod paper_stream;
mod pine_host;
mod pine_libraries;
mod pine_requests;
mod plugins;
mod sandbox;
mod worker;
mod workspace;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde_json::{Value, json};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{path::PathBuf, str::FromStr};
use tower_http::services::{ServeDir, ServeFile};
#[derive(Clone)]
pub struct App {
    pub db: SqlitePool,
    pub token: String,
    pub root: PathBuf,
    pub node: PathBuf,
    pub execution_budget: std::sync::Arc<tokio::sync::Semaphore>,
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let root = std::env::var("TRADING_ROOT")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    let dir = std::env::var("TRADING_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or(root.join("var"));
    std::fs::create_dir_all(&dir)?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("instance.lock"))?;
    fs2::FileExt::try_lock_exclusive(&lock)
        .map_err(|_| anyhow::anyhow!("Data directory already in use"))?;
    let bind = std::env::var("TRADING_BIND").unwrap_or("127.0.0.1:8787".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    let token = match std::env::var("TRADING_TOKEN") {
        Ok(v) if v.len() >= 24 => v,
        Ok(_) => anyhow::bail!("TRADING_TOKEN must contain at least 24 characters"),
        Err(_) => {
            let p = dir.join("auth-token");
            if p.exists() {
                std::fs::read_to_string(p)?.trim().to_string()
            } else {
                let v = uuid::Uuid::new_v4().to_string();
                {
                    use std::io::Write;
                    let mut opts = std::fs::OpenOptions::new();
                    opts.write(true).create_new(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        opts.mode(0o600);
                    }
                    let mut f = opts.open(&p)?;
                    f.write_all(v.as_bytes())?;
                    f.sync_all()?;
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600))?;
                }
                eprintln!("Authentication token saved to {}", p.display());
                v
            }
        }
    };
    anyhow::ensure!(
        token.len() >= 24,
        "Authentication token must contain at least 24 characters"
    );
    let options = SqliteConnectOptions::from_str(&format!(
        "sqlite://{}",
        dir.join("trading.sqlite").display()
    ))?
    .create_if_missing(true)
    .foreign_keys(true)
    .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
    let db = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    sqlx::migrate!().run(&db).await?;
    // Interrupted computation has no committed successful outcome. Queued jobs resume; running jobs become interrupted.
    let mut recovery = db.begin().await?;
    sqlx::query("INSERT INTO events(job_id,kind,payload) SELECT id,'interrupted','{\"reason\":\"service restarted\"}' FROM jobs WHERE status='running'").execute(&mut *recovery).await?;
    sqlx::query("UPDATE jobs SET status='interrupted',error='Service restarted during execution' WHERE status='running'").execute(&mut *recovery).await?;
    sqlx::query("INSERT INTO broker_events(client_order_id,state,payload) SELECT client_order_id,'unknown','{\"reason\":\"service restarted during submission\"}' FROM broker_orders WHERE state='submitting'").execute(&mut *recovery).await?;
    sqlx::query("UPDATE broker_orders SET state='unknown',error='Service restarted during submission; reconcile before retry' WHERE state='submitting'").execute(&mut *recovery).await?;
    recovery.commit().await?;
    let app = App {
        db,
        token,
        root: root.clone(),
        node: sandbox::node_path()?,
        execution_budget: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
    };
    tokio::spawn(worker::queue(app.clone()));
    market::resume(&app).await?;
    tokio::spawn(paper_stream::run(app.clone()));
    tokio::spawn(pine_host::coordinator(app.clone()));
    let router = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({"ok":true,"service":"trading-service","version":"0.1.0"}))
            }),
        )
        .route("/api/command", post(command))
        .layer(DefaultBodyLimit::max(16_000_000))
        .fallback_service(
            ServeDir::new(root.join("dist"))
                .not_found_service(ServeFile::new(root.join("dist/index.html"))),
        )
        .with_state(app);
    eprintln!("Trading service listening on {bind}");
    axum::serve(listener, router).await?;
    Ok(())
}
async fn command(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let provided = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    let scopes = auth::scopes(&app.token, provided).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized"})),
        )
    })?;
    let method = body["method"].as_str().unwrap_or("");
    if !scopes.iter().any(|s| s == auth::permission(method)) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({"error":"permission_denied","required":auth::permission(method)})),
        ));
    }
    if method == "system.capabilities" {
        let mut info = commands::execute(&app, body).await.map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":e.to_string()})),
            )
        })?;
        info["permissions"] = json!(scopes);
        return Ok(Json(info));
    }
    commands::execute(&app, body).await.map(Json).map_err(|e| {
        (
            if e.to_string().contains("revision_conflict")
                || e.to_string().contains("client_order_id_conflict")
                || e.to_string().contains("library_version_conflict")
            {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            },
            Json(json!({"error":e.to_string()})),
        )
    })
}
