"""Host permission/namespace/resource tests against actual isolated service."""
import json,os,pathlib,shutil,socket,subprocess,tempfile,time,urllib.request,urllib.error,uuid
ROOT=pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='trading-sandbox-') as directory:
    root=pathlib.Path(directory)/'app';root.mkdir();extensions=root/'extensions';extensions.mkdir()
    for name in ['src','scripts','node_modules','dist']: (root/name).symlink_to(ROOT/name,target_is_directory=True)
    secret=pathlib.Path(directory)/'host-secret';secret.write_text('must-never-be-readable')
    def plugin(name,code,permissions=['input.read']):
        folder=extensions/name;folder.mkdir();(folder/'plugin.json').write_text(json.dumps({'id':name,'version':'0.1.0','api_version':'trading.plugin.v1','entrypoint':'index.cjs','contributes':['test'],'permissions':permissions}));(folder/'index.cjs').write_text(code);return folder
    plugin('bound-output','''const {once}=require('events');(async()=>{while(true){if(!process.stdout.write('x'.repeat(65536)))await once(process.stdout,'drain')}})()''' )
    plugin('deadline','while(true){}')
    folder=plugin('isolation',r'''const fs=require('fs'),net=require('net');let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{const p=JSON.parse(text);const out={ok:true};try{fs.readFileSync(p.secretPath);out.hostRead=true}catch{out.hostRead=false}try{fs.readFileSync('/plugin/escape');out.symlinkRead=true}catch{out.symlinkRead=false}try{fs.writeFileSync('/plugin/host-write','x');out.hostWrite=true}catch{out.hostWrite=false}out.secretEnvironment=!!process.env.ALPACA_API_SECRET;const connection=net.connect({host:'127.0.0.1',port:p.port});connection.on('connect',()=>{out.hostNetwork=true;connection.destroy();process.stdout.write(JSON.stringify(out))});connection.on('error',()=>{out.hostNetwork=false;process.stdout.write(JSON.stringify(out))});});''')
    (folder/'escape').symlink_to(secret)
    plugin('denied-permission','process.stdout.write("{}")',['broker.paper'])
    hostSocket=socket.socket();hostSocket.bind(('127.0.0.1',0));hostSocket.listen();hostPort=hostSocket.getsockname()[1]
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    owner=str(uuid.uuid4());reader=str(uuid.uuid4());tokens=pathlib.Path(directory)/'tokens.json';tokens.write_text(json.dumps([{'token':owner,'permissions':['read','plugins.manage','strategy.write']},{'token':reader,'permissions':['read']}]))
    env={**os.environ,'TRADING_ROOT':str(root),'TRADING_DATA_DIR':str(pathlib.Path(directory)/'data'),'TRADING_BIND':f'127.0.0.1:{port}','TRADING_TOKEN':owner,'TRADING_TOKENS_FILE':str(tokens),'ALPACA_API_SECRET':'test-only-not-real'};url=f'http://127.0.0.1:{port}'
    service=subprocess.Popen([str(ROOT/'server/target/debug/trading-service')],env=env,stderr=subprocess.DEVNULL)
    def call(method,params=None,token=owner):
        request=urllib.request.Request(url+'/api/command',data=json.dumps({'method':method,'params':params or {}}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
        try:
            with urllib.request.urlopen(request) as response:return response.status,json.load(response)
        except urllib.error.HTTPError as e:return e.code,json.load(e)
    try:
        for _ in range(100):
            try:urllib.request.urlopen(url+'/health');break
            except OSError:time.sleep(.1)
        assert call('system.capabilities',token=reader)[0]==200
        assert call('plugins.enable',{'id':'isolation'},reader)[0]==403
        tokens.write_text(json.dumps([{'token':owner,'permissions':['read','plugins.manage','strategy.write']}]))
        assert call('system.capabilities',token=reader)[0]==401
        assert call('plugins.validate',{'id':'denied-permission'})[0]==400
        for name in ['isolation','bound-output','deadline']:assert call('plugins.enable',{'id':name})[0]==200
        status,value=call('plugins.call',{'id':'isolation','input':{'secretPath':str(secret),'port':hostPort}});assert status==200,value
        assert not any(value[key] for key in ['hostRead','symlinkRead','hostWrite','secretEnvironment','hostNetwork']),value
        start=time.monotonic();status,value=call('plugins.call',{'id':'bound-output','input':{}});outputSeconds=time.monotonic()-start;assert status==400 and 'output limit' in value['error'],value
        start=time.monotonic();status,value=call('plugins.call',{'id':'deadline','input':{}});timeoutSeconds=time.monotonic()-start;assert status==400 and 'timed_out' in value['error'],value;assert timeoutSeconds<7
        print(json.dumps({'ok':True,'scopedAuthorization':True,'revocation':True,'undeclaredPermissionDenied':True,'namespace':value if False else {'hostRead':False,'symlinkRead':False,'hostWrite':False,'secretEnvironment':False,'hostNetwork':False},'outputLimitSeconds':round(outputSeconds,3),'timeoutSeconds':round(timeoutSeconds,3)},indent=2))
    finally:service.terminate();service.wait(5);hostSocket.close()
