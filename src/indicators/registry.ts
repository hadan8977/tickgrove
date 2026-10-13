import type { Bar } from '../core/types'

export type Series = (number | null)[]
export interface IndicatorOutput {
  title: string
  kind: 'line' | 'histogram' | 'area'
  color: string
  data: Series
  width?: number
  dashed?: boolean
}
export interface IndicatorInputSpec {
  key: string
  label: string
  type: 'int' | 'float' | 'bool' | 'string'
  default: number | boolean | string
  min?: number
  max?: number
}
export interface IndicatorDef {
  id: string
  name: string
  short: string
  description: string
  overlay: boolean
  pluginId?: string
  inputs: IndicatorInputSpec[]
  compute: (bars: Bar[], inputs: Record<string, any>) => IndicatorOutput[]
  levels?: number[]
}

export const sma = (src: number[], n: number): Series => {
  const out: Series = []
  let sum = 0
  for (let i = 0; i < src.length; i++) {
    sum += src[i]
    if (i >= n) sum -= src[i - n]
    out.push(i >= n - 1 ? sum / n : null)
  }
  return out
}
export const ema = (src: number[], n: number): Series => {
  const out: Series = []
  const k = 2 / (n + 1)
  let prev: number | null = null
  for (let i = 0; i < src.length; i++) {
    if (i < n - 1) {
      out.push(null)
      continue
    }
    if (prev === null) {
      let s = 0
      for (let j = i - n + 1; j <= i; j++) s += src[j]
      prev = s / n
    } else prev = src[i] * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}
export const rsi = (src: number[], n: number): Series => {
  const out: Series = [null]
  let g = 0
  let l = 0
  for (let i = 1; i < src.length; i++) {
    const d = src[i] - src[i - 1]
    const up = Math.max(d, 0)
    const dn = Math.max(-d, 0)
    if (i <= n) {
      g += up / n
      l += dn / n
      out.push(i === n ? 100 - 100 / (1 + g / (l || 1e-9)) : null)
    } else {
      g = (g * (n - 1) + up) / n
      l = (l * (n - 1) + dn) / n
      out.push(100 - 100 / (1 + g / (l || 1e-9)))
    }
  }
  return out
}
export const stdev = (src: number[], n: number): Series => {
  const m = sma(src, n)
  return src.map((_, i) => {
    if (m[i] === null) return null
    let s = 0
    for (let j = i - n + 1; j <= i; j++) s += (src[j] - (m[i] as number)) ** 2
    return Math.sqrt(s / n)
  })
}
export const atr = (bars: Bar[], n: number): Series => {
  const tr = bars.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))))
  const out: Series = []
  let prev: number | null = null
  tr.forEach((t, i) => {
    if (i < n - 1) return out.push(null)
    prev = prev === null ? tr.slice(0, n).reduce((a, b) => a + b, 0) / n : (prev * (n - 1) + t) / n
    out.push(prev)
  })
  return out
}
const nz = (s: Series) => s.map((v) => v ?? 0)
const closes = (b: Bar[]) => b.map((x) => x.close)

const registry = new Map<string, IndicatorDef>()
const listeners = new Set<() => void>()
let snapshot: IndicatorDef[] = []
const changed = () => {
  snapshot = [...registry.values()]
  listeners.forEach((l) => l())
}
export function registerIndicator(def: IndicatorDef) {
  registry.set(def.id, def)
  changed()
  return () => {
    registry.delete(def.id)
    changed()
  }
}
/** Stable reference between changes (safe for useSyncExternalStore). */
export const listIndicators = () => snapshot
export const getIndicator = (id: string) => registry.get(id)
export const subscribeIndicators = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

