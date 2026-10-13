import { useMemo, useState } from 'react'
import { Reorder, AnimatePresence, motion } from 'motion/react'
import { ArrowRight, Boxes, Code2, FlaskConical, GitBranch, GripVertical, Plus, ShieldAlert, Trash2, Wallet, X, Copy } from 'lucide-react'
import { execute } from '../../core/commands'
import { TIMEFRAMES } from '../../core/types'
import { SYMBOLS } from '../../data/feed'
import { newCondition, newGroup, uid, exampleStrategy, type Comparator, type Condition, type Group, type Operand, type OperandKind, type StrategyDefinition } from '../../builder/model'
import { toPine } from '../../builder/codegen'
import { useApp, useBacktests, useBuilder } from '../../store'
import { Button, IconButton, Segmented, Select, cx } from '../../ui/primitives'

const KINDS: { v: OperandKind; l: string }[] = [
  { v: 'price', l: 'Price' },
  { v: 'sma', l: 'SMA' },
  { v: 'ema', l: 'EMA' },
  { v: 'rsi', l: 'RSI' },
  { v: 'atr', l: 'ATR' },
  { v: 'macd', l: 'MACD hist' },
  { v: 'volume', l: 'Volume' },
  { v: 'value', l: 'Value' },
]
const CMPS: Comparator[] = ['>', '<', 'crosses above', 'crosses below']

function updateNode(g: Group, id: string, fn: (n: Condition | Group) => Condition | Group | null): Group {
  return {
    ...g,
    children: g.children
      .map((c) => (c.id === id ? fn(c) : c.type === 'group' ? updateNode(c, id, fn) : c))
      .filter(Boolean) as (Condition | Group)[],
  }
}

