const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const ts=require('typescript');
// Exercise the actual component effect, without a browser/service or mutable global market store.
const source=fs.readFileSync(require.resolve('../src/features/backtest/BacktestReport.tsx'),'utf8');
const part=source.slice(source.indexOf('function EquityChart('),source.indexOf('\nfunction Trades('));
const compiled=ts.transpileModule(part,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function harness(report,options={}){
 const calls=[],statuses=[],series=[],cleanups=[];let removed=false,feedReads=0,config;
 const chart={addSeries:()=>{const track={updates:[],setData(data){this.updates.push(JSON.parse(JSON.stringify(data)))}};series.push(track);return track},panes:()=>[{}, {setHeight(){}}],timeScale:()=>({fitContent(){}}),remove(){removed=true}};
 const context={exports:{},require,console,useRef:()=>({current:{}}),useState:()=>['',s=>statuses.push(s)],useApp:fn=>fn({theme:'dark'}),useEffect:fn=>cleanups.push(fn()),createChart:(el,cfg)=>{config=cfg;return chart},BaselineSeries:1,AreaSeries:2,HistogramSeries:3,ColorType:{Solid:'solid'},LineStyle:{Dashed:2},cssVar:()=> '#888',document:{body:{}},getComputedStyle:()=>({fontFamily:'Review Font, sans-serif'}),isDemoData:()=>!!options.demo,getBars(){feedReads++;if(!options.demo)throw Error('Current feed must not be used for a saved report');return options.bars??[]},command:(method,params)=>{calls.push(JSON.parse(JSON.stringify({method,params})));return options.load?options.load():Promise.resolve(options.snapshot??{bars:[]})}};
 vm.createContext(context);vm.runInContext(compiled,context);context.EquityChart({r:report});
 return {calls,statuses,series,cleanups,get feedReads(){return feedReads},get removed(){return removed},get config(){return config}};
}
const report={id:'saved-run',symbol:'YAHOO:VOO',tf:'1D',config:{capital:1000},equity:[{time:10,value:1000},{time:30,value:1200}],drawdown:[],server:{snapshotId:'original-snapshot',manifest:{snapshot_id:'manifest-snapshot'}}};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('saved report uses immutable snapshot despite absent current feed, aligned to equity times',async()=>{
 const h=harness(report,{snapshot:{bars:[{time:10,open:10,close:11},{time:20,open:11,close:12},{time:30,open:12,close:15},{time:40,open:15,close:20}]}});await flush();
 assert.deepEqual(h.calls,[{method:'data.get',params:{snapshot_id:'original-snapshot'}}]);assert.equal(h.feedReads,0);assert.deepEqual(h.series[1].updates[0],[{time:10,value:1100},{time:30,value:1500}]);assert.equal(h.config.layout.fontFamily,'Review Font, sans-serif');assert.match(h.statuses.at(-1),/saved snapshot/);
});
test('manifest fallback is used and empty snapshot is an explicit unavailable state, without crash',async()=>{
 const h=harness({...report,server:{manifest:{snapshot_id:'manifest-snapshot'}}});await flush();assert.equal(h.calls[0].params.snapshot_id,'manifest-snapshot');assert.equal(h.feedReads,0);assert.equal(h.series[1].updates.length,0);assert.match(h.statuses.at(-1),/unavailable.*starting price/);
});
test('snapshot time gaps are not replaced by current prices or interpolated samples',async()=>{
 const h=harness(report,{snapshot:{bars:[{time:10,open:10,close:11}]}});await flush();assert.deepEqual(h.series[1].updates[0],[{time:10,value:1100},{time:30}]);assert.match(h.statuses.at(-1),/1 strategy timestamp/);
});
test('late snapshot after component cleanup cannot update the removed chart',async()=>{
 let resolve;const h=harness(report,{load:()=>new Promise(r=>resolve=r)});h.cleanups[0]();resolve({bars:[{time:10,open:10,close:11}]});await flush();assert.equal(h.removed,true);assert.equal(h.series[1].updates.length,0);
});
test('demo results cannot take current live prices as their synthetic benchmark',async()=>{
 const {server,...demoReport}=report;const h=harness(demoReport);await flush();assert.equal(h.feedReads,0);assert.equal(h.calls.length,0);assert.match(h.statuses.at(-1),/Demo benchmark unavailable/);
});
