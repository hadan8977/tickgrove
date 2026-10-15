# Tickgrove command API

`POST /api/command` with `Authorization: Bearer <instance token>` and JSON `{ "method": "...", "params": {}, "idempotency_key": "..." }`. `/health` is public and exposes no state. All data APIs require authentication; errors are `{ "error": "message" }`, 401 invalid/revoked token, 403 insufficient scope, 400 validation/execution request errors. Async execution errors appear as terminal job states.

| Command | Parameters | Result |
| --- | --- | --- |
| system.capabilities | none | Actual commands, permissions and unsupported capabilities |
| strategy.createVersion | name, kind (pine/composer), source | Immutable version ID/hash |
| strategy.list | none | Saved versions/source |
| data.import | data {symbol,timeframe,metadata,bars,datasets} | Immutable snapshot ID/hash |
| data.list / data.get | none / snapshot_id | Snapshot summaries / full data |
| backtest.start | version_id, snapshot_id, inputs object | job_id, manifest; requires idempotency_key |
| backtest.status | optional job_id | Summary/status, no bulk results |
| backtest.results | job_id | Manifest and persistent result/error |
| backtest.cancel | job_id | Cancellation request acknowledged |
| events.list | optional cursor | Ordered events after cursor |
| paper.deploy | version_id, snapshot_id, inputs, execution=closed_bar_native, optional subscription_id | Persisted initializing session and baseline job; a bound subscription supplies future confirmed bars |
| paper.append | session_id, event_id, bars mapping symbol→one new OHLCV bar | Pending job; duplicate same event is idempotent |
| paper.list | none | Committed and pending IDs/status |
| paper.pause/resume/retry/discard | session_id | Lifecycle action; retry preserves event identity |
| plugins.list/validate/enable/disable | none / id | Manifests and host enable state |
| plugins.call | id,input | Bounded sandbox execution of enabled extension |
| alpaca.config/account | none | Configuration capability / Paper account |
| orders.list/status/events | none / client_order_id / cursor | Persisted order summaries, current state and audit events |
| orders.preview/submit | client_order_id,symbol,side,qty,type=market,time_in_force=day | Validation / persistent Paper order submission |
| orders.reconcile | client_order_id | Query venue before retrying unknown submissions |
| orders.cancel | order_id | Paper cancel request |
| connections.list | none | Provider setup cards; no credentials returned |
| connections.save / remove | provider=alpaca, apiKey/apiSecret for save | Private local profile; requires connections.manage; old account streams stop |
| connections.test | provider, optional feed and apiKey/apiSecret | One read-only source request; does not assert live stream or trading permissions |
| market.historyPage | provider,symbol,timeframe,feed?,session?,before?,start?,end?,limit? | Bounded chart page, coverage/cursor/cache; snapshot_id=null |
| market.history | provider,symbol,timeframe,start,end,feed?,session?,adjustment?,allowGaps? | Immutable data snapshot for a reproducible strategy run |
| market.cacheInfo / cacheClear | none | Bounded download cache / clear only cache; snapshots and journals preserved |
| data.fetch | symbol,start,end,timeframe | Alpaca IEX adjusted bars; pagination truncation rejected |

Pine libraries are immutable local source versions. `pine.library.createVersion` accepts `publisher`, `name`, positive integer `version`, `source`, and optional `license`/`sourceUrl`; its scope is `pine.library.write`. `pine.library.list` and `pine.library.get {reference}` read the registry. A reference such as `publisher/name/1` is used by normal Pine `import`. `pine.resolve {source}` returns imports, locked source modules and `lockHash`. Missing or ambiguous dependencies fail explicitly. Strategy versions retain their library lock.

`pine.inspectRequests {source,symbol?,timeframe?,inputs?}` returns statically discoverable symbol/timeframe requests and separate dynamic diagnostics. `pine.prepareData {version_id,snapshot_id}` freezes available static dependencies from the same provider/feed/session/adjustment. `backtest.start` invokes preparation automatically; callers must use the **returned manifest's snapshot_id**, which may differ from the initially selected primary snapshot. Dynamic request datasets must be supplied explicitly. Realtime event-host dependencies are not yet supported.

| Persistent Pine host command | Parameters | Result / behavior |
| --- | --- | --- |
| pine.host.deploy | version_id, snapshot_id, subscription_id, inputs?, execution=indicator/local_broker/external_broker, startingCash? | Immutable deployment ID; warms up before processing future market events |
| pine.host.list / pine.host.status | none / session_id | Status, cursor, latest plots/account/pending intentions and error |
| pine.host.render | session_id | Full bars and Pine render data for an active worker |
| pine.host.events | session_id, cursor? | Up to 1000 journal events after the cursor, in ascending order |
| pine.host.pause / pine.host.resume | session_id | Pause or resume order dispatch; calculation and reconciliation continue |
| pine.host.stop | session_id | Terminal stop; cancels this host's unfilled local orders, leaves filled positions intact |
| pine.host.feedback | session_id, fill {id,orderId,side,qty,price,fee,time,barIndex} | Actual external fill journal; requires broker.feedback scope and external_broker execution |

