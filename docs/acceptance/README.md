# Initial local release acceptance

These files record actual offline, local and public-market network checks. Each report proves only its recorded source/runtime and scope; earlier reports do not automatically validate later changes. They contain temporary run IDs, without credentials or real brokerage orders. Public market data is identified separately from deterministic fixtures.

| Evidence | Scope |
| --- | --- |
| [free-data-release.json](free-data-release.json) | Current integration checks, exact frontend/binary hashes and explicit remaining release boundaries |
| [publication.json](publication.json) | Public repository access, updated commit attribution and preserved source history |
| [free-data-docker.json](free-data-docker.json) | Current image: 13 isolated runtime checks, real ETF history and crypto WebSocket, restart persistence and sandboxed Pine; exact build hashes and network scope |
| [free-data-preview.json](free-data-preview.json) | Updated HTTPS preview; preserved user workspace, account and token; current frontend and vector favicon |
| [market-data-report.json](../../server/tests/market-data-report.json) | Actual public Yahoo/Coinbase paging, 28-day minute snapshots, shared live connections and bounded cache |
| [free-data-workflow.json](free-data-workflow.json) | Real VOO history → immutable zero-gap snapshot → recorded-price native Pine backtest |
| [real-free-data-browser.json](real-free-data-browser.json) | Actual ETF/crypto search, periods, older pages, live quote updates, four themes and mobile UI |
| [real-data-screenshots.json](real-data-screenshots.json) | Real market 4/6 charts and actual canvas text colors following the selected theme |
| [free-data-browser.json](free-data-browser.json) | Controlled delayed/error/empty responses, retry and pagination, low-price precision; actual components with API fixtures |
| [workspace-interactions.json](workspace-interactions.json) | Chart retention/Undo, exact ticker Enter, search races, local Pine dependencies and paper-run navigation |
| [reliability-current.json](reliability-current.json) | Five isolated service paths: alert recovery, Pine alert persistence, valid/invalid fills, outbox recovery and explicit tick loss |
| [rebrand-preview.json](rebrand-preview.json) | Deployed Tickgrove service, unchanged workspace/account/token, HTTPS preview and API authentication after restart |
| [rebrand-browser.json](rebrand-browser.json) | Tickgrove browser identity, legacy storage/token migration, four themes and mobile width; isolated review instance |
| [branding-report.json](../../server/tests/branding-report.json) | Old-to-new database continuity, canonical/legacy CLI, two official MCP clients, backup/restore, eight Rust binaries; image rebuild excluded |
| locked-runtime.json | Full no-key service/Pine/three-portfolio/plugin/CLI chain repeated with a clean frozen dependency installation |
| locked-build.json | Clean frozen pnpm install, identical final src, typecheck/build, project dist copied from exact locked dependencies |
| default-startup.json | Independent no-token startup: generated token 0600, CLI token-file auth, no secret in logs, temporary service stopped |
| assertions.json | Earlier 47 deterministic Pine/Composer/CLI assertions |
| pine-public-service.json | Earlier 312 unmodified public Pine scripts; recorded four adapter hashes |
| browser.json / screenshots | Independent real Chromium148.0.7778.96 against final locked dist and latest Rust binaries: nine checks, native Pine rendering/inputs, portfolio tree and persistent Paper state, zero uncaught errors |
| worker-environment.json | Missing adapter file produces terminal failure/event instead of a hanging running job |
| service-supervision.json | Independent parent review: authentication, invalid inputs, six concurrent idempotent starts, hand-calculated native Pine ledger, restart, second-instance lock, queued/running cancel, SIGKILL recovery |
| paper-supervision.json | Independent parent review: initialization cancel/retry, single-symbol append idempotency/restart, failure preserving committed state/retry/discard, exact trade identity rewrite rejection |
| local-closed-bar.json | Pine + three Composer strategies, five genuinely appended closed events each, duplicate IDs, restart, exact final native/batch equality, three loaded process plugins and CLI |
| mcp-clients.json | Official TS SDK 1.32.1 and Python SDK 1.30.0; actual stdio initialization, tools list/call, errors; Python negotiated protocol 2025-11-25 |
| sandbox.json | Actual denied host file/symlink/write/network/env access; host permission refusal, token revocation, bounded output and total timeout |
| alpaca-offline.json | Actual Rust HTTP adapter against localhost venue fault mock; known refusal, lost response, partial fill/cancel/restart, fill regression and ID conflict |
| unit-tests-current.json | Later 64-test frontend/runtime suite, including immutable library and workspace restoration cases; later host additions have their own reports |
| pine-public-current.json / pine-public-batch.json / pine-public-retry.json | Fixed 312-script execution coverage with five adapter hashes: initial batch 311/312, one 5-second timeout passed in isolation with identical inputs. Aggregate retains the initial failure; not TradingView equivalence |
| market-network.json / market-session-network.json | Actual dynamic product discovery, stock/ETF/crypto history, public websocket events and regular/extended-session gap checks |
| real-workspace-browser.json | Browser uses real dynamic symbols, persistent server Pine jobs, local quote-driven orders, price alerts and workspace restoration |
| mobile-workspace.json | 390×844 browser, real chart data, limit order/cancel and independent desktop/mobile layouts |
| pine-libraries.json / pine-library-browser.json | Immutable library source/dependency lock, runtime semantics and original editor input-to-native-job flow |
| pine-request-data.json | Actual SPY primary data plus NASDAQ:QQQ dependency, frozen automatically with matching final close |
| paper-market-stream.json / paper-cached-deploy.json | Fixture market events, cached-bar catch-up, durable Pine/Composer session behavior |
| paper-public-stream.json | Actual Coinbase future closed bars execute 0.0001 BTC native simulated entry and exit; no synthetic prices or brokerage orders |
| paper-public-stream-failure.json / paper-public-stream-revision.json | Retained earlier failed runs and revision diagnostics, before the later passing public-stream report |
| pine-event-service.json / pine-event-host-boundaries.json | Persistent Rust/Node tick host, fixture quotes and actual local-paper fills, replay recovery and explicit remaining semantic limitations |
| pine-host-browser.json | Actual Coinbase events drive a saved indicator, intrabar varip and chart values through React/Rust/Node; UI stop terminates the session. This checks event processing, not a transport-latency service guarantee |
| market-session-roundtrip.json | Explicit Coinbase/Yahoo/Alpaca session identities round-trip through history and subscription contracts, with mismatched sessions rejected |
| market-status-index.json | Same 100,350-event database copy, identical status values: quote-only covering indexes reduce median query time from 768.39ms to 0.153ms; network transport is a separate check |
| quote-index-migration.json / market-latency-current.json | Actual Rust startup applies migration 21. After updating the review service, 20/20 public Coinbase observations had quotes within 15 seconds: median 1.929s, maximum 8.412s; status HTTP median 22.93ms. This short window is not an SLA |
| backup-restore.json | Native Rust online backup, checksums, restore, preserved account/job state and directory lock |
| docker-runtime.json | Actual tested image: non-root Rust/React, no Python interpreter, authentication and sandboxed native Pine trade; see image hash for exact build |

