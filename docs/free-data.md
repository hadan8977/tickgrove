# Data in your own environment

Tickgrove is free, open-source software. It connects to data sources from your own machine or server; it does not sell or proxy a shared Tickgrove market-data service. Open **Data connections** to test the public sources or configure your own optional account.

| Source | Available without a paid data plan | Limits |
| --- | --- | --- |
| Yahoo Finance | US stock/ETF history and public reference quote updates | An unofficial public interface with provider-controlled availability and delay. It is not a guaranteed consolidated realtime exchange feed. |
| Coinbase Exchange | Historical candles and live ticker, trade and heartbeat events for its listed crypto pairs | Prices and volume belong to Coinbase, not every crypto exchange. Public feed gaps are possible. |
| Your Alpaca account | Its Basic plan currently includes realtime IEX stock data | Requires your own account/key. IEX covers one venue. SIP and overnight feeds have separate account entitlements and semantics. |

Source access and data usage remain subject to the provider's terms. Free software does not grant rights to redistribute third-party market data. See [Yahoo's source and delay information](https://help.yahoo.com/kb/SLN2310.html), [Coinbase's data terms](https://www.coinbase.com/legal/market_data), and [Alpaca's current data plans](https://docs.alpaca.markets/us/docs/about-market-data-api).

## History and older pages

Charts load bounded pages and request older history as you move left or select **Load older**. A page contains up to 5,000 bars and charts merge the returned pages. A single history request is bounded to 20,000 calendar-time buckets, or 100,000 for US intraday data to allow for closed sessions; the resulting strategy snapshot still accepts at most 20,000 actual bars. Loading another chart page does not silently change a backtest's immutable input.

Yahoo's minute history has two different limits: retention and request size. On **October 15, 2026**, the public source returned actual 1-minute bars from 9 and 21 days earlier, and rejected a 34-day-old request with a 30-day retention message. Tickgrove therefore pages within that 30-day window using requests no wider than seven days. Preparing an immutable minute-data snapshot uses the same request splitting, then merges and deduplicates the source bars. The seven-day page size is an adapter request policy, not the total available history.

The adapter also bounds Yahoo 5/15-minute requests to 60 days and hourly requests to 730 days. These are public-source limits, not a promise of complete data for every symbol. Daily history is much longer: the same [read-only source probes](../server/tests/market-source-probes.json) returned **2,512 VOO daily bars across ten years**. Tickgrove uses Yahoo's reported first trading date when available; its current US calendar supports 1990–2035. It does not claim that Yahoo's own archive starts in 1990.

Coinbase does not share Yahoo's short minute-history window. The probes returned LTC-USD 1-minute bars from a month earlier and hourly bars from two months earlier. Coinbase's candle endpoint allows at most 300 rows per request; Tickgrove fetches bounded ranges and aggregates supported larger periods. No-trade intervals may have no candle. An empty page is distinguished from a confirmed history boundary. See the [official candle contract](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles).

The [isolated application acceptance](../server/tests/market-data-report.json) also paged VOO back to 2014 and froze 28 days of SPY minute data into one 7,800-bar snapshot through four source requests, with no reported gaps. It verified shared live Coinbase and Yahoo connections without provider credentials or order submission.

These probes establish the ranges tested on that date. They do not guarantee permanent availability, arbitrary multi-year stock minute history, or complete tick archives. For unavailable ranges, use a supported longer interval or import a data archive you are entitled to use. An imported OHLCV archive does not recreate missing historical ticks.

## Live data and trading sessions

Rust receives upstream WebSocket messages. Each provider/feed/credential profile uses one shared connection for its requested symbols; different chart periods consume that connection independently. Reconnection restores the current symbol set. Consumer overload and missing messages produce explicit gaps.

The browser currently reads resumable event cursors. A refresh timer is not an exchange latency guarantee. Connection health, quote time, provider delay, and the selected trading session are separate states. A closed regular session should show the last known price **as of** its timestamp rather than imply a broken connection.

- Coinbase is a 24/7 venue. Its ticker and matches channels provide live market events; heartbeat IDs help detect missing trades. Bar reconciliation can repair candles, but cannot reconstruct never-received ticks. [Coinbase WebSocket documentation](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels).
- Yahoo quote updates are reference data. Quote-derived forming candles have unknown volume and are not confirmed strategy candles or executable local-account quotes.
- Alpaca `iex` and `sip` use the official `v2` stream; `boats` and `overnight` use `v1beta1`. The regular session, pre/post-market, and overnight session have different calendar boundaries. [Official stream contract](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data).
- Alpaca's free `overnight` feed provides indicative realtime quotes and delayed trades. Overnight historical requests use `boats`; the free entitlement requires delayed history. Actual BOATS access depends on the user's plan. Indicative data is view-only for local quote matching. [Overnight feed matrix](https://docs.alpaca.markets/us/docs/245-trading-for-trading-api).

Alpaca feed routing and calendar behavior have offline tests; dedicated-account live SIP/BOATS validation remains separate. Saving a key or passing one REST connection test does not verify every feed or a sustained stream.

Quote midpoint, bid/ask and last trade are distinct. Local paper matching requires an explicitly eligible, fresh source quote. Yahoo reference prices and indicative/unknown/delayed feeds cannot silently produce simulated fills. Native historical backtests use their recorded snapshot and simulation model instead.

## Storage and cache

You do not need to install a database service. Rust embeds SQLite; keep the data directory or Docker volume across upgrades. Use one running instance per data directory.

History responses have a rebuildable SQLite cache, shared request coalescing, a pooled HTTP client, and provider-wide request pacing. The default cache budget is **64 MiB**, configurable with `TICKGROVE_HISTORY_CACHE_BYTES`. Recent ranges expire after 30 seconds; ranges ending more than a week ago expire after 24 hours. Default live-page requests use a minute boundary so repeated loads can reuse the same cache key.

The cache is separate from saved strategy versions, immutable data snapshots, results, workspaces and execution journals. **Clear history cache** removes only data that can be fetched again. It does not delete saved research or reset the paper account. `market.cacheInfo` reports cache usage; `market.cacheClear` clears it.

Backups must preserve the database consistently, plus deployment/configuration material needed to reproduce the run. See [self-hosting](self-hosting.md). Older chart pages and a bounded cache are not a promise of an unlimited permanent archive. Market event retention is finite; an expired cursor is reported rather than silently skipped.

Optional account credentials stay server-side in your own data directory with restricted file permissions, or in explicitly configured environment variables. No credentials are bundled with the repository, returned by the connection API, or borrowed from another project.
