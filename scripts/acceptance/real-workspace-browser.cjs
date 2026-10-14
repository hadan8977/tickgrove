// Exercises the integrated workspace with public provider data, never generated prices.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.TRADING_URL||'http://127.0.0.1:18879';
const token=fs.readFileSync(process.env.TRADING_TOKEN_FILE||'var/ui-real-data-review/auth-token','utf8').trim();
const out=process.env.TRADING_BROWSER_OUTPUT||'var/ui-real-data-review/browser';
fs.mkdirSync(out,{recursive:true});
const errors=[],calls=[],checks=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const api=async(method,params={},key)=>{const response=await fetch(base+'/api/command',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({method,params,idempotency_key:key})});const body=await response.json();if(!response.ok)throw Error(method+': '+JSON.stringify(body));return body};
async function until(fn,timeout=60000){const start=Date.now();while(Date.now()-start<timeout){const value=await fn();if(value)return value;await sleep(250)}throw Error('Acceptance wait timed out')}
function check(name,detail){checks.push({name,ok:true,detail});console.log(JSON.stringify(checks.at(-1)))}
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:1600,height:1000}}),page=await context.newPage();let failure;
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('response',async response=>{if(response.url().endsWith('/api/command'))try{const req=response.request().postDataJSON();calls.push({method:req.method,params:req.params,status:response.status(),body:await response.json()})}catch{}});
 try{
  // Reduce initial watchlist traffic only; all tested symbols still come from provider discovery.
  await page.addInitScript(()=>{if(!localStorage.getItem('oc.workspaces')){localStorage.setItem('oc.workspaces',JSON.stringify({version:0,state:{activeId:'review',workspaces:[{id:'review',name:'Review',layout:null,preset:'trade',updatedAt:Date.now()}]}}));localStorage.setItem('oc.charts',JSON.stringify({version:0,state:{charts:{},drawings:{},watchlists:[{id:'public',name:'Public markets',symbols:['COINBASE:LTC-USD','YAHOO:VOO']}],activeWatchlist:'public'}}))}});
  await page.goto(base);
  await page.getByPlaceholder('Instance token (var/auth-token)').fill(token);
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  await page.waitForFunction(()=>window.openComposer?.state().charts.length>0);
  await page.evaluate(()=>window.openComposer.execute('workspace.applyLayout',{preset:'trade'}));
  await page.evaluate(async()=>{await window.openComposer.execute('chart.setSymbol',{symbol:'COINBASE:LTC-USD'});await window.openComposer.execute('chart.setTimeframe',{tf:'1m'})});
  const live=await until(async()=>{const list=await api('market.list');return list.find(s=>s.identity.provider==='coinbase'&&s.identity.symbol==='LTC-USD'&&s.identity.timeframe==='1m'&&s.lastQuoteEventTime&&Date.now()-s.lastQuoteEventTime<15000)},90000);
  await until(()=>calls.find(c=>c.method==='market.history'&&c.params.symbol==='LTC-USD'&&c.params.timeframe==='1m'&&c.status===200));
  assert.ok(await page.locator('canvas').count()>=2);
  check('Generic real history and live Coinbase workspace',{symbol:live.identity.symbol,provider:live.identity.provider,feed:live.identity.feed,subscription:live.id,quoteAgeMs:Date.now()-live.lastQuoteEventTime});
  const discovered=await api('market.search',{provider:'coinbase',query:'SOL-USD'});assert.ok(discovered.symbols.some(s=>s.symbol==='SOL-USD'));check('Provider discovery outside initial watchlist',{symbol:'SOL-USD'});
  await page.evaluate(async()=>{await window.openComposer.execute('chart.setSymbol',{symbol:'YAHOO:VOO'});await window.openComposer.execute('chart.setTimeframe',{tf:'1D'})});
  const stock=await until(()=>calls.find(c=>c.method==='market.history'&&c.params.symbol==='VOO'&&c.params.timeframe==='1D'&&c.status===200),90000);assert.equal(stock.body.identity.assetClass,'etf');assert.ok(stock.body.data.bars.length>200);
  const pine='//@version=6\nstrategy("Real history UI audit", overlay=true, initial_capital=10000)\nif bar_index == 2\n    strategy.entry("L", strategy.long, qty=2)\nif bar_index == 5\n    strategy.close("L")\nplot(ta.sma(close, 5))';
  const script=await page.evaluate(source=>window.openComposer.execute('pine.createScript',{name:'Real history UI audit',source}),pine);
  await page.evaluate(scriptId=>window.openComposer.execute('backtest.runScript',{scriptId}),script);
  const runCall=await until(()=>[...calls].reverse().find(c=>c.method==='backtest.results'&&c.body.status==='succeeded'));assert.equal(runCall.body.result.backtest.trades[0].qty,2);assert.ok(runCall.body.manifest.snapshot_hash);
  check('Original Pine interface runs a persistent native job on real ETF history',{symbol:'VOO',bars:stock.body.data.bars.length,job:runCall.body.job_id,tradeQty:2,snapshotHash:runCall.body.manifest.snapshot_hash});
  await page.locator('.dv-tab').filter({hasText:'YAHOO:VOO · 1D'}).first().click();
  await page.getByRole('button',{name:'Chart tools and objects',exact:true}).first().click();
  await page.getByRole('button',{name:'Start replay',exact:true}).click();
  await page.getByRole('slider',{name:'Replay visible bars'}).focus();await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');
  await page.getByRole('button',{name:'Return to live chart',exact:true}).click();
  await page.keyboard.press('Escape');
  check('Chart replay prefix and return to live controls work',{});
  await page.evaluate(async()=>{await window.openComposer.execute('chart.setSymbol',{symbol:'COINBASE:LTC-USD'});await window.openComposer.execute('chart.setTimeframe',{tf:'1m'})});
  const before=(await api('account.state')).fills.length;
  await page.evaluate(()=>window.openComposer.execute('paper.placeOrder',{symbol:'COINBASE:LTC-USD',side:'buy',qty:0.02,type:'market'}));
  const account=await until(async()=>{const a=await api('account.state');return a.fills.length>before?a:null});
  const fill=account.fills[0];assert.equal(fill.symbol,'LTC-USD');assert.equal(fill.qty,0.02);assert.ok(fill.marketCursor>0);assert.ok(Math.abs(fill.fee-fill.qty*fill.price*account.quotePolicy.commissionBps/10000)<1e-8);
  check('Workspace manual order uses real-quote server ledger',{fill:fill.id,qty:fill.qty,fee:fill.fee,event:fill.marketCursor});
  await page.evaluate(()=>window.openComposer.execute('app.navigate',{view:'alerts'}));
  const alertName='Live browser acceptance '+Date.now();await page.getByLabel('Alert name').fill(alertName);await page.getByLabel('Alert instrument').fill('COINBASE:LTC-USD');await page.getByLabel('Alert condition').selectOption('above');await page.getByLabel('Alert price').fill('0.001');
  await page.getByRole('button',{name:'Create alert',exact:true}).click();
  const alert=await until(async()=>{const a=await api('alerts.list');return a.find(x=>x.params?.name===alertName)});
  const notification=await until(async()=>{const h=await api('alerts.history');return h.find(e=>e.alertId===alert.id)},90000);
  assert.ok(notification.marketCursor>0);check('Server alert triggered by actual quote',{alert:alert.id,event:notification.marketCursor});
  await page.evaluate(()=>window.openComposer.execute('app.navigate',{view:'workspace'}));
  await page.evaluate(()=>window.openComposer.execute('workspace.save'));
  const saved=await until(async()=>{const d=await api('workspace.get',{id:'default'});return d.data&&Object.values(d.data.charts.charts).some(c=>c.symbol==='COINBASE:LTC-USD')?d:null});
  assert.ok(saved.revision>0);
  await page.screenshot({path:out+'/live-workspace.png',fullPage:true});
  const second=await browser.newContext({viewport:{width:1400,height:900}}),other=await second.newPage();other.on('pageerror',e=>errors.push(String(e)));
  await other.goto(base);await other.getByPlaceholder('Instance token (var/auth-token)').fill(token);await other.getByRole('button',{name:'Connect',exact:true}).click();
  await other.waitForFunction(()=>window.openComposer?.state().charts.some(c=>c.symbol==='COINBASE:LTC-USD'));
  const restored=await other.evaluate(()=>window.openComposer.state());assert.equal(restored.mode,'SERVICE');check('Clean browser restores server workspace',{revision:saved.revision,charts:restored.charts.length});await second.close();
  assert.deepEqual(errors,[]);assert.deepEqual(calls.filter(c=>c.status>=400),[]);check('No browser runtime or command errors',{count:errors.length});
 }catch(error){failure=String(error);throw error}finally{
  fs.writeFileSync(out+'/report.json',JSON.stringify({at:new Date().toISOString(),passed:!failure,failure,base,browser:browser.version(),checks,errors,failures:calls.filter(c=>c.status>=400)},null,2));
  await browser.close();
 }
})().catch(error=>{console.error(error.stack);process.exitCode=1});
