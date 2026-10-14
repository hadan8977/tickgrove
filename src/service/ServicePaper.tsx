import { useEffect, useState } from "react";
import { command } from "./client";
export default function ServicePaper({
  version,
  snapshot,
  inputs,
  onReport,
}: {
  version: string;
  snapshot: string;
  inputs: string;
  onReport: (id: string) => Promise<void>;
}) {
  const [sessions, setSessions] = useState<any[]>([]),
    [error, setError] = useState("");
  const [stream, setStream] = useState<"market" | "manual">("market"),
    [busy, setBusy] = useState(false);
  const refresh = async () => setSessions(await command("paper.list"));
  const act = async (fn: () => Promise<unknown>) => {
    try {
      setError("");
      setBusy(true);
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void act(refresh);
    const timer = setInterval(() => void refresh().catch((e) => setError(String(e))), 1500);
    return () => clearInterval(timer);
  }, []);
  const startSelected = async () => {
    if (!snapshot) throw Error("Select a data snapshot before deploying");
    let subscription_id: string | undefined;
    if (stream === "market") {
      const data = await command("data.get", { snapshot_id: snapshot }),
        identity = data.metadata?.identity;
      if (!identity?.provider)
        throw Error(
          "This snapshot has no market-source identity. Import market history or select imported events.",
        );
      const subscribed = await command("market.subscribe", {
        provider: identity.provider,
        symbol: identity.symbol,
        timeframe: identity.timeframe,
        session: identity.session,
        adjustment: identity.adjustment,
        ...(identity.provider === "alpaca" ? { feed: identity.feed } : {}),
      });
      subscription_id = subscribed.subscription_id;
    }
    await command("paper.deploy", {
      version_id: version,
      snapshot_id: snapshot,
      inputs: JSON.parse(inputs),
      execution: "closed_bar_native",
      subscription_id,
    });
  };
  const start = async () => {
    const data = await (await fetch("/examples/composer/synthetic-etfs.json")).json();
    data.bars = data.bars.slice(0, 64);
    for (const d of data.datasets) d.bars = d.bars.slice(0, 64);
    const snapshot = await command("data.import", { data });
    await command("paper.deploy", {
      version_id: version,
      snapshot_id: snapshot.id,
      inputs: JSON.parse(inputs),
      execution: "closed_bar_native",
    });
  };
  const appendExample = async (session: any) => {
    const visible = await command("data.get", {
      snapshot_id: session.snapshot_id,
    });
    const example = await (await fetch("/examples/composer/synthetic-etfs.json")).json();
    if (
      visible.symbol !== example.symbol ||
      visible.timeframe !== example.timeframe ||
      JSON.stringify(visible.bars) !== JSON.stringify(example.bars.slice(0, visible.bars.length)) ||
      JSON.stringify(visible.datasets) !==
        JSON.stringify(
          example.datasets.map((d: any) => ({
            ...d,
            bars: d.bars.slice(0, visible.bars.length),
          })),
        )
    )
      throw Error(
        "Example append is only allowed for the exact example prefix; import your own market events for other snapshots",
      );
    const bar = example.bars.find((b: any) => b.time > visible.bars.at(-1).time);
    if (!bar) throw Error("Example feed exhausted");
    const bars: Record<string, any> = { [example.symbol]: bar };
    for (const d of example.datasets) bars[d.symbol] = d.bars.find((b: any) => b.time === bar.time);
    await command("paper.append", {
      session_id: session.session_id,
      event_id: `example-${bar.time}`,
      bars,
    });
  };
  return (
    <section className="mt-5 rounded border border-line p-4">
      <h2 className="text-sm font-semibold">2. Start continuous paper trading</h2>
      <p className="my-2 text-xs text-muted">
        Follow new confirmed bars from the selected dataset's source. Each strategy keeps a separate
        simulated ledger. This runs after bars close; it does not place broker orders.
      </p>
      <button
        disabled={busy || !version || !snapshot}
        className="mr-2 rounded bg-accent text-accent-ink p-2 text-xs disabled:opacity-30"
        onClick={() => void act(startSelected)}
      >
        Start with selected strategy
      </button>
      <label className="mr-3 text-xs">
        Input stream{" "}
        <select
          className="rounded border border-line bg-panel-2 p-2"
          value={stream}
          onChange={(e) => setStream(e.target.value as "market" | "manual")}
        >
          <option value="market">Follow market source</option>
          <option value="manual">Imported events</option>
        </select>
      </label>
      {stream === "manual" && (
        <button
          disabled={busy || !version}
          className="rounded bg-panel-2 p-2 text-xs disabled:opacity-30"
          onClick={() => void act(start)}
        >
          Start explicit 64-bar synthetic example
        </button>
      )}
      {sessions.map((s) => (
        <div key={s.session_id} className="my-2 rounded bg-panel-2 p-3 text-xs">
          <div className="flex flex-wrap gap-3">
            <b>{s.session_id.slice(0, 8)}</b>
            <span>{s.status}</span>
            <button
              disabled={busy || s.status === "stopped"}
              onClick={() => void act(() => command("paper.stop", { session_id: s.session_id }))}
            >
              Stop session
            </button>
            {!s.subscription_id && (
              <>
                <button
                  disabled={busy || !!s.pending_job_id || s.status === "stopped"}
                  onClick={() => void act(() => appendExample(s))}
                >
                  Append next example closed bar
                </button>
                <label>
                  Import event JSON
                  <input
                    type="file"
                    accept=".json"
                    className="ml-2 max-w-40"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file)
                        void act(async () => {
                          const event = JSON.parse(await file.text());
                          await command("paper.append", {
                            ...event,
                            session_id: s.session_id,
                          });
                        });
                    }}
                  />
                </label>
              </>
            )}
            <button
              disabled={busy || !["active", "paused"].includes(s.status) || !!s.pending_job_id}
              onClick={() =>
                void act(async () => {
                  await command(s.status === "active" ? "paper.pause" : "paper.resume", {
                    session_id: s.session_id,
                  });
                })
              }
            >
              {s.status === "active" ? "Pause" : "Resume"}
            </button>
            {s.last_job_id && (
              <button onClick={() => void act(() => onReport(s.last_job_id))}>
                Committed ledger
              </button>
            )}
            {s.pending_job_id && (
              <>
                <button onClick={() => void act(() => onReport(s.pending_job_id))}>
                  Pending job
                </button>
                <button
                  onClick={() =>
                    void act(async () => {
                      await command("backtest.cancel", {
                        job_id: s.pending_job_id,
                      });
                    })
                  }
                >
                  Cancel pending
                </button>
                <button
                  onClick={() =>
                    void act(async () => {
                      await command("paper.retry", { session_id: s.session_id });
                    })
                  }
                >
                  Retry pending
                </button>
                <button
                  onClick={() =>
                    void act(async () => {
                      await command("paper.discard", {
                        session_id: s.session_id,
                      });
                    })
                  }
                >
                  Discard failed pending
                </button>
              </>
            )}
          </div>
          {s.error && (
            <p role="alert" className="mt-2 break-words text-down">
              {s.error}
            </p>
          )}
          <span className="mt-2 block text-muted">
            Committed snapshot {s.snapshot_id.slice(0, 12)} ·{" "}
            {s.pending_job_id ? "pending market event" : "ready for next event"}
          </span>
        </div>
      ))}
      {error && (
        <p role="alert" className="text-down">
          {error}
        </p>
      )}
    </section>
  );
}
