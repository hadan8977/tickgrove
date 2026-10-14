import concurrent.futures
import json
import math
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(tempfile.mkdtemp(prefix='trading-supervision-'))
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    PORT = sock.getsockname()[1]
URL = f'http://127.0.0.1:{PORT}'
TOKEN = secrets.token_hex(24)
ENV = dict(PATH=os.environ.get('PATH','/usr/bin:/bin'), LANG='C.UTF-8', TRADING_ROOT=str(ROOT), TRADING_DATA_DIR=str(OUT / 'data'), TRADING_TOKEN=TOKEN, TRADING_BIND=f'127.0.0.1:{PORT}', TRADING_NODE=shutil.which('node'))
BIN = ROOT / 'server/target/debug/trading-service'
process = None
checks = []
log = (OUT / 'server.log').open('ab')

def request(method, params=None, key=None, token=TOKEN):
    payload = json.dumps({'method': method, 'params': params or {}, 'idempotency_key': key}).encode()
    headers = {'Content-Type': 'application/json'}
    if token is not None:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(URL + '/api/command', data=payload, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())

def command(method, params=None, key=None):
    status, body = request(method, params, key)
    assert status == 200, (method, status, body)
    return body

def start():
    global process
    process = subprocess.Popen([str(BIN)], cwd=ROOT, env=ENV, stdout=log, stderr=log)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError('Service exited: ' + (OUT / 'server.log').read_text()[-2000:])
        try:
            with urllib.request.urlopen(URL + '/health', timeout=.5) as r:
                if r.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(.1)
    raise AssertionError('Service did not become healthy')

def stop(hard=False):
    global process
    if process is not None and process.poll() is None:
        process.kill() if hard else process.terminate()
        process.wait(timeout=15)

def wait_job(job_id, states=('succeeded','failed','cancelled','timed_out','interrupted'), timeout=40):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r = command('backtest.status', {'job_id': job_id})
        if r['status'] in states:
            return r
        time.sleep(.08)
    raise AssertionError('Job wait timed out: ' + job_id)

def record(name, fn):
    try:
        detail = fn()
        checks.append({'check':name,'ok':True,'detail':detail})
    except Exception as error:
        checks.append({'check':name,'ok':False,'error':str(error)})
    print(json.dumps(checks[-1],ensure_ascii=False),flush=True)

