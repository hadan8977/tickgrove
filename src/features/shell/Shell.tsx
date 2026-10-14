import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Bot,
  Check,
  ChevronDown,
  Command as CmdIcon,
  LayoutGrid,
  LayoutDashboard,
  Library,
  Lock,
  Moon,
  Plug,
  Plus,
  Sun,
  X,
  Cpu,
  Database,
  FlaskConical,
  Radio,
  Search,
  Wallet,
  FileCode2,
  Bell,
  Settings2,
} from "lucide-react";
import { execute, listCommands } from "../../core/commands";
import { useApp, useCharts, useWorkspaces, usePaper, THEMES, isDarkTheme } from "../../store";
import { livePrice, isDemoData, marketSummary } from "../../data/feed";
import {
  useConnection,
  exportWorkspaceState,
  reloadWorkspaceState,
  disconnectService,
} from "../../service/workspaceSync";
import { useAccount } from "../../service/account";
import { useActivity, useTick } from "../../ui/hooks";
import { IconButton, Kbd, MenuItem, Popover, StatusBadge, cx, Button } from "../../ui/primitives";
import { Logo, LogoMark } from "../../brand/Logo";
import { PRESETS } from "../workspace/dock";
import SymbolSearch from "../chart/SymbolSearch";
import Shader from "./Shader";
import { ADAPTERS } from "../../core/adapters";

