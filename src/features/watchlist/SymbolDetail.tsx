import { useMemo, useRef } from 'react'
import { getBars, orderBook, symbolInfo } from '../../data/feed'
import { useApp, useCharts } from '../../store'
import { useQuote, useTick } from '../../ui/hooks'
import { Segmented, StatusBadge, cx, fmt } from '../../ui/primitives'
import { useState } from 'react'

export default function SymbolDetail() {
  const activeId = useApp((s) => s.activeChartId)
  const symbol = useCharts((s) => s.charts[activeId ?? '']?.symbol) ?? 'NVDA'
  const [tab, setTab] = useState<'book' | 'tape' | 'stats'>('book')
  const info = symbolInfo(symbol)
  const q = useQuote(symbol)
  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="border-b border-line px-3 py-2.5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[14px] font-semibold tracking-tight">{symbol}</div>
            <div className="text-[11px] text-muted">{info.name} · {info.sector}</div>
          </div>
          <div className="text-right">
            <div className="num text-[16px] font-semibold">{fmt.price(q.last)}</div>
            <div className={cx('num text-[11.5px]', q.change >= 0 ? 'text-up' : 'text-down')}>
              {q.change >= 0 ? '+' : ''}
              {q.change.toFixed(2)} ({fmt.pct(q.changePct)})
            </div>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <Segmented layoutId={`detail-tab`} value={tab} onChange={setTab} options={[{ value: 'book', label: 'Depth' }, { value: 'tape', label: 'Trades' }, { value: 'stats', label: 'Stats' }]} />
          <StatusBadge status="demo" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{tab === 'book' ? <Book symbol={symbol} /> : tab === 'tape' ? <Tape symbol={symbol} /> : <Stats symbol={symbol} />}</div>
    </div>
  )
}

function Book({ symbol }: { symbol: string }) {
  useTick()
  const { asks, bids, spread } = orderBook(symbol, 9)
  const max = Math.max(...asks.map((a) => a.size), ...bids.map((b) => b.size))
  const row = (p: number, s: number, side: 'a' | 'b') => (
    <div key={side + p} className="relative grid grid-cols-2 px-3 py-[2px] text-[11.5px]">
      <div className={cx('absolute inset-y-[1px] right-0', side === 'a' ? 'bg-down/10' : 'bg-up/10')} style={{ width: `${(s / max) * 100}%` }} />
      <span className={cx('num relative', side === 'a' ? 'text-down' : 'text-up')}>{fmt.price(p)}</span>
      <span className="num relative text-right text-muted">{s.toLocaleString()}</span>
    </div>
  )
  return (
    <div className="py-1.5">
      {[...asks].reverse().map((a) => row(a.price, a.size, 'a'))}
      <div className="num my-1 flex justify-between border-y border-line bg-panel-2 px-3 py-1 text-[11px] text-muted">
        <span>Spread</span>
        <span>{spread.toFixed(2)}</span>
      </div>
      {bids.map((b) => row(b.price, b.size, 'b'))}
    </div>
  )
}

function Tape({ symbol }: { symbol: string }) {
  const tick = useTick()
  const q = useQuote(symbol)
  const tape = useRef<{ id: number; t: number; p: number; s: number; up: boolean }[]>([])
  const last = useRef<{ sym: string; p: number }>({ sym: symbol, p: q.last })
  useMemo(() => {
    if (last.current.sym !== symbol) {
      tape.current = []
      last.current = { sym: symbol, p: q.last }
    }
    const n = 1 + Math.floor(Math.random() * 3)
    for (let i = 0; i < n; i++) {
      const p = q.last + (Math.random() - 0.5) * q.last * 0.0002
      tape.current.unshift({ id: tick * 10 + i, t: Date.now(), p, s: Math.round(10 + Math.random() * 800), up: p >= last.current.p })
      last.current.p = p
    }
    tape.current = tape.current.slice(0, 60)
  }, [tick, symbol])
  return (
    <div className="py-1">
      <div className="grid grid-cols-3 px-3 py-1 text-[10.5px] uppercase tracking-wider text-faint">
        <span>Time</span>
        <span className="text-right">Price</span>
        <span className="text-right">Size</span>
      </div>
      {tape.current.map((x) => (
        <div key={x.id} className="num grid grid-cols-3 px-3 py-[2px] text-[11.5px]">
          <span className="text-faint">{new Date(x.t).toLocaleTimeString('en-US', { hour12: false })}</span>
          <span className={cx('text-right', x.up ? 'text-up' : 'text-down')}>{fmt.price(x.p)}</span>
          <span className="text-right text-muted">{x.s}</span>
        </div>
      ))}
    </div>
  )
}

function Stats({ symbol }: { symbol: string }) {
  const d = getBars(symbol, '1D')
  const y = d.slice(-252)
  const hi = Math.max(...y.map((b) => b.high))
  const lo = Math.min(...y.map((b) => b.low))
  const avgVol = y.slice(-30).reduce((a, b) => a + b.volume, 0) / 30
  const last = d[d.length - 1]
  const info = symbolInfo(symbol)
  const rows: [string, string][] = [
    ['Open', fmt.price(last.open)],
    ['Day range', `${fmt.price(last.low)} – ${fmt.price(last.high)}`],
    ['52W range', `${fmt.price(lo)} – ${fmt.price(hi)}`],
    ['Avg vol (30D)', fmt.compact(avgVol)],
    ['Volatility (ann.)', `${(info.vol * 100).toFixed(0)}%`],
    ['YTD', fmt.pct((last.close / d[d.length - 160].close - 1) * 100)],
    ['Exchange', info.exchange],
    ['Type', info.kind.toUpperCase()],
  ]
  return (
    <div className="p-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between rounded-md px-1.5 py-1.5 text-[12px] odd:bg-panel-2/60">
          <span className="text-muted">{k}</span>
          <span className="num">{v}</span>
        </div>
      ))}
    </div>
  )
}
