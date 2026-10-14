import { useEffect, useState } from "react";
import { command } from "./client";
import { TIMEFRAMES } from "../core/types";
export default function ServiceExtensions({
  report,
  onImport,
}: {
  report: any;
  onImport: () => Promise<void>;
}) {
  const [plugins, setPlugins] = useState<any[]>([]),
    [broker, setBroker] = useState<any>(null),
    [error, setError] = useState(""),
    [pluginReport, setPluginReport] = useState<any>(null);
  const [csvSymbol, setCsvSymbol] = useState(""),
    [csvTimeframe, setCsvTimeframe] = useState("1D");
  const refresh = async () => {
    setPlugins(await command("plugins.list"));
    setBroker(await command("alpaca.config"));
  };
  const act = async (fn: () => Promise<void>) => {
    try {
      setError("");
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    void act(refresh);
  }, []);
  return (
    <details className="mt-5 rounded border border-line p-4">
      <summary>Host extensions and Alpaca Paper configuration</summary>
      <p className="my-2 text-xs text-muted">
        Plugin host grants caller-provided input only. Network, broker credentials and host files
        are unavailable to plugin processes. Server token permissions authorize management.
      </p>
      {plugins.map((p) => (
        <div key={p.manifest.id} className="my-1 flex gap-3 text-xs">
          <b>{p.manifest.id}</b>
          <span>{p.manifest.version}</span>
          <button
            onClick={() =>
              void act(async () => {
                await command(p.enabled ? "plugins.disable" : "plugins.enable", {
                  id: p.manifest.id,
                });
              })
            }
          >
            {p.enabled ? "Disable" : "Enable"}
          </button>
          {p.manifest.id === "csv-data" && p.enabled && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="CSV symbol"
                placeholder="Symbol in CSV"
                value={csvSymbol}
                onChange={(e) => setCsvSymbol(e.target.value)}
                className="w-32 rounded border border-line bg-surface p-1"
              />
              <select
                aria-label="CSV timeframe"
                value={csvTimeframe}
                onChange={(e) => setCsvTimeframe(e.target.value)}
                className="rounded border border-line bg-surface p-1"
              >
                {TIMEFRAMES.map((tf) => (
                  <option key={tf}>{tf}</option>
                ))}
              </select>
              <label>
                Import CSV
                <input
                  type="file"
                  accept=".csv"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file)
                      void act(async () => {
                        if (!csvSymbol.trim())
                          throw Error("Enter the instrument symbol before importing CSV");
                        const parsed = await command("plugins.call", {
                          id: "csv-data",
                          input: {
                            csv: await file.text(),
                            symbol: csvSymbol.trim(),
                            timeframe: csvTimeframe,
                          },
                        });
                        await command("data.import", { data: parsed.data });
                        await onImport();
                      });
                  }}
                />
              </label>
            </div>
          )}
          {p.manifest.id === "equity-report" && p.enabled && report?.result && (
            <button
              onClick={() =>
                void act(async () =>
                  setPluginReport(
                    await command("plugins.call", {
                      id: "equity-report",
                      input: {
                        equity: report.result.backtest?.equity ?? report.result.equity,
                      },
                    }),
                  ),
                )
              }
            >
              Run report extension
            </button>
          )}
        </div>
      ))}
      {pluginReport && (
        <div className="my-3 flex gap-4 text-xs">
          {Object.entries(pluginReport.report).map(([k, v]) => (
            <span key={k}>
              {k}: {String(v)}
            </span>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs">
        Alpaca Paper:{" "}
        {broker?.configured
          ? "Credentials configured on host"
          : "Not configured; set dedicated ALPACA_API_KEY / ALPACA_API_SECRET on the host"}
        . Live trading unavailable. Actual account/network acceptance has not been performed.
      </p>
      {error && (
        <p role="alert" className="text-down">
          {error}
        </p>
      )}
    </details>
  );
}
