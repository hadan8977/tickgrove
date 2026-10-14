import { useState } from "react";
import { command } from "./client";
import { TIMEFRAMES, type Timeframe } from "../core/types";
import type { MarketHistoryResult } from "../core/marketTypes";
import { Button, Input, Select } from "../ui/primitives";
import { useApp } from "../store";
export let preferredSnapshot = "";
export default function PortfolioData() {
  const [symbols, setSymbols] = useState("SPY, TLT, QQQ"),
    [provider, setProvider] = useState("yahoo"),
    [tf, setTf] = useState<Timeframe>("1D");
  const [start, setStart] = useState(
      new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10),
    ),
    [end, setEnd] = useState(new Date().toISOString().slice(0, 10)),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [snapshot, setSnapshot] = useState<any>();
  async function load() {
    setBusy(true);
    setError("");
    setSnapshot(undefined);
    try {
      const requested = [
        ...new Set(
          symbols
            .toUpperCase()
            .split(/[\s,]+/)
            .filter(Boolean),
        ),
      ];
      if (!requested.length || requested.length > 32)
        throw Error("Enter between 1 and 32 provider symbols");
      const records: MarketHistoryResult[] = [];
      for (const symbol of requested) {
        setProgress(`Loading ${symbol} (${records.length + 1}/${requested.length})`);
        records.push(
          await command<MarketHistoryResult>("market.history", {
            provider,
            symbol,
            timeframe: tf,
            start: Date.parse(start + "T00:00:00Z") / 1000,
            end: Math.min(Date.now() / 1000, Date.parse(end + "T00:00:00Z") / 1000 + 86400),
            adjustment: provider === "coinbase" ? "none" : "raw",
            allowGaps: false,
          }),
        );
      }
      const first = records[0];
      for (const row of records)
        if (
          row.data.bars.length !== first.data.bars.length ||
          row.data.bars.some((bar, i) => bar.time !== first.data.bars[i].time)
        )
          throw Error(
            `${row.identity.symbol} has a different trading calendar or incomplete range. Choose a shared complete range; no rows were filled or silently removed.`,
          );
      const data = {
        ...first.data,
        datasets: records.slice(1).map((row) => row.data),
        metadata: {
          ...first.data.metadata,
          provenance: {
            ...first.provenance,
            portfolioSources: records.map((row) => ({
              identity: row.identity,
              snapshot_id: row.snapshot_id,
              hash: row.hash,
              gaps: row.gaps,
            })),
          },
        },
      };
      const result = await command("data.import", { data });
      preferredSnapshot = result.id;
      setSnapshot({ ...result, symbols: requested });
      setProgress("");
    } catch (e) {
      setError(String(e));
      setProgress("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-6 rounded-xl border border-line p-4">
      <h2 className="font-semibold">Portfolio and cross-symbol data</h2>
      <p className="my-2 text-xs text-muted">
        Build a reproducible multi-instrument snapshot for Composer or Pine request.security. Each
        series must have a complete, matching bar calendar.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs">
          Provider
          <Select className="block" value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="yahoo">Yahoo stocks / ETFs</option>
            <option value="coinbase">Coinbase</option>
            <option value="alpaca">Alpaca (configured host)</option>
          </Select>
        </label>
        <label className="text-xs">
          Provider symbols
          <Input
            aria-label="Portfolio symbols"
            value={symbols}
            onChange={(e) => setSymbols(e.target.value)}
          />
        </label>
        <label className="text-xs">
          Interval
          <Select className="block" value={tf} onChange={(e) => setTf(e.target.value as Timeframe)}>
            {TIMEFRAMES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </label>
        <label className="text-xs">
          Start (UTC)
          <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="text-xs">
          End (UTC)
          <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <Button disabled={busy} onClick={() => void load()}>
          Load portfolio snapshot
        </Button>
      </div>
      {progress && <p className="mt-3 text-xs">{progress}</p>}
      {error && (
        <p role="alert" className="mt-3 text-xs text-down">
          {error}
        </p>
      )}
      {snapshot && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <span>
            {snapshot.symbols.join(", ")} · {snapshot.bars} aligned bars ·{" "}
            {snapshot.hash.slice(0, 12)}
          </span>
          <Button size="sm" onClick={() => useApp.getState().setView("operations")}>
            Use in saved strategy run
          </Button>
        </div>
      )}
    </section>
  );
}
