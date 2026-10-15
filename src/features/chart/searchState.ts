export interface SearchResult<T> { key: string; rows: T[]; loading: boolean; error?: string }
export function searchKey(query: string, provider: string) {
  return JSON.stringify([provider, query.trim()]);
}
/** A previous query's rows must never remain selectable during debounce/loading. */
export function currentSearchRows<T>(result: SearchResult<T>, key: string): T[] {
  return result.key === key && !result.loading ? result.rows : [];
}

/** Provider ranking may put another exchange's suffix first; an exact ticker wins. */
export function rankInstrumentResults<T extends { symbol: string; providerSymbol?: string }>(
  rows: T[], query: string,
): T[] {
  const needle = query.trim().toUpperCase().split(":").at(-1) ?? "";
  if (!needle) return rows;
  const rank = (row: T) => {
    const ticker = (row.providerSymbol ?? row.symbol.split(":").at(-1) ?? "").toUpperCase();
    return ticker === needle ? 0 : ticker.startsWith(needle) ? 1 : 2;
  };
  return rows.map((row, index) => ({ row, index, rank: rank(row) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ row }) => row);
}
