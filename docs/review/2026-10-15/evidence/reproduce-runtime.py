#!/usr/bin/env python3
"""Adversarial review repro, NOT passing product acceptance. Own temporary DB only."""
import json, os, pathlib, socket, subprocess, tempfile, time, urllib.request, uuid, sqlite3

ROOT = pathlib.Path(__file__).resolve().parents[4]
RESULT = pathlib.Path(os.environ.get('TICKGROVE_REVIEW_OUTPUT', str(ROOT/'var/review/runtime-observed.json')))
RESULT.parent.mkdir(parents=True,exist_ok=True)
node_probe = r"""
require('./scripts/register-typescript.cjs');
const {PineEventHost}=require('./src/pine/host.ts');
const b=(i,c=10)=>({time:1700006400+i*60,closeTime:1700006460+i*60,open:10,high:Math.max(10,c),low:Math.min(10,c),close:c,volume:1});
const src=exit=>`//@version=6\nstrategy('review',calc_on_every_tick=true)\nif barstate.isrealtime and strategy.position_size==0\n    strategy.entry('L',strategy.long,qty=2)\nif barstate.isrealtime and strategy.position_size>0\n    ${exit}`;
(async()=>{
 const findings=[];
 for(const exit of ["strategy.exit('Exit','L',profit=20,loss=10)","strategy.exit('Exit','L',trail_points=2,trail_offset=1)"]){
  const h=await PineEventHost.create(src(exit),[b(0),b(1)],'1m',{broker:{startingCash:1000}});
  await h.append({id:'a',kind:'forming',bar:b(2),eventTime:1700006520000});
  h.applyBrokerFill({id:'f',orderId:'L',side:'buy',qty:2,price:10,fee:0,time:1700006520100,barIndex:2});
  await h.append({id:'b',kind:'forming',bar:b(2,10.01),eventTime:1700006520200});
  findings.push({source:exit,pending:h.pendingOrders,absoluteLimitStopAbsent:h.pendingOrders.every(o=>o.limit==null&&o.stop==null),rustSourceFinding:'server/src/pine_host.rs:593-604 defaults absent limit/stop to market; actual Rust local order dispatch not executed by this probe'});
 }
 const x=await PineEventHost.create(src('plot(close)'),[b(0),b(1)],'1m',{broker:{startingCash:1000}});
 await x.append({id:'x',kind:'forming',bar:b(2),eventTime:1700006520000});
 const issued=x.pendingOrders;
 const accepted=x.applyBrokerFill({id:'wrong',orderId:'L',side:'sell',qty:2,price:10,fee:0,time:1700006520100,barIndex:2});
 console.log(JSON.stringify({exitIntents:findings,wrongSide:{issued,accepted,account:x.account}}));
})().catch(e=>{console.error(e);process.exitCode=1});
"""
report = {'reviewedGitSha': subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
          'reviewAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'verdict':'ISSUES',
          'scope':'synthetic fixtures; no public preview state, provider keys, broker accounts or external orders',
          'pine':json.loads(subprocess.check_output(['node','-e',node_probe],cwd=ROOT,text=True))}
with tempfile.TemporaryDirectory(prefix='tickgrove-review-alerts-') as directory:
 with socket.socket() as sock:
  sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
 token=str(uuid.uuid4());url=f'http://127.0.0.1:{port}';process=None
 env={'PATH':os.environ.get('PATH','/usr/local/bin:/usr/bin:/bin')}
 env.update(TRADING_ROOT=str(ROOT),TRADING_DATA_DIR=directory,TRADING_BIND=f'127.0.0.1:{port}',TRADING_TOKEN=token,
            TRADING_COINBASE_WS_MOCK='ws://127.0.0.1:1',HTTPS_PROXY='http://127.0.0.1:1',
            HTTP_PROXY='http://127.0.0.1:1',ALL_PROXY='http://127.0.0.1:1',NO_PROXY='127.0.0.1,localhost')
 def start():
  global process
  process=subprocess.Popen([str(ROOT/'server/target/debug/tickgrove-server')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  for _ in range(200):
   try: urllib.request.urlopen(url+'/health');return
   except OSError:time.sleep(.02)
  raise RuntimeError('startup timeout')
 def stop():process.terminate();process.wait(10)
 def call(method,params):
  req=urllib.request.Request(url+'/api/command',data=json.dumps({'method':method,'params':params}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
  with urllib.request.urlopen(req,timeout=20) as response:return json.load(response)
 try:
  start();stop();t=int(time.time())//60*60-60
  identity=dict(provider='coinbase',symbol='TEST-USD',symbolId='COINBASE:TEST-USD',venue='COINBASE',currency='USD',assetClass='crypto',timeframe='1m',timezone='UTC',session='24x7',adjustment='none',feed='public-websocket',testFixture=True)
  bar=dict(time=t+60,closeTime=t+120,open=10,high=10,low=10,close=10,volume=1)
  with sqlite3.connect(directory+'/trading.sqlite') as db:
   db.execute("INSERT INTO market_subscriptions(id,provider,symbol,timeframe,identity,status,feed) VALUES('fixture','coinbase','TEST-USD','1m',?,'connecting','public-websocket')",(json.dumps(identity),))
   db.execute("INSERT INTO market_bars(subscription_id,time,payload,closed,quality) VALUES('fixture',?,?,0,?)",(bar['time'],json.dumps(bar),json.dumps({'complete':True})))
  start()
  data=dict(symbol='TEST-USD',timeframe='1m',metadata=dict(identity=identity,provenance=dict(synthetic=True,testFixture=True,gaps=[]),timezone='UTC',currency='USD'),bars=[dict(bar,time=t,closeTime=t+60)])
  snapshot=call('data.import',{'data':data})
  version=call('strategy.createVersion',dict(name='Review alert',kind='pine',source='//@version=6\nindicator("Review alert")\nif barstate.isrealtime\n    alert("probe-live-alert",alert.freq_all)\nplot(close)'))
  sid=call('pine.host.deploy',dict(version_id=version['id'],snapshot_id=snapshot['id'],subscription_id='fixture',execution='indicator'))['session_id']
  def wait(predicate):
   for _ in range(300):
    value=call('pine.host.status',{'session_id':sid})
    if predicate(value):return value
    assert value['status']!='failed',value
    time.sleep(.03)
   raise AssertionError(value)
  wait(lambda x:x['status']=='active')
  with sqlite3.connect(directory+'/trading.sqlite') as db:
   db.execute("INSERT INTO market_events(subscription_id,type,event_time,received_at,payload,quality) VALUES('fixture','bar.update',?,?,?,?)",(int(time.time()*1000),int(time.time()*1000),json.dumps(bar),json.dumps({'complete':True})))
  value=wait(lambda x:bool((x.get('result') or {}).get('alerts')))
  history=call('alerts.strategyHistory',{})
  stop();start();wait(lambda x:x['status']=='active')
  report['realtimeAlerts']={'loopbackPort':port,'temporaryDatabaseDeletedOnExit':True,'outboundHttpBlocked':True,
      'liveHostAlerts':value['result']['alerts'],'historyBeforeRestart':history,'historyAfterRestart':call('alerts.strategyHistory',{})}
 finally:
  if process and process.poll() is None:stop()
RESULT.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'verdict':report['verdict'],'result':str(RESULT),'issuesReproduced':['relative/trailing intent lacks absolute limit/stop','opposite-side fill accepted','realtime alert history absent before/after restart']}))
