import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { BacktestResult, ChartState, Drawing, DrawingTool, Fill, IndicatorInstance, LinkGroup, Order, PaperStrategy, Position, Script, Timeframe } from '../core/types'
import { exampleStrategy, uid, type StrategyDefinition } from '../builder/model'
import { EXAMPLE_SCRIPTS } from '../pine/examples'
import { livePrice } from '../data/feed'

/* ---------------- App ---------------- */
export type View = 'workspace' | 'library' | 'integrations'
export interface Toast {
  id: number
  title: string
  body?: string
  tone?: 'default' | 'demo' | 'up' | 'down' | 'error'
}
export type ThemeId = 'light' | 'dark' | 'cobalt' | 'moss'
export const THEMES: { id: ThemeId; label: string; swatch: [string, string] }[] = [
  { id: 'light', label: 'Paper', swatch: ['#ffffff', '#161615'] },
  { id: 'dark', label: 'Graphite', swatch: ['#151516', '#e8e8e6'] },
  { id: 'cobalt', label: 'Cobalt', swatch: ['#0d1428', '#5b8cff'] },
  { id: 'moss', label: 'Moss', swatch: ['#fbfaf6', '#3f6b2a'] },
]
export const isDarkTheme = (t: ThemeId) => t === 'dark' || t === 'cobalt'
interface AppState {
  theme: ThemeId
  view: View
  activeChartId: string | null
  tool: DrawingTool
  paletteOpen: boolean
  liveDialog: boolean
  toasts: Toast[]
  setTheme: (t: ThemeId) => void
  setView: (v: View) => void
  setActiveChart: (id: string) => void
  setTool: (t: DrawingTool) => void
  setPalette: (o: boolean) => void
  setLiveDialog: (o: boolean) => void
  toast: (t: Omit<Toast, 'id'>) => void
  dismiss: (id: number) => void
}
let toastSeq = 1
export const useApp = create<AppState>()(
  persist(
    (set) => ({
      theme: 'dark',
      view: 'workspace',
      activeChartId: null,
      tool: 'cursor',
      paletteOpen: false,
      liveDialog: false,
      toasts: [],
      setTheme: (theme) => set({ theme }),
      setView: (view) => set({ view }),
      setActiveChart: (activeChartId) => set({ activeChartId }),
      setTool: (tool) => set({ tool }),
      setPalette: (paletteOpen) => set({ paletteOpen }),
      setLiveDialog: (liveDialog) => set({ liveDialog }),
      toast: (t) => {
        const id = toastSeq++
        set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }))
        setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), 3800)
      },
      dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
    }),
    { name: 'oc.app', partialize: (s) => ({ theme: s.theme, view: s.view, activeChartId: s.activeChartId }) },
  ),
)

/* ---------------- Charts ---------------- */
interface ChartsState {
  charts: Record<string, ChartState>
  drawings: Record<string, Drawing[]> // keyed by symbol
  watchlists: { id: string; name: string; symbols: string[] }[]
  activeWatchlist: string
  createChart: (init?: Partial<ChartState>) => string
  removeChart: (id: string) => void
  setSymbol: (id: string, symbol: string) => void
  setTf: (id: string, tf: Timeframe) => void
  setGroup: (id: string, g: LinkGroup) => void
  setStyle: (id: string, s: ChartState['style']) => void
  addIndicator: (id: string, ind: Omit<IndicatorInstance, 'id' | 'visible'>) => string
  updateIndicator: (id: string, indId: string, patch: Partial<IndicatorInstance>) => void
  removeIndicator: (id: string, indId: string) => void
  setBacktest: (id: string, btId?: string) => void
  addDrawing: (symbol: string, d: Drawing) => void
  removeDrawing: (symbol: string, id: string) => void
  clearDrawings: (symbol: string) => void
  setWatchlist: (id: string) => void
  addToWatchlist: (symbol: string) => void
  removeFromWatchlist: (symbol: string) => void
}

const linked = (charts: Record<string, ChartState>, id: string) => {
  const g = charts[id]?.group
  return Object.values(charts).filter((c) => c.id === id || (g && c.group === g))
}

