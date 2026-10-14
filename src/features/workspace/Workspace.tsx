import { useEffect, useState, useSyncExternalStore } from "react";
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelProps,
} from "dockview-react";
import {
  Boxes,
  CandlestickChart,
  FileCode2,
  FlaskConical,
  LayoutGrid,
  List,
  Maximize2,
  Minimize2,
  Plus,
  Puzzle,
  Receipt,
  Wallet,
  BookOpenText,
} from "lucide-react";
import ChartPanel from "../chart/ChartPanel";
import Watchlist from "../watchlist/Watchlist";
import SymbolDetail from "../watchlist/SymbolDetail";
import PineEditor from "../pine/PineEditor";
import StrategyBuilder from "../builder/StrategyBuilder";
import BacktestReport from "../backtest/BacktestReport";
import OrderTicket from "../trading/OrderTicket";
import PaperAccount from "../trading/PaperAccount";
import PineLibraries from "../../service/PineLibraries";
import { getPluginPanel, listPluginPanels, subscribePluginPanels } from "../../plugins";
import { useApp, useCharts, useWorkspaces, isDarkTheme } from "../../store";
import {
  applyPreset,
  loadWorkspace,
  openPanel,
  saveCurrentWorkspace,
  setDockApi,
  getDockApi,
  syncChartTitles,
} from "./dock";
import { Empty, IconButton, MenuItem, Popover } from "../../ui/primitives";
import { LogoMark } from "../../brand/Logo";

const components: Record<string, React.FunctionComponent<IDockviewPanelProps<any>>> = {
  chart: (p) => <ChartPanel chartId={p.params.chartId} />,
  watchlist: () => <Watchlist />,
  detail: () => <SymbolDetail />,
  pine: () => <PineEditor />,
  builder: () => <StrategyBuilder />,
  backtest: () => <BacktestReport />,
  ticket: () => <OrderTicket />,
  positions: () => <PaperAccount />,
  libraries: () => <PineLibraries />,
  plugin: (p) => <PluginHost id={p.params.pluginPanel} />,
};

function PluginHost({ id }: { id: string }) {
  useSyncExternalStore(subscribePluginPanels, () => getPluginPanel(id));
  const entry = getPluginPanel(id);
  if (!entry)
    return (
      <Empty
        icon={<Puzzle size={18} />}
        title="Plugin disabled"
        body="Enable this plugin in Integrations → Plugins to restore the panel."
      />
    );
  const C = entry.component;
  return <C />;
}

export const PANEL_MENU = [
  { id: "chart", label: "Chart", icon: CandlestickChart },
  { id: "watchlist", label: "Watchlist", icon: List },
  { id: "detail", label: "Symbol · Depth", icon: BookOpenText },
  { id: "pine", label: "Pine Editor", icon: FileCode2 },
  { id: "libraries", label: "Pine imports", icon: BookOpenText },
  { id: "builder", label: "Strategy Builder", icon: Boxes },
  { id: "backtest", label: "Backtest Report", icon: FlaskConical },
  { id: "ticket", label: "Order Ticket", icon: Receipt },
  { id: "positions", label: "Paper Account", icon: Wallet },
];

export function addPanelById(id: string, reference?: string) {
  if (id.startsWith("plugin:")) {
    const pid = id.slice(7);
    return openPanel(
      "plugin",
      { pluginPanel: pid, title: getPluginPanel(pid)?.title },
      { reference, direction: "within" },
    );
  }
  if (id === "chart") {
    const active = useCharts.getState().charts[useApp.getState().activeChartId ?? ""];
    const cid = useCharts.getState().createChart({
      symbol: active?.symbol ?? "AAPL",
      tf: active?.tf ?? "1D",
      group: null,
    });
    useApp.getState().setActiveChart(cid);
    return openPanel(
      "chart",
      { chartId: cid },
      {
        reference,
        direction: "right",
      },
    );
  }
  return openPanel(id, {}, { reference, direction: "within" });
}

