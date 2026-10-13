import { useEffect, useMemo, useRef, useState } from 'react'
import { AreaSeries, BaselineSeries, ColorType, createChart, HistogramSeries, LineStyle, type Time } from 'lightweight-charts'
import { FlaskConical, Rocket, Trash2 } from 'lucide-react'
import type { BacktestResult } from '../../core/types'
import { execute } from '../../core/commands'
import { useApp, useBacktests, useCharts } from '../../store'
import { Badge, Button, Empty, Select, StatusBadge, cx, fmt } from '../../ui/primitives'
import { cssVar } from '../chart/bus'
import { getBars } from '../../data/feed'

export default function BacktestReport() {
  const { results, activeId, setActive, remove, running } = useBacktests()
  const r = results.find((x) => x.id === activeId) ?? results[0]
  const [tab, setTab] = useState<'trades' | 'monthly'>('trades')
  if (!r)
    return (
      <Empty
        icon={<FlaskConical size={18} />}
        title={running ? 'Running backtest…' : 'No backtests yet'}
        body="Run a Pine strategy or a visual strategy. Results stay in this session and can be deployed to paper trading."
        action={
          <Button size="sm" onClick={() => execute('backtest.runBuilder', {})}>
            <FlaskConical size={12} /> Backtest visual strategy
          </Button>
        }
      />
    )
  const m = r.metrics
  const cards: [string, string, 'up' | 'down' | null][] = [
    ['Net profit', fmt.pct(m.netProfitPct), m.netProfitPct >= 0 ? 'up' : 'down'],
    ['Buy & hold', fmt.pct(m.buyHoldPct), null],
    ['CAGR', fmt.pct(m.cagr), m.cagr >= 0 ? 'up' : 'down'],
    ['Max drawdown', fmt.pct(m.maxDrawdownPct, false), 'down'],
    ['Sharpe', m.sharpe.toFixed(2), null],
    ['Sortino', m.sortino.toFixed(2), null],
    ['Win rate', `${m.winRate.toFixed(1)}%`, null],
    ['Profit factor', Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞', null],
    ['Trades', String(m.trades), null],
    ['Exposure', `${m.exposurePct.toFixed(0)}%`, null],
  ]
  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-2.5">
        <Select value={r.id} onChange={(e) => setActive(e.target.value)} className="max-w-[220px] font-medium">
          {results.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} · {x.symbol} {x.tf} · {new Date(x.createdAt).toLocaleTimeString()}
            </option>
          ))}
        </Select>
        <Badge>{r.source === 'pine' ? 'Pine' : 'Blocks'}</Badge>
        <span className="text-[11px] italic text-faint">Hypothetical results · demo data</span>
        <div className="flex-1" />
        <StatusBadge status="demo" />
        <Button size="sm" variant="ghost" onClick={() => remove(r.id)} title="Discard">
          <Trash2 size={12} />
        </Button>
        <Button size="sm" variant="primary" onClick={() => execute('paper.deploy', { backtestId: r.id })}>
          <Rocket size={12} /> Deploy to paper
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid grid-cols-5 gap-px border-b border-line bg-line">
          {cards.map(([k, v, tone]) => (
            <div key={k} className="bg-panel px-3 py-2">
              <div className="text-[10.5px] uppercase tracking-wider text-faint">{k}</div>
              <div className={cx('num mt-0.5 text-[15px] font-semibold', tone === 'up' && 'text-up', tone === 'down' && 'text-down')}>{v}</div>
            </div>
          ))}
        </div>
        <EquityChart r={r} />
        <div className="flex items-center gap-1 border-y border-line px-2.5 py-1.5">
          {(['trades', 'monthly'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cx('h-6 rounded-md px-2 text-[11.5px] font-medium capitalize', tab === t ? 'bg-panel-3 text-text' : 'text-muted hover:text-text')}>
              {t === 'trades' ? `Trades · ${r.trades.length}` : 'Monthly returns'}
            </button>
          ))}
          <div className="flex-1" />
          <span className="num text-[11px] text-faint">
            capital {fmt.money(r.config.capital)} · fee {r.config.commissionBps}bp · slip {r.config.slippageBps}bp · size {r.config.sizePct}%
            {r.config.stopPct ? ` · SL ${r.config.stopPct}%` : ''}
            {r.config.takePct ? ` · TP ${r.config.takePct}%` : ''}
          </span>
        </div>
        {tab === 'trades' ? <Trades r={r} /> : <Monthly r={r} />}
      </div>
    </div>
  )
}

