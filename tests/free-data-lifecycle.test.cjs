const { test } = require("node:test");
const assert = require("node:assert/strict");
require("../scripts/register-typescript.cjs");
const feed = require("../src/data/feed.ts");
const { historyPresentation, prependedBarCount } = require("../src/data/history.ts");
const { marketStatus } = require("../src/data/marketStatus.ts");
const bar = (time, close = time) => ({
  time,
  closeTime: time + 60,
  open: close,
  high: close,
  low: close,
  close,
  volume: null,
});
const identity = {
  provider: "coinbase",
  symbol: "TEST-USD",
  feed: "exchange",
  assetClass: "crypto",
  venue: "COINBASE",
  currency: "USD",
  pricePrecision: 2,
  delay: { kind: "realtime" },
};
const page = (times, overrides = {}) => ({
  snapshot_id: null,
  identity,
  hash: "test",
  bars: times.length,
  data: { metadata: {}, bars: times.map((t) => (typeof t === "object" ? t : bar(t))) },
  provenance: {},
  gaps: [],
  page: { hasMore: true, nextBefore: times[0]?.time ?? times[0] ?? 100, requestedEnd: 1000 },
  ...overrides,
});
const tick = () => new Promise((r) => setImmediate(r));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function fixture(t, handler) {
  const saved = global.fetch,
    calls = [];
  global.fetch = async (_, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    let result;
    if (request.method === "market.quote") result = {};
    else if (request.method === "market.subscribe")
      result = {
        subscription_id: request.params.symbol + request.params.timeframe,
        identity,
        status: "connected",
      };
    else if (request.method === "market.bars") result = { bars: [], cursor: 0 };
    else if (request.method === "market.events") result = { events: [], cursor: 0 };
    else result = await handler(request);
    return { ok: true, json: async () => result };
  };
  feed.configureData("service", true);
  t.after(async () => {
    await tick();
    feed.configureData("service", false);
    global.fetch = saved;
  });
  return calls;
}
test("cold chart is loading immediately, overlapping intervals stay isolated and recent data is reused", async (t) => {
  const minute = deferred(),
    hour = deferred();
  const calls = fixture(t, (r) => (r.params.timeframe === "1m" ? minute.promise : hour.promise));
  const symbol = "COINBASE:LIFECYCLE-USD";
  feed.ensureMarket(symbol, "1m");
  assert.equal(historyPresentation(feed.marketSeries(symbol, "1m")), "loading");
  await tick();
  const m = feed.loadMarketHistory(symbol, "1m"),
    h = feed.loadMarketHistory(symbol, "1H");
  hour.resolve(page([3600]));
  await h;
  assert.equal(historyPresentation(feed.marketSeries(symbol, "1m")), "loading");
  assert.deepEqual(
    feed.marketSeries(symbol, "1H").bars.map((b) => b.time),
    [3600],
  );
  minute.resolve(page([60, 120]));
  await m;
  assert.equal(historyPresentation(feed.marketSeries(symbol, "1m")), "ready");
  await feed.loadMarketHistory(symbol, "1m");
  assert.equal(calls.filter((c) => c.method === "market.historyPage").length, 2);
  assert.deepEqual(
    feed.marketSeries(symbol, "1H").bars.map((b) => b.time),
    [3600],
  );
});
test("older pages deduplicate boundaries, preserve the current candle and viewport anchor", async (t) => {
  fixture(t, (r) =>
    r.params.before
      ? page([bar(60), bar(120, 999)], { page: { hasMore: false, nextBefore: null } })
      : page([120, 180]),
  );
  const symbol = "COINBASE:PAGING-USD";
  const first = await feed.loadMarketHistory(symbol, "1m");
  const anchor = first.bars[0].time;
  await feed.loadOlderHistory(symbol, "1m");
  assert.deepEqual(
    first.bars.map((b) => b.time),
    [60, 120, 180],
  );
  assert.equal(first.bars[1].close, 120);
  assert(Number.isNaN(first.bars[0].volume));
  assert.equal(prependedBarCount(anchor, first.bars), 1);
  assert.equal(first.snapshotId, undefined);
});
test("empty trading windows can advance to earlier pages without claiming the history ended", async (t) => {
  fixture(t, (r) =>
    r.params.before ? page([60], { page: { hasMore: false, nextBefore: null } }) : page([]),
  );
  const symbol = "COINBASE:EMPTY-WINDOW-USD";
  const entry = await feed.loadMarketHistory(symbol, "1m");
  assert.equal(historyPresentation(entry), "empty");
  await feed.loadOlderHistory(symbol, "1m");
  assert.equal(historyPresentation(entry), "ready");
  assert.equal(entry.bars.length, 1);
});
test("refresh failure retains cached bars and retry recovers the same chart", async (t) => {
  let fail = false;
  fixture(t, () => {
    if (fail) throw Error("upstream unavailable");
    return page([60, 120]);
  });
  const symbol = "COINBASE:RETRY-USD";
  const entry = await feed.loadMarketHistory(symbol, "1m");
  fail = true;
  await assert.rejects(
    feed.loadMarketHistory(symbol, "1m", undefined, { force: true }),
    /upstream unavailable/,
  );
  assert.equal(historyPresentation(entry), "cached-error");
  assert.equal(entry.bars.length, 2);
  fail = false;
  await feed.loadMarketHistory(symbol, "1m", undefined, { force: true });
  assert.equal(historyPresentation(entry), "ready");
});
test("late older-page response cannot contaminate a newly selected explicit range or its backtest", async (t) => {
  const old = deferred();
  const calls = fixture(t, (r) =>
    r.params.before
      ? old.promise
      : r.method === "market.history"
        ? page([600, 660], { snapshot_id: "immutable-range", page: undefined })
        : page([120, 180]),
  );
  const symbol = "COINBASE:RANGE-USD";
  const entry = await feed.loadMarketHistory(symbol, "1m");
  const pending = feed.loadOlderHistory(symbol, "1m");
  await tick();
  await feed.loadMarketHistory(symbol, "1m", { start: 600, end: 720 });
  old.resolve(page([60]));
  await pending;
  assert.deepEqual(
    entry.bars.map((b) => b.time),
    [600, 660],
  );
  assert.equal(entry.loadingOlder, false);
  const snapshot = await feed.prepareMarketSnapshot(symbol, "1m");
  assert.equal(snapshot.snapshot_id, "immutable-range");
  assert.deepEqual(calls.filter((c) => c.method === "market.history").at(-1).params, {
    provider: "coinbase",
    symbol: "TEST-USD",
    timeframe: "1m",
    adjustment: "none",
    start: 600,
    end: 720,
    allowGaps: false,
  });
});
test("market status separates closed sessions, delayed references and quiet live instruments", () => {
  const data = {
    bars: [bar(1)],
    loadedAt: 1,
    loading: false,
    historyState: "ready",
    identity,
    quoteReceivedAt: 1,
    eventTime: 1,
    status: "connected",
  };
  assert.equal(marketStatus({ ...data, marketState: { open: false } }, 100000).label, "Closed");
  assert.equal(marketStatus(data, 100000).label, "As of last quote");
  assert.equal(
    marketStatus({ ...data, quoteReceivedAt: 99999, eventTime: 99999 }, 100000).label,
    "Live",
  );
  assert.equal(
    marketStatus({ ...data, identity: { ...identity, delay: { kind: "delayed" } } }, 100000).label,
    "Delayed",
  );
  assert.deepEqual(feed.marketRequest("ALPACA:iex:extended:SPY", "1H"), {
    provider: "alpaca",
    symbol: "SPY",
    timeframe: "1H",
    feed: "iex",
    session: "extended",
    adjustment: "raw",
  });
});

test("changing an account connection invalidates an in-flight page from the old profile", async (t) => {
  const pending = deferred();
  fixture(t, () => pending.promise);
  const symbol = "ALPACA:iex:PROFILE-TEST";
  const entry = feed.marketSeries(symbol, "1m");
  entry.identity = { ...identity, provider: "alpaca" };
  const request = feed.loadMarketHistory(symbol, "1m");
  await tick();
  feed.invalidateProviderConnection("alpaca");
  pending.resolve(page([60]));
  await request;
  assert.equal(entry.bars.length, 0);
  assert.match(entry.error, /Account connection changed/);
  assert.equal(entry.subscriptionId, undefined);
});

test("night feeds preserve the overnight session instead of inheriting regular hours", () => {
  for (const feedName of ["boats", "overnight"])
    assert.equal(feed.marketRequest(`ALPACA:${feedName}:SPY`, "1m").session, "overnight");
});

test("an interrupted proxy response gives a recoverable service error instead of a JSON parser failure", async t => {
  const original = global.fetch; t.after(() => { global.fetch = original; });
  global.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } });
  const { command } = require("../src/service/client.ts");
  await assert.rejects(command("system.capabilities"), /service is unavailable \(HTTP 502\).*retry/);
});
