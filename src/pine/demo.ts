import { getBars, SYMBOLS } from '../data/feed'
import type { Timeframe } from '../core/types'
import type { PineRunOptions } from './runtime'

/** Explicit demo snapshots, including cross-symbol requests; never mixed with real feeds. */
export function demoPineOptions(symbol: string, tf: Timeframe, inputs?: Record<string, unknown>): PineRunOptions {
  const metadata = (s: typeof SYMBOLS[number]) => ({ timezone: 'UTC', prefix: s.exchange === 'NYSE Arca' ? 'AMEX' : s.exchange,
    type: s.kind, description: `${s.name} (synthetic demo data)`, mintick: 0.01, pointvalue: 1 })
  const info = SYMBOLS.find(s => s.symbol === symbol)
  return { symbol, inputs, metadata: info && metadata(info),
    datasets: SYMBOLS.filter(s => s.symbol !== symbol).map(s => ({ symbol: s.symbol, timeframe: tf, bars: getBars(s.symbol, tf), metadata: metadata(s) })) }
}
