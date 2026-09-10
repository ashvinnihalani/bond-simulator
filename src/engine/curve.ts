/**
 * Nelson-Siegel yield-curve engine.
 *
 * The three factors (level L, slope S, curvature C) define a continuously
 * compounded zero curve. Discount factors, par yields and forward rates are
 * derived from it. A term-premium term lifts the long end.
 */

import { cholesky, type Rng } from "./rng";
import type { CurveConfig } from "./config";

export const KEY_TENORS = [1 / 12, 0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30] as const;

/** Nelson-Siegel loadings for tenor τ (years) and decay λ. */
export function nsLoadings(tau: number, lambda: number): [number, number, number] {
  const x = Math.max(tau, 1e-6) / lambda;
  const e = Math.exp(-x);
  const slopeLoad = (1 - e) / x;
  return [1, slopeLoad, slopeLoad - e];
}

/** Term-premium shape: 0 at the short end, equal to `tp` at 30y. */
export function termPremiumAt(tau: number, tp: number): number {
  const scale = 1 - Math.exp(-3);
  return (tp * (1 - Math.exp(-tau / 10))) / scale;
}

export interface CurveFactors {
  L: number;
  S: number;
  C: number;
}

/** A snapshot of the fitted curve on one day. */
export class NsCurve {
  constructor(
    public readonly L: number,
    public readonly S: number,
    public readonly C: number,
    public readonly lambda: number,
    public readonly termPremium: number,
    public readonly minRate = -0.01,
    public readonly maxRate = 0.2,
  ) {}

  static fromFactors(f: CurveFactors, cfg: CurveConfig): NsCurve {
    return new NsCurve(f.L, f.S, f.C, cfg.lambda, cfg.termPremium, cfg.minRate, cfg.maxRate);
  }

  /** Continuously compounded zero rate at tenor τ (years). */
  zeroRate(tau: number): number {
    const [l0, l1, l2] = nsLoadings(tau, this.lambda);
    const y = this.L * l0 + this.S * l1 + this.C * l2 + termPremiumAt(tau, this.termPremium);
    return Math.min(this.maxRate, Math.max(this.minRate, y));
  }

  /** Discount factor for a cash flow τ years away. */
  discountFactor(tau: number): number {
    if (tau <= 0) return 1;
    return Math.exp(-this.zeroRate(tau) * tau);
  }

  /** Instantaneous-ish forward rate between τ1 and τ2. */
  forwardRate(tau1: number, tau2: number): number {
    const d1 = this.discountFactor(tau1);
    const d2 = this.discountFactor(tau2);
    return Math.log(d1 / d2) / (tau2 - tau1);
  }

  /**
   * Semi-annual par yield for a bond maturing in τ years (bond-equivalent).
   * Coupon dates are spaced 0.5y back from maturity; a short first stub is
   * handled by the accrual fraction of the first coupon.
   */
  parYield(tau: number): number {
    if (tau <= 0.5) {
      // Money-market style: simple yield over the period, semi-annual bond-equivalent.
      const df = this.discountFactor(tau);
      return (1 / df - 1) / tau;
    }
    const { annuity, dfMat } = this.annuity(tau);
    return (2 * (1 - dfMat)) / annuity;
  }

  /** Sum of discount factors at semi-annual coupon dates (with stub weighting) and DF at maturity. */
  annuity(tau: number): { annuity: number; dfMat: number } {
    const n = Math.ceil(tau * 2 - 1e-9);
    let annuity = 0;
    for (let k = 1; k <= n; k++) {
      const t = tau - (n - k) * 0.5;
      const frac = k === 1 ? Math.min(1, t / 0.5) : 1;
      annuity += frac * this.discountFactor(t);
    }
    return { annuity, dfMat: this.discountFactor(tau) };
  }

  /** Par yields at the standard key tenors. */
  keyParYields(): number[] {
    return KEY_TENORS.map((t) => this.parYield(t));
  }
}

/**
 * Evolves the factors as correlated mean-reverting AR(1) processes and anchors
 * the short end to the policy rate.
 */
export class FactorProcess {
  private readonly chol: number[][];
  L: number;
  S: number;
  C: number;

