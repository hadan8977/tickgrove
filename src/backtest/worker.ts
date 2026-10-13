import { simulate } from './engine'

self.onmessage = (e: MessageEvent) => {
  const { id, bars, signals, config, tf } = e.data
  try {
    const res = simulate(bars, signals, config, tf)
    ;(self as unknown as Worker).postMessage({ id, ok: true, res })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, ok: false, error: String((err as Error).message) })
  }
}