const builtins: IndicatorDef[] = [
  {
    id: 'sma',
    name: 'Simple Moving Average',
    short: 'SMA',
    description: 'Arithmetic mean of closing prices.',
    overlay: true,
    inputs: [{ key: 'length', label: 'Length', type: 'int', default: 20, min: 1, max: 500 }],
    compute: (b, i) => [{ title: `SMA ${i.length}`, kind: 'line', color: '#f4b545', data: sma(closes(b), i.length) }],
  },
  {
    id: 'ema',
    name: 'Exponential Moving Average',
    short: 'EMA',
    description: 'Weighted average favoring recent prices.',
    overlay: true,
    inputs: [{ key: 'length', label: 'Length', type: 'int', default: 50, min: 1, max: 500 }],
    compute: (b, i) => [{ title: `EMA ${i.length}`, kind: 'line', color: '#8b7dff', data: ema(closes(b), i.length) }],
  },
  {
    id: 'bb',
    name: 'Bollinger Bands',
    short: 'BB',
    description: 'Volatility bands around an SMA.',
    overlay: true,
    inputs: [
      { key: 'length', label: 'Length', type: 'int', default: 20, min: 2 },
      { key: 'mult', label: 'StdDev', type: 'float', default: 2, min: 0.1 },
    ],
    compute: (b, i) => {
      const c = closes(b)
      const m = sma(c, i.length)
      const sd = stdev(c, i.length)
      return [
        { title: 'Basis', kind: 'line', color: '#4ee6d2', data: m, width: 1 },
        { title: 'Upper', kind: 'line', color: '#4ee6d288', data: m.map((v, k) => (v === null ? null : v + i.mult * (sd[k] as number))), width: 1 },
        { title: 'Lower', kind: 'line', color: '#4ee6d288', data: m.map((v, k) => (v === null ? null : v - i.mult * (sd[k] as number))), width: 1 },
      ]
    },
  },
  {
    id: 'vwap',
    name: 'VWAP (rolling)',
    short: 'VWAP',
    description: 'Volume-weighted average price over a rolling window.',
    overlay: true,
    inputs: [{ key: 'length', label: 'Window', type: 'int', default: 50, min: 2 }],
    compute: (b, i) => {
      const out: Series = []
      for (let k = 0; k < b.length; k++) {
        if (k < i.length - 1) {
          out.push(null)
          continue
        }
        let pv = 0
        let v = 0
        for (let j = k - i.length + 1; j <= k; j++) {
          const tp = (b[j].high + b[j].low + b[j].close) / 3
          pv += tp * b[j].volume
          v += b[j].volume
        }
        out.push(pv / v)
      }
      return [{ title: 'VWAP', kind: 'line', color: '#f472b6', data: out, dashed: true }]
    },
  },
  {
    id: 'rsi',
    name: 'Relative Strength Index',
    short: 'RSI',
    description: 'Momentum oscillator 0–100.',
    overlay: false,
    levels: [70, 30],
    inputs: [{ key: 'length', label: 'Length', type: 'int', default: 14, min: 2 }],
    compute: (b, i) => [{ title: `RSI ${i.length}`, kind: 'line', color: '#8b7dff', data: rsi(closes(b), i.length) }],
  },
  {
    id: 'macd',
    name: 'MACD',
    short: 'MACD',
    description: 'Trend-following momentum: EMA difference with signal line.',
    overlay: false,
    inputs: [
      { key: 'fast', label: 'Fast', type: 'int', default: 12, min: 1 },
      { key: 'slow', label: 'Slow', type: 'int', default: 26, min: 1 },
      { key: 'signal', label: 'Signal', type: 'int', default: 9, min: 1 },
    ],
    compute: (b, i) => {
      const c = closes(b)
      const f = ema(c, i.fast)
      const s = ema(c, i.slow)
      const m = f.map((v, k) => (v === null || s[k] === null ? null : v - (s[k] as number)))
      const start = m.findIndex((v) => v !== null)
      const sigRaw = ema(nz(m).slice(start), i.signal)
      const sig: Series = [...Array(start).fill(null), ...sigRaw]
      const hist = m.map((v, k) => (v === null || sig[k] === null ? null : v - (sig[k] as number)))
      return [
        { title: 'Hist', kind: 'histogram', color: '#22c58f', data: hist },
        { title: 'MACD', kind: 'line', color: '#4ee6d2', data: m },
        { title: 'Signal', kind: 'line', color: '#f4b545', data: sig },
      ]
    },
  },
  {
    id: 'atr',
    name: 'Average True Range',
    short: 'ATR',
    description: 'Average range including gaps — a volatility gauge.',
    overlay: false,
    inputs: [{ key: 'length', label: 'Length', type: 'int', default: 14, min: 1 }],
    compute: (b, i) => [{ title: `ATR ${i.length}`, kind: 'area', color: '#f2545f', data: atr(b, i.length) }],
  },
]
builtins.forEach(registerIndicator)

export function defaultInputs(def: IndicatorDef) {
  return Object.fromEntries(def.inputs.map((i) => [i.key, i.default]))
}
