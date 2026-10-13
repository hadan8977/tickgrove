import type { DockviewApi } from 'dockview-react'
import type { ChartState } from '../../core/types'
import { useApp, useCharts, useWorkspaces } from '../../store'

let api: DockviewApi | null = null
export const setDockApi = (a: DockviewApi | null) => {
  api = a
}
export const getDockApi = () => api

export const PANEL_TITLES: Record<string, string> = {
  chart: 'Chart',
  watchlist: 'Watchlist',
  detail: 'Symbol · Depth',
  pine: 'Pine Editor',
  builder: 'Strategy Builder',
  backtest: 'Backtest Report',
  ticket: 'Order Ticket',
  positions: 'Paper Account',
  plugin: 'Plugin',
}

export type PresetId = 'charts1' | 'charts2' | 'charts4' | 'charts6' | 'research' | 'strategy' | 'trade'
export const PRESETS: { id: PresetId; label: string; hint: string }[] = [
  { id: 'charts1', label: '1 chart', hint: 'Single chart + watchlist' },
  { id: 'charts2', label: '2 charts', hint: 'Side by side' },
  { id: 'charts4', label: '4 charts', hint: '2 × 2 grid' },
  { id: 'charts6', label: '6 charts', hint: '3 × 2 grid' },
  { id: 'research', label: 'Research', hint: 'Charts, watchlist, depth' },
  { id: 'strategy', label: 'Strategy', hint: 'Builder, Pine, backtest' },
  { id: 'trade', label: 'Trade', hint: 'Chart, ticket, account' },
]

let pseq = 0
const pid = (c: string) => `${c}-${Date.now().toString(36)}-${pseq++}`

export function chartTitle(c?: ChartState) {
  return c ? `${c.symbol} · ${c.tf}` : 'Chart'
}

export function openPanel(component: string, params: Record<string, unknown> = {}, opts: { reference?: string; direction?: 'right' | 'left' | 'above' | 'below' | 'within'; focus?: boolean } = {}) {
  if (!api) return null
  // singleton panels: focus if exists
  if (!['chart', 'plugin'].includes(component)) {
    const existing = api.panels.find((p) => (p.params as any)?.component === component || p.id.startsWith(component + '-'))
    if (existing) {
      existing.api.setActive()
      return existing.id
    }
  }
  let title = PANEL_TITLES[component] ?? component
  if (component === 'chart') {
    const chartId = (params.chartId as string) ?? useCharts.getState().createChart(params.init as Partial<ChartState>)
    params = { chartId }
    title = chartTitle(useCharts.getState().charts[chartId])
  }
  if (component === 'plugin') title = (params.title as string) ?? 'Plugin'
  const id = pid(component)
  const ref = opts.reference ?? api.activePanel?.id
  api.addPanel({
    id,
    component,
    title,
    params: { ...params, component },
    position: ref && api.getPanel(ref) ? { referencePanel: ref, direction: opts.direction ?? 'within' } : undefined,
  })
  return id
}

const SYMS = ['NVDA', 'AAPL', 'SPY', 'BTCUSD', 'MSFT', 'TSLA']
const GROUPS = ['violet', 'teal', null, 'amber', 'rose', null] as const
const TFS = ['1D', '1D', '1H', '4H', '1D', '15m'] as const

