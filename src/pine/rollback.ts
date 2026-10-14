/** Restore mutable Pine collections in place; bound helper closures retain their object identity. */
import {Context} from 'pinets'
type RecordState={target:any;kind:'object'|'map'|'set'|'date';properties?:Map<PropertyKey,PropertyDescriptor>;entries?:any[];time?:number}
export function captureMutableState(context:Context){
 const records:RecordState[]=[],seen=new Set<any>();
 function visit(value:any){if(!value||typeof value!=='object'||value instanceof Context||seen.has(value))return;seen.add(value);
  if(value instanceof Map){records.push({target:value,kind:'map',entries:[...value]});for(const [k,v]of value){visit(k);visit(v)}return}
  if(value instanceof Set){records.push({target:value,kind:'set',entries:[...value]});for(const v of value)visit(v);return}
  if(value instanceof Date){records.push({target:value,kind:'date',time:value.getTime()});return}
  const properties=new Map<PropertyKey,PropertyDescriptor>();for(const key of Reflect.ownKeys(value)){const descriptor=Object.getOwnPropertyDescriptor(value,key)!;if('value'in descriptor&&typeof descriptor.value!=='function'&&!(descriptor.value instanceof Context)){properties.set(key,descriptor);visit(descriptor.value)}}records.push({target:value,kind:'object',properties});
 }
 for(const scope of [context,...context.lctx.values()])for(const kind of ['var','let','const','params'])for(const series of Object.values((scope as any)[kind]??{}) as any[])if(Array.isArray(series?.data))visit(series.data.at(-1));
 return ()=>{for(const record of records){const value=record.target;if(record.kind==='map'){value.clear();for(const [k,v]of record.entries!)value.set(k,v)}else if(record.kind==='set'){value.clear();for(const v of record.entries!)value.add(v)}else if(record.kind==='date')value.setTime(record.time);else{for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key)!;if(!record.properties!.has(key)&&d.configurable&&'value'in d&&typeof d.value!=='function'&&!(d.value instanceof Context))delete value[key]}for(const [key,descriptor]of record.properties!)Object.defineProperty(value,key,descriptor)}}};
}
export function removeNewSeries(context:Context,snapshot:any){
 const clean=(scope:any,record:any)=>{for(const kind of ['var','let','const','params'])for(const key of Object.keys(scope[kind]??{}))if(!Object.prototype.hasOwnProperty.call(record?.[kind]??{},key))delete scope[kind][key]};clean(context,snapshot.main);let i=0;for(const [key,scope]of context.lctx){if(i>=snapshot.lctx.length)context.lctx.delete(key);else clean(scope,snapshot.lctx[i]);i++}
}
