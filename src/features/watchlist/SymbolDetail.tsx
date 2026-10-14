import { useEffect } from 'react'
import { getBars, orderBook, symbolInfo, loadDepth, tradeTape, formatInstrumentPrice, marketSeries } from '../../data/feed'
import { MarketBadge } from '../../service/MarketPanel'
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
            <div className="num text-[16px] font-semibold">{q.format(q.last)}</div>
            <div className={cx('num text-[11.5px]', q.change >= 0 ? 'text-up' : 'text-down')}>
              {q.change >= 0 ? '+' : ''}
              {q.format(q.change)} ({fmt.pct(q.changePct)})
            </div>
          </div>
        </div>
        <div className="mt-2 flex flex-col items-start gap-2">
          <Segmented layoutId={`detail-tab`} value={tab} onChange={setTab} options={[{ value: 'book', label: 'Depth' }, { value: 'tape', label: 'Trades' }, { value: 'stats', label: 'Stats' }]} />
          <MarketBadge symbol={symbol} tf="1D" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{tab === 'book' ? <Book symbol={symbol} /> : tab === 'tape' ? <Tape symbol={symbol} /> : <Stats symbol={symbol} />}</div>
    </div>
  )
}

function Book({ symbol }: { symbol: string }) {
  useTick()
  useEffect(()=>{void loadDepth(symbol);const t=setInterval(()=>void loadDepth(symbol),5000);return()=>clearInterval(t)},[symbol])
  const { asks, bids, spread,kind,receivedAt,error } = orderBook(symbol, 9)
  const max = Math.max(0, ...asks.map((a) => a.size), ...bids.map((b) => b.size))
  const row = (p: number, s: number, side: 'a' | 'b') => (
    <div key={side + p} className="relative grid grid-cols-2 px-3 py-[2px] text-[11.5px]">
      <div className={cx('absolute inset-y-[1px] right-0', side === 'a' ? 'bg-down/10' : 'bg-up/10')} style={{ width: `${max > 0 ? (s / max) * 100 : 0}%` }} />
      <span className={cx('num relative', side === 'a' ? 'text-down' : 'text-up')}>{formatInstrumentPrice(symbol, p)}</span>
      <span className="num relative text-right text-muted">{s.toLocaleString("en-US", { maximumFractionDigits: 20 })}</span>
    </div>
  )
  return (
    <div className="py-1.5">
      <p className="px-3 py-1 text-[10px] text-muted">{kind??'Depth capability'} {receivedAt&&new Date(receivedAt).toISOString().slice(11,19)} {receivedAt&&'UTC'}</p>
      {error&&<p role="status" className="px-3 py-2 text-xs text-muted">{error}</p>}
      {[...asks].reverse().map((a) => row(a.price, a.size, 'a'))}
      <div className="num my-1 flex justify-between border-y border-line bg-panel-2 px-3 py-1 text-[11px] text-muted">
        <span>Spread</span>
        <span>{formatInstrumentPrice(symbol, spread)}</span>
      </div>
      {bids.map((b) => row(b.price, b.size, 'b'))}
    </div>
  )
}

function Tape({ symbol }: { symbol: string }) {
  useTick()
  const tape = tradeTape(symbol)
  return (
    <div className="py-1">
      <div className="grid grid-cols-3 px-3 py-1 text-[10.5px] uppercase tracking-wider text-faint">
        <span>Time</span>
        <span className="text-right">Price</span>
        <span className="text-right">Size</span>
      </div>
      {!tape.length&&<p className="p-3 text-xs text-muted">No recorded trade events from this subscription yet. A quote update is not a trade.</p>}
      {tape.map((x) => (
        <div key={x.id} className="num grid grid-cols-3 px-3 py-[2px] text-[11.5px]">
          <span className="text-faint">{new Date(x.time).toLocaleTimeString('en-US', { hour12: false })}</span>
          <span className={cx('text-right', x.side==='buy' ? 'text-up' : 'text-down')}>{formatInstrumentPrice(symbol, x.price)}</span>
          <span className="text-right text-muted">{x.size.toLocaleString("en-US", { maximumFractionDigits: 20 })}</span>
        </div>
      ))}
    </div>
  )
}

function Stats({ symbol }: { symbol: string }) {
  useTick()
  const d = getBars(symbol, '1D')
  const last = d[d.length - 1]
  const info = symbolInfo(symbol)
  if (!last) return <p className="p-3 text-xs text-muted">Daily history has not loaded.</p>
  const timezone = marketSeries(symbol, '1D').identity?.timezone ?? (info.kind === 'crypto' ? 'UTC' : 'America/New_York')
  const date = new Date(last.time * 1000)
  const lastDate = date.toLocaleDateString('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const year = Number(new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric' }).format(date))
  const y = d.filter(b => b.time >= last.time - 365.25 * 86400 && b.time <= last.time)
  const hi = y.length ? Math.max(...y.map(b => b.high)) : NaN
  const lo = y.length ? Math.min(...y.map(b => b.low)) : NaN
  const volumeBars = y.slice(-30)
  const avgVol = volumeBars.length && volumeBars.every(b => Number.isFinite(b.volume) && b.volume >= 0)
    ? volumeBars.reduce((sum, b) => sum + b.volume, 0) / volumeBars.length : NaN
  const priorYear = [...d].reverse().find(b => b.time < Date.UTC(year, 0, 1) / 1000)
  const price = (value: number) => formatInstrumentPrice(symbol, value)
  const returns=y.slice(1).map((b,i)=>Math.log(b.close/y[i].close)),mean=returns.reduce((a,b)=>a+b,0)/returns.length
  const volatility=returns.length>1?Math.sqrt(returns.reduce((sum,r)=>sum+(r-mean)**2,0)/(returns.length-1))*Math.sqrt(info.kind==='crypto'?365:252):Number.NaN
  const rows: [string, string][] = [
    ['Latest bar open', price(last.open)],
    ['Latest bar range', `${price(last.low)} – ${price(last.high)}`],
    ['Available 52W range', `${price(lo)} – ${price(hi)}`],
    [`Avg vol (${volumeBars.length} available daily bars)`, fmt.compact(avgVol)],
    ['Volatility (ann.)', fmt.pct(volatility*100,false)],
    [`YTD (${year}, as of latest bar)`, priorYear?fmt.pct((last.close / priorYear.close - 1) * 100):'Insufficient history'],
    ['Exchange', info.exchange],
    ['Type', info.kind.toUpperCase()],
  ]
  return (
    <div className="p-2">
      <p role="status" className="mb-2 px-1.5 text-xs text-muted">Latest available daily bar: {lastDate} · {timezone}{last.closeTime && last.closeTime > Date.now() / 1000 ? " · forming" : ""}. Statistics use available history through this bar.</p>
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-wrap justify-between gap-x-2 gap-y-1 rounded-md px-1.5 py-1.5 text-[12px] odd:bg-panel-2/60">
          <span className="text-muted">{k}</span>
          <span className="num">{v}</span>
        </div>
      ))}
    </div>
  )
}
