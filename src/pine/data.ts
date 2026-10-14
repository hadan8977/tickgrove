import type { IProvider, ISymbolInfo, Kline } from 'pinets'
import type { Bar, Timeframe } from '../core/types'

export interface PineDataset {
  symbol: string
  timeframe: string
  bars: Bar[]
  metadata?: Partial<ISymbolInfo>
}

export function pineTimeframe(tf: string): string {
  const value = tf.toUpperCase()
  if (value === '1D') return 'D'
  if (value === '1W') return 'W'
  if (/^\d+H$/.test(value)) return String(parseInt(value) * 60)
  if (/^\d+m$/.test(tf)) return tf.slice(0, -1)
  return value
}

export function timeframeSeconds(tf: string): number {
  const value = pineTimeframe(tf)
  if (/^0(?:[SDW])?$/.test(value)) throw new Error(`Invalid timeframe ${tf}`)
  if (/^\d+$/.test(value)) return Number(value) * 60
  if (/^\d*S$/.test(value)) return parseInt(value) || 1
  if (/^\d*D$/.test(value)) return (parseInt(value) || 1) * 86400
  if (/^\d*W$/.test(value)) return (parseInt(value) || 1) * 604800
  throw new Error(`Timeframe ${tf} requires an explicit dataset and calendar`)
}

function validateBars(bars: Bar[]) {
  if (!bars.length) throw new Error('No market data supplied')
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    if (![b.time, b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite)) throw new Error(`Non-finite OHLCV at bar ${i}`)
    if (i && b.time <= bars[i - 1].time) throw new Error(`Market timestamps must be unique and increasing (bar ${i})`)
    if (b.high < Math.max(b.open, b.close, b.low) || b.low > Math.min(b.open, b.close) || b.volume < 0) throw new Error(`Invalid OHLCV at bar ${i}`)
    if (b.closeTime != null && (!Number.isFinite(b.closeTime) || b.closeTime <= b.time)) throw new Error(`Invalid closeTime at bar ${i}`)
  }
}

/** An offline provider. A request can never silently fetch another feed or symbol. */
export function createPineProvider(primary: PineDataset, extra: PineDataset[] = []): IProvider {
  const datasets = [primary, ...extra]
  datasets.forEach(d => validateBars(d.bars))
  const findSymbol = (symbol: string) => datasets.filter(d => d.symbol === symbol ||
    (!symbol.includes(':') && d.symbol.split(':').at(-1) === symbol) ||
    (d.metadata?.prefix && `${d.metadata.prefix}:${d.symbol}` === symbol))
  return {
    configure() {},
    async getSymbolInfo(symbol) {
      const d = findSymbol(symbol)[0]
      if (!d) throw new Error(`No dataset supplied for ${symbol}`)
      return {
        ticker: symbol.split(':').at(-1), tickerid: symbol, main_tickerid: symbol,
        prefix: 'LOCAL', description: symbol, type: 'stock', timezone: 'UTC',
        currency: 'USD', basecurrency: 'USD', session: 'regular', mintick: 0.01,
        minmove: 1, pricescale: 100, pointvalue: 1, mincontract: 1, volumetype: 'base',
        ...d.metadata,
      } as ISymbolInfo
    },
    async getMarketData(symbol, requested, limit, start, end) {
      const tf = pineTimeframe(requested || primary.timeframe)
      const choices = findSymbol(symbol)
      if (!choices.length) throw new Error(`No dataset supplied for ${symbol}; add it before using request.security`)
      const exact = choices.find(d => pineTimeframe(d.timeframe) === tf)
      let rows: Bar[]
      if (exact) rows = exact.bars
      else {
        const step = timeframeSeconds(tf)
        const lower = choices.filter(d => timeframeSeconds(d.timeframe) < step && step % timeframeSeconds(d.timeframe) === 0)
          .sort((a, b) => timeframeSeconds(b.timeframe) - timeframeSeconds(a.timeframe))[0]
        if (!lower) throw new Error(`No ${requested} dataset supplied for ${symbol}; lower-timeframe data cannot be invented`)
        // Only generic UTC datasets may be aggregated without a market calendar.
        if (lower.metadata?.timezone && lower.metadata.timezone !== 'UTC') throw new Error(`Supply session-aligned ${requested} bars for ${symbol}`)
        const buckets = new Map<number, Bar>()
        const anchor = tf.endsWith('W') ? 4 * 86400 : 0 // Monday, 1970-01-05
        for (const b of lower.bars) {
          const t = Math.floor((b.time - anchor) / step) * step + anchor
          const hit = buckets.get(t)
          if (!hit) buckets.set(t, { ...b, time: t, closeTime: t + step })
          else { hit.high = Math.max(hit.high, b.high); hit.low = Math.min(hit.low, b.low); hit.close = b.close; hit.volume += b.volume }
        }
        rows = [...buckets.values()]
      }
      let selected = rows.filter(b => (start == null || b.time * 1000 >= start) && (end == null || b.time * 1000 <= end))
      if (limit != null && limit > 0) selected = selected.slice(-limit)
      return selected.map(b => ({ ...b, openTime: b.time * 1000, closeTime: (b.closeTime ?? b.time + timeframeSeconds(tf)) * 1000,
        quoteAssetVolume: 0, numberOfTrades: 0, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0 })) as Kline[]
    },
  }
}

export function primaryDataset(bars: Bar[], tf: Timeframe | string, symbol = 'LOCAL:CHART'): PineDataset {
  return { symbol, timeframe: pineTimeframe(tf), bars }
}
