import { useEffect, useMemo, useRef, useState } from 'react'
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
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type SeriesType,
  type Time,
} from 'lightweight-charts'
import type { Bar, ChartState, Drawing, Signal } from '../../core/types'
import { getBars, subscribeTicks } from '../../data/feed'
import { defaultInputs, getIndicator, type IndicatorOutput } from '../../indicators/registry'
import { applyInputs, runPine, type PineRunResult } from '../../pine/runtime'
import { useApp, useBacktests, useCharts, useScripts } from '../../store'
import { crosshairBus, cssVar } from './bus'
import { drawAll, hitTest, xToTime, yToPrice, type Viewport } from './drawing'
import { uid } from '../../builder/model'
import { cx } from '../../ui/primitives'

export interface LegendEntry {
  indId: string
  outputs: { title: string; color: string; data: (number | null)[] }[]
  error?: string
}

const pineCache = new Map<string, Promise<PineRunResult>>()
function cachedPine(src: string, bars: Bar[], key: string, tf: ChartState['tf']) {
  const k = key + '|' + src
  let p = pineCache.get(k)
  if (!p) {
    p = runPine(src, bars, tf)
    pineCache.set(k, p)
    if (pineCache.size > 60) pineCache.delete(pineCache.keys().next().value as string)
  }
  return p
}

const EMPTY: Drawing[] = []
const t = (x: number) => x as Time

