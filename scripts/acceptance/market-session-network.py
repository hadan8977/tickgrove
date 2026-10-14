#!/usr/bin/env python3
"""Public Yahoo real intraday/extended history probes; never submits orders."""
import datetime,json,os,pathlib,socket,subprocess,tempfile,time,urllib.request,urllib.error,uuid
ROOT=pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='market-session-probe-') as d:
 with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 token=str(uuid.uuid4());env={k:v for k,v in os.environ.items() if not k.startswith('ALPACA_')};env.update(TRADING_ROOT=str(ROOT),TRADING_BIND=f'127.0.0.1:{port}',TRADING_DATA_DIR=d,TRADING_TOKEN=token);child=subprocess.Popen([str(ROOT/'server/target/debug/trading-service')],env=env,stderr=subprocess.DEVNULL)
 def call(method,params):
  req=urllib.request.Request(f'http://127.0.0.1:{port}/api/command',data=json.dumps({'method':method,'params':params}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
  try:
   with urllib.request.urlopen(req,timeout=90) as r:return json.load(r)
  except urllib.error.HTTPError as e:raise RuntimeError(e.read().decode())
 try:
  for _ in range(100):
   try:urllib.request.urlopen(f'http://127.0.0.1:{port}/health');break
   except OSError:time.sleep(.1)
  start=int(datetime.datetime.fromisoformat('2026-10-05T04:00:00-04:00').timestamp());end=int(datetime.datetime.fromisoformat('2026-10-09T20:00:00-04:00').timestamp());cases=[]
  for session in ['regular','extended']:
   for tf in ['5m','1H','4H','1D','1W']:
    try:
     v=call('market.history',{'provider':'yahoo','symbol':'SPY','timeframe':tf,'session':session,'start':start,'end':end,'allowGaps':True});assert v['identity']['session']==session;assert all(b['closeTime']<=end for b in v['data']['bars']);cases.append({'session':session,'timeframe':tf,'ok':True,'bars':v['bars'],'hash':v['hash'],'first':v['data']['bars'][0],'last':v['data']['bars'][-1],'gaps':v['gaps'],'complete':not bool(v['gaps'])})
    except Exception as e:cases.append({'session':session,'timeframe':tf,'ok':False,'error':str(e)})
  try:
   v=call('market.history',{'provider':'yahoo','symbol':'VOO','timeframe':'1m','session':'regular','adjustment':'raw','start':1791774302,'end':1791947102,'allowGaps':True});cases.append({'symbol':'VOO','session':'regular','timeframe':'1m-unaligned-regression','ok':True,'bars':v['bars'],'excluded':v['provenance']['trimmedPartialPeriods'],'gaps':v['gaps']})
  except Exception as e:cases.append({'symbol':'VOO','timeframe':'1m-unaligned-regression','ok':False,'error':str(e)})
  print(json.dumps({'realNetwork':True,'credentials':False,'cases':cases},indent=2))
 finally:child.terminate();child.wait(10)
