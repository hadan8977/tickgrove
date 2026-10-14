import { useMemo, useState } from 'react'
import { ArrowDownUp, Plus, X, Settings2 } from 'lucide-react'
import { execute } from '../../core/commands'
import { LINK_COLORS } from '../../core/types'
import { getBars, symbolInfo } from '../../data/feed'
import { useApp, useCharts } from '../../store'
import { useFlash, useQuote, useTick } from '../../ui/hooks'
import { IconButton, Popover, Input, Button, cx, fmt } from '../../ui/primitives'
import SymbolSearch from '../chart/SymbolSearch'
import { livePrice, prevClosePrice } from '../../data/feed'

type Sort = 'manual' | 'change' | 'symbol'

export default function Watchlist() {
  const { watchlists, activeWatchlist, setWatchlist, addToWatchlist } = useCharts()
  const wl = watchlists.find((w) => w.id === activeWatchlist) ?? watchlists[0]
  const [sort, setSort] = useState<Sort>('manual')
  const [name,setName]=useState('')
  useTick()
  const symbols = useMemo(() => {
    const s = [...wl.symbols]
    if (sort === 'symbol') s.sort()
    if (sort === 'change') s.sort((a, b) => livePrice(b) / prevClosePrice(b) - livePrice(a) / prevClosePrice(a))
    return s
  }, [wl.symbols, sort, sort === 'change' ? Math.floor(Date.now() / 3000) : 0])
  const activeChart = useCharts((s) => s.charts[useApp.getState().activeChartId ?? ''])
  useApp((s) => s.activeChartId)
  return (
    <div className="@container flex h-full flex-col bg-panel" title="Click a row to load it into the active chart">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <div className="no-scrollbar flex min-w-0 flex-1 gap-0.5 overflow-x-auto [mask-image:linear-gradient(90deg,#000_85%,transparent)]">
          {watchlists.map((w) => (
            <button key={w.id} onClick={() => setWatchlist(w.id)} className={cx('h-6 shrink-0 rounded-md px-2 text-[11.5px] font-medium', w.id === wl.id ? 'bg-panel-3 text-text' : 'text-muted hover:text-text')}>
              {w.name}
            </button>
          ))}
        </div>
        <IconButton label={`Sort: ${sort}`} active={sort !== 'manual'} onClick={() => setSort(sort === 'manual' ? 'change' : sort === 'change' ? 'symbol' : 'manual')}>
          <ArrowDownUp size={13} />
        </IconButton>
        <Popover align="right" trigger={({toggle})=><IconButton label="Manage watchlists" onClick={toggle}><Settings2 size={13}/></IconButton>}><div className="w-64 space-y-2 p-2 text-xs"><Input placeholder="Watchlist name" value={name} onChange={e=>setName(e.target.value)}/><div className="flex gap-2"><Button size="sm" onClick={()=>{useCharts.getState().createWatchlist(name);setName('')}}>Create</Button><Button size="sm" disabled={!name.trim()} onClick={()=>{useCharts.getState().renameWatchlist(wl.id,name);setName('')}}>Rename current</Button></div><Button size="sm" disabled={watchlists.length<2} onClick={()=>useCharts.getState().deleteWatchlist(wl.id)}>Delete current list</Button><Button size="sm" onClick={()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({name:wl.name,symbols:wl.symbols},null,2)],{type:'application/json'}));a.download='watchlist.json';a.click();URL.revokeObjectURL(a.href)}}>Export list</Button><label className="block">Import list JSON<input className="mt-1 max-w-full" type="file" accept=".json" onChange={e=>{const file=e.target.files?.[0];if(file)void file.text().then(text=>{const data=JSON.parse(text);if(!Array.isArray(data.symbols)||data.symbols.some((x:unknown)=>typeof x!=='string'||!x)||data.symbols.length>1000)throw Error('Expected up to 1000 symbol strings');useCharts.getState().createWatchlist(String(data.name??file.name),data.symbols)}).catch(error=>useApp.getState().toast({title:String(error),tone:'error'}))}}/></label><p className="text-faint">Drag a symbol onto another row to change manual order.</p></div></Popover>
        <Popover align="right" className="w-[320px]" trigger={({ toggle }) => <IconButton label="Add symbol" onClick={toggle}><Plus size={14} /></IconButton>}>
          {(close) => <SymbolSearch onPick={(s) => (addToWatchlist(s), close())} />}
        </Popover>
      </div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-wider text-faint">
        <span>Symbol</span>
        <span className="w-[72px] text-right">Last</span>
        <span className="w-[58px] text-right">Chg%</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
        {symbols.map((s) => (
          <Row key={s} symbol={s} active={activeChart?.symbol === s} groupColor={activeChart?.group ? LINK_COLORS[activeChart.group] : undefined} />
        ))}
      </div>
    </div>
  )
}

