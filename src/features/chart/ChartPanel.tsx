import { useState, useSyncExternalStore } from "react";
import {
  Activity,
  BarChart3,
  CandlestickChart,
  ChevronDown,
  Eye,
  EyeOff,
  Link2,
  LineChart,
  MousePointer2,
  Minus,
  Settings2,
  Slash,
  Square,
  Trash2,
  Type,
  X,
  AreaChart,
  FileCode2,
  Search,
  TrendingUp,
  MoreHorizontal,
} from "lucide-react";
import { execute } from "../../core/commands";
import {
  LINK_COLORS,
  LINK_GROUPS,
  TIMEFRAMES,
  type ChartState,
  type DrawingTool,
  type IndicatorInstance,
} from "../../core/types";
import {
  listIndicators,
  subscribeIndicators,
  getIndicator,
  defaultInputs,
} from "../../indicators/registry";
import { parseInputs } from "../../pine/runtime";
import { useApp, useBacktests, useCharts, useScripts } from "../../store";
import { useQuote, useFlash, useTick } from "../../ui/hooks";
import { MarketBadge } from "../../service/MarketPanel";
import { Empty, IconButton, Input, MenuItem, Popover, cx, fmt } from "../../ui/primitives";
import ChartCanvas, { type LegendEntry } from "./ChartCanvas";
import SymbolSearch from "./SymbolSearch";
import ChartTools from "./ChartTools";
import Comparison from "./Comparison";
import ChartTrading from "./ChartTrading";
import { getBars, symbolInfo } from "../../data/feed";

const TOOLS: { id: DrawingTool; icon: typeof Slash; label: string; key?: string }[] = [
  { id: "cursor", icon: MousePointer2, label: "Cursor", key: "Esc" },
  { id: "trend", icon: Slash, label: "Trend line", key: "Alt T" },
  { id: "hline", icon: Minus, label: "Horizontal line", key: "Alt H" },
  { id: "rect", icon: Square, label: "Rectangle" },
  { id: "fib", icon: Activity, label: "Fib retracement", key: "Alt F" },
  { id: "text", icon: Type, label: "Text" },
];

export default function ChartPanel({ chartId }: { chartId: string }) {
  const state = useCharts((s) => s.charts[chartId]);
  const setActive = useApp((s) => s.setActiveChart);
  const isActive = useApp((s) => s.activeChartId === chartId);
  const [legend, setLegend] = useState<LegendEntry[]>([]);
  const [hover, setHover] = useState<number | null>(null);
  if (!state)
    return (
      <Empty title="Chart not found" body="This panel references a chart that no longer exists." />
    );
  return (
    <div
      className="chart-panel @container flex h-full min-w-0 flex-col bg-panel"
      data-chart-id={chartId}
      onPointerDownCapture={() => !isActive && setActive(chartId)}
    >
      <Toolbar state={state} />
      <div className="relative flex min-h-0 flex-1">
        <DrawingRail symbol={state.symbol} />
        <div className="relative min-w-0 flex-1">
          <ChartCanvas state={state} onLegend={setLegend} onHover={setHover} />
          <Legend state={state} legend={legend} hover={hover} />
        </div>
      </div>
      {!!state.comparisons?.length && <Comparison state={state} />}
    </div>
  );
}

