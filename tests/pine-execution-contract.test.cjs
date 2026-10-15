const {test}=require('node:test'),assert=require('node:assert/strict');
require('../scripts/register-typescript.cjs');
const {PineEventHost}=require('../src/pine/host.ts');
const bar=(i,c=10)=>({time:1700006400+i*60,closeTime:1700006460+i*60,open:10,high:Math.max(10,c),low:Math.min(10,c),close:c,volume:1});
const event=(id,kind='forming',i=2)=>({id,kind,bar:bar(i),eventTime:bar(i).time*1000+100});
const source=exit=>`//@version=6\nstrategy('contract',calc_on_every_tick=true)\nif barstate.isrealtime and strategy.position_size==0\n    strategy.entry('L',strategy.long,qty=2)\nif barstate.isrealtime and strategy.position_size>0\n    ${exit}`;
const fill=(extra={})=>({id:'entry',orderId:'L',side:'buy',qty:2,price:10,fee:.1,time:1700006520200,barIndex:2,...extra});
async function entry(exit='plot(close)'){const h=await PineEventHost.create(source(exit),[bar(0),bar(1)],'1m',{broker:{startingCash:1000}});await h.append(event('first'));return h;}
test('relative, trailing and bracket exits fail before an executable intent can be published',async()=>{
 for(const exit of ["strategy.exit('X','L',profit=20,loss=10)","strategy.exit('X','L',trail_points=2,trail_offset=1)","strategy.exit('X','L',stop=9,limit=12)"]){
  const h=await entry(exit);h.applyBrokerFill(fill());const account={...h.account};
  await assert.rejects(()=>h.append(event('second')),/Unsupported event broker|requires OCO/);
  assert.deepEqual(h.account,account);
 }
});
test('invalid direction, order identity, quantity and time feedback leave ledger and pending order unchanged',async()=>{
 const h=await entry(),account={...h.account},pending=h.pendingOrders;
 for(const bad of [{side:'sell'},{orderId:'missing'},{qty:3},{qty:-1},{fee:-1},{time:1700006400000},{barIndex:9},{barIndex:0}]){
  assert.throws(()=>h.applyBrokerFill(fill(bad)));assert.deepEqual(h.account,account);assert.deepEqual(h.pendingOrders,pending);
 }
 h.applyBrokerFill(fill({qty:1}));assert.equal(h.pendingOrders[0].qty,1);
 assert.equal(h.applyBrokerFill(fill({qty:1})).duplicate,true);
 assert.throws(()=>h.applyBrokerFill(fill({qty:1,price:11})),/reused/);
 assert.throws(()=>h.applyBrokerFill(fill({id:'late',qty:1,time:1700006520100})),/Out-of-order/);
 h.applyBrokerFill(fill({id:'rest',qty:1,time:1700006520300}));assert.equal(h.account.positionSize,2);assert.equal(h.pendingOrders.length,0);
});
test('supported absolute stop exits project correct side and partial quantities',async()=>{
 const h=await entry("strategy.exit('X','L',stop=9)");h.applyBrokerFill(fill());await h.append(event('exit'));
 assert.equal(h.pendingOrders[0].stop,9);assert.throws(()=>h.applyBrokerFill(fill({id:'wrong-exit',orderId:'X',side:'buy',qty:1,time:1700006520400})),/side/);
 h.applyBrokerFill(fill({id:'exit-part',orderId:'X',side:'sell',qty:1,price:9,time:1700006520400}));assert.equal(h.account.positionSize,1);assert.equal(h.pendingOrders[0].qty,1);
 h.applyBrokerFill(fill({id:'exit-rest',orderId:'X',side:'sell',qty:1,price:9,time:1700006520500}));assert.equal(h.account.positionSize,0);
});
test('live alert frequencies and replay produce identical occurrence sequences',async()=>{
 for(const [freq,counts]of [['alert.freq_all',[1,2,3]],['alert.freq_once_per_bar',[1,1,1]],['alert.freq_once_per_bar_close',[0,0,1]]]){
  const run=async()=>{const h=await PineEventHost.create(`//@version=6\nindicator('alerts')\nif barstate.isrealtime\n    alert('trigger',${freq})`,[bar(0),bar(1)],'1m');const start=h.state.alerts.length;
   for(let i=0;i<3;i++){const e=event(String(i),i===2?'closed':'forming');await h.append(e);assert.equal(h.state.alerts.length-start,counts[i]);await h.append(e);assert.equal(h.state.alerts.length-start,counts[i]);}
   return h.state.alerts.slice(start);};
  assert.deepEqual(await run(),await run());
 }
});
test('signed reversal feedback preserves actual transaction size and replay',async()=>{
 const source=`//@version=6\nstrategy('reverse',calc_on_every_tick=true)\nif barstate.isrealtime and strategy.position_size==0\n    strategy.entry('L',strategy.long,qty=2)\nif barstate.isrealtime and strategy.position_size>0\n    strategy.entry('S',strategy.short,qty=1)`;
 const run=async()=>{const h=await PineEventHost.create(source,[bar(0),bar(1)],'1m',{broker:{startingCash:1000}});await h.append(event('entry'));h.applyBrokerFill(fill());await h.append(event('reverse'));
  const order=h.pendingOrders[0];assert.equal(order.id,'S');assert.equal(order.direction,-1);assert.equal(order.qty,3);
  h.applyBrokerFill(fill({id:'reverse',orderId:'S',side:'sell',qty:3,time:1700006520400}));assert.equal(h.account.positionSize,-1);return h.account;};
 assert.deepEqual(await run(),await run());
});
test('persistent worker rejects invalid feedback without terminating or mutating state',async()=>{
 const {spawn}=require('node:child_process'),{createInterface}=require('node:readline');
 const child=spawn(process.execPath,['scripts/pine-host-worker.cjs'],{cwd:require('node:path').resolve(__dirname,'..'),stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();let stderr='';child.stderr.on('data',b=>{stderr+=b});
 const call=async request=>{child.stdin.write(JSON.stringify(request)+'\n');const result=await lines.next();assert.equal(result.done,false,stderr);return JSON.parse(result.value);};
 try{
  await call({operation:'init',source:source('plot(close)'),data:{symbol:'TEST-USD',timeframe:'1m',bars:[bar(0),bar(1)]},options:{broker:{startingCash:1000}}});
  await call({operation:'market',event:event('entry')});
  const rejected=await call({operation:'fill',fill:fill({side:'sell'})});assert.equal(rejected.ok,false);assert.equal(rejected.recoverable,true);
  const healthy=await call({operation:'state'});assert.equal(healthy.ok,true);assert.equal(healthy.account.positionSize,0);assert.equal(healthy.pendingOrders[0].qty,2);
  const accepted=await call({operation:'fill',fill:fill()});assert.equal(accepted.ok,true);assert.equal(accepted.account.positionSize,2);
 }finally{child.stdin.end();child.kill();}
});
