import { useEffect, useMemo, useRef, useState } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { autocompletion } from "@codemirror/autocomplete";
import { setDiagnostics } from "@codemirror/lint";
import { indentWithTab } from "@codemirror/commands";
import {
  AlertTriangle,
  BookOpen,
  Boxes,
  CheckCircle2,
  FileCode2,
  FlaskConical,
  LineChart,
  Play,
  Plus,
  Trash2,
  X,
  Copy,
  Square,
  MoreHorizontal,
  Upload,
} from "lucide-react";
import { execute } from "../../core/commands";
import { getBars, isDemoData, loadMarketHistory } from "../../data/feed";
import { detectKind, detectTitle, parseInputs, type PineRunResult } from "../../pine/runtime";
import { runPineInWorker } from "../../pine/client";
import { demoPineOptions } from "../../pine/demo";
import { resolvePineOptions } from "../../service/pineLibraries";
import { prepareChartPine } from "../../service/pineData";
import type { PineLibraryLock } from "../../pine/library";
import { pineCompletions, pineHighlight, pineLanguage } from "../../pine/language";
import { fromPine } from "../../builder/codegen";
import {
  getChart,
  targetChartId,
  useApp,
  useBacktests,
  useBuilder,
  useScripts,
  useCharts,
} from "../../store";
import ImportPine from "./ImportPine";
import { useConnection } from "../../service/workspaceSync";
import { uid } from "../../builder/model";
import {
  Badge,
  Button,
  Empty,
  IconButton,
  Segmented,
  Input,
  Select,
  Popover,
  MenuItem,
  cx,
} from "../../ui/primitives";
import { openPanel } from "../workspace/dock";

const NEW_TEMPLATE = `//@version=5
indicator("My Indicator", overlay=true)

length = input.int(20, "Length", minval=1)

basis = ta.sma(close, length)
plot(basis, "Basis", color=#8b7dff)
`;

