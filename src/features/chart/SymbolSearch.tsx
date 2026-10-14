import { useEffect, useState } from 'react'
import { SYMBOLS, searchMarket, isDemoData, type Instrument } from '../../data/feed'
import { Input, cx, fmt } from '../../ui/primitives'

export default function SymbolSearch({ onPick, autoFocus = true }: { onPick: (s: string) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const [remote,setRemote]=useState<Instrument[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(''),[provider,setProvider]=useState('')
  const ql = q.toLowerCase()
  const list = q.trim() && !isDemoData() ? remote : SYMBOLS.filter((s) => (s.symbol + s.name + s.sector).toLowerCase().includes(ql))
  useEffect(()=>{if(!q.trim()||isDemoData())return;let cancelled=false;const timer=setTimeout(()=>{setLoading(true);setError('');void searchMarket(q,provider||undefined).then(values=>{if(!cancelled)setRemote(values)}).catch(e=>{if(!cancelled){setError(String(e));setRemote([])}}).finally(()=>{if(!cancelled)setLoading(false)})},300);return()=>{cancelled=true;clearTimeout(timer)}},[q,provider])
  return (
    <div>
      {!isDemoData()&&<select aria-label="Search provider" value={provider} onChange={e=>setProvider(e.target.value)} className="mb-2 w-full rounded bg-panel-2 p-1 text-xs"><option value="">All configured providers</option><option value="yahoo">Yahoo equities / ETFs</option><option value="coinbase">Coinbase products</option><option value="alpaca">Alpaca instruments</option></select>}
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
        {loading&&<p className="p-2 text-xs text-muted">Searching provider instruments…</p>}
        {error&&<p role="alert" className="p-2 text-xs text-down">{error}</p>}
        {!list.length&&!loading&&!error && <div className="p-3 text-center text-[12px] text-muted">No instrument matches "{q}"</div>}
      </div>
    </div>
  )
}

function Row({ sym, name, ex, active, onClick }: { sym: string; name: string; ex: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cx('flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left', active ? 'bg-accent/14' : 'hover:bg-panel-3/70')}>
      <span className="w-16 font-semibold">{sym}</span>
      <span className="flex-1 truncate text-[12px] text-muted">{name}</span>
      <span className="text-[10.5px] text-faint">{ex}</span>
      <span className="text-xs text-muted">View</span>
    </button>
  )
}
