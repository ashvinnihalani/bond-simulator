/**
 * On/off-the-run liquidity premium.
 *
 * Each bond's idiosyncratic yield spread to the fitted curve is
 *   spread = −P₀ · stressMult · e^(−age/h) − repoRichness + cheapness(age) + noise
 * where P₀ is the tenor's base OTR richness, h a half-life scaled to the
 * tenor's issuance cycle (so every tenor decays to ~zero by double-old),
 * repoRichness is the expected value of financing specialness, cheapness
 * grows slowly with age, and noise is AR(1).
 */

import { nsLoadings } from "./curve";
import { TENORS, type LiquidityConfig, type Tenor } from "./config";
import type { Bond } from "./bond";
import type { Simulation } from "./simulate";
import { STATUS_CODES } from "./records";

/** Business days between new issues of a tenor. */
export function cycleDays(tenor: Tenor): number {
  return tenor >= 10 ? 63 : 21;
}

export interface OnOffSeries {
  otrMinusOld: Float64Array;
  otrMinusDoubleOld: Float64Array;
  otrMinusFitted: Float64Array;
  /** OTR repo specialness (bp). */
  specialness: Float64Array;
}

export interface OffRunFit {
  dayIdx: number[];
  /** Factor deltas (off-run curve minus model curve), decimal. */
  dL: number[];
  dS: number[];
  dC: number[];
  /** RMS residual of off-run spreads to the off-run curve (bp). */
  rmsBp: number[];
}

export interface LiquidityHistory {
  onOff: Record<Tenor, OnOffSeries>;
  offRunFit: OffRunFit;
}

export class LiquidityModule {
  readonly history: LiquidityHistory;
  private readonly cfg: LiquidityConfig;
  private readonly ln2 = Math.log(2);

  constructor(private readonly sim: Simulation) {
    this.cfg = sim.config.liquidity;
    const n = sim.n;
    const mk = (): OnOffSeries => ({
      otrMinusOld: new Float64Array(n),
      otrMinusDoubleOld: new Float64Array(n),
      otrMinusFitted: new Float64Array(n),
      specialness: new Float64Array(n),
    });
    this.history = {
      onOff: { 2: mk(), 3: mk(), 5: mk(), 7: mk(), 10: mk(), 20: mk(), 30: mk() },
      offRunFit: { dayIdx: [], dL: [], dS: [], dC: [], rmsBp: [] },
    };
    // Initialise spreads on day 0 so seeded bonds start at their steady state.
    this.updateSpreads(true);
  }

  /** Age in business days since auction (calendar-scaled for seeded bonds). */
  ageBdays(b: Bond): number {
    return Math.max(0, ((this.sim.today - b.auctionDate) * 252) / 365.25);
  }

  /** Decay-based richness component in bp (positive = rich). */
  richnessBp(b: Bond): number {
    const p0 = this.cfg.baseRichnessBp[b.tenor] * this.sim.richnessMult;
    if (b.status === "WI") return p0 * this.cfg.wiRichnessFraction;
    if (b.status === "retired") return 0;
    const h = (this.cfg.halfLifeDays * cycleDays(b.tenor)) / 63;
    return p0 * Math.exp((-this.ln2 * this.ageBdays(b)) / h);
  }

  /** Repo specialness in bp for a bond, from its decay-based richness. */
  specialnessBp(b: Bond): number {
    if (b.status === "WI" || b.status === "retired") return 0;
    return this.cfg.specialnessSensitivity * this.richnessBp(b);
  }

  /** Aging cheapness in bp for deep off-the-runs. */
  cheapnessBp(b: Bond): number {
    const ageYears = Math.max(0, (this.sim.today - b.issueDate) / 365.25);
    return Math.min(this.cfg.agingCheapnessCapBp, this.cfg.agingCheapnessBpPerYear * ageYears);
  }

  /** Daily update of every bond's idiosyncratic spread. */
  updateSpreads(init = false): void {
    const rng = this.sim.streamFor("liquidity");
    const rho = this.cfg.noisePersistence;
    const sigma = this.cfg.noiseBp / 1e4;
    const innov = sigma * Math.sqrt(1 - rho * rho);
    for (const b of this.sim.ledger.bonds) {
      // Draw for every bond regardless of status so the stream is independent of lifecycle.
      const z = rng.normal();
      if (b.status === "retired") continue;
      if (init) b.noiseState = sigma * z;
      else b.noiseState = rho * b.noiseState + innov * z;
      const rich = this.richnessBp(b);
      // Expected financing advantage over the remaining OTR-ish holding period, in yield terms.
      const holdYears = cycleDays(b.tenor) / 252;
      const dur = Math.max(1, b.tenor * 0.8);
      const repoRich = (this.cfg.specialnessFeedback * this.specialnessBp(b) * holdYears) / dur;
      b.spread = (-(rich + repoRich) + this.cheapnessBp(b)) / 1e4;
    }
  }

