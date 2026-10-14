const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../scripts/register-typescript.cjs');
const { runPine } = require('../src/pine/runtime.ts');
const { drawPineVisuals } = require('../src/features/chart/pineDrawing.ts');
const bars = [0,1,2].map(i=>({time:1704067200+i*3600,open:100+i,high:104+i,low:98+i,close:102+i,volume:1000}));
const viewport = {bars,chart:{timeScale:()=>({options:()=>({barSpacing:10}),logicalToCoordinate:i=>i*10})},series:{priceToCoordinate:p=>200-p}};
function canvas() {
  const calls=[];
  const ctx={fillStyle:'',strokeStyle:'',measureText:s=>({width:s.length*7})};
  for(const name of ['save','restore','translate','beginPath','rect','clip','fillRect','strokeRect','setLineDash','moveTo','lineTo','stroke','fill','closePath','fillText'])ctx[name]=(...args)=>calls.push({name,args,color:ctx.fillStyle});
  return {ctx,calls};
}
test('retained Pine tables and labels reach the canvas renderer as text',async()=>{
  const r=await runPine('//@version=6\nindicator("Visual",overlay=true)\nvar t=table.new(position.top_right,1,1)\nif barstate.islast\n    table.cell(t,0,0,"PUBLIC PINE")\n    label.new(bar_index,close,"LABEL")',bars,'60');
  assert.equal(r.ok,true,r.error?.message);
  const {ctx,calls}=canvas();drawPineVisuals(ctx,viewport,r.visuals,500,300);
  assert.deepEqual(calls.filter(c=>c.name==='fillText').map(c=>c.args[0]).sort(),['LABEL','PUBLIC PINE']);
  assert.ok(calls.some(c=>c.name==='fillText'&&c.args[0]==='LABEL'&&c.args[1]===20));
});
test('fill, candles and shapes retain geometry instead of disappearing as null plots',async()=>{
  const r=await runPine('//@version=6\nindicator("Visual",overlay=true)\np=plot(close,"C")\nq=plot(open,"O")\nfill(p,q,color=color.blue)\nplotcandle(open,high,low,close,title="Candles",color=color.green)\nplotshape(close>open,title="Up",text="UP",location=location.abovebar)',bars,'60');
  assert.equal(r.ok,true,r.error?.message);
  const {ctx,calls}=canvas();drawPineVisuals(ctx,viewport,r.visuals,500,300);
  assert.equal(calls.filter(c=>c.name==='fill').length,2);
  assert.equal(calls.filter(c=>c.name==='fillRect'&&c.color==='#4CAF50').length,3);
  const shape=calls.find(c=>c.name==='fillText'&&c.args[0]==='UP');assert.ok(shape);assert.equal(shape.args[2],200-bars[0].high-8);
});
test('background colors use Pine color options across the full bar width',async()=>{
  const r=await runPine('//@version=6\nindicator("Background")\nbgcolor(color.red)',bars,'60');
  assert.equal(r.ok,true,r.error?.message);
  const {ctx,calls}=canvas();drawPineVisuals(ctx,viewport,r.visuals,500,300);
  const rects=calls.filter(c=>c.name==='fillRect');assert.equal(rects.length,3);
  assert.deepEqual(rects[0].args,[-5,0,10,300]);assert.equal(rects[0].color,'#F23645');
});
