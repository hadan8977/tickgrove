import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  BaselineSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineStyle,
  type Time,
} from "lightweight-charts";
import { FlaskConical, Rocket, Trash2 } from "lucide-react";
import type { BacktestResult } from "../../core/types";
import { execute } from "../../core/commands";
import { useApp, useBacktests, useCharts } from "../../store";
import { Badge, Button, Empty, Select, StatusBadge, cx, fmt } from "../../ui/primitives";
import { cssVar } from "../chart/bus";
import { getBars, isDemoData } from "../../data/feed";
import { useRunProgress, cancelCurrentRun } from "../../service/runs";
import { command } from "../../service/client";

export default function BacktestReport({ onOpenScripts }: { onOpenScripts?: () => void } = {}) {
  const { results, activeId, setActive, remove, running } = useBacktests();
  const r = results.find((x) => x.id === activeId) ?? results[0];
  const [tab, setTab] = useState<"trades" | "monthly">("trades");
  const progress = useRunProgress();
  const [compare, setCompare] = useState("");
  const other = results.find((x) => x.id === compare);
  if (!r)
    return (
      <Empty
        icon={<FlaskConical size={18} />}
        title={running ? "Running backtest…" : "No backtests yet"}
        body={
          progress.error ??
          (running
            ? `Server job: ${progress.status}`
            : "Run a Pine or visual strategy against a saved market-data snapshot.")
        }
        action={
          <Button
            size="sm"
            onClick={() =>
              running
                ? cancelCurrentRun()
                : onOpenScripts
                  ? onOpenScripts()
                  : execute("panel.open", { panel: "pine" })
            }
          >
            <FlaskConical size={12} /> {running ? "Cancel run" : "Open Pine scripts"}
          </Button>
        }
      />
    );
  const m = r.metrics;
  const cards: [string, string, "up" | "down" | null][] = [
    ["Net profit", fmt.pct(m.netProfitPct), m.netProfitPct >= 0 ? "up" : "down"],
    ["Buy & hold", fmt.pct(m.buyHoldPct), null],
    ["CAGR", fmt.pct(m.cagr), m.cagr >= 0 ? "up" : "down"],
    ["Max drawdown", fmt.pct(m.maxDrawdownPct, false), "down"],
    ["Sharpe", fmt.number(m.sharpe), null],
    ["Sortino", fmt.number(m.sortino), null],
    ["Win rate", fmt.pct(m.winRate, false), null],
    ["Profit factor", Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞", null],
    ["Trades", String(m.trades), null],
    ["Exposure", fmt.pct(m.exposurePct, false), null],
  ];
  return (
    <div className="report-panel flex h-full min-w-0 flex-col bg-panel">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-2.5 py-2">
        <Select
          value={r.id}
          onChange={(e) => setActive(e.target.value)}
          className="max-w-[220px] font-medium"
        >
          {results.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} · {x.symbol} {x.tf} · {new Date(x.createdAt).toLocaleTimeString()}
            </option>
          ))}
        </Select>
        <Badge>{r.source === "pine" ? "Pine" : "Blocks"}</Badge>
        <span className="text-[11px] text-muted" title={r.engine}>
          Historical simulation
        </span>
        <div className="flex-1" />
        {r.server ? <Badge>Server</Badge> : <StatusBadge status="demo" />}
        <Button
          size="sm"
          onClick={() => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(
              new Blob([JSON.stringify(r, null, 2)], { type: "application/json" }),
            );
            a.download = `run-${r.server?.jobId ?? r.id}.json`;
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          Export JSON
        </Button>
        <Button size="sm" variant="ghost" onClick={() => remove(r.id)} title="Discard">
          <Trash2 size={12} />
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => execute("paper.deploy", { backtestId: r.id })}
        >
          <Rocket size={12} />{" "}
          {isDemoData() && r.source === "pine" ? "Replay backtest" : "Deploy to paper"}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {running && (
          <div className="flex items-center gap-3 bg-accent/10 p-2 text-xs">
            Server job: {progress.status}
            <Button size="sm" onClick={() => void cancelCurrentRun()}>
              Cancel run
            </Button>
          </div>
        )}
        {progress.error && (
          <p role="alert" className="p-2 text-xs text-down">
            {progress.error}
          </p>
        )}
        {r.server && (
          <div className="flex flex-wrap gap-3 border-b border-line p-2 text-xs text-muted">
            <span>Snapshot {r.server.manifest.snapshot_hash?.slice(0, 12)}</span>
            <span>Source {r.server.manifest.strategy_hash?.slice(0, 12)}</span>
            <span>{r.server.manifest.engine}</span>
            <span>Inputs {JSON.stringify(r.server.inputs)}</span>
          </div>
        )}
        {results.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 p-2 text-xs">
            <label>
              Compare with{" "}
              <Select value={compare} onChange={(e) => setCompare(e.target.value)}>
                <option value="">Select run</option>
                {results
                  .filter((x) => x.id !== r.id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name} · {x.symbol} {x.tf}
                    </option>
                  ))}
              </Select>
            </label>
            {other && (
              <span>
                Net {fmt.pct(r.metrics.netProfitPct)} vs {fmt.pct(other.metrics.netProfitPct)} ·
                Drawdown {fmt.pct(r.metrics.maxDrawdownPct, false)} vs{" "}
                {fmt.pct(other.metrics.maxDrawdownPct, false)}
                {r.server?.manifest.snapshot_hash !== other.server?.manifest.snapshot_hash
                  ? " · different data snapshots"
                  : ""}
              </span>
            )}
          </div>
        )}
        <div className="report-metrics grid gap-px border-b border-line bg-line">
          {cards.map(([k, v, tone]) => (
            <div key={k} className="bg-panel px-3 py-2">
              <div className="text-[10.5px] uppercase tracking-wider text-faint">{k}</div>
              <div
                className={cx(
                  "num mt-0.5 text-[15px] font-semibold",
                  tone === "up" && "text-up",
                  tone === "down" && "text-down",
                )}
              >
                {v}
              </div>
            </div>
          ))}
        </div>
        <EquityChart r={r} />
        <div className="flex flex-wrap items-center gap-1 border-y border-line px-2.5 py-1.5">
          {(["trades", "monthly"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cx(
                "h-6 rounded-md px-2 text-[11.5px] font-medium capitalize",
                tab === t ? "bg-panel-3 text-text" : "text-muted hover:text-text",
              )}
            >
              {t === "trades" ? `Trades · ${r.trades.length}` : "Monthly returns"}
            </button>
          ))}
          <div className="flex-1" />
          <span className="num text-[11px] text-faint">
            capital {fmt.money(r.config.capital)} ·{" "}
            {r.nativeConfig
              ? `fee ${r.nativeConfig.commissionValue} ${r.nativeConfig.commissionType} · slip ${r.nativeConfig.slippageTicks} ticks · size ${r.nativeConfig.sizeValue} ${r.nativeConfig.sizeType}`
              : `fee ${r.config.commissionBps}bp · slip ${r.config.slippageBps}bp · size ${r.config.sizePct}%`}
            {r.config.stopPct ? ` · SL ${r.config.stopPct}%` : ""}
            {r.config.takePct ? ` · TP ${r.config.takePct}%` : ""}
          </span>
        </div>
        {!!r.openPositions?.length && (
          <div className="px-3 py-2 text-[11.5px] text-demo">
            {r.openPositions.length} open position(s) marked to the last close; excluded from closed
            trades.
          </div>
        )}
        {tab === "trades" ? <Trades r={r} /> : <Monthly r={r} />}
      </div>
    </div>
  );
}

