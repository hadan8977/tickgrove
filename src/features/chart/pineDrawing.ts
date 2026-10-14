import { timeToX, type Viewport } from "./drawing";
import { pinePaneVisible } from "./pineDisplay";

/** Draw Pine's retained objects. Text is drawn as text, never interpreted as HTML. */
export function drawPineVisuals(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  plots: Record<string, any>,
  width: number,
  height: number,
  top = 0,
) {
  const x = (n: number, loc?: string): number | null =>
    loc === "bt" || loc === "bar_time"
      ? timeToX(v, n / 1000)
      : v.chart.timeScale().logicalToCoordinate(n as any);
  const y = (n: number): number | null =>
    Number.isFinite(n) ? v.series.priceToCoordinate(n) : null;
  const halfBar = Math.max(1, Number(v.chart.timeScale().options().barSpacing ?? 8) / 2);
  const candle = (at: number, values: number[], opts: any, bar = false) => {
    const [open, high, low, close] = values.map(y);
    if ([open, high, low, close].some((n) => n == null)) return;
    const color = opts.color || (values[3] >= values[0] ? "#4CAF50" : "#F23645");
    stroke(opts.wickcolor || color);
    ctx.beginPath();
    ctx.moveTo(at, high!);
    ctx.lineTo(at, low!);
    ctx.stroke();
    if (bar) {
      stroke(color);
      ctx.beginPath();
      ctx.moveTo(at - halfBar * 0.7, open!);
      ctx.lineTo(at, open!);
      ctx.moveTo(at, close!);
      ctx.lineTo(at + halfBar * 0.7, close!);
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(
        at - halfBar * 0.7,
        Math.min(open!, close!),
        halfBar * 1.4,
        Math.max(1, Math.abs(open! - close!)),
      );
    }
  };
  const stroke = (color: string, size = 1, style?: string) => {
    ctx.strokeStyle = color || "#8b7dff";
    ctx.lineWidth = Math.min(10, size || 1);
    ctx.setLineDash(style?.includes("dashed") ? [6, 4] : style?.includes("dotted") ? [2, 3] : []);
  };
  ctx.save();
  ctx.translate(0, top);
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  for (const [key, plot] of Object.entries(plots)) {
    if (key === "__tables__") continue;
    if (!pinePaneVisible(plot.options?.display)) continue;
    if (plot.options?.style === "fill") {
      const first = new Map<number, number>((plot.first ?? []).map((p: any) => [p.time, p.value]));
      const second = new Map<number, number>(
        (plot.second ?? []).map((p: any) => [p.time, p.value]),
      );
      let previous: { x: number; a: number; b: number } | undefined;
      for (const event of plot.data ?? []) {
        const at = timeToX(v, event.time / 1000),
          a = y(first.get(event.time)!),
          b = y(second.get(event.time)!);
        if (at == null || a == null || b == null) {
          previous = undefined;
          continue;
        }
        if (previous) {
          ctx.fillStyle = event.options?.color || plot.options.color || "#8b7dff40";
          ctx.beginPath();
          ctx.moveTo(previous.x, previous.a);
          ctx.lineTo(at, a);
          ctx.lineTo(at, b);
          ctx.lineTo(previous.x, previous.b);
          ctx.closePath();
          ctx.fill();
        }
        previous = { x: at, a, b };
      }
      continue;
    }
    for (const event of plot.data ?? []) {
      const opts = { ...plot.options, ...event.options };
      if (!pinePaneVisible(opts.display)) continue;
      if (opts.style === "candle" || opts.style === "bar" || opts.style === "barcolor") {
        const at = timeToX(v, event.time / 1000),
          b = v.bars.find((b) => b.time * 1000 === event.time);
        const values =
          opts.style === "barcolor" ? b && [b.open, b.high, b.low, b.close] : event.value;
        if (at != null && Array.isArray(values)) candle(at, values, opts, opts.style === "bar");
        continue;
      }
      if (!Array.isArray(event.value)) {
        if (opts.style === "bgcolor" || opts.style === "background") {
          const at = timeToX(v, event.time / 1000);
          if (at != null && opts.color) {
            ctx.fillStyle = opts.color;
            ctx.fillRect(at - halfBar, 0, halfBar * 2, height);
          }
        } else if (event.value && /shape|char/.test(opts.style ?? plot.options?.style ?? "")) {
          const at = timeToX(v, event.time / 1000);
          const b = v.bars.find((b) => b.time * 1000 === event.time);
          const location = String(opts.location ?? "").toLowerCase();
          const yy =
            location === "top"
              ? 16
              : location === "bottom"
                ? height - 16
                : location === "absolute"
                  ? y(event.value)
                  : b && y(location === "abovebar" ? b.high : b.low);
          if (at != null && yy != null) {
            ctx.fillStyle = opts.color || "#8b7dff";
            ctx.font = "12px Geist, sans-serif";
            ctx.fillText(
              opts.text || opts.char || "◆",
              at,
              yy + (location === "abovebar" ? -8 : 16),
            );
          }
        }
        continue;
      }
      for (const o of event.value) {
        if (!o || o._deleted) continue;
        if (key === "__linefills__") {
          if (o.line1?._deleted || o.line2?._deleted) continue;
          const points = [o.line1, o.line2].flatMap((l) =>
            l
              ? [
                  [x(l.x1, l.xloc), y(l.y1)],
                  [x(l.x2, l.xloc), y(l.y2)],
                ]
              : [],
          );
          if (points.length !== 4 || points.some((p) => p.some((n) => n == null))) continue;
          ctx.fillStyle = o.color || "#8b7dff40";
          ctx.beginPath();
          for (const [i, p] of [points[0], points[1], points[3], points[2]].entries())
            i ? ctx.lineTo(p[0]!, p[1]!) : ctx.moveTo(p[0]!, p[1]!);
          ctx.closePath();
          ctx.fill();
        } else if (key === "__lines__") {
          let a = x(o.x1, o.xloc),
            b = x(o.x2, o.xloc),
            c = y(o.y1),
            d = y(o.y2);
          if (a == null || b == null || c == null || d == null) continue;
          if (a !== b) {
            const slope = (d - c) / (b - a);
            if (o.extend === "left" || o.extend === "both") {
              c -= slope * a;
              a = 0;
            }
            if (o.extend === "right" || o.extend === "both") {
              d += slope * (width - b);
              b = width;
            }
          }
          stroke(o.color, o.width, o.style);
          ctx.beginPath();
          ctx.moveTo(a, c);
          ctx.lineTo(b, d);
          ctx.stroke();
        } else if (key === "__boxes__") {
          const a = x(o.left, o.xloc),
            b = x(o.right, o.xloc),
            c = y(o.top),
            d = y(o.bottom);
          if (a == null || b == null || c == null || d == null) continue;
          if (o.bgcolor) {
            ctx.fillStyle = o.bgcolor;
            ctx.fillRect(a, c, b - a, d - c);
          }
          stroke(o.border_color, o.border_width, o.border_style);
          ctx.strokeRect(a, c, b - a, d - c);
          if (o.text) {
            ctx.fillStyle = o.text_color || "#fff";
            ctx.font = "12px Geist, sans-serif";
            ctx.fillText(o.text, a + 4, c + 15, Math.max(1, b - a - 8));
          }
        } else if (key === "__labels__") {
          const a = x(o.x, o.xloc);
          let c = y(o.y);
          const bar = o.xloc === "bi" ? v.bars[o.x] : v.bars.find((b) => b.time * 1000 === o.x);
          if (bar && o.yloc === "ab") c = y(bar.high);
          if (bar && o.yloc === "bl") c = y(bar.low);
          if (a == null || c == null) continue;
          ctx.font = "12px Geist, sans-serif";
          const text = String(o.text ?? "");
          const w = ctx.measureText(text).width + 8;
          if (o.color) {
            ctx.fillStyle = o.color;
            ctx.fillRect(a - w / 2, c - 17, w, 20);
          }
          ctx.fillStyle = o.textcolor || "#e8e8e6";
          ctx.textAlign = "center";
          ctx.fillText(text, a, c - 3);
          ctx.textAlign = "left";
        } else if (key === "__polylines__") {
          stroke(o.line_color, o.line_width, o.line_style);
          ctx.beginPath();
          let started = false;
          for (const point of o.points ?? []) {
            const a = x(o.xloc === "bt" ? point.time : point.index, o.xloc),
              c = y(point.price);
            if (a == null || c == null) continue;
            if (!started) {
              ctx.moveTo(a, c);
              started = true;
            } else ctx.lineTo(a, c);
          }
          if (o.closed) ctx.closePath();
          if (o.fill_color) {
            ctx.fillStyle = o.fill_color;
            ctx.fill();
          }
          ctx.stroke();
        }
      }
    }
  }
  for (const event of plots.__tables__?.data ?? [])
    for (const table of event.value ?? []) {
      if (table._deleted) continue;
      ctx.font = "12px Geist, sans-serif";
      const cells = table.cells ?? [];
      const widths = Array.from({ length: table.columns }, (_, col) =>
        Math.max(
          50,
          ...cells.map((row: any[]) => ctx.measureText(String(row[col]?.text ?? "")).width + 14),
        ),
      );
      const tw = widths.reduce((a: number, b: number) => a + b, 0),
        th = table.rows * 22;
      const px = table.position.includes("right")
        ? width - tw - 8
        : table.position.includes("center")
          ? (width - tw) / 2
          : 8;
      const py = table.position.startsWith("bottom")
        ? height - th - 8
        : table.position.startsWith("middle")
          ? (height - th) / 2
          : 8;
      for (let row = 0; row < table.rows; row++)
        for (let col = 0; col < table.columns; col++) {
          const cell = cells[row]?.[col];
          if (!cell || cell._merged) continue;
          const left = px + widths.slice(0, col).reduce((a: number, b: number) => a + b, 0),
            upper = py + row * 22;
          ctx.fillStyle = cell.bgcolor || table.bgcolor || "#151516dd";
          ctx.fillRect(left, upper, widths[col], 22);
          ctx.fillStyle = cell.text_color || "#e8e8e6";
          ctx.fillText(String(cell.text ?? ""), left + 6, upper + 15);
          if (table.border_width) {
            stroke(table.border_color, table.border_width);
            ctx.strokeRect(left, upper, widths[col], 22);
          }
        }
    }
  ctx.restore();
}