export const useCharts = create<ChartsState>()(
  persist(
    (set, get) => ({
      charts: {},
      drawings: {},
      watchlists: [
        { id: 'core', name: 'Core', symbols: ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA'] },
        { id: 'semis', name: 'Semis', symbols: ['NVDA', 'AMD', 'QQQ'] },
        { id: 'crypto', name: 'Crypto', symbols: ['BTCUSD', 'ETHUSD'] },
        { id: 'fin', name: 'Financials', symbols: ['JPM', 'SPY'] },
      ],
      activeWatchlist: 'core',
      createChart: (init) => {
        const id = uid('ch')
        set((s) => ({ charts: { ...s.charts, [id]: { id, symbol: 'NVDA', tf: '1D', group: 'violet', style: 'candles', indicators: [], ...init } } }))
        return id
      },
      removeChart: (id) =>
        set((s) => {
          const { [id]: _, ...rest } = s.charts
          return { charts: rest }
        }),
      setSymbol: (id, symbol) =>
        set((s) => {
          const charts = { ...s.charts }
          for (const c of linked(s.charts, id)) charts[c.id] = { ...c, symbol, backtestId: c.id === id ? undefined : c.backtestId }
          return { charts }
        }),
      setTf: (id, tf) =>
        set((s) => {
          const charts = { ...s.charts }
          for (const c of linked(s.charts, id)) charts[c.id] = { ...c, tf }
          return { charts }
        }),
      setGroup: (id, group) => set((s) => ({ charts: { ...s.charts, [id]: { ...s.charts[id], group } } })),
      setStyle: (id, style) => set((s) => ({ charts: { ...s.charts, [id]: { ...s.charts[id], style } } })),
      addIndicator: (id, ind) => {
        const indId = uid('i')
        set((s) => ({ charts: { ...s.charts, [id]: { ...s.charts[id], indicators: [...s.charts[id].indicators, { ...ind, id: indId, visible: true }] } } }))
        return indId
      },
      updateIndicator: (id, indId, patch) =>
        set((s) => ({ charts: { ...s.charts, [id]: { ...s.charts[id], indicators: s.charts[id].indicators.map((i) => (i.id === indId ? { ...i, ...patch } : i)) } } })),
      removeIndicator: (id, indId) => set((s) => ({ charts: { ...s.charts, [id]: { ...s.charts[id], indicators: s.charts[id].indicators.filter((i) => i.id !== indId) } } })),
      setBacktest: (id, backtestId) => set((s) => ({ charts: { ...s.charts, [id]: { ...s.charts[id], backtestId } } })),
      addDrawing: (symbol, d) => set((s) => ({ drawings: { ...s.drawings, [symbol]: [...(s.drawings[symbol] ?? []), d] } })),
      removeDrawing: (symbol, id) => set((s) => ({ drawings: { ...s.drawings, [symbol]: (s.drawings[symbol] ?? []).filter((d) => d.id !== id) } })),
      clearDrawings: (symbol) => set((s) => ({ drawings: { ...s.drawings, [symbol]: [] } })),
      setWatchlist: (activeWatchlist) => set({ activeWatchlist }),
      addToWatchlist: (symbol) =>
        set((s) => ({ watchlists: s.watchlists.map((w) => (w.id === s.activeWatchlist && !w.symbols.includes(symbol) ? { ...w, symbols: [...w.symbols, symbol] } : w)) })),
      removeFromWatchlist: (symbol) => set((s) => ({ watchlists: s.watchlists.map((w) => (w.id === s.activeWatchlist ? { ...w, symbols: w.symbols.filter((x) => x !== symbol) } : w)) })),
    }),
    { name: 'oc.charts' },
  ),
)
export const getChart = (id: string | null | undefined) => (id ? useCharts.getState().charts[id] : undefined)
/** Resolve the chart commands should act on: explicit id, active chart, or first chart. */
export function targetChartId(id?: string) {
  const charts = useCharts.getState().charts
  if (id && charts[id]) return id
  const a = useApp.getState().activeChartId
  if (a && charts[a]) return a
  return Object.keys(charts)[0]
}

/* ---------------- Workspaces ---------------- */
export interface WorkspaceDoc {
  id: string
  name: string
  layout: unknown | null
  preset: string
  updatedAt: number
}
interface WorkspacesState {
  workspaces: WorkspaceDoc[]
  activeId: string
  add: (w: WorkspaceDoc) => void
  save: (id: string, layout: unknown) => void
  rename: (id: string, name: string) => void
  remove: (id: string) => void
  setActive: (id: string) => void
}
export const useWorkspaces = create<WorkspacesState>()(
  persist(
    (set) => ({
      workspaces: [
        { id: 'w-research', name: 'Research', layout: null, preset: 'research', updatedAt: Date.now() },
        { id: 'w-strategy', name: 'Strategy Lab', layout: null, preset: 'strategy', updatedAt: Date.now() },
        { id: 'w-trade', name: 'Trade', layout: null, preset: 'trade', updatedAt: Date.now() },
      ],
      activeId: 'w-research',
      add: (w) => set((s) => ({ workspaces: [...s.workspaces, w], activeId: w.id })),
      save: (id, layout) => set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, layout, updatedAt: Date.now() } : w)) })),
      rename: (id, name) => set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name } : w)) })),
      remove: (id) =>
        set((s) => {
          const ws = s.workspaces.filter((w) => w.id !== id)
          return { workspaces: ws, activeId: s.activeId === id ? ws[0]?.id : s.activeId }
        }),
      setActive: (activeId) => set({ activeId }),
    }),
    { name: 'oc.workspaces' },
  ),
)

