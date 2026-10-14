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
  start();stop();t=int(time.time())//60*60-600
  identity={'provider':'coinbase','symbol':'TEST-USD','symbolId':'COINBASE:TEST-USD','venue':'COINBASE','currency':'USD','assetClass':'crypto','timeframe':'1m','timezone':'UTC','session':'24x7','adjustment':'none','feed':'public-websocket','testFixture':True}
  db=sqlite3.connect(d+'/trading.sqlite');db.execute("INSERT INTO market_subscriptions(id,provider,symbol,timeframe,identity,status,feed) VALUES('fixture','coinbase','TEST-USD','1m',?,'connecting','public-websocket')",(json.dumps(identity),));db.commit();db.close();start()
  data={'symbol':'TEST-USD','timeframe':'1m','metadata':{'identity':identity,'provenance':{'synthetic':True,'testFixture':True,'gaps':[]},'timezone':'UTC','currency':'USD'},'bars':[{'time':t,'closeTime':t+60,'open':10,'high':10,'low':10,'close':10,'volume':1}]};snap=call('data.import',{'data':data})
  pine=call('strategy.createVersion',{'name':'Pine live fixture','kind':'pine','source':'//@version=6\nstrategy("Fixture",initial_capital=1000,commission_type=strategy.commission.cash_per_order,commission_value=0)\nif bar_index==0\n    strategy.entry("L",strategy.long,qty=2)\nif bar_index==1\n    strategy.close("L")'})
  composer=call('strategy.createVersion',{'name':'Composer live fixture','kind':'composer','source':json.dumps({'version':1,'capital':1000,'commissionBps':0,'rebalance':{'everyBars':1,'threshold':0},'tree':{'type':'asset','symbol':'TEST-USD'}})})
  ids=[]
  for version in [pine,composer]:ids.append(call('paper.deploy',{'version_id':version['id'],'snapshot_id':snap['id'],'subscription_id':'fixture'})['session_id'])
  initial=wait_sessions(2)
  for _ in range(300):
   if connections:break
   time.sleep(.02)
  async def send(value):
   for ws in list(connections):await ws.send(json.dumps(value))
  def publish(value):asyncio.run_coroutine_threadsafe(send(value),loop).result(10)
  def stamp(sec):return time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(sec))
  publish({'type':'match','product_id':'TEST-USD','trade_id':1,'time':stamp(t+1),'price':'10','size':'1'});publish({'type':'heartbeat','product_id':'TEST-USD','last_trade_id':1,'time':stamp(t+60)})
  for n in [1,2]:
   publish({'type':'match','product_id':'TEST-USD','trade_id':n+1,'time':stamp(t+n*60+1),'price':str(10+n),'size':'1'});publish({'type':'heartbeat','product_id':'TEST-USD','last_trade_id':n+1,'time':stamp(t+(n+1)*60)})
   time.sleep(.1)
   for _ in range(1000):
    s=call('paper.list',{});db=sqlite3.connect(d+'/trading.sqlite');counts=[db.execute('SELECT json_array_length(payload,\'$.bars\') FROM snapshots WHERE id=?',(x['snapshot_id'],)).fetchone()[0] for x in s];db.close()
    if all(c==n+1 for c in counts) and all(not x['pending_job_id'] for x in s):break
    if any(x['error']for x in s):raise RuntimeError(s)
    time.sleep(.05)
   else:raise RuntimeError({'sessions':s,'bars':counts})
   if n==1:stop();start();time.sleep(.3)
  settled=wait_sessions(2);reports=[call('backtest.results',{'job_id':s['last_job_id']})for s in settled]
  assert all(s['subscription_id']=='fixture' for s in settled)
  for s,r in zip(settled,reports):
   result=r['result']
   if s['name'].startswith('Pine'):
    trade=result['backtest']['trades'][0];assert trade['entryPrice']==11 and trade['exitPrice']==12 and trade['qty']==2;assert result['backtest']['metrics']['netProfit']==2
   else:assert abs(result['frames'][-1]['equity']-1090.909090909091)<1e-8
  before=[s['last_job_id'] for s in settled]
  publish({'type':'match','product_id':'TEST-USD','trade_id':3,'time':stamp(t+121),'price':'12','size':'1'});publish({'type':'heartbeat','product_id':'TEST-USD','last_trade_id':3,'time':stamp(t+180)});time.sleep(.5);assert [s['last_job_id']for s in call('paper.list',{})]==before
  for id in ids:call('paper.stop',{'session_id':id})
  for id in ids:assert call('paper.stop',{'session_id':id})['duplicate']

  print(json.dumps({'fixtureOnly':True,'externalNetworkBlocked':True,'externalOrders':False,'initial':initial,'settled':settled,'reports':reports},indent=2))
 finally:
  if service.poll() is None:stop()