export function TopBar() {
  const { workspaces, activeId, rename, remove } = useWorkspaces();
  const view = useApp((s) => s.view);
  const theme = useApp((s) => s.theme);
  const [editing, setEditing] = useState<string | null>(null);
  const activeChart = useCharts((s) => s.charts[useApp.getState().activeChartId ?? ""]);
  useApp((s) => s.activeChartId);
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const h = () => setSearchOpen(true);
    window.addEventListener("oc:symbol-search", h);
    return () => window.removeEventListener("oc:symbol-search", h);
  }, []);
  return (
    <header className="relative z-40 flex h-12 shrink-0 items-center gap-2 pl-3 pr-2.5">
      <div className="relative flex shrink-0 items-center gap-2 pr-1">
        <span className="hidden sm:block">
          <Logo />
        </span>
        <span className="sm:hidden">
          <LogoMark size={25} />
        </span>
      </div>
      {/* workspace tabs */}
      <nav
        aria-label="Saved chart layouts"
        className={cx(
          "glass-flat no-scrollbar relative h-8 min-w-0 shrink items-center gap-0.5 overflow-x-auto rounded-xl p-0.5",
          view === "workspace" ? "flex" : "hidden",
        )}
      >
        {workspaces.map((w) => {
          const active = w.id === activeId && view === "workspace";
          return (
            <div key={w.id} className="group relative">
              {editing === w.id ? (
                <input
                  autoFocus
                  defaultValue={w.name}
                  onBlur={(e) => (rename(w.id, e.target.value || w.name), setEditing(null))}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  className="h-7 w-28 rounded-md bg-panel-2 px-2 text-[12.5px] outline-none ring-1 ring-accent/50"
                />
              ) : (
                <button
                  onClick={() => execute("workspace.switch", { id: w.id })}
                  onDoubleClick={() => setEditing(w.id)}
                  title="Double-click to rename"
                  className={cx(
                    "relative flex h-7 shrink-0 items-center gap-1.5 rounded-[9px] px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors",
                    active ? "text-text" : "text-muted hover:text-text",
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="ws-tab"
                      className="absolute inset-0 rounded-[9px] bg-panel-3/90 shadow-[inset_0_1px_0_var(--glass-edge),0_1px_3px_rgba(0,0,0,0.25)]"
                      transition={{ type: "spring", stiffness: 500, damping: 38 }}
                    />
                  )}
                  <span className="relative">{w.name}</span>
                  {workspaces.length > 1 && (
                    <span
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        const switching = w.id === activeId;
                        remove(w.id);
                        if (switching)
                          execute("workspace.switch", { id: useWorkspaces.getState().activeId });
                      }}
                      className="relative -mr-1 hidden rounded p-0.5 text-faint hover:text-text group-hover:block"
                    >
                      <X size={10} />
                    </span>
                  )}
                </button>
              )}
            </div>
          );
        })}
        <IconButton
          label="New workspace"
          onClick={() =>
            execute("workspace.create", { name: `Workspace ${workspaces.length + 1}` })
          }
        >
          <Plus size={14} />
        </IconButton>
      </nav>
      {view === "workspace" && (
        <Popover
          className="w-56"
          trigger={({ toggle }) => (
            <button
              onClick={toggle}
              title="Layout presets"
              className="relative flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-2 text-[12px] text-muted hover:bg-panel-2/70 hover:text-text"
            >
              <LayoutGrid size={14} /> <span className="hidden xl:inline">Layout</span>{" "}
              <ChevronDown size={11} />
            </button>
          )}
        >
          {(close) => (
            <div>
              <div className="px-2 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-faint">
                Apply preset to current workspace
              </div>
              {PRESETS.map((p) => (
                <MenuItem
                  key={p.id}
                  onClick={() => (execute("workspace.applyLayout", { preset: p.id }), close())}
                  right={<span className="text-[10.5px] text-faint">{p.hint}</span>}
                >
                  {p.label}
                </MenuItem>
              ))}
              <div className="mx-2 my-1 h-px bg-line" />
              <MenuItem onClick={() => (execute("workspace.save"), close())} right={<Kbd>⌘S</Kbd>}>
                Save layout
              </MenuItem>
            </div>
          )}
        </Popover>
      )}
      <div className="relative flex-1" />
      <Popover
        open={searchOpen}
        onOpenChange={setSearchOpen}
        align="right"
        className="w-[360px]"
        trigger={({ toggle }) => (
          <button
            onClick={toggle}
            title="Search symbols (/)"
            className="glass-flat relative flex h-8 shrink-0 items-center gap-2 rounded-xl px-2.5 text-[12.5px] text-muted transition-shadow hover:text-text lg:w-[200px]"
          >
            <Search size={13} className="text-faint" />
            <span className="max-w-24 truncate font-semibold text-text">
              {activeChart?.symbol?.split(":").at(-1) ?? "Symbol"}
            </span>
            <span className="hidden flex-1 truncate text-left text-faint lg:block">Search</span>
            <Kbd>/</Kbd>
          </button>
        )}
      >
        {(close) => (
          <SymbolSearch onPick={(s) => (execute("chart.setSymbol", { symbol: s }), close())} />
        )}
      </Popover>
      <ModeSwitch />
      <button
        onClick={() => useApp.getState().setPalette(true)}
        title="Command palette (⌘K)"
        className="glass-flat relative flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-[12px] text-muted hover:text-text"
      >
        <CmdIcon size={13} /> <span className="hidden xl:inline">Commands</span> <Kbd>⌘K</Kbd>
      </button>
      <Popover
        align="right"
        className="w-44"
        trigger={({ toggle }) => (
          <IconButton label="Theme" className="relative" onClick={toggle}>
            {isDarkTheme(theme) ? <Moon size={15} /> : <Sun size={15} />}
          </IconButton>
        )}
      >
        {(close) => (
          <div>
            <div className="px-2 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-faint">
              Theme
            </div>
            {THEMES.map((t) => (
              <MenuItem
                key={t.id}
                active={theme === t.id}
                onClick={() => (useApp.getState().setTheme(t.id), close())}
                right={theme === t.id ? <Check size={12} /> : undefined}
              >
                <span className="flex size-4 overflow-hidden rounded-full ring-1 ring-line-2">
                  <span className="w-1/2" style={{ background: t.swatch[0] }} />
                  <span className="w-1/2" style={{ background: t.swatch[1] }} />
                </span>
                {t.label}
              </MenuItem>
            ))}
          </div>
        )}
      </Popover>
    </header>
  );
}

function ModeSwitch() {
  if (!isDemoData())
    return (
      <button
        onClick={() => useApp.getState().setView("market")}
        className="hidden h-8 items-center gap-2 rounded-lg px-2 text-xs text-muted hover:bg-panel-2 md:flex"
        title="Data sources and coverage"
      >
        <Radio size={13} />
        <span>Data</span>
        <span>· Local paper</span>
      </button>
    );
  return (
    <div className="glass-flat relative flex h-8 shrink-0 items-center rounded-xl p-0.5">
      <span
        title="Demo data and simulated (paper) execution"
        className="flex h-7 items-center gap-1.5 rounded-[9px] bg-demo/14 px-2.5 text-[11px] font-semibold tracking-[0.08em] text-demo ring-1 ring-inset ring-demo/30"
      >
        <span className="size-1.5 rounded-full bg-demo" /> DEMO
      </span>
      <button
        onClick={() => useApp.getState().setLiveDialog(true)}
        title="Live trading is locked in this build"
        className="hidden h-7 items-center gap-1.5 rounded-[9px] px-2.5 text-[11px] font-semibold tracking-[0.08em] text-faint hover:text-live md:flex"
      >
        <Lock size={11} /> LIVE
      </button>
    </div>
  );
}

