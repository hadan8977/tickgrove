import { Indicator, PineTS, type Context } from 'pinets'
import type { Bar, PineInput, PineReplayFrame, Signal, Timeframe } from '../core/types'
import { createPineProvider, primaryDataset, type PineDataset } from './data'
import { pineReport, type PineBacktest } from './report'
import { installPineCompatibility } from './compat'
import { linkPineLibraries, type PineLibraryLock } from './library'

installPineCompatibility()

export interface PinePlot {
  title: string
  color: string
  colors?: (string | undefined)[]
  data: (number | null)[]
  shape?: boolean
  style?: string
  display?: string
  width?: number
}
export interface PineRunResult {
  ok: boolean
  kind: 'indicator' | 'strategy'
  title: string
  overlay: boolean
  plots: PinePlot[]
  /** Display markers at actual fill bars, never strategy input signals. */
  signals: Signal[]
  alerts?: Context["alerts"]
  visuals?: Record<string, any>
  backtest?: PineBacktest
  error?: { message: string; line?: number; reference?: string }
  libraryLock?: {lockHash:string;modules:{reference:string;hash:string}[]}
  ms: number
  warnings: string[]
}
export interface PineRunOptions {
  symbol?: string
  inputs?: Record<string, unknown>
  datasets?: PineDataset[]
  metadata?: PineDataset['metadata']
  backtest?: boolean
  maxLoops?: number
  libraryLock?: PineLibraryLock
}

const DEFAULT_COLORS = ['#8b7dff', '#4ee6d2', '#f4b545', '#f472b6', '#22c58f', '#f2545f']

/** Parse multiline/named args, escaping and duplicate titles with the runtime's parser. */
export function parseInputs(source: string, libraryLock?:PineLibraryLock): PineInput[] {
  try {
    return new Indicator(linkPineLibraries(source,libraryLock).source).getInputsMeta().map(m => ({
      name: m.varId ?? m.id, title: m.title ?? m.name, type: m.type,
      default: typeof m.defval === 'number' || typeof m.defval === 'boolean' ? m.defval : String(m.defval ?? ''),
      min: m.minval, max: m.maxval, options: m.options?.map(String),
      line: Math.max(1, source.split('\n').findIndex(l => m.varId && l.includes(m.varId)) + 1),
    }))
  } catch { return [] }
}

