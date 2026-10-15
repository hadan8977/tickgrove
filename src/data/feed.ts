import type { Bar, SymbolInfo, Timeframe } from "../core/types";
import type { MarketEvent, MarketHistoryResult, MarketIdentity } from "../core/marketTypes";
import type { PineRunOptions } from "../pine/runtime";
import { command } from "../service/client";
import * as demo from "./demoFeed";
import { mergeHistory, type HistoryState } from "./history";

export type DataMode = "service" | "demo";
let mode: DataMode =
  typeof location !== "undefined" && new URLSearchParams(location.search).get("mode") === "demo"
    ? "demo"
    : "service";
let connected = false,
  revision = 0,
  polling = false;
let timer: ReturnType<typeof setInterval> | undefined;
let demoOff: (() => void) | undefined;
type Listener = (prices: Record<string, number>) => void;
const listeners = new Set<Listener>();
const prices: Record<string, number> = {},
  previous: Record<string, number> = {};
// Initial watchlist suggestions, never a provider whitelist or fallback prices.
export const SYMBOLS: SymbolInfo[] = demo.SYMBOLS.map((s) => ({
  ...s,
  price: Number.NaN,
  vol: Number.NaN,
  exchange: s.kind === "crypto" ? "COINBASE" : s.exchange,
}));
export interface Instrument extends SymbolInfo {
  provider?: "yahoo" | "coinbase" | "alpaca";
  providerSymbol?: string;
  currency?: string;
  pricePrecision?: number;
}
export interface MarketSeries {
  bars: Bar[];
  snapshotId?: string;
  identity?: MarketIdentity;
  metadata?: Record<string, unknown>;
  loading: boolean;
  historyState: HistoryState;
  historyGeneration?: number;
  connectionGeneration?: number;
  loadingOlder?: boolean;
  olderError?: string;
  hasMore?: boolean;
  nextBefore?: number | null;
  coverageStart?: number;
  coverageReason?: string;
  cacheHit?: boolean;
  lastQuote?: { bid?: number; ask?: number; mid?: number; time: number };
  marketState?: {
    state: string;
    open: boolean;
    asOf: number;
    timezone?: string;
    selectedSession?: string;
  };
  error?: string;
  streamError?: string;
  subscriptionId?: string;
  cursor: number;
  status: string;
  eventTime?: number;
  receivedAt?: number;
  quoteReceivedAt?: number;
  complete: boolean;
  revision: number;
  loadedAt?: number;
  provenance?: Record<string, unknown>;
  gaps?: { start: number; end: number }[];
  historyRange?: { start: number; end: number; live: boolean };
  subscribing?: boolean;
}
export interface TradePrint {
  id: string;
  time: number;
  price: number;
  size: number;
  side?: string;
}
export interface DepthSnapshot {
  asks: { price: number; size: number }[];
  bids: { price: number; size: number }[];
  spread: number;
  receivedAt?: number;
  kind?: string;
  error?: string;
}
const series = new Map<string, MarketSeries>(),
  trades = new Map<string, TradePrint[]>(),
  books = new Map<string, DepthSnapshot>();
const depthInFlight = new Set<string>(),
  histories = new Map<string, Promise<MarketSeries>>();
