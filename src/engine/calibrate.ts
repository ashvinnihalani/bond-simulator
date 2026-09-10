/**
 * Calibration against historical data (Phase 10).
 *
 * Fits Nelson-Siegel factors to observed yields day by day, estimates AR(1)
 * dynamics for each factor, and turns historical buyback results into offer
 * and fill parameters. Data loading is left to the caller (FRED / Fiscal
 * Data CSVs) so the engine stays network-free.
 */

import { nsLoadings } from "./curve";
import type { PartialConfig } from "./config";

export interface YieldObservation {
  /** ISO date. */
  date: string;
  /** Tenor (years) → yield (decimal). Missing tenors may be omitted. */
  yields: Record<number, number>;
}

/** Least-squares Nelson-Siegel factors for one day's yields. */
export function fitNsFactors(yields: Record<number, number>, lambda: number): [number, number, number] | null {
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const atb = [0, 0, 0];
  let n = 0;
  for (const [tenorStr, y] of Object.entries(yields)) {
    const tau = Number(tenorStr);
    if (!Number.isFinite(y) || !Number.isFinite(tau) || tau <= 0) continue;
    const x = nsLoadings(tau, lambda);
    for (let a = 0; a < 3; a++) {
      atb[a] += x[a] * y;
      for (let b = 0; b < 3; b++) ata[a][b] += x[a] * x[b];
    }
    n++;
  }
  if (n < 3) return null;
  const det =
    ata[0][0] * (ata[1][1] * ata[2][2] - ata[1][2] * ata[2][1]) -
    ata[0][1] * (ata[1][0] * ata[2][2] - ata[1][2] * ata[2][0]) +
    ata[0][2] * (ata[1][0] * ata[2][1] - ata[1][1] * ata[2][0]);
  if (Math.abs(det) < 1e-18) return null;
  const solveCol = (k: number): number => {
    const m = ata.map((row, i) => row.map((v, j) => (j === k ? atb[i] : v)));
    return (
      (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
        m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
        m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])) /
      det
    );
  };
  return [solveCol(0), solveCol(1), solveCol(2)];
}

export interface Ar1Fit {
  mean: number;
  /** Daily mean-reversion speed (1 − autoregressive coefficient). */
  speed: number;
  /** Residual standard deviation per day. */
  vol: number;
  phi: number;
}

/** OLS fit of x_{t+1} = a + φ x_t + ε. */
export function fitAr1(x: ArrayLike<number>): Ar1Fit {
  const n = x.length - 1;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += x[i + 1];
    sxx += x[i] * x[i];
    sxy += x[i] * x[i + 1];
  }
  const mx = sx / n;
  const my = sy / n;
  const varx = sxx / n - mx * mx;
  const phi = varx > 0 ? Math.min(0.9999, Math.max(0, (sxy / n - mx * my) / varx)) : 0;
  const a = my - phi * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const e = x[i + 1] - a - phi * x[i];
    ss += e * e;
  }
  const speed = 1 - phi;
  return { mean: speed > 1e-9 ? a / speed : mx, speed, vol: Math.sqrt(ss / Math.max(1, n - 2)), phi };
}

export interface CurveCalibration {
  factors: { mean: [number, number, number]; speed: [number, number, number]; vol: [number, number, number]; corr: number[][]; initial: [number, number, number] };
  /** Daily factor series (for plots / diagnostics). */
  series: { dates: string[]; L: number[]; S: number[]; C: number[]; rmseBp: number[] };
  overlay: PartialConfig;
}

/** Fit factors to a yield history and estimate their AR(1) dynamics. */
export function calibrateCurve(history: YieldObservation[], lambda = 1.8): CurveCalibration {
  const dates: string[] = [];
  const L: number[] = [];
  const S: number[] = [];
  const C: number[] = [];
  const rmseBp: number[] = [];
  for (const obs of history) {
    const f = fitNsFactors(obs.yields, lambda);
    if (!f) continue;
    dates.push(obs.date);
    L.push(f[0]);
    S.push(f[1]);
    C.push(f[2]);
    let ss = 0;
    let n = 0;
    for (const [t, y] of Object.entries(obs.yields)) {
      const x = nsLoadings(Number(t), lambda);
      const fit = f[0] * x[0] + f[1] * x[1] + f[2] * x[2];
      ss += (y - fit) ** 2;
      n++;
    }
    rmseBp.push(Math.sqrt(ss / n) * 1e4);
  }
  const fits = [fitAr1(L), fitAr1(S), fitAr1(C)];
  // Residual correlation matrix.
  const resid = [L, S, C].map((x, k) => {
    const out: number[] = [];
    for (let i = 0; i < x.length - 1; i++) out.push(x[i + 1] - (fits[k].mean * fits[k].speed + fits[k].phi * x[i]));
    return out;
  });
  const corr = resid.map((a) => resid.map((b) => correlation(a, b)));
  const last = L.length - 1;
  const factors = {
    mean: [fits[0].mean, fits[1].mean, fits[2].mean] as [number, number, number],
    speed: [fits[0].speed, fits[1].speed, fits[2].speed] as [number, number, number],
    vol: [fits[0].vol, fits[1].vol, fits[2].vol] as [number, number, number],
    corr,
    initial: [L[last], S[last], C[last]] as [number, number, number],
  };
  return {
    factors,
    series: { dates, L, S, C, rmseBp },
    overlay: { curve: { lambda, factors: { ...factors, corr: corr as [[number, number, number], [number, number, number], [number, number, number]] } } },
  };
}

