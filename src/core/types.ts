export type Timeframe = '5m' | '15m' | '1H' | '4H' | '1D' | '1W'
export const TIMEFRAMES: Timeframe[] = ['5m', '15m', '1H', '4H', '1D', '1W']
export const TF_SECONDS: Record<Timeframe, number> = {
  '5m': 300,
  '15m': 900,
  '1H': 3600,
  '4H': 14400,
  '1D': 86400,
  '1W': 604800,
}

export interface Bar {
  time: number // unix seconds
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface SymbolInfo {
  symbol: string
  name: string
  exchange: string
  sector: string
  price: number
  vol: number // annualized volatility
  kind: 'stock' | 'etf' | 'crypto'
}

export type LinkGroup = 'violet' | 'teal' | 'amber' | 'rose' | null
export const LINK_GROUPS: Exclude<LinkGroup, null>[] = ['violet', 'teal', 'amber', 'rose']
export const LINK_COLORS: Record<Exclude<LinkGroup, null>, string> = {
  violet: '#8b7dff',
  teal: '#2dd4bf',
  amber: '#f4b545',
  rose: '#f472b6',
}

export type ChartStyle = 'candles' | 'bars' | 'line' | 'area'

export interface IndicatorInstance {
  id: string
  kind: 'builtin' | 'pine'
  type: string // builtin id or script id
  name: string
  inputs: Record<string, number | string | boolean>
  visible: boolean
}

export type DrawingTool = 'cursor' | 'trend' | 'hline' | 'rect' | 'fib' | 'text'
export interface Drawing {
  id: string
  tool: Exclude<DrawingTool, 'cursor'>
  points: { t: number; p: number }[]
  text?: string
}

export interface ChartState {
  id: string
  symbol: string
  tf: Timeframe
  group: LinkGroup
  style: ChartStyle
  indicators: IndicatorInstance[]
  backtestId?: string
}

export type ExecMode = 'demo' | 'live'
export type ConnectionStatus = 'demo' | 'not-connected' | 'live'

export interface PineInput {
  name: string
  title: string
  type: 'int' | 'float' | 'bool' | 'string' | 'source'
  default: number | string | boolean
  min?: number
  max?: number
  options?: string[]
  line: number
}

export interface Script {
  id: string
  name: string
  kind: 'indicator' | 'strategy'
  source: string
  updatedAt: number
  origin?: 'builder' | 'user' | 'example'
}

export interface Signal {
  bar: number
  action: 'long' | 'short' | 'flat'
}

export interface Trade {
  id: number
  side: 'long' | 'short'
  entryBar: number
  exitBar: number
  entryTime: number
  exitTime: number
  entryPrice: number
  exitPrice: number
  qty: number
  pnl: number
  pnlPct: number
  reason: 'signal' | 'stop' | 'take' | 'end'
}

export interface BacktestMetrics {
  netProfit: number
  netProfitPct: number
  buyHoldPct: number
  cagr: number
  sharpe: number
  sortino: number
  maxDrawdownPct: number
  winRate: number
  profitFactor: number
  trades: number
  avgTradePct: number
  exposurePct: number
}

export interface BacktestResult {
  id: string
  name: string
  source: 'pine' | 'builder'
  sourceRef: string
  symbol: string
  tf: Timeframe
  createdAt: number
  config: BacktestConfig
  trades: Trade[]
  equity: { time: number; value: number }[]
  drawdown: { time: number; value: number }[]
  monthly: { y: number; m: number; r: number }[]
  metrics: BacktestMetrics
}

export interface BacktestConfig {
  capital: number
  commissionBps: number
  slippageBps: number
  sizePct: number
  stopPct?: number
  takePct?: number
}

export type OrderSide = 'buy' | 'sell'
export type OrderType = 'market' | 'limit' | 'stop'
export interface Order {
  id: string
  symbol: string
  side: OrderSide
  type: OrderType
  qty: number
  price?: number
  status: 'working' | 'filled' | 'cancelled' | 'rejected'
  createdAt: number
  source: 'manual' | 'strategy' | 'agent'
  strategyId?: string
}
export interface Fill {
  id: string
  orderId: string
  symbol: string
  side: OrderSide
  qty: number
  price: number
  time: number
  fee: number
}
export interface Position {
  symbol: string
  qty: number
  avg: number
}

export interface PaperStrategy {
  id: string
  name: string
  symbol: string
  tf: Timeframe
  source: 'pine' | 'builder'
  sourceRef: string
  status: 'running' | 'paused' | 'stopped'
  startedAt: number
  sizePct: number
  lastSignal?: string
}
