import { useState } from "react";
import { execute } from "../core/commands";
import { isDemoData } from "../data/feed";
import { useAccount } from "../service/account";
import { useApp, useCharts, usePaper } from "../store";
import { useQuote } from "../ui/hooks";
import { Button, fmt } from "../ui/primitives";

export default function PositionSizer() {
  const activeId = useApp((s) => s.activeChartId);
  const symbol = useCharts((s) => s.charts[activeId ?? ""]?.symbol) ?? "NVDA";
  const demoCash = usePaper((s) => s.cash);
  const account = useAccount((s) => s.data);
  const cash = isDemoData() ? demoCash : (account?.equity ?? NaN);
  const q = useQuote(symbol);
  const [risk, setRisk] = useState(1);
  const [stop, setStop] = useState(5);
  const qty = Math.floor((cash * risk) / 100 / ((q.last * stop) / 100));
  return (
    <div className="flex h-full flex-col gap-3 overflow-auto bg-panel p-3">
      <div className="text-[11px] text-muted">Position size estimate</div>
      <div className="flex justify-between">
        <span className="font-semibold">{symbol}</span>
        <span className="num">{q.format(q.last)}</span>
      </div>
      {(
        [
          ["Risk per trade", risk, setRisk, 0.25, 5, 0.25],
          ["Stop distance", stop, setStop, 0.5, 20, 0.5],
        ] as const
      ).map(([l, v, set, min, max, step]) => (
        <label key={l} className="flex flex-col gap-1 text-[12px]">
          <span className="flex justify-between text-muted">
            {l} <span className="num text-text">{v}%</span>
          </span>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={v}
            onChange={(e) => set(Number(e.target.value))}
            className="accent-[var(--accent)]"
          />
        </label>
      ))}
      <div className="rounded-xl bg-panel-2 p-3 ring-1 ring-line">
        <div className="text-[10.5px] uppercase tracking-wider text-faint">Suggested size</div>
        <div className="num text-[22px] font-semibold">
          {Number.isFinite(qty) ? qty.toLocaleString() : "—"}{" "}
          <span className="text-[13px] text-muted">units</span>
        </div>
        <div className="num text-[11.5px] text-muted">
          Notional {fmt.money(qty * q.last)} · assumed stop {q.format(q.last * (1 - stop / 100))} ·
          planned risk {fmt.money((cash * risk) / 100)} before fees and slippage
        </div>
      </div>
      <p className="text-xs text-muted">
        This is a sizing calculation. It does not place an order or a protective stop; actual loss
        can exceed this estimate.
      </p>
      <Button
        disabled={!Number.isFinite(qty) || qty <= 0}
        onClick={() => execute("panel.open", { panel: "ticket" }, "plugin")}
      >
        Open order ticket
      </Button>
    </div>
  );
}
