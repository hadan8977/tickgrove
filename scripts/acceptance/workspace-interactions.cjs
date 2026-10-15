// Current-source browser checks: demo grid and isolated component fixtures. No service writes.
const {chromium}=require('/tmp/trading-browser-tools/node_modules/playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
const BASE=process.env.TICKGROVE_REVIEW_URL||'http://127.0.0.1:18894';
const report={at:new Date().toISOString(),base:BASE,publicPreviewWrites:false,serverRequestsForwarded:0,checks:[]};
(async()=>{
 const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox'],headless:true});
 try{
  const ctx=await browser.newContext({viewport:{width:1366,height:768}});
  await ctx.addInitScript(()=>sessionStorage.setItem('tickgrove.splash','1'));
  const page=await ctx.newPage();
  await page.route('**/api/**',route=>route.abort());
  await page.goto(BASE+'/?mode=demo',{waitUntil:'commit',timeout:20000});
  await page.waitForFunction(()=>window.tickgrove&&document.querySelector('.chart-panel'),null,{timeout:45000});
  const original=await page.evaluate(async()=>{
   const id=window.tickgrove.state().activeChartId;
   await window.tickgrove.execute('chart.setSymbol',{chartId:id,symbol:'COINBASE:SOL-USD'});
   await window.tickgrove.execute('chart.setTimeframe',{chartId:id,tf:'5m'});
   await window.tickgrove.execute('chart.setStyle',{chartId:id,style:'area'});
   return window.tickgrove.state().charts.find(c=>c.id===id);
  });
  const ids=async()=>page.locator('.chart-panel').evaluateAll(nodes=>nodes.map(n=>n.dataset.chartId));
  await page.evaluate(()=>window.tickgrove.execute('workspace.applyLayout',{preset:'charts6'}));
  await page.waitForFunction(()=>document.querySelectorAll('.chart-panel').length===6);
  const six=await ids();assert(six.includes(original.id));
  await page.evaluate(()=>window.tickgrove.execute('workspace.applyLayout',{preset:'charts1'}));
  assert.deepEqual(await ids(),[original.id]);
  await page.reload({waitUntil:'commit'});
  await page.waitForFunction(()=>window.tickgrove&&document.querySelector('.chart-panel'));
  await page.evaluate(()=>window.tickgrove.execute('workspace.applyLayout',{preset:'charts6'}));
  assert.deepEqual(new Set(await ids()),new Set(six));
  const current=await page.evaluate(id=>window.tickgrove.state().charts.find(c=>c.id===id),original.id);
  assert.equal(current.symbol,original.symbol);assert.equal(current.tf,original.tf);assert.equal(current.style,'area');
  await page.evaluate(()=>window.tickgrove.execute('workspace.replaceTemplate',{preset:'trade'}));
  assert(!(await ids()).includes(original.id));
  await page.evaluate(()=>window.tickgrove.execute('workspace.undoLayout'));
  assert.deepEqual(new Set(await ids()),new Set(six));
  report.checks.push('Fresh demo: SOL-USD/5m/area and chart IDs survive 6→1→reload→6; template replacement Undo restores all six.');
  await ctx.close();

  // Each fixture renders actual source components in a new document; every API is fulfilled here.
  const fixture=async(componentCode,respond)=>{
   const c=await browser.newContext({viewport:{width:1100,height:800}}),p=await c.newPage();
   await p.route('**/api/**',async route=>{
    const request=route.request(); const {method,params}=request.postDataJSON()||{};
    try{const value=await respond(method,params);await route.fulfill({status:value?.status||200,contentType:'application/json',body:JSON.stringify(value?.body??value)});}catch(e){await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:String(e)})});}
   });
   await p.route('**/__review__.html',route=>route.fulfill({contentType:'text/html',body:`<html><body><div id="root" style="height:760px"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module">import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';const {createRoot}=ReactDOM;import '/src/index.css';${componentCode}</script></body></html>`}));
   p.on("pageerror",error=>{report.fixtureErrors??=[];if(report.fixtureErrors.length<5)report.fixtureErrors.push(error.stack?.slice(0,700)||error.message)});await p.goto(BASE+'/__review__.html',{waitUntil:'commit'});return {c,p};
  };
  let resolveSol;
  const search=await fixture(`import SymbolSearch from '/src/features/chart/SymbolSearch.tsx';import {configureData} from '/src/data/feed.ts';configureData('service',false);window.picks=[];createRoot(document.getElementById('root')).render(React.createElement(SymbolSearch,{onPick:s=>window.picks.push(s)}));`,async(method,params)=>{
   assert.equal(method,'market.search');if(params.query==='VOO')return {symbols:[{provider:'yahoo',symbol:'VOO.MX',name:'Mexico Vanguard',exchange:'MEX',kind:'etf'},{provider:'yahoo',symbol:'VOO',name:'Vanguard S&P 500 ETF',exchange:'NYSEARCA',kind:'etf'}]};if(params.query==='SOL')await new Promise(resolve=>resolveSol=resolve);
   return {symbols:[{provider:params.query==='SOL'?'coinbase':'yahoo',symbol:params.query==='SOL'?'SOL-USD':'AAPL',name:params.query,exchange:params.query==='SOL'?'COINBASE':'NASDAQ',kind:params.query==='SOL'?'crypto':'stock'}]};
  });
  const input=search.p.getByRole('combobox',{name:'Search instruments'});
  await input.fill('AAPL');await search.p.getByRole('listbox').getByRole('option').first().waitFor();
  await input.fill('SOL');await input.press('Enter');assert.deepEqual(await search.p.evaluate(()=>window.picks),[]);
  await search.p.getByRole('status').waitFor();
  await new Promise(resolve=>setTimeout(resolve,400));resolveSol();
  await search.p.getByRole('listbox').getByRole('option').first().waitFor();await input.press('Enter');
  assert.deepEqual(await search.p.evaluate(()=>window.picks),['COINBASE:SOL-USD']);
  report.checks.push('Actual SymbolSearch fixture: changing AAPL→SOL then immediate Enter cannot choose old AAPL; completed SOL result is selectable.');
  await input.fill('VOO');await search.p.getByRole('listbox').getByRole('option').first().locator('span[title="YAHOO:VOO"]').waitFor();await input.press('Enter');
  assert.deepEqual(await search.p.evaluate(()=>window.picks),['COINBASE:SOL-USD','YAHOO:VOO']);
  report.checks.push('Actual Enter search: provider returns VOO.MX first; exact VOO is ranked first and Enter selects YAHOO:VOO.');await search.c.close();

  let installed=false,installParams;
  const source='//@version=6\nindicator("Needs library")\nimport Actual/Math/3 as math\nplot(math.twice(close))';
  const pine=await fixture(`import PineEditor from '/src/features/pine/PineEditor.tsx';import {configureData} from '/src/data/feed.ts';import {useScripts} from '/src/store/index.ts';configureData('service',false);useScripts.getState().upsert({id:'dependency-fixture',name:'Needs library',kind:'indicator',source:${JSON.stringify(source)},origin:'user',updatedAt:1});createRoot(document.getElementById('root')).render(React.createElement(PineEditor));`,async(method,params)=>{
   if(method==='pine.resolve')return installed?{lockHash:'fixture',libraries:[{reference:'Actual/Math/3',hash:'fixture',source:installParams.source}]}:{status:400,body:{error:'Missing local Pine library Actual/Math/3'}};
   if(method==='pine.library.list')return [];
   if(method==='pine.library.createVersion'){installParams=params;installed=true;return {reference:'Actual/Math/3'};}
   throw Error('Unexpected fixture method '+method);
  });
  await pine.p.getByRole('button',{name:'Resolve dependency'}).click();
  const dialog=pine.p.getByRole('dialog',{name:'Install Pine dependency'});
  await dialog.waitFor();assert.equal(await dialog.getByLabel('Publisher',{exact:true}).inputValue(),'Actual');
  assert.equal(await dialog.getByLabel('Library name',{exact:true}).inputValue(),'Math');
  assert.equal(await dialog.getByLabel('Version',{exact:true}).inputValue(),'3');
  await dialog.locator('.cm-content').fill('//@version=6\nlibrary("Math")\nexport twice(float value) => value * 2');
  await dialog.getByRole('button',{name:'Install dependency',exact:true}).click();
  await dialog.getByRole('status').waitFor();assert.equal(installParams.publisher,'Actual');assert.equal(installParams.version,3);
  await dialog.getByRole('button',{name:'Back to script'}).click();
  await pine.p.getByText('1 dependencies ready',{exact:true}).waitFor();
  assert.equal(await pine.p.locator('.cm-content').first().innerText(),source);
  report.checks.push('Actual PineEditor/PineLibraries fixtures: missing dependency opens prefilled Actual/Math/3, installs supplied source, rechecks lock and returns to unchanged script.');await pine.c.close();

  const account=await fixture(`import ServerAccount from '/src/service/ServerAccount.tsx';import {showPaperSession} from '/src/service/paperSelection.ts';import {useApp} from '/src/store/index.ts';useApp.setState({view:'library'});window.choose=()=>showPaperSession('new-session');window.selected=()=>useApp.getState().paperSessionId;createRoot(document.getElementById('root')).render(React.createElement(ServerAccount));`,async(method)=>{
   if(method==='account.state')return {cash:100000,equity:100000,unrealizedPnl:0,realizedPnl:0,totalFees:0,positions:[],orders:[],fills:[]};
   if(method==='paper.list')return [{session_id:'old-session',name:'Old strategy',status:'active',version_id:'v1',snapshot_id:'d1'},{session_id:'new-session',name:'Selected strategy',status:'active',version_id:'v2',snapshot_id:'d2'}];
   if(method==='strategy.list')return [];throw Error('Unexpected fixture method '+method);
  });
  await account.p.getByText('MANUAL PAPER ACCOUNT',{exact:true}).waitFor();await account.p.evaluate(()=>window.choose());
  const selected=account.p.locator('[data-paper-session="new-session"]');await selected.waitFor();
  await selected.getByText('Selected run',{exact:true}).waitFor();assert.equal(await account.p.evaluate(()=>document.activeElement.dataset.paperSession),'new-session');
  report.checks.push('Actual ServerAccount fixture: selected new run opens Strategies, is highlighted/focused and is explicitly separate from manual account totals.');await account.c.close();
  assert.deepEqual(report.fixtureErrors??[],[], 'Browser fixture JavaScript errors');
  report.ok=true;
 }catch(error){report.ok=false;report.error=String(error);throw error;}finally{
  await browser.close();fs.mkdirSync('docs/acceptance',{recursive:true});fs.writeFileSync('docs/acceptance/workspace-interactions.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }
})().catch(e=>{console.error(e);process.exitCode=1});
