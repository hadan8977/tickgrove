"""Immutable local Pine libraries: real API, worker output and lock persistence."""
import json,os,pathlib,socket,subprocess,tempfile,time,urllib.request,urllib.error,uuid
ROOT=pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='trading-libraries-') as directory:
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 token=str(uuid.uuid4());env={**os.environ,'TRADING_ROOT':str(ROOT),'TRADING_DATA_DIR':directory,'TRADING_TOKEN':token,'TRADING_BIND':f'127.0.0.1:{port}'}
 service=subprocess.Popen([str(ROOT/'server/target/debug/trading-service')],env=env,stderr=subprocess.DEVNULL)
 def call(method,params={},key=None):
  request=urllib.request.Request(f'http://127.0.0.1:{port}/api/command',data=json.dumps({'method':method,'params':params,**({'idempotency_key':key} if key else {})}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
  with urllib.request.urlopen(request) as response:return json.load(response)
 try:
  for _ in range(100):
   try:call('system.capabilities');break
   except OSError:time.sleep(.1)
  end=int(time.time())//60*60-120
  primary=call('market.history',{'provider':'coinbase','symbol':'BTC-USD','timeframe':'1m','start':end-20*60,'end':end})
  assert primary['data']['metadata']['mincontract']==1e-8,primary['data']['metadata']
  source='//@version=6\nstrategy("Fractional real BTC",initial_capital=10000)\nif bar_index==0\n    strategy.entry("L",strategy.long,qty=0.0001)\nif bar_index==1\n    strategy.close("L")'
  version=call('strategy.createVersion',{'name':'Fractional real BTC','kind':'pine','source':source})['id']
  job=call('backtest.start',{'version_id':version,'snapshot_id':primary['snapshot_id']},str(uuid.uuid4()))
  for _ in range(200):
   status=call('backtest.status',{'job_id':job['job_id']})
   if status['status'] in ['succeeded','failed']:break
   time.sleep(.1)
  assert status['status']=='succeeded',status
  result=call('backtest.results',{'job_id':job['job_id']})['result'];trade=result['backtest']['trades'][0]
  assert abs(trade['qty']-.0001)<1e-12,trade
  assert trade['entryPrice']==primary['data']['bars'][1]['open'] and trade['exitPrice']==primary['data']['bars'][2]['open']
  print(json.dumps({'ok':True,'realNetwork':True,'externalOrders':False,'identity':primary['identity'],'metadata':primary['data']['metadata'],'snapshot_id':primary['snapshot_id'],'trade':trade},indent=2))
 finally:service.terminate();service.wait(10)
