import { execute } from "../core/commands";
import { symbolInfo, livePrice, prevClosePrice } from "../data/feed";
import { useCharts } from "../store";
import { useTick } from "../ui/hooks";
import { fmt } from "../ui/primitives";

export default function SectorHeatmap() {
  useTick();
  const watchlists = useCharts((s) => s.watchlists),
    active = useCharts((s) => s.activeWatchlist);
  const symbols = (watchlists.find((w) => w.id === active)?.symbols ?? []).map(symbolInfo);
  const sectors = [...new Set(symbols.map((s) => s.sector))];
  return (
    <div className="flex h-full flex-col overflow-auto bg-panel p-2">
      <div className="mb-2 px-1 text-[11px] text-muted">
        Plugin · <span className="text-accent">tickgrove.sector-heatmap</span> · click a tile to
        load it
      </div>
      <div className="grid flex-1 auto-rows-fr grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-1">
        {sectors.flatMap((sec) =>
          symbols
            .filter((s) => s.sector === sec)
            .map((s) => {
              const ch = (livePrice(s.symbol) / prevClosePrice(s.symbol) - 1) * 100;
              const a = Number.isFinite(ch) ? Math.min(1, Math.abs(ch) / 3) : 0;
              return (
                <button
                  key={s.symbol}
                  onClick={() => execute("chart.setSymbol", { symbol: s.symbol }, "plugin")}
                  className="flex min-h-[64px] flex-col justify-between rounded-lg p-2 text-left transition-transform hover:scale-[1.02]"
                  style={{
                    background: `color-mix(in srgb, ${ch >= 0 ? "var(--up)" : "var(--down)"} ${12 + a * 60}%, var(--panel-2))`,
                  }}
                >
                  <span className="text-[10px] text-text/60">{sec || "Unclassified"}</span>
                  <span>
                    <span className="block text-[13px] font-semibold">{s.symbol}</span>
                    <span className="num text-[11.5px]">{fmt.pct(ch)}</span>
                  </span>
                </button>
              );
            }),
        )}
      </div>
    </div>
  );
}