  constructor(
    private readonly cfg: CurveConfig,
    private readonly rng: Rng,
  ) {
    this.chol = cholesky(cfg.factors.corr as unknown as number[][]);
    [this.L, this.S, this.C] = cfg.factors.initial;
  }

  get factors(): CurveFactors {
    return { L: this.L, S: this.S, C: this.C };
  }

  /**
   * Advance one business day.
   * @param policyRate today's policy rate (decimal)
   * @param volMult multiplier on innovation volatility (stress channel)
   */
  step(policyRate: number, volMult = 1): void {
    const { mean, speed, vol } = this.cfg.factors;
    const z = this.rng.correlatedNormals(this.chol);
    this.L += speed[0] * (mean[0] - this.L) + vol[0] * volMult * z[0];
    this.S += speed[1] * (mean[1] - this.S) + vol[1] * volMult * z[1];
    this.C += speed[2] * (mean[2] - this.C) + vol[2] * volMult * z[2];

    // Short-end anchor: the instantaneous rate L+S is pulled toward policy + spread.
    const target = policyRate + this.cfg.shortEndSpread;
    const gap = target - (this.L + this.S);
    this.S += this.cfg.shortEndPull * gap;

    // Keep the curve inside the configured band.
    const lo = this.cfg.minRate;
    const hi = this.cfg.maxRate;
    this.L = Math.min(hi - 0.005, Math.max(lo + 0.005, this.L));
    if (this.L + this.S < lo) this.S = lo - this.L;
    if (this.L + this.S > hi) this.S = hi - this.L;
  }

  curve(): NsCurve {
    return NsCurve.fromFactors(this.factors, this.cfg);
  }
}

/**
 * Bootstrap a piecewise-flat-forward discount curve from semi-annual par
 * yields at the given tenors. Returns a function DF(τ). Used for the
 * off-the-run fitted curve and for validating that NS par yields reprice.
 */
export function bootstrapDiscountCurve(
  tenors: number[],
  parYields: number[],
): (tau: number) => number {
  // Knots: zero rates at each tenor, log-linear interpolation of DF between.
  const knotT: number[] = [];
  const knotZ: number[] = [];
  const dfAt = (t: number): number => {
    if (t <= 0) return 1;
    if (knotT.length === 0) return Math.exp(-parYields[0] * t);
    if (t <= knotT[0]) return Math.exp(-knotZ[0] * t);
    for (let i = 1; i < knotT.length; i++) {
      if (t <= knotT[i]) {
        const w = (t - knotT[i - 1]) / (knotT[i] - knotT[i - 1]);
        const lnDf = -(knotZ[i - 1] * knotT[i - 1]) * (1 - w) - knotZ[i] * knotT[i] * w;
        return Math.exp(lnDf);
      }
    }
    const last = knotT.length - 1;
    return Math.exp(-knotZ[last] * t); // flat extrapolation of the zero rate
  };

  for (let i = 0; i < tenors.length; i++) {
    const tau = tenors[i];
    const y = parYields[i];
    if (tau <= 0.5) {
      knotT.push(tau);
      knotZ.push(Math.log(1 + y * tau) / tau);
      continue;
    }
    // Solve for the zero rate at tau such that the par bond prices at 100.
    const n = Math.ceil(tau * 2 - 1e-9);
    const price = (zTau: number): number => {
      knotT.push(tau);
      knotZ.push(zTau);
      let pv = 0;
      for (let k = 1; k <= n; k++) {
        const t = tau - (n - k) * 0.5;
        const frac = k === 1 ? Math.min(1, t / 0.5) : 1;
        pv += (frac * y) / 2 * dfAt(t);
      }
      pv += dfAt(tau);
      knotT.pop();
      knotZ.pop();
      return pv;
    };
    let lo = -0.05;
    let hi = 0.5;
    for (let it = 0; it < 80; it++) {
      const mid = 0.5 * (lo + hi);
      if (price(mid) > 1) lo = mid;
      else hi = mid;
    }
    knotT.push(tau);
    knotZ.push(0.5 * (lo + hi));
  }
  return dfAt;
}
