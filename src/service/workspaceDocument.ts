import { TIMEFRAMES, type ChartState, type Drawing, type Script } from "../core/types";
import type { StrategyDefinition } from "../builder/model";
import type { ThemeId, WorkspaceDoc } from "../store";

type JsonObject = Record<string, any>;
function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`Invalid workspace: ${label} must be an object`);
  return value as JsonObject;
}
function check(ok: unknown, label: string): asserts ok {
  if (!ok) throw Error(`Invalid workspace: ${label}`);
}
function text(value: unknown) {
  return typeof value === "string";
}
function id(value: unknown) {
  return (
    text(value) && !!value && !["__proto__", "prototype", "constructor"].includes(value as string)
  );
}
function list(value: unknown, label: string): any[] {
  check(Array.isArray(value) && value.length <= 10000, label);
  return value;
}
function unique(rows: any[], label: string) {
  const ids = rows.map((v) => v.id);
  check(ids.every(id) && new Set(ids).size === ids.length, `${label} IDs`);
}
function inputs(value: unknown) {
  if (value === undefined) return;
  const row = object(value, "inputs");
  check(
    Object.values(row).every(
      (v) => typeof v === "boolean" || text(v) || (typeof v === "number" && Number.isFinite(v)),
    ),
    "input values",
  );
}
function tree(value: unknown, depth = 0): void {
  const row = object(value, "builder node");
  check(depth < 32 && id(row.id), "builder node ID/depth");
  if (row.type === "group") {
    check(["all", "any"].includes(row.op), "builder group operation");
    list(row.children, "builder children").forEach((v) => tree(v, depth + 1));
    return;
  }
  check(
    row.type === "condition" && [">", "<", "crosses above", "crosses below"].includes(row.cmp),
    "builder condition",
  );
  for (const side of [row.left, row.right]) {
    const o = object(side, "operand");
    check(
      ["price", "sma", "ema", "rsi", "atr", "value", "macd", "volume"].includes(o.kind),
      "operand kind",
    );
    check(o.length === undefined || (Number.isInteger(o.length) && o.length > 0), "operand length");
    check(o.value === undefined || Number.isFinite(o.value), "operand value");
    check(
      o.field === undefined || ["open", "high", "low", "close"].includes(o.field),
      "operand field",
    );
  }
}

