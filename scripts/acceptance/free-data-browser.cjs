// Actual app/components with deterministic provider fixtures. Start review-dev-server.mjs first.
const { chromium } = require('/tmp/trading-browser-tools/node_modules/playwright');
const fs = require('node:fs'), assert = require('node:assert/strict');
const BASE = process.env.TICKGROVE_REVIEW_URL || 'http://127.0.0.1:18894';
const report = { at: new Date().toISOString(), base: BASE, fixtureData: true, serverRequestsForwarded: 0, publicPreviewWrites: false, checks: [], layouts: [], apiCounts: {}, errors: [] };
const now = 1792022400;
const steps = { '1m': 60, '5m': 300, '15m': 900, '1H': 3600, '4H': 14400, '1D': 86400, '1W': 604800 };
const subscriptions = new Map();
let delayedHour, holdHour = true, failRefresh = false, failOlder = false, holdRefresh, configured = false;
const identity = p => ({ symbolId: `${p.provider}:${p.symbol}`, symbol: p.symbol, provider: p.provider || 'coinbase', feed: p.feed || (p.provider === 'yahoo' ? 'public-reference' : 'public-websocket'), venue: p.provider === 'yahoo' ? 'NASDAQ' : 'COINBASE', currency: 'USD', assetClass: p.provider === 'yahoo' ? 'stock' : 'crypto', timeframe: p.timeframe, timezone: p.provider === 'yahoo' ? 'America/New_York' : 'UTC', session: p.provider === 'yahoo' ? 'regular' : '24x7', adjustment: 'raw', pricePrecision: p.symbol === 'TINY-USD' ? 8 : 2, tickSize: p.symbol === 'TINY-USD' ? 1e-8 : 0.01, delay: { kind: p.provider === 'yahoo' ? 'delayed' : 'realtime', seconds: p.provider === 'yahoo' ? 900 : 0, disclaimer: 'Long provider policy. '.repeat(30) } });
function bars(p, count = 400, before) { const step = steps[p.timeframe] || 60, end = before ?? now; return Array.from({ length: count }, (_, i) => ({ time: end - (count - i) * step, closeTime: end - (count - i - 1) * step, open: (100 + i / 20) * (p.symbol === 'TINY-USD' ? 1e-6 : 1), high: (103 + i / 20) * (p.symbol === 'TINY-USD' ? 1e-6 : 1), low: (98 + i / 20) * (p.symbol === 'TINY-USD' ? 1e-6 : 1), close: (101 + i / 20) * (p.symbol === 'TINY-USD' ? 1e-6 : 1), volume: 1000 + i })); }
function history(p) {
  const empty = p.symbol === 'EMPTY-USD' && !p.before;
  const values = empty ? [] : bars(p, p.before ? 120 : 400, p.before);
  const more = empty || (p.symbol === 'SOL-USD' && p.timeframe === '1H' && !p.before);
  const start = values[0]?.time ?? now - (steps[p.timeframe] || 60) * 400;
  return { snapshot_id: `fixture-${p.symbol}-${p.timeframe}`, hash: 'fixture', bars: values.length, data: { symbol: p.symbol, timeframe: p.timeframe, metadata: { identity: identity(p) }, bars: values }, identity: identity(p), gaps: [], provenance: { rawMetadata: { previousClose: 99 } }, page: { hasMore: more, nextBefore: more ? start : null, limit: 1000, requestedStart: start, requestedEnd: p.before ?? now, reason: empty ? 'No recent trades; earlier history is available.' : 'Provider history boundary' }, cache: { hit: false } };
}
async function respond(method, p) {
  report.apiCounts[method] = (report.apiCounts[method] || 0) + 1;
  if (method === 'market.historyPage' || method === 'market.history') {
    if (p.symbol === 'SOL-USD' && p.timeframe === '1H' && !p.before && holdHour) { holdHour = false; await new Promise(resolve => delayedHour = resolve); }
    else if (p.symbol === 'SOL-USD' && p.timeframe === '1H' && !p.before && failRefresh) { failRefresh = false; return { status: 503, body: { error: 'Fixture provider temporarily unavailable' } }; }
    else if (p.symbol === 'SOL-USD' && p.timeframe === '1H' && !p.before && holdRefresh) await holdRefresh;
    if (p.before && failOlder) { failOlder = false; return { status: 503, body: { error: 'Fixture earlier page unavailable' } }; }
    return { body: history(p) };
  }
  if (method === 'market.quote') return { body: { price: p.symbol === 'TINY-USD' ? 0.00012 : 120, previousClose: p.symbol === 'TINY-USD' ? 0.000099 : 99 } };
  if (method === 'market.subscribe') { const id = `${p.provider}|${p.symbol}|${p.timeframe}`; subscriptions.set(id, identity(p)); return { body: { subscription_id: id, identity: identity(p), status: 'connected' } }; }
  if (method === 'market.bars') return { body: { bars: [], forming: null, identity: subscriptions.get(p.subscription_id), quality: [], cursor: 0, status: 'connected', error: null, lastQuote: null, marketState: { state: 'regular', open: true } } };
  if (method === 'market.events') return { body: { events: [], nextCursor: 0 } };
  if (method === 'market.depth') return { body: { book: { asks: [['121', '1']], bids: [['120', '1']] }, receivedAt: Date.now(), kind: 'snapshot' } };
  if (method === 'market.capabilities') return { body: { providers: [{ id: 'yahoo', history: true, credentials: false }, { id: 'coinbase', history: true, credentials: false }, { id: 'alpaca', history: true, configured }] } };
  if (method === 'market.list') return { body: [] };
  if (method === 'market.cacheInfo') return { body: { entries: 4, bytes: 4096, maxBytes: 10000000 } };
  if (method === 'connections.list') return { body: { providers: [{ id: 'yahoo', name: 'Yahoo stocks', requiresKey: false, configured: true, description: 'Public stock history and reference quotes.' }, { id: 'coinbase', name: 'Coinbase', requiresKey: false, configured: true, description: 'Exchange crypto history and live quotes.' }, { id: 'alpaca', name: 'Alpaca', requiresKey: true, configured, credentialsSource: configured ? 'server-private-file' : undefined, description: 'Optional account and feed access.' }] } };
  if (method === 'connections.test') return { body: { sampleAvailable: p.provider !== 'alpaca', latencyMs: 12 } };
  if (method === 'connections.save') { assert.equal(p.apiKey, 'fixture-key'); assert.equal(p.apiSecret, 'fixture-secret'); configured = true; return { body: { ok: true } }; }
  if (method === 'connections.remove') { configured = false; return { body: { ok: true } }; }
  throw Error('Unexpected fixture API: ' + method);
}
(async () => {
 const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell', headless: true, args: ['--no-sandbox'] });
 const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
 const page = await context.newPage();
 page.on('pageerror', e => { if (report.errors.length < 10) report.errors.push(e.message); });
 await page.route('**/api/**', async route => { try { const { method, params } = route.request().postDataJSON(); const r = await respond(method, params); await route.fulfill({ status: r.status || 200, contentType: 'application/json', body: JSON.stringify(r.body) }); } catch (e) { report.errors.push(String(e)); await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: String(e) }) }); } });
 const bootstrap = `import App from '/src/App.tsx';import * as feed from '/src/data/feed.ts';import {useApp,useCharts,useWorkspaces,useScripts} from '/src/store/index.ts';import {useConnection} from '/src/service/workspaceSync.ts';sessionStorage.setItem('tickgrove.splash','1');useApp.setState({view:'workspace',theme:'moss'});useCharts.setState({charts:{},drawings:{},watchlists:[{id:'review',name:'Review',symbols:[]}],activeWatchlist:'review'});useWorkspaces.setState({workspaces:[{id:'review',name:'Data review',layout:null,preset:'charts1',updatedAt:1}],activeId:'review'});useConnection.setState({connected:true,permissions:['connections.manage','market.read'],commands:[]});feed.configureData('service',true);window.review={feed,useApp,useCharts,useScripts,useConnection,series:()=>{const c=useCharts.getState().charts[useApp.getState().activeChartId];const s=feed.marketSeries(c.symbol,c.tf);return {symbol:c.symbol,tf:c.tf,count:s.bars.length,times:s.bars.map(b=>b.time),hasMore:s.hasMore,state:s.historyState,error:s.error,olderError:s.olderError,loading:s.loading}},refresh:()=>{const c=useCharts.getState().charts[useApp.getState().activeChartId];return feed.loadMarketHistory(c.symbol,c.tf,undefined,{force:true}).catch(()=>{})}};createRoot(document.getElementById('root')).render(React.createElement(App));`;
 await page.route('**/__free_data_review__.html', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root" style="height:100dvh"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module">import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';const {createRoot}=ReactDOM;import '/src/index.css';${bootstrap}</script></body></html>` }));
 try {
  await page.goto(BASE + '/__free_data_review__.html', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.tickgrove && document.querySelector('.chart-panel'), null, { timeout: 45000 });
  await page.evaluate(async () => { await tickgrove.execute('chart.setSymbol', { symbol: 'COINBASE:SOL-USD' }); await tickgrove.execute('chart.setTimeframe', { tf: '1m' }); });
  await page.waitForFunction(() => review.series().count === 400 && review.series().tf === '1m');
  await page.evaluate(() => { const id = review.useApp.getState().activeChartId; review.useScripts.getState().upsert({ id: 'review-sma', name: 'Review SMA', kind: 'indicator', source: '//@version=6\nindicator("Review SMA", overlay=true)\nplot(ta.sma(close,5))', origin: 'user', updatedAt: 1 }); review.useCharts.getState().addIndicator(id, { kind: 'pine', type: 'review-sma', name: 'Review SMA', inputs: {} }); window.historyObservations = []; window.historyObserver = new MutationObserver(() => { const c = document.querySelector('.chart-panel'); if (c) window.historyObservations.push({ state: c.querySelector('[data-history-state]')?.dataset.historyState, bad: /No data supplied|No bars in this range|\bEmpty\b/.test(c.innerText) }); }); window.historyObserver.observe(document.querySelector('.chart-panel'), { childList: true, subtree: true, attributes: true, characterData: true }); });
  await page.locator('.chart-panel').getByText('120.85', { exact: true }).waitFor({ timeout: 20000 });
  await page.evaluate(() => tickgrove.execute('chart.setTimeframe', { tf: '1H' }));
  await page.waitForFunction(() => review.series().tf === '1H' && review.series().loading);
  await page.getByText('Loading SOL-USD · 1H…', { exact: true }).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.chart-panel').getByRole('button', { name: 'Retry history', exact: true }).count(), 0);
  delayedHour(); await page.waitForFunction(() => review.series().tf === '1H' && review.series().count === 400 && !review.series().loading);
  await page.locator('.chart-panel').getByText('120.85', { exact: true }).waitFor({ timeout: 20000 });
  const transition = await page.evaluate(() => { window.historyObserver.disconnect(); return window.historyObservations; });
  assert(transition.some(x => x.state === 'loading')); assert(!transition.some(x => x.bad));
  report.transitionSamples = transition.length;
  report.checks.push('Actual ChartCanvas calculates Pine SMA=120.85 before and after delayed 1m→1H; transition shows Loading, never Empty/No bars/No data supplied.');

  const cached = await page.evaluate(() => review.series().times);
  failRefresh = true; await page.evaluate(() => review.refresh());
  await page.getByRole('button', { name: 'Showing cached history · Retry', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => review.series().times), cached);
  await page.evaluate(() => tickgrove.execute('panel.open', { panel: 'ticket' }));
  await page.getByText('This chart is showing cached data or its source is reconnecting. Simulated fills require a fresh, valid quote from this source.', { exact: true }).waitFor();
  await page.evaluate(async () => { const dock = await import('/src/features/workspace/dock.ts'); dock.focusChartPanel(review.useApp.getState().activeChartId); });
  report.checks.push('Actual OrderTicket explains cached/reconnecting data and the fresh server quote requirement without changing execution policy.');
  let releaseRefresh; holdRefresh = new Promise(resolve => releaseRefresh = resolve);
  await page.getByRole('button', { name: 'Showing cached history · Retry', exact: true }).click();
  await page.getByText('Refreshing history…', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => review.series().times), cached);
  holdRefresh = undefined; releaseRefresh(); await page.waitForFunction(() => !review.series().loading && !review.series().error);
  failOlder = true; await page.getByRole('button', { name: '← Load earlier history', exact: true }).click();
  await page.getByRole('button', { name: 'Earlier history unavailable · Retry', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => review.series().times), cached);
  await page.getByRole('button', { name: 'Earlier history unavailable · Retry', exact: true }).click();
  await page.waitForFunction(() => review.series().count === 520 && !review.series().olderError);
  report.checks.push('Initial refresh and older-page failures preserve all cached candles; visible Retry recovers and prepends 120 bars without duplication.');

  await page.evaluate(async () => { await tickgrove.execute('chart.setSymbol', { symbol: 'COINBASE:EMPTY-USD' }); await tickgrove.execute('chart.setTimeframe', { tf: '1m' }); });
  await page.waitForFunction(() => review.series().state === 'empty' && review.series().hasMore);
  await page.getByText('No bars in this range', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Load earlier history', exact: true }).click();
  await page.waitForFunction(() => review.series().count === 120);
  assert.equal(await page.getByText('No bars in this range', { exact: true }).count(), 0);
  report.checks.push('Empty initial page with hasMore offers Load earlier history and recovers to a populated chart.');

  await page.locator('aside[aria-label="Main navigation"]').getByRole('button', { name: 'Data', exact: true }).click();
  await page.getByRole('heading', { name: 'Data sources & history', exact: true }).waitFor();
  const coinbase = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Coinbase', exact: true }) });
  await coinbase.getByRole('button', { name: 'Use source', exact: true }).click();
  assert.equal(await page.getByLabel('Provider symbol', { exact: true }).inputValue(), 'BTC-USD');
  await coinbase.getByRole('button', { name: 'Test', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'coinbase: connection accepted, sample data received' }).waitFor();
  const alpaca = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Alpaca', exact: true }) });
  await alpaca.getByRole('button', { name: 'Connect account', exact: true }).click();
  await page.getByRole('button', { name: 'Save connection', exact: true }).isDisabled().then(v => assert(v));
  await page.getByLabel('Alpaca API key', { exact: true }).fill('fixture-key');
  await page.getByLabel('Alpaca API secret', { exact: true }).fill('fixture-secret');
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await alpaca.getByText('Configured', { exact: true }).waitFor();
  assert(!await page.locator('body').innerText().then(t => /fixture-key|fixture-secret/.test(t)));
  await page.getByRole('button', { name: 'Open chart', exact: true }).click();
  await page.waitForFunction(() => review.useApp.getState().view === 'workspace' && review.series().symbol === 'COINBASE:BTC-USD');
  report.checks.push('Actual MarketPanel/DataConnections: source card selects symbol, test gives sample status, key form requires values, fixture save updates Configured, Open chart targets the chosen source. No credentials sent to a server.');

  await page.evaluate(async () => { await tickgrove.execute('chart.setSymbol', { symbol: 'COINBASE:TINY-USD' }); await tickgrove.execute('chart.setTimeframe', { tf: '1m' }); });
  await page.waitForFunction(() => review.series().symbol === 'COINBASE:TINY-USD' && review.series().count === 400);
  await page.locator('.chart-panel').getByText('0.00012085', { exact: true }).waitFor({ timeout: 20000 });
  const ohlcText = await page.locator('.chart-panel [aria-label^="O "]').getAttribute('aria-label');
  assert.equal(ohlcText, 'O 0.00011995 · H 0.00012295 · L 0.00011795 · C 0.00012095');
  report.lowPrice = { ohlc: ohlcText, pineSma: '0.00012085', pricePrecision: 8 };
  report.checks.push('Actual tiny-price chart: all OHLC fields retain instrument precision 8, and Pine SMA retains 0.00012085 instead of 0.00.');
  for (const preset of ['charts4', 'charts6']) {
    await page.evaluate(preset => tickgrove.execute('workspace.applyLayout', { preset }), preset);
    await page.waitForFunction(n => document.querySelectorAll('.chart-panel').length === n && [...document.querySelectorAll('.chart-panel [data-history-state]')].every(e => e.dataset.historyState === 'ready'), Number(preset.slice(-1)));
    await page.waitForTimeout(400);
    const panels = await page.locator('.chart-panel').evaluateAll(nodes => nodes.map(node => { const panel = node.getBoundingClientRect(), toolbar = node.querySelector('.chart-toolbar'), plot = node.querySelector('[data-history-state]')?.getBoundingClientRect(), box = toolbar.getBoundingClientRect(), canvas = [...node.querySelectorAll('.tv-lightweight-charts canvas')].map(c => c.getBoundingClientRect()).sort((a,b) => b.width*b.height-a.width*a.height)[0]; return { width: panel.width, height: panel.height, toolbarHeight: box.height, toolbarOverflow: toolbar.scrollWidth - toolbar.clientWidth, chartAreaWidth: plot?.width, chartAreaHeight: plot?.height, plotWidth: canvas?.width, plotHeight: canvas?.height, plotRatio: canvas?.height / panel.height, longMetadataVisible: node.innerText.includes('Long provider policy.'), closeVisible: [...node.querySelectorAll('[aria-label^="O "] span')].some(s=>s.textContent==='0.00012095'&&s.getBoundingClientRect().width>0) }; }));
    report.layouts.push({ preset, viewport: { width: 1366, height: 768 }, panels });
    assert(panels.every(p => p.toolbarHeight <= 33 && p.toolbarOverflow <= 1 && p.plotHeight >= 200 && p.plotRatio >= 0.70 && !p.longMetadataVisible && p.closeVisible));
    const badge = page.locator('.chart-panel').first().getByRole('button', { name: /^Data status for/ });
    await badge.click(); const details = page.getByRole('region', { name: 'Market data details' }); await details.waitFor();
    const db = await details.locator("xpath=..").boundingBox(); assert(db.x >= 0 && db.y >= 0 && db.x + db.width <= 1366 && db.y + db.height <= 768);
    await details.getByRole('button', { name: 'Data settings', exact: true }).scrollIntoViewIfNeeded(); await details.getByRole('button', { name: 'Data settings', exact: true }).click({trial:true}); await page.keyboard.press('Escape');
    fs.mkdirSync('var/free-data-browser', { recursive: true }); await page.screenshot({ path: `var/free-data-browser/${preset}.png` });
  }
  report.checks.push('4/6 actual chart layouts retain a single-row toolbar and at least 70% chart height; source metadata stays in an on-screen popover with actionable Data settings.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('aside[aria-label="Main navigation"]').getByRole('button', { name: 'Data', exact: true }).click();
  await page.getByRole('heading', { name: 'Data sources & history', exact: true }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert(overflow <= 1); report.mobileOverflow = overflow;
  await page.screenshot({ path: 'var/free-data-browser/mobile-data.png' });
  report.checks.push('390px data connections and history form stay within the viewport.');
  assert.deepEqual(report.errors, []); report.ok = true;
 } catch (error) { report.ok = false; report.failure = String(error); fs.mkdirSync('var/free-data-browser', { recursive: true }); await page.screenshot({ path: 'var/free-data-browser/failure.png' }).catch(() => {}); throw error; }
 finally { if (delayedHour) delayedHour(); await context.close(); await browser.close(); fs.writeFileSync('docs/acceptance/free-data-browser.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
