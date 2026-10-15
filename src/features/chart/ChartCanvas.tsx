import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type SeriesType,
  type Time,
} from "lightweight-charts";
import type { PineRunResult } from "../../pine/runtime";
import type { Bar, ChartState, Drawing, Signal } from "../../core/types";
import {
  getBars,
  subscribeTicks,
  isDemoData,
  dataPineOptions,
  marketSeries,
  marketRequest,
  loadMarketHistory,
  loadOlderHistory,
} from "../../data/feed";
import { historyPresentation, prependedBarCount } from "../../data/history";
import { useTick } from "../../ui/hooks";
import { useAccount } from "../../service/account";
import { defaultInputs, getIndicator, type IndicatorOutput } from "../../indicators/registry";
import { runPineInWorker } from "../../pine/client";
import { demoPineOptions } from "../../pine/demo";
import { prepareChartPine } from "../../service/pineData";
import { drawPineVisuals } from "./pineDrawing";
import { pinePaneVisible } from "./pineDisplay";
import { useApp, useBacktests, useCharts, useScripts } from "../../store";
import { crosshairBus, cssVar, chartControls } from "./bus";
import { drawAll, hitTest, xToTime, yToPrice, type Viewport } from "./drawing";
import { uid } from "../../builder/model";
import { cx } from "../../ui/primitives";

export interface LegendEntry {
  indId: string;
  outputs: { title: string; color: string; data: (number | null)[] }[];
  error?: string;
}

const EMPTY: Drawing[] = [];
const t = (x: number) => x as Time;

