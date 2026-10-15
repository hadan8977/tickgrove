const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const BASE = (process.env.TICKGROVE_REVIEW_URL || 'http://127.0.0.1:18892/').replace(/\/$/, '') + '/?mode=demo';
const output = process.env.TICKGROVE_REVIEW_OUTPUT || '/tmp/tickgrove-layout-review-latest.json';
const timeout = setTimeout(() => { console.error('Review deadline exceeded'); process.exit(2); }, 55000);
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await context.addInitScript(() => sessionStorage.setItem('tickgrove.splash', '1'));
  const page = await context.newPage();
  const mutations = [];
  await page.route('**/api/**', async route => {
    const req = route.request(); mutations.push({url:req.url(),method:req.method()}); await route.abort();
  });
  const report = { at: new Date().toISOString(), referenceSha: 'ec039649fe9f4b8729b977e819509910bf95cc2a', mode: 'demo', base: BASE, freshContext: true, serverApiRequests: mutations };
  try {
    await page.goto(BASE, { waitUntil: 'commit', timeout: 12000 });
    await page.waitForFunction(() => window.tickgrove && document.querySelector('.chart-panel'), null, { timeout: 12000 });
    report.initial = await page.evaluate(() => window.tickgrove.state());
    const initialId = await page.locator('.chart-panel').first().getAttribute('data-chart-id');
    report.targetId = initialId;
    await page.evaluate(async id => {
      await window.tickgrove.execute('chart.setSymbol', {chartId:id,symbol:'COINBASE:SOL-USD'});
      await window.tickgrove.execute('chart.setTimeframe', {chartId:id,tf:'5m'});
    }, initialId);
    report.modified = await page.evaluate(() => window.tickgrove.state());
    await page.evaluate(() => window.tickgrove.execute('workspace.applyLayout',{preset:'charts6'}));
    await page.waitForFunction(() => document.querySelectorAll('.chart-panel').length === 6, null, {timeout:8000});
    report.afterSix = await page.evaluate(() => window.tickgrove.state());
    await page.evaluate(() => window.tickgrove.execute('workspace.applyLayout',{preset:'charts1'}));
    await page.waitForFunction(() => document.querySelectorAll('.chart-panel').length === 1, null, {timeout:8000});
    report.afterOne = await page.evaluate(() => window.tickgrove.state());
    report.reproducedStateLoss = !report.afterSix.charts.some(c => c.id === initialId || c.symbol === 'COINBASE:SOL-USD') && !report.afterOne.charts.some(c => c.id === initialId || c.symbol === 'COINBASE:SOL-USD') && report.afterOne.charts[0].symbol === 'NVDA' && report.afterOne.charts[0].tf === '1D';
    report.success = true;
  } catch(error) { report.success=false;report.error=String(error); }
  await browser.close();
  clearTimeout(timeout);
  fs.writeFileSync(output, JSON.stringify(report,null,2));
  console.log(JSON.stringify({success:report.success,reproducedStateLoss:report.reproducedStateLoss,serverApiRequests:report.serverApiRequests.length,targetId:report.targetId,afterOne:report.afterOne?.charts,error:report.error},null,2));
})();
