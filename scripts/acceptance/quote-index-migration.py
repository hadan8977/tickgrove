"""Fresh Rust startup proves migration 21 is embedded, not merely present on disk."""
import json,os,pathlib,socket,sqlite3,subprocess,tempfile,time,urllib.request,uuid
ROOT=pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='quote-index-migration-') as directory:
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 env={k:v for k,v in os.environ.items() if not k.startswith('ALPACA_')};env.update(TRADING_ROOT=str(ROOT),TRADING_DATA_DIR=directory,TRADING_BIND=f'127.0.0.1:{port}',TRADING_TOKEN=str(uuid.uuid4()))
 child=subprocess.Popen([str(ROOT/'server/target/debug/trading-service')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 try:
  for _ in range(200):
   try:urllib.request.urlopen(f'http://127.0.0.1:{port}/health');break
   except OSError:time.sleep(.05)
  with sqlite3.connect('file:'+directory+'/trading.sqlite?mode=ro',uri=True) as db:
   migrations=db.execute('SELECT version,success FROM _sqlx_migrations ORDER BY version').fetchall();assert migrations[-1]==(21,1),migrations
   indexes=db.execute("SELECT name,sql FROM sqlite_master WHERE type='index' AND name IN ('market_quote_event_time','market_quote_received_at') ORDER BY name").fetchall();assert len(indexes)==2 and all("WHERE type='quote'" in row[1] for row in indexes),indexes
  print(json.dumps(dict(ok=True,freshRustStartup=True,embeddedMigrationVersion=21,indexes=indexes,noMarketSubscriptions=True),indent=2))
 finally:child.terminate();child.wait(15)
