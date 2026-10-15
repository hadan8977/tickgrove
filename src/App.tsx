import { compatibleStorage } from "./brand/storage";
import ServiceWorkbench from "./service/ServiceWorkbench";
import ConnectionGate from "./service/ConnectionGate";
import MarketPanel from "./service/MarketPanel";
import AlertsPanel from "./service/AlertsPanel";
import { useConnection } from "./service/workspaceSync";
import { useEffect, useLayoutEffect, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { execute, listCommands, commandSchema, getActivity } from "./core/commands";
import { exportState, registerCoreCommands, tickPaperStrategies } from "./core/actions";
import { initPlugins } from "./plugins";
import { subscribeTicks, isDemoData, configureData } from "./data/feed";
import { useApp, usePaper } from "./store";
import Workspace from "./features/workspace/Workspace";
import Integrations from "./features/integrations/Integrations";
import LibraryPage from "./features/library/LibraryPage";
import CommandPalette from "./features/shell/CommandPalette";
import Shader, { pulseField } from "./features/shell/Shader";
import {
  LiveDialog,
  Rail,
  Splash,
  StatusBar,
  Toasts,
  TopBar,
  WorkspaceTasks,
  useShortcuts,
} from "./features/shell/Shell";

// ---- one-time bootstrap (module scope survives HMR re-renders) ----
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  registerCoreCommands();
  initPlugins();
  // Offline demo-only in-page command surface. Server bridges use /api/command.
  const api = {
    version: "0.1.0",
    mode: isDemoData() ? "DEMO" : "SERVICE",
    commands: () =>
      listCommands()
        .filter((c) => !c.hidden)
        .map((c) => ({
          id: c.id,
          title: c.title,
          description: c.description,
          scope: c.scope,
          inputSchema: commandSchema(c),
        })),
    execute: (id: string, params?: Record<string, unknown>) => execute(id, params ?? {}, "agent"),
    state: exportState,
    activity: () => getActivity().slice(0, 50),
  };
  (window as any).tickgrove = api;
  // Compatibility for existing integrations; all new examples use window.tickgrove.
  (window as any).openComposer = api;
  if (!isDemoData()) return;
  configureData("demo", false);
  let n = 0;
  subscribeTicks((prices) => {
    const fills = usePaper.getState().processTick(prices);
    for (const f of fills)
      useApp.getState().toast({
        title: `Simulated fill · ${f.side.toUpperCase()} ${f.qty} ${f.symbol}`,
        body: `@ ${f.price.toFixed(2)} · working order triggered`,
        tone: "demo",
      });
    if (++n % 5 === 0) tickPaperStrategies();
  });
}

export default function App() {
  const serviceMode = !isDemoData();
  const connected = useConnection((s) => s.connected);
  const theme = useApp((s) => s.theme);
  const view = useApp((s) => s.view);
  const [splash, setSplash] = useState(
    () => !compatibleStorage(sessionStorage).getItem("tickgrove.splash"),
  );
  useShortcuts();
  useEffect(() => {
    boot();
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    pulseField(0.02, 0.1 + (view === "workspace" ? 0 : view === "library" ? 0.05 : 0.1));
  }, [view]);
  useEffect(() => {
    document.title = "Tickgrove";
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/svg+xml";
    link.href = "/favicon.svg?v=tickgrove-2";
  }, []);
  if (serviceMode && !connected) return <ConnectionGate />;
  return (
    <MotionConfig reducedMotion="user">
      <div className="relative isolate flex h-full flex-col bg-bg text-text">
        {!serviceMode && (
          <div className="bg-demo/10 px-4 py-1 text-xs text-demo">
            Synthetic demo · browser-only accounts ·{" "}
            <a href="/" className="underline">
              Connect to the server workspace
            </a>
          </div>
        )}
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <Rail />
          <main className="relative min-w-0 flex-1">
            <div
              className={
                view === "workspace"
                  ? "flex h-full flex-col"
                  : "invisible flex h-full flex-col opacity-0"
              }
            >
              <WorkspaceTasks />
              <div className="min-h-0 flex-1">
                <Workspace />
              </div>
            </div>
            <AnimatePresence>
              {view !== "workspace" && (
                <motion.div
                  key={view}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.1 }}
                  className="absolute inset-0 z-10"
                >
                  {view === "integrations" ? (
                    <Integrations />
                  ) : view === "market" ? (
                    <MarketPanel />
                  ) : view === "alerts" ? (
                    <AlertsPanel />
                  ) : view === "operations" ? (
                    <ServiceWorkbench preconnected />
                  ) : (
                    <LibraryPage />
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </main>
        </div>
        <StatusBar />
        <CommandPalette />
        <LiveDialog />
        <Toasts />
        <AnimatePresence>
          {splash && !serviceMode && (
            <Splash
              onDone={() => {
                compatibleStorage(sessionStorage).setItem("tickgrove.splash", "1");
                setSplash(false);
              }}
            />
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
