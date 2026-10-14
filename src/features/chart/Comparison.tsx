import { useEffect,useRef } from 'react'
import { createChart,LineSeries,ColorType,type Time } from 'lightweight-charts'
import type { ChartState } from '../../core/types'
import { getBars,marketSeries } from '../../data/feed'
import { useTick } from '../../ui/hooks'
import { cssVar } from './bus'

export default function Comparison({state}:{state:ChartState}){
  const root=useRef<HTMLDivElement>(null),tick=useTick(),symbols=[state.symbol,...state.comparisons??[]]
  const source=getBars(state.symbol,state.tf),base=state.replayCursor!=null?source.slice(0,state.replayCursor):source
  const start=base[0]?.time,end=base.at(-1)?.time
  const groups=symbols.map(symbol=>({symbol,bars:getBars(symbol,state.tf).filter(b=>b.time>=(start??Infinity)&&b.time<=(end??-Infinity)),error:marketSeries(symbol,state.tf).error}))
  const signature=groups.map(g=>g.symbol+':'+g.bars.length+':'+g.bars.at(-1)?.close).join('|')
  useEffect(()=>{
    if(!root.current)return
    const chart=createChart(root.current,{autoSize:true,layout:{background:{type:ColorType.Solid,color:'transparent'},textColor:cssVar('--muted'),attributionLogo:false,fontSize:10},grid:{vertLines:{visible:false},horzLines:{color:cssVar('--grid')}},timeScale:{visible:true},rightPriceScale:{borderVisible:false}})
    const usable=groups.filter(g=>g.bars.length>0),common=usable.length===groups.length?Math.max(...usable.map(g=>g.bars[0].time)):Infinity
    usable.forEach((g,i)=>{const data=g.bars.filter(b=>b.time>=common);if(!data.length)return;const first=data[0].close;chart.addSeries(LineSeries,{title:g.symbol,color:['#8b7dff','#2dd4bf','#fbbf24','#fb7185','#60a5fa','#a3e635'][i],lineWidth:1,priceLineVisible:false}).setData(data.map(b=>({time:b.time as Time,value:b.close/first*100})))})
    chart.timeScale().fitContent();return()=>chart.remove()
  },[signature,start,end])
  return <div className="h-44 shrink-0 border-t border-line"><div className="truncate px-2 py-1 text-[10px] text-muted">Comparison · common start = 100 · {groups.map(g=>`${g.symbol}${g.error?' (data error)':!g.bars.length?' (loading / unavailable)':''}`).join(' · ')}</div><div className="h-36" ref={root}/></div>
}