  /** Compute on/off deltas for each tenor from today's curve. */
  recordOnOff(): void {
    const i = this.sim.dayIdx;
    for (const t of TENORS) {
      const chain = this.sim.ledger.chain[t];
      const otr = chain[0] ? this.sim.ledger.get(chain[0]) : undefined;
      const s = this.history.onOff[t];
      if (!otr || otr.coupon === 0) continue;
      const yOtr = this.yieldOf(otr);
      const fitted = this.sim.yieldOnCurve(otr, Math.max(this.sim.today, otr.issueDate), 0);
      s.otrMinusFitted[i] = (yOtr - fitted) * 1e4;
      s.specialness[i] = this.specialnessBp(otr);
      const old = chain[1] ? this.sim.ledger.get(chain[1]) : undefined;
      const dbl = chain[2] ? this.sim.ledger.get(chain[2]) : undefined;
      // Compare on a curve-adjusted basis: OTR spread minus old spread (removes maturity difference).
      if (old) s.otrMinusOld[i] = (yOtr - fitted - this.spreadOf(old)) * 1e4;
      if (dbl) s.otrMinusDoubleOld[i] = (yOtr - fitted - this.spreadOf(dbl)) * 1e4;
    }
  }

  private yieldOf(b: Bond): number {
    return this.sim.yieldOnCurve(b, Math.max(this.sim.today, b.issueDate), this.sim.effectiveSpread(b));
  }

  /** Realised yield spread to the fitted curve (decimal). */
  private spreadOf(b: Bond): number {
    const settle = Math.max(this.sim.today, b.issueDate);
    return this.yieldOf(b) - this.sim.yieldOnCurve(b, settle, 0);
  }

  /**
   * Fit an off-the-run curve: least-squares NS factor deltas explaining the
   * off-the-run spreads, using loadings at each bond's duration. Runs on
   * recorded days from the recorder's rows.
   */
  fitOffRunCurve(): void {
    const rec = this.sim.records;
    const i = this.sim.dayIdx;
    const [s, e] = rec.rangeForDay(i);
    if (e <= s) return;
    const status = rec.status.view();
    const spread = rec.spread.view();
    const dur = rec.modDuration.view();
    const lambda = this.sim.config.curve.lambda;
    // Normal equations for 3 parameters.
    const ata = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const atb = [0, 0, 0];
    let count = 0;
    for (let r = s; r < e; r++) {
      if (status[r] !== STATUS_CODES["off-run"]) continue;
      if (dur[r] < 0.4) continue;
      const x = nsLoadings(Math.max(0.5, dur[r] * 1.05), lambda);
      for (let a = 0; a < 3; a++) {
        atb[a] += x[a] * spread[r];
        for (let b = 0; b < 3; b++) ata[a][b] += x[a] * x[b];
      }
      count++;
    }
    if (count < 10) return;
    const d = solve3(ata, atb);
    if (!d) return;
    let ss = 0;
    for (let r = s; r < e; r++) {
      if (status[r] !== STATUS_CODES["off-run"] || dur[r] < 0.4) continue;
      const x = nsLoadings(Math.max(0.5, dur[r] * 1.05), lambda);
      const resid = spread[r] - (d[0] * x[0] + d[1] * x[1] + d[2] * x[2]);
      ss += resid * resid;
    }
    const f = this.history.offRunFit;
    f.dayIdx.push(i);
    f.dL.push(d[0]);
    f.dS.push(d[1]);
    f.dC.push(d[2]);
    f.rmsBp.push(Math.sqrt(ss / count) * 1e4);
  }
}

/** Solve a 3×3 linear system by Cramer's rule; null if singular. */
function solve3(a: number[][], b: number[]): [number, number, number] | null {
  const det =
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  if (Math.abs(det) < 1e-18) return null;
  const col = (k: number): number[][] => a.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)));
  const d = (m: number[][]): number =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  return [d(col(0)) / det, d(col(1)) / det, d(col(2)) / det];
}
