import { useEffect, useId, useState } from "react";
import { SYMBOLS, searchMarket, isDemoData, type Instrument } from "../../data/feed";
import { Input, cx } from "../../ui/primitives";
import { currentSearchRows, rankInstrumentResults, searchKey, type SearchResult } from "./searchState";

export default function SymbolSearch({ onPick, autoFocus = true }: { onPick: (s: string) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [provider, setProvider] = useState("");
  const [remote, setRemote] = useState<SearchResult<Instrument>>({ key: "", rows: [], loading: false });
  const [retry, setRetry] = useState(0);
  const listId = useId();
  const key = searchKey(q, provider);
  const needsRemote = !!q.trim() && !isDemoData();
  const loading = needsRemote && (remote.key !== key || remote.loading);
  const error = needsRemote && remote.key === key ? remote.error : "";
  const list = rankInstrumentResults(needsRemote ? currentSearchRows(remote, key) : SYMBOLS.filter((s) =>
    (s.symbol + s.name + s.sector).toLowerCase().includes(q.toLowerCase())), q);
  useEffect(() => {
    if (!needsRemote) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setRemote({ key, rows: [], loading: true });
      void searchMarket(q.trim(), provider || undefined).then((rows) => {
        if (!cancelled) setRemote({ key, rows, loading: false });
      }).catch((error) => {
        if (!cancelled) setRemote({ key, rows: [], loading: false, error: String(error) });
      });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [key, needsRemote, retry]);
  return (
    <div>
      {!isDemoData() && <select aria-label="Search provider" value={provider} onChange={(e) => { setProvider(e.target.value); setIdx(0); }} className="mb-2 w-full rounded bg-panel-2 p-1 text-xs"><option value="">All configured providers</option><option value="yahoo">Yahoo equities / ETFs</option><option value="coinbase">Coinbase products</option><option value="alpaca">Alpaca instruments</option></select>}
      <Input
        autoFocus={autoFocus}
        role="combobox"
        aria-label="Search instruments"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={list[idx] ? `${listId}-${idx}` : undefined}
        placeholder="Search symbol, company or sector"
        value={q}
        onChange={(e) => { setQ(e.target.value); setIdx(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.max(0, Math.min(i + 1, list.length - 1))); }
          if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
          if (e.key === "Enter") { e.preventDefault(); if (!loading && list[idx]) onPick(list[idx].symbol); }
        }}
      />
      <div id={listId} role="listbox" aria-label="Matching instruments" aria-busy={loading} className="mt-1.5 max-h-[320px] overflow-auto">
        {list.map((s, i) => (
          <button key={s.symbol} id={`${listId}-${i}`} role="option" aria-selected={i === idx} onClick={() => onPick(s.symbol)} className={cx("flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left", i === idx ? "bg-accent/14" : "hover:bg-panel-3/70")}>
            <span className="w-20 shrink-0 truncate font-semibold" title={s.symbol}>{s.symbol.split(":").at(-1)}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{s.name}</span>
            <span className="shrink-0 text-[11px] text-muted">{s.exchange}</span>
          </button>
        ))}
        {loading && <p role="status" className="p-2 text-xs text-muted">Searching instruments…</p>}
        {error && <div role="alert" className="p-2 text-xs text-down">{error}<button className="ml-2 underline" onClick={() => setRetry((n) => n + 1)}>Retry search</button></div>}
        {!list.length && !loading && !error && <div className="p-3 text-center text-[12px] text-muted">No instrument matches “{q}”. Try its ticker or another data source.</div>}
      </div>
    </div>
  );
}
