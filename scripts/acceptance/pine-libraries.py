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
  lib={'publisher':'local','name':'Tools','version':1,'source':'//@version=6\nlibrary("Tools")\nexport twice(float x)=>x*2','license':'fixture only'}
  created=call('pine.library.createVersion',lib);assert call('pine.library.createVersion',lib)['duplicate']
  try:call('pine.library.createVersion',{**lib,'source':lib['source']+'\n// changed'});raise AssertionError('mutable version accepted')
  except urllib.error.HTTPError as error:assert error.code==409,error.code
  assert call('pine.library.get',{'reference':'local/Tools/1'})['source']==lib['source']
  source='//@version=6\nindicator("Library test")\nimport local/Tools/1 as tools\nplot(tools.twice(close),"value")'
  locked=call('pine.resolve',{'source':source});assert locked['libraries'][0]['hash']==created['hash']
  version=call('strategy.createVersion',{'name':'library test','kind':'pine','source':source})['id']
  bars=[{'time':1700006400+i*86400,'open':i+1,'high':i+2,'low':i+.5,'close':i+1,'volume':10} for i in range(4)]
  snapshot=call('data.import',{'data':{'symbol':'SPY','timeframe':'1D','bars':bars}})['id']
  job=call('backtest.start',{'version_id':version,'snapshot_id':snapshot},str(uuid.uuid4()))
  assert job['manifest']['library_lock']['lockHash']==locked['lockHash']
  for _ in range(200):
   status=call('backtest.status',{'job_id':job['job_id']})
   if status['status'] in ['succeeded','failed']:break
   time.sleep(.1)
  assert status['status']=='succeeded',status
  result=call('backtest.results',{'job_id':job['job_id']})['result']
  assert result['plots'][0]['data']==[2,4,6,8],result
  print(json.dumps({'ok':True,'immutableConflict':409,'recursiveLocalLock':locked['lockHash'],'nativePlot':[2,4,6,8],'libraryHash':created['hash'],'manifestLock':job['manifest']['library_lock']},indent=2))
 finally:service.terminate();service.wait(10)
