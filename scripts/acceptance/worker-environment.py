"""Missing runtime file must terminally fail an already queued job, never hang running."""
import json,os,pathlib,socket,sqlite3,subprocess,tempfile,time,urllib.request,uuid
ROOT=pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='trading-worker-env-') as directory:
    root=pathlib.Path(directory)/'runtime';(root/'scripts').mkdir(parents=True);(root/'src/pine').mkdir(parents=True)
    for name in ['runtime.ts','data.ts','compat.ts']:(root/'src/pine'/name).write_text('// fixture')
    (root/'scripts/service-worker.cjs').write_text('// fixture')
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    token=str(uuid.uuid4());data=pathlib.Path(directory)/'data';env={**os.environ,'TRADING_ROOT':str(root),'TRADING_DATA_DIR':str(data),'TRADING_TOKEN':token,'TRADING_BIND':f'127.0.0.1:{port}'};url=f'http://127.0.0.1:{port}'
    service=subprocess.Popen([str(ROOT/'server/target/debug/trading-service')],env=env,stderr=subprocess.DEVNULL)
    def call(method,params):
        request=urllib.request.Request(url+'/api/command',data=json.dumps({'method':method,'params':params}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
        with urllib.request.urlopen(request) as response:return json.load(response)
    try:
        for _ in range(100):
            try:urllib.request.urlopen(url+'/health');break
            except OSError:time.sleep(.1)
        version=call('strategy.createVersion',{'name':'missing-runtime','kind':'pine','source':'//@version=6\nstrategy("fixture")'})['id']
        snapshot=call('data.import',{'data':{'symbol':'SPY','timeframe':'D','bars':[{'time':1,'open':10,'high':10,'low':10,'close':10,'volume':1}]}})['id']
        id=str(uuid.uuid4())
        # Insert a pre-existing queued row to simulate a runtime file disappearing after creation.
        with sqlite3.connect(data/'trading.sqlite') as db:db.execute("INSERT INTO jobs(id,version_id,snapshot_id,manifest,status) VALUES(?,?,?,?,'queued')",(id,version,snapshot,json.dumps({'adapter_hash':'old-test-hash','inputs':{}})))
        for _ in range(100):
            result=call('backtest.status',{'job_id':id})
            if result['status']=='failed':break
            time.sleep(.05)
        assert result['status']=='failed' and 'Worker adapter unavailable' in result['error'] and result['result'] is None,result
        events=call('events.list',{});assert any(e['job_id']==id and e['kind']=='failed' for e in events)
        print(json.dumps({'ok':True,'missingAdapterTerminal':'failed','result':None,'terminalEvent':True},indent=2))
    finally:service.terminate();service.wait(5)
