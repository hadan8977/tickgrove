import { useEffect, useRef, useState } from "react";
import { command } from "./client";
import { marketRequest } from "../data/feed";
import { targetChartId, useApp, useCharts } from "../store";
import { Button, Input, Select, fmt } from "../ui/primitives";
import { TIMEFRAMES, type Timeframe } from "../core/types";
import { useConnection } from "./workspaceSync";
export default function AlertsPanel() {
  const activeChartId = useApp((s) => s.activeChartId);
  const chart = useCharts((s) => s.charts[activeChartId ?? targetChartId() ?? ""]);
  const pendingAction = useRef(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [followChart, setFollowChart] = useState(true);
  const [alerts, setAlerts] = useState<any[]>([]),
    [history, setHistory] = useState<any[]>([]),
    [strategyHistory, setStrategyHistory] = useState<any[]>([]),
    [error, setError] = useState("");
  const supportsStrategies = useConnection((s) => s.commands.includes("alerts.strategyHistory"));
  const [symbol, setSymbol] = useState(chart?.symbol ?? "SPY"),
    [name, setName] = useState("Price alert"),
    [kind, setKind] = useState("cross"),
    [price, setPrice] = useState(""),
    [frequency, setFrequency] = useState("once"),
    [expiry, setExpiry] = useState("");
  const [tf, setTf] = useState<Timeframe>(chart?.tf ?? "1m");
  useEffect(() => {
    if (!followChart || !chart) return;
    if (chart.symbol !== symbol) setPrice("");
    setSymbol(chart.symbol);
    setTf(chart.tf);
  }, [chart?.symbol, chart?.tf, followChart]);
  const useCurrentChart = () => {
    if (!chart) return;
    if (chart.symbol !== symbol) setPrice("");
    setSymbol(chart.symbol); setTf(chart.tf); setFollowChart(true);
  };
  const refresh = async () => {
    const [a, h, s] = await Promise.all([
      command("alerts.list"),
      command("alerts.history"),
      supportsStrategies ? command("alerts.strategyHistory") : Promise.resolve([]),
    ]);
    setAlerts(
      (Array.isArray(a) ? a : (a.alerts ?? [])).map((item: any) => ({
        ...item.params,
        ...item,
      })),
    );
    setHistory(Array.isArray(h) ? h : (h.events ?? []));
    setStrategyHistory(s);
  };
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
    const id = setInterval(() => void refresh().catch((e) => setError(String(e))), 2000);
    return () => clearInterval(id);
  }, [supportsStrategies]);
  const act = async (fn: () => Promise<unknown>, success = "") => {
    if (pendingAction.current) return;
    pendingAction.current = true; setBusy(true);
    setError(""); setNotice("");
    try {
      await fn();
      await refresh();
      setNotice(success);
    } catch (error) {
      setError(String(error));
    } finally {
      pendingAction.current = false; setBusy(false);
    }
  };
  return (
    <section className="h-full overflow-auto bg-panel p-5">
      <h1 className="text-xl font-semibold">Alerts</h1>
      <p className="mt-2 text-sm text-muted">
        Alerts run on the server against their provider's market events. Delivery history remains
        available after closing your browser.
      </p>
      <p className="mt-2 text-xs text-muted">
        Only fresh source events trigger price alerts. Delayed or unknown-latency feeds, including
        the free stock fallback, do not guarantee realtime alerts.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted"><span>{followChart ? `Following current chart${chart ? " · " + chart.symbol + " " + chart.tf : ""}` : "Custom alert instrument"}</span><Button type="button" size="sm" disabled={busy || !chart} onClick={useCurrentChart}>Use current chart</Button></div>
      <form
        className="my-5 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            if (!name.trim() || !symbol.trim() || !Number.isFinite(Number(price)) || !(Number(price) > 0)) throw Error("Enter a name, instrument and positive finite price");
            if (expiry && !Number.isFinite(Date.parse(expiry))) throw Error("Choose a valid expiry time");
            return command("alerts.create", {
              ...marketRequest(symbol, tf), name: name.trim(), kind, price: Number(price), frequency,
              ...(expiry ? { expiresAt: Date.parse(expiry) } : {}),
            });
          }, `Alert created for ${symbol} · ${tf}`);
        }}
      >
        <label className="text-xs">
          Name
          <Input aria-label="Alert name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="text-xs">
          Instrument
          <Input
            aria-label="Alert instrument"
            value={symbol}
            onChange={(e) => { setFollowChart(false); setSymbol(e.target.value); }}
          />
        </label>
        <label className="text-xs">
          Condition
          <Select
            aria-label="Alert condition"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="cross">Crosses price</option>
            <option value="above">Above price</option>
            <option value="below">Below price</option>
          </Select>
        </label>
        <label className="text-xs">
          Bar interval
          <Select value={tf} onChange={(e) => { setFollowChart(false); setTf(e.target.value as Timeframe); }}>
            {TIMEFRAMES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </label>
        <label className="text-xs">
          Price
          <Input
            aria-label="Alert price"
            type="number"
            min="0"
            step="any"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        <label className="text-xs">
          Frequency
          <Select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            <option value="once">Once</option>
            <option value="once_per_bar">Once per bar</option>
          </Select>
        </label>
        <label className="text-xs">
          Expiry (local time)
          <Input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </label>
        <Button variant="primary" disabled={busy || !name.trim() || !symbol.trim() || !Number.isFinite(Number(price)) || !(Number(price) > 0)}>
          {busy ? "Saving…" : "Create alert"}
        </Button>
      </form>
      {notice && <p role="status" className="mb-3 text-sm text-up">{notice}</p>}
      {error && (
        <p role="alert" className="text-sm text-down">
          {error}
        </p>
      )}
      <div className="space-y-2">
        {alerts.map((a) => (
          <div
            key={a.id}
            className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-line p-3 text-sm"
          >
            <b>{a.name}</b>
            <span>
              {a.symbol} · {a.kind} {a.price}
            </span>
            <span className={a.status === "failed" ? "text-down" : "text-muted"}>
              {a.provider} · {a.status === "failed" ? "Source needs attention" : a.status}
            </span>
            {["active", "paused", "failed"].includes(a.status) && <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  command("alerts.pause", {
                    id: a.id,
                    paused: a.status === "active",
                  }),
                  a.status === "active" ? "Alert paused" : "A new observation window has started. Earlier gaps are not replayed.",
                )
              }
            >
              {a.status === "active" ? "Pause" : "Resume from now"}
            </Button>}
            <Button
              size="sm"
              variant="danger"
              disabled={busy || a.status === "deleted"}
              onClick={() => void act(() => command("alerts.delete", { id: a.id }), "Alert deleted")}
            >
              Delete
            </Button>
            {a.error && <p role="alert" className="w-full min-w-0 break-words text-xs text-down">{a.error}</p>}
            {["paused", "failed"].includes(a.status) && <p className="w-full text-xs text-muted">Resuming starts a new observation window. Earlier gaps are not replayed.</p>}
          </div>
        ))}
      </div>
      <h2 className="mb-3 mt-6 font-semibold">Trigger history</h2>
      {!history.length && <p className="text-sm text-muted">No alert events yet.</p>}
      {history.map((event, i) => (
        <div
          key={event.id ?? event.cursor ?? i}
          className="flex flex-wrap gap-3 border-b border-line py-2 text-xs"
        >
          <span>{new Date(event.eventTime).toLocaleString()}</span>
          <b>{event.message}</b>
          <span>{fmt.price(event.price)}</span>
          <span className="text-muted">Source event {event.marketCursor}</span>
        </div>
      ))}
      {supportsStrategies && (
        <>
          <h2 className="mb-3 mt-6 font-semibold">Pine notifications</h2>
          <p className="mb-3 text-xs text-muted">
            Notifications from live scripts and newly committed strategy bars. Each trigger follows
            its script's frequency. Historical backtest alerts stay with their reports.
          </p>
          {!strategyHistory.length && (
            <p className="text-sm text-muted">No strategy notifications yet.</p>
          )}
          {strategyHistory.map((event) => (
            <div key={event.id} className="flex flex-wrap gap-3 border-b border-line py-2 text-xs">
              <span>{new Date(event.eventTime).toLocaleString()}</span>
              <b>{event.alert?.title ?? event.alert?.type ?? "Pine alert"}</b>
              <span className="min-w-0 break-words">{event.alert?.message}</span>
              <span className="text-muted">
                {event.context?.source === "pine_host" ? "Live script" : "Strategy"} · {event.session_id.slice(0, 8)}
              </span>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
