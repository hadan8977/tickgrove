const {test}=require('node:test'),assert=require('node:assert/strict');
require('../scripts/register-typescript.cjs');
const {toPine,fromPine}=require('../src/builder/codegen.ts');
const {runPine}=require('../src/pine/runtime.ts');
const condition=(cmp,value)=>({id:'c'+value,type:'condition',left:{kind:'price',field:'close'},cmp,right:{kind:'value',value}});
const def={id:'short-test',name:'Quoted "short" strategy',symbol:'FIXTURE',tf:'1D',direction:'short',entry:{id:'entry',type:'group',op:'all',children:[condition('>',60)]},exit:{id:'exit',type:'group',op:'any',children:[condition('<',60)]},sizePct:50,stopPct:null,takePct:null,capital:10000,commissionBps:2.5,slippageTicks:2,updatedAt:0};
test('builder roundtrip preserves named strategy, nested conditions and explicit cost settings',()=>{assert.deepEqual(fromPine(toPine(def)),{ok:true,def});assert.equal(fromPine(toPine(def).replace('qty_type','invalid_qty_type')).ok,false)});
test('generated short strategy uses native next-open fills, capital, percent fees and tick slippage',async()=>{
 const bars=[80,70,40,30,35].map((price,i)=>({time:1735776000+i*86400,open:price,high:price,low:price,close:price,volume:100}));
 const r=await runPine(toPine(def),bars,'1D',{symbol:'FIXTURE',metadata:{timezone:'UTC',mintick:.01},backtest:true});assert.equal(r.ok,true,r.error?.message);assert.equal(r.backtest.config.capital,10000);assert.equal(r.backtest.nativeConfig.slippageTicks,2);assert.equal(r.backtest.nativeConfig.commissionValue,.025);assert.equal(r.backtest.trades.length,1);const trade=r.backtest.trades[0];assert.equal(trade.side,'short');assert.ok(Math.abs(trade.entryPrice-69.98)<1e-9);assert.ok(Math.abs(trade.exitPrice-30.02)<1e-9);assert.ok(trade.pnl>0);
});