export function Rail() {
  const view = useApp((s) => s.view);
  const items = [
    { id: "workspace", icon: LayoutDashboard, label: "Charts" },
    { id: "library", icon: FileCode2, label: "Scripts" },
    ...(!isDemoData()
      ? [
          { id: "alerts" as const, icon: Bell, label: "Alerts" },
          { id: "market" as const, icon: Radio, label: "Data" },
          { id: "operations" as const, icon: Database, label: "Automation" },
        ]
      : []),
    { id: "integrations", icon: Settings2, label: "Settings" },
  ] as const;
  return (
    <aside
      aria-label="Main navigation"
      className="my-1 ml-1 mr-1 flex w-11 shrink-0 flex-col items-center gap-1 self-start rounded-xl border border-line bg-panel py-1.5 sm:w-16"
    >
      {items.map((it) => (
        <button
          key={it.id}
          aria-label={it.label}
          aria-current={view === it.id ? "page" : undefined}
          title={it.label}
          onClick={() => execute("app.navigate", { view: it.id })}
          className={cx(
            "relative flex h-9 w-9 flex-col items-center justify-center gap-1 rounded-lg transition-colors sm:h-12 sm:w-14",
            view === it.id ? "text-text" : "text-muted hover:text-text hover:bg-panel-2/70",
          )}
        >
          {view === it.id && (
            <motion.span
              layoutId="rail-active"
              className="absolute inset-0 rounded-xl bg-panel-3/90 shadow-[inset_0_1px_0_var(--glass-edge),0_2px_8px_-2px_rgba(0,0,0,0.35)]"
              transition={{ type: "spring", stiffness: 420, damping: 30 }}
            />
          )}
          <it.icon size={17} className="relative" />
          <span className="relative hidden text-[10px] font-medium sm:block">{it.label}</span>
        </button>
      ))}
    </aside>
  );
}

export function WorkspaceTasks() {
  return (
    <nav
      aria-label="Chart tasks"
      className="workspace-taskbar flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-y border-line bg-panel px-2 text-xs"
    >
      <button
        className="flex shrink-0 items-center gap-1.5 rounded px-2 py-1 hover:bg-panel-2"
        onClick={() => execute("panel.open", { panel: "pine" })}
      >
        <FileCode2 size={13} /> Pine Editor
      </button>
      <button
        className="flex shrink-0 items-center gap-1.5 rounded px-2 py-1 hover:bg-panel-2"
        onClick={() => execute("panel.open", { panel: "backtest" })}
      >
        <FlaskConical size={13} /> Backtest
      </button>
      <button
        className="flex shrink-0 items-center gap-1.5 rounded px-2 py-1 hover:bg-panel-2"
        onClick={() => execute("panel.open", { panel: "positions" })}
      >
        <Wallet size={13} /> Paper account
      </button>
      <button
        className="flex shrink-0 items-center gap-1.5 rounded px-2 py-1 hover:bg-panel-2"
        onClick={() => execute("panel.open", { panel: "ticket" })}
      >
        Order ticket
      </button>
      <span className="ml-auto hidden shrink-0 px-2 text-[11px] text-muted lg:block">
        Select a chart to target its tools · drag panel tabs to rearrange
      </span>
    </nav>
  );
}

function marketClock() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mins = et.getHours() * 60 + et.getMinutes();
  const wd = et.getDay();
  const open = wd > 0 && wd < 6 && mins >= 570 && mins < 960;
  return { time: et.toLocaleTimeString("en-US", { hour12: false }), open };
}

