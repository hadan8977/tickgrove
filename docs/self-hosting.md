# Self-hosting

Run one Rust service per data directory. It serves the React app and owns the SQLite database, market subscriptions, accounts, alerts, and strategy jobs. PineTS and Composer execute in isolated Node.js workers.

## Docker

From the repository root:

```sh
docker compose up --build -d
docker compose exec trading cat /app/var/auth-token
```

Open [localhost:8787](http://localhost:8787) and enter the token. The first build compiles the frontend and Rust binaries. The `trading-data` volume stores application state at `/app/var`; recreating the container preserves it. `docker compose down -v` deletes that volume.

To choose another host port:

```sh
TRADING_PORT=8471 docker compose up --build -d
```

The container runs as a non-root user with a read-only root filesystem. Pine execution requires the host to permit unprivileged user namespaces. Compose includes relaxed seccomp and system-path settings for the nested bubblewrap sandbox; review [compose.yaml](../compose.yaml) for your deployment.

### Ubuntu sandbox setup

On hosts that restrict unprivileged user namespaces, load the supplied AppArmor profile and select it for this container:

```sh
sudo apparmor_parser -r deploy/apparmor/trading-dashboard
TRADING_APPARMOR_PROFILE=trading-dashboard docker compose up --build -d
```

This selects a profile for the application without changing global kernel settings. Without this override, Compose uses `apparmor:unconfined`.

## Build from source

Requires Linux, Node.js 22.12+, Corepack, Rust 1.90, a native build toolchain, and `bubblewrap` on PATH. Enable unprivileged user namespaces for strategy execution. The runtime does not require Python.

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts --ignore-workspace
npm run build
CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 cargo build --locked --manifest-path server/Cargo.toml --bins
TRADING_ROOT="$PWD" TRADING_BIND=127.0.0.1:8471 server/target/debug/trading-service
```

Open [localhost:8471](http://localhost:8471). In another terminal, read `var/auth-token` to sign in. State is stored in `var` unless `TRADING_DATA_DIR` is set. A directory lock prevents two services from sharing the same database.

Use [.env.example](../.env.example) as a configuration reference. The native service does not load it automatically; export variables or configure them through your service manager. Broker credentials must be supplied separately. Alpaca account integration is unverified, and overnight data has outstanding implementation gaps.

### Development

Keep the Rust service running, then start Vite:

```sh
TRADING_URL=http://127.0.0.1:8471 npm run dev -- --host 127.0.0.1
```

Vite proxies `/api` to that service. The explicit `?mode=demo` URL uses synthetic browser data.

Run the checks relevant to your changes:

```sh
npm run typecheck
npm test
npm run build
cargo test --locked --manifest-path server/Cargo.toml
npm run test:pine-public
```

The last command executes the fixed public Pine corpus. Execution coverage is separate from numerical or fill equivalence with TradingView. Reports in [acceptance](acceptance/README.md) identify their tested versions and limits.

## CLI and MCP

Both use the same authenticated command API as the web app:

```sh
TRADING_URL=http://127.0.0.1:8471 server/target/debug/trading-cli system.capabilities
TRADING_URL=http://127.0.0.1:8471 server/target/debug/trading-mcp
```

The CLI accepts `METHOD [PARAMS.json | JSON] [--key IDEMPOTENCY_KEY]`. Both clients default to `var/auth-token`; set `TRADING_TOKEN_FILE` for a different instance. MCP uses stdio. See [API documentation](api.md) for commands, permissions, SDKs, and plugins.

## Remote access

Compose binds to `127.0.0.1` by default. For a remote server, use an SSH tunnel or an HTTPS reverse proxy. Keep API authentication enabled and protect the instance token.

For Paseo, first build from source. Start `trading` in Scripts, then optionally `trading-share` for an HTTPS preview. Sharing requires `cloudflared` and prints a temporary URL. Preview state and the token are stored under `var/paseo-preview`. Restart sharing if the service port changes; stop `trading-share` to close the external entry point. Its launcher does not inherit broker credentials.

## Backup and restore

From a source installation:

```sh
server/target/debug/trading-admin backup --data-dir var --output backups/run-1
server/target/debug/trading-admin restore --input backups/run-1 --data-dir var-restored
TRADING_ROOT="$PWD" TRADING_DATA_DIR="$PWD/var-restored" TRADING_BIND=127.0.0.1:8472 server/target/debug/trading-service
```

Backups contain a consistent SQLite snapshot, checksums, and the instance token. Restore requires an empty destination and verifies integrity. Keep the deployment version, custom calendars, extensions, and external credentials separately; they are not automatically included.

Docker includes the same `trading-admin` binary. Write backups inside the persistent volume, then copy them to independent storage:

```sh
docker compose exec trading trading-admin backup --data-dir /app/var --output /app/var/backups/run-1
docker compose cp trading:/app/var/backups/run-1 ./trading-backup-run-1
```

Each backup path must be new. Protect backups as credentials because they contain the instance token. For a Docker restore, stop the application and use an empty data volume; never replace a database in use.