try:
    start()
    def authentication():
        assert request('system.capabilities',token=None)[0] == 401
        assert request('system.capabilities',token='invalid')[0] == 401
        return command('system.capabilities')
    record('API authenticates before command execution',authentication)
    source = '''//@version=6
strategy("Supervision native ledger",initial_capital=10000,commission_type=strategy.commission.percent,commission_value=0.1)
if bar_index==1
    strategy.entry("L",strategy.long,qty=2)
if bar_index==4
    strategy.close("L")
'''
    version = command('strategy.createVersion',{'name':'Supervision','kind':'pine','source':source})
    bars = [dict(time=1700006400+i*86400,open=100+i,high=102+i,low=99+i,close=101+i,volume=1000) for i in range(8)]
    data = {'symbol':'LOCAL:SPY','timeframe':'D','bars':bars}
    snapshot = command('data.import',{'data':data})
    params = {'version_id':version['id'],'snapshot_id':snapshot['id'],'inputs':{}}
    def validation():
        assert request('backtest.start',dict(params,inputs=[]),'invalid-inputs')[0] >= 400
        bad = dict(data,bars=[bars[0],bars[0]])
        assert request('data.import',{'data':bad})[0] >= 400
        return 'non-object inputs and duplicate timestamps rejected'
    record('Invalid data and inputs are rejected',validation)

    job_id = None
    def idempotency():
        global job_id
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _:request('backtest.start',params,'concurrent-run'),range(6)))
        assert all(status == 200 for status,body in results), results
        ids = {body['job_id'] for status,body in results}
        assert len(ids) == 1, results
        job_id = ids.pop()
        status,body = request('backtest.start',dict(params,inputs={'changed':1}),'concurrent-run')
        assert status >= 400, body
        return {'oneJobForSixConcurrentCalls':True,'changedPayloadRejected':True}
    record('Concurrent idempotency binds the request body',idempotency)
    if not job_id:
        job_id = command('backtest.start',params,'fallback-native-check')['job_id']
    expected = None
    def native():
        global expected
        status = wait_job(job_id)
        assert status['status'] == 'succeeded', status
        report = command('backtest.results',{'job_id':job_id})
        ledger = report['result']['backtest']
        t = ledger['trades'][0]
        assert (t['entryBar'],t['exitBar'],t['qty']) == (2,5,2), t
        assert math.isclose(t['pnl'],5.586,abs_tol=1e-9), t
        assert math.isclose(ledger['equity'][-1]['value'],10005.586,abs_tol=1e-8),ledger['equity'][-1]
        expected = report
        return {'entryBar':2,'exitBar':5,'qty':2,'finalEquity':ledger['equity'][-1]['value']}
    record('API preserves the hand-calculated Pine ledger',native)
    def persistence():
        stop()
        start()
        after = command('backtest.results',{'job_id':job_id})
        assert after == expected, (after,expected)
        summary = command('backtest.status')
        assert all('result' not in row or row['result'] is None for row in summary), 'list returns full results'
        return 'report unchanged after restart; list contains summaries'
    record('Results survive a service restart',persistence)
    def instance_lock():
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0))
            other_port = sock.getsockname()[1]
        other = subprocess.run([str(BIN)],cwd=ROOT,env=dict(ENV,TRADING_BIND=f'127.0.0.1:{other_port}'),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
        assert other.returncode != 0, 'second instance acquired the same data directory'
        assert command('backtest.results',{'job_id':job_id}) == expected
        return 'second process rejected without modifying first process data'
    record('A second service cannot acquire an active data directory',instance_lock)

    slow = '//@version=6\nstrategy("Slow supervision")\nfloat x=0\nfor i=0 to 40000\n    x+=math.sqrt(i+1)\nplot(x)'
    slow_version = command('strategy.createVersion',{'name':'Slow supervision','kind':'pine','source':slow})
    many_bars = [dict(time=1700006400+i*86400,open=100+i,high=102+i,low=99+i,close=101+i,volume=1000) for i in range(400)]
    slow_snapshot = command('data.import',{'data':dict(data,bars=many_bars)})
    slow_params = {'version_id':slow_version['id'],'snapshot_id':slow_snapshot['id'],'inputs':{}}
    def cancellation():
        active = command('backtest.start',slow_params,'cancel-running')['job_id']
        wait_job(active,('running','failed','succeeded'))
        queued = command('backtest.start',params,'cancel-queued')['job_id']
        command('backtest.cancel',{'job_id':queued})
        command('backtest.cancel',{'job_id':active})
        a,b = wait_job(active),wait_job(queued)
        assert a['status'] == b['status'] == 'cancelled',(a,b)
        assert not command('backtest.results',{'job_id':active}).get('result')
        return 'running and queued cancellation leave no successful result'
    record('Cancellation handles running and queued jobs',cancellation)
    def interrupted():
        active = command('backtest.start',slow_params,'interrupt-running')['job_id']
        status = wait_job(active,('running','failed','succeeded'))
        assert status['status'] == 'running',status
        queued = command('backtest.start',params,'resume-queued')['job_id']
        stop(hard=True)
        start()
        a,b = wait_job(active),wait_job(queued)
        assert a['status'] == 'interrupted',a
        assert b['status'] == 'succeeded',b
        events = command('events.list')
        assert sum(e['kind']=='succeeded' and e['job_id']==queued for e in events)==1
        return 'running job interrupted; queued job resumes with one terminal success'
    record('Hard restart distinguishes interrupted and queued work',interrupted)
finally:
    stop()
    log.close()
    report = {'checks':checks,'passed':sum(c['ok'] for c in checks),'total':len(checks),'artifactDirectory':str(OUT)}
    (OUT/'report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
    print(json.dumps(report,ensure_ascii=False),flush=True)
