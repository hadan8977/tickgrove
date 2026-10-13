import { useState } from 'react'
import { SYMBOLS } from '../../data/feed'
import { useQuote } from '../../ui/hooks'
import { Input, cx, fmt } from '../../ui/primitives'

export default function SymbolSearch({ onPick, autoFocus = true }: { onPick: (s: string) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const ql = q.toLowerCase()
  const list = SYMBOLS.filter((s) => (s.symbol + s.name + s.sector).toLowerCase().includes(ql))
  return (
    <div>
      <Input
        autoFocus={autoFocus}
        placeholder="Search symbol, company or sector"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setIdx(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setIdx((i) => Math.min(i + 1, list.length - 1))
          if (e.key === 'ArrowUp') setIdx((i) => Math.max(i - 1, 0))
          if (e.key === 'Enter' && list[idx]) onPick(list[idx].symbol)
        }}
      />
      <div className="mt-1.5 max-h-[320px] overflow-auto">
        {list.map((s, i) => (
          <Row key={s.symbol} sym={s.symbol} name={s.name} ex={s.exchange} active={i === idx} onClick={() => onPick(s.symbol)} />
        ))}
        {!list.length && <div className="p-3 text-center text-[12px] text-muted">No demo symbol matches "{q}"</div>}
      </div>
    </div>
  )
}

function Row({ sym, name, ex, active, onClick }: { sym: string; name: string; ex: string; active: boolean; onClick: () => void }) {
  const q = useQuote(sym)
  return (
    <button onClick={onClick} className={cx('flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left', active ? 'bg-accent/14' : 'hover:bg-panel-3/70')}>
      <span className="w-16 font-semibold">{sym}</span>
      <span className="flex-1 truncate text-[12px] text-muted">{name}</span>
      <span className="text-[10.5px] text-faint">{ex}</span>
      <span className={cx('num w-16 text-right text-[12px]', q.change >= 0 ? 'text-up' : 'text-down')}>{fmt.pct(q.changePct)}</span>
    </button>
  )
}
