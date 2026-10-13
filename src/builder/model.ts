import type { Bar, Signal, Timeframe } from '../core/types'
import { atr, ema, rsi, sma, type Series } from '../indicators/registry'

export type OperandKind = 'price' | 'sma' | 'ema' | 'rsi' | 'atr' | 'value' | 'macd' | 'volume'
export interface Operand {
  kind: OperandKind
  length?: number
  value?: number
  field?: 'close' | 'open' | 'high' | 'low'
}
export type Comparator = '>' | '<' | 'crosses above' | 'crosses below'
export interface Condition {
  id: string
  type: 'condition'
  left: Operand
  cmp: Comparator
  right: Operand
}
export interface Group {
  id: string
  type: 'group'
  op: 'all' | 'any'
  children: (Condition | Group)[]
}
export interface StrategyDefinition {
  id: string
  name: string
  symbol: string
  tf: Timeframe
  direction: 'long' | 'short'
  entry: Group
  exit: Group
  sizePct: number
  stopPct: number | null
  takePct: number | null
  updatedAt: number
}

let n = 0
export const uid = (p = 'n') => `${p}${Date.now().toString(36)}${(n++).toString(36)}`

export const newCondition = (): Condition => ({ id: uid('c'), type: 'condition', left: { kind: 'ema', length: 12 }, cmp: 'crosses above', right: { kind: 'ema', length: 26 } })
export const newGroup = (op: 'all' | 'any' = 'all', children: (Condition | Group)[] = [newCondition()]): Group => ({ id: uid('g'), type: 'group', op, children })

export const exampleStrategy = (): StrategyDefinition => ({
  id: uid('s'),
  name: 'Trend Pullback',
  symbol: 'NVDA',
  tf: '1D',
  direction: 'long',
  entry: {
    id: uid('g'),
    type: 'group',
    op: 'all',
    children: [
      { id: uid('c'), type: 'condition', left: { kind: 'price', field: 'close' }, cmp: '>', right: { kind: 'sma', length: 50 } },
      { id: uid('c'), type: 'condition', left: { kind: 'rsi', length: 14 }, cmp: 'crosses above', right: { kind: 'value', value: 45 } },
    ],
  },
  exit: {
    id: uid('g'),
    type: 'group',
    op: 'any',
    children: [
      { id: uid('c'), type: 'condition', left: { kind: 'rsi', length: 14 }, cmp: '>', right: { kind: 'value', value: 72 } },
      { id: uid('c'), type: 'condition', left: { kind: 'price', field: 'close' }, cmp: 'crosses below', right: { kind: 'ema', length: 21 } },
    ],
  },
  sizePct: 95,
  stopPct: 8,
  takePct: null,
  updatedAt: Date.now(),
})

export function operandLabel(o: Operand) {
  switch (o.kind) {
    case 'price':
      return o.field ?? 'close'
    case 'value':
      return String(o.value ?? 0)
    case 'volume':
      return 'volume'
    case 'macd':
      return 'MACD hist'
    default:
      return `${o.kind.toUpperCase()}(${o.length ?? 14})`
  }
}

function series(bars: Bar[], o: Operand, cache: Map<string, Series>): Series {
  const key = JSON.stringify(o)
  const hit = cache.get(key)
  if (hit) return hit
  const c = bars.map((b) => b.close)
  let s: Series
  switch (o.kind) {
    case 'price':
      s = bars.map((b) => b[o.field ?? 'close'])
      break
    case 'value':
      s = bars.map(() => o.value ?? 0)
      break
    case 'volume':
      s = bars.map((b) => b.volume)
      break
    case 'sma':
      s = sma(c, o.length ?? 20)
      break
    case 'ema':
      s = ema(c, o.length ?? 20)
      break
    case 'rsi':
      s = rsi(c, o.length ?? 14)
      break
    case 'atr':
      s = atr(bars, o.length ?? 14)
      break
    case 'macd': {
      const f = ema(c, 12)
      const sl = ema(c, 26)
      const m = f.map((v, i) => (v === null || sl[i] === null ? 0 : v - (sl[i] as number)))
      const sig = ema(m, 9)
      s = m.map((v, i) => (sig[i] === null ? null : v - (sig[i] as number)))
      break
    }
  }
  cache.set(key, s)
  return s
}

function evalNode(node: Condition | Group, bars: Bar[], i: number, cache: Map<string, Series>): boolean {
  if (node.type === 'group') {
    if (!node.children.length) return false
    return node.op === 'all' ? node.children.every((c) => evalNode(c, bars, i, cache)) : node.children.some((c) => evalNode(c, bars, i, cache))
  }
  const a = series(bars, node.left, cache)
  const b = series(bars, node.right, cache)
  const [a0, b0, a1, b1] = [a[i], b[i], a[i - 1], b[i - 1]]
  if (a0 == null || b0 == null) return false
  switch (node.cmp) {
    case '>':
      return a0 > b0
    case '<':
      return a0 < b0
    case 'crosses above':
      return a1 != null && b1 != null && a1 <= b1 && a0 > b0
    case 'crosses below':
      return a1 != null && b1 != null && a1 >= b1 && a0 < b0
  }
}

/** Evaluate the block tree into position signals. */
export function evaluate(def: StrategyDefinition, bars: Bar[]): Signal[] {
  const cache = new Map<string, Series>()
  const out: Signal[] = []
  let inPos = false
  for (let i = 1; i < bars.length; i++) {
    if (!inPos && evalNode(def.entry, bars, i, cache)) {
      out.push({ bar: i, action: def.direction })
      inPos = true
    } else if (inPos && evalNode(def.exit, bars, i, cache)) {
      out.push({ bar: i, action: 'flat' })
      inPos = false
    }
  }
  return out
}

export function currentSignal(def: StrategyDefinition, bars: Bar[]) {
  const cache = new Map<string, Series>()
  const i = bars.length - 1
  return { entry: evalNode(def.entry, bars, i, cache), exit: evalNode(def.exit, bars, i, cache) }
}
