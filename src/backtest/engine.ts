import type { BacktestConfig, BacktestMetrics, Bar, Signal, Trade } from '../core/types'
import { TF_SECONDS, type Timeframe } from '../core/types'

/** Event-driven bar-by-bar simulator. Signals act on the next bar's open. */
export function simulate(bars: Bar[], signals: Signal[], cfg: BacktestConfig, tf: Timeframe) {
  const byBar = new Map<number, Signal['action']>()
  for (const s of signals) byBar.set(s.bar, s.action)
  const fee = cfg.commissionBps / 10000
  const slip = cfg.slippageBps / 10000
  let cash = cfg.capital
  type Pos = { side: 'long' | 'short'; qty: number; entry: number; bar: number }
  let pos = null as Pos | null
  const trades: Trade[] = []
  const equity: { time: number; value: number }[] = []
  let pending: Signal['action'] | null = null
  let barsInMarket = 0

  const close = (i: number, price: number, reason: Trade['reason']) => {
    if (!pos) return
    const px = pos.side === 'long' ? price * (1 - slip) : price * (1 + slip)
    const gross = (pos.side === 'long' ? px - pos.entry : pos.entry - px) * pos.qty
    const cost = px * pos.qty * fee
    cash += pos.side === 'long' ? px * pos.qty - cost : pos.entry * pos.qty + gross - cost
    trades.push({
      id: trades.length + 1,
      side: pos.side,
      entryBar: pos.bar,
      exitBar: i,
      entryTime: bars[pos.bar].time,
      exitTime: bars[i].time,
      entryPrice: pos.entry,
      exitPrice: px,
      qty: pos.qty,
      pnl: gross - cost - pos.entry * pos.qty * fee,
      pnlPct: (gross / (pos.entry * pos.qty)) * 100,
      reason,
    })
    pos = null
  }
  const open = (i: number, side: 'long' | 'short', price: number) => {
    const px = side === 'long' ? price * (1 + slip) : price * (1 - slip)
    const alloc = cash * (cfg.sizePct / 100)
    const qty = Math.floor((alloc / px) * 1e4) / 1e4
    if (qty <= 0) return
    cash -= px * qty + px * qty * fee
    if (side === 'short') cash += 0 // margin held in cash; P&L settled on close
    pos = { side, qty, entry: px, bar: i }
  }

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    if (pending) {
      if (pos && (pending === 'flat' || pending !== pos.side)) close(i, b.open, 'signal')
      if (!pos && pending !== 'flat') open(i, pending, b.open)
      pending = null
    }
    if (pos) {
      barsInMarket++
      const p = pos as NonNullable<typeof pos>
      const stop = cfg.stopPct ? (p.side === 'long' ? p.entry * (1 - cfg.stopPct / 100) : p.entry * (1 + cfg.stopPct / 100)) : null
      const take = cfg.takePct ? (p.side === 'long' ? p.entry * (1 + cfg.takePct / 100) : p.entry * (1 - cfg.takePct / 100)) : null
      if (stop !== null && (p.side === 'long' ? b.low <= stop : b.high >= stop)) close(i, stop, 'stop')
      else if (take !== null && (p.side === 'long' ? b.high >= take : b.low <= take)) close(i, take, 'take')
    }
    const a = byBar.get(i)
    if (a) pending = a
    const mark = pos ? (pos.side === 'long' ? pos.qty * b.close : pos.qty * pos.entry + (pos.entry - b.close) * pos.qty) : 0
    equity.push({ time: b.time, value: cash + mark })
  }
  if (pos) close(bars.length - 1, bars[bars.length - 1].close, 'end')
  equity[equity.length - 1].value = cash

  // drawdown + metrics
  let peak = -Infinity
  let maxDD = 0
  const drawdown = equity.map((e) => {
    peak = Math.max(peak, e.value)
    const dd = ((e.value - peak) / peak) * 100
    maxDD = Math.min(maxDD, dd)
    return { time: e.time, value: dd }
  })
  const rets = equity.slice(1).map((e, i) => e.value / equity[i].value - 1)
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1)
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1))
  const dsd = Math.sqrt(rets.reduce((a, b) => a + Math.min(b, 0) ** 2, 0) / (rets.length || 1))
  const perYear = (86400 * 252) / Math.min(TF_SECONDS[tf], 86400) / (TF_SECONDS[tf] >= 604800 ? 5 : 1)
  const final = equity[equity.length - 1].value
  const years = (bars[bars.length - 1].time - bars[0].time) / (86400 * 365)
  const wins = trades.filter((t) => t.pnl > 0)
  const losses = trades.filter((t) => t.pnl <= 0)
  const gp = wins.reduce((a, t) => a + t.pnl, 0)
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0))
  const metrics: BacktestMetrics = {
    netProfit: final - cfg.capital,
    netProfitPct: (final / cfg.capital - 1) * 100,
    buyHoldPct: (bars[bars.length - 1].close / bars[0].open - 1) * 100,
    cagr: years > 0 ? ((final / cfg.capital) ** (1 / years) - 1) * 100 : 0,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(perYear) : 0,
    sortino: dsd > 0 ? (mean / dsd) * Math.sqrt(perYear) : 0,
    maxDrawdownPct: maxDD,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    trades: trades.length,
    avgTradePct: trades.length ? trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length : 0,
    exposurePct: (barsInMarket / bars.length) * 100,
  }
  // monthly returns
  const monthly: { y: number; m: number; r: number }[] = []
  let lastKey = ''
  let startVal = equity[0].value
  equity.forEach((e, i) => {
    const d = new Date(e.time * 1000)
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`
    if (key !== lastKey) {
      if (lastKey) {
        const [y, m] = lastKey.split('-').map(Number)
        monthly.push({ y, m, r: (equity[i - 1].value / startVal - 1) * 100 })
        startVal = equity[i - 1].value
      }
      lastKey = key
    }
  })
  const [y, m] = lastKey.split('-').map(Number)
  monthly.push({ y, m, r: (final / startVal - 1) * 100 })
  return { trades, equity, drawdown, metrics, monthly, config: cfg }
}
