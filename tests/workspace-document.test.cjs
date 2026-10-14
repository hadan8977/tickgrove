const {test}=require('node:test'),assert=require('node:assert/strict');
require('../scripts/register-typescript.cjs');
const {validateWorkspace}=require('../src/service/workspaceDocument.ts');
const {exampleStrategy}=require('../src/builder/model.ts');
function fixture(){const def=exampleStrategy();return {schema:'trading.workspace.v1',charts:{charts:{main:{id:'main',symbol:'COINBASE:SOL-USD',tf:'1m',group:null,style:'candles',indicators:[]}},drawings:{'COINBASE:SOL-USD':[{id:'line',tool:'trend',points:[{t:1,p:100},{t:2,p:110}],locked:true}]},watchlists:[{id:'general',name:'General',symbols:['COINBASE:SOL-USD','YAHOO:VOO']}],activeWatchlist:'general'},workspaces:{workspaces:[{id:'work',name:'Main',layout:null,preset:'trade',updatedAt:1}],activeId:'work'},scripts:{scripts:[{id:'pine',name:'Indicator',kind:'indicator',source:'//@version=6\nindicator("Test")\nplot(close)',updatedAt:1}],openIds:['pine'],activeId:'pine'},builder:{defs:[def],activeId:def.id},app:{theme:'dark',activeChartId:'main'}}}
test('workspace roundtrip preserves generic identities, drawings and strategies but excludes store actions',()=>{
 const data=fixture();data.charts.setSymbol='not a function';data.app.toast={};data.scripts.upsert=false;data.builder.setDef=null;const saved=validateWorkspace(JSON.parse(JSON.stringify(data)));
 assert.equal(saved.charts.charts.main.symbol,'COINBASE:SOL-USD');assert.equal(saved.charts.drawings['COINBASE:SOL-USD'][0].locked,true);assert.equal(saved.builder.defs[0].entry.children.length,2);assert.equal('setSymbol' in saved.charts,false);assert.equal('toast' in saved.app,false);assert.equal('upsert' in saved.scripts,false);assert.equal('setDef' in saved.builder,false);
});
test('workspace rejects malformed sections and dangling references before mutation',()=>{
 for(const mutate of [d=>d.charts.charts.main.tf='invalid',d=>d.charts.drawings['COINBASE:SOL-USD'][0].points=[{t:1,p:'no'}],d=>d.scripts.openIds=['missing'],d=>d.charts.watchlists=[],d=>d.builder.defs[0].entry.children[0].left=null,d=>d.workspaces.workspaces.push(d.workspaces.workspaces[0])]){const d=fixture();mutate(d);assert.throws(()=>validateWorkspace(d),/Invalid workspace/)}
});
test('workspace tolerates a removed active chart and rejects prototype dictionary keys',()=>{
 const d=fixture();d.app.activeChartId='removed';assert.equal(validateWorkspace(d).app.activeChartId,null);d.charts.charts=JSON.parse('{"__proto__":{"id":"__proto__"}}');assert.throws(()=>validateWorkspace(d),/Invalid workspace/);
});