export function applyPreset(preset: PresetId) {
  if (!api) return
  const charts = useCharts.getState()
  // drop chart states not referenced elsewhere
  for (const p of api.panels) if ((p.params as any)?.chartId) charts.removeChart((p.params as any).chartId)
  api.clear()
  const mk = (i: number, extra: Partial<ChartState> = {}) =>
    charts.createChart({ symbol: SYMS[i], group: GROUPS[i] as ChartState['group'], tf: TFS[i], ...extra })
  const add = (component: string, params: Record<string, unknown>, reference?: string, direction?: 'right' | 'left' | 'above' | 'below' | 'within', size?: { w?: number; h?: number }) => {
    const id = pid(component)
    const chartId = params.chartId as string | undefined
    api!.addPanel({
      id,
      component,
      title: component === 'chart' ? chartTitle(useCharts.getState().charts[chartId!]) : PANEL_TITLES[component],
      params: { ...params, component },
      position: reference ? { referencePanel: reference, direction: direction ?? 'within' } : undefined,
      initialWidth: size?.w,
      initialHeight: size?.h,
    })
    return id
  }
  const n = { charts1: 1, charts2: 2, charts4: 4, charts6: 6 }[preset as 'charts1']
  if (n) {
    const ids: string[] = []
    const first = add('chart', { chartId: mk(0) })
    ids.push(first)
    const wl = add('watchlist', {}, first, 'right', { w: 300 })
    add('detail', {}, wl, 'below', { h: 300 })
    if (n === 2) ids.push(add('chart', { chartId: mk(1) }, first, 'right'))
    if (n === 4) {
      const b = add('chart', { chartId: mk(1) }, first, 'right')
      add('chart', { chartId: mk(2) }, first, 'below')
      add('chart', { chartId: mk(3) }, b, 'below')
    }
    if (n === 6) {
      const b = add('chart', { chartId: mk(1) }, first, 'right')
      const c = add('chart', { chartId: mk(2) }, b, 'right')
      add('chart', { chartId: mk(3) }, first, 'below')
      add('chart', { chartId: mk(4) }, b, 'below')
      add('chart', { chartId: mk(5) }, c, 'below')
    }
    api.getPanel(first)?.api.setActive()
  } else if (preset === 'research') {
    const a = add('chart', { chartId: mk(0, { indicators: [] }) })
    const b = add('chart', { chartId: mk(0, { tf: '1H', group: null }) }, a, 'right')
    add('chart', { chartId: mk(2) }, a, 'below')
    add('chart', { chartId: mk(3) }, b, 'below')
    const wl = add('watchlist', {}, b, 'right', { w: 300 })
    add('detail', {}, wl, 'below', { h: 300 })
    api.getPanel(a)?.api.setActive()
  } else if (preset === 'strategy') {
    const bld = add('builder', {})
    add('pine', {}, bld, 'within')
    const ch = add('chart', { chartId: mk(0) }, bld, 'right')
    add('backtest', {}, ch, 'below')
    api.getPanel(bld)?.api.setActive()
    api.getPanel(ch)?.api.setActive()
  } else if (preset === 'trade') {
    const ch = add('chart', { chartId: mk(0) })
    const tk = add('ticket', {}, ch, 'right', { w: 320 })
    add('detail', {}, tk, 'below')
    add('positions', {}, ch, 'below', { h: 260 })
    add('watchlist', {}, ch, 'left', { w: 260 })
    api.getPanel(ch)?.api.setActive()
  }
  const first = Object.keys(useCharts.getState().charts).find((id) => api!.panels.some((p) => (p.params as any)?.chartId === id))
  if (first) useApp.getState().setActiveChart(first)
  balanceSidebar()
}

/** Give the watchlist a readable share of its column when stacked above Symbol · Depth. */
export function balanceSidebar(attempt = 0) {
  setTimeout(() => {
    if (!api) return
    const wl = api.panels.find((p) => (p.params as any)?.component === 'watchlist')?.group
    const dt = api.panels.find((p) => (p.params as any)?.component === 'detail')?.group
    if (!wl || !dt || wl === dt) return
    const total = wl.api.height + dt.api.height
    if (total < 120) return attempt < 10 && balanceSidebar(attempt + 1) // not laid out yet
    if (total < 440) {
      // short viewport: stack as tabs so each gets the full column instead of two slivers
      const detail = api.panels.find((p) => (p.params as any)?.component === 'detail')!
      detail.api.moveTo({ group: wl, position: 'center' })
      api.panels.find((p) => (p.params as any)?.component === 'watchlist')?.api.setActive()
      return
    }
    if (wl.api.height >= total * 0.4) return
    wl.api.setSize({ height: Math.round(total * 0.52) })
  }, 80)
}

export function saveCurrentWorkspace() {
  if (!api) return
  const { activeId, save } = useWorkspaces.getState()
  save(activeId, api.toJSON())
}

export function loadWorkspace(id: string) {
  if (!api) return
  const ws = useWorkspaces.getState().workspaces.find((w) => w.id === id)
  if (!ws) return
  if (ws.layout) {
    try {
      api.fromJSON(ws.layout as any)
      const chartIds = api.panels.map((p) => (p.params as any)?.chartId).filter(Boolean)
      const missing = chartIds.filter((c: string) => !useCharts.getState().charts[c])
      if (!missing.length) {
        useApp.getState().setActiveChart(chartIds[0])
        balanceSidebar()
        return
      }
    } catch {
      /* fall through to preset */
    }
  }
  applyPreset(ws.preset as PresetId)
  useWorkspaces.getState().save(id, api.toJSON())
}

export function syncChartTitles() {
  if (!api) return
  const charts = useCharts.getState().charts
  for (const p of api.panels) {
    const cid = (p.params as any)?.chartId
    if (cid && charts[cid]) {
      const t = chartTitle(charts[cid])
      if (p.title !== t) p.api.setTitle(t)
    }
  }
}

export function focusChartPanel(chartId: string) {
  const p = api?.panels.find((x) => (x.params as any)?.chartId === chartId)
  p?.api.setActive()
}
export function visibleChartIds() {
  return (api?.panels ?? []).map((p) => (p.params as any)?.chartId).filter(Boolean) as string[]
}
