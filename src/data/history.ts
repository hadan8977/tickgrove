import type { Bar } from "../core/types";

export type HistoryState = "idle" | "loading" | "ready" | "empty" | "error";

/** Incoming bars replace matching timestamps; missing volume stays unknown. */
export function mergeHistory(
  existing: (Omit<Bar, "volume"> & { volume: number | null })[],
  incoming: Bar[],
): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const bar of [...existing, ...incoming]) {
    if (![bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) continue;
    byTime.set(bar.time, { ...bar, volume: bar.volume == null ? Number.NaN : bar.volume });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function historyPresentation(data: {
  bars: Bar[];
  historyState?: HistoryState;
  loading: boolean;
  error?: string;
}) {
  if (data.bars.length) return data.error ? "cached-error" : "ready";
  if (data.loading || !data.historyState || data.historyState === "idle") return "loading";
  return data.historyState === "error"
    ? "error"
    : data.historyState === "empty"
      ? "empty"
      : "loading";
}

/** Preserve the visible candles when older bars are prepended. */
export function prependedBarCount(previousFirstTime: number | undefined, next: Bar[]) {
  return previousFirstTime === undefined
    ? 0
    : Math.max(
        0,
        next.findIndex((b) => b.time === previousFirstTime),
      );
}