export default function ChartCanvas({ state, onLegend, onHover }: { state: ChartState; onLegend: (l: LegendEntry[]) => void; onHover: (i: number | null) => void }) {
  const el = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const mainRef = useRef<ISeriesApi<SeriesType> | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const indRef = useRef<{ s: ISeriesApi<SeriesType>; indId: string; oi: number; builtin: boolean }[]>([])
  const barsRef = useRef<Bar[]>([])
  const rangeKey = useRef('')
  const [mainVersion, setMainVersion] = useState(0)
  const [pineSignals, setPineSignals] = useState<Signal[]>([])
  const theme = useApp((s) => s.theme)
  const tool = useApp((s) => s.tool)
  const setTool = useApp((s) => s.setTool)
  const drawings = useCharts((s) => s.drawings[state.symbol]) ?? EMPTY
  const addDrawing = useCharts((s) => s.addDrawing)
  const removeDrawing = useCharts((s) => s.removeDrawing)
  const scripts = useScripts((s) => s.scripts)
  const bt = useBacktests((s) => (state.backtestId ? s.results.find((r) => r.id === state.backtestId) : undefined))
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<Drawing | null>(null)
  const [textAt, setTextAt] = useState<{ x: number; y: number; t: number; p: number } | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const drawRef = useRef({ drawings, draft, selected })
  drawRef.current = { drawings, draft, selected }

  const pineSources = useMemo(
    () => state.indicators.filter((i) => i.kind === 'pine').map((i) => scripts.find((s) => s.id === i.type)?.source ?? '').join('\u0000'),
    [scripts, state.indicators],
  )

  /* create chart */
  useEffect(() => {
    const chart = createChart(el.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, fontFamily: 'Geist, sans-serif', fontSize: 11, attributionLogo: false },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.16, bottom: 0.22 } },
      timeScale: { borderVisible: false, rightOffset: 6, barSpacing: 7, timeVisible: true },
    })
    chartRef.current = chart
    chart.subscribeCrosshairMove((param) => {
      const logical = param.logical ?? null
      onHover(param.point && logical !== null ? Math.round(logical) : null)
      const s = stateRef.current
      if (param.sourceEvent && s.group) crosshairBus.emit({ source: s.id, group: s.group, tf: s.tf, time: param.time ? Number(param.time) : null })
    })
    const offBus = crosshairBus.on((e) => {
      const s = stateRef.current
      if (e.source === s.id || e.group !== s.group || e.tf !== s.tf || !mainRef.current) return
      if (e.time === null) return chart.clearCrosshairPosition()
      const b = barsRef.current.find((x) => x.time === e.time)
      if (b) chart.setCrosshairPosition(b.close, t(b.time), mainRef.current)
    })
    chart.subscribeClick((param) => {
      if (!param.point || !mainRef.current) return
      const v: Viewport = { chart, series: mainRef.current, bars: barsRef.current }
      setSelected(hitTest(v, drawRef.current.drawings, param.point.x, param.point.y))
    })
    return () => {
      offBus()
      chart.remove()
      chartRef.current = null
      mainRef.current = null
      volRef.current = null
      markersRef.current = null
      indRef.current = []
    }
  }, [])

  /* theme */
  useEffect(() => {
    const chart = chartRef.current!
    chart.applyOptions({
      layout: { textColor: cssVar('--muted'), panes: { separatorColor: cssVar('--line-2'), separatorHoverColor: cssVar('--accent') } },
      grid: { vertLines: { color: cssVar('--grid') }, horzLines: { color: cssVar('--grid') } },
      crosshair: {
        vertLine: { color: cssVar('--faint'), labelBackgroundColor: cssVar('--panel-3'), style: LineStyle.Dashed },
        horzLine: { color: cssVar('--faint'), labelBackgroundColor: cssVar('--panel-3'), style: LineStyle.Dashed },
      },
    })
  }, [theme])

  /* main + volume series */
  useEffect(() => {
    const chart = chartRef.current!
    if (mainRef.current) chart.removeSeries(mainRef.current)
    if (volRef.current) chart.removeSeries(volRef.current)
    const up = cssVar('--up')
    const down = cssVar('--down')
    const accent = cssVar('--accent')
    let main: ISeriesApi<SeriesType>
    if (state.style === 'candles') main = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false })
    else if (state.style === 'bars') main = chart.addSeries(BarSeries, { upColor: up, downColor: down, thinBars: false })
    else if (state.style === 'line') main = chart.addSeries(LineSeries, { color: accent, lineWidth: 2 })
    else main = chart.addSeries(AreaSeries, { lineColor: accent, topColor: accent + '55', bottomColor: accent + '00', lineWidth: 2 })
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    const bars = getBars(state.symbol, state.tf)
    barsRef.current = bars
    const ohlc = state.style === 'candles' || state.style === 'bars'
    main.setData(bars.map((b) => (ohlc ? { ...b, time: t(b.time) } : { time: t(b.time), value: b.close })))
    vol.setData(bars.map((b) => ({ time: t(b.time), value: b.volume, color: (b.close >= b.open ? up : down) + '40' })))
    mainRef.current = main
    volRef.current = vol
    markersRef.current = createSeriesMarkers(main, [])
    const key = state.symbol + state.tf
    if (rangeKey.current !== key) {
      chart.timeScale().setVisibleLogicalRange({ from: bars.length - 170, to: bars.length + 6 })
      rangeKey.current = key
    }
    setMainVersion((v) => v + 1)
  }, [state.symbol, state.tf, state.style, theme])

  /* indicators */
  useEffect(() => {
    const chart = chartRef.current!
    let cancelled = false
    const bars = barsRef.current
    const key = `${state.symbol}:${state.tf}:${bars.length}:${bars[0]?.time}`
    ;(async () => {
      type Built = { indId: string; overlay: boolean; outputs: IndicatorOutput[]; builtin: boolean; levels?: number[]; error?: string; signals?: Signal[] }
      const built: Built[] = []
      for (const ind of state.indicators) {
        if (ind.kind === 'builtin') {
          const def = getIndicator(ind.type)
          if (!def) {
            built.push({ indId: ind.id, overlay: true, outputs: [], builtin: true, error: 'Indicator unavailable (plugin disabled?)' })
            continue
          }
          built.push({ indId: ind.id, overlay: def.overlay, outputs: ind.visible ? def.compute(bars, { ...defaultInputs(def), ...ind.inputs }) : [], builtin: true, levels: def.levels })
        } else {
          const script = scripts.find((s) => s.id === ind.type)
          if (!script) {
            built.push({ indId: ind.id, overlay: true, outputs: [], builtin: false, error: 'Script was deleted' })
            continue
          }
          const res = await cachedPine(applyInputs(script.source, ind.inputs), bars, key, state.tf)
          if (cancelled) return
          if (!res.ok) {
            built.push({ indId: ind.id, overlay: true, outputs: [], builtin: false, error: res.error?.message })
            continue
          }
          built.push({
            indId: ind.id,
            overlay: res.overlay,
            builtin: false,
            signals: res.kind === 'strategy' ? res.signals : undefined,
            outputs: ind.visible ? res.plots.filter((p) => !p.shape).map((p) => ({ title: p.title, kind: 'line', color: p.color, data: p.data })) : [],
          })
        }
      }
      if (cancelled || !chartRef.current) return
      for (const r of indRef.current) chart.removeSeries(r.s)
      indRef.current = []
      while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1)
      let pane = 1
      const up = cssVar('--up')
      const down = cssVar('--down')
      for (const b of built) {
        if (!b.outputs.length) continue
        const pi = b.overlay ? 0 : pane++
        b.outputs.forEach((o, oi) => {
          const common = { priceLineVisible: false, lastValueVisible: !b.overlay || oi === 0, title: '' }
          let s: ISeriesApi<SeriesType>
          if (o.kind === 'histogram') s = chart.addSeries(HistogramSeries, { ...common }, pi)
          else if (o.kind === 'area') s = chart.addSeries(AreaSeries, { ...common, lineColor: o.color, topColor: o.color + '44', bottomColor: o.color + '00', lineWidth: 1 }, pi)
          else s = chart.addSeries(LineSeries, { ...common, color: o.color, lineWidth: (o.width ?? 2) as 1 | 2, lineStyle: o.dashed ? LineStyle.Dashed : LineStyle.Solid, crosshairMarkerRadius: 3 }, pi)
          s.setData(
            o.data.map((v, i) =>
              v === null || !Number.isFinite(v) ? { time: t(bars[i].time) } : o.kind === 'histogram' ? { time: t(bars[i].time), value: v, color: (v >= 0 ? up : down) + 'aa' } : { time: t(bars[i].time), value: v },
            ),
          )
          if (oi === 0 && b.levels) for (const lv of b.levels) s.createPriceLine({ price: lv, color: cssVar('--faint'), lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false, title: '' })
          indRef.current.push({ s, indId: b.indId, oi, builtin: b.builtin })
        })
      }
      const panes = chart.panes()
      const total = el.current?.clientHeight ?? 400
      const sub = Math.max(70, Math.min(130, total * 0.2))
      panes.slice(1).forEach((p) => p.setHeight(sub))
      setPineSignals(built.flatMap((b) => b.signals ?? []))
      onLegend(built.map((b) => ({ indId: b.indId, error: b.error, outputs: b.outputs.map((o) => ({ title: o.title, color: o.color, data: o.data })) })))
    })()
    return () => {
      cancelled = true
    }
  }, [state.indicators, pineSources, mainVersion])

  /* trade markers */
  useEffect(() => {
    const bars = barsRef.current
    const m: SeriesMarker<Time>[] = []
    const up = cssVar('--up')
    const down = cssVar('--down')
    if (bt && bt.symbol === state.symbol && bt.tf === state.tf) {
      for (const tr of bt.trades) {
        m.push({ time: t(tr.entryTime), position: tr.side === 'long' ? 'belowBar' : 'aboveBar', shape: tr.side === 'long' ? 'arrowUp' : 'arrowDown', color: cssVar('--accent'), text: tr.side === 'long' ? 'L' : 'S', size: 1 })
        m.push({ time: t(tr.exitTime), position: tr.side === 'long' ? 'aboveBar' : 'belowBar', shape: 'circle', color: tr.pnl >= 0 ? up : down, text: `${tr.pnlPct >= 0 ? '+' : ''}${tr.pnlPct.toFixed(1)}%`, size: 0.6 })
      }
    } else {
      for (const s of pineSignals) {
        const b = bars[Math.min(s.bar + 1, bars.length - 1)]
        if (!b) continue
        m.push(s.action === 'flat' ? { time: t(b.time), position: 'aboveBar', shape: 'circle', color: cssVar('--muted'), size: 0.5 } : { time: t(b.time), position: s.action === 'long' ? 'belowBar' : 'aboveBar', shape: s.action === 'long' ? 'arrowUp' : 'arrowDown', color: cssVar('--accent'), size: 0.8 })
      }
    }
    m.sort((a, b) => Number(a.time) - Number(b.time))
    markersRef.current?.setMarkers(m)
  }, [bt, pineSignals, mainVersion, state.symbol, state.tf])

  /* live ticks */
  useEffect(
    () =>
      subscribeTicks(() => {
        const bars = barsRef.current
        const main = mainRef.current
        if (!main || !bars.length) return
        const last = bars[bars.length - 1]
        const s = stateRef.current
        main.update(s.style === 'candles' || s.style === 'bars' ? { ...last, time: t(last.time) } : { time: t(last.time), value: last.close })
        volRef.current?.update({ time: t(last.time), value: last.volume, color: (last.close >= last.open ? cssVar('--up') : cssVar('--down')) + '40' })
        const byInd = new Map<string, IndicatorOutput[]>()
        for (const r of indRef.current) {
          if (!r.builtin) continue
          let outs = byInd.get(r.indId)
          if (!outs) {
            const inst = s.indicators.find((i) => i.id === r.indId)
            const def = inst && getIndicator(inst.type)
            if (!def || !inst) continue
            outs = def.compute(bars, { ...defaultInputs(def), ...inst.inputs })
            byInd.set(r.indId, outs)
          }
          const v = outs[r.oi]?.data.at(-1)
          if (v !== null && v !== undefined && Number.isFinite(v)) r.s.update(outs[r.oi].kind === 'histogram' ? { time: t(last.time), value: v, color: (v >= 0 ? cssVar('--up') : cssVar('--down')) + 'aa' } : { time: t(last.time), value: v })
        }
      }),
    [],
  )

  /* drawing overlay render loop */
  useEffect(() => {
    let raf = 0
    const c = canvasRef.current!
    const ctx = c.getContext('2d')!
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const chart = chartRef.current
      const main = mainRef.current
      if (!chart || !main || document.hidden) return
      const dpr = window.devicePixelRatio || 1
      const w = c.clientWidth
      const h = c.clientHeight
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr)
        c.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const { drawings, draft, selected } = drawRef.current
      if (!drawings.length && !draft) {
        ctx.clearRect(0, 0, w, h)
        return
      }
      const plotW = w - (chart.priceScale('right').width() || 0)
      drawAll(ctx, { chart, series: main, bars: barsRef.current }, drawings, { width: plotW, height: h, accent: cssVar('--accent'), text: cssVar('--text'), muted: cssVar('--muted'), selected, draft })
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [])

  /* delete selected drawing */
  useEffect(() => {
    if (!selected) return
    const k = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target as HTMLElement).closest('input,textarea,.cm-editor')) {
        removeDrawing(state.symbol, selected)
        setSelected(null)
      }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [selected, state.symbol])

  useEffect(() => {
    if (tool === 'cursor') setDraft(null)
  }, [tool])

  const toPoint = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const v: Viewport = { chart: chartRef.current!, series: mainRef.current!, bars: barsRef.current }
    const tt = xToTime(v, x)
    const p = yToPrice(v, y)
    return tt === null || p === null ? null : { x, y, t: tt, p }
  }
  const downAt = useRef<{ x: number; y: number } | null>(null)
  const commit = (d: Drawing) => {
    addDrawing(state.symbol, d)
    setDraft(null)
    setSelected(d.id)
    setTool('cursor')
  }
  const onDown = (e: React.PointerEvent) => {
    if (tool === 'cursor') return
    const pt = toPoint(e)
    if (!pt) return
    e.currentTarget.setPointerCapture(e.pointerId)
    if (tool === 'hline') return commit({ id: uid('d'), tool, points: [{ t: pt.t, p: pt.p }] })
    if (tool === 'text') return setTextAt(pt)
    if (draft) return commit({ ...draft, points: [draft.points[0], { t: pt.t, p: pt.p }] })
    downAt.current = { x: pt.x, y: pt.y }
    setDraft({ id: uid('d'), tool, points: [{ t: pt.t, p: pt.p }, { t: pt.t, p: pt.p }] })
  }
  const onMove = (e: React.PointerEvent) => {
    if (!draft) return
    const pt = toPoint(e)
    if (pt) setDraft({ ...draft, points: [draft.points[0], { t: pt.t, p: pt.p }] })
  }
  const onUp = (e: React.PointerEvent) => {
    if (!draft || !downAt.current) return
    const pt = toPoint(e)
    if (pt && Math.hypot(pt.x - downAt.current.x, pt.y - downAt.current.y) > 6) commit({ ...draft, points: [draft.points[0], { t: pt.t, p: pt.p }] })
    downAt.current = null
  }

  return (
    <div className="absolute inset-0" onDoubleClick={(e) => {
      if (tool !== 'cursor' || (e.target as HTMLElement).tagName === 'INPUT') return
      const n = barsRef.current.length
      chartRef.current?.timeScale().setVisibleLogicalRange({ from: n - 170, to: n + 6 })
    }}>
      <div ref={el} className="absolute inset-0" />
      <canvas
        ref={canvasRef}
        className={cx('absolute inset-0 h-full w-full', tool === 'cursor' ? 'pointer-events-none' : 'cursor-crosshair')}
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
            if (e.key === 'Enter' && e.currentTarget.value.trim()) {
              commit({ id: uid('d'), tool: 'text', points: [{ t: textAt.t, p: textAt.p }], text: e.currentTarget.value.trim() })
              setTextAt(null)
            }
            if (e.key === 'Escape') {
              setTextAt(null)
              setTool('cursor')
            }
          }}
          onBlur={() => setTextAt(null)}
        />
      )}
      {selected && (
        <button
          onClick={() => {
            removeDrawing(state.symbol, selected)
            setSelected(null)
          }}
          className="glass absolute bottom-10 left-1/2 z-10 -translate-x-1/2 rounded-full px-3 py-1 text-[11.5px] text-muted hover:text-down"
        >
          Delete drawing <span className="text-faint">· Del</span>
        </button>
      )}
    </div>
  )
}