function AddMenu({ reference }: { reference?: string }) {
  const plugins = useSyncExternalStore(subscribePluginPanels, () =>
    listPluginPanels()
      .map((p) => p.id)
      .join(),
  );
  return (
    <Popover
      align="right"
      className="w-52"
      trigger={({ toggle }) => (
        <IconButton label="Add panel" onClick={toggle}>
          <Plus size={14} />
        </IconButton>
      )}
    >
      {(close) => (
        <div>
          {PANEL_MENU.map((m) => (
            <MenuItem
              key={m.id}
              onClick={() => {
                addPanelById(m.id, reference);
                close();
              }}
            >
              <m.icon size={14} className="text-muted" />
              {m.label}
            </MenuItem>
          ))}
          {plugins && <div className="mx-2 my-1 h-px bg-line" />}
          {listPluginPanels().map((p) => (
            <MenuItem
              key={p.id}
              onClick={() => {
                addPanelById("plugin:" + p.id, reference);
                close();
              }}
              right={<span className="text-[10px] text-accent">plugin</span>}
            >
              <Puzzle size={14} className="text-muted" />
              {p.title}
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}

function HeaderActions(props: IDockviewHeaderActionsProps) {
  const [max, setMax] = useState(props.api.isMaximized());
  useEffect(() => {
    const d = props.containerApi.onDidMaximizedGroupChange(() => setMax(props.api.isMaximized()));
    return () => d.dispose();
  }, [props.api, props.containerApi]);
  return (
    <div className="flex h-full items-center gap-0.5 px-1">
      <AddMenu reference={props.activePanel?.id} />
      <IconButton
        label={max ? "Restore" : "Maximize"}
        onClick={() => (max ? props.api.exitMaximized() : props.api.maximize())}
      >
        {max ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </IconButton>
    </div>
  );
}

function Watermark() {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-3 text-center">
        <LogoMark size={40} />
        <div className="text-[13px] font-medium">Empty workspace</div>
        <div className="text-[12px] text-muted">
          Add a panel or apply a layout preset from the top bar.
        </div>
        <div className="flex gap-2">
          <button
            className="flex items-center gap-1.5 rounded-lg bg-panel-2 px-3 py-1.5 text-[12px] ring-1 ring-line hover:ring-line-2"
            onClick={() => addPanelById("chart")}
          >
            <CandlestickChart size={13} /> New chart
          </button>
          <button
            className="flex items-center gap-1.5 rounded-lg bg-panel-2 px-3 py-1.5 text-[12px] ring-1 ring-line hover:ring-line-2"
            onClick={() => applyPreset("charts4")}
          >
            <LayoutGrid size={13} /> 4-chart layout
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Workspace() {
  const theme = useApp((s) => s.theme);
  const [mobilePanels, setMobilePanels] = useState<
      {
        id: string;
        title: string;
      }[]
    >([]),
    [mobileActive, setMobileActive] = useState("");
  const onReady = (e: DockviewReadyEvent) => {
    setDockApi(e.api);
    loadWorkspace(useWorkspaces.getState().activeId);
    const refreshPanels = () => {
      setMobilePanels(e.api.panels.map((p) => ({ id: p.id, title: p.api.title ?? p.id })));
      setMobileActive(e.api.activePanel?.id ?? "");
    };
    refreshPanels();
    if (window.innerWidth < 768 && e.api.activePanel) e.api.maximizeGroup(e.api.activePanel);
    let t: ReturnType<typeof setTimeout>;
    e.api.onDidLayoutChange(() => {
      refreshPanels();
      clearTimeout(t);
      t = setTimeout(saveCurrentWorkspace, 600);
    });
    e.api.onDidActivePanelChange((ev) => {
      refreshPanels();
      if (window.innerWidth < 768 && ev.panel && !ev.panel.group.api.isMaximized())
        e.api.maximizeGroup(ev.panel);
      const cid = (ev.panel?.params as any)?.chartId;
      if (cid) useApp.getState().setActiveChart(cid);
    });
  };
  useEffect(() => {
    const media = window.matchMedia("(max-width:767px)");
    const resize = () => {
      const api = getDockApi();
      if (!api) return;
      loadWorkspace(useWorkspaces.getState().activeId);
      if (media.matches && api.activePanel) api.maximizeGroup(api.activePanel);
      else if (!media.matches) api.exitMaximizedGroup();
    };
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    const unsub = useCharts.subscribe(syncChartTitles);
    return () => {
      unsub();
      // Keep the dock API: StrictMode re-runs this effect without re-firing onReady,
      // so nulling it here would silently disable saving and panel commands.
      saveCurrentWorkspace();
    };
  }, []);
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel p-2 text-xs md:hidden">
        <label className="flex min-w-0 flex-1 items-center gap-2">
          Panel
          <select
            aria-label="Workspace panel"
            className="min-w-0 flex-1 rounded bg-panel-2 p-1"
            value={mobileActive}
            onChange={(e) => {
              const api = getDockApi(),
                panel = api?.getPanel(e.target.value);
              if (api && panel) {
                panel.api.setActive();
                api.maximizeGroup(panel);
              }
            }}
          >
            {mobilePanels.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        <AddMenu />
      </div>
      <div className="min-h-0 flex-1">
        <DockviewReact
          className="h-full"
          theme={{
            name: "tickgrove",
            className: "dockview-theme-tickgrove",
            colorScheme: isDarkTheme(theme) ? "dark" : "light",
            gap: 6,
          }}
          components={components}
          onReady={onReady}
          rightHeaderActionsComponent={HeaderActions}
          watermarkComponent={Watermark}
          singleTabMode="default"
        />
      </div>
    </div>
  );
}
