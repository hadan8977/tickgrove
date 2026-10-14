import type { Bar } from '../core/types'
export type Node = { type: 'asset'; symbol: string } | {type:'cash'} | {type:'group';name:string;child:Node} | { type: 'weight'; mode?:'specified'|'equal'|'inverse_volatility';lookback?:number; children: { weight: number; node: Node }[] } | { type: 'condition'; symbol: string; lookback: number; above: number; yes: Node; no: Node } | { type: 'filter'; symbols: string[]; lookback: number; count: number; order: 'top' | 'bottom' }
export interface ComposerSpec { tree: Node; capital: number; commissionBps: number; rebalance: { everyBars?: number; calendar?: 'daily' | 'weekly' | 'monthly'; threshold: number } }
export interface ComposerFrame { time: number; equity: number; cash: number; positions: Record<string, number>; weights: Record<string, number>; reason: string[]; orders: { symbol: string; qty: number; price: number; commission: number }[] }
export function validateSpec(spec: ComposerSpec): void {
  if (!spec || !spec.rebalance || !(spec.capital > 0 && Number.isFinite(spec.capital)) || !(Number.isFinite(spec.commissionBps) && spec.commissionBps >= 0 && spec.commissionBps <= 1000) || (!spec.rebalance?.calendar && (!Number.isInteger(spec.rebalance?.everyBars) || spec.rebalance.everyBars! < 1)) || (spec.rebalance?.calendar != null && !["daily","weekly","monthly"].includes(spec.rebalance.calendar)) || !(Number.isFinite(spec.rebalance.threshold) && spec.rebalance.threshold >= 0 && spec.rebalance.threshold <= 1)) throw new Error('Invalid Composer capital, cost or rebalance settings')
  let nodes = 0
  const walk = (node: Node, depth: number) => {
    if (++nodes > 1000 || depth > 32 || !node) throw new Error('Composer tree exceeds limits')
    if (node.type === 'asset') { if (!/^[A-Z][A-Z0-9.-]{0,15}$/.test(node.symbol)) throw new Error('Invalid symbol') }
    else if(node.type==='cash')return
    else if(node.type==='group'){if(typeof node.name!=='string'||node.name.length>120)throw Error('Invalid group name');walk(node.child,depth+1)}
    else if (node.type === 'weight') { const mode=node.mode??'specified';if(!['specified','equal','inverse_volatility'].includes(mode)||!Array.isArray(node.children)||!node.children.length)throw Error('Invalid weight group');if(mode==='specified'&&(node.children.some(c => !Number.isFinite(c.weight) || c.weight < 0) || Math.abs(node.children.reduce((s,c) => s+c.weight,0)-1)>1e-8)) throw new Error('Specified weights must be nonnegative and sum to one');if(mode==='inverse_volatility'&&(!Number.isInteger(node.lookback)||node.lookback!<2||node.lookback!>10000))throw Error('Inverse volatility needs a 2–10000 bar lookback');node.children.forEach(c => walk(c.node,depth+1)) }
    else if (node.type === 'condition') { if (!Number.isInteger(node.lookback) || node.lookback<1 || !Number.isFinite(node.above)) throw new Error('Invalid condition');walk({type:'asset',symbol:node.symbol},depth+1);walk(node.yes,depth+1);walk(node.no,depth+1) }
    else if (node.type === 'filter') { if (!node.symbols.length || new Set(node.symbols).size!==node.symbols.length || !Number.isInteger(node.count) || node.count<1 || node.count>node.symbols.length || !Number.isInteger(node.lookback) || node.lookback<1 || !['top','bottom'].includes(node.order)) throw new Error('Invalid filter');node.symbols.forEach(symbol=>walk({type:'asset',symbol},depth+1)) }
    else throw new Error('Unknown Composer node')
  }; walk(spec.tree,0)
}
export function runComposer(spec: ComposerSpec, data: { symbol: string; bars: Bar[]; metadata?: {timezone?:string}; datasets?: {symbol:string; bars:Bar[]}[] }) {
 validateSpec(spec)
 if(!data||!Array.isArray(data.bars)||!data.bars.length)throw new Error('Composer requires nonempty market data')
 for(const dataset of [data,...(data.datasets??[])]){if(!Array.isArray(dataset.bars)||!dataset.bars.length)throw new Error('Empty dataset');for(let i=0;i<dataset.bars.length;i++){const b=dataset.bars[i];if(![b.open,b.high,b.low,b.close].every(v=>Number.isFinite(v)&&v>0)||!Number.isFinite(b.time)||!Number.isFinite(b.volume)||b.volume<0||b.high<Math.max(b.open,b.close,b.low)||b.low>Math.min(b.open,b.close)||i>0&&b.time<=dataset.bars[i-1].time)throw new Error('Invalid Composer OHLCV')}}
 const series: Record<string,Bar[]> = {[data.symbol]:data.bars}; for(const d of data.datasets??[]) { if(series[d.symbol]) throw new Error('Duplicate Composer symbol');series[d.symbol]=d.bars }
 for(const [symbol,bars] of Object.entries(series)) if(bars.length!==data.bars.length||bars.some((b,i)=>b.time!==data.bars[i].time)) throw new Error(`Composer requires aligned closed bars for ${symbol}`)
 const close=(symbol:string,i:number)=>{if(!series[symbol])throw new Error(`Missing data for ${symbol}`);return series[symbol][i].close}
 const metric=(symbol:string,i:number,n:number)=> i>=n ? close(symbol,i)/close(symbol,i-n)-1 : null
 const evaluate=(node:Node,i:number,reasons:string[]):Record<string,number>=>{
  if(node.type==='asset'){close(node.symbol,i);return {[node.symbol]:1}}
  if(node.type==='cash'){reasons.push('Cash allocation');return {}}
  if(node.type==='group'){reasons.push(`Group: ${node.name}`);return evaluate(node.child,i,reasons)}
  if(node.type==='weight'){
   const out:Record<string,number>={},children=node.children.map(c=>evaluate(c.node,i,reasons)),mode=node.mode??'specified';let weights=node.children.map(c=>c.weight)
   if(mode==='equal')weights=children.map(()=>1/children.length)
   if(mode==='inverse_volatility'){
    const lookback=node.lookback!;if(i<lookback){reasons.push(`Inverse volatility: ${i}/${lookback} return bars → cash`);return {}}
    // Risk is measured on each child's current allocation held at fixed weights
    // across trailing close-to-close returns. No future weights or bars are read.
    const deviations=children.map(allocation=>{const returns=[];for(let j=i-lookback+1;j<=i;j++)returns.push(Object.entries(allocation).reduce((sum,[s,w])=>sum+w*(close(s,j)/close(s,j-1)-1),0));const mean=returns.reduce((sum,x)=>sum+x,0)/returns.length;return Math.sqrt(returns.reduce((sum,x)=>sum+(x-mean)**2,0)/(returns.length-1))})
    const zeros=deviations.filter(v=>v<=1e-12).length
    const raw=deviations.map(v=>zeros?(v<=1e-12?1:0):1/v),sum=raw.reduce((a,b)=>a+b,0);weights=raw.map(v=>v/sum)
    reasons.push(`Inverse volatility of current child allocations (${lookback} trailing returns): ${weights.map(v=>v.toFixed(6)).join(', ')}${zeros?' · zero-variance children share allocation':''}`)
   }
   for(let c=0;c<children.length;c++)for(const [s,w]of Object.entries(children[c]))out[s]=(out[s]??0)+w*weights[c]
   return out
  }
  if(node.type==='condition'){const value=metric(node.symbol,i,node.lookback);if(value===null){reasons.push(`${node.symbol}: warmup → no branch`);return evaluate(node.no,i,reasons)}const yes=value>node.above;reasons.push(`${node.symbol} ${node.lookback}-bar return ${value.toFixed(6)} ${yes?'>':'<='} ${node.above}`);return evaluate(yes?node.yes:node.no,i,reasons)}
  const values=node.symbols.map(symbol=>({symbol,value:metric(symbol,i,node.lookback)}));if(values.some(v=>v.value===null)){reasons.push('Filter warmup → cash');return {}}
  values.sort((a,b)=> (node.order==='top'?-1:1)*(a.value!-b.value!)||a.symbol.localeCompare(b.symbol));const chosen=values.slice(0,node.count);reasons.push(`Filter ${node.order}: ${chosen.map(v=>v.symbol).join(', ')}`);return Object.fromEntries(chosen.map(v=>[v.symbol,1/chosen.length]))
 }
 const calendarKey=(time:number)=>{const timezone=data.metadata?.timezone;if(!timezone)throw new Error('Calendar rebalance requires declared dataset timezone');const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(time*1000));const get=(type:string)=>parts.find(p=>p.type===type)!.value;const date=`${get('year')}-${get('month')}-${get('day')}`;if(spec.rebalance.calendar==='monthly')return date.slice(0,7);if(spec.rebalance.calendar==='daily')return date;const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);return d.toISOString().slice(0,10)}
 let previousCalendar:string|undefined;
 let cash=spec.capital;let positions:Record<string,number>={};let pending:Record<string,number>|null=null;let previousWeights:Record<string,number>={};const frames:ComposerFrame[]=[]
 for(let i=0;i<data.bars.length;i++){
  const orders:ComposerFrame['orders']=[]
  if(pending){const symbols=new Set([...Object.keys(positions),...Object.keys(pending)]);const equity=cash+[...symbols].reduce((s,symbol)=>s+(positions[symbol]??0)*series[symbol][i].open,0);const target:Record<string,number>={};const rate=spec.commissionBps/10000;
   // Solve post-fee investable equity including sales, using monotonic bisection.
   let lower=0,upper=equity;for(let step=0;step<80;step++){const candidate=(lower+upper)/2;const fees=[...symbols].reduce((sum,s)=>sum+Math.abs((pending![s]??0)*candidate-(positions[s]??0)*series[s][i].open)*rate,0);if(candidate+fees>equity)upper=candidate;else lower=candidate}
   for(const s of symbols)target[s]=(pending[s]??0)*lower/series[s][i].open;
   for(const s of [...symbols].sort((a,b)=>(target[a]-(positions[a]??0))-(target[b]-(positions[b]??0)))) {const qty=target[s]-(positions[s]??0);if(Math.abs(qty)<1e-9)continue;const price=series[s][i].open;const commission=Math.abs(qty*price)*spec.commissionBps/10000;cash-=qty*price+commission;positions[s]=target[s];orders.push({symbol:s,qty,price,commission})}if(cash < -1e-7)throw new Error('Rebalance produced negative cash');if(Math.abs(cash)<1e-9)cash=0;pending=null
  }
  const equity=cash+Object.entries(positions).reduce((s,[symbol,qty])=>s+qty*close(symbol,i),0);const reason:string[]=[];const weights=evaluate(spec.tree,i,reason);const drift=Math.max(0,...[...new Set([...Object.keys(weights),...Object.keys(positions)])].map(symbol=>Math.abs((weights[symbol]??0)-(positions[symbol]??0)*close(symbol,i)/equity)))
  const key=spec.rebalance.calendar?calendarKey(data.bars[i].time):undefined;const scheduled=spec.rebalance.calendar?key!==previousCalendar:i % (spec.rebalance.everyBars ?? 1) === 0;previousCalendar=key;
  if(i===0||scheduled||(spec.rebalance.threshold>0&&drift>=spec.rebalance.threshold)){pending=weights;reason.push('Target scheduled for next bar open');previousWeights=weights}
  if(!Number.isFinite(equity)||!Number.isFinite(cash)||Object.values(positions).some(q=>!Number.isFinite(q))||orders.some(o=>![o.qty,o.price,o.commission].every(Number.isFinite)))throw new Error('Non-finite portfolio state')
  frames.push({time:data.bars[i].time,equity,cash,positions:{...positions},weights:{...previousWeights},reason,orders})
 }
 return {ok:true,kind:'composer',title:'Composer portfolio',contract:'closed-bar targets → next open fractional shares; no forced liquidation',frames,equity:frames.map(f=>({time:f.time,value:f.equity})),metrics:{netProfit:frames.at(-1)!.equity-spec.capital,netProfitPct:(frames.at(-1)!.equity/spec.capital-1)*100},pendingWeights:pending}
}
