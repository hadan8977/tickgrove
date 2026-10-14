import ChartCanvas from "../features/chart/ChartCanvas";
import type { ChartState } from "../core/types";
import { useEffect, useRef } from "react";
import { AreaSeries, ColorType, createChart, type Time } from "lightweight-charts";
import { fmt } from "../ui/primitives";
export default function ServiceReport({ report, data }: { report: any; data: any }) {
  const root = useRef<HTMLDivElement>(null);
  const result = report?.result;
  const equity = result?.backtest?.equity ?? result?.equity ?? [];
  const metrics = result?.backtest?.metrics ?? result?.metrics ?? {};
  useEffect(() => {
    if (!root.current || !equity.length) return;
    const chart = createChart(root.current, {
      height: 260,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: getComputedStyle(document.body).color,
        fontFamily: getComputedStyle(document.body).fontFamily,
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      autoSize: true,
    });
    chart
      .addSeries(AreaSeries, {
        lineColor: "#8b7dff",
        topColor: "#8b7dff55",
        bottomColor: "#8b7dff00",
      })
      .setData(equity.map((e: any) => ({ time: e.time as Time, value: e.value })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [report]);

  const [initial, final] = [equity[0]?.value, equity.at(-1)?.value];
  return (
    <section className="report-panel mt-5 min-w-0">
      <h2 className="text-lg">
        {result?.title ?? "Run report"} · {report.status}
      </h2>
      <p className="text-xs text-muted">
        {report.manifest.execution} · snapshot {report.manifest.snapshot_hash?.slice(0, 12)}
      </p>
      <div className="report-summary my-3 grid gap-2">
        {Object.entries({
          Initial: initial,
          Final: final,
          "Net profit": metrics.netProfit,
          "Return %": metrics.netProfitPct,
        }).map(([key, value]) => (
          <div key={key} className="rounded bg-panel-2 p-3">
            <span className="block text-xs text-muted">{key}</span>
            <strong>{typeof value === "number" ? value.toFixed(2) : "—"}</strong>
          </div>
        ))}
      </div>
      <div ref={root} aria-label="Persistent equity chart" />
      {data?.bars && (
        <div
          className="relative my-3 h-[420px]"
          aria-label="Snapshot candles and original Pine rendering"
        >
          <ChartCanvas
            key={report.job_id}
            state={
              {
                id: "server-report",
                symbol: data.symbol,
                tf: data.timeframe,
                group: null,
                style: "candles",
                indicators: [],
              } as ChartState
            }
            authoritative={{
              bars: data.bars,
              result: result?.kind === "composer" ? undefined : result,
            }}
            onLegend={() => {}}
            onHover={() => {}}
          />
        </div>
      )}
      {(result?.warnings ?? []).map((warning: string) => (
        <p key={warning} className="text-demo">
          {warning}
        </p>
      ))}
      <div className="max-h-72 overflow-auto">
        <table className="w-full min-w-[600px] whitespace-nowrap text-left text-xs">
          <thead>
            <tr>
              {["Entry", "Exit", "Side", "Qty", "Entry price", "Exit price", "P&L", "Fee"].map(
                (x) => (
                  <th key={x} className="p-2">
                    {x}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {(result?.backtest?.trades ?? []).map((t: any) => (
              <tr key={t.id} className="border-t border-line">
                {[
                  new Date(t.entryTime * 1000).toISOString(),
                  new Date(t.exitTime * 1000).toISOString(),
                  t.side,
                  t.qty,
                  t.entryPrice,
                  t.exitPrice,
                  t.pnl,
                  t.commission,
                ].map((v, i) => (
                  <td key={i} className="p-2">
                    {typeof v === "number"
                      ? v.toLocaleString("en-US", { maximumSignificantDigits: 12 })
                      : v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result?.frames && (
        <div className="max-h-96 overflow-auto">
          <h3 className="my-3">Allocation decisions and fills</h3>
          {result.frames.slice(-40).map((frame: any) => (
            <div key={frame.time} className="border-t border-line py-2 text-xs">
              <b>{new Date(frame.time * 1000).toISOString()}</b> · equity {frame.equity.toFixed(2)}{" "}
              · cash {frame.cash.toFixed(2)}
              <div>{frame.reason.join("; ")}</div>
              <div>
                Targets {JSON.stringify(frame.weights)} · quantities{" "}
                {JSON.stringify(frame.positions)}
              </div>
              <div>
                {frame.orders
                  .map(
                    (o: any) =>
                      `${
                        o.qty > 0 ? "Buy" : "Sell"
                      } ${Math.abs(o.qty).toLocaleString("en-US", { maximumSignificantDigits: 12 })} ${o.symbol} @ ${fmt.price(o.price)} fee ${fmt.money(o.commission)}`,
                  )
                  .join("; ")}
              </div>
            </div>
          ))}
        </div>
      )}
      <details className="mt-3">
        <summary>Manifest, open positions and pending orders</summary>
        <pre className="max-h-64 overflow-auto text-xs">
          {JSON.stringify(
            {
              manifest: report.manifest,
              openPositions: result?.backtest?.openPositions,
              pendingOrders: result?.backtest?.pendingOrders,
              pendingWeights: result?.pendingWeights,
              error: report.error,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}
