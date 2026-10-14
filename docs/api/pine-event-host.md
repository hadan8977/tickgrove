# Pine event host

The Rust API runs a controlled Node/PineTS 0.11.1 process for each event host. This contract is separate from `paper.deploy` closed-bar native replay. It does not promise TradingView equivalence.

`pine.host.deploy` accepts `{version_id,snapshot_id,subscription_id,inputs?,execution,startingCash?}`. Execution is `indicator`, `local_broker`, or `external_broker`. The immutable version, library lock, input overrides, data snapshot, implementation hash, and persisted event journal define replay. `pine.host.status`, `pine.host.list`, `pine.host.events`, and `pine.host.render` expose status, diagnostics, source cursors, pending orders, account projection, and matching bars/visuals. Render preserves plot display metadata.

For broker modes, historical warmup runs with matching disabled and a flat account. It does not carry simulated historical fills into script variables. Live intents are matched only by the Rust shared USD local account (`local_broker`), or projected from explicitly authorized external fill feedback (`external_broker`). The shared local account is not a separately funded account for each strategy; startingCash is the strategy accounting reference. Orders require a fresh quote arriving after the decision. Quote freshness, feed identity, fees, and account leverage constraints belong to Rust.

`pine.host.feedback` accepts `{session_id,fill:{id,orderId,side,qty,price,fee,time,barIndex}}`. It requires `broker.feedback` scope and an active or paused external-broker session. Time is milliseconds. Feedback must refer to an issued pending Pine order. Partial fills retain the remaining quantity. Repeating an identical fill ID is idempotent; changing its payload is rejected. This interface is not an authenticated connection to any external broker by itself. No external real-money orders were executed during acceptance.

Pause stops new order dispatch and cancels outstanding local host orders; computation and actual fill reconciliation continue. Resume discards intents accumulated while paused before permitting new dispatch. Stop is terminal and idempotent. All three accept `{session_id}`. Missing close confirmations, changed committed source history, expired source cursors, mismatched implementation hashes, and unrecoverable worker errors fail closed.

Execution uses the recorded exchange event time and recorded receipt/execution time rather than the current wall clock. Ordinary mutable variable containers roll back on repeated forming updates. Primitive global `varip` persists intrabar. Unknown source volume remains Pine `na`; it is never manufactured as zero. A new bar requires an explicit prior close and explicit closeTime.

Current resource contract: `TRADING_MAX_PINE_HOSTS` defaults to 2 (host-configurable 1–8). A global process mutex serializes event and API access; this is a single-host implementation, not a multi-tenant throughput guarantee. Each event has a 10-second deadline, 16 MB request and 32 MB response budgets. A persistent worker has a 256 MB Node heap, 1536 MB address-space, 128 file-descriptor, and 32-process limit. Its cumulative CPU limit is unlimited rather than the single-job 35-second limit. Bubblewrap isolates the filesystem and network; Node permission restrictions additionally deny child processes, workers, native addons, and file writes. Stderr capture is bounded and included in exit diagnostics. Replay budgets are 200,000 events and 20,000 bars; exceeding a budget fails explicitly.

Remaining compatibility boundaries: `calc_on_order_fills`, scoped or structured `varip`, live multi-timeframe request bindings, complete OCA/bracket/trailing-order execution and external rejection/cancellation feedback are not supported. Entitled Alpaca market streams and live account integration still require dedicated credentials. Persisted-journal recovery cannot recreate exchange ticks never received during a network outage. No full Pine v5/v6 or TradingView compatibility claim follows from this host.

Acceptance commands (test-only Python dependencies are not production dependencies):

```sh
CARGO_BUILD_JOBS=1 cargo build --manifest-path server/Cargo.toml --bin tickgrove-server
node --test tests/pine-host.test.cjs tests/pine-broker.test.cjs
python3 scripts/acceptance/pine-event-service.py > /tmp/pine-event-service.json
```
