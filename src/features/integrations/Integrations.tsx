import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { Bot, Check, Copy, Download, Play, Plug, Puzzle, Search, Server, Shield, Terminal, Webhook, Activity as ActivityIcon } from 'lucide-react'
import { cliFor, commandSchema, execute, mcpToolName, type Command } from '../../core/commands'
import { ADAPTERS } from '../../core/adapters'
import { exportState } from '../../core/actions'
import { PLUGINS } from '../../plugins'
import { usePlugins } from '../../store'
import { useActivity, useCommands } from '../../ui/hooks'
import { Badge, Button, Input, StatusBadge, Toggle, cx } from '../../ui/primitives'
import Shader from '../shell/Shader'
import { isDemoData } from '../../data/feed'
import ServerIntegrations from '../../service/ServerIntegrations'

type Tab = 'commands' | 'plugins' | 'adapters' | 'permissions' | 'activity'

export default function Integrations() {
  const [tab, setTab] = useState<Tab>('commands')
  const { commands } = useCommands()
  const visible = commands.filter((c) => !c.hidden)
  const tabs: { id: Tab; label: string; icon: typeof Plug }[] = [
    { id: 'commands', label: `Command registry · ${visible.length}`, icon: Terminal },
    { id: 'plugins', label: 'Plugins', icon: Puzzle },
    { id: 'adapters', label: 'Adapters', icon: Plug },
    { id: 'permissions', label: 'Permissions', icon: Shield },
    { id: 'activity', label: 'Agent activity', icon: ActivityIcon },
  ]
  if(!isDemoData())return <ServerIntegrations><Plugins/></ServerIntegrations>
  return (
    <div className="h-full overflow-auto">
      <section className="relative overflow-hidden border-b border-line">
        <Shader className="absolute inset-0 h-full w-full opacity-70" intensity={0.8} />
        <div className="absolute inset-0 bg-gradient-to-r from-bg via-bg/85 to-bg/30" />
        <div className="relative mx-auto flex max-w-[1180px] items-end justify-between gap-8 px-8 pb-7 pt-10">
          <div className="max-w-[560px]">
            <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
              <Bot size={13} /> Agent-native workbench
            </div>
            <h1 className="text-[30px] font-semibold leading-[1.1] tracking-[-0.03em]">Every click is a command. Agents get the same ones.</h1>
            <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
              This page describes the offline UI demo registry. The self-hosted service workbench uses authenticated /api/command, the trading CLI and official Rust MCP bridge; browser demo permissions do not authorize server actions.
            </p>
          </div>
          <div className="grid shrink-0 grid-cols-3 gap-2">
            <Endpoint icon={Server} name="MCP server" value="stdio · trading-mcp" />
            <Endpoint icon={Terminal} name="CLI" value="scripts/trading.cjs" />
            <Endpoint icon={Webhook} name="REST / WS" value="127.0.0.1:8787/api/command" />
          </div>
        </div>
      </section>
      <div className="mx-auto max-w-[1180px] px-8 py-5">
        <div className="mb-4 flex items-center gap-1">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={cx('relative flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium', tab === t.id ? 'text-text' : 'text-muted hover:text-text')}>
              {tab === t.id && <motion.span layoutId="int-tab" className="absolute inset-0 rounded-lg bg-panel-2 ring-1 ring-line-2" />}
              <t.icon size={13} className="relative" />
              <span className="relative">{t.label}</span>
            </button>
          ))}
          <div className="flex-1" />
          <Button
            size="sm"
            onClick={() => {
              const blob = new Blob([JSON.stringify(exportState(), null, 2)], { type: 'application/json' })
              const a = document.createElement('a')
              a.href = URL.createObjectURL(blob)
              a.download = 'open-composer-state.json'
              a.click()
            }}
          >
            <Download size={12} /> Export state JSON
          </Button>
        </div>
        {tab === 'commands' && <CommandExplorer commands={visible} />}
        {tab === 'plugins' && <Plugins />}
        {tab === 'adapters' && <Adapters />}
        {tab === 'permissions' && <Permissions />}
        {tab === 'activity' && <ActivityLog />}
      </div>
    </div>
  )
}

function Endpoint({ icon: I, name, value }: { icon: typeof Plug; name: string; value: string }) {
  return (
    <div className="glass w-[170px] rounded-xl p-3">
      <div className="mb-2 flex items-center justify-between">
        <I size={15} className="text-muted" />
        <StatusBadge status="not-connected" />
      </div>
      <div className="text-[12.5px] font-medium">{name}</div>
      <div className="num truncate text-[11px] text-faint">{value}</div>
    </div>
  )
}

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text)
        setOk(true)
        setTimeout(() => setOk(false), 1200)
      }}
      className="rounded p-1 text-faint hover:text-text"
      title="Copy"
    >
      {ok ? <Check size={12} className="text-up" /> : <Copy size={12} />}
    </button>
  )
}

