import { useEffect, useRef, useState } from "react";
import { command } from "./client";
import { Button, Input } from "../ui/primitives";
import SourceEditor from "./SourceEditor";
import { dependencyFields, type DependencyRequest } from "../features/pine/dependencies";
export default function PineLibraries({ initial, onSaved }: { initial?: DependencyRequest; onSaved?: () => void } = {}) {
  const fields = dependencyFields(initial?.reference);
  const installing = useRef(false);
  const [libraries, setLibraries] = useState<any[]>([]),
    [publisher, setPublisher] = useState(fields?.publisher ?? "local"),
    [name, setName] = useState(fields?.name ?? initial?.source?.match(/\blibrary\s*\(\s*["']([A-Za-z_]\w*)["']/)?.[1] ?? "MathTools"),
    [version, setVersion] = useState(fields?.version ?? 1),
    [license, setLicense] = useState(""),
    [sourceUrl, setSourceUrl] = useState("");
  const [source, setSource] = useState(
      initial?.source ?? (initial?.reference ? "" : '//@version=6\nlibrary("MathTools")\nexport twice(float value) =>\n    value * 2\n'),
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState("");
  const refresh = async () => {
    const data = await command("pine.library.list");
    setLibraries(Array.isArray(data) ? data : (data.libraries ?? []));
  };
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, []);
  async function save() {
    if (installing.current) return;
    installing.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await command("pine.library.createVersion", {
        publisher,
        name,
        version,
        source,
        ...(license ? { license } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
      });
      setSaved(result.reference ?? `${publisher}/${name}/${version}`);
      await refresh();
      onSaved?.();
    } catch (e) {
      setError(String(e));
    } finally {
      installing.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="h-full overflow-auto bg-panel p-5">
      <h1 className="page-heading">Pine dependencies</h1>
      <p className="my-3 text-sm text-muted">
        Use this only when a script contains an import statement. These reusable code modules are
        separate from your indicators and strategies. Install the library source with its publisher,
        name and version; saved versions cannot be overwritten.
      </p>
      {initial?.reference && <p className="mb-4 rounded bg-panel-2 p-3 text-sm">Required by your script: <b>{initial.reference}</b>. Paste or upload this library's source below. Tickgrove does not download protected TradingView code.</p>}
      <div className="grid gap-5 lg:grid-cols-[250px_1fr]">
        <aside className="space-y-2">
          {libraries.map((l) => (
            <button
              key={l.reference ?? l.id}
              className="block w-full rounded border border-line p-3 text-left text-xs"
              onClick={() =>
                void command("pine.library.get", { reference: l.reference })
                  .then((value) => {
                    setPublisher(value.publisher ?? l.publisher);
                    setName(value.name ?? l.name);
                    setVersion(value.version ?? l.version);
                    setSource(value.source ?? l.source);
                    setLicense(value.license ?? "");
                    setSourceUrl(value.sourceUrl ?? "");
                  })
                  .catch((e) => setError(String(e)))
              }
            >
              <b>{l.reference ?? `${l.publisher}/${l.name}/${l.version}`}</b>
              <span className="mt-1 block text-muted">
                {l.hash?.slice(0, 12)} · {l.license ?? "No license metadata"}
              </span>
            </button>
          ))}
          {!libraries.length && <p className="text-xs text-muted">No local libraries installed.</p>}
        </aside>
        <div>
          <div className="flex flex-wrap gap-3 text-xs">
            <label>
              Publisher
              <Input value={publisher} onChange={(e) => setPublisher(e.target.value)} />
            </label>
            <label>
              Library name
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Version
              <Input
                className="w-20"
                type="number"
                min="1"
                step="1"
                value={version}
                onChange={(e) => setVersion(Number(e.target.value))}
              />
            </label>
            <label>
              License
              <Input
                value={license}
                onChange={(e) => setLicense(e.target.value)}
                placeholder="SPDX identifier"
              />
            </label>
            <label>
              Source URL
              <Input
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="Optional attribution"
              />
            </label>
          </div>
          <SourceEditor value={source} onChange={setSource} kind="pine" />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button disabled={busy || !source.trim() || !publisher.trim() || !name.trim() || !Number.isInteger(version) || version < 1} variant="primary" onClick={() => void save()}>
              {busy ? "Installing…" : "Install dependency"}
            </Button>
            <label className="text-xs">
              Import .pine file
              <input
                className="ml-2 max-w-48"
                type="file"
                accept=".pine,.txt"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file)
                    void file
                      .text()
                      .then(setSource)
                      .catch((e) => setError(String(e)));
                }}
              />
            </label>
          </div>
          {saved && (
            <div className="mt-4 rounded bg-panel-2 p-3 text-xs">
              <p role="status">Installed {saved}. Return to your script and add it to the chart again.</p>
              <code className="mt-2 block">import {saved} as tools</code>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-down">
              {error}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
