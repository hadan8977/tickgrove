const fs=require('node:fs'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.TICKGROVE_URL||process.env.TRADING_URL||'http://127.0.0.1:18892';
const token=fs.readFileSync(process.env.TICKGROVE_TOKEN_FILE||process.env.TRADING_TOKEN_FILE||'var/ui-real-data-review/auth-token','utf8').trim();
async function api(method,params={}){const r=await fetch(base+'/api/command',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({method,params})});assert.equal(r.status,200);return r.json();}
(async()=>{
 const saved=await api('workspace.get',{id:'default'}),doc=saved.data;
 const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
 const errors=[],checks=[];fs.mkdirSync('var/brand-review',{recursive:true});
 try{
  const legacy=await browser.newContext({viewport:{width:1480,height:760}});
  await legacy.addInitScript(d=>{
   for(const key of ['charts','workspaces','scripts','builder'])localStorage.setItem('oc.'+key,JSON.stringify({state:d[key],version:0}));
   localStorage.setItem('oc.app',JSON.stringify({state:{...d.app,theme:'moss'},version:0}));
   localStorage.setItem('oc.plugins',JSON.stringify({state:{enabled:{'oc.supertrend':false,'oc.position-sizer':false,'oc.sector-heatmap':true}},version:0}));
   sessionStorage.setItem('oc.splash','1');
  },doc);
  const p=await legacy.newPage();p.on('pageerror',e=>errors.push(String(e)));
  await p.goto(base+'/?mode=demo',{waitUntil:'commit'});await p.waitForFunction(()=>window.tickgrove?.state().charts.length);
  const migration=await p.evaluate(()=>({state:window.tickgrove.state(),sameApi:window.openComposer===window.tickgrove,theme:document.documentElement.dataset.theme,storage:['app','charts','workspaces','scripts','builder','plugins'].map(k=>localStorage.getItem('tickgrove.'+k)!==null),riskCommand:window.tickgrove.commands().some(c=>c.id==='risk.size')}));
  assert.equal(migration.sameApi,true);assert.equal(migration.state.app,'tickgrove');assert.equal(migration.theme,'moss');assert.ok(migration.storage.every(Boolean));assert.equal(migration.riskCommand,false);
  for(const old of doc.scripts.scripts)assert.ok(migration.state.scripts.some(s=>s.id===old.id&&s.name===old.name));
  await p.getByRole('button',{name:'Settings',exact:true}).click();await p.getByRole('button',{name:'Plugins',exact:true}).click();await p.getByText('Sector Heatmap',{exact:true}).waitFor();
  checks.push('legacy localStorage and splash restore under Tickgrove; saved scripts and disabled plugin choice survive; old browser API remains the same object');
  await legacy.close();
  const context=await browser.newContext({viewport:{width:1480,height:760}});
  await context.addInitScript(value=>sessionStorage.setItem('trading.token',value),token);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(base,{waitUntil:'commit'});await page.waitForFunction(()=>window.tickgrove?.state().charts.length,{}, {timeout:60000});
  await page.waitForFunction(()=>!document.querySelector('input[placeholder="Instance token (var/auth-token)"]'));
  assert.equal(await page.title(),'Tickgrove');assert.equal(await page.evaluate(()=>sessionStorage.getItem('tickgrove.token')===sessionStorage.getItem('trading.token')),true);
  const icon=await page.locator('link[rel="icon"]').getAttribute('href');assert.match(icon,/tickgrove/);
  for(let i=0;i<4&&(await page.evaluate(()=>document.documentElement.dataset.theme))!=='moss';i++){await page.evaluate(()=>window.tickgrove.execute('app.toggleTheme'));await page.waitForTimeout(100);}
  await page.evaluate(()=>window.tickgrove.execute('workspace.applyLayout',{preset:'charts4'}));
  await page.waitForFunction(()=>{const s=window.tickgrove.state();return [...document.querySelectorAll('.chart-panel')].every(n=>{const c=s.charts.find(c=>c.id===n.dataset.chartId);return c&&Number.isFinite(c.last)&&c.last>0})},{},{timeout:90000});
  assert.ok(!/Open Composer|Trading Dashboard|Figma Make/.test(await page.locator('body').innerText()));
  await page.waitForFunction(()=>[...document.querySelectorAll('.chart-panel')].every(n=>!n.querySelector('.market-status')?.textContent.includes('Loading')&&!n.innerText.includes('C —')),{},{timeout:120000});
  await page.screenshot({path:'var/brand-review/workspace.png'});
  const themes=[];for(let i=0;i<4;i++){await page.evaluate(()=>window.tickgrove.execute('app.toggleTheme'));await page.waitForTimeout(150);themes.push(await page.evaluate(()=>({name:document.documentElement.dataset.theme,color:getComputedStyle(document.querySelector('header svg[aria-label="Tickgrove"]')).color,overflow:document.documentElement.scrollWidth-innerWidth})));}
  assert.ok(themes.every(t=>t.overflow<=0));assert.equal(new Set(themes.map(t=>t.name)).size,4);
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(500);await page.getByRole('img',{name:'Tickgrove',exact:true}).first().waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.waitForFunction(()=>[...document.querySelectorAll('.chart-panel')].every(n=>!n.querySelector('.market-status')?.textContent.includes('Loading')&&!n.innerText.includes('C —')),{},{timeout:120000});
  await page.screenshot({path:'var/brand-review/mobile.png'});
  checks.push('existing session token signs into the real Rust workspace; title, favicon, desktop and mobile UI show Tickgrove across four themes');
  assert.deepEqual(errors,[]);
  fs.writeFileSync('docs/acceptance/rebrand-browser.json',JSON.stringify({at:new Date().toISOString(),base,checks,themes,errors,isolatedDataDirectory:'var/ui-real-data-review',publicPreviewWrites:false},null,2)+'\n');console.log(JSON.stringify({checks,themes,errors}));
 }catch(e){console.error(e.stack);throw e;}finally{await browser.close();}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
