import { useState } from "react";
import { ArrowLeft, ChartNoAxesCombined } from "lucide-react";
import PineEditor from "../pine/PineEditor";
import StrategyBuilder from "../builder/StrategyBuilder";
import BacktestReport from "../backtest/BacktestReport";
import PineLibraries from "../../service/PineLibraries";
import { useApp } from "../../store";
import { Button, cx } from "../../ui/primitives";

export default function LibraryPage() {
  const [tab, setTab] = useState<"pine" | "visual" | "results" | "dependencies">("pine");
  return (
    <section aria-label="Scripts workspace" className="flex h-full min-h-0 flex-col bg-panel">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h1 className="page-heading">Scripts</h1>
          <p className="page-description hidden md:block">
            Edit your Pine scripts, build strategies and review their results.
          </p>
        </div>
        <Button size="sm" onClick={() => useApp.getState().setView("workspace")}>
          <ChartNoAxesCombined size={14} /> View chart
        </Button>
      </header>
      <nav
        aria-label="Script sections"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3"
      >
        {(
          [
            ["pine", "Pine scripts"],
            ["visual", "Visual builder"],
            ["results", "Backtest results"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => setTab(id)}
            className={cx(
              "shrink-0 border-b-2 px-3 py-2 text-[13px]",
              tab === id
                ? "border-accent font-medium text-text"
                : "border-transparent text-muted hover:text-text",
            )}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
        {tab === "pine" && (
          <PineEditor
            onBacktest={() => setTab("results")}
            onLibraries={() => setTab("dependencies")}
          />
        )}
        {tab === "visual" && <StrategyBuilder onBacktest={() => setTab("results")} />}
        {tab === "results" && <BacktestReport onOpenScripts={() => setTab("pine")} />}
        {tab === "dependencies" && (
          <div className="flex h-full flex-col">
            <div className="p-2">
              <Button size="sm" onClick={() => setTab("pine")}>
                <ArrowLeft size={13} /> Back to scripts
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <PineLibraries />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
