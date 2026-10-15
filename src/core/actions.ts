import { execute, registerCommand } from "./commands";
import type { BacktestConfig, PaperStrategy, PineReplayFrame, Timeframe } from "./types";
import { TIMEFRAMES } from "./types";
import { getBars, livePrice, isDemoData, marketRequest, subscribeMarket } from "../data/feed";
import { runServerStrategy } from "../service/runs";
import { command } from "../service/client";
import { accountAction, useAccount } from "../service/account";
import { saveWorkspaceState } from "../service/workspaceSync";
import { showPaperSession } from "../service/paperSelection";
import { detectKind, detectTitle } from "../pine/runtime";
import { runPineInWorker } from "../pine/client";
import { demoPineOptions } from "../pine/demo";
import { advanceReplay } from "../pine/replay";
import { runBacktest } from "../backtest/client";
import { evaluate, currentSignal, uid } from "../builder/model";
import { toPine } from "../builder/codegen";
import { getIndicator, listIndicators, defaultInputs } from "../indicators/registry";
import {
  getChart,
  targetChartId,
  useApp,
  useBacktests,
  useBuilder,
  useCharts,
  usePaper,
  useScripts,
  useWorkspaces,
} from "../store";
import {
  applyPreset,
  focusChartPanel,
  loadWorkspace,
  openPanel,
  PRESETS,
  GRID_PRESETS,
  WORKSPACE_TEMPLATES,
  replaceWorkspaceTemplate,
  undoWorkspaceTemplate,
  saveCurrentWorkspace,
  type PresetId,
} from "../features/workspace/dock";

const DEFAULT_BT: BacktestConfig = {
  capital: 100000,
  commissionBps: 2,
  slippageBps: 3,
  sizePct: 95,
};

/* ---------- service functions ---------- */
export async function backtestScript(scriptId: string, chartId?: string) {
  if (useBacktests.getState().running)
    throw Error("A run is already being submitted from this browser");
  const script = useScripts.getState().scripts.find((s) => s.id === scriptId);
  if (!script) throw new Error("Script not found");
  if (detectKind(script.source) !== "strategy")
    throw new Error("Only strategy() scripts can be backtested");
  const cid = targetChartId(chartId);
  const chart = getChart(cid);
  const symbol = chart?.symbol ?? "NVDA";
  const tf = chart?.tf ?? "1D";
  const allBars = getBars(symbol, tf);
  const bars = chart?.replayCursor != null ? allBars.slice(0, chart.replayCursor) : allBars;
  useBacktests.getState().setRunning(true);
  try {
    const run = isDemoData()
      ? await runPineInWorker(script.source, bars, tf, {
          ...demoPineOptions(symbol, tf, script.inputs),
          backtest: true,
        })
      : {
          ok: true,
          backtest: await runServerStrategy({
            name: script.name,
            source: script.source,
            symbol,
            tf,
            inputs: script.inputs,
            replayUntil: chart?.replayCursor != null ? bars.at(-1)?.time : undefined,
          }),
          error: undefined,
        };
    if (!run.ok)
      throw new Error(
        `Pine error${run.error?.line ? ` (line ${run.error.line})` : ""}: ${run.error?.message}`,
      );
    const res = run.backtest;
    if (!res) throw new Error("Pine runtime produced no strategy ledger");
    const id = uid("bt");
    useBacktests.getState().add({
      ...res,
      id,
      name: detectTitle(script.source),
      source: "pine",
      sourceRef: scriptId,
      symbol,
      tf,
      createdAt: Date.now(),
    });
    if (cid) useCharts.getState().setBacktest(cid, id);
    if (useApp.getState().view === "workspace") openPanel("backtest", {}, { direction: "below" });
    return `Backtest ${res.metrics.trades} trades · net ${res.metrics.netProfitPct.toFixed(2)}%`;
  } finally {
    useBacktests.getState().setRunning(false);
  }
}

