import { useEffect, useState, useSyncExternalStore } from 'react'
import { livePrice, prevClosePrice, subscribeTicks } from '../data/feed'
import { getActivity, listCommands, subscribeActivity, subscribeCommands, commandsVersion } from '../core/commands'

let tickVersion = 0
const versionListeners = new Set<() => void>()
subscribeTicks(() => {
  tickVersion++
  versionListeners.forEach((l) => l())
})

/** Re-render on every simulated tick. */
export function useTick() {
  return useSyncExternalStore(
    (l) => {
      versionListeners.add(l)
      return () => versionListeners.delete(l)
    },
    () => tickVersion,
  )
}

export function useQuote(symbol: string) {
  useTick()
  const last = livePrice(symbol)
  const prev = prevClosePrice(symbol)
  return { last, prev, change: last - prev, changePct: ((last - prev) / prev) * 100 }
}

/** Returns 'up' | 'down' briefly after a price change, for flash animation. */
export function useFlash(value: number) {
  const [state, setState] = useState<{ v: number; dir: 'up' | 'down' | null; k: number }>({ v: value, dir: null, k: 0 })
  useEffect(() => {
    if (value !== state.v) setState((s) => ({ v: value, dir: value > s.v ? 'up' : 'down', k: s.k + 1 }))
  }, [value, state.v])
  return state
}

export function useCommands() {
  const v = useSyncExternalStore(subscribeCommands, commandsVersion)
  return { version: v, commands: listCommands() }
}

let actVersion = 0
subscribeActivity(() => actVersion++)
export function useActivity() {
  useSyncExternalStore(subscribeActivity, () => actVersion)
  return getActivity()
}

export function useReducedMotion() {
  const [r, setR] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)')
    const h = () => setR(m.matches)
    m.addEventListener('change', h)
    return () => m.removeEventListener('change', h)
  }, [])
  return r
}
