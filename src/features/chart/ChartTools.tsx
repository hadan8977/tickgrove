import { useEffect, useState } from "react";
import { Settings2, Pause, Play, SkipForward, Undo2, Redo2 } from "lucide-react";
import type { ChartState, Drawing } from "../../core/types";
import { useApp, useCharts } from "../../store";
import { getBars, marketSeries } from "../../data/feed";
import { Button, IconButton, Input, Popover } from "../../ui/primitives";
import { chartControls } from "./bus";
import { useTick } from "../../ui/hooks";
import SymbolSearch from "./SymbolSearch";

function download(text: string, name: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
export default function ChartTools({ state }: { state: ChartState }) {
  useTick();
  const bars = getBars(state.symbol, state.tf),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1);
  const drawings = useCharts((s) => s.drawings[state.symbol]) ?? [];
  const patch = (value: Partial<ChartState>) => useCharts.getState().patchChart(state.id, value);
  const replay = state.replayCursor != null;
  const step = () => {
    const chart = useCharts.getState().charts[state.id];
    if (chart?.replayCursor != null)
      useCharts
        .getState()
        .patchChart(state.id, {
          replayCursor: Math.min(getBars(chart.symbol, chart.tf).length, chart.replayCursor + 1),
        });
  };
  useEffect(() => {
    if (!playing || !replay) return;
    const timer = setInterval(step, 1000 / speed);
    return () => clearInterval(timer);
  }, [playing, replay, speed, state.id]);
  useEffect(() => {
    if ((state.replayCursor ?? 0) >= bars.length) setPlaying(false);
  }, [state.replayCursor, bars.length]);
  return (
    <div className="flex items-center gap-1">
      <Popover
        align="right"
        className="w-[360px]"
        trigger={({ toggle }) => (
          <IconButton label="Chart tools and objects" active={replay} onClick={toggle}>
            <Settings2 size={14} />
          </IconButton>
        )}
      >
        <div className="max-h-[70vh] space-y-3 overflow-auto p-2 text-xs">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => chartControls.get(state.id)?.fit()}>
              Fit data
            </Button>
            <Button
              size="sm"
              onClick={() => patch({ scale: state.scale === "log" ? "linear" : "log" })}
            >
              {state.scale === "log" ? "Logarithmic" : "Linear"} scale
            </Button>
            <Button size="sm" onClick={() => chartControls.get(state.id)?.screenshot()}>
              Save PNG
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const rows = replay ? bars.slice(0, state.replayCursor!) : bars;
                const identity = marketSeries(state.symbol, state.tf).identity;
                download(
                  [
                    "time,open,high,low,close,volume",
                    ...rows.map((b) =>
                      [b.time, b.open, b.high, b.low, b.close, b.volume].join(","),
                    ),
                  ].join("\n"),
                  `${state.symbol}-${state.tf}.csv`,
                  "text/csv",
                );
                download(
                  JSON.stringify(
                    {
                      symbol: state.symbol,
                      timeframe: state.tf,
                      identity,
                      snapshot: marketSeries(state.symbol, state.tf).snapshotId,
                    },
                    null,
                    2,
                  ),
                  `${state.symbol}-${state.tf}-source.json`,
                  "application/json",
                );
              }}
            >
              Export bars + source
            </Button>
          </div>
          <div className="border-y border-line py-3">
            <b>Historical bar replay</b>
            <p className="my-2 text-faint">
              Chart calculations see only the selected prefix. Server trading continues separately.
            </p>
            <Button
              size="sm"
              disabled={!bars.length}
              onClick={() => {
                patch({ replayCursor: replay ? null : Math.min(100, bars.length) });
                setPlaying(false);
              }}
            >
              {replay ? "Return to live chart" : "Start replay"}
            </Button>
            {replay && (
              <>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-demo">
                    {state.replayCursor} / {bars.length} bars
                  </span>
                  <Button size="sm" onClick={() => setPlaying(!playing)}>
                    {playing ? <Pause size={12} /> : <Play size={12} />}{" "}
                    {playing ? "Pause replay" : "Play replay"}
                  </Button>
                  <Button size="sm" onClick={step}>
                    <SkipForward size={12} /> Next bar
                  </Button>
                </div>
                <label className="mt-2 block">
                  Visible bars
                  <input
                    aria-label="Replay visible bars"
                    className="w-full"
                    type="range"
                    min="1"
                    max={bars.length}
                    value={state.replayCursor!}
                    onChange={(e) => patch({ replayCursor: Number(e.target.value) })}
                  />
                </label>
                <label>
                  Bars per second{" "}
                  <select
                    className="bg-panel-2"
                    value={speed}
                    onChange={(e) => setSpeed(Number(e.target.value))}
                  >
                    {[1, 2, 5, 10].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <Button
                  size="sm"
                  onClick={() => {
                    setPlaying(false);
                    patch({ replayCursor: 1 });
                  }}
                >
                  Reset
                </Button>
              </>
            )}
          </div>
          <details>
            <summary className="cursor-pointer font-medium">
              Compare symbols ({state.comparisons?.length ?? 0})
            </summary>
            <SymbolSearch
              onPick={(symbol) =>
                patch({
                  comparisons: [...new Set([...(state.comparisons ?? []), symbol])]
                    .filter((s) => s !== state.symbol)
                    .slice(0, 5),
                })
              }
            />
            {state.comparisons?.map((symbol) => (
              <div key={symbol} className="flex justify-between py-1">
                <span>{symbol}</span>
                <button
                  onClick={() =>
                    patch({ comparisons: state.comparisons!.filter((s) => s !== symbol) })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </details>
          <div className="flex items-center justify-between">
            <b>Drawing objects ({drawings.length})</b>
            <div className="flex">
              <IconButton
                label="Undo drawing"
                onClick={() => useCharts.getState().undoDrawing(state.symbol)}
              >
                <Undo2 size={13} />
              </IconButton>
              <IconButton
                label="Redo drawing"
                onClick={() => useCharts.getState().redoDrawing(state.symbol)}
              >
                <Redo2 size={13} />
              </IconButton>
            </div>
          </div>
          {drawings.map((d) => (
            <DrawingObject key={d.id} drawing={d} state={state} />
          ))}
        </div>
      </Popover>
    </div>
  );
}
function DrawingObject({ drawing: d, state }: { drawing: Drawing; state: ChartState }) {
  const [editing, setEditing] = useState(false),
    [points, setPoints] = useState(d.points.map((p) => ({ ...p }))),
    [text, setText] = useState(d.text ?? "");
  const update = (patch: Partial<Drawing>) =>
    useCharts.getState().updateDrawing(state.symbol, d.id, patch);
  return (
    <div className="rounded border border-line p-2">
      <div className="flex flex-wrap items-center gap-2">
        <b>{d.tool}</b>
        <button
          className="text-accent"
          onClick={() => chartControls.get(state.id)?.focus(d.points[0]?.t)}
        >
          Locate
        </button>
        <button onClick={() => update({ hidden: !d.hidden })}>{d.hidden ? "Show" : "Hide"}</button>
        <button onClick={() => update({ locked: !d.locked })}>
          {d.locked ? "Unlock" : "Lock"}
        </button>
        <button
          disabled={d.locked}
          onClick={() => {
            setPoints(d.points.map((p) => ({ ...p })));
            setText(d.text ?? "");
            setEditing(!editing);
          }}
        >
          Edit
        </button>
        <button
          disabled={d.locked}
          onClick={() => useCharts.getState().removeDrawing(state.symbol, d.id)}
        >
          Delete
        </button>
      </div>
      {editing && (
        <form
          className="mt-2 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (points.some((p) => !Number.isFinite(p.t) || !Number.isFinite(p.p))) {
              useApp
                .getState()
                .toast({ title: "Enter a valid time and price for each point", tone: "error" });
              return;
            }
            update({ points, text });
            setEditing(false);
          }}
        >
          {points.map((point, index) => (
            <div key={index} className="space-y-1">
              <label>
                Point {index + 1} time (UTC)
                <Input
                  type="datetime-local"
                  step="1"
                  value={new Date(point.t * 1000).toISOString().slice(0, 19)}
                  onChange={(e) => {
                    const t = Date.parse(e.target.value + "Z") / 1000;
                    if (Number.isFinite(t))
                      setPoints(points.map((p, i) => (i === index ? { ...p, t } : p)));
                  }}
                />
              </label>
              <label>
                Price
                <Input
                  type="number"
                  step="any"
                  value={point.p}
                  onChange={(e) =>
                    setPoints(
                      points.map((p, i) => (i === index ? { ...p, p: Number(e.target.value) } : p)),
                    )
                  }
                />
              </label>
            </div>
          ))}
          {d.tool === "text" && (
            <Input
              aria-label="Drawing text"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
          <Button size="sm" type="submit">
            Save drawing
          </Button>
        </form>
      )}
    </div>
  );
}
