import { useState } from 'react'
import { Pause, Play, RotateCcw, Square, X } from 'lucide-react'
import { execute } from '../../core/commands'
import { livePrice } from '../../data/feed'
import { usePaper } from '../../store'
import { useTick } from '../../ui/hooks'
import { Badge, Button, IconButton, StatusBadge, cx, fmt } from '../../ui/primitives'

type Tab = 'positions' | 'orders' | 'fills' | 'strategies'

export default function PaperAccount() {
  useTick()
  const { cash, startingCash, positions, orders, fills, strategies, setStrategyStatus, cancelOrder, reset } = usePaper()
  const [tab, setTab] = useState<Tab>('positions')
  const pos = Object.values(positions)
  const mv = pos.reduce((a, p) => a + p.qty * livePrice(p.symbol), 0)
  const upnl = pos.reduce((a, p) => a + (livePrice(p.symbol) - p.avg) * p.qty, 0)
  const equity = cash + mv
  const total = equity - startingCash
  const working = orders.filter((o) => o.status === 'working')
  const tabs: [Tab, string, number][] = [
    ['positions', 'Positions', pos.length],
    ['orders', 'Orders', working.length],
    ['fills', 'Fills', fills.length],
    ['strategies', 'Strategies', strategies.filter((s) => s.status !== 'stopped').length],
  ]
  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex shrink-0 items-center gap-5 border-b border-line px-3 py-2">
        <StatusBadge status="demo" />
        <Stat k="Equity" v={fmt.money(equity)} />
        <Stat k="Cash" v={fmt.money(cash)} />
        <Stat k="Unrealized" v={fmt.money(upnl)} tone={upnl} />
        <Stat k="Total P&L" v={`${fmt.money(total)} (${fmt.pct((total / startingCash) * 100)})`} tone={total} />
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={reset} title="Reset paper account">
          <RotateCcw size={12} /> Reset
        </Button>
      </div>
      <div className="flex shrink-0 gap-0.5 border-b border-line px-2 py-1">
        {tabs.map(([id, l, n]) => (
          <button key={id} onClick={() => setTab(id)} className={cx('flex h-6 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-medium', tab === id ? 'bg-panel-3 text-text' : 'text-muted hover:text-text')}>
            {l}
            {n > 0 && <span className="num rounded bg-accent/15 px-1 text-[10px] text-accent">{n}</span>}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'positions' && (
          <Table head={['Symbol', 'Qty', 'Avg', 'Last', 'Mkt value', 'Unrealized', '']} empty="No open paper positions.">
            {pos.map((p) => {
              const last = livePrice(p.symbol)
              const pl = (last - p.avg) * p.qty
              return (
                <tr key={p.symbol}>
                  <td className="!text-left font-semibold font-sans">{p.symbol}</td>
                  <td className={p.qty >= 0 ? 'text-up' : 'text-down'}>{p.qty}</td>
                  <td>{fmt.price(p.avg)}</td>
                  <td>{fmt.price(last)}</td>
                  <td>{fmt.money(p.qty * last)}</td>
                  <td className={pl >= 0 ? 'text-up' : 'text-down'}>
                    {fmt.money(pl)} <span className="text-[10.5px] opacity-70">{fmt.pct(((last - p.avg) / p.avg) * 100 * Math.sign(p.qty))}</span>
                  </td>
                  <td>
                    <Button size="sm" variant="ghost" onClick={() => execute('paper.flatten', { symbol: p.symbol })}>
                      Flatten
                    </Button>
                  </td>
                </tr>
              )
            })}
          </Table>
        )}
        {tab === 'orders' && (
          <Table head={['Time', 'Symbol', 'Side', 'Type', 'Qty', 'Price', 'Status', 'Source', '']} empty="No orders yet.">
            {orders.slice(0, 80).map((o) => (
              <tr key={o.id}>
                <td className="!text-left text-faint">{new Date(o.createdAt).toLocaleTimeString('en-US', { hour12: false })}</td>
                <td className="font-sans font-semibold">{o.symbol}</td>
                <td className={o.side === 'buy' ? 'text-up' : 'text-down'}>{o.side.toUpperCase()}</td>
                <td className="text-muted">{o.type}</td>
                <td>{o.qty}</td>
                <td>{o.price ? fmt.price(o.price) : '—'}</td>
                <td>
                  <Badge className={cx(o.status === 'filled' && '!text-up', o.status === 'working' && '!text-accent', o.status === 'rejected' && '!text-down')}>{o.status}</Badge>
                </td>
                <td className="text-faint">{o.source}</td>
                <td>
                  {o.status === 'working' && (
                    <IconButton label="Cancel" onClick={() => cancelOrder(o.id)}>
                      <X size={12} />
                    </IconButton>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
        {tab === 'fills' && (
          <Table head={['Time', 'Symbol', 'Side', 'Qty', 'Price', 'Fee']} empty="No simulated fills yet.">
            {fills.slice(0, 80).map((f) => (
              <tr key={f.id}>
                <td className="!text-left text-faint">{new Date(f.time).toLocaleTimeString('en-US', { hour12: false })}</td>
                <td className="font-sans font-semibold">{f.symbol}</td>
                <td className={f.side === 'buy' ? 'text-up' : 'text-down'}>{f.side.toUpperCase()}</td>
                <td>{f.qty}</td>
                <td>{fmt.price(f.price)}</td>
                <td className="text-muted">{fmt.money(f.fee)}</td>
              </tr>
            ))}
          </Table>
        )}
        {tab === 'strategies' && (
          <Table head={['Strategy', 'Market', 'Source', 'Status', 'Last signal', 'Since', '']} empty="Deploy a backtest to run it against simulated ticks.">
            {strategies.map((s) => (
              <tr key={s.id}>
                <td className="!text-left font-sans font-semibold">{s.name}</td>
                <td>
                  {s.symbol} · {s.tf}
                </td>
                <td className="text-muted">{s.source}</td>
                <td>
                  <span className={cx('inline-flex items-center gap-1.5', s.status === 'running' ? 'text-up' : s.status === 'paused' ? 'text-demo' : 'text-faint')}>
                    <span className={cx('size-1.5 rounded-full bg-current', s.status === 'running' && 'animate-pulse')} />
                    {s.status}
                  </span>
                </td>
                <td className="text-muted">{s.lastSignal ?? '—'}</td>
                <td className="text-faint">{new Date(s.startedAt).toLocaleTimeString()}</td>
                <td>
                  <div className="flex justify-end">
                    {s.status === 'running' ? (
                      <IconButton label="Pause" onClick={() => setStrategyStatus(s.id, 'paused')}>
                        <Pause size={12} />
                      </IconButton>
                    ) : s.status === 'paused' ? (
                      <IconButton label="Resume" onClick={() => setStrategyStatus(s.id, 'running')}>
                        <Play size={12} />
                      </IconButton>
                    ) : null}
                    {s.status !== 'stopped' && (
                      <IconButton label="Stop" onClick={() => setStrategyStatus(s.id, 'stopped')}>
                        <Square size={11} />
                      </IconButton>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </div>
  )
}

const Stat = ({ k, v, tone }: { k: string; v: string; tone?: number }) => (
  <div>
    <div className="text-[10px] uppercase tracking-wider text-faint">{k}</div>
    <div className={cx('num text-[12.5px] font-semibold', tone !== undefined && (tone >= 0 ? 'text-up' : 'text-down'))}>{v}</div>
  </div>
)

function Table({ head, children, empty }: { head: string[]; children: React.ReactNode; empty: string }) {
  const rows = Array.isArray(children) ? children.length : children ? 1 : 0
  return (
    <table className="num w-full text-[11.5px]">
      <thead className="sticky top-0 bg-panel text-[10.5px] uppercase tracking-wider text-faint">
        <tr className="[&>th]:px-3 [&>th]:py-1.5 [&>th]:text-right [&>th]:font-medium [&>th:first-child]:text-left">
          {head.map((h, i) => (
            <th key={i}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody className="[&>tr]:border-t [&>tr]:border-line [&>tr:hover]:bg-panel-2 [&_td]:px-3 [&_td]:py-1 [&_td]:text-right">
        {children}
        {!rows && (
          <tr>
            <td colSpan={head.length} className="!py-6 !text-center font-sans text-muted">
              {empty}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}
