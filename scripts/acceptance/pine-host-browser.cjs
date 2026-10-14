// Browser acceptance for the persistent event host, using actual public market events.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TRADING_URL || 'http://127.0.0.1:18879';
const token = fs.readFileSync(process.env.TRADING_TOKEN_FILE || 'var/ui-real-data-review/auth-token', 'utf8').trim();
async function api(method, params = {}) {
  const response = await fetch(base + '/api/command', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(120000) });
  const data = await response.json();
  if (!response.ok) throw Error(method + ': ' + JSON.stringify(data));
  return data;
}
(async () => {
  const end = Math.floor(Date.now() / 60000) * 60 - 120;
  const history = await api('market.history', { provider: 'coinbase', symbol: 'BTC-USD', timeframe: '1m', start: end - 40 * 60, end, allowGaps: false });
  assert.equal(history.gaps.length, 0);
  const name = 'Live indicator browser ' + Date.now();
  const source = `//@version=6\nindicator("${name}",overlay=true)\nvarip int ticks=0\nif barstate.isnew\n    ticks := 0\nticks += 1\nplot(close,"Live close")\nplot(ticks,"Tick count",display=display.data_window)`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage(), errors = [], calls = [], checks = [];
  let session;
  page.on('pageerror', error => errors.push(String(error)));
  page.on('response', async response => { try { if (response.url().endsWith('/api/command')) calls.push({ method: response.request().postDataJSON()?.method, status: response.status(), body: await response.json() }); } catch {} });
  try {
    await page.goto(base);
    await page.getByPlaceholder('Instance token (var/auth-token)').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.waitForFunction(() => window.openComposer?.state().charts.length);
    await page.evaluate(() => window.openComposer.execute('app.navigate', { view: 'operations' }));
    await page.getByLabel('Strategy name', { exact: true }).fill(name);
    const editor = page.getByLabel('Strategy code editor').locator('.cm-content');
    await editor.click(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(source);
    await page.getByRole('button', { name: 'Save new version', exact: true }).click();
    await page.getByLabel('Data snapshot', { exact: true }).selectOption(history.snapshot_id);
    const panel = page.getByRole('region', { name: 'Live Pine sessions', exact: true });
    await panel.getByLabel('Live Pine execution', { exact: true }).selectOption('indicator');
    await panel.getByRole('button', { name: 'Start selected Pine version', exact: true }).click();
    for (let i = 0; i < 160; i++) {
      session = calls.find(call => call.method === 'pine.host.deploy' && call.status === 200)?.body.session_id;
      if (session) break;
      await page.waitForTimeout(250);
    }
    assert.ok(session, JSON.stringify(calls.filter(call => call.status >= 400)));
    checks.push('React creates an immutable Pine version and deploys it through the Rust service');
    let current;
    for (let i = 0; i < 300; i++) {
      current = await api('pine.host.status', { session_id: session });
      if (current.error) throw Error(current.error);
      if (current.status === 'active' && current.result?.plots?.['Tick count']?.value >= 2) break;
      await page.waitForTimeout(1000);
    }
    assert.equal(current.status, 'active');
    assert.ok(current.result.plots['Tick count'].value >= 2, 'Expected multiple actual events within one bar');
    const initialCursor = current.marketCursor;
    await panel.locator('canvas').first().waitFor({ timeout: 30000 });
    await panel.getByText('Session event history', { exact: true }).waitFor();
    for (let i = 0; i < 30; i++) {
      if ((await panel.innerText()).includes('coinbase ·')) break;
      await page.waitForTimeout(500);
    }
    assert.match(await panel.innerText(), /coinbase.*realtime/);
    const render = await api('pine.host.render', { session_id: session });
    assert.ok(render.bars.length > history.data.bars.length);
    assert.equal(render.render.plots.find(plot => plot.title === 'Live close').data.at(-1), render.bars.at(-1).close);
    assert.equal(render.render.plots.find(plot => plot.title === 'Tick count').display, 'data_window');
    checks.push('actual Coinbase events advance same-bar varip ticks and rendered close values', 'live chart exposes provider, delay policy, timestamp and durable event history');
    const card = panel.locator('article').filter({ hasText: session.slice(0, 8) });
    await card.getByRole('button', { name: 'Stop session', exact: true }).click();
    for (let i = 0; i < 40; i++) {
      current = await api('pine.host.status', { session_id: session });
      if (current.status === 'stopped') break;
      await page.waitForTimeout(250);
    }
    assert.equal(current.status, 'stopped');
    assert.deepEqual(errors, []);
    assert.deepEqual(calls.filter(call => call.status >= 400), []);
    checks.push('stopping in React terminates the Rust-managed session', 'no browser exceptions or failed API requests');
    const report = { at: new Date().toISOString(), passed: true, synthetic: false, mode: 'indicator', externalOrders: false, session, snapshot: history.snapshot_id, initialCursor, status: current.status, bars: render.bars.length, checks, errors };
    fs.writeFileSync('docs/acceptance/pine-host-browser.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } catch (error) {
    fs.mkdirSync('var/ui-real-data-review/browser', { recursive: true });
    await page.screenshot({ path: 'var/ui-real-data-review/browser/pine-host-failure.png', fullPage: true });
    fs.writeFileSync('var/ui-real-data-review/browser/pine-host-failure.json', JSON.stringify({ error: String(error), text: await page.locator('body').innerText(), calls }, null, 2));
    throw error;
  } finally {
    if (session) await api('pine.host.stop', { session_id: session });
    await browser.close();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