/** Validate all sections before changing any store. Return data fields only: imported JSON cannot replace store actions. */
export function validateWorkspace(value: unknown) {
  const data = object(value, "document");
  check(data.schema === "trading.workspace.v1", "unsupported schema");
  const c = object(data.charts, "charts"),
    w = object(data.workspaces, "workspaces"),
    s = object(data.scripts, "scripts");
  const charts = object(c.charts, "chart map");
  check(Object.keys(charts).length <= 100, "too many charts");
  for (const [key, raw] of Object.entries(charts)) {
    const v = object(raw, "chart");
    check(
      id(key) && v.id === key && text(v.symbol) && v.symbol && TIMEFRAMES.includes(v.tf),
      "chart identity",
    );
    check(
      ["candles", "bars", "line", "area"].includes(v.style) &&
        [null, "violet", "teal", "amber", "rose"].includes(v.group),
      "chart style/group",
    );
    const indicators = list(v.indicators, "indicators");
    unique(indicators, "indicator");
    for (const i of indicators) {
      check(
        ["builtin", "pine"].includes(i.kind) &&
          text(i.type) &&
          text(i.name) &&
          typeof i.visible === "boolean",
        "indicator",
      );
      inputs(i.inputs);
    }
    check(v.scale === undefined || ["linear", "log"].includes(v.scale), "chart scale");
    check(
      v.replayCursor == null || (Number.isInteger(v.replayCursor) && v.replayCursor >= 0),
      "replay cursor",
    );
    if (v.comparisons !== undefined)
      check(list(v.comparisons, "comparisons").every(text), "comparison symbols");
  }
  const drawings = object(c.drawings ?? {}, "drawings");
  for (const [symbol, values] of Object.entries(drawings)) {
    check(id(symbol), "drawing symbol");
    const rows = list(values, "drawings");
    unique(rows, "drawing");
    for (const d of rows) {
      check(["trend", "hline", "rect", "fib", "text"].includes(d.tool), "drawing tool");
      check(
        list(d.points, "drawing points").length > 0 &&
          d.points.every((p: any) => p && Number.isFinite(p.t) && Number.isFinite(p.p)),
        "drawing coordinates",
      );
      check(d.text === undefined || text(d.text), "drawing text");
    }
  }
  const watchlists = list(c.watchlists, "watchlists");
  check(watchlists.length > 0, "at least one watchlist is required");
  unique(watchlists, "watchlist");
  for (const v of watchlists)
    check(
      text(v.name) && list(v.symbols, "watchlist symbols").every((v) => text(v) && v),
      "watchlist",
    );
  check(
    watchlists.some((v) => v.id === c.activeWatchlist),
    "active watchlist",
  );
  const workspaces = list(w.workspaces, "workspaces");
  check(workspaces.length > 0, "at least one workspace is required");
  unique(workspaces, "workspace");
  for (const v of workspaces) {
    check(text(v.name) && text(v.preset) && Number.isFinite(v.updatedAt), "workspace fields");
    if (v.layout !== null) object(v.layout, "layout");
    if (v.mobileLayout != null) object(v.mobileLayout, "mobile layout");
  }
  check(
    workspaces.some((v) => v.id === w.activeId),
    "active workspace",
  );
  const scripts = list(s.scripts, "scripts");
  unique(scripts, "script");
  for (const v of scripts) {
    check(
      text(v.name) &&
        text(v.source) &&
        ["indicator", "strategy"].includes(v.kind) &&
        Number.isFinite(v.updatedAt),
      "script",
    );
    inputs(v.inputs);
  }
  const openIds = list(s.openIds, "open scripts");
  check(
    openIds.every((v) => scripts.some((sc) => sc.id === v)),
    "open script reference",
  );
  check(s.activeId === "" || openIds.includes(s.activeId), "active script");
  let builder: { defs: StrategyDefinition[]; activeId: string } | undefined;
  if (data.builder !== undefined) {
    const b = object(data.builder, "builder");
    const defs = list(b.defs, "builder definitions");
    unique(defs, "builder");
    for (const v of defs) {
      check(
        text(v.name) &&
          text(v.symbol) &&
          TIMEFRAMES.includes(v.tf) &&
          ["long", "short"].includes(v.direction) &&
          Number.isFinite(v.sizePct) &&
          v.sizePct > 0 &&
          Number.isFinite(v.updatedAt),
        "builder settings",
      );
      tree(v.entry);
      tree(v.exit);
      for (const key of ["stopPct", "takePct", "capital", "commissionBps", "slippageTicks"])
        check(v[key] == null || (Number.isFinite(v[key]) && v[key] >= 0), `builder ${key}`);
    }
    check(b.activeId === "" || defs.some((v) => v.id === b.activeId), "active builder");
    builder = { defs, activeId: b.activeId };
  }
  let app: { theme: ThemeId; activeChartId: string | null } | undefined;
  if (data.app !== undefined) {
    const a = object(data.app, "app");
    check(["light", "dark", "cobalt", "moss"].includes(a.theme), "theme");
    check(a.activeChartId == null || text(a.activeChartId), "active chart");
    app = {
      theme: a.theme,
      activeChartId:
        a.activeChartId && Object.prototype.hasOwnProperty.call(charts, a.activeChartId)
          ? a.activeChartId
          : null,
    };
  }
  return {
    charts: {
      charts: charts as Record<string, ChartState>,
      drawings: drawings as Record<string, Drawing[]>,
      watchlists: watchlists as { id: string; name: string; symbols: string[] }[],
      activeWatchlist: c.activeWatchlist as string,
    },
    workspaces: {
      workspaces: workspaces as WorkspaceDoc[],
      activeId: w.activeId as string,
    },
    scripts: {
      scripts: scripts as Script[],
      openIds: openIds as string[],
      activeId: s.activeId as string,
    },
    builder,
    app,
  };
}
