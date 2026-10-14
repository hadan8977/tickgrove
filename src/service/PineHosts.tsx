import { useEffect, useMemo, useRef, useState } from "react";
import { command } from "./client";
import { useConnection } from "./workspaceSync";
import { Button, Input, Select, fmt } from "../ui/primitives";
import ChartCanvas from "../features/chart/ChartCanvas";
import type { ChartState, Timeframe } from "../core/types";
import type { MarketSubscription } from "../core/marketTypes";

type SourceStatus = MarketSubscription & {
  lastQuoteEventTime?: number;
  lastQuoteReceivedAt?: number;
  quoteStale?: boolean;
};

type Host = {
  session_id: string;
  version_id: string;
  snapshot_id: string;
  subscription_id: string;
  execution: string;
  status: string;
  marketCursor: number;
  result?: any;
  error?: string;
};
const ignoreChartEvent = () => {};
export default function PineHosts({
  version,
  snapshot,
  inputs,
}: {
  version: string;
  snapshot: string;
  inputs: string;
}) {
  const supported = useConnection((s) => s.commands.includes("pine.host.deploy"));
  const [hosts, setHosts] = useState<Host[]>([]),
    [mode, setMode] = useState("indicator"),
    [capital, setCapital] = useState("10000"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(""),
    [view, setView] = useState<any>(),
    [identity, setIdentity] = useState<any>(),
    [viewIdentity, setViewIdentity] = useState<any>(),
    [events, setEvents] = useState<any[]>([]);
  const [sourceStatus, setSourceStatus] = useState<SourceStatus>();
  const eventCursor = useRef(0);
  const refresh = async () => setHosts(await command("pine.host.list"));
  useEffect(() => {
    if (!supported) return;
    void refresh().catch((e) => setError(String(e)));
    const timer = setInterval(() => void refresh().catch((e) => setError(String(e))), 2000);
    return () => clearInterval(timer);
  }, [supported]);
  useEffect(() => {
    setIdentity(undefined);
    if (!snapshot) {
      return;
    }
    let canceled = false;
    void command("data.get", { snapshot_id: snapshot })
      .then((data) => {
        if (!canceled) setIdentity(data.metadata?.identity);
      })
      .catch((e) => {
        if (!canceled) setError(String(e));
      });
    return () => {
      canceled = true;
    };
  }, [snapshot]);
  const active = hosts.find((s) => s.session_id === selected);
  useEffect(() => {
    eventCursor.current = 0;
    setEvents([]);
    setView(undefined);
    setViewIdentity(undefined);
    setSourceStatus(undefined);
  }, [selected]);
  useEffect(() => {
    if (!active?.snapshot_id) return;
    let canceled = false;
    void command("data.get", { snapshot_id: active.snapshot_id })
      .then((data) => {
        if (!canceled) setViewIdentity(data.metadata?.identity);
      })
      .catch((e) => {
        if (!canceled) setError(String(e));
      });
    return () => {
      canceled = true;
    };
  }, [active?.snapshot_id]);
  useEffect(() => {
    if (!selected || !active || !["active", "paused"].includes(active.status)) return;
    let canceled = false,
      pending = false;
    const update = async () => {
      if (pending) return;
      pending = true;
      try {
        const [render, history, sources] = await Promise.all([
          command("pine.host.render", { session_id: selected }),
          command("pine.host.events", { session_id: selected, cursor: eventCursor.current }),
          command<SourceStatus[]>("market.status", { subscription_id: active.subscription_id }),
        ]);
        if (!canceled) {
          setView(render);
          setSourceStatus(sources[0]);
          const next = history.events ?? [];
          if (next.length) {
            eventCursor.current = next.at(-1).cursor;
            setEvents((old) => [...old, ...next].slice(-1000));
          }
        }
      } catch (e) {
        if (!canceled) setError(String(e));
      } finally {
        pending = false;
      }
    };
    void update();
    const timer = setInterval(() => void update(), 1500);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [selected, active?.status]);
  async function act(fn: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function deploy() {
    if (!identity)
      throw Error(
        "Select a real market snapshot with source metadata before starting a live session",
      );
    if (!Number.isFinite(Number(capital)) || Number(capital) <= 0)
      throw Error("Starting allocation must be positive");
    const stream = await command("market.subscribe", {
      provider: identity.provider,
      symbol: identity.symbol,
      timeframe: identity.timeframe,
      session: identity.session,
      adjustment: identity.adjustment,
      ...(identity.provider === "alpaca" ? { feed: identity.feed } : {}),
    });
    const result = await command(
      "pine.host.deploy",
      {
        version_id: version,
        snapshot_id: snapshot,
        subscription_id: stream.subscription_id,
        execution: mode,
        startingCash: Number(capital),
        inputs: JSON.parse(inputs),
      },
      crypto.randomUUID(),
    );
    setSelected(result.session_id);
    setView(undefined);
    setEvents([]);
  }
  const chart = useMemo<ChartState>(
    () => ({
      id: "live-pine-" + selected,
      symbol: viewIdentity?.symbolId ?? viewIdentity?.symbol ?? "Live Pine",
      tf: (viewIdentity?.timeframe as Timeframe) ?? "1m",
      group: null,
      style: "candles",
      indicators: [],
    }),
    [selected, viewIdentity],
  );
  const displayBars = useMemo(
    () => view?.bars?.map((bar: any) => ({ ...bar, volume: bar.volume ?? NaN })) ?? [],
    [view?.bars],
  );
  if (!supported) return null;
  return (
    <section aria-label="Live Pine sessions" className="mt-5 rounded border border-line p-4">
      <h2 className="text-lg">Live Pine sessions</h2>
      <p className="my-2 text-xs text-muted">
        Run indicators on market events, or use broker fills as the strategy account. Tick
        strategies require calc_on_every_tick=true. Unsupported language or data bindings fail with
        a diagnostic.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs">
          Execution
          <Select
            aria-label="Live Pine execution"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="indicator">Indicator only</option>
            <option value="local_broker">Local paper account</option>
            <option value="external_broker">External fills through API</option>
          </Select>
        </label>
        {mode !== "indicator" && (
          <label className="text-xs">
            Strategy reference capital (USD)
            <Input
              type="number"
              min="0"
              step="any"
              value={capital}
              onChange={(e) => setCapital(e.target.value)}
            />
          </label>
        )}
        <Button
          disabled={busy || !version || !snapshot || !identity}
          variant="primary"
          onClick={() => void act(deploy)}
        >
          Start selected Pine version
        </Button>
        <span className="text-xs text-muted">
          {identity
            ? `${identity.provider}:${identity.symbol} · ${identity.timeframe}`
            : "Choose a market snapshot above"}
        </span>
      </div>
      {mode === "local_broker" && (
        <p className="mt-3 text-xs text-muted">
          Orders use the shared local paper account. Reference capital measures this strategy's
          equity; it does not reserve account cash.
        </p>
      )}
      {mode === "external_broker" && (
        <p className="mt-3 text-xs text-demo">
          This mode exposes order intentions. A separately configured adapter must return actual
          fills through the authorized feedback API.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-down">
          {error}
        </p>
      )}
      <div className="mt-3 space-y-2">
        {hosts.map((s) => (
          <article key={s.session_id} className="rounded border border-line p-3 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <b>{s.session_id.slice(0, 8)}</b>
              <span>
                {s.execution === "indicator"
                  ? "Indicator"
                  : s.execution === "local_broker"
                    ? "Local paper"
                    : "External broker"}
              </span>
              <span>{s.status}</span>
              {s.result?.account && (
                <span>
                  Equity {fmt.money(s.result.account.equity)} · position{" "}
                  {s.result.account.positionSize}
                </span>
              )}
              <Button
                size="sm"
                disabled={!["active", "paused"].includes(s.status)}
                onClick={() => setSelected(s.session_id)}
              >
                View chart and events
              </Button>
              {s.execution !== "indicator" && ["active", "paused"].includes(s.status) && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      command(s.status === "paused" ? "pine.host.resume" : "pine.host.pause", {
                        session_id: s.session_id,
                      }),
                    )
                  }
                >
                  {s.status === "paused" ? "Resume orders" : "Pause orders"}
                </Button>
              )}
              <Button
                size="sm"
                disabled={busy || s.status === "stopped"}
                onClick={() =>
                  void act(() => command("pine.host.stop", { session_id: s.session_id }))
                }
              >
                Stop session
              </Button>
            </div>
            {s.status === "paused" && (
              <p className="mt-2 text-muted">
                Order submission is paused; calculations and fill reconciliation continue.
              </p>
            )}
            {s.status === "warming_up" && (
              <p className="mt-2 text-muted">
                Waiting for contiguous confirmed history and a complete live bar. A connection
                restart may require historical repair before this session can start.
              </p>
            )}
            {s.error && <p className="mt-2 text-down">{s.error}</p>}
            {s.result?.pendingOrders?.length > 0 && (
              <p className="mt-2 text-muted">
                {s.result.pendingOrders.length} pending order intention(s)
              </p>
            )}
          </article>
        ))}
      </div>
      {selected && view?.render && (
        <>
          {sourceStatus && (
            <p
              role="status"
              className="mt-4 text-xs text-muted"
              title={sourceStatus.identity.delay.disclaimer}
            >
              {sourceStatus.identity.provider} · {sourceStatus.identity.feed} ·{" "}
              {sourceStatus.identity.symbol}
              {" · "}
              {sourceStatus.identity.session}
              {" · "}
              {sourceStatus.identity.delay.kind}
              {" · "}
              {sourceStatus.status}
              {sourceStatus.lastQuoteEventTime
                ? ` · quote ${new Date(sourceStatus.lastQuoteEventTime).toISOString()}`
                : " · no quote received"}
              {sourceStatus.lastQuoteReceivedAt
                ? ` · received ${Math.max(0, Math.floor((Date.now() - sourceStatus.lastQuoteReceivedAt) / 1000))}s ago`
                : ""}
              {sourceStatus.quoteStale ? " · stale quote" : ""}
              {sourceStatus.error ? ` · ${sourceStatus.error}` : ""}
            </p>
          )}
          {view.render.warnings?.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-xs text-demo">
              {view.render.warnings.map((warning: string, i: number) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          )}
          <div className="relative mt-4 h-[460px] overflow-hidden rounded border border-line">
            <ChartCanvas
              key={selected}
              state={chart}
              onLegend={ignoreChartEvent}
              onHover={ignoreChartEvent}
              authoritative={{
                bars: displayBars,
                result: view.render,
              }}
            />
          </div>
          <div className="mt-3 max-h-60 overflow-auto text-xs">
            <h3 className="font-semibold">Session event history</h3>
            {events
              .slice(-100)
              .reverse()
              .map((e) => (
                <div key={e.cursor} className="flex flex-wrap gap-3 border-b border-line py-2">
                  <b>{e.kind}</b>
                  <span>#{e.cursor}</span>
                  <span>
                    {e.kind === "fill"
                      ? `${e.payload.side} ${e.payload.qty} @ ${e.payload.price}`
                      : e.payload?.bar
                        ? `${e.payload.kind} · ${e.payload.bar.close}`
                        : (e.payload?.message ?? "Order state updated")}
                  </span>
                </div>
              ))}
          </div>
        </>
      )}
    </section>
  );
}
