"""Provider/session contract acceptance using explicit cached identity fixtures, no keys."""
import json,os,pathlib,socket,sqlite3,subprocess,tempfile,time,urllib.request,urllib.error,uuid
ROOT=pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='market-session-contract-') as directory:
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 token=str(uuid.uuid4());env={k:v for k,v in os.environ.items() if not k.startswith('ALPACA_')};env.update(TRADING_ROOT=str(ROOT),TRADING_DATA_DIR=directory,TRADING_BIND=f'127.0.0.1:{port}',TRADING_TOKEN=token,HTTP_PROXY='http://127.0.0.1:1',HTTPS_PROXY='http://127.0.0.1:1',NO_PROXY='localhost,127.0.0.1');url=f'http://127.0.0.1:{port}'
 def start():
  child=subprocess.Popen([str(ROOT/'server/target/debug/trading-service')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  for _ in range(200):
   try:urllib.request.urlopen(url+'/health');return child
   except OSError:time.sleep(.05)
  raise RuntimeError('startup timeout')
 def call(method,params):
  req=urllib.request.Request(url+'/api/command',data=json.dumps({'method':method,'params':params}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
  try:
   with urllib.request.urlopen(req,timeout=30) as result:return result.status,json.load(result)
  except urllib.error.HTTPError as error:return error.code,json.load(error)
 child=start();child.terminate();child.wait(15)
 cases=[('coinbase','TEST-USD','public-websocket','24x7','regular'),('yahoo','TEST','public-pricing-websocket','regular','24x7'),('yahoo','TEST','public-pricing-websocket','extended','overnight'),('alpaca','TEST','iex','regular','overnight'),('alpaca','TEST','overnight','overnight','regular')]
 with sqlite3.connect(directory+'/trading.sqlite') as db:
  for index,(provider,symbol,feed,session,bad) in enumerate(cases):
   identity=dict(provider=provider,symbol=symbol,feed=feed,session=session,timeframe='1m',testFixture=True)
   db.execute("INSERT INTO market_subscriptions(id,provider,symbol,timeframe,identity,status,feed) VALUES(?,?,?,'1m',?,'connecting',?)",(str(index),provider,symbol,json.dumps(identity),feed))
 child=start()
 try:
  results=[]
  for index,(provider,symbol,feed,session,bad) in enumerate(cases):
   params=dict(provider=provider,symbol=symbol,feed=feed,timeframe='1m',session=session)
   status,value=call('market.subscribe',params);assert status==200 and value['subscription_id']==str(index),(status,value)
   status,error=call('market.subscribe',{**params,'session':bad});assert status==400 and 'Unsupported provider/session' in error['error'],error
   status,error=call('market.history',{**params,'session':bad,'start':1000000000,'end':1000000600});assert status==400 and 'Unsupported provider/session' in error['error'],error
   results.append(dict(provider=provider,feed=feed,session=session,roundtrip=True,mismatchedSubscriptionRejected=True,mismatchedHistoryRejected=True))
  print(json.dumps(dict(ok=True,fixtureOnly=True,cases=results),indent=2))
 finally:child.terminate();child.wait(15)
