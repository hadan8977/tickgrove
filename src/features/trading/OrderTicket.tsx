import { useEffect, useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { execute } from "../../core/commands";
import { isDemoData, marketRequest, marketSeries } from "../../data/feed";
import { useAccount } from "../../service/account";
import { useConnection } from "../../service/workspaceSync";
import { MarketBadge } from "../../service/MarketPanel";
import type { OrderType } from "../../core/types";
import { useApp, useCharts, usePaper } from "../../store";
import { useQuote } from "../../ui/hooks";
import { Button, Segmented, StatusBadge, cx, fmt } from "../../ui/primitives";

export default function OrderTicket() {
  const activeId = useApp((s) => s.activeChartId);
  const symbol = useCharts((s) => s.charts[activeId ?? ""]?.symbol) ?? "NVDA";
  const timeframe = useCharts((s) => s.charts[activeId ?? ""]?.tf) ?? "1m";
  const q = useQuote(symbol);
  const demo = isDemoData(),
    account = useAccount((s) => s.data);
  const permissions = useConnection((s) => s.permissions);
  const canTrade = demo || permissions.includes("paper.manage");
  const demoCash = usePaper((s) => s.cash);
  const demoPos = usePaper((s) => s.positions[symbol]);
  const identity = marketRequest(symbol);
  const cash = demo ? demoCash : (account?.cash ?? Number.NaN);
  const pos = demo
    ? demoPos
    : account?.positions.find(
        (p) => p.symbol === identity.symbol && p.provider === identity.provider,
      );
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<OrderType | "stop-limit">("market");
  const [stopPrice, setStopPrice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [qty, setQty] = useState(0);
  const [price, setPrice] = useState<string>("");
  useEffect(() => {
    setQty(0);
    setPrice("");
    setStopPrice("");
  }, [symbol]);
  const px = type === "market" ? q.last : Number(price) > 0 ? Number(price) : NaN;
  const notional = px * qty;
  const insufficient = side === "buy" && notional > cash;
  const executable =
    demo ||
    (!!account && account.quotePolicy.executableProviders?.includes(identity.provider) === true);
  const market = marketSeries(symbol, timeframe);
  const needsQuote = !demo && (market.error || market.streamError ||
    ["disconnected", "reconnecting", "connecting", "stopped"].includes(market.status));
  const submit = async () => {
    setSubmitting(true);
    try {
      await execute("paper.placeOrder", {
        symbol,
        side,
        qty,
        type,
        price: type === "market" ? undefined : Number(price),
        stopPrice: type === "stop-limit" ? Number(stopPrice) : undefined,
      });
    } catch (e) {
      useApp.getState().toast({ title: String(e), tone: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-auto bg-panel">
      <div className="flex items-center justify-between border-b border-demo/25 bg-demo/8 px-3 py-2 text-demo">
        <span className="flex items-center gap-1.5 text-[11.5px] font-medium">
          <ShieldCheck size={13} /> Paper account · simulated fills only
        </span>
        {demo ? (
          <StatusBadge status="demo" hatch={false} />
        ) : (
          <span className="text-xs">Server account</span>
        )}
      </div>
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-[15px] font-semibold tracking-tight">{symbol}</div>
            <div className="text-[11px] text-muted">
              Position: {pos ? `${pos.qty} @ ${q.format(pos.avg)}` : "flat"}
            </div>
          </div>
          <div className="num text-right">
            <div className="text-[16px] font-semibold">{q.format(q.last)}</div>
            <div className={cx("text-[11px]", q.change >= 0 ? "text-up" : "text-down")}>
              {fmt.pct(q.changePct)}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-panel-2 p-1 ring-1 ring-line">
          {(["buy", "sell"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={cx(
                "h-8 rounded-lg text-[12.5px] font-semibold capitalize transition-colors",
                side === s
                  ? s === "buy"
                    ? "bg-up text-white"
                    : "bg-down text-white"
                  : "text-muted hover:text-text",
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <Segmented
          layoutId="ticket-type"
          size="md"
          value={type}
          onChange={setType}
          options={[
            { value: "market", label: "Market" },
            { value: "limit", label: "Limit" },
            { value: "stop", label: "Stop" },
            ...(!demo ? [{ value: "stop-limit" as const, label: "Stop limit" }] : []),
          ]}
        />
        {!demo && <MarketBadge symbol={symbol} tf={timeframe} />}
        <Field label="Quantity">
          <div className="flex items-center gap-1">
            <input
              aria-label="Order quantity"
              type="number"
              min={0}
              step="any"
              placeholder="Enter quantity"
              value={qty || ""}
              onChange={(e) => setQty(Math.max(0, Number(e.target.value) || 0))}
              className="num h-8 min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-2.5 text-right text-[13px] outline-none focus:border-accent/60"
            />
            {[1, 10, 100].map((n) => (
              <button
                key={n}
                onClick={() => setQty(qty + n)}
                className="num h-8 rounded-lg bg-panel-2 px-2 text-[11px] text-muted ring-1 ring-line hover:text-text"
              >
                +{n}
              </button>
            ))}
          </div>
        </Field>
        {type !== "market" && (
          <Field label={type === "stop" ? "Stop price" : "Limit price"}>
            <input
              aria-label="Order limit or stop price"
              type="number"
              step="any"
              placeholder={q.format(q.last)}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="num h-8 w-full rounded-lg border border-line bg-panel-2 px-2.5 text-right text-[13px] outline-none focus:border-accent/60"
            />
          </Field>
        )}
        {type === "stop-limit" && (
          <Field label="Stop trigger">
            <input
              type="number"
              min="0"
              step="any"
              value={stopPrice}
              onChange={(e) => setStopPrice(e.target.value)}
              className="h-8 rounded-lg border border-line bg-panel-2 px-2"
            />
          </Field>
        )}
        <div className="num space-y-1 rounded-lg bg-panel-2/70 p-2.5 text-[11.5px]">
          <Row k="Est. notional" v={fmt.money(notional)} />
          <Row
            k={`Est. fee (${demo ? 1 : (account?.quotePolicy.commissionBps ?? "—")} bp)`}
            v={fmt.money(
              (notional * (demo ? 1 : (account?.quotePolicy.commissionBps ?? NaN))) / 10000,
            )}
          />
          <Row k="Buying power" v={fmt.money(cash)} warn={insufficient} />
        </div>
        {!canTrade && (
          <p className="text-xs text-demo">This connection is read-only for paper trading.</p>
        )}
        {!demo && !account && <p className="text-xs text-muted">Loading paper account…</p>}
        {needsQuote && <div role="status" className="rounded-lg bg-demo/10 p-2 text-xs text-demo">
          <p>This chart is showing cached data or its source is reconnecting. Simulated fills require a fresh, valid quote from this source.</p>
          <button className="mt-1 underline" onClick={() => useApp.getState().setView("market")}>Open data settings</button>
        </div>}
        {!executable && account && (
          <p className="text-xs text-demo">
            This source has no verified executable quote policy. Select Coinbase or a configured
            Alpaca feed for local order simulation.
          </p>
        )}
        <Button
          variant={side === "buy" ? "up" : "down"}
          className="h-10 text-[13px]"
          onClick={submit}
          disabled={
            !canTrade ||
            !executable ||
            submitting ||
            qty <= 0 ||
            !Number.isFinite(px) ||
            (type === "stop-limit" && !(Number(stopPrice) > 0))
          }
        >
          {side === "buy" ? "Buy" : "Sell"} {qty} {symbol} · {type}
        </Button>
        <div className="text-center text-[11px] text-faint">
          Orders route to the local paper broker. No real order is ever sent.
        </div>
        <p className="text-center text-[11px] text-muted">Broker trading is not connected.</p>
      </div>
    </div>
  );
}
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="flex flex-col gap-1">
    <span className="text-[11px] font-medium text-muted">{label}</span>
    {children}
  </label>
);
const Row = ({ k, v, warn }: { k: string; v: string; warn?: boolean }) => (
  <div className="flex justify-between">
    <span className="text-muted">{k}</span>
    <span className={warn ? "text-down" : ""}>{v}</span>
  </div>
);
