import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { autocompletion } from '@codemirror/autocomplete'
import { setDiagnostics } from '@codemirror/lint'
import { indentWithTab } from '@codemirror/commands'
import { AlertTriangle, BookOpen, Boxes, CheckCircle2, FileCode2, FlaskConical, LineChart, Play, Plus, Trash2, X } from 'lucide-react'
import { execute } from '../../core/commands'
import { getBars } from '../../data/feed'
import { applyInputs, detectKind, detectTitle, parseInputs, runPine, type PineRunResult } from '../../pine/runtime'
import { pineCompletions, pineHighlight, pineLanguage } from '../../pine/language'
import { fromPine } from '../../builder/codegen'
import { getChart, targetChartId, useApp, useBacktests, useBuilder, useScripts } from '../../store'
import { uid } from '../../builder/model'
import { Badge, Button, Empty, IconButton, Segmented, cx } from '../../ui/primitives'
import { openPanel } from '../workspace/dock'

const NEW_TEMPLATE = `//@version=5
indicator("My Indicator", overlay=true)

length = input.int(20, "Length", minval=1)

basis = ta.sma(close, length)
plot(basis, "Basis", color=#8b7dff)
`

export default function PineEditor() {
  const { scripts, openIds, activeId, open, close, upsert, remove } = useScripts()
  const active = scripts.find((s) => s.id === activeId)
  const [libOpen, setLibOpen] = useState(true)
  const [results, setResults] = useState<Record<string, PineRunResult & { at: number }>>({})
  const [consoleTab, setConsoleTab] = useState<'console' | 'inputs'>('console')
  const viewRef = useRef<EditorView | null>(null)
  const running = useBacktests((s) => s.running)
  const result = active ? results[active.id] : undefined

  const compile = async () => {
    if (!active) return
    const cid = targetChartId()
    const c = getChart(cid)
    const bars = getBars(c?.symbol ?? 'NVDA', c?.tf ?? '1D')
    const r = await runPine(active.source, bars, c?.tf)
    setResults((s) => ({ ...s, [active.id]: { ...r, at: Date.now() } }))
    setConsoleTab('console')
    const view = viewRef.current
    if (view) {
      if (!r.ok && r.error?.line) {
        const line = view.state.doc.line(Math.min(r.error.line, view.state.doc.lines))
        view.dispatch(setDiagnostics(view.state, [{ from: line.from, to: line.to, severity: 'error', message: r.error.message }]))
      } else view.dispatch(setDiagnostics(view.state, []))
    }
    return r
  }
  const addToChart = async () => {
    const r = await compile()
    if (r?.ok) execute('pine.addToChart', { scriptId: active!.id }).then((m) => useApp.getState().toast({ title: String(m), body: 'Applied to the active chart' }))
  }
  const backtest = async () => {
    const r = await compile()
    if (r?.ok) execute('backtest.runScript', { scriptId: active!.id }).catch((e) => useApp.getState().toast({ title: e.message, tone: 'error' }))
  }
  const toBlocks = () => {
    if (!active) return
    const res = fromPine(active.source)
    if (!res.ok) return useApp.getState().toast({ title: 'Cannot convert to blocks', body: res.reason, tone: 'error' })
    const b = useBuilder.getState()
    if (b.defs.some((d) => d.id === res.def.id)) b.setDef(res.def)
    else b.addDef(res.def)
    b.setActive(res.def.id)
    openPanel('builder')
  }
  const goto = (line: number) => {
    const v = viewRef.current
    if (!v) return
    const l = v.state.doc.line(Math.min(line, v.state.doc.lines))
    v.dispatch({ selection: { anchor: l.from, head: l.to }, scrollIntoView: true })
    v.focus()
  }
  const newScript = (kind: 'indicator' | 'strategy') => {
    const source = kind === 'indicator' ? NEW_TEMPLATE : `//@version=5\nstrategy("My Strategy", overlay=true)\n\nlen = input.int(20, "Length")\nm = ta.sma(close, len)\n\nif ta.crossover(close, m)\n    strategy.entry("L", strategy.long)\nif ta.crossunder(close, m)\n    strategy.close("L")\n\nplot(m, "SMA")\n`
    upsert({ id: uid('sc'), name: kind === 'indicator' ? 'My Indicator' : 'My Strategy', kind, source, updatedAt: Date.now(), origin: 'user' })
  }

  return (
    <div className="flex h-full bg-panel">
      {libOpen && (
        <aside className="flex w-[200px] shrink-0 flex-col border-r border-line">
          <div className="flex h-9 items-center justify-between border-b border-line px-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Library</span>
            <div className="flex">
              <IconButton label="New indicator" onClick={() => newScript('indicator')}>
                <Plus size={14} />
              </IconButton>
              <IconButton label="New strategy" onClick={() => newScript('strategy')}>
                <FlaskConical size={13} />
              </IconButton>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-1.5">
            {(['indicator', 'strategy'] as const).map((k) => (
              <div key={k} className="mb-2">
                <div className="px-1.5 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-wider text-faint">{k === 'indicator' ? 'Indicators' : 'Strategies'}</div>
                {scripts
                  .filter((s) => detectKind(s.source) === k)
                  .map((s) => (
                    <div key={s.id} onClick={() => open(s.id)} className={cx('group flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px]', s.id === activeId ? 'bg-accent/12 text-text' : 'text-muted hover:bg-panel-2 hover:text-text')}>
                      {k === 'indicator' ? <LineChart size={12} className="shrink-0 text-accent-2" /> : <FlaskConical size={12} className="shrink-0 text-accent" />}
                      <span className="flex-1 truncate">{s.name}</span>
                      {s.origin === 'builder' && <Boxes size={11} className="text-faint" />}
                      {s.origin !== 'example' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            remove(s.id)
                          }}
                          className="hidden text-faint hover:text-down group-hover:block"
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center border-b border-line">
          <IconButton label="Toggle library" className="mx-1" active={libOpen} onClick={() => setLibOpen(!libOpen)}>
            <BookOpen size={14} />
          </IconButton>
          <div className="flex min-w-0 flex-1 overflow-x-auto">
            {openIds.map((id) => {
              const s = scripts.find((x) => x.id === id)
              if (!s) return null
              return (
                <div key={id} onClick={() => open(id)} className={cx('group flex h-9 shrink-0 cursor-pointer items-center gap-1.5 border-r border-line px-3 text-[12px]', id === activeId ? 'bg-panel-2 text-text shadow-[inset_0_-2px_0_var(--accent)]' : 'text-muted hover:text-text')}>
                  <FileCode2 size={12} className={detectKind(s.source) === 'strategy' ? 'text-accent' : 'text-accent-2'} />
                  {s.name}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      close(id)
                    }}
                    className="text-faint opacity-0 hover:text-text group-hover:opacity-100"
                  >
                    <X size={11} />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
        {active ? (
          <>
            <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2">
              <Button size="sm" variant="primary" onClick={compile} title="Run (⌘↵)">
                <Play size={12} /> Run
              </Button>
              <Button size="sm" onClick={addToChart}>
                <LineChart size={12} /> Add to chart
              </Button>
              {detectKind(active.source) === 'strategy' && (
                <Button size="sm" onClick={backtest} disabled={running}>
                  <FlaskConical size={12} /> {running ? 'Running…' : 'Backtest'}
                </Button>
              )}
              {active.origin === 'builder' && (
                <Button size="sm" variant="ghost" onClick={toBlocks} title="Supported only for unmodified builder output">
                  <Boxes size={12} /> Open as blocks
                </Button>
              )}
              <div className="flex-1" />
              <Badge>{detectKind(active.source)}</Badge>
              <Badge className="num">PineTS · v5 subset</Badge>
            </div>
            <div className="min-h-0 flex-1">
              <CodeEditor key={active.id} scriptId={active.id} onRun={compile} viewRef={viewRef} />
            </div>
            <Console result={result} tab={consoleTab} setTab={setConsoleTab} onGoto={goto} scriptId={active.id} />
          </>
        ) : (
          <Empty icon={<FileCode2 size={18} />} title="No script open" body="Pick a script from the library or create a new one." action={<Button onClick={() => newScript('indicator')}><Plus size={13} /> New indicator</Button>} />
        )}
      </div>
    </div>
  )
}

function CodeEditor({ scriptId, onRun, viewRef }: { scriptId: string; onRun: () => void; viewRef: React.MutableRefObject<EditorView | null> }) {
  const host = useRef<HTMLDivElement>(null)
  const runRef = useRef(onRun)
  runRef.current = onRun
  useEffect(() => {
    const script = useScripts.getState().scripts.find((s) => s.id === scriptId)!
    let timer: ReturnType<typeof setTimeout>
    let pushed = script.source
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: script.source,
        extensions: [
          basicSetup,
          pineLanguage,
          pineHighlight,
          autocompletion({ override: [pineCompletions] }),
          keymap.of([indentWithTab, { key: 'Mod-Enter', run: () => (runRef.current(), true) }]),
          EditorView.theme({ '&': { color: 'var(--text)' }, '.cm-content': { caretColor: 'var(--accent)' } }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            clearTimeout(timer)
            const src = u.state.doc.toString()
            timer = setTimeout(() => {
              pushed = src
              useScripts.getState().update(scriptId, src)
              const t = detectTitle(src)
              const s = useScripts.getState().scripts.find((x) => x.id === scriptId)
              if (s && t !== 'Untitled' && s.name !== t) useScripts.getState().upsert({ ...s, source: src, name: t, kind: detectKind(src) })
            }, 350)
          }),
        ],
      }),
    })
    viewRef.current = view
    // external edits (inputs panel, agents) flow back into the editor
    const unsub = useScripts.subscribe((st) => {
      const src = st.scripts.find((x) => x.id === scriptId)?.source
      if (src === undefined || src === pushed || src === view.state.doc.toString()) return
      pushed = src
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: src } })
    })
    return () => {
      unsub()
      clearTimeout(timer)
      view.destroy()
      viewRef.current = null
    }
  }, [scriptId])
  return <div ref={host} className="h-full overflow-hidden" />
}

function Console({ result, tab, setTab, onGoto, scriptId }: { result?: PineRunResult & { at: number }; tab: 'console' | 'inputs'; setTab: (t: 'console' | 'inputs') => void; onGoto: (l: number) => void; scriptId: string }) {
  const script = useScripts((s) => s.scripts.find((x) => x.id === scriptId))
  const inputs = useMemo(() => (script ? parseInputs(script.source) : []), [script?.source])
  return (
    <div className="flex h-[150px] shrink-0 flex-col border-t border-line">
      <div className="flex h-8 items-center gap-2 px-2">
        <Segmented layoutId={`pine-console-${scriptId}`} value={tab} onChange={setTab} options={[{ value: 'console', label: 'Console' }, { value: 'inputs', label: `Inputs · ${inputs.length}` }]} />
        <div className="flex-1" />
        {result && <span className="num text-[11px] text-faint">{new Date(result.at).toLocaleTimeString()} · {result.ms.toFixed(0)} ms</span>}
      </div>
      <div className="num min-h-0 flex-1 overflow-auto px-3 pb-2 text-[11.5px]">
        {tab === 'console' ? (
          !result ? (
            <div className="text-faint">Press Run (⌘↵) to compile against the active chart's data.</div>
          ) : result.ok ? (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-up">
                <CheckCircle2 size={13} /> Compiled “{result.title}” · {result.kind} · {result.overlay ? 'overlay' : 'separate pane'}
              </div>
              <div className="text-muted">Plots: {result.plots.map((p) => p.title).join(', ') || '—'}</div>
              {result.kind === 'strategy' && <div className="text-muted">Signals: {result.signals.length} order events</div>}
              {result.warnings.map((w, i) => (
                <div key={i} className="text-demo">⚠ {w}</div>
              ))}
            </div>
          ) : (
            <button onClick={() => result.error?.line && onGoto(result.error.line)} className="flex items-start gap-1.5 text-left text-down">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                {result.error?.line && <span className="mr-1.5 rounded bg-down/15 px-1 underline-offset-2 hover:underline">line {result.error.line}</span>}
                {result.error?.message}
              </span>
            </button>
          )
        ) : inputs.length ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 pt-0.5 font-sans">
            {inputs.map((inp) => (
              <label key={inp.name} className="flex items-center justify-between gap-2 text-[12px]">
                <button className="text-muted hover:text-text" onClick={() => onGoto(inp.line)}>
                  {inp.title}
                </button>
                <input
                  type={inp.type === 'bool' ? 'checkbox' : inp.type === 'string' || inp.type === 'source' ? 'text' : 'number'}
                  defaultValue={inp.type === 'bool' ? undefined : String(inp.default)}
                  defaultChecked={inp.type === 'bool' ? Boolean(inp.default) : undefined}
                  min={inp.min}
                  max={inp.max}
                  step={inp.type === 'float' ? 0.1 : 1}
                  onBlur={(e) => {
                    if (!script || inp.type === 'source') return
                    const v = inp.type === 'bool' ? e.target.checked : inp.type === 'string' ? e.target.value : Number(e.target.value)
                    useScripts.getState().update(script.id, applyInputs(script.source, { [inp.name]: v }))
                  }}
                  className="num h-6 w-20 rounded border border-line bg-panel-2 px-1.5 text-right outline-none focus:border-accent/60"
                />
              </label>
            ))}
            <div className="col-span-2 text-[11px] text-faint">Edits rewrite the script defaults. Per-chart overrides live in the chart legend ⚙.</div>
          </div>
        ) : (
          <div className="text-faint">No input.*() declarations found.</div>
        )}
      </div>
    </div>
  )
}
