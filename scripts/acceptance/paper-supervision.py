from pathlib import Path
exec(Path(__file__).with_name('supervision.py').read_text().split('\ntry:\n    start()')[0])

def session_state(id):
    return next(s for s in command('paper.list') if s['session_id']==id)

def make_source(extra=''):
    return '''//@version=6
strategy("Paper supervision",initial_capital=10000,commission_type=strategy.commission.percent,commission_value=0.1,calc_on_every_tick=false)
if bar_index==1
    strategy.entry("L",strategy.long,qty=2)
if bar_index==4
    strategy.close("L")
''' + extra

bars=[dict(time=1700006400+i*86400,open=100+i,high=102+i,low=99+i,close=101+i,volume=1000) for i in range(10)]
def deploy(source, n=4):
    version=command('strategy.createVersion',{'name':'Paper supervision','kind':'pine','source':source})
    snapshot=command('data.import',{'data':{'symbol':'LOCAL:SPY','timeframe':'D','bars':bars[:n]}})
    s=command('paper.deploy',{'version_id':version['id'],'snapshot_id':snapshot['id'],'inputs':{}})
    return s,snapshot

try:
    start()
    def initialize_cancel_retry():
        s,snap=deploy(make_source())
        command('backtest.cancel',{'job_id':s['job_id']})
        cancelled=wait_job(s['job_id'])
        assert cancelled['status']=='cancelled',cancelled
        state=session_state(s['session_id'])
        assert state.get('last_job_id') is None and state['pending_job_id']==s['job_id'],state
        retried=command('paper.retry',{'session_id':s['session_id']})
        assert wait_job(retried['job_id'])['status']=='succeeded'
        state=session_state(s['session_id'])
        assert state['status']=='active' and state['last_job_id']==s['job_id'] and state['pending_job_id'] is None,state
        return 'initial cancellation leaves no committed ledger; explicit retry initializes once'
    record('Initial paper job can cancel and retry',initialize_cancel_retry)

    def append_and_restart():
        s,snap=deploy(make_source())
        assert wait_job(s['job_id'])['status']=='succeeded'
        params={'session_id':s['session_id'],'event_id':'bar-4','bars':{'LOCAL:SPY':bars[4]}}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            responses=list(pool.map(lambda _:command('paper.append',params),range(2)))
        assert len({r['job_id'] for r in responses})==1,responses
        first=responses[0]
        assert wait_job(first['job_id'])['status']=='succeeded'
        assert request('paper.append',dict(params,bars={'LOCAL:SPY':dict(bars[4],volume=2)}))[0]>=400
        state_before=session_state(s['session_id'])
        stop(hard=True)
        start()
        assert session_state(s['session_id'])==state_before
        second=command('paper.append',{'session_id':s['session_id'],'event_id':'bar-5','bars':{'LOCAL:SPY':bars[5]}})
        assert wait_job(second['job_id'])['status']=='succeeded'
        ledger=command('backtest.results',{'job_id':second['job_id']})['result']['backtest']
        assert len(ledger['trades'])==1 and ledger['trades'][0]['qty']==2,ledger['trades']
        assert math.isclose(ledger['equity'][-1]['value'],10005.586,abs_tol=1e-8)
        return {'duplicateAppendOneJob':True,'restartThenExitQty':2,'finalEquity':ledger['equity'][-1]['value']}
    record('Closed-bar append is idempotent and resumes after restart',append_and_restart)

    def rollback():
        extra='if bar_index==4 and volume>1000\n    runtime.error("invalid event for this strategy")\n'
        s,snap=deploy(make_source(extra))
        assert wait_job(s['job_id'])['status']=='succeeded'
        bad=command('paper.append',{'session_id':s['session_id'],'event_id':'bad-4','bars':{'LOCAL:SPY':dict(bars[4],volume=2000)}})
        assert wait_job(bad['job_id'])['status']=='failed'
        state=session_state(s['session_id'])
        assert state['snapshot_id']==snap['id'] and state['last_job_id']==s['job_id'],state
        retried=command('paper.retry',{'session_id':s['session_id']})
        assert wait_job(retried['job_id'])['status']=='failed'
        command('paper.discard',{'session_id':s['session_id']})
        corrected=command('paper.append',{'session_id':s['session_id'],'event_id':'corrected-4','bars':{'LOCAL:SPY':bars[4]}})
        assert wait_job(corrected['job_id'])['status']=='succeeded'
        state=session_state(s['session_id'])
        assert state['snapshot_id']==corrected['snapshot_id'] and state['pending_job_id'] is None,state
        return 'failed/retried append never advanced committed snapshot; corrected new event succeeds'
    record('A failed market event preserves the committed account',rollback)

    def identity():
        source='//@version=6\nstrategy("Identity",initial_capital=10000)\nvar string id=str.tostring(last_bar_index)\nif bar_index==1\n    strategy.entry(id,strategy.long,qty=2)\nif bar_index==4\n    strategy.close(id)'
        s,snap=deploy(source,8)
        initial=wait_job(s['job_id'])
        if initial['status']=='failed':
            return {'repaintingRejectedAtInitialization':initial.get('error')}
        assert initial['status']=='succeeded',initial
        event=command('paper.append',{'session_id':s['session_id'],'event_id':'identity-8','bars':{'LOCAL:SPY':bars[8]}})
        failed=wait_job(event['job_id'])
        assert failed['status']=='failed',failed
        state=session_state(s['session_id'])
        assert state['snapshot_id']==snap['id'] and state['last_job_id']==s['job_id'],state
        return {'sameEquityButChangedEntryIdRejected':True,'error':failed.get('error')}
    record('Trade identity rewrites are rejected even when equity is unchanged',identity)
finally:
    stop()
    log.close()
    report={'checks':checks,'passed':sum(c['ok'] for c in checks),'total':len(checks),'artifactDirectory':str(OUT)}
    (OUT/'report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
    print(json.dumps(report,ensure_ascii=False),flush=True)
