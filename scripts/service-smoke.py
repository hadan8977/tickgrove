#!/usr/bin/env python3
"""Real service acceptance in a temporary database; no market credentials/network orders."""
import copy, json, os, pathlib, socket, subprocess, tempfile, time, urllib.request, uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
BIN=ROOT/'server/target/debug/trading-service'
def port():
    with socket.socket() as s: s.bind(('127.0.0.1',0)); return s.getsockname()[1]
def main():
    with tempfile.TemporaryDirectory(prefix='trading-smoke-') as directory:
        address=f'http://127.0.0.1:{port()}'; token=str(uuid.uuid4()); env={**os.environ,'TRADING_ROOT':str(ROOT),'TRADING_DATA_DIR':directory,'TRADING_BIND':address.removeprefix('http://'),'TRADING_TOKEN':token}
        service=None
        def start():
            nonlocal service
            service=subprocess.Popen([str(BIN)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            for _ in range(200):
                if service.poll() is not None: raise RuntimeError(service.stderr.read().decode())
                try: urllib.request.urlopen(address+'/health'); return
                except OSError: time.sleep(.05)
            raise RuntimeError('Service start deadline')
        def call(method,params=None,key=None):
            request=urllib.request.Request(address+'/api/command',data=json.dumps({'method':method,'params':params or {},'idempotency_key':key}).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
            try:
                with urllib.request.urlopen(request) as response: return json.load(response)
            except urllib.error.HTTPError as e: raise RuntimeError(e.read().decode())
        def wait(job):
            for _ in range(700):
                r=call('backtest.status',{'job_id':job})
                if r['status'] not in ['queued','running']:
                    assert r['status']=='succeeded',r
                    return call('backtest.results',{'job_id':job})
                time.sleep(.05)
            raise RuntimeError('Job deadline')
        def reopen():
            service.terminate();service.wait(5);start()
        start()
        try:
            full=json.loads((ROOT/'examples/composer/synthetic-etfs.json').read_text())
            data=copy.deepcopy(full);data['bars']=data['bars'][:64]
            for d in data['datasets']:d['bars']=d['bars'][:64]
            snapshot=call('data.import',{'data':data})['id']
            assert call('alpaca.config')['liveTrading'] is False
            source='//@version=6\nstrategy("Native continuous",initial_capital=10000,calc_on_every_tick=false)\nif bar_index==2\n    strategy.entry("L",strategy.long,qty=2)\nif bar_index==66\n    strategy.close("L")\nplot(ta.sma(close,10))'
            strategies=[('pine',source)] + [('composer',(ROOT/f'examples/composer/{name}.json').read_text()) for name in ['balanced','trend','momentum']]
            evidence=[]
            for kind,source in strategies:
                version=call('strategy.createVersion',{'name':kind,'kind':kind,'source':source})['id']
                session=call('paper.deploy',{'version_id':version,'snapshot_id':snapshot})
                baseline=wait(session['job_id']);assert baseline['result']['ok']
                prior=session['job_id']
                for index in range(64,69):
                    bars={full['symbol']:full['bars'][index],**{d['symbol']:d['bars'][index] for d in full['datasets']}}
                    p={'session_id':session['session_id'],'event_id':f'bar-{index}','bars':bars}
                    pending=call('paper.append',p);assert call('paper.append',p)['job_id']==pending['job_id']
                    result=wait(pending['job_id']);prior=pending['job_id']
                    if index==66:reopen()
                final=call('paper.list');current=next(s for s in final if s['session_id']==session['session_id']);assert current['last_job_id']==prior and current['pending_job_id'] is None
                batch=call('backtest.start',{'version_id':version,'snapshot_id':current['snapshot_id']},key=str(uuid.uuid4()))
                reference=wait(batch['job_id'])
                for field in ['backtest'] if kind=='pine' else ['frames','equity','metrics']:
                    assert result['result'][field]==reference['result'][field],(kind,field)
                evidence.append({'kind':kind,'session_id':session['session_id'],'appended_events':5,'restart':True,'native_batch_equals_continuous':True})
            plugins=call('plugins.list');assert len(plugins)>=3
            for plugin in plugins: call('plugins.enable',{'id':plugin['manifest']['id']})
            csv=call('plugins.call',{'id':'csv-data','input':{'symbol':'SPY','timeframe':'1D','csv':'time,open,high,low,close,volume\n1,10,10,10,10,1\n2,11,11,11,11,1'}});assert len(csv['data']['bars'])==2;call('data.import',{'data':csv['data']})
            indicator=call('plugins.call',{'id':'moving-average','input':{'period':2,'bars':csv['data']['bars']}});assert indicator['values'][-1]['value']==10.5
            summary=call('plugins.call',{'id':'equity-report','input':{'equity':[{'time':1,'value':100},{'time':2,'value':90}]}});assert abs(summary['report']['maxDrawdown']+.1)<1e-12
            cli=subprocess.run(['node','scripts/trading.cjs','system.capabilities'],cwd=ROOT,env={**env,'TRADING_URL':address},capture_output=True,text=True);assert cli.returncode==0,cli.stderr
            print(json.dumps({'ok':True,'continuous':evidence,'plugins':3,'cli':True},indent=2))
        finally:
            if service and service.poll() is None:service.terminate();service.wait(5)
if __name__=='__main__':main()
