import { useEffect, useState } from "react";
import { command } from "./client";
import { useConnection, exportWorkspaceState, importWorkspaceState } from "./workspaceSync";
import { validateWorkspace } from "./workspaceDocument";
import { Button, Input, Select } from "../ui/primitives";
import ServiceExtensions from "./ServiceExtensions";
import PineLibraries from "./PineLibraries";
import { useApp, THEMES } from "../store";

const examples: Record<string, unknown> = {
  "market.search": { provider: "coinbase", query: "SOL" },
  "market.history": {
    provider: "yahoo",
    symbol: "VOO",
    timeframe: "1D",
    start: Math.floor(Date.now() / 1000) - 40 * 86400,
    end: Math.floor(Date.now() / 1000),
  },
  "market.subscribe": {
    provider: "coinbase",
    symbol: "LTC-USD",
    timeframe: "1m",
  },
  "workspace.get": { id: "default" },
  "account.state": {},
  "alerts.list": {},
  "system.capabilities": {},
};
export default function ServerIntegrations({ children }: { children: React.ReactNode }) {
  const [pendingWorkspace, setPendingWorkspace] = useState<any>();
  const [cap, setCap] = useState<any>(),
    [market, setMarket] = useState<any>(),
    [method, setMethod] = useState("system.capabilities"),
    [params, setParams] = useState("{}"),
    [result, setResult] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const theme = useApp((s) => s.theme),
    setTheme = useApp((s) => s.setTheme);
  const [tab, setTab] = useState("appearance"),
    permissions = useConnection((s) => s.permissions);
  useEffect(() => {
    void Promise.all([command("system.capabilities"), command("market.capabilities")])
      .then(([a, b]) => {
        setCap(a);
        setMarket(b);
      })
      .catch((e) => setError(String(e)));
  }, []);
  async function execute() {
    setBusy(true);
    setError("");
    try {
      setResult(
        JSON.stringify(await command(method, JSON.parse(params), crypto.randomUUID()), null, 2),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="h-full overflow-auto bg-panel px-5 py-6">
      <div className="mx-auto max-w-6xl">
        <h1 className="page-heading">Settings</h1>
        <p className="my-3 text-sm text-muted">
          Appearance and workspace preferences. Developer interfaces and extensions are optional for
          charting and backtesting.
        </p>
        <div className="mb-5 flex flex-wrap gap-2">
          {[
            ["appearance", "Appearance"],
            ["workspace", "Workspace"],
            ["adapters", "Connections"],
            ["plugins", "Extensions"],
            ["commands", "API / CLI / MCP"],
            ["permissions", "Permissions"],
          ].map(([t, label]) => (
            <Button key={t} onClick={() => setTab(t)} variant={tab === t ? "primary" : "ghost"}>
              {label}
            </Button>
          ))}
        </div>
        {error && (
          <p role="alert" className="mb-3 text-sm text-down">
            {error}
          </p>
        )}
        {tab === "appearance" && (
          <section className="max-w-xl rounded-xl border border-line p-4">
            <h2 className="mb-3 text-sm font-semibold">Theme</h2>
            <div className="grid grid-cols-2 gap-3">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  aria-pressed={theme === t.id}
                  onClick={() => setTheme(t.id)}
                  className="rounded-lg border border-line-2 p-3 text-left text-sm"
                  style={{ background: t.swatch[0], color: t.swatch[1] }}
                >
                  {t.label}
                  {theme === t.id ? " ✓" : ""}
                </button>
              ))}
            </div>
            <p className="mt-4 text-xs text-muted">
              UI labels and prices use one typeface. Code stays monospaced. Fonts are included with
              the application.
            </p>
          </section>
        )}
        {tab === "commands" && (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3">
                <label className="text-xs">
                  Server command
                  <Select
                    className="ml-2"
                    value={method}
                    onChange={(e) => {
                      setMethod(e.target.value);
                      setParams(JSON.stringify(examples[e.target.value] ?? {}, null, 2));
                    }}
                  >
                    {(cap?.commands ?? ["system.capabilities"]).map((c: string) => (
                      <option key={c}>{c}</option>
                    ))}
                  </Select>
                </label>
                <textarea
                  aria-label="Command parameters"
                  className="num h-40 w-full rounded border border-line bg-panel-2 p-3 text-xs"
                  value={params}
                  onChange={(e) => setParams(e.target.value)}
                />
                <Button disabled={busy} onClick={() => void execute()}>
                  {busy ? "Executing…" : "Execute command"}
                </Button>
                <p className="text-xs text-muted">
                  Mutation commands apply to this instance. Their results and errors use the same
                  contract as the CLI.
                </p>
              </div>
              <pre className="num max-h-72 overflow-auto rounded border border-line p-3 text-xs">
                {result || "Command result"}
              </pre>
            </div>
            <div className="mt-5 grid gap-3 lg:grid-cols-3">
              <Code
                title="HTTP API"
                value={`POST /api/command\nAuthorization: Bearer <instance token>\nContent-Type: application/json\n\n${JSON.stringify({ method, params: parse(params), idempotency_key: "<unique request key>" }, null, 2)}`}
              />
              <Code
                title="CLI"
                value={`# Save parameters in params.json\nserver/target/release/trading-cli ${method} params.json --key <unique-request-key>\n\n# Read token from a local file\nTRADING_TOKEN_FILE=/path/to/auth-token\nTRADING_URL=https://your-instance`}
              />
              <Code
                title="MCP (stdio)"
                value={`server/target/release/trading-mcp\n\nEnvironment:\nTRADING_URL=https://your-instance\nTRADING_TOKEN_FILE=/path/to/auth-token\n\nUse tools/list to discover the server's command tool and input schema.`}
              />
            </div>
          </>
        )}
        {tab === "pine libraries" && <PineLibraries />}
        {tab === "plugins" && (
          <>
            {children}
            <ServiceExtensions report={null} onImport={async () => {}} />
          </>
        )}
        {tab === "adapters" && (
          <>
            <div className="grid gap-3 md:grid-cols-3">
              {market?.providers?.map((p: any) => (
                <article key={p.id} className="rounded-xl border border-line p-4">
                  <h2 className="font-semibold">{p.id}</h2>
                  <pre className="mt-3 whitespace-pre-wrap text-xs text-muted">
                    {JSON.stringify(p, null, 2)}
                  </pre>
                </article>
              ))}
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-3">
              {[
                ["Chart", "Lightweight Charts · Apache-2.0"],
                ["Pine runtime", cap?.engine ?? "PineTS"],
                ["Backtesting", "Persistent Rust jobs + native strategy ledger"],
                ["Local execution", "Server simulated account + native strategy sessions"],
                ["Broker adapter", "Alpaca Paper · host credentials required"],
              ].map(([name, value]) => (
                <article key={name} className="rounded-xl border border-line p-4">
                  <h2 className="text-sm font-semibold">{name}</h2>
                  <p className="mt-2 text-xs text-muted">{value}</p>
                </article>
              ))}
            </div>
          </>
        )}
        {tab === "permissions" && (
          <div className="rounded-xl border border-line p-5 text-sm">
            <p>Current token scopes:</p>
            <ul className="my-3 list-inside list-disc">
              {permissions?.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <p className="text-muted">
              Scope checks run on the server for HTTP, CLI and MCP. Revoking a token also revokes
              this browser's access.
            </p>
          </div>
        )}
        {tab === "workspace" && (
          <div className="space-y-4 rounded-xl border border-line p-5 text-sm">
            <p>
              Export chart layouts, drawing objects, watchlists, Pine drafts and visual strategies.
            </p>
            <Button
              onClick={() => {
                const a = document.createElement("a");
                a.href = URL.createObjectURL(
                  new Blob([JSON.stringify(exportWorkspaceState(), null, 2)], {
                    type: "application/json",
                  }),
                );
                a.download = "workspace.json";
                a.click();
                URL.revokeObjectURL(a.href);
              }}
            >
              Export workspace JSON
            </Button>
            <label className="block">
              Restore workspace JSON
              <input
                className="ml-3"
                type="file"
                accept=".json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file)
                    void file
                      .text()
                      .then((text) => {
                        const doc = JSON.parse(text);
                        validateWorkspace(doc);
                        setPendingWorkspace(doc);
                        setError("");
                      })
                      .catch((e) => setError(String(e)));
                }}
              />
            </label>
            {pendingWorkspace && (
              <div
                role="region"
                aria-label="Workspace restore preview"
                className="space-y-3 rounded border border-line-2 bg-panel-2 p-3"
              >
                <p>
                  Ready to restore {pendingWorkspace.workspaces.workspaces.length} layouts,{" "}
                  {pendingWorkspace.charts.watchlists.length} watchlists and{" "}
                  {pendingWorkspace.scripts.scripts.length} scripts.
                </p>
                <p className="text-muted">
                  This replaces your current layouts, drawings, watchlists and script drafts. Export
                  your current workspace first if you need to keep it. Trading accounts and server
                  jobs are not replaced.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={busy || !permissions.includes("workspace.write")}
                    onClick={() => {
                      setBusy(true);
                      void importWorkspaceState(pendingWorkspace)
                        .then(() => setPendingWorkspace(undefined))
                        .catch((e) => setError(String(e)))
                        .finally(() => setBusy(false));
                    }}
                  >
                    Replace workspace
                  </Button>
                  <Button onClick={() => setPendingWorkspace(undefined)}>Cancel restore</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
function parse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
function Code({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-xl border border-line">
      <div className="flex items-center justify-between border-b border-line p-2 text-xs">
        <b>{title}</b>
        <button onClick={() => void navigator.clipboard.writeText(value)}>Copy</button>
      </div>
      <pre className="num overflow-auto p-3 text-xs text-muted">{value}</pre>
    </div>
  );
}