export async function backtestBuilder(defId?: string) {
  if (useBacktests.getState().running)
    throw Error("A run is already being submitted from this browser");
  const st = useBuilder.getState();
  const def = st.defs.find((d) => d.id === (defId ?? st.activeId));
  if (!def) throw new Error("Strategy not found");
  if (
    !Number.isFinite(def.capital ?? 100000) ||
    (def.capital ?? 100000) <= 0 ||
    !Number.isFinite(def.commissionBps ?? 2) ||
    (def.commissionBps ?? 2) < 0 ||
    !Number.isInteger(def.slippageTicks ?? 3) ||
    (def.slippageTicks ?? 3) < 0
  )
    throw Error(
      "Use positive capital, nonnegative commission and a nonnegative integer slippage in ticks",
    );
  const bars = getBars(def.symbol, def.tf);
  useBacktests.getState().setRunning(true);
  try {
    const res = isDemoData()
      ? await runBacktest(
          bars,
          evaluate(def, bars),
          {
            ...DEFAULT_BT,
            sizePct: def.sizePct,
            stopPct: def.stopPct ?? undefined,
            takePct: def.takePct ?? undefined,
          },
          def.tf,
        )
      : await runServerStrategy({
          name: def.name,
          source: toPine(def),
          symbol: def.symbol,
          tf: def.tf,
        });
    const id = uid("bt");
    useBacktests.getState().add({
      ...res,
      id,
      name: def.name,
      source: "builder",
      sourceRef: def.id,
      symbol: def.symbol,
      tf: def.tf,
      createdAt: Date.now(),
    });
    // show on a chart with matching symbol, or retarget the active chart
    const charts = Object.values(useCharts.getState().charts);
    const match = charts.find((c) => c.symbol === def.symbol && c.tf === def.tf);
    const cid = match?.id ?? targetChartId();
    if (cid) {
      if (!match) {
        useCharts.getState().setSymbol(cid, def.symbol);
        useCharts.getState().setTf(cid, def.tf);
      }
      useCharts.getState().setBacktest(cid, id);
    }
    if (useApp.getState().view === "workspace") openPanel("backtest", {}, { direction: "below" });
    return `Backtest ${res.metrics.trades} trades · net ${res.metrics.netProfitPct.toFixed(2)}%`;
  } finally {
    useBacktests.getState().setRunning(false);
  }
}

const pineReplays = new Map<string, PineReplayFrame[]>();
const pendingPaperDeployments = new Map<string, Promise<string>>();

export async function deployToPaper(backtestId?: string) {
  const bt = useBacktests.getState();
  const r = bt.results.find((x) => x.id === (backtestId ?? bt.activeId));
  if (!r) throw new Error("No backtest to deploy");
  if (!isDemoData()) {
    if (!r.server) throw Error("Run this strategy on the server before deploying");
    const server = r.server;
    const pending = pendingPaperDeployments.get(r.id);
    if (pending) return pending;
    const deployment = (async () => {
      const subscription_id = await subscribeMarket(r.symbol, r.tf);
      const session = await command(
        "paper.deploy",
        {
          version_id: server.versionId,
          snapshot_id: server.snapshotId,
          inputs: server.inputs,
          execution: "closed_bar_native",
          subscription_id,
        },
        crypto.randomUUID(),
      );
      useApp.getState().toast({
        title: `Started ${r.name}`,
        body: "Its independent simulated account follows confirmed market bars.",
      });
      showPaperSession(session.session_id);
      return session.session_id as string;
    })();
    pendingPaperDeployments.set(r.id, deployment);
    try { return await deployment; }
    finally { pendingPaperDeployments.delete(r.id); }
  }
  const s: PaperStrategy = {
    id: uid("ps"),
    name: r.name,
    symbol: r.symbol,
    tf: r.tf,
    source: r.source,
    sourceRef: r.sourceRef,
    status: "running",
    startedAt: Date.now(),
    sizePct: r.config.sizePct,
  };
  if (r.source === "pine") {
    if (!r.replayFrames?.length)
      throw new Error("Run a new native Pine backtest before starting replay");
    pineReplays.set(s.id, structuredClone(r.replayFrames));
    s.replay = { cursor: 0, total: r.replayFrames.length };
    s.lastSignal = "Historical replay · independent native ledger";
  }
  usePaper.getState().addStrategy(s);
  useApp.getState().toast({
    title: r.source === "pine" ? `Started replay of "${r.name}"` : `Deployed "${r.name}" to paper`,
    body:
      r.source === "pine"
        ? "20 historical bars per step · view Strategies for equity and position"
        : `${r.symbol} · ${r.tf} · evaluates on each tick`,
    tone: "demo",
  });
  showPaperSession(s.id);
  return s.id;
}