/* ---------------- Scripts ---------------- */
interface ScriptsState {
  scripts: Script[]
  openIds: string[]
  activeId: string
  upsert: (s: Script) => void
  update: (id: string, source: string) => void
  open: (id: string) => void
  close: (id: string) => void
  remove: (id: string) => void
}
export const useScripts = create<ScriptsState>()(
  persist(
    (set) => ({
      scripts: EXAMPLE_SCRIPTS,
      openIds: [EXAMPLE_SCRIPTS[0].id, EXAMPLE_SCRIPTS[1].id],
      activeId: EXAMPLE_SCRIPTS[0].id,
      upsert: (sc) =>
        set((s) => ({
          scripts: s.scripts.some((x) => x.id === sc.id) ? s.scripts.map((x) => (x.id === sc.id ? sc : x)) : [...s.scripts, sc],
          openIds: s.openIds.includes(sc.id) ? s.openIds : [...s.openIds, sc.id],
          activeId: sc.id,
        })),
      update: (id, source) => set((s) => ({ scripts: s.scripts.map((x) => (x.id === id ? { ...x, source, updatedAt: Date.now() } : x)) })),
      open: (id) => set((s) => ({ openIds: s.openIds.includes(id) ? s.openIds : [...s.openIds, id], activeId: id })),
      close: (id) =>
        set((s) => {
          const openIds = s.openIds.filter((x) => x !== id)
          return { openIds, activeId: s.activeId === id ? (openIds[0] ?? '') : s.activeId }
        }),
      remove: (id) => set((s) => ({ scripts: s.scripts.filter((x) => x.id !== id), openIds: s.openIds.filter((x) => x !== id) })),
    }),
    { name: 'oc.scripts' },
  ),
)

/* ---------------- Backtests ---------------- */
interface BacktestsState {
  results: BacktestResult[]
  activeId: string | null
  running: boolean
  add: (r: BacktestResult) => void
  setActive: (id: string) => void
  setRunning: (b: boolean) => void
  remove: (id: string) => void
}
export const useBacktests = create<BacktestsState>()((set) => ({
  results: [],
  activeId: null,
  running: false,
  add: (r) => set((s) => ({ results: [r, ...s.results].slice(0, 12), activeId: r.id })),
  setActive: (activeId) => set({ activeId }),
  setRunning: (running) => set({ running }),
  remove: (id) => set((s) => ({ results: s.results.filter((r) => r.id !== id) })),
}))

/* ---------------- Builder ---------------- */
interface BuilderState {
  defs: StrategyDefinition[]
  activeId: string
  setDef: (d: StrategyDefinition) => void
  addDef: (d: StrategyDefinition) => void
  setActive: (id: string) => void
}
const ex = exampleStrategy()
export const useBuilder = create<BuilderState>()(
  persist(
    (set) => ({
      defs: [ex],
      activeId: ex.id,
      setDef: (d) => set((s) => ({ defs: s.defs.map((x) => (x.id === d.id ? { ...d, updatedAt: Date.now() } : x)) })),
      addDef: (d) => set((s) => ({ defs: [...s.defs, d], activeId: d.id })),
      setActive: (activeId) => set({ activeId }),
    }),
    { name: 'oc.builder' },
  ),
)