export default function StrategyBuilder() {
  const { defs, activeId, setDef, addDef, setActive } = useBuilder()
  const def = defs.find((d) => d.id === activeId) ?? defs[0]
  const [showCode, setShowCode] = useState(true)
  const [confirm, setConfirm] = useState(false)
  const running = useBacktests((s) => s.running)
  const pine = useMemo(() => (def ? toPine(def) : ''), [def])
  if (!def) return null
  const set = (patch: Partial<StrategyDefinition>) => setDef({ ...def, ...patch })
  const editGroup = (which: 'entry' | 'exit') => ({
    root: def[which],
    onChange: (g: Group) => set({ [which]: g } as Partial<StrategyDefinition>),
  })
  const backtest = () => execute('backtest.runBuilder', { strategyId: def.id }).catch((e) => useApp.getState().toast({ title: e.message, tone: 'error' }))

  return (
    <div className="relative flex h-full bg-panel">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2">
          <Select value={def.id} onChange={(e) => setActive(e.target.value)} className="max-w-[160px] font-medium">
            {defs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <IconButton label="New strategy" onClick={() => addDef({ ...exampleStrategy(), id: uid('s'), name: `Strategy ${defs.length + 1}`, entry: newGroup('all'), exit: newGroup('any', [{ ...newCondition(), cmp: 'crosses below' }]) })}>
            <Plus size={14} />
          </IconButton>
          <IconButton label="Duplicate" onClick={() => addDef({ ...structuredClone(def), id: uid('s'), name: def.name + ' copy' })}>
            <Copy size={13} />
          </IconButton>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => setShowCode(!showCode)}>
            <Code2 size={13} /> {showCode ? 'Hide' : 'Show'} Pine
          </Button>
          <Button size="sm" onClick={() => setConfirm(true)}>
            <ArrowRight size={13} /> To Pine editor
          </Button>
          <Button size="sm" variant="primary" onClick={backtest} disabled={running}>
            <FlaskConical size={13} /> {running ? 'Running…' : 'Backtest'}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mx-auto flex max-w-[720px] flex-col">
            {/* Root */}
            <Card tone="root" icon={<Boxes size={14} />} title="Strategy">
              <div className="flex flex-wrap items-center gap-2">
                <input value={def.name} onChange={(e) => set({ name: e.target.value })} className="h-7 min-w-[160px] flex-1 rounded-md border border-line bg-panel px-2 text-[13px] font-semibold outline-none focus:border-accent/60" />
                <Select value={def.symbol} onChange={(e) => set({ symbol: e.target.value })}>
                  {SYMBOLS.map((s) => (
                    <option key={s.symbol}>{s.symbol}</option>
                  ))}
                </Select>
                <Select value={def.tf} onChange={(e) => set({ tf: e.target.value as StrategyDefinition['tf'] })}>
                  {TIMEFRAMES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
                <Segmented layoutId={`dir-${def.id}`} value={def.direction} onChange={(v) => set({ direction: v })} options={[{ value: 'long', label: 'Long' }, { value: 'short', label: 'Short' }]} />
              </div>
            </Card>
            <Connector />
            <Card tone="entry" icon={<GitBranch size={14} />} title="Enter when">
              <GroupEditor group={def.entry} {...editGroup('entry')} depth={0} />
            </Card>
            <Connector />
            <Card tone="alloc" icon={<Wallet size={14} />} title={`Allocate · ${def.direction === 'long' ? 'buy' : 'sell short'} ${def.symbol}`}>
              <div className="flex items-center gap-3">
                <input type="range" min={5} max={100} step={5} value={def.sizePct} onChange={(e) => set({ sizePct: Number(e.target.value) })} className="flex-1 accent-[var(--accent)]" />
                <span className="num w-24 text-right text-[13px] font-semibold">{def.sizePct}% equity</span>
              </div>
            </Card>
            <Connector />
            <Card tone="exit" icon={<GitBranch size={14} className="rotate-180" />} title="Exit when">
              <GroupEditor group={def.exit} {...editGroup('exit')} depth={0} />
            </Card>
            <Connector />
            <Card tone="risk" icon={<ShieldAlert size={14} />} title="Risk">
              <div className="flex flex-wrap gap-4 text-[12px]">
                <RiskField label="Stop loss" value={def.stopPct} onChange={(v) => set({ stopPct: v })} />
                <RiskField label="Take profit" value={def.takePct} onChange={(v) => set({ takePct: v })} />
              </div>
            </Card>
          </div>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {showCode && (
          <motion.aside initial={{ width: 0, opacity: 0 }} animate={{ width: 340, opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 400, damping: 40 }} className="flex shrink-0 flex-col overflow-hidden border-l border-line bg-bg-2">
            <div className="flex h-10 shrink-0 items-center justify-between border-b border-line px-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Generated Pine · live preview</span>
            </div>
            <pre className="num min-h-0 flex-1 overflow-auto p-3 text-[11.5px] leading-relaxed text-muted">
              {pine.split('\n').filter((l) => !l.startsWith('// @oc-blocks')).map((l, i) => (
                <div key={i} className={cx(l.startsWith('//') && 'text-faint', /^(if|strategy)/.test(l.trim()) && 'text-accent')}>
                  {l || ' '}
                </div>
              ))}
            </pre>
            <div className="border-t border-line p-3 text-[11px] leading-relaxed text-faint">One-way generation. Only unmodified generated scripts can be reopened as blocks.</div>
          </motion.aside>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {confirm && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-30 grid place-items-center bg-black/40 backdrop-blur-[2px]">
            <motion.div initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 8 }} className="glass w-[380px] rounded-2xl p-5">
              <div className="mb-1 text-[14px] font-semibold">Send “{def.name}” to the Pine editor?</div>
              <p className="mb-4 text-[12.5px] leading-relaxed text-muted">A strategy script will be created (or updated) in your library. Generation is one-way — manual Pine edits can’t be mapped back to blocks.</p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirm(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    execute('strategy.generatePine', { strategyId: def.id })
                    setConfirm(false)
                  }}
                >
                  Generate script
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

const TONES = {
  root: 'var(--text)',
  entry: 'var(--accent)',
  alloc: 'var(--accent-2)',
  exit: 'var(--down)',
  risk: 'var(--demo)',
}
function Card({ tone, icon, title, children }: { tone: keyof typeof TONES; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  const c = TONES[tone]
  return (
    <motion.div layout className="relative overflow-hidden rounded-xl border border-line bg-panel-2" style={{ boxShadow: `inset 3px 0 0 ${c}` }}>
      <div className="flex items-center gap-2 px-3.5 pb-1.5 pt-2.5 text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: c }}>
        {icon}
        {title}
      </div>
      <div className="px-3.5 pb-3">{children}</div>
    </motion.div>
  )
}
const Connector = () => (
  <div className="ml-6 flex h-5 items-center">
    <div className="h-full w-px bg-gradient-to-b from-line-2 to-line" />
  </div>
)

function GroupEditor({ group, root, onChange, depth }: { group: Group; root: Group; onChange: (g: Group) => void; depth: number }) {
  const patch = (id: string, fn: (n: Condition | Group) => Condition | Group | null) => onChange(group.id === root.id && id === root.id ? (fn(root) as Group) : updateNode(root, id, fn))
  const setChildren = (children: (Condition | Group)[]) => patch(group.id, (g) => ({ ...(g as Group), children }))
  return (
    <div className={cx(depth > 0 && 'rounded-lg border border-dashed border-line-2 bg-panel/60 p-2')}>
      <div className="mb-1.5 flex items-center gap-2 text-[12px] text-muted">
        <span>If</span>
        <Segmented layoutId={`op-${group.id}`} value={group.op} onChange={(op) => patch(group.id, (g) => ({ ...(g as Group), op }))} options={[{ value: 'all', label: 'all' }, { value: 'any', label: 'any' }]} />
        <span>of the following are true</span>
        {depth > 0 && (
          <IconButton label="Remove group" className="ml-auto" onClick={() => patch(group.id, () => null)}>
            <X size={13} />
          </IconButton>
        )}
      </div>
      <Reorder.Group axis="y" values={group.children} onReorder={setChildren} className="flex flex-col gap-1.5">
        {group.children.map((c) => (
          <Reorder.Item key={c.id} value={c} className="relative" whileDrag={{ scale: 1.01, zIndex: 5 }}>
            {c.type === 'group' ? (
              <div className="flex gap-1">
                <Grip />
                <div className="flex-1">
                  <GroupEditor group={c} root={root} onChange={onChange} depth={depth + 1} />
                </div>
              </div>
            ) : (
              <ConditionRow c={c} onChange={(n) => patch(c.id, () => n)} onRemove={() => patch(c.id, () => null)} />
            )}
          </Reorder.Item>
        ))}
      </Reorder.Group>
      {!group.children.length && <div className="rounded-lg border border-dashed border-line-2 px-3 py-2 text-[12px] text-faint">No conditions — this block never triggers.</div>}
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => setChildren([...group.children, newCondition()])}>
          <Plus size={12} /> Condition
        </Button>
        {depth < 2 && (
          <Button size="sm" variant="ghost" onClick={() => setChildren([...group.children, newGroup(group.op === 'all' ? 'any' : 'all')])}>
            <GitBranch size={12} /> Nested group
          </Button>
        )}
      </div>
    </div>
  )
}
const Grip = () => (
  <span className="flex w-4 shrink-0 cursor-grab items-center justify-center text-faint active:cursor-grabbing">
    <GripVertical size={13} />
  </span>
)

function ConditionRow({ c, onChange, onRemove }: { c: Condition; onChange: (c: Condition) => void; onRemove: () => void }) {
  return (
    <div className="group flex items-center gap-1.5 rounded-lg bg-panel px-1.5 py-1.5 ring-1 ring-line hover:ring-line-2">
      <Grip />
      <OperandEditor o={c.left} onChange={(left) => onChange({ ...c, left })} />
      <Select value={c.cmp} onChange={(e) => onChange({ ...c, cmp: e.target.value as Comparator })} className="font-medium text-accent">
        {CMPS.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </Select>
      <OperandEditor o={c.right} onChange={(right) => onChange({ ...c, right })} />
      <div className="flex-1" />
      <IconButton label="Remove condition" className="opacity-0 group-hover:opacity-100" onClick={onRemove}>
        <Trash2 size={12} />
      </IconButton>
    </div>
  )
}

function OperandEditor({ o, onChange }: { o: Operand; onChange: (o: Operand) => void }) {
  const num = 'num h-7 w-14 rounded-md border border-line bg-panel-2 px-1.5 text-right text-[12px] outline-none focus:border-accent/60'
  return (
    <div className="flex items-center gap-1">
      <Select
        value={o.kind}
        onChange={(e) => {
          const kind = e.target.value as OperandKind
          onChange(kind === 'value' ? { kind, value: 50 } : kind === 'price' ? { kind, field: 'close' } : ['sma', 'ema', 'rsi', 'atr'].includes(kind) ? { kind, length: kind === 'rsi' || kind === 'atr' ? 14 : 20 } : { kind })
        }}
      >
        {KINDS.map((k) => (
          <option key={k.v} value={k.v}>
            {k.l}
          </option>
        ))}
      </Select>
      {o.kind === 'price' && (
        <Select value={o.field} onChange={(e) => onChange({ ...o, field: e.target.value as Operand['field'] })}>
          {['close', 'open', 'high', 'low'].map((f) => (
            <option key={f}>{f}</option>
          ))}
        </Select>
      )}
      {['sma', 'ema', 'rsi', 'atr'].includes(o.kind) && <input type="number" min={1} max={500} value={o.length} onChange={(e) => onChange({ ...o, length: Math.max(1, Number(e.target.value)) })} className={num} />}
      {o.kind === 'value' && <input type="number" value={o.value} onChange={(e) => onChange({ ...o, value: Number(e.target.value) })} className={num} />}
    </div>
  )
}

function RiskField({ label, value, onChange }: { label: string; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={value !== null} onChange={(e) => onChange(e.target.checked ? 5 : null)} className="accent-[var(--accent)]" />
      <span className="text-muted">{label}</span>
      <input type="number" min={0.5} step={0.5} disabled={value === null} value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))} className="num h-7 w-16 rounded-md border border-line bg-panel px-1.5 text-right text-[12px] outline-none disabled:opacity-40" />
      <span className="text-faint">%</span>
    </label>
  )
}
