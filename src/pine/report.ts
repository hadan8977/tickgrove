import type { Context } from 'pinets'
import type { BacktestResult, Bar, Trade } from '../core/types'

export type PineBacktest = Omit<BacktestResult, 'id' | 'name' | 'source' | 'sourceRef' | 'symbol' | 'tf' | 'createdAt'> & { pendingOrders: unknown[] }
export type PineState = NonNullable<Context['strategy']>

/** Import the runtime's actual ledger; never manufacture a second set of fills. */
export function pineReport(state: PineState, bars: Bar[], equity: { time: number; value: number }[], exposedBars: number): PineBacktest {
  const trades: Trade[] = state.closedtrades.map((t, i) => ({
    id: i + 1, side: t.size < 0 ? 'short' : 'long', entryBar: t.entry_bar_index,
    exitBar: t.exit_bar_index!, entryTime: t.entry_time / 1000, exitTime: t.exit_time! / 1000,
    entryPrice: t.entry_price, exitPrice: t.exit_price!, qty: Math.abs(t.size), pnl: t.profit ?? 0,
    pnlPct: t.entry_price && t.size ? (t.profit ?? 0) / (t.entry_price * Math.abs(t.size)) * 100 : 0,
    reason: 'pine', entryId: t.entry_id, exitId: t.exit_id, commission: t.commission ?? 0,
  }))
  let peak = state.initial_capital
  const drawdown = equity.map(e => { peak = Math.max(peak, e.value); return { time: e.time, value: peak > 0 ? (e.value / peak - 1) * 100 : 0 } })
  const monthly: PineBacktest['monthly'] = []
  let previous = state.initial_capital
  for (let i = 0; i < equity.length; i++) {
    const date = new Date(equity[i].time * 1000)
    const next = equity[i + 1] && new Date(equity[i + 1].time * 1000)
    if (!next || date.getUTCMonth() !== next.getUTCMonth() || date.getUTCFullYear() !== next.getUTCFullYear()) {
      monthly.push({ y: date.getUTCFullYear(), m: date.getUTCMonth(), r: previous ? (equity[i].value / previous - 1) * 100 : 0 })
      previous = equity[i].value
    }
  }
  const cfg = state.config
  return {
    engine: 'pinets', trades, equity, drawdown, monthly, pendingOrders: JSON.parse(JSON.stringify(state.pending_orders)),
    openPositions: state.opentrades.map(t => ({ entryId: t.entry_id, qty: t.size, price: t.entry_price, time: t.entry_time / 1000 })),
    nativeConfig: { commissionType: cfg.commission_type ?? 'percent', commissionValue: cfg.commission_value ?? 0,
      slippageTicks: cfg.slippage ?? 0, sizeType: cfg.default_qty_type ?? 'fixed', sizeValue: cfg.default_qty_value ?? 1 },
    config: { capital: state.initial_capital, commissionBps: cfg.commission_type === 'percent' ? (cfg.commission_value ?? 0) * 100 : 0,
      slippageBps: 0, sizePct: cfg.default_qty_type === 'percent_of_equity' ? cfg.default_qty_value ?? 0 : 0 },
    metrics: {
      netProfit: state.equity - state.initial_capital, netProfitPct: (state.equity / state.initial_capital - 1) * 100,
      buyHoldPct: bars[0].open ? (bars.at(-1)!.close / bars[0].open - 1) * 100 : 0,
      cagr: state.cagr ?? 0, sharpe: state.sharpe_ratio ?? 0, sortino: state.sortino_ratio ?? 0,
      maxDrawdownPct: -(state.max_drawdown_percent_value ?? 0), winRate: trades.length ? state.wintrades / trades.length * 100 : 0,
      profitFactor: state.grossloss ? state.grossprofit / Math.abs(state.grossloss) : state.grossprofit ? Infinity : 0,
      trades: trades.length, avgTradePct: trades.length ? trades.reduce((sum, t) => sum + t.pnlPct, 0) / trades.length : 0,
      exposurePct: equity.length ? exposedBars / equity.length * 100 : 0,
    },
  }
}
