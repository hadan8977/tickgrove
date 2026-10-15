// Persistent event host. Rust supplies immutable source/data and durably ordered events.
require('./register-typescript.cjs');
const readline=require('node:readline');
const {PineEventHost}=require('../src/pine/host.ts');
let host,alertCursor=0;
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
(async()=>{for await(const line of lines){let request;try{if(line.length>16_000_000)throw Error('Host message budget exceeded');request=JSON.parse(line);let output;
 if(request.operation==='init'){if(host)throw Error('Host already initialized');host=await PineEventHost.create(request.source,request.data.bars,request.data.timeframe,{...request.options,symbol:request.data.symbol,metadata:request.data.metadata,datasets:request.data.datasets});alertCursor=host.state.alerts.length;output={ready:true};}
 else{if(!host)throw Error('Host not initialized');if(request.operation==='market')output=await host.append(request.event);else if(request.operation==='fill')output=host.applyBrokerFill(request.fill);else if(request.operation==='clearOrders'){host.clearPendingOrders();output={cleared:true}}else if(request.operation!=='state')throw Error('Unknown host operation');}
 const ctx=host.state;const alerts=ctx.alerts.slice(alertCursor);alertCursor=ctx.alerts.length;
 const plots={};for(const [name,p]of Object.entries(ctx.plots)){if(p.data?.length&&typeof p.data.at(-1)?.value==='number')plots[name]={time:p.data.at(-1).time,value:p.data.at(-1).value,options:p.data.at(-1).options};}
 const response={barIndex:ctx.idx,openTrades:ctx.strategy?.opentrades,ok:true,duplicate:output?.duplicate??false,pendingOrders:host.pendingOrders,account:host.account,plots,alerts};
 if(request.operation==='state'){
 const bars=ctx.marketData.map(b=>({time:b.openTime/1000,closeTime:b.closeTime/1000,open:b.open,high:b.high,low:b.low,close:b.close,volume:Number.isFinite(b.volume)?b.volume:null}));
 const indexes=new Map(bars.map((b,i)=>[b.time*1000,i]));const lines=[];const visuals={};
 for(const [key,p]of Object.entries(ctx.plots)){if(key.startsWith('__')||p.data?.some(d=>Array.isArray(d.value)||d.value&&typeof d.value==='object')){visuals[key]=p;continue}const values=bars.map(()=>null),colors=bars.map(()=>undefined);let shape=false;for(const d of p.data??[]){const i=indexes.get(d.time);if(i==null)continue;if(typeof d.value==='boolean'){shape=true;values[i]=d.value?bars[i].close:null}else if(typeof d.value==='number'&&Number.isFinite(d.value))values[i]=d.value;colors[i]=d.options?.color;}const options={...p.options,...p.data?.at(-1)?.options};lines.push({title:p.title??key,data:values,colors,color:colors.find(Boolean)??'#8b7dff',shape,display:options.display,style:options.style,width:options.linewidth??2});if(shape)visuals[key]=p;}
 const signals=[];for(const trade of [...(ctx.strategy?.closedtrades??[]),...(ctx.strategy?.opentrades??[])]){signals.push({bar:trade.entry_bar_index,action:trade.size<0?'short':'long'});if(trade.status==='closed')signals.push({bar:trade.exit_bar_index,action:'flat'});}
 response.render={ok:true,kind:ctx.strategy?'strategy':'indicator',title:ctx.strategy?.config.title??ctx.indicator?.title??'Pine event host',overlay:Boolean(ctx.strategy?.config.overlay??ctx.indicator?.overlay),plots:lines,signals,visuals,warnings:ctx.warnings.map(w=>w.message),alerts:ctx.alerts,ms:host.executionMs};response.bars=bars;
 }
 process.stdout.write(JSON.stringify(response,(_,v)=>typeof v==='number'&&!Number.isFinite(v)?null:v)+'\n');
 }catch(e){const recoverable=request?.operation==='fill';process.stdout.write(JSON.stringify({ok:false,error:{message:e.message},recoverable})+'\n');if(!recoverable){process.exitCode=1;break;}}}})().catch(()=>process.exit(2));
