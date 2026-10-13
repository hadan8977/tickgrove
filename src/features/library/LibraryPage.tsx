import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { ArrowUpRight, Boxes, FileCode2, FlaskConical, LineChart, Loader2, Play, Rocket, Search, SquarePen } from 'lucide-react'
import { execute } from '../../core/commands'
import { detectKind, parseInputs } from '../../pine/runtime'
import { toPine } from '../../builder/codegen'
import type { Condition, Group, Operand, StrategyDefinition } from '../../builder/model'
import type { BacktestResult, Script } from '../../core/types'
import { useApp, useBacktests, useBuilder, useCharts, useScripts } from '../../store'
import { Button, Segmented, cx, fmt } from '../../ui/primitives'
import { openPanel } from '../workspace/dock'

type Filter = 'all' | 'scripts' | 'strategies' | 'runs'
type Item =
  | { key: string; type: 'indicator' | 'strategy'; group: 'Pine scripts'; name: string; meta: string; script: Script }
  | { key: string; type: 'visual'; group: 'Visual strategies'; name: string; meta: string; def: StrategyDefinition }
  | { key: string; type: 'run'; group: 'Backtest runs'; name: string; meta: string; run: BacktestResult }

const TYPE: Record<Item['type'], { tag: string; label: string }> = {
  indicator: { tag: 'IND', label: 'Pine indicator' },
  strategy: { tag: 'STR', label: 'Pine strategy' },
  visual: { tag: 'VIS', label: 'Visual strategy' },
  run: { tag: 'RUN', label: 'Backtest run' },
}
const SPRING = { type: 'spring', stiffness: 460, damping: 36 } as const

const goWorkspace = (fn: () => void) => {
  useApp.getState().setView('workspace')
  setTimeout(fn, 60)
}
const notify = (p: Promise<unknown>) => p.catch((e) => useApp.getState().toast({ title: e.message, tone: 'error' }))