function EquityChart({ r }: { r: BacktestResult }) {
  const el = useRef<HTMLDivElement>(null);
  const theme = useApp((s) => s.theme);
  const [benchmarkStatus, setBenchmarkStatus] = useState("Loading benchmark…");
  useEffect(() => {
    let canceled = false;
    const chart = createChart(el.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: cssVar("--muted"),
        fontFamily: getComputedStyle(document.body).fontFamily,
        fontSize: 10.5,
        attributionLogo: false,
        panes: { separatorColor: cssVar("--line") },
      },
      grid: { vertLines: { visible: false }, horzLines: { color: cssVar("--grid") } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
      handleScroll: false,
      handleScale: false,
    });
    const eq = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: r.config.capital },
      topLineColor: cssVar("--up"),
      topFillColor1: cssVar("--up") + "40",
      topFillColor2: cssVar("--up") + "05",
      bottomLineColor: cssVar("--down"),
      bottomFillColor1: cssVar("--down") + "05",
      bottomFillColor2: cssVar("--down") + "40",
      lineWidth: 2,
      priceLineVisible: false,
    });
    eq.setData(r.equity.map((e) => ({ time: e.time as Time, value: e.value })));
    const bh = chart.addSeries(AreaSeries, {
      lineColor: cssVar("--faint"),
      topColor: "transparent",
      bottomColor: "transparent",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const dd = chart.addSeries(
      HistogramSeries,
      {
        color: cssVar("--down") + "88",
        priceLineVisible: false,
        priceFormat: { type: "percent" } as any,
      },
      1,
    );
    dd.setData(r.drawdown.map((d) => ({ time: d.time as Time, value: d.value })));
    chart.panes()[1]?.setHeight(60);
    chart.timeScale().fitContent();
    const load = async () => {
      setBenchmarkStatus(
        r.server ? "Loading saved snapshot benchmark…" : "Loading synthetic demo benchmark…",
      );
      try {
        let bars: { time: number; open: number; close: number }[];
        if (r.server) {
          const snapshotId = r.server.snapshotId || r.server.manifest.snapshot_id;
          if (!snapshotId) throw Error("Saved report has no data snapshot reference");
          const snapshot = await command("data.get", { snapshot_id: snapshotId });
          bars = snapshot?.bars ?? [];
        } else {
          if (!isDemoData()) throw Error("Demo benchmark unavailable in connected market mode");
          bars = getBars(r.symbol, r.tf);
        }
        if (canceled) return;
        const base = bars[0]?.open;
        if (!Number.isFinite(base) || !(base > 0))
          throw Error("Snapshot has no valid starting price");
        const closes = new Map(bars.map((bar) => [bar.time, bar.close]));
        let missing = 0;
        const aligned = r.equity.map((point) => {
          const close = closes.get(point.time);
          if (close === undefined || !Number.isFinite(close) || close <= 0) {
            missing++;
            return { time: point.time as Time };
          }
          return { time: point.time as Time, value: (r.config.capital * close) / base };
        });
        if (!aligned.length || missing === aligned.length)
          throw Error("No snapshot prices align with strategy equity timestamps");
        bh.setData(aligned);
        setBenchmarkStatus(
          missing
            ? `Benchmark unavailable at ${missing} strategy timestamp(s); gaps remain visible.`
            : r.server
              ? "Buy & hold uses this report’s saved snapshot."
              : "Buy & hold uses synthetic demo prices.",
        );
      } catch (error) {
        if (!canceled) setBenchmarkStatus(`Buy & hold unavailable: ${String(error)}`);
      }
    };
    void load();
    return () => {
      canceled = true;
      chart.remove();
    };
  }, [r, theme]);
  return (
    <div className="relative">
      <div className="pointer-events-none absolute left-3 top-2 z-10 flex gap-3 text-[10.5px] text-muted">
        <span className="flex items-center gap-1">
          <span className="h-0.5 w-3 rounded bg-up" /> Strategy equity
        </span>
        <span className="flex items-center gap-1">
          <span className="h-0 w-3 border-t border-dashed border-faint" /> Buy & hold
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-down/60" /> Drawdown
        </span>
      </div>
      <div ref={el} className="h-[230px]" />
      <p role="status" className="px-3 pb-2 text-[11px] text-muted">
        {benchmarkStatus}
      </p>
    </div>
  );
}