export default function ChartCanvas({
  state,
  onLegend,
  onHover,
  authoritative,
}: {
  state: ChartState;
  onLegend: (l: LegendEntry[]) => void;
  onHover: (i: number | null) => void;
  authoritative?: { bars: Bar[]; result?: PineRunResult };
}) {
  const el = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const indRef = useRef<
    {
      s: ISeriesApi<SeriesType>;
      indId: string;
      oi: number;
      builtin: boolean;
    }[]
  >([]);
  const barsRef = useRef<Bar[]>([]);
  const rendered = useRef({ count: 0, revision: 0 });
  const rangeKey = useRef("");
  const [mainVersion, setMainVersion] = useState(0);
  const [pineSignals, setPineSignals] = useState<Signal[]>([]);
  const [pineRevision, setPineRevision] = useState(0);
  const tickCount = useRef(0);
  const pineComputing = useRef(0);
  const pineVisuals = useRef<
    {
      id: string;
      overlay: boolean;
      plots: Record<string, any>;
    }[]
  >([]);
  const theme = useApp((s) => s.theme);
  const account = useAccount((s) => s.data);
  const tool = useApp((s) => s.tool);
  const setTool = useApp((s) => s.setTool);
  const drawings = useCharts((s) => s.drawings[state.symbol]) ?? EMPTY;
  const addDrawing = useCharts((s) => s.addDrawing);
  const removeDrawing = useCharts((s) => s.removeDrawing);
  const scripts = useScripts((s) => s.scripts);
  const localBt = useBacktests((s) =>
    state.backtestId ? s.results.find((r) => r.id === state.backtestId) : undefined,
  );
  const bt = authoritative?.result?.backtest
    ? { ...authoritative.result.backtest, symbol: state.symbol, tf: state.tf }
    : authoritative
      ? undefined
      : localBt;
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Drawing | null>(null);
  const [textAt, setTextAt] = useState<{
    x: number;
    y: number;
    t: number;
    p: number;
  } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const drawRef = useRef({ drawings, draft, selected });
  drawRef.current = {
    drawings: drawings.filter((d) => !d.hidden),
    draft,
    selected,
  };
  useTick();
  const history = marketSeries(state.symbol, state.tf);
  const historyState = historyPresentation(history);
  const showHistory = !authoritative && !isDemoData();

  const pineSources = useMemo(
    () =>
      state.indicators
        .filter((i) => i.kind === "pine")
        .map((i) => {
          const s = scripts.find((s) => s.id === i.type);
          return (s?.source ?? "") + JSON.stringify(s?.inputs ?? {});
        })
        .join("\u0000"),
    [scripts, state.indicators],
  );

  /* create chart */
  useEffect(() => {
    const chart = createChart(el.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        fontFamily: getComputedStyle(document.body).fontFamily,
        fontSize: 11,
        attributionLogo: false,
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.16, bottom: 0.22 },
      },
      timeScale: {
        borderVisible: false,
        rightOffset: 6,
        barSpacing: 7,
        timeVisible: true,
      },
    });
    chartRef.current = chart;
    chartControls.set(state.id, {
      fit: () => chart.timeScale().fitContent(),
      focus: (time) => {
        const index = barsRef.current.findIndex((b) => b.time >= time);
        if (index >= 0)
          chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, index - 30),
            to: index + 30,
          });
      },
      screenshot: () => {
        const shot = chart.takeScreenshot();
        const overlay = canvasRef.current;
        if (overlay) shot.getContext("2d")?.drawImage(overlay, 0, 0, shot.width, shot.height);
        const a = document.createElement("a");
        a.download = `${stateRef.current.symbol}-${stateRef.current.tf}.png`;
        a.href = shot.toDataURL("image/png");
        a.click();
      },
    });
    chart.subscribeCrosshairMove((param) => {
      const logical = param.logical ?? null;
      onHover(param.point && logical !== null ? Math.round(logical) : null);
      const s = stateRef.current;
      if (param.sourceEvent && s.group)
        crosshairBus.emit({
          source: s.id,
          group: s.group,
          tf: s.tf,
          time: param.time ? Number(param.time) : null,
        });
    });
    const offBus = crosshairBus.on((e) => {
      const s = stateRef.current;
      if (e.source === s.id || e.group !== s.group || e.tf !== s.tf || !mainRef.current) return;
      if (e.time === null) return chart.clearCrosshairPosition();
      const b = barsRef.current.find((x) => x.time === e.time);
      if (b) chart.setCrosshairPosition(b.close, t(b.time), mainRef.current);
    });
    chart.subscribeClick((param) => {
      if (!param.point || !mainRef.current) return;
      const v: Viewport = {
        chart,
        series: mainRef.current,
        bars: barsRef.current,
      };
      setSelected(hitTest(v, drawRef.current.drawings, param.point.x, param.point.y));
    });
    const loadVisibleHistory = (range: { from: number; to: number } | null) => {
      const s = stateRef.current;
      if (!range || range.from > 20 || s.replayCursor != null || authoritative || isDemoData())
        return;
      const entry = marketSeries(s.symbol, s.tf);
      if (
        entry.loadedAt &&
        entry.hasMore &&
        !entry.loading &&
        !entry.loadingOlder &&
        !entry.olderError
      )
        void loadOlderHistory(s.symbol, s.tf).catch(() => {});
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(loadVisibleHistory);
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(loadVisibleHistory);
      offBus();
      chartControls.delete(state.id);
      chart.remove();
      chartRef.current = null;
      mainRef.current = null;
      volRef.current = null;
      markersRef.current = null;
      indRef.current = [];
    };
  }, []);

  /* theme */
  useEffect(() => {
    const chart = chartRef.current!;
    chart.applyOptions({
      layout: {
        textColor: cssVar("--muted"),
        panes: {
          separatorColor: cssVar("--line-2"),
          separatorHoverColor: cssVar("--accent"),
        },
      },
      grid: {
        vertLines: { color: cssVar("--grid") },
        horzLines: { color: cssVar("--grid") },
      },
      crosshair: {
        vertLine: {
          color: cssVar("--faint"),
          labelBackgroundColor: cssVar("--panel-3"),
          style: LineStyle.Dashed,
        },
        horzLine: {
          color: cssVar("--faint"),
          labelBackgroundColor: cssVar("--panel-3"),
          style: LineStyle.Dashed,
        },
      },
    });
  }, [theme]);
  useEffect(() => {
    chartRef.current?.priceScale("right").applyOptions({
      mode: state.scale === "log" ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }, [state.scale]);

  /* main + volume series */
  useEffect(() => {
    const chart = chartRef.current!;
    if (mainRef.current) chart.removeSeries(mainRef.current);
    if (volRef.current) chart.removeSeries(volRef.current);
    const up = cssVar("--up");
    const down = cssVar("--down");
    const accent = cssVar("--accent");
    let main: ISeriesApi<SeriesType>;
    if (state.style === "candles")
      main = chart.addSeries(CandlestickSeries, {
        upColor: up,
        downColor: down,
        wickUpColor: up,
        wickDownColor: down,
        borderVisible: false,
      });
    else if (state.style === "bars")
      main = chart.addSeries(BarSeries, {
        upColor: up,
        downColor: down,
        thinBars: false,
      });
    else if (state.style === "line")
      main = chart.addSeries(LineSeries, { color: accent, lineWidth: 2 });
    else
      main = chart.addSeries(AreaSeries, {
        lineColor: accent,
        topColor: accent + "55",
        bottomColor: accent + "00",
        lineWidth: 2,
      });
    const vol = chart.addSeries(HistogramSeries, {
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const all = authoritative?.bars ?? getBars(state.symbol, state.tf);
    const bars =
      !authoritative && state.replayCursor != null ? all.slice(0, state.replayCursor) : all;
    barsRef.current = bars;
    rendered.current = {
      count: bars.length,
      revision: marketSeries(state.symbol, state.tf).revision,
    };
    const ohlc = state.style === "candles" || state.style === "bars";
    main.setData(
      bars.map((b) => (ohlc ? { ...b, time: t(b.time) } : { time: t(b.time), value: b.close })),
    );
    vol.setData(
      bars.map((b) =>
        Number.isFinite(b.volume)
          ? {
              time: t(b.time),
              value: b.volume,
              color: (b.close >= b.open ? up : down) + "40",
            }
          : { time: t(b.time) },
      ),
    );
    mainRef.current = main;
    volRef.current = vol;
    markersRef.current = createSeriesMarkers(main, []);
    const key = state.symbol + state.tf + (state.replayCursor == null ? "live" : "replay");
    if (rangeKey.current !== key || state.replayCursor != null) {
      chart.timeScale().setVisibleLogicalRange({
        from: bars.length - 170,
        to: bars.length + 6,
      });
      rangeKey.current = key;
    }
    setMainVersion((v) => v + 1);
  }, [state.symbol, state.tf, state.style, state.replayCursor, theme, authoritative?.bars]);

  useEffect(() => {
    const main = mainRef.current;
    if (!main || authoritative || isDemoData() || state.replayCursor != null) return;
    const request = marketRequest(state.symbol, state.tf),
      levels: { price: number; title: string; color: string }[] = [];
    for (const position of account?.positions ?? [])
      if (position.provider === request.provider && position.symbol === request.symbol)
        levels.push({
          price: position.avg,
          title: `Local position ${position.qty}`,
          color: cssVar("--accent"),
        });
    for (const order of account?.orders ?? [])
      if (
        order.provider === request.provider &&
        order.symbol === request.symbol &&
        ["working", "triggered"].includes(order.status)
      ) {
        if (order.price)
          levels.push({
            price: order.price,
            title: `${order.side} ${order.qty} limit · ${order.id.slice(0, 6)}`,
            color: cssVar(order.side === "buy" ? "--up" : "--down"),
          });
        if (order.stopPrice)
          levels.push({
            price: order.stopPrice,
            title: `${order.side} ${order.qty} stop · ${order.id.slice(0, 6)}`,
            color: cssVar("--demo"),
          });
      }
    const lines = levels
      .filter((l) => Number.isFinite(l.price))
      .map((l) =>
        main.createPriceLine({
          ...l,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
        }),
      );
    return () => {
      for (const line of lines)
        try {
          main.removePriceLine(line);
        } catch {}
    };
  }, [account, state.symbol, state.tf, state.replayCursor, mainVersion, authoritative, theme]);

  /* indicators */
  useEffect(() => {
    const chart = chartRef.current!;
    let cancelled = false;
    const abort = new AbortController();
    const bars = barsRef.current;
    if (!bars.length) {
      onLegend([]);
      setPineSignals([]);
      pineVisuals.current = [];
      for (const item of indRef.current) {
        try {
          chart.removeSeries(item.s);
        } catch {}
      }
      indRef.current = [];
      return;
    }
    pineComputing.current++;
    (async () => {
      type Built = {
        indId: string;
        overlay: boolean;
        outputs: IndicatorOutput[];
        builtin: boolean;
        levels?: number[];
        error?: string;
        signals?: Signal[];
        visuals?: Record<string, any>;
      };
      const built: Built[] = [];
      if (authoritative?.result) {
        const res = authoritative.result;
        built.push({
          indId: "server-result",
          overlay: res.overlay,
          builtin: false,
          visuals: res.visuals,
          signals: res.kind === "strategy" ? res.signals : undefined,
          outputs: res.plots
            .filter((p) => !p.shape && pinePaneVisible(p.display))
            .map((p) => ({
              title: p.title,
              kind: /histogram|columns/.test(p.style ?? "")
                ? "histogram"
                : /area/.test(p.style ?? "")
                  ? "area"
                  : "line",
              color: p.color,
              colors: p.colors,
              data: p.data,
              width: p.width,
              stepped: p.style === "stepline",
            })),
        });
      }
      for (const ind of authoritative ? [] : state.indicators) {
        if (ind.kind === "builtin") {
          const def = getIndicator(ind.type);
          if (!def) {
            built.push({
              indId: ind.id,
              overlay: true,
              outputs: [],
              builtin: true,
              error: "Indicator unavailable (plugin disabled?)",
            });
            continue;
          }
          built.push({
            indId: ind.id,
            overlay: def.overlay,
            outputs: ind.visible ? def.compute(bars, { ...defaultInputs(def), ...ind.inputs }) : [],
            builtin: true,
            levels: def.levels,
          });
        } else {
          const script = scripts.find((s) => s.id === ind.type);
          if (!script) {
            built.push({
              indId: ind.id,
              overlay: true,
              outputs: [],
              builtin: false,
              error: "Script was deleted",
            });
            continue;
          }
          if (!ind.visible) {
            built.push({
              indId: ind.id,
              overlay: true,
              outputs: [],
              builtin: false,
            });
            continue;
          }
          let options = isDemoData()
            ? demoPineOptions(state.symbol, state.tf, {
                ...script.inputs,
                ...ind.inputs,
              })
            : dataPineOptions(state.symbol, state.tf, {
                ...script.inputs,
                ...ind.inputs,
              });
          if (!isDemoData())
            try {
              options = await prepareChartPine(script.source, state.symbol, state.tf, {
                ...script.inputs,
                ...ind.inputs,
              });
            } catch (error) {
              built.push({
                indId: ind.id,
                overlay: true,
                outputs: [],
                builtin: false,
                error: String(error),
              });
              continue;
            }
          if (state.replayCursor != null && options.datasets) {
            const end = bars.at(-1)?.closeTime ?? bars.at(-1)?.time ?? 0;
            options.datasets = options.datasets
              .map((d) => ({
                ...d,
                bars: d.bars.filter((b) => (b.closeTime ?? b.time) <= end),
              }))
              .filter((d) => d.bars.length);
          }
          const res = await runPineInWorker(script.source, bars, state.tf, options, abort.signal);
          if (cancelled) return;
          if (!res.ok) {
            built.push({
              indId: ind.id,
              overlay: true,
              outputs: [],
              builtin: false,
              error: res.error?.message,
            });
            continue;
          }
          built.push({
            indId: ind.id,
            overlay: res.overlay,
            builtin: false,
            visuals: res.visuals,
            signals: res.kind === "strategy" ? res.signals : undefined,
            outputs: ind.visible
              ? res.plots
                  .filter((p) => !p.shape && pinePaneVisible(p.display))
                  .map((p) => ({
                    title: p.title,
                    kind: /histogram|columns/.test(p.style ?? "")
                      ? "histogram"
                      : /area/.test(p.style ?? "")
                        ? "area"
                        : "line",
                    color: p.color,
                    colors: p.colors,
                    data: p.data,
                    width: p.width,
                    stepped: p.style === "stepline",
                  }))
              : [],
          });
        }
      }
      if (cancelled || !chartRef.current) return;
      for (const r of indRef.current) chart.removeSeries(r.s);
      indRef.current = [];
      while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);
      let pane = 1;
      const up = cssVar("--up");
      const down = cssVar("--down");
      for (const b of built) {
        if (!b.outputs.length) continue;
        const pi = b.overlay ? 0 : pane++;
        b.outputs.forEach((o, oi) => {
          const common = {
            priceLineVisible: false,
            lastValueVisible: !b.overlay || oi === 0,
            title: "",
          };
          let s: ISeriesApi<SeriesType>;
          if (o.kind === "histogram") s = chart.addSeries(HistogramSeries, { ...common }, pi);
          else if (o.kind === "area")
            s = chart.addSeries(
              AreaSeries,
              {
                ...common,
                lineColor: o.color,
                topColor: o.color,
                bottomColor: "transparent",
                lineWidth: 1,
              },
              pi,
            );
          else
            s = chart.addSeries(
              LineSeries,
              {
                ...common,
                color: o.color,
                lineWidth: Math.max(1, Math.min(4, o.width ?? 2)) as 1 | 2,
                lineType: o.stepped ? LineType.WithSteps : LineType.Simple,
                lineStyle: o.dashed ? LineStyle.Dashed : LineStyle.Solid,
                crosshairMarkerRadius: 3,
              },
              pi,
            );
          s.setData(
            o.data.map((v, i) =>
              v === null || !Number.isFinite(v)
                ? { time: t(bars[i].time) }
                : o.kind === "histogram"
                  ? {
                      time: t(bars[i].time),
                      value: v,
                      color: o.colors?.[i] ?? (b.builtin ? (v >= 0 ? up : down) + "aa" : o.color),
                    }
                  : { time: t(bars[i].time), value: v, color: o.colors?.[i] },
            ),
          );
          if (oi === 0 && b.levels)
            for (const lv of b.levels)
              s.createPriceLine({
                price: lv,
                color: cssVar("--faint"),
                lineStyle: LineStyle.Dotted,
                lineWidth: 1,
                axisLabelVisible: false,
                title: "",
              });
          indRef.current.push({ s, indId: b.indId, oi, builtin: b.builtin });
        });
      }
      const panes = chart.panes();
      const total = el.current?.clientHeight ?? 400;
      const sub = Math.max(70, Math.min(130, total * 0.2));
      panes.slice(1).forEach((p) => p.setHeight(sub));
      setPineSignals(built.flatMap((b) => b.signals ?? []));
      pineVisuals.current = built
        .filter((b) => b.visuals)
        .map((b) => ({ id: b.indId, overlay: b.overlay, plots: b.visuals! }));
      onLegend(
        built.map((b) => ({
          indId: b.indId,
          error: b.error,
          outputs: b.outputs.map((o) => ({
            title: o.title,
            color: o.color,
            data: o.data,
          })),
        })),
      );
    })()
      .catch((error: Error) => {
        if (!cancelled)
          onLegend(
            state.indicators.map((i) => ({
              indId: i.id,
              outputs: [],
              error: error.message,
            })),
          );
      })
      .finally(() => {
        pineComputing.current--;
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [
    state.symbol,
    state.tf,
    state.replayCursor,
    state.indicators,
    pineSources,
    mainVersion,
    pineRevision,
    authoritative?.result,
  ]);

  /* trade markers */
  useEffect(() => {
    const bars = barsRef.current;
    const m: SeriesMarker<Time>[] = [];
    const up = cssVar("--up");
    const down = cssVar("--down");
    if (bt && bt.symbol === state.symbol && bt.tf === state.tf) {
      for (const tr of bt.trades) {
        m.push({
          time: t(tr.entryTime),
          position: tr.side === "long" ? "belowBar" : "aboveBar",
          shape: tr.side === "long" ? "arrowUp" : "arrowDown",
          color: cssVar("--accent"),
          text: tr.side === "long" ? "L" : "S",
          size: 1,
        });
        m.push({
          time: t(tr.exitTime),
          position: tr.side === "long" ? "aboveBar" : "belowBar",
          shape: "circle",
          color: tr.pnl >= 0 ? up : down,
          text: `${tr.pnlPct >= 0 ? "+" : ""}${tr.pnlPct.toFixed(1)}%`,
          size: 0.6,
        });
      }
    } else {
      for (const s of pineSignals) {
        const b = bars[s.bar];
        if (!b) continue;
        m.push(
          s.action === "flat"
            ? {
                time: t(b.time),
                position: "aboveBar",
                shape: "circle",
                color: cssVar("--muted"),
                size: 0.5,
              }
            : {
                time: t(b.time),
                position: s.action === "long" ? "belowBar" : "aboveBar",
                shape: s.action === "long" ? "arrowUp" : "arrowDown",
                color: cssVar("--accent"),
                size: 0.8,
              },
        );
      }
    }
    m.sort((a, b) => Number(a.time) - Number(b.time));
    markersRef.current?.setMarkers(m);
  }, [bt, pineSignals, mainVersion, state.symbol, state.tf]);

  /* live ticks */
  useEffect(
    () =>
      authoritative
        ? undefined
        : subscribeTicks(() => {
            if (stateRef.current.replayCursor != null) return;
            if (
              ++tickCount.current % 5 === 0 &&
              pineComputing.current === 0 &&
              stateRef.current.indicators.some((i) => i.kind === "pine" && i.visible)
            )
              setPineRevision((v) => v + 1);
            const s = stateRef.current;
            const bars = getBars(s.symbol, s.tf);
            const main = mainRef.current;
            if (!main || !bars.length) return;
            const rev = marketSeries(s.symbol, s.tf).revision;
            const instrument = marketSeries(s.symbol, s.tf).identity;
            if (instrument?.tickSize && instrument.pricePrecision != null)
              main.applyOptions({
                priceFormat: {
                  type: "price",
                  precision: instrument.pricePrecision,
                  minMove: instrument.tickSize,
                },
              });
            if (
              barsRef.current !== bars ||
              rendered.current.count !== bars.length ||
              rendered.current.revision !== rev
            ) {
              const firstLoad = rendered.current.count === 0;
              const firstTime = barsRef.current[0]?.time;
              const visible = chartRef.current?.timeScale().getVisibleLogicalRange();
              const addedBefore = prependedBarCount(firstTime, bars);
              barsRef.current = bars;
              rendered.current = { count: bars.length, revision: rev };
              main.setData(
                bars.map((b) =>
                  s.style === "candles" || s.style === "bars"
                    ? { ...b, time: t(b.time) }
                    : { time: t(b.time), value: b.close },
                ),
              );
              volRef.current?.setData(
                bars.map((b) =>
                  Number.isFinite(b.volume)
                    ? {
                        time: t(b.time),
                        value: b.volume,
                        color: (b.close >= b.open ? cssVar("--up") : cssVar("--down")) + "40",
                      }
                    : { time: t(b.time) },
                ),
              );
              if (firstLoad)
                chartRef.current?.timeScale().setVisibleLogicalRange({
                  from: Math.max(0, bars.length - 170),
                  to: bars.length + 6,
                });
              else if (addedBefore > 0 && visible)
                chartRef.current?.timeScale().setVisibleLogicalRange({
                  from: visible.from + addedBefore,
                  to: visible.to + addedBefore,
                });
              setMainVersion((v) => v + 1);
            }
            const last = bars[bars.length - 1];
            main.update(
              s.style === "candles" || s.style === "bars"
                ? { ...last, time: t(last.time) }
                : { time: t(last.time), value: last.close },
            );
            volRef.current?.update(
              Number.isFinite(last.volume)
                ? {
                    time: t(last.time),
                    value: last.volume,
                    color: (last.close >= last.open ? cssVar("--up") : cssVar("--down")) + "40",
                  }
                : { time: t(last.time) },
            );
            const byInd = new Map<string, IndicatorOutput[]>();
            for (const r of indRef.current) {
              if (!r.builtin) continue;
              let outs = byInd.get(r.indId);
              if (!outs) {
                const inst = s.indicators.find((i) => i.id === r.indId);
                const def = inst && getIndicator(inst.type);
                if (!def || !inst) continue;
                outs = def.compute(bars, {
                  ...defaultInputs(def),
                  ...inst.inputs,
                });
                byInd.set(r.indId, outs);
              }
              const v = outs[r.oi]?.data.at(-1);
              if (v !== null && v !== undefined && Number.isFinite(v))
                r.s.update(
                  outs[r.oi].kind === "histogram"
                    ? {
                        time: t(last.time),
                        value: v,
                        color: (v >= 0 ? cssVar("--up") : cssVar("--down")) + "aa",
                      }
                    : { time: t(last.time), value: v },
                );
            }
          }),
    [authoritative],
  );

  /* drawing overlay render loop */
  useEffect(() => {
    let raf = 0;
    const c = canvasRef.current!;
    const ctx = c.getContext("2d")!;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const chart = chartRef.current;
      const main = mainRef.current;
      if (!chart || !main || document.hidden) return;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const { drawings, draft, selected } = drawRef.current;
      if (!drawings.length && !draft && !pineVisuals.current.length) {
        ctx.clearRect(0, 0, w, h);
        return;
      }
      const plotW = w - (chart.priceScale("right").width() || 0);
      drawAll(ctx, { chart, series: main, bars: barsRef.current }, drawings, {
        width: plotW,
        height: h,
        accent: cssVar("--accent"),
        text: cssVar("--text"),
        muted: cssVar("--muted"),
        selected,
        draft,
      });
      for (const visual of pineVisuals.current) {
        const series = visual.overlay
          ? main
          : (indRef.current.find((r) => r.indId === visual.id)?.s ?? main);
        const pane = series.getPane();
        const paneIndex = chart.panes().indexOf(pane);
        const top = chart
          .panes()
          .slice(0, Math.max(0, paneIndex))
          .reduce((sum, p) => sum + p.getHeight(), 0);
        drawPineVisuals(
          ctx,
          { chart, series, bars: barsRef.current },
          visual.plots,
          plotW,
          pane.getHeight(),
          top,
        );
      }
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);

  /* delete selected drawing */
  useEffect(() => {
    if (!selected) return;
    const k = (e: KeyboardEvent) => {
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        !(e.target as HTMLElement).closest("input,textarea,.cm-editor")
      ) {
        removeDrawing(state.symbol, selected);
        setSelected(null);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [selected, state.symbol]);

  useEffect(() => {
    if (tool === "cursor") setDraft(null);
  }, [tool]);

  const toPoint = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const v: Viewport = {
      chart: chartRef.current!,
      series: mainRef.current!,
      bars: barsRef.current,
    };
    const tt = xToTime(v, x);
    const p = yToPrice(v, y);
    return tt === null || p === null ? null : { x, y, t: tt, p };
  };
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const commit = (d: Drawing) => {
    addDrawing(state.symbol, d);
    setDraft(null);
    setSelected(d.id);
    setTool("cursor");
  };
  const onDown = (e: React.PointerEvent) => {
    if (tool === "cursor") return;
    const pt = toPoint(e);
    if (!pt) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === "hline") return commit({ id: uid("d"), tool, points: [{ t: pt.t, p: pt.p }] });
    if (tool === "text") return setTextAt(pt);
    if (draft)
      return commit({
        ...draft,
        points: [draft.points[0], { t: pt.t, p: pt.p }],
      });
    downAt.current = { x: pt.x, y: pt.y };
    setDraft({
      id: uid("d"),
      tool,
      points: [
        { t: pt.t, p: pt.p },
        { t: pt.t, p: pt.p },
      ],
    });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!draft) return;
    const pt = toPoint(e);
    if (pt) setDraft({ ...draft, points: [draft.points[0], { t: pt.t, p: pt.p }] });
  };
  const onUp = (e: React.PointerEvent) => {
    if (!draft || !downAt.current) return;
    const pt = toPoint(e);
    if (pt && Math.hypot(pt.x - downAt.current.x, pt.y - downAt.current.y) > 6)
      commit({ ...draft, points: [draft.points[0], { t: pt.t, p: pt.p }] });
    downAt.current = null;
  };

  return (
    <div
      className="absolute inset-0"
      data-history-state={showHistory ? historyState : "ready"}
      onDoubleClick={(e) => {
        if (tool !== "cursor" || (e.target as HTMLElement).tagName === "INPUT") return;
        const n = barsRef.current.length;
        chartRef.current?.timeScale().setVisibleLogicalRange({ from: n - 170, to: n + 6 });
      }}
    >
      <div ref={el} className="absolute inset-0" />
      {showHistory && !history.bars.length && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-panel/85 px-5 text-center"
          role="status"
          aria-live="polite"
        >
          <div className="max-w-sm space-y-2 text-xs">
            <div className="font-medium text-text">
              {historyState === "loading"
                ? `Loading ${state.symbol.split(":").at(-1)} · ${state.tf}…`
                : historyState === "error"
                  ? "History could not be loaded"
                  : "No bars in this range"}
            </div>
            <p className="break-words text-muted">
              {historyState === "loading"
                ? "Fetching history from your data source. Indicators will start when it is ready."
                : history.error ||
                  history.coverageReason ||
                  "Try an earlier trading day, another interval, or a different data source."}
            </p>
            {historyState !== "loading" && history.hasMore && (
              <button
                disabled={history.loadingOlder}
                className="mr-2 rounded-md border border-line px-3 py-2 hover:bg-panel-2 disabled:opacity-50"
                onClick={() => void loadOlderHistory(state.symbol, state.tf).catch(() => {})}
              >
                {history.loadingOlder ? "Loading earlier history…" : "Load earlier history"}
              </button>
            )}
            {history.olderError && <p className="text-demo">{history.olderError}</p>}
            {historyState !== "loading" && (
              <button
                className="rounded-md border border-line px-3 py-2 hover:bg-panel-2"
                onClick={() =>
                  void loadMarketHistory(state.symbol, state.tf, undefined, { force: true }).catch(
                    () => {},
                  )
                }
              >
                Retry history
              </button>
            )}
          </div>
        </div>
      )}
      {showHistory && history.bars.length > 0 && (
        <div
          className="absolute bottom-7 left-2 z-10 flex max-w-[calc(100%-5rem)] items-center gap-2 rounded-md bg-panel/90 px-2 py-1 text-[11px] text-muted"
          role="status"
        >
          {history.loadingOlder ? (
            "Loading earlier history…"
          ) : history.olderError ? (
            <button
              title={history.olderError}
              className="text-demo underline"
              onClick={() => void loadOlderHistory(state.symbol, state.tf).catch(() => {})}
            >
              Earlier history unavailable · Retry
            </button>
          ) : history.loading ? (
            "Refreshing history…"
          ) : history.error ? (
            <button
              title={history.error}
              className="text-demo underline"
              onClick={() =>
                void loadMarketHistory(state.symbol, state.tf, undefined, { force: true }).catch(
                  () => {},
                )
              }
            >
              Showing cached history · Retry
            </button>
          ) : history.hasMore ? (
            <button
              className="hover:text-text"
              onClick={() => void loadOlderHistory(state.symbol, state.tf).catch(() => {})}
            >
              ← Load earlier history
            </button>
          ) : (
            <span title={history.coverageReason}>
              History from {new Date(history.bars[0].time * 1000).toISOString().slice(0, 10)}
            </span>
          )}
        </div>
      )}
      <canvas
        ref={canvasRef}
        className={cx(
          "absolute inset-0 h-full w-full",
          tool === "cursor" ? "pointer-events-none" : "cursor-crosshair",
        )}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      />
      {textAt && (
        <input
          autoFocus
          placeholder="Label…"
          className="glass absolute z-10 h-7 w-40 rounded-md px-2 text-[12px] text-text outline-none"
          style={{ left: textAt.x, top: textAt.y - 14 }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.currentTarget.value.trim()) {
              commit({
                id: uid("d"),
                tool: "text",
                points: [{ t: textAt.t, p: textAt.p }],
                text: e.currentTarget.value.trim(),
              });
              setTextAt(null);
            }
            if (e.key === "Escape") {
              setTextAt(null);
              setTool("cursor");
            }
          }}
          onBlur={() => setTextAt(null)}
        />
      )}
      {selected && (
        <button
          onClick={() => {
            removeDrawing(state.symbol, selected);
            setSelected(null);
          }}
          className="glass absolute bottom-10 left-1/2 z-10 -translate-x-1/2 rounded-full px-3 py-1 text-[11.5px] text-muted hover:text-down"
        >
          Delete drawing <span className="text-faint">· Del</span>
        </button>
      )}
    </div>
  );
}
