import type { IChartApi, ISeriesApi, SeriesType, Time } from 'lightweight-charts'
import type { Bar, Drawing } from '../../core/types'

export interface Viewport {
  chart: IChartApi
  series: ISeriesApi<SeriesType>
  bars: Bar[]
}

function indexOfTime(bars: Bar[], t: number) {
  let lo = 0
  let hi = bars.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].time < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** time -> x, interpolating between bars and extrapolating past the last bar. */
export function timeToX(v: Viewport, t: number): number | null {
  const { bars, chart } = v
  if (!bars.length) return null
  const step = bars.length > 1 ? bars[bars.length - 1].time - bars[bars.length - 2].time : 60
  let logical: number
  if (t > bars[bars.length - 1].time) logical = bars.length - 1 + (t - bars[bars.length - 1].time) / step
  else if (t < bars[0].time) logical = (t - bars[0].time) / step
  else {
    const i = indexOfTime(bars, t)
    const b = bars[i]
    if (b.time === t || i === 0) logical = i
    else {
      const a = bars[i - 1]
      logical = i - 1 + (t - a.time) / (b.time - a.time)
    }
  }
  return chart.timeScale().logicalToCoordinate(logical as any)
}

export function xToTime(v: Viewport, x: number): number | null {
  const { bars, chart } = v
  const logical = chart.timeScale().coordinateToLogical(x)
  if (logical === null || !bars.length) return null
  const step = bars.length > 1 ? bars[bars.length - 1].time - bars[bars.length - 2].time : 60
  const i = Math.round(logical)
  if (i >= bars.length) return bars[bars.length - 1].time + (i - bars.length + 1) * step
  if (i < 0) return bars[0].time + i * step
  return bars[i].time
}

export const priceToY = (v: Viewport, p: number) => v.series.priceToCoordinate(p)
export const yToPrice = (v: Viewport, y: number) => v.series.coordinateToPrice(y) as number | null

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]

export function drawAll(ctx: CanvasRenderingContext2D, v: Viewport, drawings: Drawing[], opts: { width: number; height: number; accent: string; text: string; muted: string; selected?: string | null; draft?: Drawing | null }) {
  ctx.clearRect(0, 0, opts.width, opts.height)
  const list = opts.draft ? [...drawings, opts.draft] : drawings
  const paneH = v.chart.panes()[0]?.getHeight() ?? opts.height
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, opts.width, paneH)
  ctx.clip()
  for (const d of list) {
    const pts = d.points.map((p) => ({ x: timeToX(v, p.t), y: priceToY(v, p.p) }))
    if (pts.some((p) => p.x === null || p.y === null)) {
      if (d.tool !== 'hline') continue
    }
    const sel = d.id === opts.selected || d === opts.draft
    const color = opts.accent
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = sel ? 2 : 1.5
    ctx.setLineDash([])
    const [a, b] = pts as { x: number; y: number }[]
    switch (d.tool) {
      case 'trend': {
        if (!b) break
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
        break
      }
      case 'hline': {
        const y = priceToY(v, d.points[0].p)
        if (y === null) break
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(opts.width, y)
        ctx.stroke()
        ctx.font = '500 10.5px Geist Mono, monospace'
        const label = d.points[0].p.toFixed(2)
        const w = ctx.measureText(label).width + 10
        ctx.fillRect(4, y - 9, w, 18)
        ctx.fillStyle = '#fff'
        ctx.fillText(label, 9, y + 4)
        break
      }
      case 'rect': {
        if (!b) break
        ctx.globalAlpha = 0.12
        ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
        ctx.globalAlpha = 1
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
        break
      }
      case 'fib': {
        if (!b) break
        const p0 = d.points[0].p
        const p1 = d.points[1].p
        const x0 = Math.min(a.x, b.x)
        const x1 = Math.max(a.x, b.x, x0 + 40)
        ctx.font = '500 10px Geist Mono, monospace'
        FIB.forEach((f, i) => {
          const price = p1 + (p0 - p1) * f
          const y = priceToY(v, price)
          if (y === null) return
          ctx.globalAlpha = 0.06 + (i % 2) * 0.05
          const yn = priceToY(v, p1 + (p0 - p1) * (FIB[i + 1] ?? f))
          if (i < FIB.length - 1 && yn !== null) ctx.fillRect(x0, Math.min(y, yn), x1 - x0, Math.abs(yn - y))
          ctx.globalAlpha = 0.9
          ctx.beginPath()
          ctx.moveTo(x0, y)
          ctx.lineTo(x1, y)
          ctx.stroke()
          ctx.globalAlpha = 1
          ctx.fillText(`${f.toFixed(3)}  ${price.toFixed(2)}`, x1 + 6, y + 3)
        })
        ctx.setLineDash([4, 4])
        ctx.globalAlpha = 0.5
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
        ctx.globalAlpha = 1
        break
      }
      case 'text': {
        ctx.font = '600 12px Geist, sans-serif'
        const t = d.text ?? ''
        const w = ctx.measureText(t).width
        ctx.globalAlpha = 0.16
        ctx.fillRect(a.x - 4, a.y - 14, w + 8, 20)
        ctx.globalAlpha = 1
        ctx.fillStyle = opts.text
        ctx.fillText(t, a.x, a.y)
        break
      }
    }
    if (sel && d !== opts.draft) {
      for (const p of pts) {
        if (p.x === null || p.y === null) continue
        ctx.beginPath()
        ctx.fillStyle = '#fff'
        ctx.strokeStyle = color
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
    }
  }
  ctx.restore()
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax
  const dy = by - ay
  const l = dx * dx + dy * dy
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

export function hitTest(v: Viewport, drawings: Drawing[], x: number, y: number): string | null {
  for (let i = drawings.length - 1; i >= 0; i--) {
    const d = drawings[i]
    const pts = d.points.map((p) => ({ x: timeToX(v, p.t) ?? -1e9, y: priceToY(v, p.p) ?? -1e9 }))
    const [a, b] = pts
    if (d.tool === 'hline' && Math.abs(y - a.y) < 6) return d.id
    if (d.tool === 'trend' && b && distToSeg(x, y, a.x, a.y, b.x, b.y) < 6) return d.id
    if ((d.tool === 'rect' || d.tool === 'fib') && b && x >= Math.min(a.x, b.x) - 4 && x <= Math.max(a.x, b.x) + 4 && y >= Math.min(a.y, b.y) - 4 && y <= Math.max(a.y, b.y) + 4) return d.id
    if (d.tool === 'text' && x >= a.x - 4 && x <= a.x + 120 && Math.abs(y - a.y + 4) < 12) return d.id
  }
  return null
}

export type { Time }
