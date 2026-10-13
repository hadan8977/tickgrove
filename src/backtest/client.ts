import type { BacktestConfig, Bar, Signal, Timeframe } from '../core/types'
import { simulate } from './engine'

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

function getWorker() {
  if (worker) return worker
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id)
      if (!p) return
      pending.delete(e.data.id)
      e.data.ok ? p.resolve(e.data.res) : p.reject(new Error(e.data.error))
    }
  } catch {
    worker = null
  }
  return worker
}

/** Runs the browser backtest engine off the main thread (falls back inline). */
export function runBacktest(bars: Bar[], signals: Signal[], config: BacktestConfig, tf: Timeframe): Promise<ReturnType<typeof simulate>> {
  const w = getWorker()
  if (!w) return Promise.resolve(simulate(bars, signals, config, tf))
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ id, bars, signals, config, tf })
  })
}
