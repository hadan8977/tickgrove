const {test}=require('node:test');const assert=require('node:assert/strict');require('../scripts/register-typescript.cjs');const {runComposer}=require('../src/composer/engine.ts');
const bars=p=>p.map((close,i)=>({time:i+1,open:close,high:close,low:close,close,volume:1}));
const spec={capital:100,commissionBps:100,rebalance:{everyBars:1,threshold:0},tree:{type:'condition',symbol:'SPY',lookback:1,above:0,yes:{type:'asset',symbol:'SPY'},no:{type:'asset',symbol:'TLT'}}};
const data={symbol:'SPY',bars:bars([10,20,20]),datasets:[{symbol:'TLT',bars:bars([10,10,10])}]};
test('two-asset hand calculation reserves sales and purchases fees',()=>{const r=runComposer(spec,data);assert.ok(Math.abs(r.frames[1].equity-100/1.01)<1e-10);const afterSell=100/1.01*.99;assert.ok(Math.abs(r.frames[2].equity-afterSell/1.01)<1e-10);assert.equal(r.frames[2].cash,0);assert.equal(r.frames[2].orders[0].symbol,'TLT');assert.ok(r.frames[2].orders[0].qty<0);assert.ok(r.frames[2].orders[1].qty>0)});
test('duplicate filter and bad weights are errors',()=>{assert.throws(()=>runComposer({...spec,tree:{type:'filter',symbols:['SPY','SPY'],lookback:1,count:2,order:'top'}},data));assert.throws(()=>runComposer({...spec,tree:{type:'weight',children:[{weight:-1,node:{type:'asset',symbol:'SPY'}}]}},data))});
test('visible-prefix execution agrees with every batch frame',()=>{const full=runComposer(spec,data);for(let n=1;n<=3;n++){const prefix={...data,bars:data.bars.slice(0,n),datasets:data.datasets.map(d=>({...d,bars:d.bars.slice(0,n)}))};assert.deepEqual(runComposer(spec,prefix).frames,full.frames.slice(0,n))}});
test('weekly calendar uses first observed closed bar of new week after a holiday gap',()=>{const times=['2026-01-02T21:00:00Z','2026-01-06T21:00:00Z','2026-01-07T21:00:00Z'].map(s=>Date.parse(s)/1000);const ds={symbol:'SPY',metadata:{timezone:'America/New_York'},bars:bars([10,10,10]).map((b,i)=>({...b,time:times[i]}))};const s={...spec,commissionBps:0,tree:{type:'asset',symbol:'SPY'},rebalance:{calendar:'weekly',threshold:0}};const r=runComposer(s,ds);assert.ok(r.frames[1].reason.includes('Target scheduled for next bar open'));assert.ok(!r.frames[2].reason.includes('Target scheduled for next bar open'));assert.equal(r.frames[1].orders[0].qty,10);assert.throws(()=>runComposer(s,{...ds,metadata:{}}),/timezone/)});
test('cash and groups retain uninvested capital with exact specified weights',()=>{
 const s={...spec,commissionBps:0,tree:{type:'group',name:'Reserve',child:{type:'weight',children:[{weight:.8,node:{type:'asset',symbol:'SPY'}},{weight:.2,node:{type:'cash'}}]}}};
 const r=runComposer(s,{symbol:'SPY',bars:bars([10,10])});assert.equal(r.frames[1].cash,20);assert.equal(r.frames[1].positions.SPY,8);assert.equal(r.frames[1].equity,100);
});
test('equal weights ignore stale manual proportions and combine repeated assets',()=>{
 const s={...spec,commissionBps:0,tree:{type:'weight',mode:'equal',children:[{weight:99,node:{type:'asset',symbol:'SPY'}},{weight:0,node:{type:'asset',symbol:'SPY'}},{weight:1,node:{type:'cash'}}]}};
 const r=runComposer(s,{symbol:'SPY',bars:bars([10,10])});assert.ok(Math.abs(r.frames[1].cash-100/3)<1e-10);assert.ok(Math.abs(r.frames[1].positions.SPY-20/3)<1e-10);
});
test('inverse volatility matches hand-calculated 2:1 risk ratio and executes next open',()=>{
 const s={...spec,commissionBps:0,tree:{type:'weight',mode:'inverse_volatility',lookback:2,children:[{weight:1,node:{type:'asset',symbol:'SPY'}},{weight:1,node:{type:'asset',symbol:'TLT'}}]}};
 const d={symbol:'SPY',bars:bars([100,110,99,99,150]),datasets:[{symbol:'TLT',bars:bars([100,120,96,96,75])}]};
 const r=runComposer(s,d);assert.equal(r.frames[1].orders.length,0);assert.ok(Math.abs(r.frames[2].weights.SPY-2/3)<1e-12);assert.ok(Math.abs(r.frames[2].weights.TLT-1/3)<1e-12);assert.ok(Math.abs(r.frames[3].positions.SPY-(200/3)/99)<1e-12);
 for(let n=1;n<=d.bars.length;n++){const prefix={...d,bars:d.bars.slice(0,n),datasets:d.datasets.map(x=>({...x,bars:x.bars.slice(0,n)}))};assert.deepEqual(runComposer(s,prefix).frames,r.frames.slice(0,n))}
});
test('zero variance allocation is deterministic and finite',()=>{
 const s={...spec,commissionBps:0,tree:{type:'weight',mode:'inverse_volatility',lookback:2,children:[{weight:1,node:{type:'asset',symbol:'SPY'}},{weight:1,node:{type:'asset',symbol:'TLT'}}]}};
 const r=runComposer(s,{symbol:'SPY',bars:bars([10,10,10,10]),datasets:[{symbol:'TLT',bars:bars([10,20,10,10])}]});assert.equal(r.frames[2].weights.SPY,1);assert.equal(r.frames[2].weights.TLT,0);assert.equal(r.frames[3].equity,100);
 assert.throws(()=>runComposer({...s,tree:{...s.tree,lookback:1}},data),/lookback/);
});
