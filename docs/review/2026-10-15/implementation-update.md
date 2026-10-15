# Free-data implementation update

This supersedes the earlier undecided data-delivery assumption, not the original review evidence. The user selected free, open-source self-hosted software with public-source adapters and optional personal provider accounts. Tickgrove does not operate a shared data service or sell a data subscription.

## Implemented in this iteration

| Area | Change | Evidence |
| --- | --- | --- |
| Free history | Older-page API, browser paging, persistent bounded cache, shared HTTP requests and provider pacing; Yahoo minute snapshots split into source-sized requests | [Real provider acceptance](../../../server/tests/market-data-report.json), [source probes](../../../server/tests/market-source-probes.json) |
| Data lifecycle | Loading is distinct from empty/error; interval requests stay separate; older data merges without replacing current candles; failed refresh keeps usable data; old responses cannot overwrite a newly selected range | [Browser fixtures](../../acceptance/free-data-browser.json), `tests/free-data-lifecycle.test.cjs` |
| Live sources | Shared upstream per provider/feed/profile, dynamic symbol union, explicit gaps, correct close-frame reconnect, calendar-based session status | Rust hub/period tests and real provider acceptance |
| Personal connections | Free-source cards, optional Alpaca private local profile, read-only tests, owner scope, account-change invalidation and outstanding-order guard | Rust connections test and browser fixture |
| F01/F02 | Typed continuous order validation, unsupported relative/trailing/OCA intents rejected, feedback direction/quantity checked without killing the worker | `tests/pine-execution-contract.test.cjs`, [runtime acceptance](../../acceptance/reliability-current.json) |
| F03/F04 | Durable price-alert consumer cursor; persistent Pine alert context/frequency; transactional result/cursor/outbox and idempotent recovery | Rust transaction tests and runtime acceptance |
| F05/F06 | Grid changes retain chart IDs/settings; hidden charts survive refresh; template Undo; new paper runs are selected and distinguished from the manual account | [Workspace acceptance](../../acceptance/workspace-interactions.json) |
| Other workflow repairs | Search results cannot be selected for an obsolete query; missing Pine dependencies open a prefilled installer and return to the same source | Workspace acceptance |
| Instrument precision | Low-price crypto OHLC follows source precision; tiny indicator values remain nonzero; compact charts show Close with full OHLC available on demand | Browser fixture, `tests/chart-price-format.test.cjs` |
| Real research path | Free-source history freezes into a zero-gap snapshot and executes native Pine fills against the recorded prices | [Real history-to-backtest acceptance](../../acceptance/free-data-workflow.json) |
| Identity | New vector T mark, matching app/favicon/lockups/social artwork, Geist typography; image-assisted concept exploration | [Brand assets and method](../../branding.md) |

The previous review's source snapshots and reports remain historical evidence. These new tests address the changed paths; they do not retroactively prove every item in the 96-feature catalog.

## Remaining release boundaries

- A dedicated Alpaca account is still unavailable. Entitlement-specific IEX/SIP/BOATS streams and broker Paper execution require separate live acceptance. Offline correctness does not substitute for those permissions.
- Free Yahoo access is a public research/reference source; it cannot promise consolidated, guaranteed realtime US tape, complete overnight trades, or arbitrary deep minute/tick archives. Coinbase describes its own venue.
- Browser delivery still uses resumable cursor polling. A shared SSE/WS browser channel, measured sustained-load targets and a full tick-repair archive remain follow-up work; upstream reconnect is not lossless historical tick recovery.
- The bounded SQLite history cache is not an unlimited permanent archive. Large immutable data objects, object-aware backup and retention policy remain separate work. UI-saved credentials need a separately protected configuration backup.
- Unsupported continuous Pine semantics remain explicit. Full TradingView numerical/fill equivalence, live multi-timeframe dependencies and external rejection/cancellation feedback are not declared complete.
- Automated browser checks do not replace novice-user task testing or a long soak. Original frontend licensing and the full release gate remain tracked separately. No promotional posts were published.