function EquityChart({ r }: { r: BacktestResult }) {
  const el = useRef<HTMLDivElement>(null)
  const theme = useApp((s) => s.theme)
  useEffect(() => {
    const chart = createChart(el.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted'), fontFamily: 'Geist, sans-serif', fontSize: 10.5, attributionLogo: false, panes: { separatorColor: cssVar('--line') } },
      grid: { vertLines: { visible: false }, horzLines: { color: cssVar('--grid') } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
      handleScroll: false,
      handleScale: false,
    })
    const eq = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: r.config.capital },
      topLineColor: cssVar('--up'),
      topFillColor1: cssVar('--up') + '40',
      topFillColor2: cssVar('--up') + '05',
      bottomLineColor: cssVar('--down'),
      bottomFillColor1: cssVar('--down') + '05',
      bottomFillColor2: cssVar('--down') + '40',
      lineWidth: 2,
      priceLineVisible: false,
    })
    eq.setData(r.equity.map((e) => ({ time: e.time as Time, value: e.value })))
    const bars = getBars(r.symbol, r.tf)
    const bh = chart.addSeries(AreaSeries, { lineColor: cssVar('--faint'), topColor: 'transparent', bottomColor: 'transparent', lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false })
    const base = bars[0].open
    bh.setData(bars.map((b) => ({ time: b.time as Time, value: (r.config.capital * b.close) / base })))
    const dd = chart.addSeries(HistogramSeries, { color: cssVar('--down') + '88', priceLineVisible: false, priceFormat: { type: 'percent' } as any }, 1)
    dd.setData(r.drawdown.map((d) => ({ time: d.time as Time, value: d.value })))
    chart.panes()[1]?.setHeight(60)
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [r, theme])
  return (
    <div className="relative">
      <div className="pointer-events-none absolute left-3 top-2 z-10 flex gap-3 text-[10.5px] text-muted">
        <span className="flex items-center gap-1">
          <span className="h-0.5 w-3 rounded bg-up" /> Strategy equity
        </span>
        <span className="flex items-center gap-1">
          <span className="h-0 w-3 border-t border-dashed border-faint" /> Buy & hold
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-down/60" /> Drawdown
        </span>
      </div>
      <div ref={el} className="h-[230px]" />
    </div>
  )
}

function Trades({ r }: { r: BacktestResult }) {
  const chartFor = () => Object.values(useCharts.getState().charts).find((c) => c.backtestId === r.id)
  return (
    <table className="num w-full text-[11.5px]">
      <thead className="sticky top-0 bg-panel text-[10.5px] uppercase tracking-wider text-faint">
        <tr className="[&>th]:px-2.5 [&>th]:py-1.5 [&>th]:text-right [&>th]:font-medium">
          <th className="!text-left">#</th>
          <th className="!text-left">Side</th>
          <th className="!text-left">Entry</th>
          <th>Price</th>
          <th className="!text-left">Exit</th>
          <th>Price</th>
          <th>Qty</th>
          <th>P&L</th>
          <th>%</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        {[...r.trades].reverse().map((t) => (
          <tr
            key={t.id}
            onClick={() => {
              const c = chartFor()
              if (!c) useApp.getState().toast({ title: 'Open a chart with this backtest to jump to trades' })
            }}
            className="cursor-default border-t border-line hover:bg-panel-2 [&>td]:px-2.5 [&>td]:py-1 [&>td]:text-right"
          >
            <td className="!text-left text-faint">{t.id}</td>
            <td className={cx('!text-left font-medium', t.side === 'long' ? 'text-up' : 'text-down')}>{t.side.toUpperCase()}</td>
            <td className="!text-left text-muted">{new Date(t.entryTime * 1000).toLocaleDateString()}</td>
            <td>{fmt.price(t.entryPrice)}</td>
            <td className="!text-left text-muted">{new Date(t.exitTime * 1000).toLocaleDateString()}</td>
            <td>{fmt.price(t.exitPrice)}</td>
            <td className="text-muted">{t.qty.toFixed(2)}</td>
            <td className={t.pnl >= 0 ? 'text-up' : 'text-down'}>{fmt.money(t.pnl)}</td>
            <td className={t.pnl >= 0 ? 'text-up' : 'text-down'}>{fmt.pct(t.pnlPct)}</td>
            <td className="text-faint">{t.reason}</td>
          </tr>
        ))}
        {!r.trades.length && (
          <tr>
            <td colSpan={10} className="p-6 text-center font-sans text-muted">
              The strategy produced no trades on this data. Loosen the entry conditions or try another symbol.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']
function Monthly({ r }: { r: BacktestResult }) {
  const years = useMemo(() => [...new Set(r.monthly.map((m) => m.y))], [r])
  const max = Math.max(1, ...r.monthly.map((m) => Math.abs(m.r)))
  return (
    <div className="p-3">
      <div className="grid grid-cols-[48px_repeat(12,1fr)_60px] gap-1 text-[10.5px]">
        <span />
        {MONTHS.map((m, i) => (
          <span key={i} className="text-center text-faint">
            {m}
          </span>
        ))}
        <span className="text-right text-faint">Year</span>
        {years.map((y) => {
          const ms = r.monthly.filter((m) => m.y === y)
          const yr = (ms.reduce((a, m) => a * (1 + m.r / 100), 1) - 1) * 100
          return [
            <span key={y} className="num self-center text-muted">
              {y}
            </span>,
            ...MONTHS.map((_, i) => {
              const m = ms.find((x) => x.m === i)
              const a = m ? Math.min(1, Math.abs(m.r) / max) : 0
              return (
                <span
                  key={y + '-' + i}
                  title={m ? `${fmt.pct(m.r)}` : ''}
                  className="num grid h-7 place-items-center rounded text-[10px]"
                  style={{ background: m ? `color-mix(in srgb, ${m.r >= 0 ? 'var(--up)' : 'var(--down)'} ${8 + a * 55}%, transparent)` : 'var(--panel-2)', color: m ? 'var(--text)' : 'transparent' }}
                >
                  {m ? m.r.toFixed(1) : ''}
                </span>
              )
            }),
            <span key={y + 'y'} className={cx('num self-center text-right font-semibold', yr >= 0 ? 'text-up' : 'text-down')}>
              {fmt.pct(yr)}
            </span>,
          ]
        })}
      </div>
    </div>
  )
}
