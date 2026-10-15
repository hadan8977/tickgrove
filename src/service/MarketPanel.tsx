import { useEffect, useState } from "react";
import { command } from "./client";
import {
  loadMarketHistory,
  marketRequest,
  marketSeries,
  marketSummary,
  isDemoData,
  registerInstrument,
  stopMarket,
} from "../data/feed";
import { TIMEFRAMES, type Timeframe } from "../core/types";
import { useTick } from "../ui/hooks";
import { useApp, useCharts, targetChartId } from "../store";
import { Button, Input, Select, Popover, cx, fmt } from "../ui/primitives";
import type { MarketSubscription } from "../core/marketTypes";
import PortfolioData from "./PortfolioData";
import DataConnections from "./DataConnections";
import { marketStatus } from "../data/marketStatus";
import { useConnection } from "./workspaceSync";

export function MarketBadge({
  symbol,
  tf,
  compact = false,
}: {
  symbol: string;
  tf: Timeframe;
  compact?: boolean;
}) {
  useTick();
  const data = marketSeries(symbol, tf),
    identity = data.identity;
  if (isDemoData()) return <span className="text-xs text-demo">Demo</span>;
  const age = data.quoteReceivedAt ? Math.max(0, Date.now() - data.quoteReceivedAt) : undefined;
  const { label, tone } = marketStatus(data);
  const date = (value?: number) =>
    value ? new Date(value).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "Not received";
  return (
    <Popover
      align="right"
      className="w-80"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-expanded={open}
          aria-label={"Data status for " + symbol}
          onClick={toggle}
          className={cx(
            "market-status inline-flex h-6 max-w-full items-center gap-1.5 whitespace-nowrap rounded px-1.5 text-[11px] hover:bg-panel-2",
            tone,
          )}
          title="Data source, freshness and coverage"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-current" />
          {!compact && identity && (
            <span className="capitalize text-muted">{identity.provider} ·</span>
          )}
          <span>{label}</span>
          {!!data.gaps?.length && <span aria-label="Historical gaps">!</span>}
        </button>
      )}
    >
      <section aria-label="Market data details" className="space-y-3 p-3 text-xs">
        <h3 className="text-sm font-semibold">Market data</h3>
        <dl className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-2 [&>dd]:break-words [&>dt]:text-muted">
          <dt>Symbol</dt>
          <dd>
            {symbol} · {tf}
          </dd>
          <dt>Source</dt>
          <dd>{identity ? identity.provider + " · " + identity.feed : "Waiting for provider"}</dd>
          <dt>Venue</dt>
          <dd>{identity?.venue ?? "—"}</dd>
          <dt>Session</dt>
          <dd>
            {identity?.session ?? "—"} · {data.marketState?.state ?? "unknown"} ·{" "}
            {identity?.timezone ?? "—"}
          </dd>
          <dt>Data policy</dt>
          <dd className={tone}>
            {identity?.delay.kind ?? "Unknown"}
            {identity?.delay.seconds != null ? " · " + identity.delay.seconds + "s" : ""}
          </dd>
          <dt>Connection</dt>
          <dd>{data.status}</dd>
          <dt>Quote time</dt>
          <dd>{date(data.eventTime)}</dd>
          <dt>Received</dt>
          <dd>{age === undefined ? "No live quote received" : Math.floor(age / 1000) + "s ago"}</dd>
          <dt>History</dt>
          <dd>
            {data.bars.length.toLocaleString()} bars
            {data.gaps?.length ? " · " + data.gaps.length + " gaps" : ""}
            {data.bars.length > 0 && (
              <span className="mt-1 block">
                {new Date(data.bars[0].time * 1000).toISOString().slice(0, 10)} —{" "}
                {new Date(data.bars.at(-1)!.time * 1000).toISOString().slice(0, 10)}
              </span>
            )}
            {data.coverageReason && (
              <span className="mt-1 block text-muted">{data.coverageReason}</span>
            )}
          </dd>
        </dl>
        {identity?.delay.disclaimer && (
          <p className="leading-relaxed text-muted">{identity.delay.disclaimer}</p>
        )}
        {(data.error || data.streamError) && (
          <p role="alert" className="break-words text-down">
            {data.error || data.streamError}
          </p>
        )}
        <div className="flex gap-2">
          {data.error && (
            <Button
              size="sm"
              onClick={() =>
                void loadMarketHistory(symbol, tf, undefined, { force: true }).catch(() => {})
              }
            >
              Retry history
            </Button>
          )}
          <Button size="sm" onClick={() => useApp.getState().setView("market")}>
            Data settings
          </Button>
        </div>
      </section>
    </Popover>
  );
}
const suggestedDays = (tf: Timeframe) =>
  ({ "1m": 3, "5m": 7, "15m": 30, "1H": 60, "4H": 365, "1D": 365, "1W": 1825 })[tf] ?? 365;
