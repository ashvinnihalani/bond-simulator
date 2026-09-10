import { Clock } from "./clock";
import { RngManager } from "./rng";
import type { SimConfig } from "./config";

export interface SimResult {
  config: SimConfig;
  seed: number;
  dates: number[];
  /** Placeholder daily series; filled in by later phases. */
  policyRate: Float64Array;
}

/**
 * Run one simulation path. Later phases extend this loop; the shape is fixed
 * now so the reproducibility test (Checkpoint 0) holds throughout.
 */
export function simulate(config: SimConfig, seed: number = config.run.seed): SimResult {
  const clock = new Clock(config.run.startDate, config.run.horizonYears);
  const rng = new RngManager(seed);
  const n = clock.length;
  const policyRate = new Float64Array(n);
  const noise = rng.stream("scaffold");
  let r = config.curve.policy.initial;
  for (let i = 0; i < n; i++) {
    r += noise.gaussian(0, 1e-5);
    policyRate[i] = r;
  }
  return { config, seed, dates: clock.businessDays, policyRate };
}
