// Real free-source history -> immutable snapshot -> native Pine backtest.
// Requires an explicitly selected isolated test instance. No broker orders.
const fs=require('node:fs'), assert=require('node:assert/strict'), crypto=require('node:crypto');
const url=process.env.TICKGROVE_URL, tokenFile=process.env.TICKGROVE_TOKEN_FILE;
assert(url&&tokenFile,'Select an isolated test URL and token file explicitly');
assert(!tokenFile.includes('paseo-preview'),'Do not run acceptance against the public preview');
const token=fs.readFileSync(tokenFile,'utf8').trim();
async function api(method,params={},key){const r=await fetch(url+'/api/command',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({method,params,idempotency_key:key}),signal:AbortSignal.timeout(120000)});const body=await r.json();assert.equal(r.status,200,method+': '+JSON.stringify(body));return body;}
(async()=>{
 const sources=await api('connections.list');assert(sources.providers.find(p=>p.id==='yahoo').configured);assert(sources.providers.find(p=>p.id==='coinbase').configured);
 const sourceTests=[];for(const provider of ['yahoo','coinbase']){const r=await api('connections.test',{provider});assert(r.requestAccepted&&r.sampleAvailable);assert.equal(r.streamVerified,false);sourceTests.push({provider,latencyMs:r.latencyMs,sampleAvailable:r.sampleAvailable});}
 const history=await api('market.historyPage',{provider:'yahoo',symbol:'VOO',timeframe:'1D',limit:250});assert.equal(history.snapshot_id,null);assert(history.bars>200);
 const snapshot=await api('market.history',{provider:'yahoo',symbol:'VOO',timeframe:'1D',start:history.data.bars[0].time,end:history.page.requestedEnd,allowGaps:false});assert(snapshot.snapshot_id);assert.equal(snapshot.gaps.length,0);
 const version=await api('strategy.createVersion',{name:'Free-source execution acceptance',kind:'pine',source:'//@version=6\nstrategy("Free-source execution acceptance",initial_capital=10000)\nif bar_index == 1\n    strategy.entry("L",strategy.long,qty=2)\nif bar_index == 3\n    strategy.close("L")\nplot(ta.sma(close,20))'});
 const job=await api('backtest.start',{version_id:version.id,snapshot_id:snapshot.snapshot_id},crypto.randomUUID());let status;
 for(let n=0;n<120;n++){status=await api('backtest.status',{job_id:job.job_id});if(!['queued','running'].includes(status.status))break;await new Promise(r=>setTimeout(r,500));}
 assert.equal(status.status,'succeeded',status.error);
 const result=await api('backtest.results',{job_id:job.job_id}),trade=result.result.backtest.trades[0];
 assert.equal(trade.qty,2);assert.equal(trade.entryPrice,snapshot.data.bars[2].open);assert.equal(trade.exitPrice,snapshot.data.bars[4].open);assert(Math.abs(trade.pnl-2*(trade.exitPrice-trade.entryPrice))<1e-8);
 const report={at:new Date().toISOString(),ok:true,scope:'isolated real Yahoo VOO history and Coinbase/Yahoo read-only connection tests; native simulated backtest only; no broker orders or public-preview writes',sourceTests,symbol:'VOO',source:snapshot.identity,bars:snapshot.bars,gaps:snapshot.gaps.length,snapshotId:snapshot.snapshot_id,jobId:job.job_id,trade,checks:['free sources work without configured keys','connection test does not claim sustained stream verification','chart page is not a strategy snapshot','exact selected range freezes with zero gaps','real-source backtest uses recorded bar opens and persists the expected native ledger']};
 fs.writeFileSync('docs/acceptance/free-data-workflow.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