function Code({ label, children }: { label: string; children: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg-2">
      <div className="flex items-center justify-between border-b border-line px-3 py-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">{label}</span>
        <CopyBtn text={children} />
      </div>
      <pre className="num overflow-auto px-3 py-2 text-[11.5px] leading-relaxed text-muted">{children}</pre>
    </div>
  )
}

function CommandExplorer({ commands }: { commands: Command[] }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(commands[0]?.id)
  const cmd = commands.find((c) => c.id === sel) ?? commands[0]
  const filtered = commands.filter((c) => (c.id + c.title).toLowerCase().includes(q.toLowerCase()))
  const groups = [...new Set(filtered.map((c) => c.category))]
  return (
    <div className="grid grid-cols-[300px_1fr] gap-4">
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <div className="relative border-b border-line p-2">
          <Search size={13} className="absolute left-4 top-1/2 -translate-y-1/2 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter commands" className="pl-7" />
        </div>
        <div className="max-h-[560px] overflow-auto p-1.5">
          {groups.map((g) => (
            <div key={g} className="mb-1.5">
              <div className="px-2 pb-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-faint">{g}</div>
              {filtered
                .filter((c) => c.category === g)
                .map((c) => (
                  <button key={c.id} onClick={() => setSel(c.id)} className={cx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left', c.id === cmd?.id ? 'bg-accent/12' : 'hover:bg-panel-2')}>
                    <span className="num flex-1 truncate text-[12px]">{c.id}</span>
                    {c.pluginId && <Badge className="!text-accent">plugin</Badge>}
                  </button>
                ))}
            </div>
          ))}
        </div>
      </div>
      {cmd && <CommandDetail key={cmd.id} cmd={cmd} />}
    </div>
  )
}

function CommandDetail({ cmd }: { cmd: Command }) {
  const schema = commandSchema(cmd)
  const example = useMemo(() => Object.fromEntries(Object.entries(cmd.params ?? {}).filter(([, s]) => s.required).map(([k, s]) => [k, s.enum?.[0] ?? (s.type === 'number' ? 10 : s.type === 'boolean' ? true : '')])), [cmd])
  const [body, setBody] = useState(JSON.stringify(example, null, 2))
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>(null)
  const run = async () => {
    try {
      const params = JSON.parse(body || '{}')
      const res = await execute(cmd.id, params, 'agent')
      setOut({ ok: true, text: JSON.stringify(res ?? { ok: true }, null, 2) })
    } catch (e) {
      setOut({ ok: false, text: (e as Error).message })
    }
  }
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="num text-[15px] font-semibold">{cmd.id}</div>
            <div className="mt-0.5 text-[12.5px] text-muted">{cmd.description}</div>
          </div>
          <div className="flex gap-1.5">
            {cmd.scope && <Badge className={cx(cmd.scope === 'paper' && '!text-demo', cmd.scope === 'live' && '!text-live')}>scope: {cmd.scope}</Badge>}
            {cmd.shortcut && <Badge className="num">{cmd.shortcut}</Badge>}
          </div>
        </div>
        {cmd.params && (
          <table className="mt-3 w-full text-[12px]">
            <tbody>
              {Object.entries(cmd.params).map(([k, s]) => (
                <tr key={k} className="border-t border-line [&>td]:py-1.5">
                  <td className="num w-32 font-medium">
                    {k}
                    {s.required && <span className="text-down">*</span>}
                  </td>
                  <td className="num w-20 text-accent">{s.type}</td>
                  <td className="text-muted">
                    {s.description}
                    {s.enum && <span className="num ml-1 text-faint">[{s.enum.slice(0, 8).join(' | ')}{s.enum.length > 8 ? ' …' : ''}]</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Code label={`MCP tool · ${mcpToolName(cmd.id)}`}>{JSON.stringify({ name: mcpToolName(cmd.id), description: cmd.description, inputSchema: schema }, null, 2)}</Code>
        <div className="space-y-3">
          <Code label="CLI">{`${cliFor(cmd)}\n\n# example\noc ${cmd.id.split('.')[0]} ${cmd.id.split('.').slice(1).join('-').replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} ${Object.entries(example).map(([k, v]) => `--${k} ${v}`).join(' ')}`}</Code>
          <Code label="REST">{`POST /v1/commands/${cmd.id}\nAuthorization: Bearer <token>\nContent-Type: application/json\n\n${JSON.stringify(example)}`}</Code>
          <Code label="In-page (window.openComposer)">{`await openComposer.execute("${cmd.id}", ${JSON.stringify(example)})`}</Code>
        </div>
      </div>
      <div className="rounded-xl border border-accent/25 bg-accent/5 p-4">
        <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium">
          <Bot size={14} className="text-accent" /> Simulate an agent call
          <span className="text-[11.5px] font-normal text-muted">— runs through the registry with source “agent” and shows up in the activity log.</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} className="num h-28 resize-none rounded-lg border border-line bg-panel p-2.5 text-[11.5px] outline-none focus:border-accent/60" />
          <pre className={cx('num h-28 overflow-auto rounded-lg border border-line bg-panel p-2.5 text-[11.5px]', out && !out.ok ? 'text-down' : 'text-muted')}>{out ? out.text : '// result'}</pre>
        </div>
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="primary" onClick={run}>
            <Play size={12} /> Execute as agent
          </Button>
        </div>
      </div>
    </div>
  )
}

function Plugins() {
  const { enabled, toggle } = usePlugins()
  return (
    <div className="grid grid-cols-3 gap-3">
      {PLUGINS.map((p) => (
        <div key={p.id} className="flex flex-col rounded-xl border border-line bg-panel p-4">
          <div className="mb-2 flex items-start justify-between">
            <div className="grid size-9 place-items-center rounded-lg bg-accent/10 text-accent ring-1 ring-accent/20">
              <Puzzle size={16} />
            </div>
            <Toggle checked={!!enabled[p.id]} onChange={(v) => toggle(p.id, v)} />
          </div>
          <div className="text-[13.5px] font-semibold">{p.name}</div>
          <div className="num text-[11px] text-faint">
            {p.id} · v{p.version} · {p.author}
          </div>
          <p className="mt-2 flex-1 text-[12px] text-muted">{p.description}</p>
          <div className="mt-3 space-y-1.5 text-[11px]">
            <div className="flex flex-wrap gap-1">
              {Object.entries(p.contributes).flatMap(([k, v]) => (v ?? []).map((x) => <Badge key={k + x}>{k.slice(0, -1)}: {x}</Badge>))}
            </div>
            <div className="flex flex-wrap gap-1">
              {p.permissions.map((x) => (
                <Badge key={x} className="!bg-transparent ring-1 ring-line-2">
                  {x}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      ))}
      <div className="col-span-3 rounded-xl border border-dashed border-line-2 p-4">
        <Code label="plugin manifest (oc-plugin.json)">{JSON.stringify({ id: 'acme.my-plugin', name: 'My Plugin', version: '0.1.0', permissions: ['read:market'], contributes: { commands: ['acme.doThing'], indicators: ['acme-osc'], panels: ['acme-panel'], adapters: [] }, main: 'dist/index.js' }, null, 2)}</Code>
      </div>
    </div>
  )
}

function Adapters() {
  const kinds = ['data', 'chart', 'runtime', 'backtest', 'broker'] as const
  const names = { data: 'DataAdapter', chart: 'ChartEngine', runtime: 'ScriptRuntime', backtest: 'BacktestEngine', broker: 'BrokerAdapter' }
  return (
    <div className="space-y-4">
      {kinds.map((k) => (
        <div key={k}>
          <div className="mb-1.5 flex items-baseline gap-2">
            <span className="num text-[12.5px] font-semibold">{names[k]}</span>
            <span className="text-[11.5px] text-faint">replaceable interface</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {ADAPTERS.filter((a) => a.kind === k).map((a) => (
              <div key={a.id} className={cx('rounded-xl border bg-panel p-3', a.active ? 'border-accent/30' : 'border-line')}>
                <div className="flex items-center justify-between">
                  <span className="text-[12.5px] font-medium">{a.name}</span>
                  <StatusBadge status={a.status} />
                </div>
                <div className="mt-1 text-[11.5px] text-muted">{a.description}</div>
                <div className="mt-2 flex gap-1">
                  {a.active && <Badge className="!text-accent">active</Badge>}
                  {a.license && <Badge>{a.license}</Badge>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="rounded-lg bg-demo/8 p-3 text-[11.5px] text-demo ring-1 ring-demo/25">
        PineTS is licensed AGPL-3.0. It is isolated behind the ScriptRuntime interface so distributions can swap it for a differently-licensed runtime.
      </div>
    </div>
  )
}

function Permissions() {
  return <div className="rounded-xl border border-line bg-panel p-5 text-sm text-muted">Offline demo controls are browser-local. Server authorization is enforced for every command with an instance token; configure scoped tokens and revoke them on the host. Live trading is unavailable. Use the server workbench connection to inspect actual capabilities.</div>
}

function ActivityLog() {
  const activity = useActivity()
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      {activity.length === 0 && <div className="p-8 text-center text-[12.5px] text-muted">No commands yet. Interact with the app or simulate an agent call.</div>}
      {activity.slice(0, 120).map((a) => (
        <div key={a.id} className="num flex items-center gap-3 border-b border-line px-4 py-1.5 text-[11.5px] last:border-0">
          <span className="w-16 text-faint">{new Date(a.time).toLocaleTimeString('en-US', { hour12: false })}</span>
          <span className={cx('w-16 rounded px-1.5 text-center text-[10.5px]', a.source === 'agent' ? 'bg-accent/15 text-accent' : 'bg-panel-3 text-muted')}>{a.source}</span>
          <span className={cx('w-48 truncate font-medium', !a.ok && 'text-down')}>{a.command}</span>
          <span className="flex-1 truncate text-faint">{JSON.stringify(a.params)}</span>
          <span className={cx('max-w-[280px] truncate', a.ok ? 'text-muted' : 'text-down')}>{a.message}</span>
        </div>
      ))}
    </div>
  )
}
