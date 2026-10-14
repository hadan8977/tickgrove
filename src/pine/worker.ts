import { runPine } from './runtime'

self.onmessage = async (e: MessageEvent) => {
  const { source, bars, tf, options } = e.data
  self.postMessage(await runPine(source, bars, tf, options))
}
