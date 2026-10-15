import type { MarketSeries } from "./feed";

export function marketStatus(data: MarketSeries, now = Date.now()) {
  if ((!data.loadedAt || data.loading) && !data.bars.length && !data.error)
    return { label: "Loading", tone: "text-muted" };
  if (data.error)
    return { label: data.bars.length ? "Cached" : "History error", tone: "text-demo" };
  if (data.status === "reconnecting" || data.status === "connecting")
    return { label: data.bars.length ? "Connecting" : "Loading", tone: "text-muted" };
  if (data.streamError || data.status === "disconnected")
    return { label: "Feed issue", tone: "text-demo" };
  if (data.marketState?.open === false) return { label: "Closed", tone: "text-muted" };
  if (!data.quoteReceivedAt)
    return { label: data.bars.length ? "History" : "Waiting", tone: "text-muted" };
  if (data.identity?.delay.kind === "delayed") return { label: "Delayed", tone: "text-demo" };
  if (data.identity?.delay.kind === "unknown") return { label: "Unverified", tone: "text-demo" };
  const fresh =
    now - data.quoteReceivedAt < 15_000 &&
    data.eventTime != null &&
    now - data.eventTime < 15_000 &&
    data.status === "connected";
  return fresh
    ? { label: "Live", tone: "text-up" }
    : { label: "As of last quote", tone: "text-muted" };
}