Re-run from project root after building service binaries:

```sh
npm test
npm run typecheck
npm run build
CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 cargo build --locked --manifest-path server/Cargo.toml --bins
python3 scripts/acceptance/supervision.py
python3 scripts/acceptance/paper-supervision.py
python3 scripts/service-smoke.py
python3 scripts/acceptance/worker-environment.py
python3 scripts/acceptance/sandbox.py
python3 scripts/acceptance/alpaca-offline.py
npm ci --prefix tests/mcp-clients --ignore-scripts
python3 -m venv /tmp/trading-mcp-verify
/tmp/trading-mcp-verify/bin/pip install -r tests/mcp-clients/requirements.lock.txt
TRADING_MCP_PYTHON=/tmp/trading-mcp-verify/bin/python python3 scripts/acceptance/mcp-clients.py
```

Do not run multiple full corpora or parallel Rust builds on the 4GB host. Tests start independent temporary SQLite directories and ports. Broker mock credentials are invented fixtures for a loopback HTTP server and never access an external account.

Historical `plans/research/pine-public-execution.json` is preserved, including its original adapter file hashes. Adding pending-order result serialization changes report.ts, so that file is an earlier tested adapter snapshot, not a claim that all source hashes match this service release. Local assertion tests were re-run after integration. TradingView same-data numeric/fill comparison remains unperformed.

Docker reports identify the image and network configuration actually tested; Compose configuration validation does not verify its default bridge/NAT behavior. No dedicated Alpaca account is configured; offline fault acceptance does not replace real account/data/order acceptance. The separate event host implements tested tick rollback and broker-feedback cases, with unsupported cases listed in its boundary report. TradingView same-data equivalence remains unverified. Public repository access does not expand the grants described in [Licenses](../licenses.md).

Browser replay requires an isolated dedicated test service, not a real account or existing user data. Install Playwright into an optional test environment and set `PLAYWRIGHT_MODULE` (module name or absolute package path), `BROWSER_EXECUTABLE` (optional existing browser binary), `TRADING_URL`, `TRADING_TOKEN` and `TRADING_BROWSER_OUTPUT`; run `node scripts/acceptance/browser.cjs`. The token is used only in requests and never written to reports. Screenshots reflect the authoritative server path, not localStorage demo results.
