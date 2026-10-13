import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CornerDownLeft, Search } from 'lucide-react'
import { execute } from '../../core/commands'
import { useApp, useCharts, useScripts, useWorkspaces } from '../../store'
import { useCommands } from '../../ui/hooks'
import { SYMBOLS } from '../../data/feed'
import { Kbd, cx } from '../../ui/primitives'
import { PRESETS } from '../workspace/dock'
import { pulseField } from './Shader'
import { listIndicators } from '../../indicators/registry'

interface Item {
  id: string
  title: string
  group: string
  hint?: string
  shortcut?: string
  run: () => unknown
}

const fmtKey = (k?: string) => k?.replace('Mod', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl').replace('Alt', '⌥').split('+')

export default function CommandPalette() {
  const open = useApp((s) => s.paletteOpen)
  const setOpen = useApp((s) => s.setPalette)
  const { commands } = useCommands()
  const scripts = useScripts((s) => s.scripts)
  const workspaces = useWorkspaces((s) => s.workspaces)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    const ql = q.trim().toLowerCase()
    // smart: symbol
    for (const s of SYMBOLS) out.push({ id: 'sym' + s.symbol, title: `${s.symbol} — ${s.name}`, group: 'Symbols', hint: 'chart.setSymbol', run: () => execute('chart.setSymbol', { symbol: s.symbol }, 'palette') })
    for (const c of commands.filter((c) => !c.hidden && !c.params?.symbol?.required && !Object.values(c.params ?? {}).some((p) => p.required)))
      out.push({ id: c.id, title: c.title, group: c.category, hint: c.id, shortcut: c.shortcut, run: () => execute(c.id, {}, 'palette') })
    for (const p of PRESETS) out.push({ id: 'layout' + p.id, title: `Layout: ${p.label}`, group: 'Workspace', hint: p.hint, run: () => execute('workspace.applyLayout', { preset: p.id }, 'palette') })
    for (const w of workspaces) out.push({ id: 'ws' + w.id, title: `Switch to “${w.name}”`, group: 'Workspace', hint: 'workspace.switch', run: () => execute('workspace.switch', { id: w.id }, 'palette') })
    for (const i of listIndicators()) out.push({ id: 'ind' + i.id, title: `Add ${i.name}`, group: 'Indicator', hint: 'indicator.add', run: () => execute('indicator.add', { indicator: i.id }, 'palette') })
    for (const s of scripts) out.push({ id: 'pine' + s.id, title: `Add “${s.name}” to chart`, group: 'Pine', hint: 'pine.addToChart', run: () => execute('pine.addToChart', { scriptId: s.id }, 'palette') })
    for (const p of ['watchlist', 'detail', 'pine', 'builder', 'backtest', 'ticket', 'positions']) out.push({ id: 'panel' + p, title: `Open ${p} panel`, group: 'Panels', hint: 'panel.open', run: () => execute('panel.open', { panel: p }, 'palette') })
    out.push({ id: 'buy', title: 'Paper buy 10 of active symbol', group: 'Paper', hint: 'paper.placeOrder', run: () => {
      const s = useCharts.getState().charts[useApp.getState().activeChartId ?? '']?.symbol ?? 'NVDA'
      return execute('paper.placeOrder', { symbol: s, side: 'buy', qty: 10 }, 'palette')
    } })
    if (!ql) return out.filter((i) => i.group !== 'Symbols' || ['NVDA', 'AAPL', 'SPY', 'BTCUSD'].some((s) => i.id === 'sym' + s))
    return out
      .map((i) => {
        const t = (i.title + ' ' + (i.hint ?? '') + ' ' + i.group).toLowerCase()
        const score = i.title.toLowerCase().startsWith(ql) ? 3 : t.includes(ql) ? 2 : ql.split(' ').every((w) => t.includes(w)) ? 1 : 0
        return { i, score }
      })
      .filter((x) => x.score)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.i)
      .slice(0, 60)
  }, [q, commands, scripts, workspaces])

  useEffect(() => {
    if (open) {
      pulseField(0.5, 0.15)
      setQ('')
      setIdx(0)
    }
  }, [open])
  useEffect(() => {
    list.current?.querySelector(`[data-i="${idx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  const run = (it: Item) => {
    setOpen(false)
    Promise.resolve(it.run()).catch((e) => useApp.getState().toast({ title: e.message, tone: 'error' }))
  }
  let lastGroup = ''
  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="fixed inset-0 z-[70] flex justify-center bg-bg/30 pt-[12vh] backdrop-blur-[3px]" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <motion.div initial={{ y: -14, scale: 0.96, opacity: 0, filter: 'blur(8px)' }} animate={{ y: 0, scale: 1, opacity: 1, filter: 'blur(0px)' }} exit={{ y: -8, scale: 0.98, opacity: 0, filter: 'blur(4px)' }} transition={{ type: 'spring', stiffness: 420, damping: 32 }} className="glass flex h-fit max-h-[62vh] w-[620px] flex-col overflow-hidden rounded-2xl">
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <Search size={16} className="text-faint" />
              <input
                autoFocus
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  setIdx(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') (e.preventDefault(), setIdx((i) => Math.min(i + 1, items.length - 1)))
                  if (e.key === 'ArrowUp') (e.preventDefault(), setIdx((i) => Math.max(i - 1, 0)))
                  if (e.key === 'Enter' && items[idx]) run(items[idx])
                  if (e.key === 'Escape') setOpen(false)
                }}
                placeholder="Type a command, symbol, indicator or script…"
                className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
              />
              <Kbd>esc</Kbd>
            </div>
            <div ref={list} className="min-h-0 flex-1 overflow-auto p-1.5">
              {items.map((it, i) => {
                const header = it.group !== lastGroup
                lastGroup = it.group
                return (
                  <div key={it.id}>
                    {header && <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-faint">{it.group}</div>}
                    <button data-i={i} onMouseMove={() => i !== idx && setIdx(i)} onClick={() => run(it)} className={cx('relative flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13px]', i === idx ? 'text-text' : 'text-text/85')}>
                      {i === idx && <motion.span layoutId="palette-sel" transition={{ type: 'spring', stiffness: 700, damping: 45 }} className="absolute inset-0 rounded-lg bg-panel-3/80 shadow-[inset_0_1px_0_var(--glass-edge)]" />}
                      <span className="relative flex-1 truncate">{it.title}</span>
                      {it.hint && <span className="num relative truncate text-[11px] text-faint">{it.hint}</span>}
                      {it.shortcut && (
                        <span className="relative flex gap-0.5">
                          {fmtKey(it.shortcut)!.map((k) => (
                            <Kbd key={k}>{k}</Kbd>
                          ))}
                        </span>
                      )}
                      {i === idx && <CornerDownLeft size={13} className="relative text-muted" />}
                    </button>
                  </div>
                )
              })}
              {!items.length && <div className="p-6 text-center text-[12.5px] text-muted">No matching commands.</div>}
            </div>
            <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-faint">
              <span>Every action here is a typed command — the same ones exposed to agents via MCP, CLI and REST.</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
