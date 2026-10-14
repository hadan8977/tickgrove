const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../scripts/register-typescript.cjs');
const { runPine, parseInputs, detectKind, detectTitle } = require('../src/pine/runtime.ts');
const { createPineProvider } = require('../src/pine/data.ts');
const bars = Array.from({ length: 80 }, (_, i) => ({ time: 1700006400 + i * 86400, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 1000 }));
const run = (body, opts = {}) => runPine(`//@version=6\nindicator('Test')\n${body}`, bars, '1D', opts);
const end = result => result.plots.find(p => p.title === 'value').data.at(-1);

const expressions = [
  ['array', 'a = array.new<float>(2, close)\nplot(array.get(a,0),"value")',180],
  ['map', 'm = map.new<string,float>()\nmap.put(m,"p",close)\nplot(map.get(m,"p"),"value")',180],
  ['matrix', 'm = matrix.new<float>(2,2,close)\nplot(matrix.get(m,0,0),"value")',180],
  ['udt', 'type Point\n    float price\np=Point.new(close)\nplot(p.price,"value")',180],
  ['while', 'int i=0\nfloat n=0\nwhile i<3\n    i+=1\n    n+=1\nplot(n,"value")',3],
  ['for', 'float n=0\nfor i=0 to 4\n    n+=i\nplot(n,"value")',10],
  ['persistent var', 'var float n=0\nn+=1\nplot(n,"value")',80],
  ['history', 'plot(close[2],"value")',178],
  ['sma', 'plot(ta.sma(close,3),"value")',179],
  ['tuple return', 'pair(x) =>\n    [x,x+1]\n[a,b]=pair(close)\nplot(b,"value")',181],
  ['switch', 'n=switch\n    close>10=>3\n    =>2\nplot(n,"value")',3],
  ['na and nz', 'float n=na\nplot(nz(n,4),"value")',4],
  ['bool', 'plot(close>open ? 1:0,"value")',1],
  ['string', 'plot(str.length("abc"),"value")',3],
  ['math', 'plot(math.pow(2,3),"value")',8],
];
for (const [name,body,expected] of expressions) test(`Pine semantic: ${name}`, async()=>{
  const r=await run(body); assert.equal(r.ok,true,r.error?.message); assert.equal(end(r),expected);
});

