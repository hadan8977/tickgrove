// Capture actual public market data in the dedicated acceptance database, never the shared preview.
const { chromium } = require('/tmp/trading-browser-tools/node_modules/playwright');
const fs = require('node:fs'), assert = require('node:assert/strict');
const base = process.env.TICKGROVE_REAL_REVIEW_URL || 'http://127.0.0.1:18896';
const tokenPath = process.env.TICKGROVE_REAL_REVIEW_TOKEN || '/root/finance/tradingdashboard/var/free-data-review/auth-token';
const report = { at: new Date().toISOString(), base, realSources: true, publicPreviewWrites: false, screenshots: [], errors: [] };
(async () => {
  const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await context.addInitScript(token => { sessionStorage.setItem('tickgrove.token', token); sessionStorage.setItem('tickgrove.splash', '1'); }, fs.readFileSync(tokenPath, 'utf8').trim());
  await context.addInitScript(() => {
    window.reviewTextDraws = [];
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (this.canvas.closest('.tv-lightweight-charts')) {
        window.reviewTextDraws.push({ chartId: this.canvas.closest('.chart-panel')?.dataset.chartId, color: this.fillStyle });
        if (window.reviewTextDraws.length > 10000) window.reviewTextDraws.splice(0, 5000);
      }
      return fillText.apply(this, args);
    };
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  const specifications = [['YAHOO:VOO', '1D'], ['YAHOO:IWM', '1D'], ['COINBASE:LTC-USD', '1H'], ['COINBASE:BTC-USD', '4H'], ['YAHOO:SPY', '1D'], ['YAHOO:QQQ', '1D']];
  try {
    await page.goto(base, { waitUntil: 'commit', timeout: 20000 });
    await page.waitForFunction(() => window.tickgrove && document.querySelector('.chart-panel'), null, { timeout: 90000 });
    assert.equal(await page.evaluate(() => tickgrove.state().mode), 'SERVICE');
    report.frontendAssets = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.getAttribute('src')));
    for (const [count, theme] of [[4, 'moss'], [6, 'dark']]) {
      await page.evaluate(count => tickgrove.execute('workspace.applyLayout', { preset: 'charts' + count }), count);
      await page.waitForFunction(count => document.querySelectorAll('.chart-panel').length === count, count);
      const ids = await page.locator('.chart-panel').evaluateAll(nodes => nodes.map(node => node.dataset.chartId));
      for (const chartId of ids) await page.evaluate(chartId => tickgrove.execute('chart.setLinkGroup', { chartId, group: 'none' }), chartId);
      for (let i = 0; i < ids.length; i++) {
        await page.evaluate(async ({ chartId, symbol, tf }) => { await tickgrove.execute('chart.setSymbol', { chartId, symbol }); await tickgrove.execute('chart.setTimeframe', { chartId, tf }); }, { chartId: ids[i], symbol: specifications[i][0], tf: specifications[i][1] });
      }
      await page.waitForFunction(count => {
        const charts = [...document.querySelectorAll('.chart-panel [data-history-state]')];
        return charts.length === count && charts.every(chart => chart.dataset.historyState === 'ready');
      }, count, { timeout: 90000 });
      await page.evaluate(() => { window.reviewTextDraws = []; });
      for (let i = 0; i < 4 && await page.evaluate(() => document.documentElement.dataset.theme) !== theme; i++) await page.evaluate(() => tickgrove.execute('app.toggleTheme'));
      // Let the actual canvas receive its resize, history and next paint before capture.
      await page.waitForTimeout(1500);
      // Verify actual canvas axis text, not just DOM theme attributes or CSS tokens.
      await page.waitForFunction(ids => {
        const expected = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim().toLowerCase();
        return ids.every(id => window.reviewTextDraws.some(draw => draw.chartId === id && draw.color === expected));
      }, ids, { timeout: 10000 });
      const canvasTextColor = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--muted').trim());
      const geometry = await page.locator('.chart-panel').evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect();
        const area = node.querySelector('[data-history-state]')?.getBoundingClientRect();
        const plot = [...node.querySelectorAll('.tv-lightweight-charts canvas')].map(canvas => canvas.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0];
        return { id: node.dataset.chartId, width: rect.width, height: rect.height, chartAreaWidth: area?.width, chartAreaHeight: area?.height, plotWidth: plot?.width, plotHeight: plot?.height, status: node.querySelector('[data-history-state]')?.dataset.historyState, sourceLabel: node.querySelector('.market-status')?.textContent?.trim() };
      }));
      assert(geometry.every(chart => chart.plotHeight >= 200 && chart.status === 'ready'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
      const path = `var/real-free-data-browser/charts${count}-${theme}.png`;
      fs.mkdirSync('var/real-free-data-browser', { recursive: true });
      await page.screenshot({ path });
      report.screenshots.push({ path, theme, canvasTextColor, viewport: { width: 1366, height: 768 }, charts: specifications.slice(0, count), geometry });
    }
    assert.deepEqual(report.errors, []); report.ok = true;
  } catch (error) { report.ok = false; report.failure = String(error); throw error; }
  finally { await context.close(); await browser.close(); fs.writeFileSync('docs/acceptance/real-data-screenshots.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
