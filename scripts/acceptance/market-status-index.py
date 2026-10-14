"""Read-only source backup and status-query benchmark; no server/market mutations."""
import argparse,json,pathlib,sqlite3,statistics,tempfile,time
ROOT=pathlib.Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--database',required=True);a=p.parse_args()
source=sqlite3.connect(pathlib.Path(a.database).resolve().as_uri()+'?mode=ro',uri=True,timeout=30)
query="SELECT s.id,(SELECT MAX(event_time) FROM market_events e WHERE e.subscription_id=s.id AND e.type='quote') AS quote_time,(SELECT MAX(received_at) FROM market_events e WHERE e.subscription_id=s.id AND e.type='quote') AS quote_received FROM market_subscriptions s ORDER BY s.rowid DESC LIMIT 100"
with tempfile.TemporaryDirectory(prefix='market-status-index-') as directory:
 target=sqlite3.connect(str(pathlib.Path(directory)/'snapshot.sqlite'));source.backup(target);source.close()
 def measure():
  samples=[];rows=None
  for _ in range(7):
   started=time.perf_counter();rows=target.execute(query).fetchall();samples.append((time.perf_counter()-started)*1000)
  return dict(medianMs=statistics.median(samples),samplesMs=samples),rows
 before_plan=target.execute('EXPLAIN QUERY PLAN '+query).fetchall();before,rows=measure()
 target.executescript((ROOT/'server/migrations/0021_quote_status_indexes.sql').read_text())
 after_plan=target.execute('EXPLAIN QUERY PLAN '+query).fetchall();after,newrows=measure();assert rows==newrows
 count=target.execute('SELECT count(*) FROM market_events').fetchone()[0]
 result=dict(ok=True,sourceReadOnly=True,sourceIsRunningService=True,eventCount=count,subscriptionCount=len(rows),beforePlan=before_plan,afterPlan=after_plan,before=before,after=after,speedup=before['medianMs']/after['medianMs'],resultsUnchanged=True)
 print(json.dumps(result,indent=2));target.close()
