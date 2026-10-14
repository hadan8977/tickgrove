// Observe the existing test subscription; never alter source timestamps or submit orders.
const fs = require('node:fs'), assert = require('node:assert/strict');
const base = process.env.TRADING_URL || 'http://127.0.0.1:18879';
const token = fs.readFileSync(process.env.TRADING_TOKEN_FILE || 'var/ui-real-data-review/auth-token', 'utf8').trim();
async function api(method, params = {}) {
  const r = await fetch(base + '/api/command', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(10000) });
  const value = await r.json(); if (!r.ok) throw Error(method + ': ' + JSON.stringify(value)); return value;
}
(async () => {
  const source = (await api('market.list')).find(s => s.desired && s.identity.provider === 'coinbase' && s.identity.symbol === 'BTC-USD' && s.identity.timeframe === '1m');
  assert.ok(source, 'An existing test Coinbase BTC-USD 1m subscription is required');
  const samples = [], startedAt = new Date().toISOString();
  for (let i = 0; i < 20; i++) {
    const before = performance.now(), [s] = await api('market.status', { subscription_id: source.id });
    const requestMs = performance.now() - before;
    samples.push({ at: Date.now(), requestMs, status: s.status, quoteTime: s.lastQuoteEventTime, persistedAt: s.lastQuoteReceivedAt, processingLagMs: s.lastQuoteReceivedAt == null ? null : s.lastQuoteReceivedAt - s.lastQuoteEventTime, quoteAgeMs: s.lastQuoteEventTime == null ? null : Date.now() - s.lastQuoteEventTime, stale: s.quoteStale });
    if (i < 19) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const freshSamples = samples.filter(s => s.status === 'connected' && s.quoteAgeMs != null && s.quoteAgeMs >= -1000 && s.quoteAgeMs <= 15000).length;
  const updates = new Set(samples.map(s => s.quoteTime)).size;
  const report = { startedAt, completedAt: new Date().toISOString(), synthetic: false, provider: source.identity.provider, symbol: source.identity.symbol, subscription: source.id, samples, summary: { medianStatusRequestMs: median(samples.map(s => s.requestMs)), medianQuoteAgeMs: median(samples.map(s => s.quoteAgeMs ?? Infinity)), maxQuoteAgeMs: Math.max(...samples.map(s => s.quoteAgeMs ?? Infinity)), freshSamples, distinctQuoteTimestamps: updates }, passed: freshSamples >= 18 && updates >= 3, limitation: 'Short observed public-network window after the status-query fix; not an uptime, latency SLA or many-symbol load guarantee. persistedAt is service processing time, not raw socket-read time.' };
  fs.writeFileSync('docs/acceptance/market-latency-current.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ startedAt, completedAt: report.completedAt, passed: report.passed, ...report.summary }));
  assert.equal(report.passed, true, 'Actual quote freshness or update frequency did not meet this short-window check');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