/* ---------------- Paper trading ---------------- */
interface PaperState {
  startingCash: number
  cash: number
  positions: Record<string, Position>
  orders: Order[]
  fills: Fill[]
  strategies: PaperStrategy[]
  placeOrder: (o: Omit<Order, 'id' | 'status' | 'createdAt'>) => Order
  cancelOrder: (id: string) => void
  processTick: (prices: Record<string, number>) => Fill[]
  flatten: (symbol: string, source?: Order['source']) => void
  addStrategy: (s: PaperStrategy) => void
  setStrategyStatus: (id: string, status: PaperStrategy['status']) => void
  patchStrategy: (id: string, p: Partial<PaperStrategy>) => void
  reset: () => void
}
const FEE_BPS = 1
const SLIP_BPS = 2
function applyFill(s: PaperState, o: Order, price: number): Partial<PaperState> & { fill: Fill } {
  const px = o.side === 'buy' ? price * (1 + SLIP_BPS / 1e4) : price * (1 - SLIP_BPS / 1e4)
  const fee = px * o.qty * (FEE_BPS / 1e4)
  const signed = o.side === 'buy' ? o.qty : -o.qty
  const pos = s.positions[o.symbol] ?? { symbol: o.symbol, qty: 0, avg: 0 }
  const nq = pos.qty + signed
  let avg = pos.avg
  if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signed)) avg = (pos.avg * Math.abs(pos.qty) + px * o.qty) / Math.abs(nq)
  else if (Math.sign(nq) !== Math.sign(pos.qty) && nq !== 0) avg = px
  const positions = { ...s.positions }
  if (Math.abs(nq) < 1e-9) delete positions[o.symbol]
  else positions[o.symbol] = { symbol: o.symbol, qty: nq, avg }
  const fill: Fill = { id: uid('f'), orderId: o.id, symbol: o.symbol, side: o.side, qty: o.qty, price: px, time: Date.now(), fee }
  return { cash: s.cash - signed * px - fee, positions, fills: [fill, ...s.fills].slice(0, 200), fill }
}
export const usePaper = create<PaperState>()(
  persist(
    (set, get) => ({
      startingCash: 100000,
      cash: 100000,
      positions: {},
      orders: [],
      fills: [],
      strategies: [],
      placeOrder: (input) => {
        const o: Order = { ...input, id: uid('o'), status: 'working', createdAt: Date.now() }
        if (!(o.qty > 0)) {
          const r = { ...o, status: 'rejected' as const }
          set((s) => ({ orders: [r, ...s.orders] }))
          return r
        }
        if (o.type === 'market') {
          const s = get()
          const { fill, ...patch } = applyFill(s, o, livePrice(o.symbol))
          const filled = { ...o, status: 'filled' as const, price: fill.price }
          set({ ...patch, orders: [filled, ...s.orders].slice(0, 200) })
          return filled
        }
        set((s) => ({ orders: [o, ...s.orders] }))
        return o
      },
      cancelOrder: (id) => set((s) => ({ orders: s.orders.map((o) => (o.id === id && o.status === 'working' ? { ...o, status: 'cancelled' } : o)) })),
      processTick: (prices) => {
        const s = get()
        const working = s.orders.filter((o) => o.status === 'working')
        if (!working.length) return []
        let state: PaperState = s
        const fills: Fill[] = []
        const orders = [...s.orders]
        for (const o of working) {
          const p = prices[o.symbol]
          const hit =
            o.type === 'limit' ? (o.side === 'buy' ? p <= (o.price ?? 0) : p >= (o.price ?? Infinity)) : o.type === 'stop' ? (o.side === 'buy' ? p >= (o.price ?? Infinity) : p <= (o.price ?? 0)) : false
          if (!hit) continue
          const { fill, ...patch } = applyFill(state, o, o.type === 'limit' ? (o.price as number) : p)
          state = { ...state, ...patch }
          fills.push(fill)
          const idx = orders.findIndex((x) => x.id === o.id)
          orders[idx] = { ...o, status: 'filled' }
        }
        if (fills.length) set({ cash: state.cash, positions: state.positions, fills: state.fills, orders })
        return fills
      },
      flatten: (symbol, source = 'manual') => {
        const pos = get().positions[symbol]
        if (!pos) return
        get().placeOrder({ symbol, side: pos.qty > 0 ? 'sell' : 'buy', type: 'market', qty: Math.abs(pos.qty), source })
      },
      addStrategy: (st) => set((s) => ({ strategies: [st, ...s.strategies] })),
      setStrategyStatus: (id, status) => set((s) => ({ strategies: s.strategies.map((x) => (x.id === id ? { ...x, status } : x)) })),
      patchStrategy: (id, p) => set((s) => ({ strategies: s.strategies.map((x) => (x.id === id ? { ...x, ...p } : x)) })),
      reset: () => set({ cash: 100000, positions: {}, orders: [], fills: [], strategies: [] }),
    }),
    { name: 'oc.paper' },
  ),
)

/* ---------------- Plugins ---------------- */
interface PluginsState {
  enabled: Record<string, boolean>
  toggle: (id: string, on: boolean) => void
}
export const usePlugins = create<PluginsState>()(
  persist(
    (set) => ({
      enabled: { 'oc.supertrend': true, 'oc.position-sizer': true, 'oc.sector-heatmap': false },
      toggle: (id, on) => set((s) => ({ enabled: { ...s.enabled, [id]: on } })),
    }),
    { name: 'oc.plugins' },
  ),
)
