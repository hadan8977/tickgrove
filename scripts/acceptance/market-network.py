"""Read-only real network acceptance; fresh instance, no API keys or orders."""
import json,os,pathlib,socket,subprocess,tempfile,time,urllib.request,urllib.error,uuid
ROOT=pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='trading-market-network-')as directory:
 with socket.socket()as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 token=str(uuid.uuid4());env={k:v for k,v in os.environ.items()if not k.startswith('ALPACA_')};env.update(TRADING_ROOT=str(ROOT),TRADING_DATA_DIR=directory,TRADING_BIND=f'127.0.0.1:{port}',TRADING_TOKEN=token);url=f'http://127.0.0.1:{port}';service=subprocess.Popen([str(ROOT/'server/target/debug/trading-service')],env=env,stderr=subprocess.PIPE)
 def call(method,params):
  request=urllib.request.Request(url+'/api/command',data=json.dumps({'method':method,'params':params,'idempotency_key':str(uuid.uuid4())}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
  try:
   with urllib.request.urlopen(request,timeout=60)as r:return json.load(r)
  except urllib.error.HTTPError as e:raise RuntimeError(e.read().decode())
 try:
  for _ in range(100):
   try:urllib.request.urlopen(url+'/health');break
   except OSError:time.sleep(.1)
  catalogue=call('market.products',{});discovery=call('market.search',{'provider':'yahoo','query':'VXUS'});assert any(x['symbol']=='VXUS' for x in discovery['symbols']);assert len(catalogue['symbols'])>100
  results=[];end=int(time.time())//60*60
  for provider,symbol,tf,start in [('coinbase','BTC-USD','1m',end-660*60),('coinbase','ETH-USD','5m',end-100*300),('coinbase','SOL-USD','1H',end-48*3600),('yahoo','SPY','1D',end-30*86400),('yahoo','VOO','1D',end-30*86400),('yahoo','MSFT','1D',end-30*86400)]:
   r=call('market.history',dict(provider=provider,symbol=symbol,timeframe=tf,start=start,end=end));assert r['provenance']['realMarketData']and not r['provenance']['synthetic'];assert len(r['data']['bars'])>10;assert r['data']['bars']==sorted(r['data']['bars'],key=lambda b:b['time']);results.append({'provider':provider,'symbol':symbol,'bars':r['bars'],'pages':r['provenance']['pages'],'snapshot_id':r['snapshot_id'],'identity':r['identity'],'first':r['data']['bars'][0],'last':r['data']['bars'][-1]})
   version=call('strategy.createVersion',{'name':'Real network SMA','kind':'pine','source':'//@version=6\nstrategy("Real data")\nif ta.crossover(close,ta.sma(close,5))\n    strategy.entry("L",strategy.long)\nif ta.crossunder(close,ta.sma(close,5))\n    strategy.close("L")'})
   job=call('backtest.start',{'version_id':version['id'],'snapshot_id':r['snapshot_id']})
   for _ in range(600):
    state=call('backtest.status',{'job_id':job['job_id']})
    if state['status']not in ['queued','running']:break
    time.sleep(.05)
   assert state['status']=='succeeded',state
  subscriptions=[]
  for provider,symbol in [('coinbase','LTC-USD'),('yahoo','SPY')]:
   s=call('market.subscribe',{'provider':provider,'symbol':symbol,'timeframe':'1m'});id=s['subscription_id'];events=[]
   for _ in range(50):
    events=call('market.events',{'subscription_id':id})['events']
    if any(e['type']=='quote'for e in events):break
    time.sleep(1)
   subscriptions.append({'provider':provider,'symbol':symbol,'subscription_id':id,'types':sorted(set(e['type']for e in events)),'sample':next((e for e in events if e['type']=='quote'),None),'state':call('market.status',{'subscription_id':id})})
   call('market.stop',{'subscription_id':id})
  assert subscriptions[0]['sample'] is not None and subscriptions[0]['sample']['quality']['stale']==False
  print(json.dumps({'catalogueCount':len(catalogue['symbols']),'discovery':discovery,'history':results,'streams':subscriptions,'realCredentials':False,'orders':False},indent=2))
 finally:service.terminate();service.wait(5)