/** Evaluate running paper strategies against the latest ticks. */
let evaluating = false;
export async function tickPaperStrategies() {
  if (evaluating) return;
  evaluating = true;
  try {
    const paper = usePaper.getState();
    for (const id of pineReplays.keys())
      if (!paper.strategies.some((s) => s.id === id && ["running", "paused"].includes(s.status)))
        pineReplays.delete(id);
    for (const st of paper.strategies.filter((x) => x.status === "running")) {
      if (st.source === "pine") {
        const frames = pineReplays.get(st.id);
        if (!frames || !st.replay) {
          usePaper.getState().patchStrategy(st.id, {
            status: "stopped",
            lastSignal: "Run a backtest to start a fresh historical replay",
          });
          continue;
        }
        const next = advanceReplay(frames, st.replay.cursor, 20);
        usePaper.getState().patchStrategy(st.id, {
          replay: next,
          status: next.completed ? "completed" : "running",
          lastSignal: `${next.cursor}/${next.total} bars · ${next.frame.closedTrades} closed trades`,
        });
        continue;
      }
      const bars = getBars(st.symbol, st.tf);
      let wantLong: boolean | null = null;
      const def = useBuilder.getState().defs.find((d) => d.id === st.sourceRef);
      if (!def) continue;
      const sig = currentSignal(def, bars);
      wantLong = sig.entry ? true : sig.exit ? false : null;
      const pos = usePaper.getState().positions[st.symbol];
      if (wantLong === true && !pos) {
        const qty =
          Math.floor(((usePaper.getState().cash * st.sizePct) / 100 / livePrice(st.symbol)) * 100) /
          100;
        if (qty > 0) {
          usePaper.getState().placeOrder({
            symbol: st.symbol,
            side: "buy",
            type: "market",
            qty,
            source: "strategy",
            strategyId: st.id,
          });
          usePaper
            .getState()
            .patchStrategy(st.id, { lastSignal: `Entry @ ${new Date().toLocaleTimeString()}` });
          useApp.getState().toast({
            title: `${st.name}: simulated entry`,
            body: `Bought ${qty} ${st.symbol}`,
            tone: "demo",
          });
        }
      } else if (wantLong === false && pos && pos.qty > 0) {
        usePaper.getState().flatten(st.symbol, "strategy");
        usePaper
          .getState()
          .patchStrategy(st.id, { lastSignal: `Exit @ ${new Date().toLocaleTimeString()}` });
      }
    }
  } finally {
    evaluating = false;
  }
}