/** Preserve strings and line offsets while removing comments. */
export function codeWithoutComments(source: string): string {
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    match => match.startsWith('/') ? match.replace(/[^\n]/g, ' ') : match)
}
export function detectKind(source: string): 'indicator' | 'strategy' {
  return /^\s*strategy\s*\(/m.test(codeWithoutComments(source)) ? 'strategy' : 'indicator'
}
export function detectTitle(source: string) {
  const match = codeWithoutComments(source).match(/^\s*(?:indicator|strategy)\s*\(\s*(?:title\s*=\s*)?("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/m)
  return match ? match[1].slice(1, -1).replace(/\\(["'\\])/g, '$1') : 'Untitled'
}
function errorLine(e: any, source: string): number | undefined {
  const n = e?.loc?.line ?? e?.line ?? String(e?.message ?? '').match(/line\s+(\d+)|\bat (\d+):\d+/i)?.slice(1).find(Boolean)
  return n && Number.isFinite(Number(n)) ? Math.max(1, Math.min(Number(n), source.split('\n').length)) : undefined
}

function validateInputs(indicator: Indicator, values: Record<string, unknown>) {
  const meta = indicator.getInputsMeta()
  const accepted = new Set(meta.flatMap(m => [m.id, m.varId, m.title, m.name].filter(Boolean)))
  for (const [key, value] of Object.entries(values)) {
    if (!accepted.has(key)) throw new Error(`Unknown Pine input: ${key}`)
    const m = meta.find(m => m.id === key || m.varId === key) ?? meta.find(m => m.title === key || m.name === key)!
    if (['int', 'float', 'price', 'time'].includes(m.type)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || (m.type === 'int' && !Number.isInteger(value))) throw new Error(`Input ${key} requires a finite ${m.type}`)
      if (m.minval != null && value < m.minval || m.maxval != null && value > m.maxval) throw new Error(`Input ${key} is outside its allowed range`)
    } else if (m.type === 'bool' ? typeof value !== 'boolean' : typeof value !== 'string') throw new Error(`Invalid value for input ${key}`)
    if (m.options && !m.options.includes(value)) throw new Error(`Input ${key} must be one of ${m.options.join(', ')}`)
  }
}

export async function runPine(source: string, bars: Bar[], tf: Timeframe | string = '1D', options: PineRunOptions = {}): Promise<PineRunResult> {
  const start = performance.now()
  const kind = detectKind(source)
  const base = { kind, title: detectTitle(source), overlay: false, plots: [] as PinePlot[], signals: [] as Signal[], warnings: [] as string[] }
  let linkedLineMap:{reference:string;line:number}[]=[]
  try {
    if (source.length > 500_000) throw new Error('Script exceeds the 500 KB source limit')
    if (bars.length > 20_000 && options.backtest) throw new Error('This browser backtest supports up to 20,000 bars per run')
    const linked=linkPineLibraries(source,options.libraryLock);source=linked.source;linkedLineMap=linked.lineMap
    const indicator = new Indicator(source, options.inputs)
    const declaration = indicator.getDeclarationType()
    if (!declaration) throw new Error('Script must declare indicator(...) or strategy(...)')
    base.kind = declaration
    validateInputs(indicator, options.inputs ?? {})
    const primary = { ...primaryDataset(bars, tf, options.symbol), metadata: options.metadata }
    const provider = createPineProvider(primary, options.datasets)
    const runtime = new PineTS(provider, primary.symbol, primary.timeframe, bars.length, bars[0]?.time * 1000, bars.at(-1)?.time! * 1000)
    runtime.setAlertMode("all")
    runtime.setMaxLoops(options.maxLoops ?? 50_000)
    let ctx: Context | undefined
    const equity: { time: number; value: number }[] = []
    const replayFrames: PineReplayFrame[] = []
    let exposed = 0
    if (declaration === 'strategy' && options.backtest) {
      // Sample after the runtime processes close-time fills, without rewriting source.
      for await (const page of runtime.run(indicator, undefined, 1)) {
        ctx = page.fullContext
        if (ctx.strategy) {
          equity.push({ time: bars[page.idx].time, value: ctx.strategy.equity })
          replayFrames.push({ time: bars[page.idx].time, equity: ctx.strategy.equity, positionSize: ctx.strategy.position_size, closedTrades: ctx.strategy.closedtrades.length })
          if (ctx.strategy.position_size !== 0) exposed++
        }
      }
    } else ctx = await runtime.run(indicator)
    if (!ctx) throw new Error('Runtime produced no output')
    const byTime = new Map(bars.map((b, i) => [b.time * 1000, i]))
    const plots: PinePlot[] = []
    const visuals: Record<string, any> = {}
    const displayWarnings: string[] = []
    for (const [key, p] of Object.entries<any>(ctx.plots ?? {})) {
      if (key.startsWith('__') || ['fill', 'bgcolor', 'background', 'barcolor', 'candle', 'bar'].includes(p.options?.style)) {
        visuals[key] = p
        if (p.options?.style === 'fill') {
          visuals[key] = { ...p, first: ctx.plots[p.plot1 ?? p.options.plot1]?.data, second: ctx.plots[p.plot2 ?? p.options.plot2]?.data }
        }
        if (['barcolor', 'bgcolor', 'background'].includes(p.options?.style) && new Set(p.data?.map((d: any) => d.time)).size !== p.data?.length) displayWarnings.push('PineTS combined multiple bar/background color calls; their display may differ from TradingView.')
        continue
      }
      const data: (number | null)[] = Array(bars.length).fill(null)
      const colors: (string | undefined)[] = Array(bars.length).fill(undefined)
      const last = p.data?.at(-1)
      const style = String(last?.options?.style ?? p.options?.style ?? 'line').replace(/^style_/, '')
      if (!['line', 'linebr', 'stepline', 'area', 'areabr', 'histogram', 'columns', 'shape', 'char', 'plotshape', 'plotchar', 'hline'].includes(style)) displayWarnings.push(`Plot style ${style} uses a line fallback in this chart renderer.`)
      let shape = ['shape', 'char', 'plotshape', 'plotchar'].includes(style)
      for (const item of p.data ?? []) {
        const index = byTime.get(item.time)
        if (index === undefined) continue
        if (typeof item.value === 'boolean') { shape = true; data[index] = item.value ? bars[index].close : null }
        else data[index] = typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : null
        colors[index] = typeof item.options?.color === 'string' ? item.options.color : undefined
      }
      plots.push({ title: p.title ?? key, color: colors.find(Boolean) ?? DEFAULT_COLORS[plots.length % DEFAULT_COLORS.length], colors, data, shape, style, display:last?.options?.display ?? p.options?.display, width: last?.options?.linewidth ?? 2 })
      if (shape) visuals[key] = p
    }
    const st = ctx.strategy
    const signals: Signal[] = []
    if (st) for (const trade of [...st.closedtrades, ...st.opentrades]) {
      signals.push({ bar: trade.entry_bar_index, action: trade.size < 0 ? 'short' : 'long' })
      if (trade.status === 'closed' && Number.isFinite(trade.exit_bar_index)) signals.push({ bar: trade.exit_bar_index!, action: 'flat' })
    }
    signals.sort((a, b) => a.bar - b.bar)
    const warnings = (ctx.warnings ?? []).map(w => typeof w === 'string' ? w : w.message)
    return { ...base, ok: true, title: st?.config.title ?? ctx.indicator?.title ?? base.title,
      overlay: Boolean(st?.config.overlay ?? ctx.indicator?.overlay), plots, signals,
      alerts:JSON.parse(JSON.stringify(ctx.alerts ?? [])),
      visuals: JSON.parse(JSON.stringify(visuals)), backtest: st && options.backtest ? { ...pineReport(st, bars, equity, exposed), replayFrames } : undefined,
      libraryLock:options.libraryLock?{lockHash:options.libraryLock.lockHash,modules:options.libraryLock.libraries.map(l=>({reference:l.reference,hash:l.hash}))}:undefined,
      warnings: [...new Set([...warnings, ...displayWarnings])], ms: performance.now() - start }
  } catch (e: any) {
    const generatedLine=errorLine(e,source);const origin=generatedLine?linkedLineMap[generatedLine-1]:undefined
    return { ...base, ok: false, ms: performance.now() - start, error: { message: String(e?.message ?? e), line:origin?.line??generatedLine,reference:origin?.reference } }
  }
}
