import type { Bar, BacktestConfig, BacktestResult, ConnectionStatus, Fill, Order, Signal, SymbolInfo, Timeframe } from './types'

/** Replaceable module interfaces. This build ships demo implementations only. */
export interface DataAdapter {
  id: string
  name: string
  status: ConnectionStatus
  symbols(): SymbolInfo[]
  bars(symbol: string, tf: Timeframe): Bar[]
  subscribe(cb: (symbol: string, price: number) => void): () => void
}

export interface ChartEngine {
  id: string
  name: string
  license: string
}

export interface ScriptRuntime {
  id: string
  name: string
  run(source: string, bars: Bar[]): Promise<unknown>
}

export interface BacktestEngine {
  id: string
  name: string
  location: 'browser' | 'remote'
  run(args: { bars: Bar[]; signals: Signal[]; config: BacktestConfig }): Promise<Omit<BacktestResult, 'id' | 'name' | 'source' | 'sourceRef' | 'symbol' | 'tf' | 'createdAt'>>
}

export interface BrokerAdapter {
  id: string
  name: string
  kind: 'paper' | 'live'
  status: ConnectionStatus
  placeOrder?(o: Omit<Order, 'id' | 'status' | 'createdAt'>): Order
  onFill?(cb: (f: Fill) => void): () => void
}

export interface AdapterSlot {
  id: string
  kind: 'data' | 'chart' | 'runtime' | 'backtest' | 'broker'
  name: string
  description: string
  status: ConnectionStatus
  license?: string
  active?: boolean
}

export const ADAPTERS: AdapterSlot[] = [
  { id: 'demo-feed', kind: 'data', name: 'Demo data', description: 'Seeded deterministic OHLCV with simulated ticks.', status: 'demo', active: true },
  { id: 'polygon', kind: 'data', name: 'Polygon.io', description: 'US equities & options REST + WebSocket.', status: 'not-connected' },
  { id: 'binance', kind: 'data', name: 'Binance', description: 'Crypto spot klines & trades.', status: 'not-connected' },
  { id: 'lwc', kind: 'chart', name: 'Lightweight Charts', description: 'TradingView open-source canvas charts.', status: 'demo', license: 'Apache-2.0', active: true },
  { id: 'vela', kind: 'chart', name: 'Vela', description: 'Alternative engine, under evaluation.', status: 'not-connected' },
  { id: 'pinets', kind: 'runtime', name: 'PineTS', description: 'Pine Script runtime in the browser.', status: 'demo', license: 'AGPL-3.0', active: true },
  { id: 'oc-bt', kind: 'backtest', name: 'OC Browser Engine', description: 'Event-driven backtester running in a Web Worker.', status: 'demo', license: 'MIT', active: true },
  { id: 'nautilus', kind: 'backtest', name: 'NautilusTrader', description: 'Remote high-fidelity engine (reserved slot).', status: 'not-connected' },
  { id: 'paper', kind: 'broker', name: 'Local paper broker', description: 'Simulated fills against demo ticks.', status: 'demo', active: true },
  { id: 'alpaca', kind: 'broker', name: 'Alpaca', description: 'Live brokerage. Requires credentials.', status: 'not-connected' },
  { id: 'ibkr', kind: 'broker', name: 'Interactive Brokers', description: 'Live brokerage via gateway.', status: 'not-connected' },
]