/* ---------- command registrations ---------- */
export function registerCoreCommands() {
  registerCommand<{ symbol: string; chartId?: string }>({
    id: "chart.setSymbol",
    title: "Set chart symbol",
    category: "Chart",
    description: "Change the symbol of a chart; propagates to charts in the same link group.",
    scope: "workspace",
    params: {
      symbol: {
        type: "string",
        required: true,
        description: "Provider-qualified symbol, discovered through market search",
      },
      chartId: { type: "string", description: "Target chart (defaults to active)" },
    },
    run: ({ symbol, chartId }) => {
      const id = targetChartId(chartId);
      if (!id) throw new Error("No chart open");
      useCharts.getState().setSymbol(id, symbol);
      return `${symbol} on ${id}`;
    },
  });
  registerCommand<{ tf: Timeframe; chartId?: string }>({
    id: "chart.setTimeframe",
    title: "Set timeframe",
    category: "Chart",
    description: "Change chart interval.",
    scope: "workspace",
    params: {
      tf: { type: "enum", enum: TIMEFRAMES, required: true, description: "Interval" },
      chartId: { type: "string", description: "Target chart" },
    },
    run: ({ tf, chartId }) => {
      const id = targetChartId(chartId);
      if (!id) throw new Error("No chart open");
      useCharts.getState().setTf(id, tf);
    },
  });
  TIMEFRAMES.forEach((tf, i) =>
    registerCommand({
      id: `chart.tf.${tf}`,
      hidden: true,
      title: `Timeframe ${tf}`,
      category: "Chart",
      description: "",
      shortcut: String(i + 1),
      run: () => execute("chart.setTimeframe", { tf }, "shortcut"),
    }),
  );
  registerCommand<{ style: string; chartId?: string }>({
    id: "chart.setStyle",
    title: "Set chart style",
    category: "Chart",
    description: "Candles, bars, line or area.",
    scope: "workspace",
    params: {
      style: {
        type: "enum",
        enum: ["candles", "bars", "line", "area"],
        required: true,
        description: "Series style",
      },
      chartId: { type: "string", description: "Target chart" },
    },
    run: ({ style, chartId }) =>
      useCharts.getState().setStyle(targetChartId(chartId)!, style as any),
  });
  registerCommand<{ group: string; chartId?: string }>({
    id: "chart.setLinkGroup",
    title: "Set link group",
    category: "Chart",
    description: "Link symbol, interval and crosshair with other charts of the same color.",
    scope: "workspace",
    params: {
      group: {
        type: "enum",
        enum: ["violet", "teal", "amber", "rose", "none"],
        required: true,
        description: "Link color",
      },
      chartId: { type: "string", description: "Target chart" },
    },
    run: ({ group, chartId }) =>
      useCharts
        .getState()
        .setGroup(targetChartId(chartId)!, group === "none" ? null : (group as any)),
  });
  registerCommand<{ symbol?: string; tf?: Timeframe }>({
    id: "chart.open",
    title: "Open new chart",
    category: "Chart",
    description: "Add a chart panel to the workspace.",
    scope: "workspace",
    params: {
      symbol: { type: "string", description: "Provider-qualified symbol", default: "AAPL" },
      tf: { type: "enum", enum: TIMEFRAMES, description: "Interval", default: "1D" },
    },
    run: ({ symbol, tf }) => {
      useApp.getState().setView("workspace");
      const id = useCharts.getState().createChart({ symbol, tf, group: null });
      openPanel("chart", { chartId: id }, { direction: "right" });
      useApp.getState().setActiveChart(id);
      return id;
    },
  });
  registerCommand<{ indicator: string; chartId?: string }>({
    id: "indicator.add",
    title: "Add indicator",
    category: "Indicator",
    description: "Add a built-in or plugin indicator to a chart.",
    scope: "workspace",
    params: {
      indicator: {
        type: "string",
        required: true,
        description: `Indicator id (${listIndicators()
          .map((i) => i.id)
          .join(", ")})`,
      },
      chartId: { type: "string", description: "Target chart" },
    },
    run: ({ indicator, chartId }) => {
      const def = getIndicator(indicator);
      if (!def) throw new Error(`Unknown indicator "${indicator}"`);
      const id = targetChartId(chartId);
      if (!id) throw new Error("No chart open");
      return useCharts.getState().addIndicator(id, {
        kind: "builtin",
        type: def.id,
        name: def.short,
        inputs: defaultInputs(def),
      });
    },
  });
  registerCommand<{ indicatorId: string; chartId?: string }>({
    id: "indicator.remove",
    title: "Remove indicator",
    category: "Indicator",
    description: "Remove an indicator instance from a chart.",
    scope: "workspace",
    params: {
      indicatorId: { type: "string", required: true, description: "Indicator instance id" },
      chartId: { type: "string", description: "Target chart" },
    },
    run: ({ indicatorId, chartId }) =>
      useCharts.getState().removeIndicator(targetChartId(chartId)!, indicatorId),
  });
  const tools = ["cursor", "trend", "hline", "rect", "fib", "text"] as const;
  registerCommand<{ tool: string }>({
    id: "drawing.setTool",
    title: "Select drawing tool",
    category: "Drawing",
    description: "Activate a drawing tool on charts.",
    scope: "workspace",
    params: { tool: { type: "enum", enum: [...tools], required: true, description: "Tool" } },
    run: ({ tool }) => useApp.getState().setTool(tool as any),
  });
  registerCommand({
    id: "drawing.trend",
    hidden: true,
    title: "Trend line tool",
    category: "Drawing",
    description: "",
    shortcut: "Alt+T",
    run: () => useApp.getState().setTool("trend"),
  });
  registerCommand({
    id: "drawing.hline",
    hidden: true,
    title: "Horizontal line tool",
    category: "Drawing",
    description: "",
    shortcut: "Alt+H",
    run: () => useApp.getState().setTool("hline"),
  });
  registerCommand({
    id: "drawing.fib",
    hidden: true,
    title: "Fib retracement tool",
    category: "Drawing",
    description: "",
    shortcut: "Alt+F",
    run: () => useApp.getState().setTool("fib"),
  });
  registerCommand<{ chartId?: string }>({
    id: "drawing.clear",
    title: "Clear drawings",
    category: "Drawing",
    description: "Remove all drawings for the chart symbol.",
    scope: "workspace",
    params: { chartId: { type: "string", description: "Target chart" } },
    run: ({ chartId }) => {
      const c = getChart(targetChartId(chartId));
      if (c) useCharts.getState().clearDrawings(c.symbol);
    },
  });
  registerCommand<{ preset: string }>({
    id: "workspace.applyLayout",
    title: "Change chart grid",
    category: "Workspace",
    description: "Change the chart grid, retaining chart settings and temporarily hidden charts.",
    scope: "workspace",
    params: {
      preset: {
        type: "enum",
        enum: GRID_PRESETS.map((p) => p.id),
        required: true,
        description: "Preset",
      },
    },
    run: ({ preset }) => {
      useApp.getState().setView("workspace");
      applyPreset(preset as PresetId);
    },
  });
  registerCommand<{ preset: string }>({
    id: "workspace.replaceTemplate",
    title: "Replace workspace with template",
    category: "Workspace",
    description: "Replace the visible workspace with a template. Undo restores the previous layout and charts.",
    scope: "workspace",
    params: { preset: { type: "enum", enum: WORKSPACE_TEMPLATES.map((p) => p.id), required: true, description: "Workspace template" } },
    run: ({ preset }) => {
      useApp.getState().setView("workspace");
      replaceWorkspaceTemplate(preset as PresetId);
      return "Template applied. Use Layout → Undo template replacement to restore your charts.";
    },
  });
  registerCommand({
    id: "workspace.undoLayout", title: "Undo template replacement", category: "Workspace",
    description: "Restore the chart layout and settings from before the last template replacement.",
    scope: "workspace", run: () => undoWorkspaceTemplate(),
  });
  registerCommand({
    id: "workspace.save",
    title: "Save workspace",
    category: "Workspace",
    description: "Persist the current layout.",
    shortcut: "Mod+S",
    scope: "workspace",
    run: async () => {
      saveCurrentWorkspace();
      if (!isDemoData()) await saveWorkspaceState();
      useApp.getState().toast({ title: "Workspace saved" });
    },
  });
  registerCommand<{ name?: string }>({
    id: "workspace.create",
    title: "New workspace",
    category: "Workspace",
    description: "Create and switch to a new workspace.",
    scope: "workspace",
    params: { name: { type: "string", description: "Name", default: "Untitled" } },
    run: ({ name }) => {
      saveCurrentWorkspace();
      const id = uid("w");
      useWorkspaces.getState().add({
        id,
        name: name ?? "Untitled",
        layout: null,
        preset: "charts1",
        updatedAt: Date.now(),
      });
      useApp.getState().setView("workspace");
      loadWorkspace(id);
      return id;
    },
  });
  registerCommand<{ id: string }>({
    id: "workspace.switch",
    title: "Switch workspace",
    category: "Workspace",
    description: "Save current and load another workspace.",
    scope: "workspace",
    params: { id: { type: "string", required: true, description: "Workspace id" } },
    run: ({ id }) => {
      saveCurrentWorkspace();
      useWorkspaces.getState().setActive(id);
      useApp.getState().setView("workspace");
      loadWorkspace(id);
    },
  });
  registerCommand<{ panel: string }>({
    id: "panel.open",
    title: "Open panel",
    category: "Workspace",
    description: "Open or focus a panel.",
    scope: "workspace",
    params: {
      panel: {
        type: "enum",
        enum: [
          "watchlist",
          "detail",
          "pine",
          "libraries",
          "builder",
          "backtest",
          "ticket",
          "positions",
        ],
        required: true,
        description: "Panel type",
      },
    },
    run: ({ panel }) => {
      useApp.getState().setView("workspace");
      openPanel(panel, {}, { direction: "right" });
    },
  });
  registerCommand<{ scriptId?: string; chartId?: string }>({
    id: "pine.addToChart",
    title: "Add Pine script to chart",
    category: "Pine",
    description: "Apply a Pine indicator or strategy to a chart.",
    scope: "workspace",
    params: {
      scriptId: { type: "string", description: "Script id (defaults to active editor tab)" },
      chartId: { type: "string", description: "Target chart" },
    },
    run: ({ scriptId, chartId }) => {
      const sc = useScripts.getState();
      const script = sc.scripts.find((s) => s.id === (scriptId ?? sc.activeId));
      if (!script) throw new Error("Script not found");
      const id = targetChartId(chartId);
      if (!id) throw new Error("No chart open");
      const existing = useCharts
        .getState()
        .charts[id]?.indicators.find((i) => i.kind === "pine" && i.type === script.id);
      if (existing)
        useCharts
          .getState()
          .updateIndicator(id, existing.id, { name: detectTitle(script.source), visible: true });
      else
        useCharts.getState().addIndicator(id, {
          kind: "pine",
          type: script.id,
          name: detectTitle(script.source),
          inputs: {},
        });
      focusChartPanel(id);
      return `${existing ? "Updated" : "Added"} "${script.name}"`;
    },
  });
  registerCommand<{ name: string; source: string }>({
    id: "pine.createScript",
    title: "Create Pine script",
    category: "Pine",
    description: "Save a new script to the library and open it.",
    scope: "workspace",
    params: {
      name: { type: "string", required: true, description: "Name" },
      source: { type: "string", required: true, description: "Pine source" },
    },
    run: ({ name, source }) => {
      const id = uid("sc");
      useScripts.getState().upsert({
        id,
        name,
        source,
        kind: detectKind(source),
        updatedAt: Date.now(),
        origin: "user",
      });
      openPanel("pine");
      return id;
    },
  });
  registerCommand<{ scriptId?: string; chartId?: string }>({
    id: "backtest.runScript",
    title: "Backtest Pine strategy",
    category: "Backtest",
    description: "Run a Pine strategy on the target chart data.",
    scope: "read",
    params: {
      scriptId: { type: "string", description: "Script id (defaults to active)" },
      chartId: { type: "string", description: "Target chart" },
    },
    run: ({ scriptId, chartId }) =>
      backtestScript(scriptId ?? useScripts.getState().activeId, chartId),
  });
  registerCommand<{ strategyId?: string }>({
    id: "backtest.runBuilder",
    title: "Backtest visual strategy",
    category: "Backtest",
    description: "Evaluate the block strategy and backtest it.",
    scope: "read",
    params: { strategyId: { type: "string", description: "Builder strategy id" } },
    run: ({ strategyId }) => backtestBuilder(strategyId),
  });
  registerCommand<{ strategyId?: string }>({
    id: "strategy.generatePine",
    title: "Generate Pine from blocks",
    category: "Strategy",
    description: "One-way generation from the visual builder into a new Pine script.",
    scope: "workspace",
    params: { strategyId: { type: "string", description: "Builder strategy id" } },
    run: ({ strategyId }) => {
      const st = useBuilder.getState();
      const def = st.defs.find((d) => d.id === (strategyId ?? st.activeId));
      if (!def) throw new Error("Strategy not found");
      const existing = useScripts
        .getState()
        .scripts.find((s) => s.origin === "builder" && s.name === def.name);
      const id = existing?.id ?? uid("sc");
      useScripts.getState().upsert({
        id,
        name: def.name,
        source: toPine(def),
        kind: "strategy",
        updatedAt: Date.now(),
        origin: "builder",
      });
      openPanel("pine");
      return id;
    },
  });
  registerCommand<{ backtestId?: string }>({
    id: "paper.deploy",
    title: "Deploy strategy to local simulation",
    category: "Paper",
    description: "Bind an immutable strategy and inputs to a server market-data subscription.",
    scope: "paper",
    params: { backtestId: { type: "string", description: "Backtest id (defaults to active)" } },
    run: ({ backtestId }) => deployToPaper(backtestId),
  });
  registerCommand<{
    symbol: string;
    side: string;
    qty: number;
    type?: string;
    price?: number;
    stopPrice?: number;
  }>({
    id: "paper.placeOrder",
    title: "Place paper order",
    category: "Paper",
    description:
      "Submit a simulated order to the local paper broker. Never routes to a live broker.",
    scope: "paper",
    params: {
      symbol: { type: "string", required: true, description: "Provider-qualified symbol" },
      side: { type: "enum", enum: ["buy", "sell"], required: true, description: "Side" },
      qty: { type: "number", required: true, description: "Quantity" },
      type: {
        type: "enum",
        enum: ["market", "limit", "stop", "stop-limit"],
        default: "market",
        description: "Order type",
      },
      price: { type: "number", description: "Limit/stop price" },
      stopPrice: { type: "number", description: "Stop trigger price" },
    },
    run: async ({ symbol, side, qty, type = "market", price, stopPrice }, ctx) => {
      if (!isDemoData()) {
        const response = await accountAction("account.placeOrder", {
          ...marketRequest(symbol),
          side,
          qty,
          type,
          price: type === "stop" ? undefined : price,
          stopPrice: stopPrice ?? (type === "stop" ? price : undefined),
          client_order_id: crypto.randomUUID(),
        });
        useApp.getState().toast({
          title: `Local order ${response.status ?? "submitted"}`,
          body: response.error ?? `${side.toUpperCase()} ${qty} ${symbol}`,
          tone: response.status === "rejected" ? "error" : undefined,
        });
        return response.id;
      }
      if (type !== "market" && !price) throw new Error("price is required for limit/stop orders");
      const o = usePaper.getState().placeOrder({
        symbol,
        side: side as any,
        qty,
        type: type as any,
        price,
        source: ctx.source === "agent" ? "agent" : "manual",
      });
      useApp.getState().toast({
        title:
          o.status === "filled"
            ? `Simulated fill · ${side.toUpperCase()} ${qty} ${symbol}`
            : o.status === "rejected"
              ? "Order rejected"
              : `Working ${type} order`,
        body:
          o.status === "filled"
            ? `@ ${o.price?.toFixed(2)} · DEMO, no real order was sent`
            : undefined,
        tone: o.status === "rejected" ? "error" : "demo",
      });
      return o.id;
    },
  });
  registerCommand<{ symbol: string }>({
    id: "paper.flatten",
    title: "Flatten position",
    category: "Paper",
    description: "Close the paper position in a symbol at market.",
    scope: "paper",
    params: {
      symbol: { type: "string", required: true, description: "Provider-qualified symbol" },
    },
    run: ({ symbol }) =>
      isDemoData()
        ? usePaper.getState().flatten(symbol)
        : accountAction("account.flatten", {
            ...marketRequest(symbol),
            client_order_id: crypto.randomUUID(),
          }),
  });
  registerCommand<{ orderId: string }>({
    id: "paper.cancelOrder",
    title: "Cancel paper order",
    category: "Paper",
    description: "Cancel a working paper order.",
    scope: "paper",
    params: { orderId: { type: "string", required: true, description: "Order id" } },
    run: ({ orderId }) =>
      isDemoData()
        ? usePaper.getState().cancelOrder(orderId)
        : accountAction("account.cancelOrder", { id: orderId }),
  });
  registerCommand({
    id: "app.toggleTheme",
    title: "Cycle theme",
    category: "App",
    description: "Switch color theme.",
    run: () => {
      const a = useApp.getState();
      const order = ["light", "dark", "cobalt", "moss"] as const;
      a.setTheme(order[(order.indexOf(a.theme) + 1) % order.length]);
    },
  });
  registerCommand({
    id: "app.palette",
    hidden: true,
    title: "Command palette",
    category: "App",
    description: "",
    shortcut: "Mod+K",
    run: () => useApp.getState().setPalette(!useApp.getState().paletteOpen),
  });
  registerCommand<{ view: string }>({
    id: "app.navigate",
    title: "Navigate",
    category: "App",
    description: "Switch top-level view.",
    params: {
      view: {
        type: "enum",
        enum: ["workspace", "library", "integrations", "market", "alerts", "operations"],
        required: true,
        description: "View",
      },
    },
    run: ({ view }) => useApp.getState().setView(view as any),
  });
  registerCommand({
    id: "app.getState",
    title: "Export app state (JSON)",
    category: "App",
    description:
      "Structured snapshot of workspace, charts, scripts, backtests and paper account for agents.",
    scope: "read",
    run: () => exportState(),
  });
  registerCommand({
    id: "app.cancel",
    hidden: true,
    title: "Cancel",
    category: "App",
    description: "",
    shortcut: "Escape",
    run: () => {
      useApp.getState().setTool("cursor");
      useApp.getState().setPalette(false);
    },
  });
}

