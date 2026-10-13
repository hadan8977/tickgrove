import { PineTS } from 'pinets'
import type { Bar, PineInput, Signal } from '../core/types'
import { TF_SECONDS, type Timeframe } from '../core/types'

export interface PinePlot {
  title: string
  color: string
  data: (number | null)[]
  shape?: boolean
}
export interface PineRunResult {
  ok: boolean
  kind: 'indicator' | 'strategy'
  title: string
  overlay: boolean
  plots: PinePlot[]
  signals: Signal[]
  error?: { message: string; line?: number }
  ms: number
  warnings: string[]
}

const DEFAULT_COLORS = ['#8b7dff', '#4ee6d2', '#f4b545', '#f472b6', '#22c58f', '#f2545f']

/** Parse `x = input.int(14, "Length", minval=1)` declarations for the settings UI. */
export function parseInputs(source: string): PineInput[] {
  const out: PineInput[] = []
  source.split('\n').forEach((line, idx) => {
    const m = line.match(/^\s*(\w+)\s*=\s*input(?:\.(int|float|bool|string|source))?\s*\((.*)\)\s*$/)
    if (!m) return
    const [, name, t = 'float', args] = m
    const parts = args.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((s) => s.trim())
    const def = parts[0]
    const title = parts.find((p, i) => i > 0 && /^"/.test(p))?.replace(/"/g, '') ?? parts.find((p) => p.startsWith('title='))?.split('=')[1].replace(/"/g, '') ?? name
    const kv = (k: string) => parts.find((p) => p.startsWith(k + '='))?.split('=')[1]
    const type = t as PineInput['type']
    let dv: number | string | boolean = def
    if (type === 'int' || type === 'float') dv = Number(def)
    else if (type === 'bool') dv = def === 'true'
    else dv = def.replace(/"/g, '')
    const opts = kv('options')
    out.push({
      name,
      title,
      type,
      default: dv,
      min: kv('minval') ? Number(kv('minval')) : undefined,
      max: kv('maxval') ? Number(kv('maxval')) : undefined,
      options: opts ? opts.replace(/[[\]"]/g, '').split(/\s*,\s*/) : undefined,
      line: idx + 1,
    })
  })
  return out
}

/** Apply input overrides by rewriting the default argument (keeps PineTS unchanged). */
export function applyInputs(source: string, values: Record<string, unknown>) {
  const inputs = parseInputs(source)
  const lines = source.split('\n')
  for (const inp of inputs) {
    if (!(inp.name in values)) continue
    const v = values[inp.name]
    const lit = inp.type === 'string' ? `"${v}"` : String(v)
    lines[inp.line - 1] = lines[inp.line - 1].replace(/(input(?:\.\w+)?\s*\()\s*([^,)]+)/, `$1${lit}`)
  }
  return lines.join('\n')
}

export function detectKind(source: string): 'indicator' | 'strategy' {
  return /^\s*strategy\s*\(/m.test(source) ? 'strategy' : 'indicator'
}
export function detectTitle(source: string) {
  return source.match(/^\s*(?:indicator|strategy)\s*\(\s*"([^"]+)"/m)?.[1] ?? 'Untitled'
}

const UNSUPPORTED = [/\brequest\.security\b/, /\btable\.new\b/, /\bmatrix\./, /\bmap\.new\b/, /\bimport\s+\w+\//, /\btype\s+\w+\s*$/m]

function errorLine(e: any, source: string): number | undefined {
  if (e?.loc?.line) {
    // PineTS prefixes nothing; clamp to source length
    return Math.min(e.loc.line, source.split('\n').length)
  }
  const msg = String(e?.message ?? '')
  const m = msg.match(/line\s+(\d+)/i) ?? msg.match(/\bat (\d+):(\d+)/)
  if (m) return Math.min(Number(m[1]), source.split('\n').length)
  const ident = msg.match(/^(\w+) is not defined/) ?? msg.match(/identifier "(\w+)"/)
  if (ident) {
    const i = source.split('\n').findIndex((l) => new RegExp(`\\b${ident[1]}\\b`).test(l))
    if (i >= 0) return i + 1
  }
  return undefined
}

export async function runPine(source: string, bars: Bar[], tf: Timeframe = '1D'): Promise<PineRunResult> {
  const t0 = performance.now()
  const kind = detectKind(source)
  const base = { kind, title: detectTitle(source), overlay: false, plots: [], signals: [], warnings: [] as string[] }
  for (const re of UNSUPPORTED) {
    const i = source.split('\n').findIndex((l) => re.test(l))
    if (i >= 0) {
      return { ...base, ok: false, ms: 0, error: { message: `Unsupported in this runtime: "${source.split('\n')[i].trim()}" — PineTS subset (no request.*, tables, matrices, UDTs).`, line: i + 1 } }
    }
  }
  if (!/^\s*(indicator|strategy)\s*\(/m.test(source)) {
    return { ...base, ok: false, ms: 0, error: { message: 'Script must declare indicator(...) or strategy(...)', line: 1 } }
  }
  try {
    const step = TF_SECONDS[tf] * 1000
    const data = bars.map((b) => ({ open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, openTime: b.time * 1000, closeTime: b.time * 1000 + step - 1 }))
    const pt = new PineTS(data as any)
    const ctx: any = await pt.run(source)
    const timeIndex = new Map(bars.map((b, i) => [b.time * 1000, i]))
    const plots: PinePlot[] = []
    let ci = 0
    for (const [title, p] of Object.entries<any>(ctx.plots ?? {})) {
      if (title.startsWith('__')) continue
      const arr: (number | null)[] = new Array(bars.length).fill(null)
      let isBool = false
      let color: string | undefined
      for (const pt of p.data ?? []) {
        const i = timeIndex.get(pt.time)
        if (i === undefined) continue
        if (typeof pt.value === 'boolean') {
          isBool = true
          arr[i] = pt.value ? 1 : null
        } else arr[i] = typeof pt.value === 'number' && Number.isFinite(pt.value) ? pt.value : null
        color ??= pt.options?.color
      }
      plots.push({ title, data: arr, color: typeof color === 'string' && color.startsWith('#') ? color : DEFAULT_COLORS[ci++ % DEFAULT_COLORS.length], shape: isBool })
    }
    const signals: Signal[] = []
    const st = ctx.strategy
    if (kind === 'strategy' && st) {
      const all = [...(st.closedtrades ?? []), ...(st.opentrades ?? [])]
      for (const t of all) {
        const dir = (t.size ?? 1) < 0 || t.direction === 'short' ? 'short' : 'long'
        signals.push({ bar: t.entry_bar_index, action: dir })
        if (Number.isFinite(t.exit_bar_index) && t.status !== 'open') signals.push({ bar: t.exit_bar_index, action: 'flat' })
      }
      signals.sort((a, b) => a.bar - b.bar || (a.action === 'flat' ? -1 : 1))
    }
    const overlay = Boolean(ctx.indicator?.overlay ?? st?.config?.overlay ?? /overlay\s*=\s*true/.test(source))
    return { ...base, ok: true, overlay: kind === 'strategy' ? true : overlay, plots, signals, warnings: (ctx.warnings ?? []).map(String), ms: performance.now() - t0 }
  } catch (e: any) {
    return { ...base, ok: false, ms: performance.now() - t0, error: { message: String(e?.message ?? e), line: errorLine(e, source) } }
  }
}