export default function LibraryPage() {
  const scripts = useScripts((s) => s.scripts)
  const defs = useBuilder((s) => s.defs)
  const results = useBacktests((s) => s.results)
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const all = useMemo<Item[]>(
    () => [
      ...scripts.map((s) => {
        const k = detectKind(s.source)
        return { key: 's:' + s.id, type: k, group: 'Pine scripts' as const, name: s.name, meta: `${s.origin ?? 'user'} · ${s.source.split('\n').length} lines`, script: s }
      }),
      ...defs.map((d) => ({ key: 'b:' + d.id, type: 'visual' as const, group: 'Visual strategies' as const, name: d.name, meta: `${d.symbol} · ${d.tf} · ${d.direction}`, def: d })),
      ...results.map((r) => ({ key: 'r:' + r.id, type: 'run' as const, group: 'Backtest runs' as const, name: r.name, meta: `${r.symbol} · ${r.tf} · ${new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, run: r })),
    ],
    [scripts, defs, results],
  )
  const items = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return all.filter((i) => {
      if (filter === 'scripts' && i.group !== 'Pine scripts') return false
      if (filter === 'strategies' && !(i.type === 'strategy' || i.type === 'visual')) return false
      if (filter === 'runs' && i.type !== 'run') return false
      return !ql || (i.name + ' ' + i.meta + ' ' + TYPE[i.type].label).toLowerCase().includes(ql)
    })
  }, [all, filter, q])
  const current = items.find((i) => i.key === sel) ?? items[0]
  useEffect(() => {
    if (current && current.key !== sel) setSel(current.key)
  }, [current?.key])

  const move = (d: number) => {
    const i = Math.max(0, Math.min(items.length - 1, items.findIndex((x) => x.key === current?.key) + d))
    if (items[i]) {
      setSel(items[i].key)
      listRef.current?.querySelector(`[data-k="${items[i].key}"]`)?.scrollIntoView({ block: 'nearest' })
    }
  }
  const counts = { all: all.length, scripts: scripts.length, strategies: all.filter((i) => i.type === 'strategy' || i.type === 'visual').length, runs: results.length }
  let lastGroup = ''

  return (
    <LayoutGroup id="library">
      <div className="flex h-full min-h-0 gap-2 pb-2 pl-0.5 pr-2 pt-1.5">
        {/* ── browse ── */}
        <section
          className="glass flex w-[300px] shrink-0 flex-col overflow-hidden rounded-2xl xl:w-[360px]"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), move(1))
            if (e.key === 'ArrowUp') (e.preventDefault(), move(-1))
            if (e.key === 'Enter' && current && (e.target as HTMLElement).tagName !== 'BUTTON') primaryAction(current)?.run()
          }}
        >
          <div className="px-3.5 pb-2.5 pt-3.5">
            <div className="flex items-baseline justify-between">
              <h1 className="text-[15px] font-semibold tracking-[-0.01em]">Library</h1>
              <span className="num text-[11px] text-faint">{all.length} assets · local</span>
            </div>
            <label className="mt-2.5 flex h-8 items-center gap-2 rounded-lg bg-panel/70 px-2.5 shadow-[inset_0_0_0_1px_var(--line)] transition-shadow focus-within:shadow-[inset_0_0_0_1px_var(--line-2),0_0_0_3px_color-mix(in_srgb,var(--aura-1)_25%,transparent)]">
              <Search size={13} className="text-faint" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find scripts, strategies, runs" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint" />
            </label>
            <div className="mt-2.5">
              <Segmented
                layoutId="lib-filter"
                value={filter}
                onChange={setFilter}
                options={(['all', 'scripts', 'strategies', 'runs'] as const).map((f) => ({
                  value: f,
                  label: (
                    <>
                      <span className="capitalize">{f}</span>
                      <span className="num text-[10px] text-faint">{counts[f]}</span>
                    </>
                  ),
                }))}
              />
            </div>
          </div>
          <div ref={listRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 outline-none">
            {items.map((it) => {
              const header = it.group !== lastGroup
              lastGroup = it.group
              const active = it.key === current?.key
              return (
                <div key={it.key}>
                  {header && <div className="px-2 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint first:pt-1">{it.group}</div>}
                  <button data-k={it.key} onClick={() => setSel(it.key)} onDoubleClick={() => primaryAction(it)?.run()} className={cx('group relative flex w-full items-center gap-2.5 rounded-[10px] px-2 py-[7px] text-left transition-colors', active ? 'text-text' : 'text-text/85 hover:bg-panel-2/60')}>
                    {active && <motion.span layoutId="lib-sel" transition={SPRING} className="absolute inset-0 rounded-[10px] bg-panel-3/85 shadow-[inset_0_1px_0_var(--glass-edge),0_4px_14px_-6px_rgba(0,0,0,0.4)]" />}
                    <TypeTile item={it} />
                    <span className="relative min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium">{it.name}</span>
                      <span className="num block truncate text-[10.5px] text-faint">{it.meta}</span>
                    </span>
                    <RowStat item={it} />
                  </button>
                </div>
              )
            })}
            {!items.length && <ListEmpty filter={filter} q={q} onClear={() => (setQ(''), setFilter('all'))} />}
          </div>
          <div className="num flex items-center gap-3 whitespace-nowrap border-t border-line px-3.5 py-2 text-[10.5px] text-faint">
            <span>↑↓ browse</span>
            <span>↵ {current ? primaryAction(current)?.label.toLowerCase() : 'open'}</span>
            <span className="ml-auto hidden xl:inline">Stored in this browser</span>
          </div>
        </section>

        {/* ── preview ── */}
        <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_24px_60px_-30px_rgba(0,0,0,0.6)]">
          <AnimatePresence mode="popLayout" initial={false}>
            {current ? (
              <motion.div key={current.key} className="flex min-h-0 flex-1 flex-col" initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -6, filter: 'blur(4px)' }} transition={SPRING}>
                <Preview item={current} onSelect={setSel} />
              </motion.div>
            ) : (
              <div className="grid flex-1 place-items-center text-[12.5px] text-muted">Nothing selected</div>
            )}
          </AnimatePresence>
        </section>
      </div>
    </LayoutGroup>
  )
}

function TypeTile({ item, layoutId, size = 'sm' }: { item: Item; layoutId?: string; size?: 'sm' | 'lg' }) {
  const strong = item.type === 'strategy' || item.type === 'visual'
  return (
    <motion.span
      layoutId={layoutId}
      transition={SPRING}
      className={cx(
        'num relative grid shrink-0 place-items-center font-semibold tracking-[0.06em]',
        size === 'sm' ? 'size-7 rounded-lg text-[9px]' : 'size-11 rounded-xl text-[11px]',
        strong ? 'bg-text text-bg' : 'bg-panel-3 text-muted shadow-[inset_0_0_0_1px_var(--line-2)]',
        item.type === 'run' && '!bg-transparent !text-muted shadow-[inset_0_0_0_1px_var(--line-2)]',
      )}
    >
      {TYPE[item.type].tag}
    </motion.span>
  )
}

function RowStat({ item }: { item: Item }) {
  const runs = useBacktests((s) => s.results)
  const r = item.type === 'run' ? item.run : runs.find((x) => x.sourceRef === (item.type === 'visual' ? item.def.id : item.script.id))
  if (!r) return null
  return <span className={cx('num relative text-[11px] font-medium', r.metrics.netProfitPct >= 0 ? 'text-up' : 'text-down')}>{fmt.pct(r.metrics.netProfitPct)}</span>
}

function ListEmpty({ filter, q, onClear }: { filter: Filter; q: string; onClear: () => void }) {
  if (filter === 'runs' && !q)
    return (
      <div className="mx-1 mt-2 rounded-xl bg-panel/60 p-3 text-[12px] text-muted shadow-[inset_0_0_0_1px_var(--line)]">
        <div className="font-medium text-text">No runs this session</div>
        Runs are created when you test a strategy. Switch to <b className="font-medium text-text">Strategies</b>, pick one and press <b className="font-medium text-text">Run backtest</b> in the preview.
      </div>
    )
  return (
    <div className="px-3 py-6 text-center text-[12px] text-muted">
      Nothing matches{q ? ` “${q}”` : ''}.{' '}
      <button className="text-text underline-offset-2 hover:underline" onClick={onClear}>
        Clear filters
      </button>
    </div>
  )
}

/* ───────────── preview ───────────── */

function primaryAction(it: Item): { label: string; icon: typeof Play; run: () => void } | undefined {
  if (it.type === 'run') return { label: 'Open report', icon: ArrowUpRight, run: () => goWorkspace(() => (useBacktests.getState().setActive(it.run.id), openPanel('backtest'))) }
  if (it.type === 'visual') return { label: 'Open in builder', icon: SquarePen, run: () => goWorkspace(() => (useBuilder.getState().setActive(it.def.id), openPanel('builder'))) }
  return { label: 'Edit in Pine', icon: SquarePen, run: () => goWorkspace(() => (useScripts.getState().open(it.script.id), openPanel('pine'))) }
}

function Preview({ item, onSelect }: { item: Item; onSelect: (k: string) => void }) {
  const primary = primaryAction(item)!
  const chart = useCharts((s) => s.charts[useApp.getState().activeChartId ?? ''])
  const code = item.type === 'visual' ? toPine(item.def) : item.type === 'run' ? '' : item.script.source
  const inputs = item.type === 'indicator' || item.type === 'strategy' ? parseInputs(item.script.source) : []
  return (
    <>
      {/* header sits on glass so the field reads through */}
      <header className="glass relative shrink-0 !rounded-none !shadow-[inset_0_-1px_0_var(--line)]">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3 px-6 pb-5 pt-6">
          <div className="flex min-w-0 flex-1 items-center gap-3.5">
            <TypeTile item={item} size="lg" />
            <div className="min-w-0">
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-faint">{TYPE[item.type].label}</div>
              <h2 className="truncate text-[22px] font-semibold leading-tight tracking-[-0.02em]">{item.name}</h2>
              <div className="num mt-0.5 truncate text-[11.5px] text-muted">{item.meta}</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="primary" onClick={primary.run}>
              <primary.icon size={13} /> {primary.label}
            </Button>
            {(item.type === 'indicator' || item.type === 'strategy') && (
              <Button variant="ghost" title={`Apply to ${chart?.symbol ?? 'active chart'}`} onClick={() => goWorkspace(() => notify(execute('pine.addToChart', { scriptId: item.script.id })))}>
                <LineChart size={13} /> Add to chart
              </Button>
            )}
            {item.type === 'run' && (
              <Button variant="ghost" onClick={() => goWorkspace(() => notify(execute('paper.deploy', { backtestId: item.run.id })))}>
                <Rocket size={13} /> Deploy to paper
              </Button>
            )}
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto xl:grid xl:grid-cols-[minmax(0,1fr)_300px] xl:overflow-hidden">
        {item.type === 'run' ? <RunBody run={item.run} onSelect={onSelect} /> : <Code source={code} generated={item.type === 'visual'} />}
        <aside className="border-t border-line bg-bg-2/50 p-4 xl:min-h-0 xl:overflow-auto xl:border-l xl:border-t-0">
          {item.type === 'visual' && <Rules def={item.def} />}
          {inputs.length > 0 && (
            <Block title="Inputs">
              <div className="flex flex-wrap gap-1">
                {inputs.map((i) => (
                  <span key={i.name} className="num rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted shadow-[inset_0_0_0_1px_var(--line)]">
                    {i.title} <span className="text-text">{String(i.default)}</span>
                  </span>
                ))}
              </div>
            </Block>
          )}
          {item.type !== 'run' && <Runs item={item} onSelect={onSelect} />}
          {item.type === 'run' && <RunConfig run={item.run} />}
        </aside>
      </div>
    </>
  )
}

const Block = ({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) => (
  <div className="mb-5 last:mb-0">
    <div className="mb-2 flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">
      {title}
      {right}
    </div>
    {children}
  </div>
)

function Code({ source, generated }: { source: string; generated: boolean }) {
  const lines = source.split('\n')
  return (
    <div className="relative overflow-x-auto xl:min-h-0 xl:overflow-auto">
      {generated && <div className="sticky top-0 z-10 border-b border-line bg-panel/90 px-6 py-1.5 text-[11px] text-faint backdrop-blur">Generated Pine · read-only preview of the block strategy</div>}
      <pre className="num px-0 py-4 text-[12px] leading-[1.7]">
        {lines.map((l, i) => (
          <div key={i} className="flex">
            <span className="w-12 shrink-0 select-none pr-4 text-right text-faint/70">{i + 1}</span>
            <code className={cx('whitespace-pre pr-6', /^\s*\/\//.test(l) ? 'text-faint' : /^\s*(\/\/@version|strategy|indicator)\b/.test(l) ? 'text-accent-2' : 'text-text/90')}>{l || ' '}</code>
          </div>
        ))}
      </pre>
    </div>
  )
}

const opText = (o: Operand) => (o.kind === 'price' ? (o.field ?? 'close') : o.kind === 'value' ? String(o.value ?? 0) : `${o.kind.toUpperCase()}${o.length ? `(${o.length})` : ''}`)
function RuleList({ g }: { g: Group }) {
  return (
    <div className="space-y-1">
      {g.children.map((c, i) => (
        <div key={c.id} className="num flex items-center gap-1.5 text-[11.5px]">
          <span className="w-7 shrink-0 text-[10px] uppercase text-faint">{i === 0 ? 'if' : g.op === 'all' ? 'and' : 'or'}</span>
          {c.type === 'condition' ? (
            <span className="rounded-md bg-panel-2 px-1.5 py-0.5 shadow-[inset_0_0_0_1px_var(--line)]">
              {opText((c as Condition).left)} <span className="text-muted">{(c as Condition).cmp}</span> {opText((c as Condition).right)}
            </span>
          ) : (
            <span className="text-muted">({(c as Group).children.length} nested rules)</span>
          )}
        </div>
      ))}
    </div>
  )
}
function Rules({ def }: { def: StrategyDefinition }) {
  return (
    <>
      <Block title={`Entry · ${def.direction}`}>
        <RuleList g={def.entry} />
      </Block>
      <Block title="Exit">
        <RuleList g={def.exit} />
        {(def.stopPct || def.takePct) && (
          <div className="num mt-1.5 text-[11px] text-muted">
            {def.stopPct ? `stop ${def.stopPct}%` : ''} {def.takePct ? `· take ${def.takePct}%` : ''}
          </div>
        )}
      </Block>
    </>
  )
}

function Runs({ item, onSelect }: { item: Exclude<Item, { type: 'run' }>; onSelect: (k: string) => void }) {
  const ref = item.type === 'visual' ? item.def.id : item.script.id
  const allRuns = useBacktests((s) => s.results)
  const runs = useMemo(() => allRuns.filter((r) => r.sourceRef === ref), [allRuns, ref])
  const chart = useCharts((s) => s.charts[useApp.getState().activeChartId ?? ''])
  const [busy, setBusy] = useState(false)
  const target = item.type === 'visual' ? `${item.def.symbol} · ${item.def.tf}` : chart ? `${chart.symbol} · ${chart.tf}` : 'the active chart'
  const runIt = () => {
    setBusy(true)
    notify(item.type === 'visual' ? execute('backtest.runBuilder', { strategyId: item.def.id }) : execute('backtest.runScript', { scriptId: item.script.id })).finally(() => setBusy(false))
  }
  if (item.type === 'indicator')
    return (
      <Block title="Backtests">
        <p className="text-[12px] leading-relaxed text-muted">Indicators plot values but don't place trades, so they can't be backtested. Add it to a chart to inspect it, or reference it from a strategy.</p>
      </Block>
    )
  return (
    <Block
      title="Backtests"
      right={
        runs.length > 0 && (
          <button onClick={runIt} disabled={busy} className="flex items-center gap-1 normal-case tracking-normal text-muted hover:text-text disabled:opacity-50">
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />} Run again
          </button>
        )
      }
    >
      {runs.length === 0 ? (
        <div className="rounded-xl bg-panel p-3.5 shadow-[inset_0_0_0_1px_var(--line)]">
          <div className="flex items-center gap-2 text-[12.5px] font-medium">
            <FlaskConical size={13} className="text-muted" /> Not tested yet
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
            Runs on <span className="num text-text">{target}</span> demo data in a background worker. The report opens in your workspace and stays listed here.
          </p>
          <Button className="mt-3 w-full" onClick={runIt} disabled={busy}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} {busy ? 'Running…' : 'Run backtest'}
          </Button>
        </div>
      ) : (
        <div className="space-y-1">
          <AnimatePresence initial={false}>
            {runs.map((r) => (
              <motion.button layout key={r.id} initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={SPRING} onClick={() => onSelect('r:' + r.id)} className="num flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] hover:bg-panel-2">
                <Equity run={r} w={56} h={18} />
                <span className="flex-1 text-muted">
                  {r.symbol} · {r.tf} · {r.metrics.trades} tr
                </span>
                <span className={r.metrics.netProfitPct >= 0 ? 'text-up' : 'text-down'}>{fmt.pct(r.metrics.netProfitPct)}</span>
              </motion.button>
            ))}
          </AnimatePresence>
        </div>
      )}
    </Block>
  )
}

function Equity({ run, w, h }: { run: BacktestResult; w: number; h: number }) {
  const pts = useMemo(() => {
    const e = run.equity
    if (e.length < 2) return ''
    const step = Math.max(1, Math.floor(e.length / 160))
    const s = e.filter((_, i) => i % step === 0)
    const lo = Math.min(...s.map((x) => x.value))
    const hi = Math.max(...s.map((x) => x.value))
    return s.map((x, i) => `${((i / (s.length - 1)) * w).toFixed(1)},${(h - 1 - ((x.value - lo) / (hi - lo || 1)) * (h - 2)).toFixed(1)}`).join(' ')
  }, [run, w, h])
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0 overflow-visible" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={run.metrics.netProfitPct >= 0 ? 'var(--up)' : 'var(--down)'} strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function RunBody({ run, onSelect }: { run: BacktestResult; onSelect: (k: string) => void }) {
  const m = run.metrics
  const stats: [string, string, number | null][] = [
    ['Net profit', fmt.pct(m.netProfitPct), m.netProfitPct],
    ['Buy & hold', fmt.pct(m.buyHoldPct), m.buyHoldPct],
    ['Max drawdown', `${m.maxDrawdownPct.toFixed(1)}%`, null],
    ['Sharpe', m.sharpe.toFixed(2), null],
    ['Win rate', `${m.winRate.toFixed(1)}%`, null],
    ['Trades', String(m.trades), null],
  ]
  const src = run.source === 'pine' ? 's:' + run.sourceRef : 'b:' + run.sourceRef
  return (
    <div className="p-6 xl:min-h-0 xl:overflow-auto">
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl bg-line shadow-[inset_0_0_0_1px_var(--line)]">
        {stats.map(([k, v, tone]) => (
          <div key={k} className="bg-panel px-3.5 py-3">
            <div className="text-[10.5px] uppercase tracking-[0.08em] text-faint">{k}</div>
            <div className={cx('num mt-1 text-[18px] font-semibold tracking-[-0.01em]', tone === null ? '' : tone >= 0 ? 'text-up' : 'text-down')}>{v}</div>
          </div>
        ))}
      </div>
      <div className="mt-5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">Equity</div>
      <div className="mt-2 h-[160px] rounded-xl bg-bg-2/60 p-3 shadow-[inset_0_0_0_1px_var(--line)]">
        <EquityFill run={run} />
      </div>
      <button onClick={() => onSelect(src)} className="mt-4 flex items-center gap-1.5 text-[12px] text-muted hover:text-text">
        {run.source === 'pine' ? <FileCode2 size={13} /> : <Boxes size={13} />} Source: <span className="text-text">{run.name}</span> <ArrowUpRight size={12} />
      </button>
    </div>
  )
}
function EquityFill({ run }: { run: BacktestResult }) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(100, e.contentRect.width)))
    ro.observe(ref.current!)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={ref} className="h-full w-full">
      <Equity run={run} w={w} h={134} />
    </div>
  )
}
function RunConfig({ run }: { run: BacktestResult }) {
  const c = run.config
  const rows: [string, string][] = [
    ['Market', `${run.symbol} · ${run.tf}`],
    ['Capital', c.capital.toLocaleString('en-US')],
    ['Position size', `${c.sizePct}%`],
    ['Commission', `${c.commissionBps} bps`],
    ['Slippage', `${c.slippageBps} bps`],
    ['Created', new Date(run.createdAt).toLocaleString()],
  ]
  return (
    <Block title="Configuration">
      <dl className="num space-y-1.5 text-[11.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-faint">{k}</dt>
            <dd className="truncate text-text/90">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[11px] leading-relaxed text-faint">Demo data, simulated fills. Not indicative of live results.</p>
    </Block>
  )
}
