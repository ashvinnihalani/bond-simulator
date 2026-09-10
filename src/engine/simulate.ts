import { Clock } from "./clock";
import { RngManager } from "./rng";
import { FactorProcess, KEY_TENORS, NsCurve } from "./curve";
import { policyPath } from "./policy";
import type { SimConfig } from "./config";

export interface CurveHistory {
  /** Business-day numbers. */
  dates: number[];
  policyRate: Float64Array;
  level: Float64Array;
  slope: Float64Array;
  curvature: Float64Array;
  /** Par yields, row-major [day][keyTenorIndex]. */
  parYields: Float64Array;
  keyTenors: readonly number[];
}

export interface SimResult {
  config: SimConfig;
  seed: number;
  dates: number[];
  curve: CurveHistory;
}

/** Curve snapshot on day i from the recorded history. */
export function curveAt(h: CurveHistory, cfg: SimConfig, i: number): NsCurve {
  return new NsCurve(
    h.level[i],
    h.slope[i],
    h.curvature[i],
    cfg.curve.lambda,
    cfg.curve.termPremium,
    cfg.curve.minRate,
    cfg.curve.maxRate,
  );
}

/** Par yield at a key tenor on day i. */
export function parYieldAt(h: CurveHistory, i: number, tenor: number): number {
  const k = h.keyTenors.indexOf(tenor);
  if (k < 0) throw new Error(`Tenor ${tenor} is not a key tenor`);
  return h.parYields[i * h.keyTenors.length + k];
}

/**
 * Run one simulation path. Each phase of the build plan adds a module to the
 * daily loop; module RNG streams are independent so switching one off leaves
 * the others' draws unchanged.
 */
export function simulate(config: SimConfig, seed: number = config.run.seed): SimResult {
  const clock = new Clock(config.run.startDate, config.run.horizonYears);
  const rng = new RngManager(seed);
  const n = clock.length;
  const nk = KEY_TENORS.length;

  const policy = policyPath(config.curve.policy, n);
  const factors = new FactorProcess(config.curve, rng.stream("curve"));

  const curve: CurveHistory = {
    dates: clock.businessDays,
    policyRate: policy,
    level: new Float64Array(n),
    slope: new Float64Array(n),
    curvature: new Float64Array(n),
    parYields: new Float64Array(n * nk),
    keyTenors: KEY_TENORS,
  };

  for (let i = 0; i < n; i++) {
    factors.step(policy[i]);
    const c = factors.curve();
    curve.level[i] = factors.L;
    curve.slope[i] = factors.S;
    curve.curvature[i] = factors.C;
    for (let k = 0; k < nk; k++) curve.parYields[i * nk + k] = c.parYield(KEY_TENORS[k]);
  }

  return { config, seed, dates: clock.businessDays, curve };
}
