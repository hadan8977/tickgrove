import { useState } from 'react'
import { Lock, ShieldCheck } from 'lucide-react'
import { execute } from '../../core/commands'
import type { OrderType } from '../../core/types'
import { useApp, useCharts, usePaper } from '../../store'
import { useQuote } from '../../ui/hooks'
import { Button, Segmented, StatusBadge, cx, fmt } from '../../ui/primitives'

export default function OrderTicket() {
  const activeId = useApp((s) => s.activeChartId)
  const symbol = useCharts((s) => s.charts[activeId ?? '']?.symbol) ?? 'NVDA'
  const q = useQuote(symbol)
  const cash = usePaper((s) => s.cash)
  const pos = usePaper((s) => s.positions[symbol])
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [type, setType] = useState<OrderType>('market')
  const [qty, setQty] = useState(10)
  const [price, setPrice] = useState<string>('')
  const px = type === 'market' ? q.last : Number(price) || q.last
  const notional = px * qty
  const insufficient = side === 'buy' && notional > cash
  const submit = () =>
    execute('paper.placeOrder', { symbol, side, qty, type, price: type === 'market' ? undefined : Number(price) || q.last }).catch((e) => useApp.getState().toast({ title: e.message, tone: 'error' }))

  return (
    <div className="flex h-full flex-col overflow-auto bg-panel">
      <div className="flex items-center justify-between border-b border-demo/25 bg-demo/8 px-3 py-2 text-demo">
        <span className="flex items-center gap-1.5 text-[11.5px] font-medium">
          <ShieldCheck size={13} /> Paper account · simulated fills only
        </span>
        <StatusBadge status="demo" hatch={false} />
      </div>
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-[15px] font-semibold tracking-tight">{symbol}</div>
            <div className="text-[11px] text-muted">Position: {pos ? `${pos.qty} @ ${fmt.price(pos.avg)}` : 'flat'}</div>
          </div>
          <div className="num text-right">
            <div className="text-[16px] font-semibold">{fmt.price(q.last)}</div>
            <div className={cx('text-[11px]', q.change >= 0 ? 'text-up' : 'text-down')}>{fmt.pct(q.changePct)}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-panel-2 p-1 ring-1 ring-line">
          {(['buy', 'sell'] as const).map((s) => (
            <button key={s} onClick={() => setSide(s)} className={cx('h-8 rounded-lg text-[12.5px] font-semibold capitalize transition-colors', side === s ? (s === 'buy' ? 'bg-up text-white' : 'bg-down text-white') : 'text-muted hover:text-text')}>
              {s}
            </button>
          ))}
        </div>
        <Segmented layoutId="ticket-type" size="md" value={type} onChange={setType} options={[{ value: 'market', label: 'Market' }, { value: 'limit', label: 'Limit' }, { value: 'stop', label: 'Stop' }]} />
        <Field label="Quantity">
          <div className="flex items-center gap-1">
            <input type="number" min={0} value={qty} onChange={(e) => setQty(Math.max(0, Number(e.target.value)))} className="num h-8 flex-1 rounded-lg border border-line bg-panel-2 px-2.5 text-right text-[13px] outline-none focus:border-accent/60" />
            {[1, 10, 100].map((n) => (
              <button key={n} onClick={() => setQty(qty + n)} className="num h-8 rounded-lg bg-panel-2 px-2 text-[11px] text-muted ring-1 ring-line hover:text-text">
                +{n}
              </button>
            ))}
          </div>
        </Field>
        {type !== 'market' && (
          <Field label={type === 'limit' ? 'Limit price' : 'Stop price'}>
            <input type="number" placeholder={q.last.toFixed(2)} value={price} onChange={(e) => setPrice(e.target.value)} className="num h-8 w-full rounded-lg border border-line bg-panel-2 px-2.5 text-right text-[13px] outline-none focus:border-accent/60" />
          </Field>
        )}
        <div className="num space-y-1 rounded-lg bg-panel-2/70 p-2.5 text-[11.5px]">
          <Row k="Est. notional" v={fmt.money(notional)} />
          <Row k="Est. fee (1bp)" v={fmt.money(notional * 0.0001)} />
          <Row k="Buying power" v={fmt.money(cash)} warn={insufficient} />
        </div>
        <Button variant={side === 'buy' ? 'up' : 'down'} className="h-10 text-[13px]" onClick={submit} disabled={qty <= 0}>
          {side === 'buy' ? 'Buy' : 'Sell'} {qty} {symbol} · {type}
        </Button>
        <div className="text-center text-[11px] text-faint">Orders route to the local paper broker. No real order is ever sent.</div>
        <button onClick={() => useApp.getState().setLiveDialog(true)} className="flex items-center justify-between rounded-lg border border-dashed border-line-2 px-3 py-2 text-[11.5px] text-muted hover:border-live/40">
          <span className="flex items-center gap-1.5">
            <Lock size={12} /> Live broker
          </span>
          <StatusBadge status="not-connected" />
        </button>
      </div>
    </div>
  )
}
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="flex flex-col gap-1">
    <span className="text-[11px] font-medium text-muted">{label}</span>
    {children}
  </label>
)
const Row = ({ k, v, warn }: { k: string; v: string; warn?: boolean }) => (
  <div className="flex justify-between">
    <span className="text-muted">{k}</span>
    <span className={warn ? 'text-down' : ''}>{v}</span>
  </div>
)
