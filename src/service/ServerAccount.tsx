import { useEffect, useRef, useState } from "react";
import { useAccount, refreshAccount, accountAction } from "./account";
import { command } from "./client";
import { Button, Input, Select, fmt, cx } from "../ui/primitives";
import { useApp } from "../store";
import ServiceReport from "./ServiceReport";

function download(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
export default function ServerAccount() {
  const selectedSessionId = useApp((s) => s.paperSessionId);
  const selectedRow = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<string | null>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const { data, error } = useAccount(),
    [tab, setTab] = useState("positions"),
    [sessions, setSessions] = useState<any[]>([]),
    [failure, setFailure] = useState(""),
    [notice, setNotice] = useState(""),
    [flattenFeeds, setFlattenFeeds] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<any>(),
    [qty, setQty] = useState(""),
    [price, setPrice] = useState(""),
    [stop, setStop] = useState(""),
    [reset, setReset] = useState(false);
  const [report, setReport] = useState<any>(),
    [reportData, setReportData] = useState<any>();
  async function refresh() {
    await refreshAccount();
    setSessions(await command("paper.list"));
  }
  useEffect(() => {
    if (!selectedSessionId) return;
    setTab("strategies");
    setReport(undefined); setReportData(undefined);
    void refresh().catch((e) => setFailure(String(e)));
  }, [selectedSessionId]);
  useEffect(() => {
    if (tab !== "strategies" || !selectedSessionId || lastFocused.current === selectedSessionId || !selectedRow.current) return;
    selectedRow.current.scrollIntoView({ block: "nearest" });
    selectedRow.current.focus({ preventScroll: true });
    lastFocused.current = selectedSessionId;
  }, [sessions, selectedSessionId, tab]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setFailure("");
    setNotice("");
    try {
      const result = (await fn()) as any;
      if (result?.status === "rejected") throw Error(result.error || "Order rejected");
      if (result?.status)
        setNotice(`Order ${result.status}. See Orders for fill or rejection details.`);
      await refresh();
    } catch (e) {
      setFailure(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void act(refresh);
    void command<any[]>("strategy.list").then(setVersions).catch((e) => setFailure(String(e)));
    const timer = setInterval(() => void refresh().catch((e) => setFailure(String(e))), 2000);
    return () => clearInterval(timer);
  }, []);
  const stats = [
    ["Equity", data?.equity],
    ["Cash", data?.cash],
    ["Unrealized", data?.unrealizedPnl],
    ["Realized", data?.realizedPnl],
    ["Fees", data?.totalFees],
  ] as const;
  return (
    <div className="flex h-full flex-col bg-panel text-xs">
      <div className="flex flex-wrap items-center gap-4 border-b border-line p-3">
        <span className="text-accent">MANUAL PAPER ACCOUNT</span>
        {stats.map(([label, value]) => (
          <div key={label}>
            <div className="text-faint">{label}</div>
            <div className="num mt-1">{fmt.money(value ?? NaN)}</div>
          </div>
        ))}
        <div className="flex-1" />
        <Button size="sm" onClick={() => download(data, "local-account.json")}>
          Export
        </Button>
        <Button size="sm" onClick={() => setReset(true)}>
          Reset account
        </Button>
      </div>
      <div className="flex gap-1 border-b border-line p-2">
        {["positions", "orders", "fills", "strategies"].map((name) => (
          <button
            key={name}
            onClick={() => setTab(name)}
            className={cx(
              "rounded px-3 py-1 capitalize",
              tab === name ? "bg-panel-3 text-text" : "text-muted",
            )}
          >
            {name}
          </button>
        ))}
      </div>
      {(failure || error) && (
        <p role="alert" className="bg-down/10 p-2 text-down">
          {failure || error}
        </p>
      )}
      {reset && (
        <div className="flex items-center gap-2 bg-demo/10 p-3">
          <span>Reset this local account to $100,000 and clear its orders and positions?</span>
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await accountAction("account.reset", {
                  confirm: "RESET_LOCAL_ACCOUNT",
                });
                setReset(false);
              })
            }
          >
            Reset local account
          </Button>
          <Button onClick={() => setReset(false)}>Keep account</Button>
        </div>
      )}
      {editing && (
        <form
          className="flex flex-wrap items-end gap-2 border-b border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await accountAction("account.modifyOrder", {
                id: editing.id,
                qty: Number(qty),
                ...(["limit", "stop-limit"].includes(editing.type) ? { price: Number(price) } : {}),
                ...(["stop", "stop-limit"].includes(editing.type)
                  ? { stopPrice: Number(stop) }
                  : {}),
              });
              setEditing(undefined);
            });
          }}
        >
          <b>
            Modify {editing.symbol} · {editing.type}
          </b>
          <label>
            Quantity
            <Input
              type="number"
              min="0"
              step="any"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </label>
          {["limit", "stop-limit"].includes(editing.type) && (
            <label>
              Limit
              <Input
                type="number"
                step="any"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </label>
          )}
          {["stop", "stop-limit"].includes(editing.type) && (
            <label>
              Stop
              <Input
                type="number"
                step="any"
                value={stop}
                onChange={(e) => setStop(e.target.value)}
              />
            </label>
          )}
          <Button type="submit" disabled={busy}>
            Save order
          </Button>
          <Button onClick={() => setEditing(undefined)}>Close</Button>
        </form>
      )}
      {notice && (
        <p role="status" className="p-2 text-xs text-muted">
          {notice}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "positions" && (
          <Table
            heads={["Market", "Qty", "Average", "Last", "Unrealized", ""]}
            empty="No open positions"
          >
            {data?.positions.map((p) => (
              <tr key={`${p.provider}:${p.symbol}`}>
                <td>
                  {p.provider}:{p.symbol}
                </td>
                <td>{p.qty}</td>
                <td>{fmt.price(p.avg)}</td>
                <td>{fmt.price(p.last)}</td>
                <td>{fmt.money(p.unrealizedPnl)}</td>
                <td>
                  {p.provider === "alpaca" && (
                    <Select
                      aria-label={`Closing quote feed for ${p.symbol}`}
                      value={flattenFeeds[p.provider + ":" + p.symbol] ?? ""}
                      onChange={(e) =>
                        setFlattenFeeds({
                          ...flattenFeeds,
                          [p.provider + ":" + p.symbol]: e.target.value,
                        })
                      }
                    >
                      <option value="">Select closing quote feed</option>
                      <option value="iex">IEX</option>
                      <option value="sip">SIP</option>
                    </Select>
                  )}
                  <Button
                    size="sm"
                    disabled={
                      busy ||
                      (p.provider === "alpaca" && !flattenFeeds[p.provider + ":" + p.symbol])
                    }
                    onClick={() => {
                      setTab("orders");
                      void act(() =>
                        accountAction("account.flatten", {
                          ...(p.provider === "alpaca"
                            ? { feed: flattenFeeds[p.provider + ":" + p.symbol] }
                            : {}),
                          provider: p.provider,
                          symbol: p.symbol,
                          client_order_id: crypto.randomUUID(),
                        }),
                      );
                    }}
                  >
                    Flatten
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
        {tab === "orders" && (
          <Table
            heads={["Time", "Market", "Side", "Type", "Qty", "Limit / stop", "Status", ""]}
            empty="No orders"
          >
            {data?.orders.map((o) => (
              <tr key={o.id}>
                <td>{new Date(o.createdAt).toLocaleString()}</td>
                <td>
                  {o.provider}:{o.symbol}
                </td>
                <td>{o.side}</td>
                <td>{o.type}</td>
                <td>{o.qty}</td>
                <td>
                  {fmt.price(o.price ?? NaN)} / {fmt.price(o.stopPrice ?? NaN)}
                </td>
                <td>
                  {o.status}
                  {o.error && <span className="block text-down">{o.error}</span>}
                </td>
                <td>
                  {["working", "triggered"].includes(o.status) && (
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setEditing(o);
                          setQty(String(o.qty));
                          setPrice(String(o.price ?? ""));
                          setStop(String(o.stopPrice ?? ""));
                        }}
                      >
                        Modify
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void act(() => accountAction("account.cancelOrder", { id: o.id }))
                        }
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
        {tab === "fills" && (
          <Table
            heads={["Time", "Market", "Side", "Quantity", "Price", "Fee", "Source event"]}
            empty="No fills"
          >
            {data?.fills.map((f) => (
              <tr key={f.id}>
                <td>{new Date(f.time).toLocaleString()}</td>
                <td>
                  {f.provider}:{f.symbol}
                </td>
                <td>{f.side}</td>
                <td>{f.qty}</td>
                <td>{fmt.price(f.price)}</td>
                <td>{fmt.money(f.fee)}</td>
                <td>{f.marketCursor}</td>
              </tr>
            ))}
          </Table>
        )}
        {tab === "strategies" && (
          <div className="p-3">
            <p className="mb-3 text-muted">
              Each strategy runs in a separate simulated account after bars close. Its results do
              not change the manual account totals above. No broker orders are placed.
            </p>
            {!sessions.length && (
              <p>Run a backtest, then deploy its saved version to a market stream.</p>
            )}
            {sessions.map((s) => (
              <div key={s.session_id} data-paper-session={s.session_id}
                ref={s.session_id === selectedSessionId ? selectedRow : undefined}
                tabIndex={s.session_id === selectedSessionId ? -1 : undefined}
                className={cx("mb-2 rounded border p-3 outline-none", s.session_id === selectedSessionId ? "border-accent bg-accent/5" : "border-line")}>
                <div className="flex flex-wrap items-center gap-3">
                  <b>{s.name ?? versions.find((v) => v.id === s.version_id)?.name ?? "Strategy run"}</b>
                  <span>{s.status}</span>
                  {s.session_id === selectedSessionId && <span className="text-accent">Selected run</span>}
                  <span className="text-muted">
                    {s.subscription_id ? "Bound market stream" : "Imported event stream"}
                  </span>
                  {["active", "paused"].includes(s.status) && (
                    <Button
                      size="sm"
                      disabled={busy || !!s.pending_job_id}
                      onClick={() =>
                        void act(() =>
                          command(s.status === "active" ? "paper.pause" : "paper.resume", {
                            session_id: s.session_id,
                          }),
                        )
                      }
                    >
                      {s.status === "active" ? "Pause" : "Resume"}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    disabled={busy || s.status === "stopped"}
                    onClick={() =>
                      void act(() => command("paper.stop", { session_id: s.session_id }))
                    }
                  >
                    Stop
                  </Button>
                  {s.last_job_id && (
                    <Button
                      size="sm"
                      onClick={() =>
                        void act(async () => {
                          const r = await command("backtest.results", {
                            job_id: s.last_job_id,
                          });
                          setReport(r);
                          setReportData(
                            await command("data.get", {
                              snapshot_id: r.manifest.snapshot_id,
                            }),
                          );
                        })
                      }
                    >
                      Committed ledger
                    </Button>
                  )}
                  {s.pending_job_id && (
                    <>
                      <Button
                        size="sm"
                        onClick={() =>
                          void act(() =>
                            command("paper.retry", {
                              session_id: s.session_id,
                            }),
                          )
                        }
                      >
                        Retry pending
                      </Button>
                      <Button
                        size="sm"
                        onClick={() =>
                          void act(() =>
                            command("paper.discard", {
                              session_id: s.session_id,
                            }),
                          )
                        }
                      >
                        Discard failed pending
                      </Button>
                    </>
                  )}
                </div>
                {s.error && <p className="mt-2 text-down">{s.error}</p>}
                <p className="mt-2 text-faint">
                  {s.status === "stopped" ? "Stopped — no new bars will be processed" : s.status === "paused" ? "Paused — resume to process new confirmed bars" : s.pending_job_id ? "Processing a confirmed market bar" : "Waiting for the next confirmed market bar"}
                </p>
                <details className="mt-2 text-muted"><summary className="cursor-pointer">Run details</summary>
                  <p className="mt-1 break-all">Run {s.session_id} · saved version {s.version_id} · snapshot {s.snapshot_id}</p>
                </details>
              </div>
            ))}
            {report && reportData && <ServiceReport report={report} data={reportData} />}
          </div>
        )}
      </div>
    </div>
  );
}
function Table({
  heads,
  empty,
  children,
}: {
  heads: string[];
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <table className="num w-full text-right [&_td]:px-3 [&_td]:py-2">
      <thead className="sticky top-0 bg-panel-2">
        <tr>
          {heads.map((h, i) => (
            <th className="px-3 py-2 font-medium text-muted" key={i}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {children}
        {(!children || (Array.isArray(children) && !children.length)) && (
          <tr>
            <td className="text-center text-muted" colSpan={heads.length}>
              {empty}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
