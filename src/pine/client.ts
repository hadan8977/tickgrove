import type { Bar, Timeframe } from '../core/types'
import { detectKind, detectTitle, type PineRunOptions, type PineRunResult } from './runtime'

/** Terminating a dedicated worker stops even synchronous script loops. */
export function runPineInWorker(source: string, bars: Bar[], tf: Timeframe = '1D', options: PineRunOptions = {}, signal?: AbortSignal): Promise<PineRunResult> {
  return new Promise(resolve => {
    const start = performance.now()
    let worker: Worker | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let finished = false
    const fail = (message: string) => finish({ ok: false, kind: detectKind(source), title: detectTitle(source), overlay: false,
      plots: [], signals: [], warnings: [], error: { message }, ms: performance.now() - start })
    const abort = () => fail('Pine run cancelled')
    const finish = (result: PineRunResult) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      worker?.terminate()
      resolve(result)
    }
    if (signal?.aborted) { abort(); return }
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = e => finish(e.data)
      worker.onerror = e => { e.preventDefault(); fail(e.message || 'Pine worker failed') }
      worker.onmessageerror = () => fail('Pine worker returned invalid data')
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => fail('Pine run exceeded 15 seconds and was stopped'), 15_000)
      worker.postMessage({ source, bars, tf, options })
    } catch (e) { fail(`Cannot start Pine worker: ${(e as Error).message}`) }
  })
}