export function exportState() {
  const charts = useCharts.getState();
  const paper = usePaper.getState();
  const ws = useWorkspaces.getState();
  return {
    app: "tickgrove",
    version: "0.1.0",
    mode: isDemoData() ? "DEMO" : "SERVICE",
    time: new Date().toISOString(),
    view: useApp.getState().view,
    workspace: {
      active: ws.workspaces.find((w) => w.id === ws.activeId)?.name,
      all: ws.workspaces.map((w) => ({ id: w.id, name: w.name })),
    },
    activeChartId: useApp.getState().activeChartId,
    charts: Object.values(charts.charts).map((c) => ({
      id: c.id,
      symbol: c.symbol,
      tf: c.tf,
      link: c.group,
      style: c.style,
      indicators: c.indicators.map((i) => ({ id: i.id, name: i.name, inputs: i.inputs })),
      last: livePrice(c.symbol),
    })),
    scripts: useScripts
      .getState()
      .scripts.map((s) => ({ id: s.id, name: s.name, kind: detectKind(s.source) })),
    builder: useBuilder
      .getState()
      .defs.map((d) => ({ id: d.id, name: d.name, symbol: d.symbol, tf: d.tf })),
    backtests: useBacktests.getState().results.map((r) => ({
      id: r.id,
      name: r.name,
      symbol: r.symbol,
      tf: r.tf,
      metrics: r.metrics,
    })),
    paper: isDemoData()
      ? {
          cash: paper.cash,
          positions: Object.values(paper.positions),
          workingOrders: paper.orders.filter((o) => o.status === "working").length,
          strategies: paper.strategies.map((s) => ({ id: s.id, name: s.name, status: s.status })),
        }
      : useAccount.getState().data,
  };
}
