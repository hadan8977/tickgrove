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
  end=int(time.time())
  primary=call('market.history',{'provider':'yahoo','symbol':'SPY','timeframe':'1D','start':end-30*86400,'end':end})
  source='//@version=6\nindicator("Cross venue")\nother=request.security("NASDAQ:QQQ","D",close)\nplot(other,"value")'
  inspection=call('pine.inspectRequests',{'source':source});assert inspection['requests'][0]['symbol']=='NASDAQ:QQQ'
  version=call('strategy.createVersion',{'name':'Cross venue','kind':'pine','source':source})['id']
  job=call('backtest.start',{'version_id':version,'snapshot_id':primary['snapshot_id']},str(uuid.uuid4()))
  assert job['manifest']['snapshot_id']!=primary['snapshot_id']
  prepared=call('data.get',{'snapshot_id':job['manifest']['snapshot_id']})
  data=prepared.get('data',prepared)
  dataset=data['datasets'][0];assert dataset['symbol']=='NASDAQ:QQQ' and dataset['metadata']['identity']['provider']=='yahoo'
  for _ in range(200):
   status=call('backtest.status',{'job_id':job['job_id']})
   if status['status'] in ['succeeded','failed']:break
   time.sleep(.1)
  assert status['status']=='succeeded',status
  result=call('backtest.results',{'job_id':job['job_id']})['result']
  assert result['plots'][0]['data'][-1]==dataset['bars'][-1]['close'],result
  print(json.dumps({'ok':True,'realNetwork':True,'inspection':inspection,'primarySnapshot':primary['snapshot_id'],'preparedSnapshot':job['manifest']['snapshot_id'],'targetIdentity':dataset['metadata']['identity'],'lastValue':result['plots'][0]['data'][-1],'frozenSources':data['metadata']['provenance']['requestSources']},indent=2))
 finally:service.terminate();service.wait(10)