const olderHistories = new Map<string, Promise<MarketSeries>>();
const quoteLoaded = new Set<string>();
const subscriptionsInFlight = new Map<string, Promise<string>>();
const EMPTY_BOOK: DepthSnapshot = { asks: [], bids: [], spread: Number.NaN };
const queued: (() => void)[] = [];
let activeRequests = 0;
async function budget<T>(work: () => Promise<T>): Promise<T> {
  if (activeRequests >= 3) await new Promise<void>((resolve) => queued.push(resolve));
  activeRequests++;
  try {
    return await work();
  } finally {
    activeRequests--;
    queued.shift()?.();
  }
}
function emit() {
  revision++;
  for (const listener of listeners) listener(prices);
}
export const feedVersion = () => revision;
export const isDemoData = () => mode === "demo";
export const isServiceDataReady = () => mode === "service" && connected;
export function configureData(next: DataMode, authenticated = false) {
  mode = next;
  connected = authenticated;
  demoOff?.();
  demoOff = undefined;
  if (timer) clearInterval(timer);
  timer = undefined;
  if (mode === "demo")
    demoOff = demo.subscribeTicks((value) => {
      Object.assign(prices, value);
      emit();
    });
  else if (connected)
    timer = setInterval(() => {
      void poll();
    }, 700);
  emit();
}
export function invalidateProviderConnection(provider: string) {
  for (const entry of series.values()) {
    if (entry.identity?.provider !== provider) continue;
    entry.historyGeneration = (entry.historyGeneration ?? 0) + 1;
    entry.connectionGeneration = (entry.connectionGeneration ?? 0) + 1;
    entry.subscriptionId = undefined;
    entry.status = "stopped";
    entry.cursor = 0;
    entry.error = "Account connection changed. Retry to load data with the current connection.";
    entry.historyState = "error";
    entry.quoteReceivedAt = undefined;
  }
  emit();
}
export function subscribeTicks(listener: Listener) {
  listeners.add(listener);
  if (mode === "demo" && !demoOff)
    demoOff = demo.subscribeTicks((value) => {
      Object.assign(prices, value);
      emit();
    });
  return () => {
    listeners.delete(listener);
  };
}
export function registerInstrument(value: Partial<Instrument> & { symbol: string }): Instrument {
  const found = SYMBOLS.find((s) => s.symbol === value.symbol);
  const next = {
    name: value.name ?? value.symbol,
    exchange: value.exchange ?? "Unresolved",
    sector: value.sector ?? "",
    kind: value.kind ?? "stock",
    price: Number.NaN,
    vol: Number.NaN,
    ...found,
    ...value,
  } as Instrument;
  if (found) Object.assign(found, next);
  else SYMBOLS.push(next);
  return next;
}
export function symbolInfo(symbol: string): Instrument {
  const known = SYMBOLS.find((s) => s.symbol === symbol);
  if (known) return known;
  const parts = symbol.split(":"),
    provider = parts[0].toLowerCase();
  return registerInstrument({
    symbol,
    name: parts.at(-1),
    provider: ["coinbase", "yahoo", "alpaca"].includes(provider)
      ? (provider as Instrument["provider"])
      : "yahoo",
    providerSymbol: parts.at(-1),
    kind: provider === "coinbase" ? "crypto" : "stock",
    exchange: parts.length > 1 ? parts[0] : "Unresolved",
  });
}
export function marketRequest(symbol: string, tf: Timeframe = "1D") {
  const info = symbolInfo(symbol),
    parts = symbol.split(":");
  const provider = info.provider ?? (info.kind === "crypto" ? "coinbase" : "yahoo");
  const raw =
    info.providerSymbol ??
    (symbol === "BTCUSD" ? "BTC-USD" : symbol === "ETHUSD" ? "ETH-USD" : parts.at(-1)!);
  const feed = provider === "alpaca" ? (parts.length > 2 ? parts[1] : "iex") : undefined;
  const session = feed === "boats" || feed === "overnight" ? "overnight" : parts.slice(1, -1).includes("extended") ? "extended" : "regular";
  return {
    provider,
    symbol: raw,
    timeframe: tf,
    ...(feed ? { feed } : {}),
    ...(["yahoo", "alpaca"].includes(provider) ? { session } : {}),
    adjustment: provider === "coinbase" ? "none" : "raw",
  };
}
export function marketSeries(symbol: string, tf: Timeframe): MarketSeries {
  const key = `${symbol}|${tf}`;
  if (!series.has(key))
    series.set(key, {
      bars: [],
      loading: false,
      historyState: "idle",
      cursor: 0,
      status: "not-connected",
      complete: false,
      revision: 0,
    });
  return series.get(key)!;
}
function windowSeconds(tf: Timeframe) {
  return tf === "1m"
    ? 86400 * 2
    : tf === "5m" || tf === "15m"
      ? 86400 * 14
      : tf === "1H" || tf === "4H"
        ? 86400 * 45
        : 86400 * 450;
}
export async function loadMarketHistory(
  symbol: string,
  tf: Timeframe,
  range?: { start: number; end: number },
  options: { force?: boolean } = {},
): Promise<MarketSeries> {
  if (!connected) throw Error("Connect to the trading service before loading market data");
  const key = `${symbol}|${tf}`,
    existing = histories.get(key);
  if (existing) {
    const done = await existing;
    if (range && (done.historyRange?.start !== range.start || done.historyRange?.end !== range.end))
      return loadMarketHistory(symbol, tf, range);
    return done;
  }
  const entry = marketSeries(symbol, tf);
  if (
    !options.force &&
    !range &&
    entry.loadedAt &&
    entry.bars.length &&
    entry.historyRange?.live &&
    Date.now() - entry.loadedAt < 30_000 &&
    !entry.error
  )
    return entry;
  const generation = (entry.historyGeneration = (entry.historyGeneration ?? 0) + 1);
  entry.loadingOlder = false;
  entry.olderError = undefined;
  entry.loading = true;
  entry.historyState = "loading";
  entry.error = undefined;
  emit();
  const task = budget(async () => {
    try {
      const end = range?.end ?? Math.floor(Date.now() / 1000);
      const start = range?.start ?? end - windowSeconds(tf);
      const result = await command<MarketHistoryResult>(
        range ? "market.history" : "market.historyPage",
        {
          ...marketRequest(symbol, tf),
          ...(range ? { start, end } : { limit: 1000 }),
          allowGaps: true,
        },
      );
      if (generation !== entry.historyGeneration) return entry;
      entry.historyRange = {
        start: range?.start ?? result.data.bars[0]?.time ?? start,
        end: result.page?.requestedEnd ?? end,
        live: !range,
      };
      entry.hasMore = result.page?.hasMore ?? false;
      entry.nextBefore = result.page?.nextBefore;
      entry.coverageStart = result.page?.coverageStart;
      entry.coverageReason = result.page?.reason;
      entry.cacheHit = result.cache?.hit;
      entry.bars.splice(
        0,
        entry.bars.length,
        ...result.data.bars.map((b) => ({
          ...b,
          volume: b.volume ?? Number.NaN,
        })),
      );
      entry.snapshotId = result.snapshot_id ?? undefined;
      entry.identity = result.identity;
      entry.metadata = result.data.metadata;
      entry.provenance = result.provenance;
      entry.gaps = result.gaps;
      entry.revision++;
      entry.complete = !result.gaps.length;
      entry.loadedAt = Date.now();
      entry.historyState = entry.bars.length ? "ready" : "empty";
      if (!entry.subscriptionId) entry.status = "historical";
      const last = entry.bars.at(-1);
      if (last && !Number.isFinite(prices[symbol])) prices[symbol] = last.close;
      if (tf === "1D" && entry.bars.length >= 2 && !Number.isFinite(previous[symbol]))
        previous[symbol] = entry.bars.at(-2)!.close;
      const raw = result.provenance.rawMetadata as Record<string, unknown> | undefined;
      const prev = Number(raw?.previousClose);
      if (Number.isFinite(prev) && prev > 0) previous[symbol] = prev;
      if (!quoteLoaded.has(symbol)) {
        quoteLoaded.add(symbol);
        void budget(async () => {
          try {
            const quote = await command<Record<string, any>>(
              "market.quote",
              marketRequest(symbol, tf),
            );
            const price = Number(quote.price),
              prev = Number(quote.previousClose);
            if (Number.isFinite(price) && price > 0) prices[symbol] = price;
            if (Number.isFinite(prev) && prev > 0) previous[symbol] = prev;
            emit();
          } catch {
            quoteLoaded.delete(symbol);
          }
        });
      }
      registerInstrument({
        symbol,
        provider: result.identity.provider,
        providerSymbol: result.identity.symbol,
        currency: result.identity.currency,
        pricePrecision: result.identity.pricePrecision,
        exchange: result.identity.venue,
        kind:
          result.identity.assetClass === "crypto"
            ? "crypto"
            : result.identity.assetClass === "etf"
              ? "etf"
              : "stock",
      });
      if (!entry.subscriptionId && !range)
        void subscribeMarket(symbol, tf).catch((error) => {
          entry.streamError = String(error);
          emit();
        });
      else if (entry.subscriptionId && !range) await hydrateMarket(symbol, entry);
      return entry;
    } catch (error) {
      entry.error = String(error);
      entry.historyState = "error";
      throw error;
    } finally {
      entry.loading = false;
      histories.delete(key);
      emit();
    }
  });
  histories.set(key, task);
  return task;
}
export async function loadOlderHistory(symbol: string, tf: Timeframe): Promise<MarketSeries> {
  const entry = marketSeries(symbol, tf),
    key = `${symbol}|${tf}`;
  const pending = olderHistories.get(key);
  if (pending) return pending;
  if (!connected || mode === "demo" || entry.loading || entry.hasMore !== true) return entry;
  const generation = entry.historyGeneration;
  const before = entry.nextBefore ?? entry.bars[0]?.time;
  if (!Number.isFinite(before)) return entry;
  entry.loadingOlder = true;
  entry.olderError = undefined;
  emit();
  const task = budget(async () => {
    try {
      const result = await command<MarketHistoryResult>("market.historyPage", {
        ...marketRequest(symbol, tf),
        before,
        limit: 1000,
        allowGaps: true,
      });
      if (generation !== entry.historyGeneration) return entry;
      if (result.page?.hasMore && !(Number(result.page.nextBefore) < Number(before)))
        throw Error("The source did not advance the history cursor. Try again later.");
      entry.bars = mergeHistory(result.data.bars, entry.bars);
      entry.historyState = entry.bars.length ? "ready" : "empty";
      entry.hasMore = result.page?.hasMore === true;
      entry.nextBefore = result.page?.nextBefore;
      entry.coverageStart = result.page?.coverageStart ?? entry.coverageStart;
      entry.coverageReason = result.page?.reason;
      entry.cacheHit = result.cache?.hit;
      entry.snapshotId = undefined;
      if (entry.historyRange && entry.bars.length) entry.historyRange.start = entry.bars[0].time;
      entry.gaps = [...(result.gaps ?? []), ...(entry.gaps ?? [])];
      entry.revision++;
      return entry;
    } catch (error) {
      if (generation === entry.historyGeneration) entry.olderError = String(error);
      throw error;
    } finally {
      if (generation === entry.historyGeneration) entry.loadingOlder = false;
      olderHistories.delete(key);
      emit();
    }
  });
  olderHistories.set(key, task);
  return task;
}

