import { useEffect, useState } from "react";
import ServiceExtensions from "./ServiceExtensions";
import ServicePaper from "./ServicePaper";
import PineHosts from "./PineHosts";
import AllocationEditor from "./AllocationEditor";
import SourceEditor from "./SourceEditor";
import ServiceReport from "./ServiceReport";
import { preferredSnapshot } from "./PortfolioData";
import { command, setServiceToken } from "./client";
import { useApp, useBacktests } from "../store";
import { Button, Input, Select } from "../ui/primitives";
const template =
  '//@version=6\nstrategy("Server SMA", overlay=true)\nfast=ta.sma(close,10)\nslow=ta.sma(close,30)\nif ta.crossover(fast,slow)\n    strategy.entry("L",strategy.long)\nif ta.crossunder(fast,slow)\n    strategy.close("L")\nplot(fast)\nplot(slow)';
export default function ServiceWorkbench({ preconnected = false }: { preconnected?: boolean }) {
  const [connected, setConnected] = useState(preconnected),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<any[]>([]),
    [snapshots, setSnapshots] = useState<any[]>([]),
    [jobs, setJobs] = useState<any[]>([]);
  const [version, setVersion] = useState(""),
    [snapshot, setSnapshot] = useState(preferredSnapshot),
    [name, setName] = useState("Server SMA"),
    [kind, setKind] = useState("pine"),
    [source, setSource] = useState(template),
    [inputs, setInputs] = useState("{}");
  const [advanced, setAdvanced] = useState(false),
    [report, setReport] = useState<any>(),
    [reportData, setReportData] = useState<any>();
  const latest = useBacktests((s) => s.results.find((r) => r.id === s.activeId) ?? s.results[0]);
  const selected = versions.find((v) => v.id === version);
  const dirty =
    !!version &&
    (!selected || selected.source !== source || selected.kind !== kind || selected.name !== name);
  const usable = !!version && !!snapshot && !dirty;
  async function refresh() {
    const [v, d, j] = await Promise.all([
      command("strategy.list"),
      command("data.list"),
      command("backtest.status"),
    ]);
    setVersions(v);
    setSnapshots(d);
    setJobs(j);
  }
  async function act(fn: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!connected) return;
    void refresh().catch((e) => setError(String(e)));
    const timer = setInterval(() => void refresh().catch((e) => setError(String(e))), 5000);
    return () => clearInterval(timer);
  }, [connected]);
  function choose(id: string) {
    const v = versions.find((v) => v.id === id);
    setVersion(id);
    if (v) {
      setName(v.name);
      setKind(v.kind);
      setSource(v.source);
    }
    setInputs("{}");
  }
  async function save() {
    const v = await command("strategy.createVersion", { name, kind, source });
    setVersion(v.id);
    await refresh();
  }
  async function importData(data: unknown) {
    const d = await command("data.import", { data });
    setSnapshot(d.id);
    await refresh();
  }
  async function openReport(id: string) {
    const r = await command("backtest.results", { job_id: id });
    setReport(r);
    setReportData(await command("data.get", { snapshot_id: r.manifest.snapshot_id }));
  }
  function useLastRun() {
    if (!latest?.server) return;
    choose(latest.server.versionId);
    setSnapshot(latest.server.snapshotId);
    setInputs(JSON.stringify(latest.server.inputs ?? {}));
  }
  return (
    <section aria-label="Automation workspace" className="h-full overflow-auto bg-panel p-4 sm:p-5">
      <div className="mx-auto max-w-6xl">
        <header className="mb-5">
          <h1 className="page-heading">Automation</h1>
          <p className="page-description mt-1">
            Run a tested strategy continuously. Sessions keep running while your browser is closed.
          </p>
        </header>
        {!connected ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await command("system.capabilities");
                setConnected(true);
              });
            }}
          >
            <Input
              type="password"
              placeholder="Instance token (var/auth-token)"
              onChange={(e) => setServiceToken(e.target.value)}
            />
            <Button type="submit">Connect</Button>
          </form>
        ) : (
          <>
            <div className="rounded-xl border border-line p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="mr-auto text-sm font-semibold">
                  1. Choose a saved strategy and dataset
                </h2>
                <Button size="sm" disabled={!latest?.server} onClick={useLastRun}>
                  Use latest backtest
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => useApp.getState().setView("library")}
                >
                  Open scripts
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-muted">
                  Strategy version
                  <Select
                    aria-label="Saved strategy version"
                    className="mt-1 w-full"
                    value={version}
                    onChange={(e) => choose(e.target.value)}
                  >
                    <option value="">Choose a saved version</option>
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} · {v.kind} · {v.hash.slice(0, 6)}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="text-xs text-muted">
                  Market dataset
                  <Select
                    aria-label="Data snapshot"
                    className="mt-1 w-full"
                    value={snapshot}
                    onChange={(e) => setSnapshot(e.target.value)}
                  >
                    <option value="">Choose a saved dataset</option>
                    {snapshots.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.symbol} · {d.timeframe} · {d.bars} bars · {d.hash.slice(0, 6)}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              <p className="mt-3 text-xs text-muted">
                Run a backtest from Scripts first, then choose “Use latest backtest”. This keeps the
                same saved source, inputs and history.
              </p>
              {dirty && (
                <p role="alert" className="mt-3 text-sm text-demo">
                  Unsaved source changes. Save a new version before running or deploying it.
                </p>
              )}
              <Button
                size="sm"
                className="mt-3"
                disabled={busy || !usable}
                onClick={() =>
                  void act(async () => {
                    await command(
                      "backtest.start",
                      { version_id: version, snapshot_id: snapshot, inputs: JSON.parse(inputs) },
                      crypto.randomUUID(),
                    );
                    await refresh();
                  })
                }
              >
                Run saved backtest
              </Button>
            </div>
            <ServicePaper
              version={!dirty ? version : ""}
              snapshot={snapshot}
              inputs={inputs}
              onReport={openReport}
            />
            <details className="mt-4 rounded-xl border border-line p-4">
              <summary className="cursor-pointer text-sm font-semibold">
                Tick strategies and external fills · advanced
              </summary>
              <PineHosts
                version={!dirty && kind === "pine" ? version : ""}
                snapshot={snapshot}
                inputs={inputs}
              />
            </details>
            <details className="mt-4 rounded-xl border border-line p-4">
              <summary className="cursor-pointer text-sm font-semibold">
                Saved jobs ({jobs.length})
              </summary>
              <div className="mt-3 space-y-2">
                {jobs.map((j) => (
                  <div
                    key={j.job_id}
                    className="flex flex-wrap items-center gap-3 rounded bg-panel-2 p-2 text-xs"
                  >
                    <span title={j.job_id}>{j.job_id.slice(0, 8)}</span>
                    <span>{j.status}</span>
                    {["queued", "running"].includes(j.status) ? (
                      <Button
                        size="sm"
                        onClick={() =>
                          void act(() => command("backtest.cancel", { job_id: j.job_id }))
                        }
                      >
                        Cancel
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => void act(() => openReport(j.job_id))}>
                        Open report
                      </Button>
                    )}
                    {j.error && <span className="text-down">{j.error}</span>}
                  </div>
                ))}
              </div>
            </details>
            {report && (
              <div className="mt-4">
                <ServiceReport report={report} data={reportData} />
              </div>
            )}
            <details
              className="mt-4 rounded-xl border border-line p-4"
              onToggle={(e) => setAdvanced(e.currentTarget.open)}
            >
              <summary className="cursor-pointer text-sm font-semibold">
                Version editor, Composer and data import · advanced
              </summary>
              {advanced && (
                <div className="mt-4 space-y-4">
                  <p className="text-xs text-muted">
                    Saved versions are immutable. Editing this source creates a draft; saving
                    produces a new version. Routine Pine editing is in Scripts.
                  </p>
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="text-xs">
                      Version name
                      <Input
                        aria-label="Strategy name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </label>
                    <label className="text-xs">
                      Strategy type
                      <Select
                        aria-label="Strategy type"
                        className="block"
                        value={kind}
                        onChange={(e) => setKind(e.target.value)}
                      >
                        <option value="pine">Pine</option>
                        <option value="composer">Composer portfolio</option>
                      </Select>
                    </label>
                    <Button disabled={busy} onClick={() => void act(save)}>
                      Save new version
                    </Button>
                  </div>
                  {kind === "composer" && (
                    <>
                      <div className="flex gap-2">
                        {["balanced", "trend", "momentum"].map((example) => (
                          <Button
                            key={example}
                            size="sm"
                            onClick={() =>
                              void act(async () => {
                                setSource(
                                  JSON.stringify(
                                    await (
                                      await fetch("/examples/composer/" + example + ".json")
                                    ).json(),
                                    null,
                                    2,
                                  ),
                                );
                                setName(example);
                              })
                            }
                          >
                            {example} example
                          </Button>
                        ))}
                      </div>
                      <AllocationEditor source={source} onChange={setSource} />
                    </>
                  )}
                  <SourceEditor value={source} onChange={setSource} kind={kind} />
                  <label className="block text-xs">
                    Input overrides (JSON)
                    <Input
                      aria-label="Pine inputs JSON"
                      value={inputs}
                      onChange={(e) => setInputs(e.target.value)}
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="text-xs">
                      Import dataset JSON{" "}
                      <input
                        type="file"
                        accept=".json"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void act(async () => importData(JSON.parse(await file.text())));
                        }}
                      />
                    </label>
                    <Button
                      size="sm"
                      onClick={() =>
                        void act(async () =>
                          importData(
                            await (await fetch("/examples/composer/synthetic-etfs.json")).json(),
                          ),
                        )
                      }
                    >
                      Load synthetic ETF example
                    </Button>
                  </div>
                  <ServiceExtensions report={report ?? null} onImport={refresh} />
                </div>
              )}
            </details>
          </>
        )}
        {error && (
          <p role="alert" className="mt-4 text-sm text-down">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
