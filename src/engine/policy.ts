import type { PolicyRateConfig } from "./config";

/** Build the daily policy-rate path (decimal) for `n` business days. */
export function policyPath(cfg: PolicyRateConfig, n: number): Float64Array {
  const out = new Float64Array(n);
  switch (cfg.scenario) {
    case "hold": {
      out.fill(cfg.initial);
      break;
    }
    case "hike":
    case "cut": {
      const sign = cfg.scenario === "hike" ? 1 : -1;
      let r = cfg.initial;
      let steps = 0;
      for (let i = 0; i < n; i++) {
        const since = i - cfg.startAfterDays;
        if (since >= 0 && steps < cfg.numSteps && since % cfg.stepEveryDays === 0) {
          r += sign * cfg.stepSize;
          steps++;
        }
        out[i] = r;
      }
      break;
    }
    case "custom": {
      const knots = [...cfg.custom].sort((a, b) => a[0] - b[0]);
      let r = knots.length ? knots[0][1] : cfg.initial;
      let k = 0;
      for (let i = 0; i < n; i++) {
        while (k < knots.length && knots[k][0] <= i) {
          r = knots[k][1];
          k++;
        }
        out[i] = r;
      }
      break;
    }
  }
  return out;
}
