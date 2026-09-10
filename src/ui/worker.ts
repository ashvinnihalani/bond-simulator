/// <reference lib="webworker" />
import { simulate, type SimConfig, type SimResult } from "../engine";
import { buildChartData, bondLevelCsv, type BuildOptions, type ChartData } from "./dashboardData";

export type WorkerRequest =
  | { type: "run"; id: number; config: SimConfig; options: Omit<BuildOptions, "onProgress"> }
  | { type: "csv"; id: number };

export type WorkerResponse =
  | { type: "progress"; id: number; message: string; frac: number }
  | { type: "result"; id: number; data: ChartData }
  | { type: "csv"; id: number; csv: string }
  | { type: "error"; id: number; message: string };

let last: SimResult | null = null;

const post = (m: WorkerResponse) => (self as unknown as Worker).postMessage(m);

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.type === "run") {
      post({ type: "progress", id: req.id, message: "Simulating…", frac: 0.05 });
      const t0 = performance.now();
      last = simulate(req.config, req.config.run.seed);
      const runMs = performance.now() - t0;
      post({ type: "progress", id: req.id, message: "Building charts…", frac: 0.4 });
      const data = buildChartData(last, { ...req.options, onProgress: (message, frac) => post({ type: "progress", id: req.id, message, frac }) }, { runMs });
      post({ type: "result", id: req.id, data });
    } else if (req.type === "csv") {
      if (!last) throw new Error("No simulation has run yet");
      post({ type: "csv", id: req.id, csv: bondLevelCsv(last) });
    }
  } catch (e) {
    post({ type: "error", id: req.id, message: e instanceof Error ? e.message : String(e) });
  }
};
