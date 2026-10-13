import type { Bar, SymbolInfo, Timeframe } from '../core/types'
import { TF_SECONDS } from '../core/types'

export const SYMBOLS: SymbolInfo[] = [
  { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', sector: 'Technology', price: 228.4, vol: 0.26, kind: 'stock' },
  { symbol: 'MSFT', name: 'Microsoft Corp.', exchange: 'NASDAQ', sector: 'Technology', price: 431.2, vol: 0.24, kind: 'stock' },
  { symbol: 'NVDA', name: 'NVIDIA Corp.', exchange: 'NASDAQ', sector: 'Semiconductors', price: 138.6, vol: 0.52, kind: 'stock' },
  { symbol: 'TSLA', name: 'Tesla Inc.', exchange: 'NASDAQ', sector: 'Automotive', price: 251.3, vol: 0.58, kind: 'stock' },
  { symbol: 'AMZN', name: 'Amazon.com Inc.', exchange: 'NASDAQ', sector: 'Consumer', price: 198.7, vol: 0.32, kind: 'stock' },
  { symbol: 'META', name: 'Meta Platforms', exchange: 'NASDAQ', sector: 'Communication', price: 582.1, vol: 0.38, kind: 'stock' },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', exchange: 'NASDAQ', sector: 'Communication', price: 172.9, vol: 0.3, kind: 'stock' },
  { symbol: 'AMD', name: 'Advanced Micro Devices', exchange: 'NASDAQ', sector: 'Semiconductors', price: 152.4, vol: 0.5, kind: 'stock' },
  { symbol: 'JPM', name: 'JPMorgan Chase', exchange: 'NYSE', sector: 'Financials', price: 221.8, vol: 0.22, kind: 'stock' },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF', exchange: 'NYSE Arca', sector: 'Index ETF', price: 571.3, vol: 0.15, kind: 'etf' },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust', exchange: 'NASDAQ', sector: 'Index ETF', price: 489.6, vol: 0.2, kind: 'etf' },
  { symbol: 'BTCUSD', name: 'Bitcoin / US Dollar', exchange: 'DEMO', sector: 'Crypto', price: 67250, vol: 0.6, kind: 'crypto' },
  { symbol: 'ETHUSD', name: 'Ethereum / US Dollar', exchange: 'DEMO', sector: 'Crypto', price: 2615, vol: 0.7, kind: 'crypto' },
]
export const symbolInfo = (s: string) => SYMBOLS.find((x) => x.symbol === s) ?? SYMBOLS[0]

function hash(str: string) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  return h >>> 0
}
function rng(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function gauss(r: () => number) {
  const u = Math.max(r(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r())
}

const BAR_COUNT = 900
const cache = new Map<string, Bar[]>()
// Session start anchored so data is stable across reloads within a day.
const ANCHOR = Math.floor(Date.now() / 1000 / 300) * 300

/** Seeded regime-switching GBM; final close is rescaled to the symbol's reference price. */
export function getBars(symbol: string, tf: Timeframe): Bar[] {
  const key = `${symbol}:${tf}`
  const hit = cache.get(key)
  if (hit) return hit
  const info = symbolInfo(symbol)
  const r = rng(hash(key))
  const step = TF_SECONDS[tf]
  const dt = step / (86400 * 252)
  const raw: Bar[] = []
  let p = 100
  let drift = 0.08
  let volMul = 1
  const end = Math.floor(ANCHOR / step) * step
  for (let i = 0; i < BAR_COUNT; i++) {
    if (r() < 0.02) drift = (r() - 0.45) * 0.9
    if (r() < 0.03) volMul = 0.6 + r() * 1.2
    const sigma = info.vol * volMul
    const o = p
    const ret = (drift - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * gauss(r)
    const c = o * Math.exp(ret)
    const wick = sigma * Math.sqrt(dt) * o
    const h = Math.max(o, c) + Math.abs(gauss(r)) * wick * 0.6
    const l = Math.min(o, c) - Math.abs(gauss(r)) * wick * 0.6
    const baseVol = info.kind === 'crypto' ? 2400 : 1_200_000
    const v = baseVol * (step / 3600) ** 0.7 * (0.5 + r() + Math.abs(ret) * 40)
    raw.push({ time: end - (BAR_COUNT - 1 - i) * step, open: o, high: h, low: l, close: c, volume: Math.round(v) })
    p = c
  }
  const k = info.price / p
  const dec = info.price > 1000 ? 2 : info.price > 10 ? 2 : 4
  const f = (x: number) => Number((x * k).toFixed(dec))
  const bars = raw.map((b) => ({ ...b, open: f(b.open), high: f(b.high), low: f(b.low), close: f(b.close) }))
  cache.set(key, bars)
  return bars
}

/** Simulated tick stream shared by all consumers. */
type TickListener = (prices: Record<string, number>) => void
const tickListeners = new Set<TickListener>()
const live: Record<string, number> = Object.fromEntries(SYMBOLS.map((s) => [s.symbol, s.price]))
const prevClose: Record<string, number> = Object.fromEntries(
  SYMBOLS.map((s) => {
    const d = getBars(s.symbol, '1D')
    return [s.symbol, d[d.length - 2].close]
  }),
)
const tickRng = rng(42)
let timer: ReturnType<typeof setInterval> | null = null

export function livePrice(s: string) {
  return live[s]
}
export function prevClosePrice(s: string) {
  return prevClose[s]
}

function tick() {
  for (const s of SYMBOLS) {
    if (tickRng() < 0.35) continue
    const sigma = s.vol / Math.sqrt(252 * 6.5 * 3600) * 4
    live[s.symbol] = Number((live[s.symbol] * Math.exp(sigma * gauss(tickRng))).toFixed(2))
  }
  // propagate into last bar of every cached series
  for (const [key, bars] of cache) {
    const sym = key.split(':')[0]
    const last = bars[bars.length - 1]
    const p = live[sym]
    bars[bars.length - 1] = { ...last, close: p, high: Math.max(last.high, p), low: Math.min(last.low, p), volume: last.volume + Math.round(last.volume * 0.002) }
  }
  tickListeners.forEach((l) => l(live))
}

export function subscribeTicks(l: TickListener) {
  tickListeners.add(l)
  if (!timer) timer = setInterval(tick, 1000)
  return () => {
    tickListeners.delete(l)
  }
}

/** Synthetic order book around the live price. */
export function orderBook(symbol: string, levels = 10) {
  const p = live[symbol]
  const tickSize = p > 1000 ? 0.5 : p > 100 ? 0.01 : 0.01
  const r = rng(Math.floor(Date.now() / 1000) + hash(symbol))
  const spread = Math.max(tickSize, p * 0.00015)
  const asks = Array.from({ length: levels }, (_, i) => ({ price: p + spread / 2 + i * spread, size: Math.round(50 + r() * 900 * (1 + i * 0.3)) }))
  const bids = Array.from({ length: levels }, (_, i) => ({ price: p - spread / 2 - i * spread, size: Math.round(50 + r() * 900 * (1 + i * 0.3)) }))
  return { asks, bids, spread }
}