export default function MarketPanel() {
  useTick();
  const activeChart = useCharts((s) => s.charts[targetChartId() ?? ""]);
  const initial = marketRequest(activeChart?.symbol ?? "SPY", activeChart?.tf ?? "1D");
  const [capabilities, setCapabilities] = useState<any>(),
    [subscriptions, setSubscriptions] = useState<MarketSubscription[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState<string>(initial.provider),
    [symbol, setSymbol] = useState(initial.symbol),
    [feed, setFeed] = useState(initial.feed ?? "iex"),
    [tf, setTf] = useState<Timeframe>(activeChart?.tf ?? "1D"),
    [session, setSession] = useState(initial.session ?? "regular");
  const [start, setStart] = useState(
      new Date(Date.now() - suggestedDays(activeChart?.tf ?? "1D") * 86400000)
        .toISOString()
        .slice(0, 16),
    ),
    [end, setEnd] = useState(new Date().toISOString().slice(0, 16));
  const [customRange, setCustomRange] = useState(false);
  const [cache, setCache] = useState<{ entries: number; bytes: number; maxBytes: number }>();
  const [cacheBusy, setCacheBusy] = useState(false);
  const canWriteData = useConnection((s) => s.permissions.includes("data.write"));
  const refresh = async () => {
    const [c, s, cache] = await Promise.all([
      command("market.capabilities"),
      command<MarketSubscription[]>("market.list"),
      command("market.cacheInfo"),
    ]);
    setCapabilities(c);
    setSubscriptions(s);
    setCache(cache);
  };
  useEffect(() => {
    const preferred = sessionStorage.getItem("tickgrove.data-source-selection");
    if (preferred && ["yahoo", "coinbase", "alpaca"].includes(preferred)) {
      setProvider(preferred);
      setSymbol(preferred === "coinbase" ? "BTC-USD" : "SPY");
      sessionStorage.removeItem("tickgrove.data-source-selection");
    }
    void refresh().catch((e) => setError(String(e)));
    const id = setInterval(() => void refresh().catch((e) => setError(String(e))), 3000);
    return () => clearInterval(id);
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };
  const load = async () => {
    setLoading(true);
    try {
      const canonical = `${provider.toUpperCase()}:${
        provider === "alpaca"
          ? feed +
            (session === "extended" && !["boats", "overnight"].includes(feed) ? ":extended:" : ":")
          : provider === "yahoo" && session === "extended"
            ? "extended:"
            : ""
      }${symbol.toUpperCase().trim()}`;
      registerInstrument({
        symbol: canonical,
        provider: provider as any,
        providerSymbol: symbol.toUpperCase().trim(),
        kind: provider === "coinbase" ? "crypto" : "stock",
      });
      await loadMarketHistory(
        canonical,
        tf,
        customRange
          ? {
              start: Date.parse(start + "Z") / 1000,
              end: Date.parse(end + "Z") / 1000,
            }
          : undefined,
      );
      const id = targetChartId();
      if (id) {
        useCharts.getState().setSymbol(id, canonical);
        useCharts.getState().setTf(id, tf);
      }
      useApp.getState().setView("workspace");
    } finally {
      setLoading(false);
    }
  };
  return (
    <section className="h-full overflow-auto bg-panel p-5">
      <h1 className="page-heading">Data sources & history</h1>
      <p className="mt-2 text-sm text-muted">
        Search instruments from a provider or enter its exact symbol. Coverage and real-time access
        depend on the selected source. Gaps never switch to synthetic prices.
      </p>
      <DataConnections
        onChoose={(next) => {
          setProvider(next);
          setSymbol(next === "coinbase" ? "BTC-USD" : "SPY");
          setSession("regular");
          setCustomRange(false);
          document
            .getElementById("market-history-form")
            ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }}
      />
      <h2 className="mt-6 text-sm font-semibold">Open a chart or choose a history range</h2>
      <div id="market-history-form" className="my-4 flex flex-wrap items-end gap-3">
        <label className="text-xs">
          Provider
          <Select
            className="mt-1 block"
            value={provider}
            onChange={(e) => {
              const next = e.target.value;
              setProvider(next);
              setSymbol(next === "coinbase" ? "BTC-USD" : "SPY");
            }}
          >
            {(
              capabilities?.providers ?? [{ id: "yahoo" }, { id: "coinbase" }, { id: "alpaca" }]
            ).map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-xs">
          Provider symbol
          <Input
            aria-label="Provider symbol"
            className="mt-1"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
          />
        </label>
        {provider === "alpaca" && (
          <label className="text-xs">
            Feed
            <Select className="mt-1 block" value={feed} onChange={(e) => setFeed(e.target.value)}>
              {["iex", "sip", "boats", "overnight"].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </Select>
          </label>
        )}
        {(provider === "yahoo" ||
          (provider === "alpaca" && !["boats", "overnight"].includes(feed))) && (
          <label className="text-xs">
            Session
            <Select
              className="mt-1 block"
              value={session}
              onChange={(e) => setSession(e.target.value)}
            >
              <option value="regular">Regular session</option>
              <option value="extended">Pre / regular / post</option>
            </Select>
          </label>
        )}
        <label className="text-xs">
          Interval
          <Select
            className="mt-1 block"
            value={tf}
            onChange={(e) => {
              const next = e.target.value as Timeframe;
              setTf(next);
              if (!customRange) {
                setStart(
                  new Date(Date.now() - suggestedDays(next) * 86400000).toISOString().slice(0, 16),
                );
                setEnd(new Date().toISOString().slice(0, 16));
              }
            }}
          >
            {TIMEFRAMES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </label>
        <details
          className="rounded-lg border border-line p-2 text-xs"
          open={customRange}
          onToggle={(e) => setCustomRange(e.currentTarget.open)}
        >
          <summary className="cursor-pointer text-muted">Custom date range (UTC)</summary>
          <div className="mt-3 flex flex-wrap gap-3">
            <label className="text-xs">
              Start (UTC)
              <Input
                className="mt-1"
                type="datetime-local"
                value={start}
                onChange={(e) => {
                  setCustomRange(true);
                  setStart(e.target.value);
                }}
              />
            </label>
            <label className="text-xs">
              End (UTC)
              <Input
                className="mt-1"
                type="datetime-local"
                value={end}
                onChange={(e) => {
                  setCustomRange(true);
                  setEnd(e.target.value);
                }}
              />
            </label>
          </div>
        </details>
        <Button
          variant="primary"
          disabled={
            loading || !symbol.trim() || (customRange && (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end)))
          }
          onClick={() => void act(load)}
        >
          {loading ? "Loading…" : customRange ? "Load selected range" : "Open chart"}
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        Charts start with recent history. Pan left or use “Load earlier history” to download older
        pages. Source limits are shown on the chart; your saved snapshots and imported archives stay
        on this server.
      </p>
      <details className="my-4 rounded-xl border border-line p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          Local history cache
          {cache ? ` · ${cache.entries} entries · ${(cache.bytes / 1048576).toFixed(1)} MB` : ""}
        </summary>
        <p className="my-3 text-xs text-muted">
          Downloaded history is cached on this server to reuse requests. Limit:{" "}
          {cache ? (cache.maxBytes / 1048576).toFixed(0) : "—"} MB. Clearing this cache keeps saved
          strategy snapshots, runs and accounts.
        </p>
        <Button
          size="sm"
          disabled={!canWriteData || cacheBusy}
          onClick={() => {
            setCacheBusy(true);
            void act(async () => {
              await command("market.cacheClear");
            }).finally(() => setCacheBusy(false));
          }}
        >
          {cacheBusy ? "Clearing…" : "Clear downloaded cache"}
        </Button>
      </details>
      {error && (
        <p role="alert" className="text-sm text-down">
          {error}
        </p>
      )}
      <details className="my-4 rounded-xl border border-line p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          Portfolio datasets · multiple symbols
        </summary>
        <PortfolioData />
      </details>
      <details className="mt-5 rounded-xl border border-line p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          Connections and diagnostics ({subscriptions.filter((s) => s.desired).length} active)
        </summary>
        <h2 className="mb-2 mt-4 font-semibold">Server subscriptions</h2>
        <p className="mb-2 text-xs text-muted">
          Subscriptions keep running when this browser is closed. Stop them explicitly when no
          longer needed.
        </p>
        <div className="space-y-2">
          {subscriptions.map((s) => (
            <div
              key={s.id}
              className="flex flex-wrap items-center gap-3 rounded-lg bg-panel-2 p-3 text-xs"
            >
              <b>{s.identity.symbol}</b>
              <span>
                {s.identity.provider} · {s.identity.feed} · {s.identity.timeframe}
              </span>
              <span>{s.status}</span>
              <span>Received {s.lastEventAt ? new Date(s.lastEventAt).toISOString() : "—"}</span>
              <Button
                size="sm"
                disabled={!s.desired}
                onClick={() => void act(() => stopMarket(s.id))}
              >
                Stop subscription
              </Button>
              {s.error && <span className="text-down">{s.error}</span>}
            </div>
          ))}
        </div>
        <h2 className="mb-2 mt-6 font-semibold">Loaded chart data</h2>
        {marketSummary().map((s) => (
          <div key={s.key} className="border-b border-line py-2 text-xs">
            <b>{s.key}</b> · {s.bars} bars · {s.status}{" "}
            {s.error && <span className="text-down">{s.error}</span>}
            <div className="text-muted">
              Snapshot {s.snapshotId ?? "created when you run a backtest"} ·{" "}
              {s.identity?.adjustment ?? "—"}
            </div>
          </div>
        ))}
      </details>
    </section>
  );
}