function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

export interface BuybackObservation {
  /** Bucket name matching config, e.g. "7-10y". */
  bucket: string;
  offered: number;
  accepted: number;
  maxAmount: number;
  /** Accepted-weighted spread to Treasury's fair-value curve (bp), if published. */
  weightedSpreadBp?: number;
}

export interface BuybackCalibration {
  byBucket: Record<string, { ops: number; offerToMax: number; fillRate: number; avgSpreadBp: number | null }>;
  overlay: PartialConfig;
}

/**
 * Turn published operation results into offer-size and reservation
 * parameters: offers relative to the maximum pin the dealer offer propensity,
 * fill rates pin how much of the offer stack Treasury takes.
 */
export function calibrateBuybacks(ops: BuybackObservation[], baseline: { offerBaseProb: number; offerSizeFraction: number }, simulatedOfferToMax: number): BuybackCalibration {
  const byBucket: BuybackCalibration["byBucket"] = {};
  for (const o of ops) {
    const b = (byBucket[o.bucket] ??= { ops: 0, offerToMax: 0, fillRate: 0, avgSpreadBp: null });
    b.ops++;
    b.offerToMax += o.maxAmount > 0 ? o.offered / o.maxAmount : 0;
    b.fillRate += o.offered > 0 ? o.accepted / o.offered : 0;
    if (o.weightedSpreadBp !== undefined) b.avgSpreadBp = (b.avgSpreadBp ?? 0) + o.weightedSpreadBp;
  }
  let offerToMax = 0;
  let count = 0;
  for (const b of Object.values(byBucket)) {
    b.offerToMax /= b.ops;
    b.fillRate /= b.ops;
    if (b.avgSpreadBp !== null) b.avgSpreadBp /= b.ops;
    offerToMax += b.offerToMax;
    count++;
  }
  offerToMax = count ? offerToMax / count : simulatedOfferToMax;
  // Scale offer volume so simulated offered/max matches history.
  const scale = simulatedOfferToMax > 0 ? offerToMax / simulatedOfferToMax : 1;
  return {
    byBucket,
    overlay: { buyback: { offerBaseProb: Math.min(0.95, baseline.offerBaseProb * Math.sqrt(scale)), offerSizeFraction: baseline.offerSizeFraction * Math.sqrt(scale) } },
  };
}

export interface Moments {
  mean: number;
  sd: number;
  /** Lag-1 autocorrelation. */
  ac1: number;
  /** Standard deviation of daily changes. */
  dsd: number;
}

export function moments(x: ArrayLike<number>): Moments {
  const n = x.length;
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i];
  const mean = s / n;
  let v = 0;
  let c = 0;
  let d = 0;
  for (let i = 0; i < n; i++) {
    v += (x[i] - mean) ** 2;
    if (i > 0) {
      c += (x[i] - mean) * (x[i - 1] - mean);
      d += (x[i] - x[i - 1]) ** 2;
    }
  }
  return { mean, sd: Math.sqrt(v / n), ac1: v > 0 ? c / v : 0, dsd: Math.sqrt(d / Math.max(1, n - 1)) };
}

/** Relative distance of simulated moments from historical ones; each entry ≤ tol passes. */
export function compareMoments(sim: Moments, hist: Moments): { mean: number; sd: number; ac1: number; dsd: number } {
  const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
  return { mean: rel(sim.mean, hist.mean), sd: rel(sim.sd, hist.sd), ac1: Math.abs(sim.ac1 - hist.ac1), dsd: rel(sim.dsd, hist.dsd) };
}

/** Parse a FRED-style CSV with a date column and yield columns in percent. */
export function parseYieldCsv(text: string, columns: Record<string, number> = { DGS1MO: 1 / 12, DGS3MO: 0.25, DGS6MO: 0.5, DGS1: 1, DGS2: 2, DGS3: 3, DGS5: 5, DGS7: 7, DGS10: 10, DGS20: 20, DGS30: 30 }): YieldObservation[] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim());
  const dateCol = header.findIndex((h) => /date/i.test(h));
  const out: YieldObservation[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const yields: Record<number, number> = {};
    header.forEach((h, i) => {
      const tenor = columns[h];
      if (tenor === undefined) return;
      const v = parseFloat(cells[i]);
      if (Number.isFinite(v)) yields[tenor] = v / 100;
    });
    if (Object.keys(yields).length >= 3) out.push({ date: cells[dateCol >= 0 ? dateCol : 0].trim(), yields });
  }
  return out;
}