export default function PineEditor({
  onBacktest,
  onLibraries,
}: { onBacktest?: () => void; onLibraries?: () => void } = {}) {
  const { scripts, openIds, activeId, open, close, upsert, remove } = useScripts();
  const active = scripts.find((s) => s.id === activeId);
  const [importing, setImporting] = useState(false),
    [query, setQuery] = useState("");
  const chartId = useApp((s) => s.activeChartId);
  const chart = useCharts((s) => s.charts[chartId ?? ""]);
  const applied =
    !!active && chart?.indicators.some((i) => i.kind === "pine" && i.type === active.id);
  const [libOpen, setLibOpen] = useState(false);
  const pane = useRef<HTMLDivElement>(null);
  const syncError = useConnection((s) => s.syncError);
  useEffect(() => {
    if (!pane.current) return;
    let previous = 0;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width <= 0) return;
      if (!previous) setLibOpen(width >= 700);
      else if (previous >= 700 && width < 700) setLibOpen(false);
      previous = width;
    });
    observer.observe(pane.current);
    return () => observer.disconnect();
  }, []);
  const [results, setResults] = useState<
    Record<
      string,
      PineRunResult & {
        at: number;
      }
    >
  >({});
  const [consoleTab, setConsoleTab] = useState<"console" | "inputs">("console");
  const viewRef = useRef<EditorView | null>(null);
  const compileRun = useRef<AbortController | null>(null);
  const [compiling, setCompiling] = useState(false);
  useEffect(() => {
    setCompiling(false);
    return () => compileRun.current?.abort();
  }, [activeId]);
  const running = useBacktests((s) => s.running);
  const result = active ? results[active.id] : undefined;

  const compile = async () => {
    if (!active) return;
    compileRun.current?.abort();
    const controller = new AbortController();
    compileRun.current = controller;
    setCompiling(true);
    const source = viewRef.current?.state.doc.toString() ?? active.source;
    if (source !== active.source) useScripts.getState().update(active.id, source);
    const cid = targetChartId();
    const c = getChart(cid);
    const symbol = c?.symbol ?? "NVDA",
      tf = c?.tf ?? "1D";
    let r: PineRunResult;
    try {
      if (!isDemoData() && !getBars(symbol, tf).length) await loadMarketHistory(symbol, tf);
      const bars = getBars(symbol, tf);
      const options = isDemoData()
        ? demoPineOptions(symbol, tf, active.inputs)
        : await prepareChartPine(source, symbol, tf, active.inputs);
      r = await runPineInWorker(source, bars, tf, options, controller.signal);
    } catch (error) {
      r = {
        ok: false,
        title: detectTitle(source),
        kind: detectKind(source),
        overlay: true,
        plots: [],
        signals: [],
        warnings: [],
        ms: 0,
        error: { message: String(error) },
      } as PineRunResult;
    }
    if (compileRun.current === controller) setCompiling(false);
    if (
      controller.signal.aborted ||
      useScripts.getState().activeId !== active.id ||
      useScripts.getState().scripts.find((s) => s.id === active.id)?.source !== source
    )
      return;
    setResults((s) => ({ ...s, [active.id]: { ...r, at: Date.now() } }));
    setConsoleTab("console");
    const view = viewRef.current;
    if (view) {
      if (!r.ok && r.error?.line && (!r.error.reference || r.error.reference === "strategy")) {
        const line = view.state.doc.line(Math.min(r.error.line, view.state.doc.lines));
        view.dispatch(
          setDiagnostics(view.state, [
            {
              from: line.from,
              to: line.to,
              severity: "error",
              message: r.error.message,
            },
          ]),
        );
      } else view.dispatch(setDiagnostics(view.state, []));
    }
    return r;
  };
  const addToChart = async () => {
    const r = await compile();
    if (r?.ok) {
      try {
        const message = await execute("pine.addToChart", { scriptId: active!.id });
        useApp.getState().toast({
          title: String(message),
          body: chart ? chart.symbol + " · " + chart.tf : "Applied to chart",
        });
      } catch (e) {
        useApp.getState().toast({ title: String(e), tone: "error" });
      }
    }
  };
  const backtest = async () => {
    if (!active) return;
    try {
      if (viewRef.current)
        useScripts.getState().update(active.id, viewRef.current.state.doc.toString());
      if (isDemoData() && !(await compile())?.ok) return;
      await execute("backtest.runScript", { scriptId: active.id });
      onBacktest?.();
    } catch (e) {
      useApp.getState().toast({ title: String(e), tone: "error" });
    }
  };
  const toBlocks = () => {
    if (!active) return;
    const res = fromPine(active.source);
    if (!res.ok)
      return useApp.getState().toast({
        title: "Cannot convert to blocks",
        body: res.reason,
        tone: "error",
      });
    const b = useBuilder.getState();
    if (b.defs.some((d) => d.id === res.def.id)) b.setDef(res.def);
    else b.addDef(res.def);
    b.setActive(res.def.id);
    openPanel("builder");
  };
  const goto = (line: number) => {
    const v = viewRef.current;
    if (!v) return;
    const l = v.state.doc.line(Math.min(line, v.state.doc.lines));
    v.dispatch({
      selection: { anchor: l.from, head: l.to },
      scrollIntoView: true,
    });
    v.focus();
  };
  const newScript = (kind: "indicator" | "strategy") => {
    const source =
      kind === "indicator"
        ? NEW_TEMPLATE
        : `//@version=5\nstrategy("My Strategy", overlay=true)\n\nlen = input.int(20, "Length")\nm = ta.sma(close, len)\n\nif ta.crossover(close, m)\n    strategy.entry("L", strategy.long)\nif ta.crossunder(close, m)\n    strategy.close("L")\n\nplot(m, "SMA")\n`;
    upsert({
      id: uid("sc"),
      name: kind === "indicator" ? "My Indicator" : "My Strategy",
      kind,
      source,
      updatedAt: Date.now(),
      origin: "user",
    });
  };

  return (
    <div ref={pane} className="pine-workbench relative flex h-full min-h-0 bg-panel">
      {importing && <ImportPine onClose={() => setImporting(false)} />}
      {libOpen && (
        <aside className="pine-sidebar flex w-[210px] shrink-0 flex-col border-r border-line bg-panel">
          <div className="flex h-9 items-center justify-between border-b border-line px-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">
              My scripts
            </span>
            <div className="flex">
              <IconButton label="New indicator" onClick={() => newScript("indicator")}>
                <Plus size={14} />
              </IconButton>
              <IconButton label="New strategy" onClick={() => newScript("strategy")}>
                <FlaskConical size={13} />
              </IconButton>
            </div>
          </div>
          <div className="p-2">
            <Input
              aria-label="Find a script"
              placeholder="Find a script…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-1.5">
            {(["indicator", "strategy"] as const).map((k) => (
              <div key={k} className="mb-2">
                <div className="px-1.5 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-wider text-faint">
                  {k === "indicator" ? "Indicators" : "Strategies"}
                </div>
                {scripts
                  .filter(
                    (s) =>
                      detectKind(s.source) === k &&
                      s.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((s) => (
                    <div
                      key={s.id}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          open(s.id);
                        }
                      }}
                      onClick={() => open(s.id)}
                      className={cx(
                        "group flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px]",
                        s.id === activeId
                          ? "bg-accent/12 text-text"
                          : "text-muted hover:bg-panel-2 hover:text-text",
                      )}
                    >
                      {k === "indicator" ? (
                        <LineChart size={12} className="shrink-0 text-accent-2" />
                      ) : (
                        <FlaskConical size={12} className="shrink-0 text-accent" />
                      )}
                      <span className="flex-1 truncate">{s.name}</span>
                      {s.origin === "builder" && <Boxes size={11} className="text-faint" />}
                      {s.origin !== "example" && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            remove(s.id);
                          }}
                          className="hidden text-faint hover:text-down group-hover:block"
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center border-b border-line">
          <IconButton
            label="My scripts"
            className="mx-1"
            active={libOpen}
            onClick={() => setLibOpen(!libOpen)}
          >
            <BookOpen size={14} />
          </IconButton>
          <div className="flex min-w-0 flex-1 overflow-x-auto">
            {openIds.map((id) => {
              const s = scripts.find((x) => x.id === id);
              if (!s) return null;
              return (
                <div
                  key={id}
                  onClick={() => open(id)}
                  className={cx(
                    "group flex h-9 shrink-0 cursor-pointer items-center gap-1.5 border-r border-line px-3 text-[12px]",
                    id === activeId
                      ? "bg-panel-2 text-text shadow-[inset_0_-2px_0_var(--accent)]"
                      : "text-muted hover:text-text",
                  )}
                >
                  <FileCode2
                    size={12}
                    className={
                      detectKind(s.source) === "strategy" ? "text-accent" : "text-accent-2"
                    }
                  />
                  {s.name}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      close(id);
                    }}
                    className="text-faint opacity-0 hover:text-text group-hover:opacity-100"
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
          <Button size="sm" variant="ghost" className="mx-1" onClick={() => setImporting(true)}>
            <Upload size={13} /> Import Pine
          </Button>
          <Popover
            align="right"
            trigger={({ toggle }) => (
              <IconButton label="Script file menu" onClick={toggle}>
                <MoreHorizontal size={15} />
              </IconButton>
            )}
          >
            {(close) => (
              <div className="w-52">
                <MenuItem
                  onClick={() => {
                    newScript("indicator");
                    close();
                  }}
                >
                  New indicator
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    newScript("strategy");
                    close();
                  }}
                >
                  New strategy
                </MenuItem>
                {active && (
                  <MenuItem
                    onClick={() => {
                      upsert({
                        ...structuredClone(active),
                        id: uid("sc"),
                        name: active.name + " copy",
                        origin: "user",
                        updatedAt: Date.now(),
                      });
                      close();
                    }}
                  >
                    Duplicate script
                  </MenuItem>
                )}
                {active && (
                  <MenuItem
                    onClick={() => {
                      const url = URL.createObjectURL(
                        new Blob([active.source], { type: "text/plain;charset=utf-8" }),
                      );
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = active.name + ".pine";
                      a.click();
                      URL.revokeObjectURL(url);
                      close();
                    }}
                  >
                    Export .pine file
                  </MenuItem>
                )}
                {active && (
                  <MenuItem
                    onClick={() => {
                      void compile();
                      close();
                    }}
                  >
                    Check script
                  </MenuItem>
                )}
                {!isDemoData() && (
                  <MenuItem
                    onClick={() => {
                      if (onLibraries) onLibraries();
                      else openPanel("libraries");
                      close();
                    }}
                  >
                    Pine dependencies…
                  </MenuItem>
                )}
              </div>
            )}
          </Popover>
        </div>
        {active ? (
          <>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5">
              <Input
                aria-label="Pine draft name"
                className="max-w-44 min-w-0"
                value={active.name}
                onChange={(e) =>
                  upsert({
                    ...active,
                    name: e.target.value,
                    updatedAt: Date.now(),
                  })
                }
              />
              <Button
                size="sm"
                variant="primary"
                onClick={addToChart}
                disabled={compiling}
                title="Compile and apply to the target chart (Ctrl/Cmd+Enter)"
              >
                <LineChart size={12} />{" "}
                {compiling ? "Checking…" : applied ? "Update on chart" : "Add to chart"}
              </Button>
              {compiling && (
                <IconButton
                  label="Cancel Pine run"
                  onClick={() => {
                    compileRun.current?.abort();
                    setCompiling(false);
                  }}
                >
                  <Square size={12} />
                </IconButton>
              )}
              {detectKind(active.source) === "strategy" && (
                <Button size="sm" onClick={backtest} disabled={running || compiling}>
                  <FlaskConical size={12} /> {running ? "Running…" : "Backtest"}
                </Button>
              )}
              {active.origin === "builder" && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={toBlocks}
                  title="Supported only for unmodified builder output"
                >
                  <Boxes size={12} /> Open as blocks
                </Button>
              )}
              <div className="flex-1" />
              <span className={cx("text-[11px]", syncError ? "text-down" : "text-muted")}>
                {syncError ? "Save needs attention" : detectKind(active.source) + " · auto-save"}
              </span>
            </div>
            <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-1 text-[11px] text-muted">
              <span>
                Target:{" "}
                {chart ? chart.symbol.split(":").at(-1) + " · " + chart.tf : "No chart selected"}
              </span>
              <button
                className="hover:text-text"
                onClick={() => useApp.getState().setView("workspace")}
              >
                View chart →
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <CodeEditor
                key={active.id}
                scriptId={active.id}
                onRun={addToChart}
                viewRef={viewRef}
              />
            </div>
            <Console
              result={result}
              tab={consoleTab}
              setTab={setConsoleTab}
              onGoto={goto}
              scriptId={active.id}
            />
          </>
        ) : (
          <Empty
            icon={<FileCode2 size={18} />}
            title="No script open"
            body="Import a .pine file, paste code, or create a new script."
            action={
              <Button onClick={() => newScript("indicator")}>
                <Plus size={13} /> New indicator
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}

function CodeEditor({
  scriptId,
  onRun,
  viewRef,
}: {
  scriptId: string;
  onRun: () => void;
  viewRef: React.MutableRefObject<EditorView | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const runRef = useRef(onRun);
  runRef.current = onRun;
  useEffect(() => {
    const script = useScripts.getState().scripts.find((s) => s.id === scriptId)!;
    let timer: ReturnType<typeof setTimeout>;
    let pushed = script.source;
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: script.source,
        extensions: [
          basicSetup,
          pineLanguage,
          pineHighlight,
          autocompletion({ override: [pineCompletions] }),
          keymap.of([indentWithTab, { key: "Mod-Enter", run: () => (runRef.current(), true) }]),
          EditorView.theme({
            "&": { color: "var(--text)" },
            ".cm-content": { caretColor: "var(--accent)" },
          }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            clearTimeout(timer);
            const src = u.state.doc.toString();
            timer = setTimeout(() => {
              pushed = src;
              useScripts.getState().update(scriptId, src);
              const t = detectTitle(src);
              const s = useScripts.getState().scripts.find((x) => x.id === scriptId);
              if (s && t !== "Untitled" && s.name !== t)
                useScripts.getState().upsert({ ...s, source: src, name: t, kind: detectKind(src) });
            }, 350);
          }),
        ],
      }),
    });
    viewRef.current = view;
    // external edits (inputs panel, agents) flow back into the editor
    const unsub = useScripts.subscribe((st) => {
      const src = st.scripts.find((x) => x.id === scriptId)?.source;
      if (src === undefined || src === pushed || src === view.state.doc.toString()) return;
      pushed = src;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: src },
      });
    });
    return () => {
      unsub();
      clearTimeout(timer);
      const source = view.state.doc.toString();
      if (source !== pushed) useScripts.getState().update(scriptId, source);
      view.destroy();
      viewRef.current = null;
    };
  }, [scriptId]);
  return <div ref={host} className="h-full overflow-hidden" />;
}

