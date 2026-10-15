#!/usr/bin/env python3
"""Isolated, offline release regressions. No account/provider credentials or preview state."""
import asyncio, datetime, hashlib, json, os, pathlib, socket, sqlite3, subprocess, tempfile, threading, time, urllib.error, urllib.request, uuid
import websockets  # Same optional fixture dependency as the other market acceptance scripts.

ROOT = pathlib.Path(__file__).resolve().parents[2]
BINARY = pathlib.Path(os.environ.get('TICKGROVE_TEST_SERVER', ROOT / 'server/target/debug/tickgrove-server'))
REPORT = pathlib.Path(os.environ.get('TICKGROVE_RELIABILITY_REPORT', ROOT / 'docs/acceptance/reliability-current.json'))

# Real local WebSocket transport/acknowledgements keep source state honest. The
# deterministic bars below test durable host delivery, not exchange decoding.
loop=asyncio.new_event_loop(); ready=threading.Event()
async def websocket_fixture(socket):
    try:
        await socket.recv()
        await socket.send(json.dumps({'type':'subscriptions','channels':[{'name':'heartbeat','product_ids':['TEST-USD']}]}))
        while True:
            await socket.send(json.dumps({'type':'heartbeat','product_id':'TEST-USD','last_trade_id':0,
                'time':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')}))
            await asyncio.sleep(.5)
    except websockets.ConnectionClosed:
        pass
async def serve_fixture():
    server=await websockets.serve(websocket_fixture,'127.0.0.1',0)
    globals()['fixture_port']=server.sockets[0].getsockname()[1]; ready.set()
    await asyncio.Future()
def fixture_thread():
    asyncio.set_event_loop(loop);loop.run_until_complete(serve_fixture())
threading.Thread(target=fixture_thread,daemon=True).start();ready.wait()

with tempfile.TemporaryDirectory(prefix='tickgrove-reliability-') as directory:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    token = str(uuid.uuid4()); url = f'http://127.0.0.1:{port}'; process = None
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ALPACA_', 'TRADING_', 'TICKGROVE_'))}
    env.update(TRADING_ROOT=str(ROOT), TRADING_DATA_DIR=directory, TRADING_BIND=f'127.0.0.1:{port}', TRADING_TOKEN=token,
               TRADING_COINBASE_WS_MOCK=f'ws://127.0.0.1:{fixture_port}', HTTPS_PROXY='http://127.0.0.1:1',
               HTTP_PROXY='http://127.0.0.1:1', ALL_PROXY='http://127.0.0.1:1', NO_PROXY='127.0.0.1,localhost')
    database = directory + '/trading.sqlite'
    def start():
        global process
        process = subprocess.Popen([str(BINARY)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(200):
            try: urllib.request.urlopen(url + '/health'); return
            except OSError: time.sleep(.025)
        raise RuntimeError('Test server startup timeout')
    def stop():
        process.terminate(); process.wait(10)
    def call(method, params=None, expect_error=False):
        request = urllib.request.Request(url + '/api/command', data=json.dumps({'method': method, 'params': params or {}}).encode(),
                                         headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
        try:
            with urllib.request.urlopen(request, timeout=30) as response: result = json.load(response)
        except urllib.error.HTTPError as error:
            result = json.load(error)
            if expect_error: return result
            raise AssertionError((method, result))
        assert not expect_error, (method, 'Unexpected success', result)
        return result
    def wait(check):
        for _ in range(400):
            result = check()
            if result: return result
            time.sleep(.04)
        raise AssertionError('Fixture operation did not settle')
    def host_state(sid, predicate):
        def check():
            value = call('pine.host.status', {'session_id': sid})
            assert value['status'] != 'failed', value
            return value if predicate(value) else None
        return wait(check)
    def sql(statement, values=()):
        with sqlite3.connect(database) as db:
            result = db.execute(statement, values)
            return result.fetchall()
    def market_event(bar, kind='bar.update'):
        now = int(time.time() * 1000)
        sql("INSERT INTO market_events(subscription_id,type,event_time,received_at,payload,quality) VALUES('fixture',?,?,?,?,?)",
            (kind, now, now, json.dumps(bar), json.dumps({'complete': True, 'stale': False})))
    def deploy(source, mode='indicator'):
        version = call('strategy.createVersion', {'name': 'Reliability fixture', 'kind': 'pine', 'source': source})
        sid = call('pine.host.deploy', {'version_id': version['id'], 'snapshot_id': snapshot['id'], 'subscription_id': 'fixture',
                                        'execution': mode, 'startingCash': 1000})['session_id']
        host_state(sid, lambda state: state['status'] == 'active')
        return sid
    checks = []
    try:
        start(); stop()
        t = int(time.time()) // 60 * 60 - 60
        identity = dict(provider='coinbase', symbol='TEST-USD', symbolId='COINBASE:TEST-USD', venue='COINBASE', currency='USD',
                        assetClass='crypto', timeframe='1m', timezone='UTC', session='24x7', adjustment='none', feed='public-websocket',
                        executionEligible=True, quoteKind='executable', delay={'kind': 'realtime'}, testFixture=True)
        bar = dict(time=t + 60, closeTime=t + 120, open=10, high=10, low=10, close=10, volume=1)
        sql("INSERT INTO market_subscriptions(id,provider,symbol,timeframe,identity,status,feed) VALUES('fixture','coinbase','TEST-USD','1m',?,'connecting','public-websocket')", (json.dumps(identity),))
        sql("INSERT INTO market_bars(subscription_id,time,payload,closed,quality) VALUES('fixture',?,?,0,?)", (bar['time'], json.dumps(bar), json.dumps({'complete': True})))
        start()
        data = dict(symbol='TEST-USD', timeframe='1m', metadata=dict(identity=identity, provenance=dict(synthetic=True, testFixture=True, gaps=[]), timezone='UTC', currency='USD'), bars=[dict(bar, time=t, closeTime=t + 60)])
        snapshot = call('data.import', {'data': data})
        alert = call('alerts.create', {'provider': 'coinbase', 'symbol': 'TEST-USD', 'timeframe': '1m', 'kind': 'cross', 'price': 100, 'frequency': 'once'})
        stop()
        for index, price in enumerate([99, 101, 99]):
            stamp = int(time.time() * 1000) + index
            sql("INSERT INTO market_events(subscription_id,type,event_time,received_at,payload,quality) VALUES('fixture','quote',?,?,?,'{\"complete\":true,\"stale\":false}')", (stamp, stamp, json.dumps({'price': price})))
        start()
        history = wait(lambda: call('alerts.history') or None)
        assert len(history) == 1 and history[0]['alertId'] == alert['id'] and history[0]['price'] == 101, history
        stop(); start(); assert len(call('alerts.history')) == 1
        checks.append('Persisted quote cross catches up after restart exactly once')

        sid = deploy('//@version=6\nindicator("Alert frequencies")\nif barstate.isrealtime\n    alert("all",alert.freq_all)\n    alert("once",alert.freq_once_per_bar)\n    alert("close",alert.freq_once_per_bar_close)')
        for index, kind in enumerate(['bar.update', 'bar.update', 'bar.closed']):
            market_event(bar, kind)
            expected = [2, 3, 5][index]
            wait(lambda: len([a for a in call('alerts.strategyHistory') if a['session_id'] == sid]) == expected)
        history = [a for a in call('alerts.strategyHistory') if a['session_id'] == sid]
        counts = {name: sum(a['alert']['message'] == name for a in history) for name in ['all', 'once', 'close']}
        assert counts == {'all': 3, 'once': 1, 'close': 1}, counts
        assert all(a['context']['version_id'] and a['context']['event_id'] for a in history)
        stop(); start(); host_state(sid, lambda state: state['status'] == 'active')
        assert len([a for a in call('alerts.strategyHistory') if a['session_id'] == sid]) == 5
        call('pine.host.stop', {'session_id': sid})
        checks.append('Realtime Pine alerts persist all/per-bar/per-close occurrences and do not duplicate on replay')

        entry = '//@version=6\nstrategy("External fixture",calc_on_every_tick=true)\nif barstate.isrealtime and strategy.position_size==0\n    strategy.entry("L",strategy.long,qty=2)'
        sid = deploy(entry, 'external_broker'); market_event(bar)
        host_state(sid, lambda state: bool((state.get('result') or {}).get('pendingOrders')))
        fill = dict(id='part-1', orderId='L', side='buy', qty=1, price=10, fee=.01, time=(t + 61) * 1000, barIndex=1)
        error = call('pine.host.feedback', {'session_id': sid, 'fill': dict(fill, side='sell')}, expect_error=True)
        assert 'side' in error['error'], error
        healthy = call('pine.host.render', {'session_id': sid})
        assert healthy['account']['positionSize'] == 0 and healthy['pendingOrders'][0]['qty'] == 2
        call('pine.host.feedback', {'session_id': sid, 'fill': fill})
        assert call('pine.host.feedback', {'session_id': sid, 'fill': fill})['duplicate']
        filled = call('pine.host.feedback', {'session_id': sid, 'fill': dict(fill, id='part-2', time=fill['time'] + 1)})
        assert filled['result']['account']['positionSize'] == 2 and not filled['result']['pendingOrders']
        stop(); start(); host_state(sid, lambda state: (state.get('result') or {}).get('account', {}).get('positionSize') == 2)
        call('pine.host.stop', {'session_id': sid})
        checks.append('Wrong-side external feedback rejects nonterminally; valid partials, duplicate ID and journal replay preserve position')

        sid = deploy(entry, 'local_broker'); market_event(bar)
        wait(lambda: len(call('account.state')['orders']) == 1)
        wait(lambda: sql("SELECT COUNT(*) FROM pine_host_dispatch WHERE session_id=? AND status='done'", (sid,))[0][0] == 1)
        stop()
        # Emulate death after local order persistence but before binding/outbox acknowledgement.
        sql('DELETE FROM pine_host_orders WHERE session_id=?', (sid,))
        sql("UPDATE pine_host_intents SET status='pending' WHERE session_id=?", (sid,))
        sql("UPDATE pine_host_dispatch SET status='pending' WHERE session_id=?", (sid,))
        start()
        wait(lambda: sql("SELECT COUNT(*) FROM pine_host_dispatch WHERE session_id=? AND status='done'", (sid,))[0][0] == 1)
        assert len(call('account.state')['orders']) == 1
        assert sql('SELECT COUNT(*) FROM pine_host_orders WHERE session_id=?', (sid,))[0][0] == 1
        checks.append('Committed outbox recovers lost local-order binding/acknowledgement without another market event or duplicate order')
        market_event({'reason':'Fixture REST repair unavailable','tickContinuityLost':False}, 'gap')
        gap_cursor=sql("SELECT MAX(cursor) FROM market_events WHERE type='gap'")[0][0]
        host_state(sid, lambda state: state['marketCursor'] >= gap_cursor)
        assert call('pine.host.status', {'session_id':sid})['status']=='active'
        market_event({'reason':'Fixture lost upstream trade ticks','tickContinuityLost':True}, 'gap')
        wait(lambda: call('pine.host.status', {'session_id':sid})['status']=='failed')
        wait(lambda: call('account.state')['orders'][0]['status']=='canceled')
        checks.append('REST-only repair failure preserves host; explicit lost-tick event freezes execution and cancels outstanding order')
    finally:
        if process is not None and process.poll() is None: stop()

files = ['server/src/account.rs', 'server/src/alerts.rs', 'server/src/pine_host.rs', 'scripts/pine-host-worker.cjs', 'src/pine/host.ts', 'src/pine/broker.ts', 'src/pine/intent.ts']
report = dict(at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), ok=True, fixtureOnly=True, externalNetworkDisabled=True,
              realAccountsUsed=False, previewWrites=False, checks=checks, binarySha256=hashlib.sha256(BINARY.read_bytes()).hexdigest(),
              sourceHashes={name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files},
              limitations=['Synthetic deterministic fixtures; no external brokerage/data entitlement acceptance', 'Transaction fault injection and unsupported-order cases also run in Rust/Node unit tests'])
REPORT.parent.mkdir(parents=True, exist_ok=True); REPORT.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