test('inputs: multiline, named arguments, typed variables, duplicate titles and escaping', async()=>{
  const src=`//@version=6\nindicator(title='Input Test')\nint a=input.int(\n defval=2, title='Same', minval=1, maxval=10)\nint b=input.int(3,'Same')\ns=input.string('hello','Text')\nplot(a+b+str.length(s),'value')`;
  const inputs=parseInputs(src); assert.equal(inputs.length,3); assert.deepEqual(inputs.slice(0,2).map(i=>i.name),['a','b']);
  const r=await runPine(src,bars,'1D',{inputs:{a:4,b:5,s:'a"b'}});assert.equal(r.ok,true,r.error?.message);assert.equal(end(r),12);
  assert.equal(detectTitle(src),'Input Test');assert.equal(src.includes('defval=2'),true);
  const bad=await runPine(src,bars,'1D',{inputs:{a:0}});assert.equal(bad.ok,false);assert.match(bad.error.message,/range/);
});
test('input overrides reject NaN, fractions for int, and unknown keys', async()=>{
  for(const inputs of [{a:NaN},{a:1.5},{missing:1}]){const r=await run('a=input.int(2,"A")\nplot(a,"value")',{inputs});assert.equal(r.ok,false);}
});
test('comments do not block APIs or create declarations', async()=>{
  const r=await run('// import somebody/lib/1 as lib\nplot(close,"value")');assert.equal(r.ok,true,r.error?.message);
  assert.equal(detectKind('// strategy("fake")\nindicator("real")'),'indicator');
});
test('retained visual objects survive normalization',async()=>{
  const r=await run('var t=table.new(position.top_right,1,1)\nif barstate.islast\n    table.cell(t,0,0,"Hello")\n    line.new(bar_index-1,100,bar_index,102)\n    box.new(bar_index-1,104,bar_index,98)\n    label.new(bar_index,103,"Test")');
  assert.equal(r.ok,true,r.error?.message);
  assert.equal(r.visuals.__tables__.data[0].value[0].cells[0][0].text,'Hello');
  for(const key of ['__lines__','__boxes__','__labels__'])assert.equal(r.visuals[key].data[0].value.length,1);
});
test('native fills, quantity, commission and equity are preserved',async()=>{
  const src=`//@version=6\nstrategy('Timing',initial_capital=10000,commission_type=strategy.commission.percent,commission_value=0.1)\nif bar_index==1\n    strategy.entry('L',strategy.long,qty=2)\nif bar_index==4\n    strategy.close('L')`;
  const r=await runPine(src,bars.slice(0,8),'1D',{backtest:true});assert.equal(r.ok,true,r.error?.message);
  const t=r.backtest.trades[0];assert.equal(t.entryBar,2);assert.equal(t.exitBar,5);assert.equal(t.qty,2);assert.equal(t.entryPrice,102);assert.equal(t.exitPrice,105);
  assert.ok(Math.abs(t.pnl-5.586)<1e-10);assert.ok(Math.abs(r.backtest.equity.at(-1).value-10005.586)<1e-8);
  assert.equal(r.backtest.config.capital,10000);assert.equal(r.backtest.nativeConfig.commissionValue,0.1);
});
test('open positions stay open and contribute unrealized PnL',async()=>{
  const r=await runPine(`//@version=6\nstrategy('Open',initial_capital=10000)\nif bar_index==1\n    strategy.entry('L',strategy.long,qty=2)`,bars.slice(0,8),'1D',{backtest:true});
  assert.equal(r.ok,true,r.error?.message);assert.equal(r.backtest.trades.length,0);assert.equal(r.backtest.openPositions[0].qty,2);assert.equal(r.backtest.metrics.netProfit,12);
});
test('short positions and same-close orders retain their direction and timing',async()=>{
  const r=await runPine(`//@version=6\nstrategy('Short',initial_capital=10000,process_orders_on_close=true)\nif bar_index==1\n    strategy.entry('S',strategy.short,qty=2)\nif bar_index==4\n    strategy.close('S')`,bars.slice(0,8),'1D',{backtest:true});
  assert.equal(r.ok,true,r.error?.message);assert.equal(r.backtest.trades[0].side,'short');assert.equal(r.backtest.trades[0].entryBar,1);assert.equal(r.backtest.trades[0].exitBar,4);assert.equal(r.backtest.trades[0].pnl,-6);
});
test('multisymbol request uses the supplied dataset',async()=>{
  const r=await run('other=request.security("OTHER","D",close)\nplot(other,"value")',{datasets:[{symbol:'OTHER',timeframe:'D',bars:bars.map(b=>({...b,open:b.open*2,high:b.high*2,low:b.low*2,close:b.close*2}))}]});
  assert.equal(r.ok,true,r.error?.message);assert.equal(end(r),360);
});
test('provider rejects invented lower timeframes and invalid data',async()=>{
  const p=createPineProvider({symbol:'SPY',timeframe:'D',bars});
  await assert.rejects(p.getMarketData('SPY','5'),/cannot be invented/);
  await assert.rejects(p.getMarketData('MISSING','D'),/No dataset/);
  const r=await runPine('indicator("empty")',[]);assert.equal(r.ok,false);
  const d=await runPine('//@version=6\nindicator("bad")\nplot(close)',[bars[0],bars[0]]);assert.equal(d.ok,false);assert.match(d.error.message,/timestamps/);
});
test('loops have a runtime limit and imports have actionable diagnostics',async()=>{
  const r=await run('int i=0\nwhile i<100\n    i+=1\nplot(i)',{maxLoops:10});assert.equal(r.ok,false);
  const imp=await run('import test/lib/1 as lib\nplot(close)');assert.equal(imp.ok,false);assert.equal(imp.error.line,3);
});

