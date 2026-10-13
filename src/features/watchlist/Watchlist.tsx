import { useMemo, useState } from 'react'
import { ArrowDownUp, Plus, X } from 'lucide-react'
import { execute } from '../../core/commands'
import { LINK_COLORS } from '../../core/types'
import { getBars, symbolInfo } from '../../data/feed'
import { useApp, useCharts } from '../../store'
import { useFlash, useQuote, useTick } from '../../ui/hooks'
import { IconButton, Popover, cx, fmt } from '../../ui/primitives'
import SymbolSearch from '../chart/SymbolSearch'
import { livePrice, prevClosePrice } from '../../data/feed'

type Sort = 'manual' | 'change' | 'symbol'

export default function Watchlist() {
  const { watchlists, activeWatchlist, setWatchlist, addToWatchlist } = useCharts()
  const wl = watchlists.find((w) => w.id === activeWatchlist) ?? watchlists[0]
  const [sort, setSort] = useState<Sort>('manual')
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
  const pts = useMemo(() => {
    const b = getBars(symbol, '1H').slice(-48)
    const lo = Math.min(...b.map((x) => x.close))
    const hi = Math.max(...b.map((x) => x.close))
    return b.map((x, i) => `${(i / (b.length - 1)) * 44},${14 - ((x.close - lo) / (hi - lo || 1)) * 12}`).join(' ')
  }, [symbol])
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
        {fmt.price(q.last)}
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
