use crate::App;
use std::{path::PathBuf, process::Stdio};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::{Duration, Instant, sleep},
};
pub fn node_path() -> anyhow::Result<PathBuf> {
    if let Ok(path) = std::env::var("TRADING_NODE") {
        return Ok(PathBuf::from(path).canonicalize()?);
    }
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let path = dir.join("node");
        if path.is_file() {
            return Ok(path.canonicalize()?);
        }
    }
    anyhow::bail!("Node executable not found; configure TRADING_NODE")
}
pub fn command(node: &PathBuf, mounts: &[(PathBuf, String)], entry: &str, heap: u32) -> Command {
    command_budget(node, mounts, entry, heap, 35, false)
}
pub fn persistent_command(
    node: &PathBuf,
    mounts: &[(PathBuf, String)],
    entry: &str,
    heap: u32,
) -> Command {
    command_budget(node, mounts, entry, heap, libc::RLIM_INFINITY, true)
}
fn command_budget(
    node: &PathBuf,
    mounts: &[(PathBuf, String)],
    entry: &str,
    heap: u32,
    cpu_budget: u64,
    permission: bool,
) -> Command {
    let mut cmd = Command::new("bwrap");
    cmd.args([
        "--die-with-parent",
        "--new-session",
        "--unshare-all",
        "--clearenv",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/usr",
        "--dir",
        "/usr/bin",
        "--dir",
        "/app",
    ]);
    for path in ["/lib", "/lib64"] {
        cmd.args(["--ro-bind", path, path]);
    }
    cmd.arg("--ro-bind").arg(node).arg("/usr/bin/node");
    for (host, guest) in mounts {
        cmd.arg("--ro-bind").arg(host).arg(guest);
    }
    cmd.args(["--chdir", "/app", "--", "/usr/bin/node"])
        .arg(format!("--max-old-space-size={heap}"));
    if permission {
        cmd.args(["--experimental-permission", "--allow-fs-read=/app"]);
    }
    cmd.arg(entry);
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(move || {
            for (resource, max) in [
                (libc::RLIMIT_AS, 1536_u64 * 1024 * 1024),
                (libc::RLIMIT_NOFILE, 128),
                (libc::RLIMIT_NPROC, 32),
                (libc::RLIMIT_CPU, cpu_budget),
                (libc::RLIMIT_FSIZE, 16_u64 * 1024 * 1024),
            ] {
                let limit = libc::rlimit {
                    rlim_cur: max,
                    rlim_max: max,
                };
                if libc::setrlimit(resource, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    cmd.env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd
}
async fn bounded<R: AsyncRead + Unpin>(mut pipe: R, limit: usize) -> anyhow::Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = pipe.read(&mut buf).await?;
        if n == 0 {
            return Ok(result);
        }
        anyhow::ensure!(result.len() + n <= limit, "Worker output limit exceeded");
        result.extend_from_slice(&buf[..n]);
    }
}
pub struct Output {
    pub status: String,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
pub async fn execute(
    mut cmd: Command,
    input: Vec<u8>,
    seconds: u64,
    limit: usize,
    cancel: Option<(&App, &str)>,
) -> anyhow::Result<Output> {
    let start = Instant::now();
    let mut child = cmd.spawn()?;
    let mut stdin = child.stdin.take().unwrap();
    let writer = tokio::spawn(async move {
        stdin.write_all(&input).await?;
        stdin.shutdown().await
    });
    let mut output = Some(tokio::spawn(bounded(child.stdout.take().unwrap(), limit)));
    let mut errors = Some(tokio::spawn(bounded(child.stderr.take().unwrap(), 64_000)));
    let mut bytes = Vec::new();
    let mut err = Vec::new();
    loop {
        if start.elapsed() > Duration::from_secs(seconds) {
            child.kill().await?;
            child.wait().await?;
            writer.abort();
            if let Some(t) = output {
                t.abort()
            }
            if let Some(t) = errors {
                t.abort()
            }
            return Ok(Output {
                status: "timed_out".into(),
                stdout: bytes,
                stderr: err,
            });
        }
        if let Some((app, id)) = cancel {
            if sqlx::query_scalar::<_, i64>("SELECT cancel_requested FROM jobs WHERE id=?")
                .bind(id)
                .fetch_one(&app.db)
                .await?
                != 0
            {
                child.kill().await?;
                child.wait().await?;
                writer.abort();
                if let Some(t) = output {
                    t.abort()
                }
                if let Some(t) = errors {
                    t.abort()
                }
                return Ok(Output {
                    status: "cancelled".into(),
                    stdout: bytes,
                    stderr: err,
                });
            }
        }
        if output.as_ref().is_some_and(|t| t.is_finished()) {
            match output.take().unwrap().await? {
                Ok(v) => bytes = v,
                Err(e) => {
                    child.kill().await?;
                    child.wait().await?;
                    writer.abort();
                    if let Some(t) = errors {
                        t.abort()
                    }
                    return Err(e);
                }
            }
        }
        if errors.as_ref().is_some_and(|t| t.is_finished()) {
            match errors.take().unwrap().await? {
                Ok(v) => err = v,
                Err(e) => {
                    child.kill().await?;
                    child.wait().await?;
                    writer.abort();
                    if let Some(t) = output {
                        t.abort()
                    }
                    return Err(e);
                }
            }
        }
        if let Some(status) = child.try_wait()? {
            writer.await??;
            if let Some(t) = output {
                bytes = t.await??
            }
            if let Some(t) = errors {
                err = t.await??
            }
            return Ok(Output {
                status: if status.success() {
                    "succeeded"
                } else {
                    "failed"
                }
                .into(),
                stdout: bytes,
                stderr: err,
            });
        }
        sleep(Duration::from_millis(30)).await;
    }
}
