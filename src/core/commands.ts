/**
 * Unified Command / Action registry. Every user-visible operation is a typed
 * command. UI buttons, keyboard shortcuts, the ⌘K palette, plugins and
 * external agents (via window.openComposer / MCP / CLI / REST) all go through
 * `execute`, so results are identical regardless of the caller.
 */
export type ParamType = 'string' | 'number' | 'boolean' | 'enum'
export interface ParamSpec {
  type: ParamType
  description: string
  required?: boolean
  enum?: string[]
  default?: unknown
}
export type CommandSource = 'ui' | 'palette' | 'shortcut' | 'agent' | 'plugin'

export interface Command<P = any> {
  id: string
  title: string
  category: 'Chart' | 'Workspace' | 'Indicator' | 'Drawing' | 'Pine' | 'Strategy' | 'Backtest' | 'Paper' | 'App' | 'Plugin'
  description: string
  params?: Record<string, ParamSpec>
  shortcut?: string
  scope?: 'read' | 'workspace' | 'paper' | 'live'
  pluginId?: string
  hidden?: boolean
  run: (params: P, ctx: { source: CommandSource }) => unknown | Promise<unknown>
}

export interface ActivityEvent {
  id: number
  time: number
  command: string
  source: CommandSource
  params: unknown
  ok: boolean
  message?: string
}

const commands = new Map<string, Command>()
const listeners = new Set<() => void>()
const activity: ActivityEvent[] = []
const activityListeners = new Set<() => void>()
let seq = 1
let version = 0

export function registerCommand<P>(cmd: Command<P>) {
  commands.set(cmd.id, cmd as Command)
  version++
  listeners.forEach((l) => l())
  return () => unregisterCommand(cmd.id)
}
export function unregisterCommand(id: string) {
  commands.delete(id)
  version++
  listeners.forEach((l) => l())
}
export function listCommands() {
  return [...commands.values()]
}
export function getCommand(id: string) {
  return commands.get(id)
}
export function subscribeCommands(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}
export function commandsVersion() {
  return version
}

function validate(cmd: Command, params: Record<string, unknown>) {
  for (const [k, spec] of Object.entries(cmd.params ?? {})) {
    const v = params[k]
    if (v === undefined || v === '') {
      if (spec.required) throw new Error(`Missing required param "${k}"`)
      if (spec.default !== undefined) params[k] = spec.default
      continue
    }
    if (spec.type === 'number') {
      const n = Number(v)
      if (!Number.isFinite(n)) throw new Error(`Param "${k}" must be a finite number`)
      params[k] = n
    }
    if(spec.type==='string'&&typeof v!=='string')throw Error(`Param "${k}" must be a string`)
    if(spec.type==='boolean'&&typeof v!=='boolean')throw Error(`Param "${k}" must be a boolean`)
    if (spec.type === 'enum' && spec.enum && !spec.enum.includes(String(v))) {
      throw new Error(`Param "${k}" must be one of ${spec.enum.join(', ')}`)
    }
  }
  return params
}

export async function execute(id: string, params: Record<string, unknown> = {}, source: CommandSource = 'ui') {
  const cmd = commands.get(id)
  const evt: ActivityEvent = { id: seq++, time: Date.now(), command: id, source, params, ok: true }
  try {
    if (!cmd) throw new Error(`Unknown command "${id}"`)
    const res = await cmd.run(validate(cmd, { ...params }), { source })
    evt.message = typeof res === 'string' ? res : undefined
    return res
  } catch (e) {
    evt.ok = false
    evt.message = (e as Error).message
    throw e
  } finally {
    activity.unshift(evt)
    if (activity.length > 200) activity.pop()
    activityListeners.forEach((l) => l())
  }
}

export function getActivity() {
  return activity
}
export function subscribeActivity(l: () => void) {
  activityListeners.add(l)
  return () => activityListeners.delete(l)
}

/** JSON-schema for a command, used by the integrations hub (MCP tools, REST). */
export function commandSchema(cmd: Command) {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [k, s] of Object.entries(cmd.params ?? {})) {
    properties[k] = {
      type: s.type === 'enum' ? 'string' : s.type,
      description: s.description,
      ...(s.enum ? { enum: s.enum } : {}),
      ...(s.default !== undefined ? { default: s.default } : {}),
    }
    if (s.required) required.push(k)
  }
  return { type: 'object', properties, required }
}

export const mcpToolName = (id: string) => 'oc_' + id.replace(/\./g, '_')
export const cliFor = (cmd: Command) => {
  const [ns, ...rest] = cmd.id.split('.')
  const verb = rest.join('-').replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
  const args = Object.entries(cmd.params ?? {})
    .map(([k, s]) => (s.required ? `--${k} <${s.enum ? s.enum.slice(0, 3).join('|') : s.type}>` : `[--${k}]`))
    .join(' ')
  return `oc ${ns} ${verb} ${args}`.trim()
}