Host deployment and lifecycle use `paper.manage`; read methods use `read`. Market and fill event timestamps are Unix milliseconds, while OHLCV `time`/`closeTime` use Unix seconds. Fill IDs must be stable: duplicate identical feedback is idempotent and conflicting reuse is rejected. Broker strategies require `calc_on_every_tick=true`. A local broker host uses the shared Rust USD simulation account; `startingCash` supplies strategy reference equity, not reserved account funds. External mode exposes order intentions and requires a separately configured adapter to return real fills; it does not automatically submit orders to Alpaca. See the [full event-host contract](api/pine-event-host.md) for recovery, resource budgets and unsupported realtime semantics.

`backtest.start` binds the idempotency key to exact parameters; different reuse is rejected. `paper.append` binds event ID to payload, checks strict increasing timestamps and aligned symbols. Multi-timeframe append is rejected at deploy. Committed snapshots move only after successful job/frame validation. Pending failure never overwrites the committed ledger; cancel then retry or discard explicitly. No synthetic external order is created from native Pine fills.

Scoped token configuration is an array of `{ "token": "at-least-24-characters", "permissions": ["read", "strategy.write", "data.write", "backtest.run", "paper.manage", "broker.paper", "plugins.manage"] }`. Additional scopes include `workspace.write`, `pine.library.write`, `alerts.manage`, `broker.feedback` and `connections.manage`; discover the current list through `system.capabilities`. Set `TICKGROVE_TOKENS_FILE` on the host. It is re-read per request, so revocation applies to existing clients. With no file the generated owner token has all available scopes. UI local permission toggles cannot grant server access.

CLI: `server/target/debug/tickgrove system.capabilities`; JSON parameters may be inline or a file. `--key` supplies idempotency. `TICKGROVE_URL`, `TICKGROVE_TOKEN`/`TICKGROVE_TOKEN_FILE` select the instance. Exit codes: 0 successful command, 1 server/network error, 2 invalid local invocation. `node scripts/trading.cjs` is an optional equivalent client.

MCP: run `server/target/debug/tickgrove-mcp` from the project root with the same URL/token variables. Official rmcp 3.2.0 provides stdio initialization, negotiation and `tools/list`/`tools/call`; `tickgrove_command` invokes the identical API and never starts a second database writer. `trading_command` remains an alias for existing clients. stdout is protocol only. No built-in chat is added.

The browser exposes `window.tickgrove` for workspace commands; `window.openComposer` remains a compatibility alias. Existing protocol IDs, database filenames, and `TRADING_*` environment variables are retained. New configurations should use `TICKGROVE_*` variables and the Tickgrove executable names.

SDKs: `sdk/tickgrove.ts` and `sdk/tickgrove.py` expose `TickgroveClient`; the original paths and `TradingClient` remain aliases. The TypeScript client uses fetch and the Python client uses the standard library. Example: `client.command("backtest.start", {"version_id": version, "snapshot_id": snapshot}, "my-run-001")`.

Plugin v1 protocol: local `extensions/<id>/plugin.json`, `api_version=trading.plugin.v1`, version, `entrypoint=index.cjs`, contributes, permissions. Host permits `input.read`; unexpected permissions/version/path/symlinks fail validation. One JSON input is delivered on stdin and one `{ok:true,...}` result on stdout. Total wall limit 5s, heap 64MiB, stdout 16MB, stderr 64KB. The shared execution budget permits one process; CPU/file/descriptor/process limits and a 1.5GiB virtual-address ceiling reinforce the V8 heap cap. stderr may contain diagnostics but never credentials. Enable, disable and validate use authenticated host commands. Examples implement CSV, moving average and equity report. Install an independent plugin by copying its folder; host source changes are unnecessary.

## History and source identity

Chart pages are disposable downloads, not immutable strategy inputs. `page.hasMore` and `page.nextBefore` drive older-history loading; an empty window may still have older pages. `page.coverageStart` and `page.reason` describe adapter/source limits, not a promise of every exchange tick. `cache.hit` reports the bounded server cache. The chart freezes the selected loaded range through `market.history` before backtesting. Source provider, venue, feed, session and adjustment remain attached to data; no silent cross-source stitching or synthetic gaps.

`market.status`, `market.bars` and `market.events` include a current `marketState` (selected-session open/closed, calendar timezone and timestamp). Transport connectivity, source delay and last-quote time are separate. Alpaca `priceKind=mid` quotes do not overwrite the last-trade display. Unknown, delayed or indicative sources cannot be promoted into executable local fills merely because their transport is connected.

`alerts.list` exposes `sourceCursor` and source errors. A failed or paused price alert resumes from the current observation window; missing events are not silently replayed as live triggers. Strategy alert history includes the persistent host context. See [free-data coverage](free-data.md) and the [event-host contract](api/pine-event-host.md).
