<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/brand/tickgrove-lockup-dark.svg">
  <img src="public/brand/tickgrove-lockup-light.svg" alt="Tickgrove" width="360">
</picture>

A self-hosted workspace for market charts, Pine scripts, backtesting, and paper trading.

[Quick start](#quick-start) · [Self-hosting](docs/self-hosting.md) · [Free data](docs/free-data.md) · [API & MCP](docs/api.md) · [Feature status](docs/features/checklist.csv)

![Dark six-chart workspace with real stock, ETF and crypto data](docs/images/workspace-dark.png)

## Features

- **Research** — linked charts, watchlists, drawing tools, indicators, and price alerts.
- **Build** — import and edit Pine scripts, manage local libraries, or create visual strategies and Composer-style portfolios.
- **Test** — backtest saved strategy versions against data snapshots, inspect trades, and run continuous local paper sessions.
- **Extend** — connect your tools through the HTTP API, CLI, MCP, and process plugins.

React and TypeScript power the UI. Rust handles data, orders, jobs, and SQLite storage. PineTS and the portfolio engine run in isolated Node.js workers.

## Quick start

Requires Linux, Docker Compose, and unprivileged user namespaces. See [Ubuntu sandbox setup](docs/self-hosting.md#ubuntu-sandbox-setup) if your host restricts them.

```sh
git clone https://github.com/hadan8977/tickgrove.git
cd tickgrove
docker compose up --build -d
docker compose exec trading cat /app/var/auth-token
```

Open [localhost:8787](http://localhost:8787) and sign in with the generated token. State persists in the `trading-data` volume; SQLite is included.

Start with **Charts** to choose a symbol and pan left for older history. Free sources need no data key; use **Settings → Connections** to add your own account. **Scripts → Import Pine** opens the editor, chart and backtest workflow.

[Build from source, configure remote access, and back up your instance →](docs/self-hosting.md)

## Current status

Early development. The default account uses local simulated fills.

| Area | Available today |
| --- | --- |
| Crypto | Coinbase historical candles and live WebSocket data for supported pairs. |
| US stocks / ETFs | Yahoo history and public quote updates; latency and completeness vary. |
| Alpaca | Optional personal IEX/SIP/overnight feeds and Paper adapter; real account acceptance still pending. |
| Pine | PineTS execution and local library imports; full TradingView compatibility is unverified. |

See the [acceptance evidence](docs/acceptance/README.md) and [free-data guide](docs/free-data.md) for tested behavior and remaining gaps.

## Contributing

Issues and pull requests are welcome. Include a reproducible example; for strategy bugs, include the script, inputs, symbol, timeframe, and data source. See [architecture](docs/architecture.md) and [development checks](docs/self-hosting.md#development).

## License

New service components use AGPL-3.0-or-later; PineTS uses AGPL-3.0-only. Original frontend licensing remains unresolved. See [licensing notes](docs/licenses.md).
