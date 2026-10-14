import { create } from "zustand";
import type { Timeframe, BacktestResult } from "../core/types";
import { loadMarketHistory, marketSeries } from "../data/feed";
import { command } from "./client";

export const useRunProgress = create<{
  jobId?: string;
  status: string;
  error?: string;
}>(() => ({ status: "idle" }));
export async function cancelCurrentRun() {
  const job_id = useRunProgress.getState().jobId;
  if (job_id) await command("backtest.cancel", { job_id });
}
export async function runServerStrategy(args: {
  name: string;
  source: string;
  symbol: string;
  tf: Timeframe;
  inputs?: Record<string, unknown>;
  replayUntil?: number;
}): Promise<BacktestResult & { server: any }> {
  useRunProgress.setState({
    status: "loading-data",
    error: undefined,
    jobId: undefined,
  });
  try {
    const dataset = marketSeries(args.symbol, args.tf);
    const range = dataset.historyRange;
    await loadMarketHistory(args.symbol, args.tf, range && !range.live ? range : undefined);
    if (!dataset.snapshotId) throw Error("No immutable market snapshot is available");
    if (dataset.gaps?.length)
      throw Error(
        `Market history has ${dataset.gaps.length} gap(s). Resolve the data coverage or choose a complete range before running.`,
      );
    let snapshotId = dataset.snapshotId;
    if (args.replayUntil !== undefined) {
      const original = await command("data.get", { snapshot_id: snapshotId });
      const bars = original.bars.filter((b: { time: number }) => b.time <= args.replayUntil!);
      if (!bars.length) throw Error("The replay prefix contains no confirmed bars");
      const end = bars.at(-1).closeTime ?? bars.at(-1).time;
      const data = {
        ...original,
        bars,
        metadata: {
          ...original.metadata,
          provenance: {
            ...original.metadata?.provenance,
            parentSnapshot: snapshotId,
            replayUntil: args.replayUntil,
          },
        },
        ...(original.datasets
          ? {
              datasets: original.datasets.map((d: any) => ({
                ...d,
                bars: d.bars.filter((b: any) => (b.closeTime ?? b.time) <= end),
              })),
            }
          : {}),
      };
      snapshotId = (await command("data.import", { data })).id;
    }
    const version = await command("strategy.createVersion", {
      name: args.name,
      kind: "pine",
      source: args.source,
    });
    const submitted = await command(
      "backtest.start",
      {
        version_id: version.id,
        snapshot_id: snapshotId,
        inputs: args.inputs ?? {},
      },
      crypto.randomUUID(),
    );
    useRunProgress.setState({
      jobId: submitted.job_id,
      status: submitted.status,
    });
    for (;;) {
      const job = await command("backtest.status", { job_id: submitted.job_id });
      useRunProgress.setState({ status: job.status });
      if (["queued", "running"].includes(job.status)) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      if (job.status !== "succeeded")
        throw Error(job.error ?? `Run ${job.status}; inspect the saved job for details`);
      const report = await command("backtest.results", {
        job_id: submitted.job_id,
      });
      if (!report.result?.ok || !report.result?.backtest)
        throw Error(report.result?.error?.message ?? "Server returned no native strategy ledger");
      return {
        ...report.result.backtest,
        server: {
          jobId: report.job_id,
          versionId: version.id,
          snapshotId: report.manifest.snapshot_id ?? snapshotId,
          manifest: report.manifest,
          inputs: args.inputs ?? {},
          result: report.result,
        },
      };
    }
  } catch (error) {
    useRunProgress.setState({ status: "failed", error: String(error) });
    throw error;
  }
}