export async function prepareMarketSnapshot(
  symbol: string,
  tf: Timeframe,
): Promise<MarketHistoryResult> {
  let entry = marketSeries(symbol, tf);
  const pending = histories.get(`${symbol}|${tf}`);
  if (pending) entry = await pending;
  else if (!entry.bars.length) entry = await loadMarketHistory(symbol, tf);
  if (entry.error) throw Error(entry.error);
  if (!entry.bars.length) throw Error("No historical bars are available for this range");
  const range = entry.historyRange!;
  const result = await command<MarketHistoryResult>("market.history", {
    ...marketRequest(symbol, tf),
    start: range.start,
    end: range.live ? Math.floor(Date.now() / 1000) : range.end,
    allowGaps: false,
  });
  if (!result.snapshot_id) throw Error("The server did not create an immutable data snapshot");
  entry.snapshotId = result.snapshot_id;
  return result;
}
export function ensureMarket(symbol: string, tf: Timeframe) {
  if (!connected || mode === "demo") return;
  const entry = marketSeries(symbol, tf);
  if (!entry.loadedAt && !entry.loading && !entry.error) {
    entry.loading = true;
    entry.historyState = "loading";
    queueMicrotask(() => {
      if (connected && !entry.loadedAt && !entry.error)
        void loadMarketHistory(symbol, tf).catch(() => {});
      else if (!connected) {
        entry.loading = false;
        entry.historyState = "idle";
      }
    });
  }
}
export function getBars(symbol: string, tf: Timeframe): Bar[] {
  if (mode === "demo") return demo.getBars(symbol, tf);
  ensureMarket(symbol, tf);
  return marketSeries(symbol, tf).bars;
}
export function livePrice(symbol: string) {
  if (mode === "demo") return demo.livePrice(symbol);
  ensureMarket(symbol, "1D");
  return prices[symbol] ?? Number.NaN;
}
export function prevClosePrice(symbol: string) {
  return mode === "demo" ? demo.prevClosePrice(symbol) : (previous[symbol] ?? Number.NaN);
}
export function formatInstrumentPrice(symbol: string, value: number) {
  if (!Number.isFinite(value)) return "—";
  const precision = Math.max(
    0,
    Math.min(
      20,
      symbolInfo(symbol).pricePrecision ?? (Math.abs(value) > 0 && Math.abs(value) < 1 ? 8 : 2),
    ),
  );
  return value.toLocaleString("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}
export function tradeTape(symbol: string) {
  return trades.get(symbol) ?? [];
}
export function orderBook(symbol: string, levels = 10): DepthSnapshot {
  if (mode === "demo") return demo.orderBook(symbol, levels);
  const value = books.get(symbol) ?? EMPTY_BOOK;
  return {
    ...value,
    asks: value.asks.slice(0, levels),
    bids: value.bids.slice(0, levels),
  };
}
export async function loadDepth(symbol: string) {
  if (!connected || mode === "demo" || depthInFlight.has(symbol)) return;
  const request = marketRequest(symbol);
  if (request.provider !== "coinbase") {
    books.set(symbol, {
      ...EMPTY_BOOK,
      error: "This provider has no authenticated depth feed configured.",
    });
    return;
  }
  depthInFlight.add(symbol);
  try {
    const response = await command<{
      book: { asks: [string, string][]; bids: [string, string][] };
      receivedAt: number;
      kind: string;
    }>("market.depth", request);
    const map = (rows: [string, string][]) =>
      rows
        .map(([p, q]) => ({ price: Number(p), size: Number(q) }))
        .filter((x) => Number.isFinite(x.price) && Number.isFinite(x.size));
    const asks = map(response.book.asks),
      bids = map(response.book.bids);
    books.set(symbol, {
      asks,
      bids,
      spread: asks[0]?.price - bids[0]?.price,
      receivedAt: response.receivedAt,
      kind: response.kind,
    });
  } catch (error) {
    books.set(symbol, {
      ...(books.get(symbol) ?? EMPTY_BOOK),
      error: String(error),
    });
  } finally {
    depthInFlight.delete(symbol);
    emit();
  }
}
export async function subscribeMarket(symbol: string, tf: Timeframe) {
  const entry = marketSeries(symbol, tf);
  const key = `${symbol}|${tf}`,
    pending = subscriptionsInFlight.get(key);
  if (pending) return pending;
  if (entry.subscriptionId) return entry.subscriptionId;
  entry.subscribing = true;
  const generation = entry.connectionGeneration;
  const task = (async () => {
    try {
      const response = await command<{
        subscription_id: string;
        identity: MarketIdentity;
        status?: string;
      }>("market.subscribe", marketRequest(symbol, tf));
      if (generation !== entry.connectionGeneration)
        throw Error("Account connection changed. Reopen this chart.");
      entry.subscriptionId = response.subscription_id;
      entry.identity = response.identity;
      entry.status = response.status ?? "connecting";
      await hydrateMarket(symbol, entry);
      return response.subscription_id;
    } finally {
      entry.subscribing = false;
      subscriptionsInFlight.delete(key);
      emit();
    }
  })();
  subscriptionsInFlight.set(key, task);
  return task;
}
async function hydrateMarket(symbol: string, entry: MarketSeries) {
  const subscriptionId = entry.subscriptionId;
  const value = await command<any>("market.bars", {
    subscription_id: subscriptionId,
  });
  if (subscriptionId !== entry.subscriptionId) return;
  for (let index = 0; index < (value.bars?.length ?? 0); index++) {
    const bar = value.bars[index];
    if (value.quality?.[index]?.complete !== false || !entry.bars.some((b) => b.time === bar.time))
      updateBar(entry, bar);
  }
  if (value.forming?.bar) updateBar(entry, value.forming.bar);
  entry.revision++;
  if (value.status) entry.status = value.status;
  if (value.identity) entry.identity = value.identity;
  if (value.marketState) entry.marketState = value.marketState;
  if (Number.isFinite(value.cursor)) entry.cursor = Math.max(entry.cursor, value.cursor);
  if (value.lastQuote && (!entry.eventTime || value.lastQuote.eventTime >= entry.eventTime))
    processMarketEvent(symbol, entry, {
      cursor: entry.cursor,
      subscriptionId: entry.subscriptionId!,
      identity: entry.identity!,
      type: "quote",
      eventTime: value.lastQuote.eventTime,
      receivedAt: value.lastQuote.receivedAt,
      payload: value.lastQuote,
      quality: value.quoteQuality,
    });
}
export async function stopMarket(subscriptionId: string) {
  await command("market.stop", { subscription_id: subscriptionId });
  for (const entry of series.values())
    if (entry.subscriptionId === subscriptionId) {
      entry.subscriptionId = undefined;
      entry.status = "stopped";
      entry.cursor = 0;
    }
  emit();
}
function updateBar(entry: MarketSeries, value: Bar) {
  if (entry.historyRange?.live === false) return;
  if (!Number.isFinite(value?.time) || !Number.isFinite(value?.close)) return;
  if (value.volume == null) value = { ...value, volume: Number.NaN };
  const i = entry.bars.findIndex((b) => b.time === value.time);
  if (i >= 0) entry.bars[i] = value;
  else {
    entry.bars.push(value);
    entry.bars.sort((a, b) => a.time - b.time);
  }
}
function processMarketEvent(symbol: string, entry: MarketSeries, event: MarketEvent) {
  entry.cursor = event.cursor;
  entry.receivedAt = event.receivedAt;
  entry.identity = event.identity;
  const data = event.payload as Record<string, any>;
  if (event.type === "quote" || event.type === "trade") {
    const price = Number(data.price ?? data.p ?? data.quote?.price);
    if (event.type === "quote") {
      const bid = Number(data.bid ?? data.bp),
        ask = Number(data.ask ?? data.ap);
      entry.lastQuote = {
        ...(Number.isFinite(bid) && bid > 0 ? { bid } : {}),
        ...(Number.isFinite(ask) && ask > 0 ? { ask } : {}),
        ...(bid > 0 && ask > 0 ? { mid: (bid + ask) / 2 } : {}),
        time: event.eventTime,
      };
    }
    if (
      Number.isFinite(price) &&
      price > 0 &&
      (event.type === "trade" || (event.identity.provider !== "alpaca" && data.priceKind !== "mid"))
    ) {
      prices[symbol] = price;
    }
    if (
      (Number.isFinite(price) && price > 0) ||
      (event.type === "quote" && (entry.lastQuote?.bid || entry.lastQuote?.ask))
    ) {
      entry.eventTime = event.eventTime;
      entry.quoteReceivedAt = event.receivedAt;
    }
    const prev = Number(
      data.previousClose ??
        (data.change != null ? price - Number(data.change) : undefined) ??
        data.open_24h,
    );
    if (Number.isFinite(prev) && prev > 0) previous[symbol] = prev;
  }
  if (event.type === "trade") {
    const list = trades.get(symbol) ?? [],
      id = String(data.trade_id ?? data.i ?? event.cursor);
    if (!list.some((t) => t.id === id))
      list.unshift({
        id,
        time: event.eventTime,
        price: Number(data.price ?? data.p),
        size: Number(data.size ?? data.s),
        side: data.side,
      });
    trades.set(symbol, list.slice(0, 100));
  }
  if (["bar.update", "bar.closed", "bar.revised"].includes(event.type)) {
    updateBar(entry, (data.bar ?? data) as Bar);
    if (event.type === "bar.revised") entry.revision++;
  }
  if (event.type === "connection") {
    if (data.status) entry.status = String(data.status);
    if (data.error != null) entry.streamError = String(data.error);
    else if (data.status === "connected") entry.streamError = undefined;
  }
  if (event.type === "gap") {
    entry.complete = false;
    entry.streamError = String(data.reason ?? "Market data gap detected");
  }
}
async function poll() {
  if (polling || !connected || mode === "demo") return;
  polling = true;
  try {
    const selected = [...series].filter(([, value]) => value.subscriptionId && !value.subscribing);
    for (let offset = 0; offset < selected.length; offset += 4)
      await Promise.all(
        selected.slice(offset, offset + 4).map(async ([key, entry]) => {
          const subscriptionId = entry.subscriptionId;
          try {
            const result = await command<{
              events: MarketEvent[];
              nextCursor: number;
              cursorExpired?: boolean;
              marketState?: MarketSeries["marketState"];
            }>("market.events", {
              subscription_id: subscriptionId,
              cursor: entry.cursor,
              limit: 1000,
            });
            if (subscriptionId !== entry.subscriptionId) return;
            if (result.marketState) entry.marketState = result.marketState;
            if (result.cursorExpired) {
              entry.complete = false;
              entry.streamError =
                "Earlier stream events have expired; refreshed current bars and quote. Missed trade prints are unavailable.";
              await hydrateMarket(key.split("|")[0], entry);
              return;
            }
            for (const event of result.events)
              if (event.cursor > entry.cursor) processMarketEvent(key.split("|")[0], entry, event);
            entry.cursor = Math.max(entry.cursor, result.nextCursor);
          } catch (error) {
            if (subscriptionId !== entry.subscriptionId) return;
            entry.status = "disconnected";
            entry.streamError = String(error);
          }
        }),
      );
  } finally {
    polling = false;
    emit();
  }
}
export function dataPineOptions(
  symbol: string,
  tf: Timeframe,
  inputs?: Record<string, unknown>,
): PineRunOptions {
  const primary = marketSeries(symbol, tf);
  const chosen = new Map<string, MarketSeries>();
  for (const entry of series.values())
    if (
      entry !== primary &&
      entry.identity &&
      entry.bars.length &&
      entry.identity.provider === primary.identity?.provider &&
      entry.identity.feed === primary.identity.feed &&
      entry.identity.session === primary.identity.session &&
      entry.identity.adjustment === primary.identity.adjustment
    ) {
      const key = `${entry.identity.symbol}|${entry.identity.timeframe}`;
      if (key !== `${primary.identity.symbol}|${primary.identity.timeframe}`)
        chosen.set(key, entry);
    }
  return {
    symbol: primary.identity?.symbol ?? marketRequest(symbol, tf).symbol,
    inputs,
    metadata: primary.metadata as PineRunOptions["metadata"],
    datasets: [...chosen.values()].map((e) => ({
      symbol: e.identity!.symbol,
      timeframe: e.identity!.timeframe,
      bars: e.bars,
      metadata: e.metadata as PineRunOptions["metadata"],
    })),
  };
}
export function marketSummary() {
  return [...series].map(([key, value]) => ({
    key,
    ...value,
    bars: value.bars.length,
  }));
}
export async function searchMarket(query: string, provider?: string): Promise<Instrument[]> {
  if (mode === "demo")
    return SYMBOLS.filter((s) => (s.symbol + s.name).toLowerCase().includes(query.toLowerCase()));
  const result = await command<{ symbols: Record<string, any>[] }>("market.search", {
    query,
    provider,
  });
  return result.symbols.map((raw) =>
    registerInstrument({
      symbol: `${String(raw.provider ?? "yahoo").toUpperCase()}:${raw.symbol}`,
      provider: raw.provider ?? "yahoo",
      providerSymbol: raw.symbol,
      name: raw.name ?? raw.symbol,
      exchange: raw.venue ?? raw.exchange ?? "",
      currency: raw.currency,
      kind:
        String(raw.assetClass).toLowerCase() === "crypto"
          ? "crypto"
          : String(raw.assetClass).toLowerCase() === "etf"
            ? "etf"
            : "stock",
    }),
  );
}