export function StatusBar() {
  useTick();
  const activity = useActivity();
  const agentCalls = activity.filter((a) => a.source === "agent").length;
  const clock = marketClock();
  const last = activity[0];
  const paper = usePaper();
  const connection = useConnection(),
    account = useAccount();
  const markets = marketSummary(),
    live = markets.filter((m) => m.status === "connected").length;
  const demo = isDemoData();
  const equity =
    paper.cash +
    Object.values(paper.positions).reduce((a, p: any) => a + p.qty * livePrice(p.symbol), 0);
  const tools = listCommands().filter((c) => !c.hidden).length;
  return (
    <footer className="relative z-30 flex h-7 min-w-0 shrink-0 items-center gap-2 whitespace-nowrap px-2 sm:gap-3 sm:px-3 text-[11px] text-muted">
      <span
        className="flex shrink-0 items-center gap-1.5"
        title={
          demo ? "Seeded synthetic quotes" : "See each chart for data source, delay and event time"
        }
      >
        <span
          className={cx("size-1.5 rounded-full", demo ? "bg-demo" : live ? "bg-up" : "bg-faint")}
        />{" "}
        {demo ? "Demo data" : `${live} connected streams`}
      </span>
      <span
        className="num flex shrink-0 items-center gap-1.5"
        title="Paper (simulated) account equity"
      >
        <Wallet size={11} /> Local paper{" "}
        <span className="hidden text-text sm:inline">
          {(demo ? equity : account.data?.equity)?.toLocaleString("en-US", {
            maximumFractionDigits: 0,
          }) ?? "—"}
        </span>
      </span>
      <span className="num hidden shrink-0 items-center gap-1.5 md:flex">
        <span className="hidden text-faint sm:inline">
          NY {clock.time.slice(0, 5)} · {demo ? "Synthetic session" : "Session shown per source"}
        </span>
      </span>
      {!demo && connection.syncError && (
        <Popover
          side="top"
          trigger={({ toggle }) => (
            <button onClick={toggle} className="max-w-24 truncate text-down sm:max-w-64">
              Workspace sync needs attention
            </button>
          )}
        >
          <div className="w-96 p-3 text-xs whitespace-normal">
            <p role="alert">{connection.syncError}</p>
            <p className="my-2">
              Your local draft is preserved. Export it before loading the latest server revision.
            </p>
            <Button
              onClick={() => {
                const a = document.createElement("a");
                a.href = URL.createObjectURL(
                  new Blob([JSON.stringify(exportWorkspaceState(), null, 2)], {
                    type: "application/json",
                  }),
                );
                a.download = "workspace-draft.json";
                a.click();
                URL.revokeObjectURL(a.href);
              }}
            >
              Export draft
            </Button>
            <Button
              onClick={() =>
                void reloadWorkspaceState().catch((e) =>
                  useApp.getState().toast({ title: String(e), tone: "error" }),
                )
              }
            >
              Load server revision
            </Button>
          </div>
        </Popover>
      )}
      <div className="flex-1" />
      <Popover
        align="right"
        side="top"
        className="w-[300px]"
        trigger={({ toggle, open }) => (
          <button
            onClick={toggle}
            aria-label="Connections"
            title="Connections & diagnostics"
            className={cx(
              "flex h-5 shrink-0 items-center gap-1.5 rounded-md px-1.5 transition-colors",
              open ? "bg-panel-2 text-text" : "hover:bg-panel-2/70 hover:text-text",
            )}
          >
            <Plug size={11} /> <span className="hidden sm:inline">Connections</span>{" "}
            <span className="size-1.5 rounded-full bg-nc" />
          </button>
        )}
      >
        <div className="p-1">
          <div className="px-1.5 pb-2 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-faint">
            Connections & diagnostics
          </div>
          <Diag
            icon={<Radio size={12} />}
            label="Market data"
            value={<span>{demo ? "Synthetic" : `${live} connected`}</span>}
            hint={demo ? "Seeded local feed" : "Provider, delay and quality shown on each chart"}
          />
          <Diag
            icon={<Wallet size={12} />}
            label="Execution"
            value={<span>{demo ? "Browser" : "Server"}</span>}
            hint="Local simulated account"
          />
          <Diag
            icon={<Bot size={12} />}
            label="API / CLI / MCP"
            value={<span>{demo ? "Demo commands" : "Rust service"}</span>}
            hint={`${tools} workspace commands · ${agentCalls} external calls in this tab`}
          />
          <div className="mx-1.5 my-1.5 h-px bg-line" />
          <Diag
            icon={<Cpu size={12} />}
            label="Pine runtime"
            value={<span className="num text-muted">PineTS</span>}
          />
          <Diag
            icon={<FlaskConical size={12} />}
            label="Backtest engine"
            value={<span className="num text-muted">{demo ? "Web Worker" : "Server jobs"}</span>}
          />
          <Diag
            icon={<Database size={12} />}
            label="Storage"
            value={
              <span className="num text-muted">
                {demo ? "localStorage" : `SQLite · revision ${connection.revision}`}
              </span>
            }
          />
          {!demo && (
            <Button size="sm" onClick={disconnectService}>
              Disconnect this browser
            </Button>
          )}
          {last && (
            <div className="num mt-1.5 truncate rounded-md bg-panel-2 px-2 py-1.5 text-[10.5px] text-faint">
              last · <span className={last.ok ? "text-muted" : "text-down"}>{last.command}</span> ·{" "}
              {last.source}
            </div>
          )}
          <div className="num px-1.5 pt-2 text-[10.5px] text-faint">Open Composer v0.1.0</div>
        </div>
      </Popover>
    </footer>
  );
}
const Diag = ({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: string;
}) => (
  <div className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[12px]">
    <span className="text-faint">{icon}</span>
    <span className="flex-1">
      {label}
      {hint && <span className="block text-[10.5px] text-faint">{hint}</span>}
    </span>
    {value}
  </div>
);

