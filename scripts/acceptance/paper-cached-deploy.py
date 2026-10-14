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
  with sqlite3.connect(d+'/trading.sqlite') as db:
   for n in [1,2]:
    cached={'time':t+n*60,'closeTime':t+(n+1)*60,'open':10+n,'high':10+n,'low':10+n,'close':10+n,'volume':1}
    db.execute("INSERT INTO market_bars(subscription_id,time,payload,closed,quality) VALUES('fixture',?,?,1,?)",(cached['time'],json.dumps(cached),json.dumps({'complete':True,'source':'test fixture'})))
  ids=[]
  for version in [pine,composer]:ids.append(call('paper.deploy',{'version_id':version['id'],'snapshot_id':snap['id'],'subscription_id':'fixture'})['session_id'])
  for _ in range(1000):
   sessions=call('paper.list',{})
   with sqlite3.connect(d+'/trading.sqlite') as db:counts=[db.execute("SELECT json_array_length(payload,'$.bars') FROM snapshots WHERE id=?",(s['snapshot_id'],)).fetchone()[0] for s in sessions]
   if counts==[3,3] and all(not s['pending_job_id'] for s in sessions):break
   assert not any(s['error'] for s in sessions),sessions
   time.sleep(.05)
  assert counts==[3,3],sessions
  reports=[call('backtest.results',{'job_id':s['last_job_id']}) for s in sessions]
  for session,result in zip(sessions,reports):
   if session['name'].startswith('Pine'):
    trade=result['result']['backtest']['trades'][0];assert trade['entryPrice']==11 and trade['exitPrice']==12 and trade['qty']==2
   else:assert abs(result['result']['frames'][-1]['equity']-1090.909090909091)<1e-8
  print(json.dumps({'ok':True,'fixtureOnly':True,'cachedBeforeDeployment':2,'newWebsocketEvents':0,'sessions':sessions,'reports':reports},indent=2))
 finally:
  if service.poll() is None:stop()
