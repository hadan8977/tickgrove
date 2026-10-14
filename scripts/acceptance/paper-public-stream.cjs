// Independent closed-bar paper acceptance using actual public Coinbase traffic.
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const base=process.env.TRADING_URL||'http://127.0.0.1:18879',token=fs.readFileSync(process.env.TRADING_TOKEN_FILE||'var/ui-real-data-review/auth-token','utf8').trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(method,params={},key){const r=await fetch(base+'/api/command',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({method,params,idempotency_key:key}),signal:AbortSignal.timeout(120000)});const b=await r.json();if(!r.ok)throw Error(method+': '+JSON.stringify(b));return b}
async function until(fn,timeout){const start=Date.now();while(Date.now()-start<timeout){const value=await fn();if(value)return value;await sleep(1000)}throw Error('Timed out waiting for a real closed-bar transition')}
(async()=>{
 let session;const startedAt=new Date().toISOString(),checks=[];
 try{
  // Seed only settled historical bars; the strategy's decision lies in the actual future stream.
  const startedSecond=Math.floor(Date.now()/1000),end=Math.floor(Date.now()/60000)*60-120,history=await api('market.history',{provider:'coinbase',symbol:'BTC-USD',timeframe:'1m',start:end-65*60,end,adjustment:'none',allowGaps:false});
  assert.equal(history.gaps.length,0);const n=history.data.bars.length;assert.ok(n>=60);
  const subscription=await api('market.subscribe',{provider:'coinbase',symbol:'BTC-USD',timeframe:'1m'});
  const source=`//@version=6\nstrategy("Public stream transition",initial_capital=10000,commission_type=strategy.commission.percent,commission_value=0.05)\nif bar_index == ${n+2}\n    strategy.entry("live-entry",strategy.long,qty=0.0001)\nif bar_index == ${n+3}\n    strategy.close("live-entry")\nplot(strategy.equity)`;
  const version=await api('strategy.createVersion',{name:'Public stream transition',kind:'pine',source});
  const deployed=await api('paper.deploy',{version_id:version.id,snapshot_id:history.snapshot_id,execution:'closed_bar_native',subscription_id:subscription.subscription_id},crypto.randomUUID());session=deployed.session_id;
  console.log(JSON.stringify({phase:'deployed',session,subscription:subscription.subscription_id,historicalBars:n,lastHistoricalTime:history.data.bars.at(-1).time}));
  const initial=await until(async()=>{const list=await api('paper.list'),s=list.find(s=>s.session_id===session);if(s.error)throw Error(s.error);if(!s.last_job_id)return;const r=await api('backtest.results',{job_id:s.last_job_id});return {s,r}},60000);
  assert.equal(initial.r.result.backtest.trades.length,0);
  checks.push('initial committed native ledger contains no closed trade');
  const final=await until(async()=>{const s=(await api('paper.list')).find(s=>s.session_id===session);if(s.error)throw Error(s.error);if(!s.last_job_id)return;const r=await api('backtest.results',{job_id:s.last_job_id});return r.result?.backtest?.trades?.length?{s,r}:null},360000);
  const trade=final.r.result.backtest.trades[0];assert.equal(trade.qty,0.0001);assert.equal(trade.entryBar,n+3);assert.equal(trade.exitBar,n+4);assert.ok(trade.entryTime>startedSecond);assert.ok(final.s.stream_cursor>initial.s.stream_cursor);
  const finalData=await api('data.get',{snapshot_id:final.r.manifest.snapshot_id});assert.equal(trade.entryPrice,finalData.bars[n+3].open);assert.equal(trade.exitPrice,finalData.bars[n+4].open);
  checks.push('actual public stream closes two new bars','bound source advances persisted cursor and native ledger','entry and exit match new official bar opens with exact requested size');
  const output={startedAt,completedAt:new Date().toISOString(),provider:'coinbase',symbol:'BTC-USD',timeframe:'1m',synthetic:false,session,subscription:subscription.subscription_id,historicalBars:n,finalBars:finalData.bars.length,initialJob:initial.s.last_job_id,finalJob:final.s.last_job_id,trade,checks};
  fs.mkdirSync('docs/acceptance',{recursive:true});fs.writeFileSync('docs/acceptance/paper-public-stream.json',JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output));
 }catch(error){fs.writeFileSync('docs/acceptance/paper-public-stream-failure.json',JSON.stringify({at:new Date().toISOString(),passed:false,session,error:String(error)},null,2)+'\n');throw error}finally{if(session)await api('paper.stop',{session_id:session})}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
