/** Event-driven adapter pinned to PineTS 0.11.1. No network or wall-clock decisions. */
import {Indicator,PineTS,type Context} from 'pinets'
import type {Bar} from '../core/types'
import {createPineProvider,primaryDataset,type PineDataset} from './data'
import {linkPineLibraries,type PineLibraryLock} from './library'
import {installPineCompatibility} from './compat'
import {PineBrokerLedger,type BrokerFill} from './broker'
import {captureMutableState,removeNewSeries} from './rollback'
installPineCompatibility()
export interface PineHostEvent {id:string;kind:'forming'|'closed';bar:Omit<Bar,'volume'>&{volume:number|null};eventTime:number;executionTime?:number}
export class PineEventHost {
 private engine!:PineTS;private context!:Context;private primary!:PineDataset;private events=new Map<string,string>();private snapshot:any;private restoreMutable:()=>void=()=>{};private varip=new Set<string>();private broker?:PineBrokerLedger;private elapsed=0;private live=false;private confirmed=false;private fresh=false;
 private constructor(){}
 static async create(source:string,bars:Bar[],timeframe:string,options:{symbol?:string;metadata?:PineDataset['metadata'];datasets?:PineDataset[];inputs?:Record<string,unknown>;libraryLock?:PineLibraryLock;executionTime?:number;broker?:{startingCash:number}}={}){
  const host=new PineEventHost(),linked=linkPineLibraries(source,options.libraryLock).source;
  const declaration=new Indicator(linked,options.inputs);
  if(declaration.getDeclarationType()==='strategy'&&!options.broker)throw Error('Event strategy requires configured BrokerHost starting account; native backtest is a separate contract');
  if(declaration.getDeclarationType()==='strategy'&&declaration.prop.calc_on_every_tick!==true)throw Error('Event BrokerHost requires calc_on_every_tick=true; use closed-bar native deployment for close-only strategies');
  if(declaration.prop.calc_on_order_fills===true)throw Error('Fill-triggered recursive calculation needs configured broker event scheduling');
  // Namespace/scope keys are compiler-owned. Only explicit global primitive varip declarations are verified here.
  const names=[...linked.matchAll(/^varip\s+(?:(?:float|int|bool|string|color)\s+)?([A-Za-z_]\w*)\s*=/gm)].map(m=>m[1]);
  if([...linked.matchAll(/^varip\b[^\n]*/gm)].length!==names.length)throw Error('Non-primitive varip storage is not yet verified');
  if(/^[ \t]+varip\b/m.test(linked))throw Error('Scoped varip requires verified callsite storage mapping');
  host.primary={...primaryDataset([...bars],timeframe,options.symbol),metadata:options.metadata};
  host.engine=new PineTS(createPineProvider(host.primary,options.datasets),host.primary.symbol,host.primary.timeframe,bars.length);
  host.engine.setMaxLoops(50000);host.engine.setAlertMode('realtime');
  const clock=options.executionTime??bars.at(-1)!.closeTime!*1000;
  const execution=host.engine as any;
  if(options.broker){
   // Warmup computes historical variables against a flat authoritative broker account.
   // Native historical fills are disabled for the entire warmup, not merely erased afterward.
   const bootstrap=await withClock(clock,()=>host.engine.run(`//@version=6\nstrategy('Broker initialization',initial_capital=${options.broker!.startingCash})`));
   const account=bootstrap.strategy!;host.broker=new PineBrokerLedger(account,options.broker.startingCash);
   const iterations=execution._executeIterations.bind(execution);
   execution._executeIterations=async(ctx:Context,fn:Function,start:number,end:number)=>{
    ctx.strategy=undefined;ctx._propOverrides={...ctx._propOverrides,initial_capital:options.broker!.startingCash};
    Object.defineProperties(ctx.pine.barstate,{isrealtime:{configurable:true,get:()=>false},ishistory:{configurable:true,get:()=>true},isconfirmed:{configurable:true,get:()=>true},isnew:{configurable:true,get:()=>true}});
    try{await iterations(ctx,async(current:Context)=>{current.strategy=account;try{return await fn(current)}finally{account.pending_orders=[];current.strategy=undefined}},start,end)}finally{ctx.strategy=account}
   };
   try{host.context=await withClock(clock,()=>host.engine.run(declaration));}finally{execution._executeIterations=iterations}
  }else host.context=await withClock(clock,()=>host.engine.run(declaration));
  for(const name of names){const keys=Object.keys(host.context.var).filter(k=>k.endsWith('_'+name));if(keys.length!==1)throw Error(`Cannot map varip ${name} to unique compiler storage`);if(typeof host.context.var[keys[0]].data.at(-1)==='object')throw Error(`Composite varip ${name} storage is not verified`);host.varip.add(keys[0]);}
  const internal=host.engine as any;if(typeof internal._snapshotVarState!=='function'||typeof internal._executeIterations!=='function')throw Error('PineTS adapter version mismatch');
  // The upstream split-run snapshot is before the last historical bar. Here history is committed.

  host.snapshot=internal._snapshotVarState(host.context);host.restoreMutable=captureMutableState(host.context);
  const barstate=host.context.pine.barstate;
  Object.defineProperties(barstate,{isrealtime:{get:()=>host.live},ishistory:{get:()=>!host.live},isnew:{get:()=>host.fresh},isconfirmed:{get:()=>host.confirmed},islastconfirmedhistory:{get:()=>!host.live&&host.context.idx===host.context.length-1}});
  return host;
 }
 async append(event:PineHostEvent){
  const executionStarted=performance.now();
  const serialized=JSON.stringify(event),seen=this.events.get(event.id);if(seen){if(seen!==serialized)throw Error('Event id reused with different payload');return {duplicate:true,context:this.context}}
  if(!event.id||!Number.isFinite(event.eventTime)||!Number.isFinite(event.bar.closeTime)||event.bar.closeTime!<=event.bar.time)throw Error('Event identity/time required');
  const b:Bar={...event.bar,volume:event.bar.volume==null?NaN:event.bar.volume},last=this.primary.bars.at(-1)!;
  if(![b.time,b.open,b.high,b.low,b.close].every(Number.isFinite)||b.time<last.time||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||(b.volume<0||!Number.isFinite(b.volume)&&!Number.isNaN(b.volume)))throw Error('Invalid event OHLCV');
  const engine=this.engine as any,ctx=this.context as any,isNew=b.time>last.time;
  if(this.events.size>=200000||isNew&&this.primary.bars.length>=20000)throw Error('Event host replay budget reached; create a new verified deployment');
  if(!isNew&&!this.live)throw Error('Committed historical bar cannot be revised');
  if(!isNew&&this.confirmed)throw Error('Closed bar cannot be revised');
  if(isNew&&this.live&&!this.confirmed)throw Error('Previous forming bar lacks an explicit close event');
  this.fresh=isNew;this.live=true;this.confirmed=event.kind==='closed';
  if(isNew){this.primary.bars.push({...b});engine._appendCandle(toKline(b));this.snapshot=engine._snapshotVarState(ctx);this.restoreMutable=captureMutableState(ctx)}else{
   const preserved=new Map([...this.varip].map(k=>[k,ctx.var[k].data.at(-1)]));
   if(this.broker)this.snapshot.strategy=engine._snapshotVarState(ctx).strategy;
   removeNewSeries(ctx,this.snapshot);this.restoreMutable();engine._restoreVarState(ctx,this.snapshot);
   for(const [key,value]of preserved){const series=ctx.var[key];if(series.data.length)series.data[series.data.length-1]=value;}
   for(const series of Object.values(ctx.data) as any[])if(Array.isArray(series?.data))series.data.pop();
   if(Array.isArray(ctx.result))ctx.result.pop();else if(ctx.result)for(const values of Object.values(ctx.result) as any[])if(Array.isArray(values))values.pop();
   for(const plot of Object.values(ctx.plots) as any[])if(Array.isArray(plot?.data))plot.data=plot.data.filter((p:any)=>p.time!==b.time*1000);
   ctx.rollbackDrawings(ctx.idx);this.primary.bars[this.primary.bars.length-1]={...b};engine._replaceCandle(engine.data.length-1,toKline(b));
  }
  ctx.marketData=engine.data;ctx.length=engine.data.length;ctx.dataVersion++;
  if(this.broker){
   const state=ctx.strategy,fn=engine.transpiledCode;this.broker.markToMarket(b.close);
   if(state.config.calc_on_every_tick===true||this.confirmed){
    ctx.strategy=undefined;
    try{await withClock(event.executionTime??event.eventTime,()=>engine._executeIterations(ctx,async(current:Context)=>{current.strategy=state;try{return await fn(current)}finally{current.strategy=undefined}},engine.data.length-1,engine.data.length))}finally{ctx.strategy=state}
   }
  }else await withClock(event.executionTime??event.eventTime,()=>engine._executeIterations(ctx,engine.transpiledCode,engine.data.length-1,engine.data.length));
  for(const key of this.varip)if(typeof ctx.var[key].data.at(-1)==='object')throw Error(`Composite varip ${key} storage is not verified`);
  this.elapsed=performance.now()-executionStarted;
  this.events.set(event.id,serialized);return {duplicate:false,context:this.context};
 }
 applyBrokerFill(fill:BrokerFill){if(!this.broker)throw Error('No BrokerHost configured');if(this.broker.hasFill(fill.id))return this.broker.applyFill(fill);const state=this.context.strategy!,order=state.pending_orders.find(o=>o.id===fill.orderId);if(!order)throw Error('Broker fill has no issued Pine order');const requested=order.qty>0?order.qty:state.opentrades.filter(t=>!order.from_entry||t.entry_id===order.from_entry).reduce((n,t)=>n+Math.abs(t.size),0)*(order.qty_percent??100)/100;if(fill.qty>requested+1e-9)throw Error('Broker fill exceeds remaining native order quantity');const outcome=this.broker.applyFill(fill);if(requested-fill.qty>1e-9){order.qty=requested-fill.qty}else state.pending_orders=state.pending_orders.filter(o=>o.id!==fill.orderId);return outcome}
 clearPendingOrders(){if(this.context.strategy)this.context.strategy.pending_orders=[]}
 get pendingOrders(){return structuredClone(this.context.strategy?.pending_orders??[])}
 get account(){return this.broker?.account}
 get executionMs(){return this.elapsed}
 get state(){return this.context}
}
function toKline(b:Bar){return {...b,openTime:b.time*1000,closeTime:b.closeTime!*1000,quoteAssetVolume:0,numberOfTrades:0,takerBuyBaseAssetVolume:0,takerBuyQuoteAssetVolume:0,ignore:0}}

let clockQueue:Promise<void>=Promise.resolve();
async function withClock<T>(time:number,execute:()=>Promise<T>):Promise<T>{
 if(!Number.isFinite(time))throw Error('Recorded execution time required');let release!:()=>void;const previous=clockQueue;clockQueue=new Promise<void>(resolve=>release=resolve);await previous;
 const RealDate=globalThis.Date;const ClockDate=function(this:any,...args:any[]){if(!new.target)return new RealDate(time).toString();return Reflect.construct(RealDate,args.length?args:[time],new.target)};ClockDate.prototype=RealDate.prototype;Object.setPrototypeOf(ClockDate,RealDate);Object.defineProperty(ClockDate,'now',{value:()=>time});globalThis.Date=ClockDate as unknown as DateConstructor;
 try{return await execute()}finally{globalThis.Date=RealDate;release()}
}
