#!/usr/bin/env python3
"""Real public streams, no keys. pip install websockets==16.0 to run."""
import asyncio,datetime,json,pathlib,os
import websockets
async def probe(url,params):
 result={'url':url,'params':params,'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'messages':[]}
 try:
  async with websockets.connect(url,open_timeout=15) as w:
   result['connected']=True;await w.send(json.dumps(params))
   for _ in range(4):
    try:result['messages'].append(json.loads(await asyncio.wait_for(w.recv(),25)))
    except TimeoutError:result['observation']='no further messages in25s; no realtime entitlement claim';break
 except Exception as e:result['error']=str(e)
 return result
async def main():
 results=[]
 results.append(await probe('wss://ws-feed.exchange.coinbase.com',{'type':'subscribe','product_ids':['LTC-USD'],'channels':['ticker','matches','heartbeat']}))
 results.append(await probe('wss://streamer.finance.yahoo.com/?version=2',{'subscribe':['BTC-USD','SPY','MSFT']}))
 path=pathlib.Path(os.getenv('MARKET_PROBE_REPORT','docs/acceptance/public-websocket-probe.json'));path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps({'realNetwork':True,'credentialsUsed':False,'sources':results},indent=2));print(path)
asyncio.run(main())
