const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process'),crypto=require('node:crypto');
const executable=process.env.DOCKER_BINARY||'/tmp/trading-docker-tools/docker/docker',prefix=['--config','/tmp/trading-docker-tools/client','--host',process.env.DOCKER_HOST||'unix:///tmp/trading-dashboard-docker.sock'];
const container=process.env.TRADING_CONTAINER||'tradingdashboard-acceptance',base=process.env.TRADING_URL||'http://127.0.0.1:18884';
function docker(...args){return execFileSync(executable,[...prefix,...args],{encoding:'utf8',timeout:30000}).trim()}
const token=docker('exec',container,'cat','/app/var/auth-token'),checks=[];
async function api(method,params={},key){const r=await fetch(base+'/api/command',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({method,params,idempotency_key:key}),signal:AbortSignal.timeout(30000)});const b=await r.json();if(!r.ok)throw Error(method+': '+JSON.stringify(b));return b}
(async()=>{
 const uid=docker('exec',container,'id','-u');assert.equal(uid,'10001');checks.push('service container runs as unprivileged uid 10001');
 const probe=docker('exec',container,'node','-e','const fs=require("node:fs"); console.log(JSON.stringify({python:fs.existsSync("/usr/bin/python3"),node:process.version}))');const runtime=JSON.parse(probe);assert.equal(runtime.python,false);checks.push('runtime image has no Python interpreter');
 const unauthorized=await fetch(base+'/api/command',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'system.capabilities'})});assert.equal(unauthorized.status,401);checks.push('unauthenticated API rejected');
 assert.ok((await (await fetch(base)).text()).includes('/assets/'));checks.push('Rust serves built React entry point');
 const data={symbol:'DOCKER-FIXTURE',timeframe:'1D',metadata:{timezone:'UTC'},bars:[10,11,12,13,14,15].map((price,i)=>({time:1735776000+i*86400,open:price,high:price,low:price,close:price,volume:1}))};
 const snapshot=await api('data.import',{data}),version=await api('strategy.createVersion',{name:'Docker native ledger',kind:'pine',source:'//@version=6\nstrategy("Docker native ledger",initial_capital=1000)\nif bar_index == 1\n    strategy.entry("L",strategy.long,qty=2)\nif bar_index == 3\n    strategy.close("L")\nplot(close)'});
 const job=await api('backtest.start',{version_id:version.id,snapshot_id:snapshot.id},crypto.randomUUID());let status;for(let i=0;i<90;i++){status=await api('backtest.status',{job_id:job.job_id});if(!['queued','running'].includes(status.status))break;await new Promise(r=>setTimeout(r,500))}
 assert.equal(status.status,'succeeded',status.error);const result=await api('backtest.results',{job_id:job.job_id});const trade=result.result.backtest.trades[0];assert.equal(trade.qty,2);assert.equal(trade.entryPrice,12);assert.equal(trade.exitPrice,14);assert.equal(trade.pnl,4);checks.push('bubblewrap-isolated Pine worker executes and persists exact native fills');
 const report={at:new Date().toISOString(),image:docker('inspect','--format','{{.Image}}',container),runtime,uid,job:job.job_id,trade,checks};fs.writeFileSync('docs/acceptance/docker-runtime.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(error=>{console.error(error.stack);process.exitCode=1});
