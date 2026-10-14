#!/usr/bin/env python3
"""Generate a versioned, auditable XNYS schedule. Install exchange-calendars==4.11.2.
The generated data is not a promise about future unscheduled exchange closures.
"""
import argparse,datetime,json,pathlib
import exchange_calendars as xc
p=argparse.ArgumentParser();p.add_argument('--start',default='1990-01-01');p.add_argument('--end',default='2035-12-31');p.add_argument('--output',default='server/data/xnys-calendar.json');a=p.parse_args()
c=xc.get_calendar('XNYS',start=a.start,end=a.end)
sessions={}
d=datetime.date.fromisoformat(a.start);end=datetime.date.fromisoformat(a.end)
while d<=end:sessions[str(d)]=None;d+=datetime.timedelta(days=1)
for d,r in c.schedule.iterrows():sessions[str(d.date())]={'open':r['open'].isoformat(),'close':r['close'].isoformat()}
# Published 2025 presidential mourning closure, also expected in the selected library.
if '2025-01-09' in sessions:sessions['2025-01-09']=None
out=pathlib.Path(a.output);out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps({'calendar':'XNYS','generator':'exchange_calendars','version':xc.__version__,'source':'https://github.com/gerrymanoim/exchange_calendars','range':{'start':a.start,'end':a.end},'futurePolicy':'scheduled rules; unscheduled closures require data update','sessions':sessions},separators=(',',':'))+'\n')
print(out,len(sessions))