function Toolbar({ state }: { state: ChartState }) {
  const run = (id: string, p: Record<string, unknown>) =>
    execute(id, { chartId: state.id, ...p }).catch((e) =>
      useApp.getState().toast({ title: e.message, tone: "error" }),
    );
  return (
    <div className="chart-toolbar flex h-8 min-w-0 shrink-0 items-center gap-0.5 whitespace-nowrap border-b border-line px-1">
      <Popover
        className="w-[340px]"
        trigger={({ toggle }) => (
          <button
            onClick={toggle}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 font-semibold tracking-tight hover:bg-panel-2"
          >
            <Search size={13} className="text-faint" />
            <span title={state.symbol}>{state.symbol.split(":").at(-1)}</span>
          </button>
        )}
      >
        {(close) => (
          <SymbolSearch
            onPick={(s) => {
              run("chart.setSymbol", { symbol: s });
              close();
            }}
          />
        )}
      </Popover>
      {state.replayCursor == null ? (
        <ToolbarQuote symbol={state.symbol} />
      ) : (
        <span className="chart-replay-label px-1 text-[10px] text-demo">Replay</span>
      )}
      <Sep />
      <Popover
        trigger={({ toggle }) => (
          <button
            onClick={toggle}
            title="Interval"
            className="num flex h-7 items-center gap-0.5 rounded-md px-1.5 text-[11.5px] font-medium text-text hover:bg-panel-2 @min-[620px]:hidden"
          >
            {state.tf} <ChevronDown size={11} className="text-faint" />
          </button>
        )}
      >
        {(close) => (
          <div className="w-24">
            {TIMEFRAMES.map((tf) => (
              <MenuItem
                key={tf}
                active={state.tf === tf}
                onClick={() => (run("chart.setTimeframe", { tf }), close())}
              >
                <span className="num">{tf}</span>
              </MenuItem>
            ))}
          </div>
        )}
      </Popover>
      <div className="hidden items-center @min-[620px]:flex">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf}
            onClick={() => run("chart.setTimeframe", { tf })}
            className={cx(
              "num h-7 rounded-md px-1.5 text-[11.5px] font-medium transition-colors",
              state.tf === tf
                ? "bg-panel-3 text-text"
                : "text-muted hover:bg-panel-2 hover:text-text",
            )}
          >
            {tf}
          </button>
        ))}
      </div>
      <div className="chart-secondary-tools flex items-center">
        <Sep />
        <Popover
          trigger={({ toggle }) => (
            <IconButton label="Chart style" onClick={toggle}>
              {state.style === "candles" ? (
                <CandlestickChart size={15} />
              ) : state.style === "bars" ? (
                <BarChart3 size={15} />
              ) : state.style === "line" ? (
                <LineChart size={15} />
              ) : (
                <AreaChart size={15} />
              )}
            </IconButton>
          )}
        >
          {(close) => (
            <div className="w-36">
              {(
                [
                  ["candles", "Candles", CandlestickChart],
                  ["bars", "Bars", BarChart3],
                  ["line", "Line", LineChart],
                  ["area", "Area", AreaChart],
                ] as const
              ).map(([v, l, I]) => (
                <MenuItem
                  key={v}
                  active={state.style === v}
                  onClick={() => (run("chart.setStyle", { style: v }), close())}
                >
                  <I size={14} /> {l}
                </MenuItem>
              ))}
            </div>
          )}
        </Popover>
        <IndicatorPicker state={state} />
      </div>
      <div className="flex-1" />
      <MarketBadge symbol={state.symbol} tf={state.tf} compact />
      <ChartTools state={state} />
      <div className="chart-secondary-tools flex items-center">
        <ChartTrading state={state} />
        <LinkPicker state={state} />
      </div>
      <div className="chart-more-tools">
        <Popover
          align="right"
          className="w-64"
          trigger={({ toggle }) => (
            <IconButton label="More chart actions" onClick={toggle}>
              <MoreHorizontal size={16} />
            </IconButton>
          )}
        >
          <div className="space-y-3 p-2 text-xs">
            <div>
              <p className="mb-2 font-medium">Chart style</p>
              <div className="flex flex-wrap gap-1">
                {(["candles", "bars", "line", "area"] as const).map((style) => (
                  <button
                    key={style}
                    className={cx(
                      "rounded px-2 py-1 capitalize",
                      state.style === style ? "bg-panel-3" : "hover:bg-panel-2",
                    )}
                    onClick={() => run("chart.setStyle", { style })}
                  >
                    {style}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span>Indicators</span>
              <IndicatorPicker state={state} />
            </div>
            <div className="flex items-center justify-between">
              <span>Trading</span>
              <ChartTrading state={state} />
            </div>
            <div className="flex items-center justify-between">
              <span>Link charts</span>
              <LinkPicker state={state} />
            </div>
          </div>
        </Popover>
      </div>
    </div>
  );
}
function ToolbarQuote({ symbol }: { symbol: string }) {
  const q = useQuote(symbol);
  const flash = useFlash(q.last);
  const tone = q.change >= 0 ? "text-up" : "text-down";
  return (
    <span className="chart-quote flex items-baseline gap-1.5 px-1">
      <span
        key={flash.k}
        className={cx(
          "num rounded px-0.5 text-[12.5px] font-semibold",
          tone,
          flash.dir === "up" && "flash-up",
          flash.dir === "down" && "flash-down",
        )}
      >
        {q.format(q.last)}
      </span>
      <span className={cx("chart-change num hidden text-[11px] @min-[620px]:inline", tone)}>
        {fmt.pct(q.changePct)}
      </span>
    </span>
  );
}
const Sep = () => <div className="chart-separator mx-0.5 h-4 w-px bg-line" />;

function IndicatorPicker({ state }: { state: ChartState }) {
  const defs = useSyncExternalStore(subscribeIndicators, listIndicators);
  const scripts = useScripts((s) => s.scripts);
  const [q, setQ] = useState("");
  const add = (id: string) => execute("indicator.add", { indicator: id, chartId: state.id });
  const addPine = (id: string) => execute("pine.addToChart", { scriptId: id, chartId: state.id });
  const ql = q.toLowerCase();
  return (
    <Popover
      className="w-[300px]"
      trigger={({ toggle, open }) => (
        <button
          onClick={toggle}
          title="Indicators & scripts"
          aria-label="Indicators"
          className={cx(
            "flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium",
            open ? "bg-panel-2 text-text" : "text-muted hover:bg-panel-2 hover:text-text",
          )}
        >
          <TrendingUp size={14} /> <span className="hidden @min-[720px]:inline">Indicators</span>
        </button>
      )}
    >
      {(close) => (
        <div>
          <Input
            autoFocus
            placeholder="Search indicators & scripts"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="mb-1.5"
          />
          <div className="max-h-[340px] overflow-auto">
            <div className="px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">
              Built-in
            </div>
            {defs
              .filter((d) => (d.name + d.short).toLowerCase().includes(ql))
              .map((d) => (
                <MenuItem
                  key={d.id}
                  onClick={() => (add(d.id), close())}
                  right={
                    d.pluginId ? (
                      <span className="text-[10px] text-accent">plugin</span>
                    ) : (
                      <span className="text-[10px] text-faint">
                        {d.overlay ? "overlay" : "pane"}
                      </span>
                    )
                  }
                >
                  <span className="num w-10 text-[11px] text-accent">{d.short}</span>
                  <span className="truncate">{d.name}</span>
                </MenuItem>
              ))}
            <div className="px-2 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">
              Pine library
            </div>
            {scripts
              .filter((s) => s.name.toLowerCase().includes(ql))
              .map((s) => (
                <MenuItem
                  key={s.id}
                  onClick={() => (addPine(s.id), close())}
                  right={<span className="text-[10px] text-faint">{s.kind}</span>}
                >
                  <FileCode2 size={13} className="text-accent-2" />
                  <span className="truncate">{s.name}</span>
                </MenuItem>
              ))}
          </div>
        </div>
      )}
    </Popover>
  );
}

function LinkPicker({ state }: { state: ChartState }) {
  const color = state.group ? LINK_COLORS[state.group] : undefined;
  return (
    <Popover
      align="right"
      className="w-48"
      trigger={({ toggle }) => (
        <button
          onClick={toggle}
          title="Link group: sync symbol, interval, crosshair"
          className="flex h-7 items-center gap-1 rounded-md px-1.5 text-muted hover:bg-panel-2"
        >
          <Link2 size={14} style={{ color }} />
          <span
            className="size-2 rounded-full"
            style={{
              background: color ?? "transparent",
              boxShadow: color ? `0 0 8px ${color}` : "inset 0 0 0 1px var(--faint)",
            }}
          />
          <ChevronDown size={12} />
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="px-2 pb-1.5 pt-1 text-[11px] text-muted">
            Linked charts share symbol, interval and crosshair.
          </div>
          {LINK_GROUPS.map((g) => (
            <MenuItem
              key={g}
              active={state.group === g}
              onClick={() => (
                execute("chart.setLinkGroup", { group: g, chartId: state.id }),
                close()
              )}
            >
              <span className="size-2.5 rounded-full" style={{ background: LINK_COLORS[g] }} />
              <span className="capitalize">{g}</span>
            </MenuItem>
          ))}
          <MenuItem
            active={!state.group}
            onClick={() => (
              execute("chart.setLinkGroup", { group: "none", chartId: state.id }),
              close()
            )}
          >
            <span className="size-2.5 rounded-full ring-1 ring-faint" /> Unlinked
          </MenuItem>
        </div>
      )}
    </Popover>
  );
}

function DrawingRail({ symbol }: { symbol: string }) {
  const tool = useApp((s) => s.tool);
  const setTool = useApp((s) => s.setTool);
  const count = useCharts((s) => s.drawings[symbol]?.length ?? 0);
  return (
    <div className="flex w-8 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-line py-1 @max-[300px]:hidden">
      {TOOLS.map((t) => (
        <IconButton
          key={t.id}
          label={`${t.label}${t.key ? ` (${t.key})` : ""}`}
          active={tool === t.id}
          onClick={() => setTool(t.id)}
        >
          <t.icon size={15} />
        </IconButton>
      ))}
      <div className="my-1 h-px w-5 bg-line" />
      <IconButton
        label="Clear drawings"
        disabled={!count}
        onClick={() => useCharts.getState().clearDrawings(symbol)}
      >
        <Trash2 size={14} />
      </IconButton>
    </div>
  );
}

function Legend({
  state,
  legend,
  hover,
}: {
  state: ChartState;
  legend: LegendEntry[];
  hover: number | null;
}) {
  useTick();
  const all = getBars(state.symbol, state.tf);
  const bars = state.replayCursor != null ? all.slice(0, state.replayCursor) : all;
  const i = hover !== null && hover >= 0 && hover < bars.length ? hover : bars.length - 1;
  const b = bars[i];
  const up = b ? b.close >= b.open : false;
  const bt = useBacktests((s) =>
    state.backtestId ? s.results.find((r) => r.id === state.backtestId) : undefined,
  );
  const info = symbolInfo(state.symbol);
  return (
    <div className="pointer-events-none absolute left-2 top-1.5 z-10 flex max-h-[45%] max-w-[calc(100%-84px)] overflow-hidden flex-col gap-1">
      <div className="num flex w-fit max-w-full gap-2 overflow-hidden whitespace-nowrap rounded-md bg-panel/80 px-1.5 py-0.5 text-[11px] text-muted backdrop-blur-sm">
        <span className="hidden text-faint @min-[560px]:inline">
          {info.exchange} · {state.tf}
        </span>
        {(["open", "high", "low", "close"] as const).map((k) => (
          <span key={k} className={k === "close" ? "" : "chart-ohlc-extra"}>
            {k[0].toUpperCase()}{" "}
            <span className={up ? "text-up" : "text-down"}>{fmt.price(b?.[k] ?? Number.NaN)}</span>
          </span>
        ))}
        <span className="hidden @min-[480px]:inline">
          V <span className="text-text/80">{fmt.compact(b?.volume ?? Number.NaN)}</span>
        </span>
      </div>
      {bt && bt.symbol === state.symbol && bt.tf === state.tf && (
        <div className="pointer-events-auto flex w-fit items-center gap-1.5 rounded-md bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent ring-1 ring-inset ring-accent/25">
          Backtest · {bt.name} · {bt.metrics.trades} trades
          <button
            className="text-accent/70 hover:text-accent"
            onClick={() => useCharts.getState().setBacktest(state.id, undefined)}
          >
            <X size={11} />
          </button>
        </div>
      )}
      {!!state.indicators.length && (
        <div className="chart-indicator-summary pointer-events-auto">
          <Popover
            trigger={({ toggle }) => (
              <button onClick={toggle} className="rounded bg-panel/90 px-2 py-0.5 text-[11px]">
                Indicators ({state.indicators.length})
              </button>
            )}
          >
            <div className="space-y-1 p-2">
              {state.indicators.map((ind) => (
                <IndicatorRow
                  key={ind.id}
                  state={state}
                  ind={ind}
                  entry={legend.find((l) => l.indId === ind.id)}
                  index={i}
                />
              ))}
            </div>
          </Popover>
        </div>
      )}
      <div className="chart-indicator-details">
        {state.indicators.map((ind) => (
          <IndicatorRow
            key={ind.id}
            state={state}
            ind={ind}
            entry={legend.find((l) => l.indId === ind.id)}
            index={i}
          />
        ))}
      </div>
    </div>
  );
}

function IndicatorRow({
  state,
  ind,
  entry,
  index,
}: {
  state: ChartState;
  ind: IndicatorInstance;
  entry?: LegendEntry;
  index: number;
}) {
  const update = useCharts((s) => s.updateIndicator);
  const remove = (id: string) =>
    execute("indicator.remove", { indicatorId: id, chartId: state.id });
  const script = useScripts((s) =>
    ind.kind === "pine" ? s.scripts.find((x) => x.id === ind.type) : undefined,
  );
  const def = ind.kind === "builtin" ? getIndicator(ind.type) : undefined;
  const inputs = def
    ? def.inputs.map((i) => ({
        key: i.key,
        label: i.label,
        type: i.type,
        value: ind.inputs[i.key] ?? i.default,
        min: i.min,
        max: i.max,
      }))
    : script
      ? parseInputs(script.source).map((i) => ({
          key: i.name,
          label: i.title,
          type: i.type,
          value: ind.inputs[i.name] ?? script.inputs?.[i.name] ?? i.default,
          min: i.min,
          max: i.max,
        }))
      : [];
  const params = def
    ? def.inputs.map((i) => ind.inputs[i.key] ?? defaultInputs(def)[i.key]).join(", ")
    : inputs.map((i) => i.value).join(", ");
  return (
    <div className="group pointer-events-auto flex w-fit items-center gap-1.5 rounded-md px-1 py-[1px] text-[11.5px] hover:bg-panel-2/90">
      <span className={cx("font-medium", !ind.visible && "text-faint line-through")}>
        {ind.kind === "pine" ? <FileCode2 size={11} className="mr-1 inline text-accent-2" /> : null}
        {ind.name}
      </span>
      {params && <span className="num text-faint">{params}</span>}
      {entry?.error ? (
        <span className="max-w-[260px] truncate text-down" title={entry.error}>
          {entry.error}
        </span>
      ) : (
        ind.visible &&
        entry?.outputs.slice(0, 3).map((o) => {
          const v = o.data[index];
          return (
            <span key={o.title} className="num" style={{ color: o.color }}>
              {v === null || v === undefined
                ? "—"
                : Math.abs(v) >= 1000
                  ? fmt.price(v)
                  : v.toFixed(2)}
            </span>
          );
        })
      )}
      <span className="flex items-center opacity-0 transition-opacity group-hover:opacity-100">
        <button
          className="p-0.5 text-muted hover:text-text"
          onClick={() => update(state.id, ind.id, { visible: !ind.visible })}
          title="Toggle visibility"
        >
          {ind.visible ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
        {inputs.length > 0 && (
          <Popover
            className="w-56"
            trigger={({ toggle }) => (
              <button
                className="p-0.5 text-muted hover:text-text"
                onClick={toggle}
                title="Settings"
              >
                <Settings2 size={12} />
              </button>
            )}
          >
            <div className="flex flex-col gap-2 p-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">
                {ind.name} · inputs
              </div>
              {inputs.map((inp) => (
                <label
                  key={inp.key}
                  className="flex items-center justify-between gap-3 text-[12px]"
                >
                  <span className="text-muted">{inp.label}</span>
                  {inp.type === "bool" ? (
                    <input
                      type="checkbox"
                      checked={Boolean(inp.value)}
                      onChange={(e) =>
                        update(state.id, ind.id, {
                          inputs: { ...ind.inputs, [inp.key]: e.target.checked },
                        })
                      }
                    />
                  ) : (
                    <input
                      type={
                        ["int", "float", "price", "time"].includes(inp.type) ? "number" : "text"
                      }
                      defaultValue={String(inp.value)}
                      min={inp.min}
                      max={inp.max}
                      step={inp.type === "float" ? 0.1 : 1}
                      onBlur={(e) =>
                        update(state.id, ind.id, {
                          inputs: {
                            ...ind.inputs,
                            [inp.key]: ["int", "float", "price", "time"].includes(inp.type)
                              ? Number(e.target.value)
                              : e.target.value,
                          },
                        })
                      }
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                      className="num h-7 w-20 rounded-md border border-line bg-panel-2 px-2 text-right text-[12px] outline-none focus:border-accent/60"
                    />
                  )}
                </label>
              ))}
            </div>
          </Popover>
        )}
        <button
          className="p-0.5 text-muted hover:text-down"
          onClick={() => remove(ind.id)}
          title="Remove"
        >
          <X size={12} />
        </button>
      </span>
    </div>
  );
}
