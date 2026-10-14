#!/usr/bin/env python3
"""Offline deterministic WS fixture→Rust→Pine/Composer jobs. No external orders/keys.
Coinbase REST requests for the deliberately nonexistent TEST-USD fail explicitly;
all accepted prices below are marked test fixtures, never a real-network claim.
"""
import asyncio,json,os,pathlib,socket,subprocess,tempfile,time,urllib.request,urllib.error,uuid,sqlite3,threading
import websockets
ROOT=pathlib.Path(__file__).resolve().parents[2];connections=[];loop=asyncio.new_event_loop();ready=threading.Event()
async def handler(ws):
 await ws.recv();connections.append(ws)
 try:await ws.wait_closed()
 finally:
  if ws in connections:connections.remove(ws)
async def serve():
 server=await websockets.serve(handler,'127.0.0.1',0);globals()['wsport']=server.sockets[0].getsockname()[1];ready.set();await asyncio.Future()
def run():asyncio.set_event_loop(loop);loop.run_until_complete(serve())
thread=threading.Thread(target=run,daemon=True);thread.start();ready.wait()
with tempfile.TemporaryDirectory(prefix='paper-market-fixture-')as d:
 with socket.socket()as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 token=str(uuid.uuid4());env={k:v for k,v in os.environ.items()if not k.startswith('ALPACA_')};env.update(TRADING_ROOT=str(ROOT),TRADING_DATA_DIR=d,TRADING_BIND=f'127.0.0.1:{port}',TRADING_TOKEN=token,TRADING_COINBASE_WS_MOCK=f'ws://127.0.0.1:{wsport}',HTTPS_PROXY='http://127.0.0.1:1',HTTP_PROXY='http://127.0.0.1:1',ALL_PROXY='http://127.0.0.1:1',NO_PROXY='127.0.0.1,localhost');url=f'http://127.0.0.1:{port}'
 def start():
  global service
  service=subprocess.Popen([str(ROOT/'server/target/debug/trading-service')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  for _ in range(200):
   try:urllib.request.urlopen(url+'/health');return
   except OSError:time.sleep(.05)
  raise RuntimeError('service startup timeout')
 def call(method,params):
  req=urllib.request.Request(url+'/api/command',data=json.dumps({'method':method,'params':params,'idempotency_key':str(uuid.uuid4())}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
  try:
   with urllib.request.urlopen(req,timeout=60)as r:return json.load(r)
  except urllib.error.HTTPError as e:raise RuntimeError(e.read().decode())
 def wait_sessions(count):
  for _ in range(1000):
   sessions=call('paper.list',{})
   if len(sessions)==count and all(s['last_job_id'] and not s['pending_job_id'] for s in sessions):return sessions
   if any(s['error'] for s in sessions):raise RuntimeError(sessions)
   time.sleep(.05)
  raise RuntimeError('strategy settlement timeout')
 def stop():service.terminate();service.wait(15)
 try:
  start();stop();t=int(time.time())//60*60-60
  identity={'provider':'coinbase','symbol':'TEST-USD','symbolId':'COINBASE:TEST-USD','venue':'COINBASE','currency':'USD','assetClass':'crypto','timeframe':'1m','timezone':'UTC','session':'24x7','adjustment':'none','feed':'public-websocket','testFixture':True}
  db=sqlite3.connect(d+'/trading.sqlite');db.execute("INSERT INTO market_subscriptions(id,provider,symbol,timeframe,identity,status,feed) VALUES('fixture','coinbase','TEST-USD','1m',?,'connecting','public-websocket')",(json.dumps(identity),));db.commit();db.close();start()
  data={'symbol':'TEST-USD','timeframe':'1m','metadata':{'identity':identity,'provenance':{'synthetic':True,'testFixture':True,'gaps':[]},'timezone':'UTC','currency':'USD'},'bars':[{'time':t,'closeTime':t+60,'open':10,'high':10,'low':10,'close':10,'volume':1}]};snap=call('data.import',{'data':data})
  pine=call('strategy.createVersion',{'name':'Event host fixture','kind':'pine','source':'//@version=6\nstrategy("Event fixture",calc_on_every_tick=true)\nqty=input.int(1,"Quantity")\nvarip float ticks=0\nif barstate.isnew\n    ticks:=0\nticks+=1\nif barstate.isrealtime and strategy.position_size==0\n    strategy.entry("L",strategy.long,qty=qty)\nplot(strategy.position_size,"position")\nplot(ticks,"ticks")'})
  current={'time':t+60,'closeTime':t+120,'open':10,'high':10,'low':10,'close':10,'volume':1}
  with sqlite3.connect(d+'/trading.sqlite') as db:db.execute("INSERT INTO market_bars(subscription_id,time,payload,closed,quality) VALUES('fixture',?,?,0,?)",(current['time'],json.dumps(current),json.dumps({'complete':True})))
  deployed=call('pine.host.deploy',{'version_id':pine['id'],'snapshot_id':snap['id'],'subscription_id':'fixture','execution':'local_broker','startingCash':1000,'inputs':{'qty':2}});id=deployed['session_id']
  def settled(predicate):
   for _ in range(500):
    state=call('pine.host.status',{'session_id':id})
    if predicate(state):return state
    assert state['status']!='failed',state
    time.sleep(.05)
   raise AssertionError(state)
  settled(lambda s:s['status']=='active')
  host_limits=None
  for attempt in range(100):
   descendants=[service.pid]
   for parent in descendants:
    try:
     for task in pathlib.Path(f'/proc/{parent}/task').iterdir():
      for child in (task/'children').read_text().split():
       if int(child) not in descendants:descendants.append(int(child))
    except OSError:continue
   for pid in descendants:
    try:
     if b'pine-host-worker.cjs' in pathlib.Path(f'/proc/{pid}/cmdline').read_bytes():
      limits=pathlib.Path(f'/proc/{pid}/limits').read_text();host_limits=next(line for line in limits.splitlines() if line.startswith('Max cpu time'));assert 'unlimited' in host_limits,host_limits
    except OSError:continue
   if host_limits:break
   time.sleep(.05)
  assert host_limits,'Persistent host process was not found'
  def event(bar,kind='bar.update'):
   with sqlite3.connect(d+'/trading.sqlite') as db:db.execute("INSERT INTO market_events(subscription_id,type,event_time,received_at,payload,quality) VALUES('fixture',?,?,?,?,?)",(kind,int(time.time()*1000),int(time.time()*1000),json.dumps(bar),json.dumps({'complete':True})))
  event(current)
  intent=settled(lambda s:s['result'] and s['result'].get('pendingOrders'))
  assert intent['result']['pendingOrders'][0]['qty']==2,intent
  for _ in range(300):
   if connections:break
   time.sleep(.02)
  async def send(value):
   for ws in list(connections):await ws.send(json.dumps(value))
  import datetime
  stamp=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=1)).isoformat().replace('+00:00','Z')
  asyncio.run_coroutine_threadsafe(send({'type':'ticker','product_id':'TEST-USD','time':stamp,'price':'10','best_bid':'9.9','best_ask':'10.1'}),loop).result(10)
  filled=settled(lambda s:s['result'] and s['result'].get('account',{}).get('positionSize')==2)
  assert not filled['result']['pendingOrders'];assert abs(filled['result']['account']['cash']-979.7899)<1e-8,filled
  event({**current,'high':10.5,'close':10.5,'volume':2})
  updated=settled(lambda s:s['result'] and s['result']['plots']['position']['value']==2)
  assert updated['result']['plots']['ticks']['value']==2,updated
  assert abs(updated['result']['account']['equity']-1000.7899)<1e-8,updated
  before=updated['result'];stop();start();restored=settled(lambda s:s['result'] and s['result'].get('account',{}).get('positionSize')==2)
  assert restored['result']==before,restored
  for _ in range(200):
   try:rendered=call('pine.host.render',{'session_id':id});break
   except RuntimeError as error:
    if 'recovering' not in str(error):raise
    time.sleep(.05)
  assert len(rendered['bars'])==2 and rendered['render']['plots']
  call('pine.host.pause',{'session_id':id});call('pine.host.resume',{'session_id':id});call('pine.host.stop',{'session_id':id})
  assert call('pine.host.stop',{'session_id':id})['duplicate']
  external=call('pine.host.deploy',{'version_id':pine['id'],'snapshot_id':snap['id'],'subscription_id':'fixture','execution':'external_broker','startingCash':1000,'inputs':{'qty':2}});id=external['session_id']
  settled(lambda s:s['status']=='active');event({**current,'high':10.5,'close':10.5,'volume':2})
  pending=settled(lambda s:s['result'] and s['result'].get('pendingOrders'))
  order=pending['result']['pendingOrders'][0]
  fill={'id':'external-part-1','orderId':order['id'],'side':'buy','qty':1,'price':10.5,'fee':.01,'time':(t+61)*1000,'barIndex':1}
  call('pine.host.pause',{'session_id':id})
  partial=call('pine.host.feedback',{'session_id':id,'fill':fill});assert partial['result']['pendingOrders'][0]['qty']==1,partial
  assert call('pine.host.feedback',{'session_id':id,'fill':fill})['duplicate']
  second=call('pine.host.feedback',{'session_id':id,'fill':{**fill,'id':'external-part-2'}});assert not second['result']['pendingOrders'] and second['result']['account']['positionSize']==2,second
  before_external=second['result'];stop();start();restored_external=settled(lambda s:s['result'] and s['result'].get('account',{}).get('positionSize')==2)
  assert restored_external['result']==before_external,restored_external
  call('pine.host.stop',{'session_id':id})
  bad=call('strategy.createVersion',{'name':'Deadline fixture','kind':'pine','source':'//@version=6\nindicator("Deadline")\nwhile true\n    x=1'})
  failed_id=call('pine.host.deploy',{'version_id':bad['id'],'snapshot_id':snap['id'],'subscription_id':'fixture','execution':'indicator'})['session_id'];id=failed_id
  failed=settled(lambda s:s['status']=='failed')
  assert failed['error'],failed
  deadline=call('strategy.createVersion',{'name':'Event deadline fixture','kind':'pine','source':'//@version=6\nindicator("Slow event")\nfloat x=0\nfor i=0 to 49999\n    for j=0 to 49999\n        x+=math.sqrt(j+1)\nplot(x)'})
  id=call('pine.host.deploy',{'version_id':deadline['id'],'snapshot_id':snap['id'],'subscription_id':'fixture','execution':'indicator'})['session_id']
  deadline_failed=settled(lambda s:s['status']=='failed')
  assert 'deadline exceeded' in deadline_failed['error'],deadline_failed
  print(json.dumps({'ok':True,'eventDeadlineTerminal':deadline_failed,'faultTerminal':failed,'fixtureOnly':True,'externalOrders':False,'persistentRustService':True,'actualHostCpuLimit':host_limits,'externalPartialFillAndPausedFeedback':True,'externalRecovered':restored_external,'renderBars':len(rendered['bars']),'initialIntent':intent,'actualRustQuoteFill':filled,'updated':updated,'recovered':restored},indent=2))
 finally:
  if service.poll() is None:stop()