function Spark({ symbol, up }: { symbol: string; up: boolean }) {
  const tick=useTick()
  const pts = useMemo(() => {
    const b = getBars(symbol, '1D').slice(-48)
    if(b.length<2)return ''
    const lo = Math.min(...b.map((x) => x.close))
    const hi = Math.max(...b.map((x) => x.close))
    return b.map((x, i) => `${(i / (b.length - 1)) * 44},${14 - ((x.close - lo) / (hi - lo || 1)) * 12}`).join(' ')
  }, [symbol,tick])
  return (
    <svg width="44" height="16" className="hidden shrink-0 opacity-80 @min-[290px]:block">
      <polyline points={pts} fill="none" stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth="1.2" />
    </svg>
  )
}

function Row({ symbol, active, groupColor }: { symbol: string; active: boolean; groupColor?: string }) {
  const q = useQuote(symbol)
  const f = useFlash(q.last)
  const info = symbolInfo(symbol)
  const up = q.change >= 0
  return (
    <div
      role="button"
      draggable
      onDragStart={e=>e.dataTransfer.setData('application/x-trading-symbol',symbol)}
      onDragOver={e=>e.preventDefault()}
      onDrop={e=>{e.preventDefault();const moved=e.dataTransfer.getData('application/x-trading-symbol');useCharts.getState().reorderWatchlist(useCharts.getState().activeWatchlist,moved,symbol)}}
      onClick={() => execute('chart.setSymbol', { symbol })}
      className={cx('group relative grid cursor-pointer grid-cols-[1fr_auto_auto] items-center gap-x-3 rounded-lg px-2 py-1.5 transition-colors', active ? 'bg-panel-3' : 'hover:bg-panel-2')}
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12.5px] font-semibold leading-tight">{symbol}{active && groupColor && <span className="size-1.5 rounded-full" style={{ background: groupColor }} title="Linked group" />}</div>
          <div className="truncate text-[10.5px] leading-tight text-faint">{info.name}</div>
        </div>
        <div className="flex-1" />
        <Spark symbol={symbol} up={up} />
      </div>
      <span key={f.k} className={cx('num w-[72px] rounded px-1 text-right text-[12.5px]', f.dir === 'up' && 'flash-up', f.dir === 'down' && 'flash-down')}>
        {q.format(q.last)}
      </span>
      <span className={cx('num w-[58px] rounded px-1 py-0.5 text-right text-[11.5px] font-medium', up ? 'text-up bg-up/10' : 'text-down bg-down/10')}>{fmt.pct(q.changePct)}</span>
      <button
        onClick={(e) => {
          e.stopPropagation()
          useCharts.getState().removeFromWatchlist(symbol)
        }}
        className="absolute -right-0.5 top-1/2 hidden -translate-y-1/2 rounded p-0.5 text-faint hover:text-down group-hover:block"
        title="Remove"
      >
        <X size={11} />
      </button>
    </div>
  )
}