function Console({
  result,
  tab,
  setTab,
  onGoto,
  scriptId,
}: {
  result?: PineRunResult & { at: number };
  tab: "console" | "inputs";
  setTab: (t: "console" | "inputs") => void;
  onGoto: (l: number) => void;
  scriptId: string;
}) {
  const script = useScripts((s) => s.scripts.find((x) => x.id === scriptId));
  const [resolved, setResolved] = useState<{
    source: string;
    lock?: PineLibraryLock;
    error?: string;
  }>();
  useEffect(() => {
    if (!script || isDemoData()) return;
    let canceled = false;
    const timer = setTimeout(
      () =>
        void resolvePineOptions(script.source, {})
          .then((options) => {
            if (!canceled) setResolved({ source: script.source, lock: options.libraryLock });
          })
          .catch((error) => {
            if (!canceled) setResolved({ source: script.source, error: String(error) });
          }),
      400,
    );
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [script?.source]);
  const inputs = useMemo(
    () =>
      script
        ? parseInputs(script.source, resolved?.source === script.source ? resolved.lock : undefined)
        : [],
    [script?.source, resolved],
  );
  return (
    <div className="flex h-[150px] shrink-0 flex-col border-t border-line">
      <div className="flex h-8 items-center gap-2 px-2">
        <Segmented
          layoutId={`pine-console-${scriptId}`}
          value={tab}
          onChange={setTab}
          options={[
            { value: "console", label: "Console" },
            { value: "inputs", label: `Inputs · ${inputs.length}` },
          ]}
        />
        <div className="flex-1" />
        {tab === "inputs" && script && Object.keys(script.inputs ?? {}).length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => useScripts.getState().setInputs(script.id, {})}
          >
            Reset inputs
          </Button>
        )}
        {result && (
          <span className="num text-[11px] text-faint">
            {new Date(result.at).toLocaleTimeString()} · {result.ms.toFixed(0)} ms
          </span>
        )}
      </div>
      <div className="num min-h-0 flex-1 overflow-auto px-3 pb-2 text-[11.5px]">
        {tab === "console" ? (
          !result ? (
            <div className="text-faint">
              Add to chart (⌘/Ctrl↵) to run this script. Use the file menu to check it without
              adding.
            </div>
          ) : result.ok ? (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-up">
                <CheckCircle2 size={13} /> Compiled “{result.title}” · {result.kind} ·{" "}
                {result.overlay ? "overlay" : "separate pane"}
              </div>
              <div className="text-muted">
                Plots: {result.plots.map((p) => p.title).join(", ") || "—"}
              </div>
              {result.kind === "strategy" && (
                <div className="text-muted">Recorded fills: {result.signals.length}</div>
              )}
              {result.warnings.map((w, i) => (
                <div key={i} className="text-demo">
                  ⚠ {w}
                </div>
              ))}
            </div>
          ) : (
            <button
              onClick={() =>
                result.error?.reference && result.error.reference !== "strategy"
                  ? openPanel("libraries")
                  : result.error?.line && onGoto(result.error.line)
              }
              className="flex items-start gap-1.5 text-left text-down"
            >
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                {result.error?.line && (
                  <span className="mr-1.5 rounded bg-down/15 px-1 underline-offset-2 hover:underline">
                    {result.error.reference && result.error.reference !== "strategy"
                      ? `${result.error.reference} · `
                      : ""}
                    line {result.error.line}
                  </span>
                )}
                {result.error?.message}
              </span>
            </button>
          )
        ) : resolved?.source === script?.source && resolved?.error ? (
          <p role="alert" className="text-down">
            {resolved.error}
          </p>
        ) : inputs.length ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 pt-0.5 font-sans">
            {inputs.map((inp) => (
              <div key={inp.name} className="flex items-center justify-between gap-2 text-[12px]">
                <button className="text-muted hover:text-text" onClick={() => onGoto(inp.line)}>
                  {inp.title}
                </button>
                {inp.options?.length ? (
                  <Select
                    aria-label={inp.title}
                    className="max-w-36"
                    value={String(script?.inputs?.[inp.name] ?? inp.default)}
                    onChange={(e) =>
                      script &&
                      useScripts.getState().setInputs(script.id, {
                        ...script.inputs,
                        [inp.name]: ["int", "float"].includes(inp.type)
                          ? Number(e.target.value)
                          : e.target.value,
                      })
                    }
                  >
                    {inp.options.map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </Select>
                ) : (
                  <input
                    aria-label={inp.title}
                    key={`${scriptId}:${inp.name}:${String(script?.inputs?.[inp.name] ?? inp.default)}`}
                    type={
                      inp.type === "bool"
                        ? "checkbox"
                        : ["int", "float", "price", "time"].includes(inp.type)
                          ? "number"
                          : "text"
                    }
                    defaultValue={
                      inp.type === "bool"
                        ? undefined
                        : String(script?.inputs?.[inp.name] ?? inp.default)
                    }
                    defaultChecked={
                      inp.type === "bool"
                        ? Boolean(script?.inputs?.[inp.name] ?? inp.default)
                        : undefined
                    }
                    min={inp.min}
                    max={inp.max}
                    step={inp.type === "float" ? 0.1 : 1}
                    onChange={
                      inp.type === "bool" && script
                        ? (e) =>
                            useScripts.getState().setInputs(script.id, {
                              ...script.inputs,
                              [inp.name]: e.target.checked,
                            })
                        : undefined
                    }
                    onBlur={(e) => {
                      if (!script) return;
                      const v =
                        inp.type === "bool"
                          ? e.target.checked
                          : ["int", "float", "price", "time"].includes(inp.type)
                            ? Number(e.target.value)
                            : e.target.value;
                      if (
                        typeof v === "number" &&
                        (!Number.isFinite(v) ||
                          (inp.type === "int" && !Number.isInteger(v)) ||
                          (inp.min != null && v < inp.min) ||
                          (inp.max != null && v > inp.max))
                      ) {
                        e.target.value = String(script.inputs?.[inp.name] ?? inp.default);
                        useApp.getState().toast({
                          title: `Invalid value for ${inp.title}`,
                          body: "Use the declared input range and type",
                          tone: "error",
                        });
                        return;
                      }
                      useScripts.getState().setInputs(script.id, {
                        ...script.inputs,
                        [inp.name]: v,
                      });
                    }}
                    className="num h-6 w-20 rounded border border-line bg-panel-2 px-1.5 text-right outline-none focus:border-accent/60"
                  />
                )}
              </div>
            ))}
            <div className="col-span-2 text-[11px] text-faint">
              Inputs are saved with the script. Run again to apply. Per-chart overrides live in the
              chart legend ⚙.
            </div>
          </div>
        ) : (
          <div className="text-faint">No input.*() declarations found.</div>
        )}
      </div>
    </div>
  );
}