function Trades({ r }: { r: BacktestResult }) {
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="num w-full min-w-[660px] whitespace-nowrap text-[11.5px]">
        <thead className="sticky top-0 bg-panel text-[10.5px] uppercase tracking-wider text-faint">
          <tr className="[&>th]:px-2.5 [&>th]:py-1.5 [&>th]:text-right [&>th]:font-medium">
            <th className="!text-left">#</th>
            <th className="!text-left">Side</th>
            <th className="!text-left">Entry</th>
            <th>Price</th>
            <th className="!text-left">Exit</th>
            <th>Price</th>
            <th>Qty</th>
            <th>P&L</th>
            <th>%</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {[...r.trades].reverse().map((t) => (
            <tr
              key={t.id}
              className="cursor-default border-t border-line hover:bg-panel-2 [&>td]:px-2.5 [&>td]:py-1 [&>td]:text-right"
            >
              <td className="!text-left text-faint">{t.id}</td>
              <td
                className={cx(
                  "!text-left font-medium",
                  t.side === "long" ? "text-up" : "text-down",
                )}
              >
                {t.side.toUpperCase()}
              </td>
              <td className="!text-left text-muted">
                {new Date(t.entryTime * 1000).toLocaleDateString()}
              </td>
              <td>{fmt.price(t.entryPrice, t.entryPrice < 1 ? 8 : t.entryPrice < 100 ? 4 : 2)}</td>
              <td className="!text-left text-muted">
                {new Date(t.exitTime * 1000).toLocaleDateString()}
              </td>
              <td>{fmt.price(t.exitPrice, t.exitPrice < 1 ? 8 : t.exitPrice < 100 ? 4 : 2)}</td>
              <td className="text-muted">
                {t.qty.toLocaleString("en-US", { maximumFractionDigits: 12 })}
              </td>
              <td className={t.pnl >= 0 ? "text-up" : "text-down"}>{fmt.money(t.pnl)}</td>
              <td className={t.pnl >= 0 ? "text-up" : "text-down"}>{fmt.pct(t.pnlPct)}</td>
              <td className="text-faint">{t.reason}</td>
            </tr>
          ))}
          {!r.trades.length && (
            <tr>
              <td colSpan={10} className="p-6 text-center font-sans text-muted">
                The strategy produced no trades on this data. Loosen the entry conditions or try
                another symbol.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
function Monthly({ r }: { r: BacktestResult }) {
  const years = useMemo(() => [...new Set(r.monthly.map((m) => m.y))], [r]);
  const max = Math.max(1, ...r.monthly.map((m) => Math.abs(m.r)));
  return (
    <div className="max-w-full overflow-x-auto p-3">
      <div className="grid min-w-[640px] grid-cols-[48px_repeat(12,1fr)_60px] gap-1 text-[10.5px]">
        <span />
        {MONTHS.map((m, i) => (
          <span key={i} className="text-center text-faint">
            {m}
          </span>
        ))}
        <span className="text-right text-faint">Year</span>
        {years.map((y) => {
          const ms = r.monthly.filter((m) => m.y === y);
          const yr = (ms.reduce((a, m) => a * (1 + m.r / 100), 1) - 1) * 100;
          return [
            <span key={y} className="num self-center text-muted">
              {y}
            </span>,
            ...MONTHS.map((_, i) => {
              const m = ms.find((x) => x.m === i);
              const a = m ? Math.min(1, Math.abs(m.r) / max) : 0;
              return (
                <span
                  key={y + "-" + i}
                  title={m ? `${fmt.pct(m.r)}` : ""}
                  className="num grid h-7 place-items-center rounded text-[10px]"
                  style={{
                    background: m
                      ? `color-mix(in srgb, ${m.r >= 0 ? "var(--up)" : "var(--down)"} ${8 + a * 55}%, transparent)`
                      : "var(--panel-2)",
                    color: m ? "var(--text)" : "transparent",
                  }}
                >
                  {m ? m.r.toFixed(1) : ""}
                </span>
              );
            }),
            <span
              key={y + "y"}
              className={cx(
                "num self-center text-right font-semibold",
                yr >= 0 ? "text-up" : "text-down",
              )}
            >
              {fmt.pct(yr)}
            </span>,
          ];
        })}
      </div>
    </div>
  );
}