export function LiveDialog() {
  const open = useApp((s) => s.liveDialog);
  const close = () => useApp.getState().setLiveDialog(false);
  const brokers = ADAPTERS.filter((a) => a.kind === "broker" && a.id !== "paper");
  const [typed, setTyped] = useState("");
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[80] grid place-items-center bg-black/45 backdrop-blur-[3px]"
          onPointerDown={(e) => e.target === e.currentTarget && close()}
        >
          <motion.div
            initial={{ y: 12, scale: 0.97 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 12, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className="glass w-[460px] overflow-hidden rounded-2xl"
          >
            <div className="border-b border-line p-5">
              <div className="mb-2 flex items-center gap-2">
                <span className="grid size-8 place-items-center rounded-lg bg-live/12 text-live ring-1 ring-live/30">
                  <Lock size={15} />
                </span>
                <div className="text-[15px] font-semibold">Live trading is locked</div>
              </div>
              <p className="text-[12.5px] leading-relaxed text-muted">
                This build only runs in <b className="text-demo">DEMO</b> mode. The interface and
                interfaces for live execution are reserved, but cannot be enabled. All orders go to
                the local paper broker.
              </p>
            </div>
            <div className="space-y-3 p-5">
              <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
                {(
                  [
                    ["demo", "Sample data and local simulation. Everything you see now."],
                    ["not-connected", "Adapter configured, but no session established."],
                    ["live", "Real money. Needs broker + double confirmation."],
                  ] as const
                ).map(([s, d]) => (
                  <div key={s} className="rounded-lg bg-panel-2/70 p-2 ring-1 ring-line">
                    <StatusBadge status={s} />
                    <div className="mt-1.5 leading-snug text-muted">{d}</div>
                  </div>
                ))}
              </div>
              <div className="space-y-1.5">
                <Req ok={false} label="Connect a live broker adapter">
                  <span className="flex gap-1">
                    {brokers.map((b) => (
                      <span key={b.id} className="text-faint">
                        {b.name}
                      </span>
                    ))}
                  </span>
                </Req>
                <Req ok={false} label="Account authentication" />
                <Req ok={typed === "LIVE"} label="Type LIVE to confirm intent">
                  <input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value.toUpperCase())}
                    placeholder="LIVE"
                    className="num h-6 w-16 rounded border border-line bg-panel-2 px-1.5 text-center text-[11px] outline-none"
                  />
                </Req>
                <Req ok={false} label="Second confirmation at order time" />
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-line bg-panel-2/40 px-5 py-3">
              <span className="text-[11px] text-faint">
                Live execution is not available in this release.
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={close}>
                  Stay in Demo
                </Button>
                <Button disabled className="!bg-live/20 !text-live">
                  <Lock size={12} /> Enable live
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
const Req = ({
  ok,
  label,
  children,
}: {
  ok: boolean;
  label: string;
  children?: React.ReactNode;
}) => (
  <div className="flex items-center gap-2 text-[12px]">
    <span
      className={cx(
        "grid size-4 place-items-center rounded-full",
        ok ? "bg-up/20 text-up" : "bg-panel-3 text-faint",
      )}
    >
      {ok ? <Check size={10} /> : <X size={10} />}
    </span>
    <span className="flex-1 text-muted">{label}</span>
    {children}
  </div>
);

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-10 right-4 z-[90] flex w-[320px] max-w-[calc(100vw-32px)] flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, x: 30, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 30, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 480, damping: 34 }}
            className="glass pointer-events-auto flex gap-2.5 rounded-xl p-3"
            onClick={() => dismiss(t.id)}
          >
            <span
              className={cx(
                "mt-1 size-2 shrink-0 rounded-full",
                t.tone === "error"
                  ? "bg-down"
                  : t.tone === "demo"
                    ? "bg-demo"
                    : t.tone === "up"
                      ? "bg-up"
                      : "bg-accent",
              )}
            />
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium">{t.title}</div>
              {t.body && <div className="mt-0.5 text-[11.5px] text-muted">{t.body}</div>}
            </div>
            {t.tone === "demo" && <StatusBadge status="demo" className="ml-auto shrink-0" />}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function Splash({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 1500);
    return () => clearTimeout(t);
  }, []);
  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.02 }}
      transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}
      className="fixed inset-0 z-[100] grid place-items-center overflow-hidden bg-bg"
      onClick={onDone}
    >
      <Shader className="absolute inset-0 h-full w-full" intensity={1} />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,var(--bg)_75%)]" />
      <motion.div
        initial={{ opacity: 0, y: 10, filter: "blur(8px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.7, ease: [0.2, 0.8, 0.2, 1] }}
        className="relative flex flex-col items-center gap-4"
      >
        <motion.div
          initial={{ rotate: -90, scale: 0.7 }}
          animate={{ rotate: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 120, damping: 14 }}
        >
          <LogoMark size={64} />
        </motion.div>
        <div className="text-[28px] font-semibold tracking-[-0.03em]">
          Open <span className="font-normal text-muted">Composer</span>
        </div>
        <div className="text-[12.5px] text-muted">
          Open-source trading workbench · charts, Pine, strategies, paper
        </div>
        <motion.div className="mt-2 h-[2px] w-40 overflow-hidden rounded-full bg-line-2">
          <motion.div
            initial={{ x: "-100%" }}
            animate={{ x: "0%" }}
            transition={{ duration: 1.3, ease: "easeInOut" }}
            className="h-full w-full bg-gradient-to-r from-accent to-accent-2"
          />
        </motion.div>
      </motion.div>
    </motion.div>
  );
}

