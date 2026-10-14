import type { PineReplayFrame } from '../core/types'

/** Playback of the frozen native ledger, without placing duplicate broker orders. */
export function advanceReplay(frames: readonly PineReplayFrame[], cursor: number, steps = 1) {
  if (!frames.length) throw new Error('No Pine replay frames available')
  const next = Math.min(frames.length, Math.max(0, cursor) + Math.max(1, Math.floor(steps)))
  return { cursor: next, total: frames.length, frame: { ...frames[next - 1] }, completed: next === frames.length }
}
