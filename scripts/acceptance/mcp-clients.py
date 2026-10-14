"""Start isolated actual service and verify two official stdio SDK clients."""
import json,os,pathlib,socket,subprocess,tempfile,time,urllib.request,uuid
ROOT=pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='trading-mcp-') as directory:
    with socket.socket() as sock: sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    token=str(uuid.uuid4());url=f'http://127.0.0.1:{port}';env={**os.environ,'TRADING_ROOT':str(ROOT),'TRADING_DATA_DIR':directory,'TRADING_TOKEN':token,'TRADING_BIND':f'127.0.0.1:{port}','TRADING_URL':url}
    service=subprocess.Popen([str(ROOT/'server/target/debug/trading-service')],env=env,stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:urllib.request.urlopen(url+'/health');break
            except OSError:time.sleep(.1)
        outcomes=[]
        for command in [['node','tests/mcp-clients/client.mjs'],[os.environ.get('TRADING_MCP_PYTHON','/tmp/trading-mcp-verify/bin/python'),'tests/mcp-clients/client.py']]:
            result=subprocess.run(command,cwd=ROOT,env=env,capture_output=True,text=True,timeout=30)
            if result.returncode:raise RuntimeError(result.stderr+result.stdout)
            outcomes.append(json.loads(result.stdout))
        print(json.dumps({'ok':True,'clients':outcomes},indent=2))
    finally:service.terminate();service.wait(5)