test('higher timeframe values arrive only on the closing child bar by default',async()=>{
  const hourly=bars.slice(0,12).map((b,i)=>({...b,time:1704067200+i*3600}));
  const src='//@version=6\nindicator("HTF")\nplot(request.security(syminfo.tickerid,"240",close),"value")';
  const r=await runPine(src,hourly,'60');assert.equal(r.ok,true,r.error?.message);
  assert.deepEqual(r.plots[0].data,[null,null,null,104,104,104,104,108,108,108,108,112]);
  const prefix=await runPine(src,hourly.slice(0,8),'60');assert.deepEqual(prefix.plots[0].data,r.plots[0].data.slice(0,8));
});
test('explicit lookahead_on is preserved instead of silently changing the script',async()=>{
  const hourly=bars.slice(0,8).map((b,i)=>({...b,time:1704067200+i*3600}));
  const r=await runPine('//@version=6\nindicator("HTF")\nplot(request.security(syminfo.tickerid,"240",close,lookahead=barmerge.lookahead_on),"value")',hourly,'60');
  assert.equal(r.ok,true,r.error?.message);assert.deepEqual(r.plots[0].data,[104,104,104,104,108,108,108,108]);
});
test('missing requested symbols fail the whole run explicitly',async()=>{
  const r=await run('plot(request.security("MISSING","D",close),"value")');
  assert.equal(r.ok,false);assert.match(r.error.message,/No dataset supplied for MISSING/);
});
test('calendar bars use supplied close times; session data is not aggregated in UTC',async()=>{
  const monthly=[{...bars[0],time:1704067200,closeTime:1706745600},{...bars[1],time:1706745600,closeTime:1709251200}];
  const p=createPineProvider({symbol:'SPY',timeframe:'M',bars:monthly});
  const data=await p.getMarketData('SPY','M');assert.equal(data[0].closeTime,1706745600000);
  const sessions=createPineProvider({symbol:'SPY',timeframe:'D',bars,metadata:{timezone:'America/New_York'}});
  await assert.rejects(sessions.getMarketData('SPY','W'),/session-aligned/);
});
test('native partial exits preserve quantity and leave the remainder open',async()=>{
  const src='//@version=6\nstrategy("Partial",initial_capital=10000)\nif bar_index==1\n    strategy.entry("L",strategy.long,qty=4)\nif bar_index==3\n    strategy.close("L",qty=1)';
  const r=await runPine(src,bars.slice(0,8),'D',{backtest:true});assert.equal(r.ok,true,r.error?.message);
  assert.equal(r.backtest.trades[0].qty,1);assert.equal(r.backtest.trades[0].exitBar,4);
  assert.equal(r.backtest.openPositions.reduce((n,t)=>n+t.qty,0),3);
  assert.equal(r.backtest.metrics.netProfit,20);
});
test('cancelled limit orders do not generate trades',async()=>{
  const src='//@version=6\nstrategy("Cancel")\nif bar_index==1\n    strategy.entry("L",strategy.long,qty=2,limit=50)\nif bar_index==2\n    strategy.cancel("L")';
  const r=await runPine(src,bars.slice(0,8),'D',{backtest:true});assert.equal(r.ok,true,r.error?.message);
  assert.equal(r.backtest.trades.length,0);assert.equal(r.backtest.openPositions.length,0);assert.equal(r.backtest.metrics.netProfit,0);
});
test('v5 scripts and per-bar plot colors remain supported',async()=>{
  const r=await runPine('//@version=5\nindicator("v5",overlay=true)\nplot(close,"value",color=bar_index%2==0?color.red:color.green)',bars,'D');
  assert.equal(r.ok,true,r.error?.message);assert.equal(r.overlay,true);assert.equal(end(r),180);
  assert.notEqual(r.plots[0].colors[0],r.plots[0].colors[1]);
});
test('replay preserves native position sizes and reaches the exact final equity',async()=>{
  const {advanceReplay}=require('../src/pine/replay.ts');
  const r=await runPine('//@version=6\nstrategy("Replay",initial_capital=10000)\nif bar_index==1\n    strategy.entry("S",strategy.short,qty=3)',bars.slice(0,8),'D',{backtest:true});
  assert.equal(r.ok,true,r.error?.message);
  const frames=r.backtest.replayFrames;
  assert.equal(advanceReplay(frames,0,2).frame.positionSize,0);
  assert.equal(advanceReplay(frames,2).frame.positionSize,-3);
  const end=advanceReplay(frames,3,100);assert.equal(end.completed,true);assert.equal(end.cursor,8);
  assert.equal(end.frame.equity,r.backtest.equity.at(-1).value);assert.equal(end.frame.equity,9982);
});
test('UDT methods bind named primitive args in declaration order, including false and zero',async()=>{
  const body='type Cfg\n    float base=100.0\nmethod score(Cfg self,int n,float mult,bool flip)=>\n    self.base+float(n)*mult*(flip?-1:1)\nvar Cfg c=Cfg.new(100)\nplot(c.score(flip=true,mult=0.1,n=5),"value")\nplot(c.score(5,mult=0.0,flip=false),"zero")';
  const r=await run(body);assert.equal(r.ok,true,r.error?.message);assert.equal(end(r),99.5);
  assert.equal(r.plots.find(p=>p.title==='zero').data.at(-1),100);
});
test('named method series args retain history instead of becoming current scalars',async()=>{
  const r=await run('type Cfg\n    float base=0.0\nmethod previous(Cfg self,float value)=>\n    value[1]\nvar Cfg c=Cfg.new()\nplot(c.previous(value=close),"value")');
  assert.equal(r.ok,true,r.error?.message);assert.equal(end(r),179);assert.equal(r.plots[0].data[0],null);
});
test('named methods reject unknown and duplicate arguments',async()=>{
  for(const args of ['wrong=1','2,n=3']){
    const r=await run(`type Cfg\n    float base=0.0\nmethod score(Cfg self,int n)=>\n    self.base+n\nvar Cfg c=Cfg.new()\nplot(c.score(${args}),"value")`);
    assert.equal(r.ok,false);assert.match(r.error.message,/Unknown named|supplied twice/);
  }
});
test('named primitive method defaults bind by AST even when string defaults contain commas',async()=>{
  const r=await run('type Cfg\n    float base=100.0\nmethod score(Cfg self,int n=5,float mult=1.0,string label="a,b")=>\n    self.base+n*mult+str.length(label)\nvar Cfg c=Cfg.new(100)\nplot(c.score(mult=2.0),"value")\nplot(c.score(),"default")');
  assert.equal(r.ok,true,r.error?.message);assert.equal(end(r),113);assert.equal(r.plots.find(p=>p.title==='default').data.at(-1),108);
});
test('lower timeframe arrays contain every supplied child, including the final parent bar',async()=>{
  const primary=Array.from({length:3},(_,i)=>({time:1704067200+i*3600,open:i*4+1,high:i*4+4,low:i*4+1,close:i*4+4,volume:4}));
  const lower=Array.from({length:12},(_,i)=>({time:1704067200+i*900,open:i+1,high:i+1,low:i+1,close:i+1,volume:1}));
  const r=await runPine('//@version=6\nindicator("Lower")\na=request.security_lower_tf(syminfo.tickerid,"15",close)\nplot(array.size(a),"size")\nplot(array.sum(a),"sum")',primary,'60',{datasets:[{symbol:'LOCAL:CHART',timeframe:'15',bars:lower}]});
  assert.equal(r.ok,true,r.error?.message);assert.deepEqual(r.plots.find(p=>p.title==='size').data,[4,4,4]);
  assert.deepEqual(r.plots.find(p=>p.title==='sum').data,[10,26,42]);
});
test('fractional crypto quantity uses provider mincontract rather than integer lots',async()=>{const result=await runPine(`//@version=6\nstrategy('Fractional BTC',initial_capital=10000)\nif bar_index==0\n    strategy.entry('L',strategy.long,qty=0.0001)\nif bar_index==1\n    strategy.close('L')`,bars.slice(0,4),'1D',{backtest:true,symbol:'BTC-USD',metadata:{type:'crypto',currency:'USD',basecurrency:'BTC',mintick:.01,mincontract:1e-8,minmove:1,pricescale:100}});assert.equal(result.ok,true,result.error?.message);assert.equal(result.backtest.trades.length,1);assert.ok(Math.abs(result.backtest.trades[0].qty-.0001)<1e-12);});
