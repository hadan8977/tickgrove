import { create } from "zustand";
import {
  clearDrawingHistory,
  useApp,
  useBuilder,
  useCharts,
  useScripts,
  useWorkspaces,
} from "../store";
import { validateWorkspace } from "./workspaceDocument";
import { command, setServiceToken } from "./client";
import { configureData } from "../data/feed";
import { loadWorkspace } from "../features/workspace/dock";
import { refreshAccount } from "./account";
import { pollNotifications, resetNotifications } from "./notifications";

export const useConnection = create<{
  connected: boolean;
  connecting: boolean;
  error: string;
  syncError: string;
  revision: number;
  permissions: string[];
  commands: string[];
}>()(() => ({
  connected: false,
  connecting: false,
  error: "",
  syncError: "",
  revision: 0,
  permissions: [],
  commands: [],
}));
type WorkspaceState = Record<string, any>;
let syncing = false,
  dirty = false,
  saving = false,
  timer: ReturnType<typeof setTimeout> | undefined,
  watcher: ReturnType<typeof setInterval> | undefined;
let unsubscribes: (() => void)[] = [];
function capture(): WorkspaceState {
  const charts = useCharts.getState(),
    workspaces = useWorkspaces.getState(),
    scripts = useScripts.getState(),
    builder = useBuilder.getState(),
    app = useApp.getState();
  return {
    schema: "trading.workspace.v1",
    charts: {
      charts: charts.charts,
      drawings: charts.drawings,
      watchlists: charts.watchlists,
      activeWatchlist: charts.activeWatchlist,
    },
    workspaces: {
      workspaces: workspaces.workspaces,
      activeId: workspaces.activeId,
    },
    scripts: {
      scripts: scripts.scripts,
      openIds: scripts.openIds,
      activeId: scripts.activeId,
    },
    builder: { defs: builder.defs, activeId: builder.activeId },
    app: { theme: app.theme, activeChartId: app.activeChartId },
  };
}
function restore(data: WorkspaceState) {
  const saved = validateWorkspace(data);
  syncing = true;
  try {
    useCharts.setState(saved.charts);
    useWorkspaces.setState(saved.workspaces);
    useScripts.setState(saved.scripts);
    if (saved.builder) useBuilder.setState(saved.builder);
    if (saved.app) useApp.setState(saved.app);
    clearDrawingHistory();
  } finally {
    syncing = false;
  }
}
export async function saveWorkspaceState() {
  if (
    !useConnection.getState().connected ||
    syncing ||
    saving ||
    useConnection.getState().syncError
  )
    return;
  if (!useConnection.getState().permissions.includes("workspace.write")) return;
  saving = true;
  dirty = false;
  try {
    const result = await command<{ revision: number }>("workspace.save", {
      id: "default",
      revision: useConnection.getState().revision,
      data: capture(),
    });
    useConnection.setState({ revision: result.revision });
  } catch (error) {
    dirty = true;
    useConnection.setState({ syncError: String(error) });
  } finally {
    saving = false;
    if (dirty && !useConnection.getState().syncError) queueSave();
  }
}
function queueSave() {
  if (syncing || !useConnection.getState().permissions.includes("workspace.write")) return;
  dirty = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void saveWorkspaceState(), 700);
}
function currentLayoutKey() {
  const state = useWorkspaces.getState(),
    doc = state.workspaces.find((w) => w.id === state.activeId);
  return JSON.stringify([
    state.activeId,
    window.innerWidth < 768 ? (doc?.mobileLayout ?? doc?.layout) : doc?.layout,
    doc?.preset,
  ]);
}
export async function reloadWorkspaceState() {
  const document = await command<{
    revision: number;
    data: WorkspaceState | null;
  }>("workspace.get", { id: "default" });
  if (document.data) restore(document.data);
  dirty = false;
  useConnection.setState({ revision: document.revision, syncError: "" });
  loadWorkspace(useWorkspaces.getState().activeId);
}
export function exportWorkspaceState() {
  return capture();
}
export async function importWorkspaceState(data: WorkspaceState) {
  if (!useConnection.getState().permissions.includes("workspace.write"))
    throw Error("Workspace import requires workspace.write permission");
  restore(data);
  loadWorkspace(useWorkspaces.getState().activeId);
  dirty = true;
  await saveWorkspaceState();
}
export async function connectService(token: string) {
  if (useConnection.getState().connecting || useConnection.getState().connected) return;
  useConnection.setState({ connecting: true, error: "" });
  setServiceToken(token);
  try {
    const capabilities = await command<{
      permissions: string[];
      commands: string[];
    }>("system.capabilities");
    const document = await command<{
      revision: number;
      data: WorkspaceState | null;
    }>("workspace.get", { id: "default" });
    if (document.data) restore(document.data);
    useConnection.setState({
      connected: true,
      revision: document.revision,
      permissions: capabilities.permissions,
      commands: capabilities.commands,
      syncError: "",
    });
    configureData("service", true);
    void refreshAccount();
    resetNotifications(capabilities.commands.includes("alerts.strategyHistory"));
    void pollNotifications();
    unsubscribes.forEach((off) => off());
    unsubscribes = [];
    for (const store of [useCharts, useWorkspaces, useScripts, useBuilder, useApp])
      unsubscribes.push(
        store.subscribe((state: any, old: any) => {
          if (
            store === useApp &&
            state.theme === old.theme &&
            state.activeChartId === old.activeChartId
          )
            return;
          queueSave();
        }),
      );
    if (watcher) clearInterval(watcher);
    watcher = setInterval(async () => {
      void refreshAccount();
      void pollNotifications();
      if (dirty || saving || syncing || useConnection.getState().syncError) return;
      try {
        const next = await command<{
          revision: number;
          data: WorkspaceState | null;
        }>("workspace.get", { id: "default" });
        if (next.revision > useConnection.getState().revision && next.data) {
          const before = currentLayoutKey();
          restore(next.data);
          useConnection.setState({ revision: next.revision });
          if (before !== currentLayoutKey()) loadWorkspace(useWorkspaces.getState().activeId);
        }
      } catch (error) {
        useConnection.setState({ syncError: String(error) });
      }
    }, 3000);
    if (!document.data) await saveWorkspaceState();
  } catch (error) {
    configureData("service", false);
    useConnection.setState({ connected: false, error: String(error) });
    throw error;
  } finally {
    useConnection.setState({ connecting: false });
  }
}
export function disconnectService() {
  unsubscribes.forEach((off) => off());
  unsubscribes = [];
  if (watcher) clearInterval(watcher);
  if (timer) clearTimeout(timer);
  dirty = false;
  setServiceToken("");
  configureData("service", false);
  useConnection.setState({ connected: false, permissions: [], syncError: "" });
}
