// Authorized isolated production UI + real public sources. Never use the shared preview database.
const { chromium } = require('/tmp/trading-browser-tools/node_modules/playwright');
const fs = require('node:fs'), assert = require('node:assert/strict');
const BASE = process.env.TICKGROVE_REAL_REVIEW_URL || 'http://127.0.0.1:18896';
const tokenPath = process.env.TICKGROVE_REAL_REVIEW_TOKEN || '/root/finance/tradingdashboard/var/free-data-review/auth-token';
const report = { at: new Date().toISOString(), base: BASE, isolatedDataDirectory: 'var/free-data-review', publicPreviewWrites: false, realSources: true, histories: [], liveEvents: [], themes: [], checks: [], errors: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
 const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell', headless: true, args: ['--no-sandbox'] });
 const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
 await context.addInitScript(token => { sessionStorage.setItem('tickgrove.token', token); sessionStorage.setItem('tickgrove.splash', '1'); }, fs.readFileSync(tokenPath, 'utf8').trim());
 const page = await context.newPage();
 page.on('pageerror', e => report.errors.push(e.message));
 page.on('response', async response => {
  if (!response.url().endsWith('/api/command')) return;
  try {
   const { method, params } = response.request().postDataJSON();
   if (!['market.historyPage', 'market.history', 'market.events'].includes(method) || response.status() !== 200) return;
   const data = await response.json();
   if (method !== 'market.events') report.histories.push({ provider: params.provider, symbol: params.symbol, timeframe: params.timeframe, before: params.before ?? null, bars: data.data?.bars?.length, first: data.data?.bars?.[0]?.time, last: data.data?.bars?.at(-1)?.time, hasMore: data.page?.hasMore, cacheHit: data.cache?.hit, delay: data.identity?.delay.kind });
   else for (const event of data.events || []) if (event.identity?.symbol === 'LTC-USD' && ['quote', 'trade', 'bar.update'].includes(event.type)) report.liveEvents.push({ type: event.type, timeframe: event.identity.timeframe, eventTime: event.eventTime, receivedAt: event.receivedAt, price: event.payload?.price ?? event.payload?.bar?.close });
  } catch {}
 });
 const active = async () => page.evaluate(() => { const s = tickgrove.state(); return s.charts.find(c => c.id === s.activeChartId); });
 const chart = () => page.locator('.chart-panel').first();
 const ready = async () => { await page.waitForFunction(() => document.querySelector('.chart-panel [data-history-state]')?.dataset.historyState === 'ready', null, { timeout: 90000 }); };
 const search = async (provider, symbol) => {
  await page.locator('button[title="Search symbols (/)"]').click();
  await page.getByLabel('Search provider', { exact: true }).selectOption(provider);
  const input = page.getByRole('combobox', { name: 'Search instruments', exact: true });
  await input.fill(symbol);
  const choices = page.getByRole('listbox').getByRole('option');
  await choices.first().locator(`span[title="${provider.toUpperCase()}:${symbol}"]`).waitFor({ timeout: 45000 });
  await input.press('Enter');
  await ready();
 };
 const details = async () => {
  await chart().getByRole('button', { name: /^Data status for/ }).click();
  const panel = page.getByRole('region', { name: 'Market data details' }); await panel.waitFor();
  const values = await panel.locator('dl').evaluate(el => Object.fromEntries([...el.querySelectorAll('dt')].map(dt => [dt.textContent, dt.nextElementSibling?.textContent])));
  await page.keyboard.press('Escape'); return values;
 };
 try {
  await page.goto(BASE, { waitUntil: 'commit', timeout: 20000 });
  await page.waitForFunction(() => window.tickgrove && document.querySelector('.chart-panel'), null, { timeout: 90000 });
  assert.equal(await page.evaluate(() => tickgrove.state().mode), 'SERVICE');
  report.frontendAssets = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.getAttribute('src')));
  await page.evaluate(() => tickgrove.execute('workspace.applyLayout', { preset: 'charts1' }));
  await page.evaluate(() => tickgrove.execute('chart.setTimeframe', { chartId: tickgrove.state().activeChartId, tf: '1D' }));
  for (const symbol of ['VOO', 'IWM']) {
   await search('yahoo', symbol); const state = await active(); assert.equal(state.symbol, 'YAHOO:' + symbol); assert(Number.isFinite(state.last) && state.last > 0);
   const info = await details(); report.checks.push({ task: 'Generic stock/ETF search and real history', symbol: state.symbol, last: state.last, history: info.History, policy: info['Data policy'], session: info.Session });
  }
  await search('coinbase', 'LTC-USD');
  await chart().getByRole('button', { name: '1m', exact: true }).first().click(); await ready();
  const minuteDetails = await details();
  await page.evaluate(() => { window.transitionSamples = []; const sample = () => { const node = document.querySelector('.chart-panel'); window.transitionSamples.push({ state: node.querySelector('[data-history-state]')?.dataset.historyState, bad: /No data supplied|No bars in this range|\bEmpty\b/.test(node.innerText) }); }; window.transitionObserver = new MutationObserver(sample); transitionObserver.observe(document.querySelector('.chart-panel'), { childList: true, subtree: true, characterData: true, attributes: true }); sample(); });
  await chart().getByRole('button', { name: '1H', exact: true }).first().click(); await ready();
  assert.equal((await active()).tf, '1H');
  await chart().getByRole('button', { name: '1m', exact: true }).first().click(); await ready();
  assert.equal((await active()).tf, '1m');
  const observations = await page.evaluate(() => { transitionObserver.disconnect(); return transitionSamples; });
  assert(!observations.some(s => s.bad));
  report.checks.push({ task: 'Real LTC-USD 1m→1H→1m transition', samples: observations.length, loadingObserved: observations.some(s => s.state === 'loading'), noFalseEmpty: true });
  const before = Number(minuteDetails.History.match(/[\d,]+/)?.[0].replaceAll(',', ''));
  const older = chart().getByRole('button', { name: '← Load earlier history', exact: true });
  await older.click();
  await page.waitForFunction(() => !document.querySelector('.chart-panel')?.innerText.includes('Loading earlier history…'), null, { timeout: 90000 });
  const afterDetails = await details(), after = Number(afterDetails.History.match(/[\d,]+/)?.[0].replaceAll(',', ''));
  assert(after > before, `History count ${before}→${after}`);
  report.checks.push({ task: 'Real earlier history', symbol: 'COINBASE:LTC-USD', before, after, range: afterDetails.History });
  const activeLiveEvents = () => report.liveEvents.filter(e => e.timeframe === '1m' && (e.type === 'quote' || e.type === 'trade'));
  const until = Date.now() + 60000;
  while (Date.now() < until && new Set(activeLiveEvents().map(e => e.eventTime)).size < 2) await delay(1000);
  const times = new Set(activeLiveEvents().map(e => e.eventTime));
  await chart().getByRole('button', { name: /^Data status for/ }).click();
  await page.waitForFunction(() => { const panel = document.querySelector('[aria-label="Market data details"]'); return panel && !panel.textContent.includes('No live quote received') && !panel.textContent.includes('Not received'); }, null, { timeout: 15000 });
  await page.keyboard.press('Escape');
  const live = await details(); report.checks.push({ task: 'Real stream updates visible in UI', distinctQuoteOrTradeTimes: times.size, quoteTime: live['Quote time'], received: live.Received, connection: live.Connection, uiLast: (await active()).last });
  assert(times.size >= 2, 'No two distinct live quote/trade events observed within 60 seconds');
  assert.notEqual(live['Quote time'], 'Not received');

  fs.mkdirSync('var/real-free-data-browser', { recursive: true });
  for (let i = 0; i < 4; i++) {
   const theme = await page.evaluate(() => document.documentElement.dataset.theme);
   const logo = page.locator('header svg[aria-label="Tickgrove"]').first();
   const mark = await logo.evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, color: getComputedStyle(el).color, path: el.querySelector('path')?.getAttribute('d') }));
   assert(mark.path?.startsWith('M2 3H30'));
   const favicon = await page.evaluate(async () => { const url = document.querySelector('link[rel="icon"]').href; const response = await fetch(url); const text = await response.text(); return { status: response.status, newMark: text.includes('M2 3H30') }; });
   assert.equal(favicon.status, 200); assert.equal(favicon.newMark, true);
   await page.evaluate(() => { document.getElementById('review-favicon-size')?.remove(); const img = document.createElement('img'); img.id = 'review-favicon-size'; img.src = document.querySelector('link[rel="icon"]').href; img.width = img.height = 16; Object.assign(img.style, { position: 'fixed', bottom: '35px', right: '14px', zIndex: '999' }); document.body.append(img); });
   await page.locator('#review-favicon-size').screenshot({ path: `var/real-free-data-browser/favicon-${theme}-16.png` });
   await page.screenshot({ path: `var/real-free-data-browser/${theme}.png` });
   report.themes.push({ name: theme, mark, favicon });
   await page.evaluate(() => tickgrove.execute('app.toggleTheme'));
  }
  assert.equal(new Set(report.themes.map(t => t.name)).size, 4);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  report.mobile = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, logo: [...document.querySelectorAll('header svg[aria-label="Tickgrove"]')].map(e => e.getBoundingClientRect().width).filter(Boolean), charts: [...document.querySelectorAll('.chart-panel')].filter(e => e.getBoundingClientRect().width > 0).length }));
  assert.equal(report.mobile.overflow, 0); assert(report.mobile.logo.includes(25));
  await page.screenshot({ path: 'var/real-free-data-browser/mobile.png' });
  assert.deepEqual(report.errors, []); report.ok = true;
 } catch(error) { report.ok = false; report.failure = String(error); fs.mkdirSync('var/real-free-data-browser', { recursive: true }); await page.screenshot({ path: 'var/real-free-data-browser/failure.png' }).catch(() => {}); throw error; }
 finally { await context.close(); await browser.close(); report.liveEvents = report.liveEvents.slice(0, 20); fs.writeFileSync('docs/acceptance/real-free-data-browser.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