/** Global keyboard → command bindings. */
export function useShortcuts() {
  const ref = useRef(false);
  useEffect(() => {
    if (ref.current) return;
    ref.current = true;
    const h = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.closest?.("input, textarea, select, .cm-editor, [contenteditable]");
      const mod = e.metaKey || e.ctrlKey;
      const key = `${mod ? "Mod+" : ""}${e.altKey ? "Alt+" : ""}${e.key.length === 1 ? e.key.toUpperCase() : e.key}`;
      if (key === "Mod+K" || key === "Mod+S") {
        e.preventDefault();
        const c = listCommands().find((x) => x.shortcut === key);
        if (c) execute(c.id, {}, "shortcut");
        return;
      }
      if (typing) return;
      if (e.key === "/") {
        e.preventDefault();
        window.dispatchEvent(new Event("oc:symbol-search"));
        return;
      }
      // Alt+letter produces special chars on macOS; use e.code
      const altKey = e.altKey && e.code.startsWith("Key") ? `Alt+${e.code.slice(3)}` : null;
      const c = listCommands().find(
        (x) =>
          x.shortcut &&
          (x.shortcut === key ||
            x.shortcut === altKey ||
            (x.shortcut === e.key && !mod && !e.altKey)),
      );
      if (c) {
        e.preventDefault();
        execute(c.id, {}, "shortcut").catch(() => {});
      }
    };
    window.addEventListener("keydown", h);
  }, []);
}
