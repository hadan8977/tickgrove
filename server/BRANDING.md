# Tickgrove compatibility

Build all commands with `CARGO_BUILD_JOBS=1 cargo build --locked --manifest-path server/Cargo.toml --bins`.

Canonical commands are `tickgrove-server`, `tickgrove`, `tickgrove-mcp`, and `tickgrove-admin`. The former `trading-service`, `trading-cli`, `trading-mcp`, and `trading-admin` remain buildable wrappers around the same Rust library. Docker installs these former names as symlinks.

Each executable applies every provided `TICKGROVE_*` variable to its corresponding `TRADING_*` variable before creating its runtime. The new prefix wins, including an explicitly empty value; normal configuration validation still applies. `ALPACA_*` names are unchanged. The Node compatibility client supports new URL/token/token-file variables; Paseo preview supports `TICKGROVE_PREVIEW_PORT` while retaining `PASEO_PORT`.

MCP identifies itself as `tickgrove-mcp` / Tickgrove. Both `tickgrove_command` and `trading_command` forward to the same authenticated service. The wire protocol remains `trading.commands.v1`.

Database filename `trading.sqlite`, backup schema `trading.backup.v1`, Compose service `trading`, and volume `trading-data` deliberately retain their old names. Compose's default project remains `tradingdashboard`; preserve any existing custom `COMPOSE_PROJECT_NAME` or `-p` value during upgrades. Port/profile variables support new-prefix then old-prefix fallback. Existing auth tokens, strategy versions, snapshots, and execution adapter hashes are not renamed.

Run `node server/tests/branding.cjs` against locally built binaries. Set `TICKGROVE_PREVIOUS_BIN` to a preserved previous service executable to additionally verify an actual old-to-new database upgrade. Set `TICKGROVE_TEST_PYTHON` to a Python interpreter with the official MCP SDK to include the second client. This acceptance owns only its temporary directory and child processes; it never uses a configured live account.
