import type { Timeframe } from "../core/types";
import type { PineRunOptions } from "../pine/runtime";
import {
  dataPineOptions,
  loadMarketHistory,
  marketRequest,
  marketSeries,
  subscribeMarket,
} from "../data/feed";
import { command, getServiceToken } from "./client";
import { resolvePineOptions } from "./pineLibraries";

type Request = {
  symbol: string | null;
  timeframe: string | null;
  function: string;
  line: number;
};
type Dependencies = {
  requests: Request[];
  dynamic: { line: number; function: string; reason: string }[];
};
const inspections = new Map<string, Promise<Dependencies>>();
const periods: Record<string, Timeframe> = {
  "1": "1m",
  "1m": "1m",
  "5": "5m",
  "5m": "5m",
  "15": "15m",
  "15m": "15m",
  "60": "1H",
  "1H": "1H",
  "240": "4H",
  "4H": "4H",
  D: "1D",
  "1D": "1D",
  W: "1W",
  "1W": "1W",
};
const venueGroup = (value: string) => {
  const v = value.toUpperCase();
  if (["NMS", "NGM", "NCM", "NASDAQ", "NASDAQGS", "NASDAQGM", "NASDAQCM"].includes(v))
    return "NASDAQ";
  if (["NYQ", "NYSE"].includes(v)) return "NYSE";
  if (["PCX", "ASE", "AMEX", "NYSEARCA", "ARCA", "NYSEAMERICAN"].includes(v)) return "AMEX";
  return v;
};

export async function prepareChartPine(
  source: string,
  symbol: string,
  tf: Timeframe,
  inputs?: Record<string, unknown>,
): Promise<PineRunOptions> {
  // A linked library can contain requests even when the root script has none.
  const lockOptions = await resolvePineOptions(source, {});
  if (!/\brequest\s*\./.test(source) && !lockOptions.libraryLock)
    return dataPineOptions(symbol, tf, inputs);
  const key = getServiceToken() + "\n" + JSON.stringify({ source, symbol, tf, inputs }),
    primary = marketSeries(symbol, tf),
    request = marketRequest(symbol, tf);
  let inspect = inspections.get(key);
  if (!inspect) {
    inspect = command<Dependencies>("pine.inspectRequests", {
      source,
      symbol: request.symbol,
      timeframe: tf,
      inputs,
    }).catch((error) => {
      inspections.delete(key);
      throw error;
    });
    inspections.set(key, inspect);
    if (inspections.size > 100) inspections.delete(inspections.keys().next().value!);
  }
  const deps = await inspect,
    aliases: NonNullable<PineRunOptions["datasets"]> = [];
  for (const dep of deps.requests) {
    const period = dep.timeframe == null || dep.timeframe === "" ? tf : periods[dep.timeframe];
    if (!period)
      throw Error(
        `request.${dep.function} on line ${dep.line}: timeframe ${dep.timeframe} is not available from this adapter`,
      );
    const target = dep.symbol || request.symbol,
      parts = target.split(":"),
      raw = parts.at(-1)!,
      prefix = parts.length > 1 ? parts[0] : undefined;
    const canonical =
      raw === request.symbol
        ? symbol
        : [
            request.provider.toUpperCase(),
            ...(request.provider === "alpaca"
              ? [request.feed!]
              : request.session === "extended"
                ? ["extended"]
                : []),
            raw,
          ].join(":");
    const series = marketSeries(canonical, period);
    if (!series.metadata || !series.bars.length) {
      const range = primary.historyRange;
      await loadMarketHistory(
        canonical,
        period,
        range ? { start: range.start, end: range.end } : undefined,
      );
    }
    if (series.error) throw Error(series.error);
    if (!series.identity || !series.bars.length)
      throw Error(`No market dataset for ${target}/${period}`);
    if (
      prefix &&
      prefix !== request.provider.toUpperCase() &&
      venueGroup(prefix) !== venueGroup(series.identity.venue)
    )
      throw Error(`Requested venue ${prefix} does not match ${series.identity.venue} for ${raw}`);
    if (primary.historyRange?.live !== false) await subscribeMarket(canonical, period);
    if (target !== series.identity.symbol)
      aliases.push({
        symbol: target,
        timeframe: period,
        bars: series.bars,
        metadata: series.metadata as PineRunOptions["metadata"],
      });
  }
  const options = dataPineOptions(symbol, tf, inputs);
  return {
    ...options,
    ...lockOptions,
    datasets: [...(options.datasets ?? []), ...aliases],
  };
}
