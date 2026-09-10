/**
 * Analytics layer: curve metrics, bond carry / roll-down / total return,
 * buyback program metrics, roll-down tracking, and the batch scenario runner.
 */

import { accruedInterest, dirtyPriceFromYield, dirtyPriceOnCurve, riskFromYield, yieldFromDirtyPrice, type Bond } from "./bond";
import { yearFrac, type DayNum } from "./clock";
import { type SimConfig, type Tenor } from "./config";
import type { NsCurve } from "./curve";
import { bucketIndex } from "./issuance";
import { STATUS_CODES } from "./records";
import { curveAt, parYieldAt, simulate, type SimResult } from "./simulate";

// ---------------------------------------------------------------------------
// Curve metrics
// ---------------------------------------------------------------------------

export interface CurveMetrics {
  /** All in bp. */
  twosTens: Float64Array;
  fivesThirties: Float64Array;
  /** 2s5s10s butterfly: 2×5y − 2y − 10y. */
  butterfly: Float64Array;
  level: Float64Array;
  slope: Float64Array;
  curvature: Float64Array;
  policyRate: Float64Array;
}

export function curveMetrics(r: SimResult): CurveMetrics {
  const n = r.dates.length;
  const out: CurveMetrics = {
    twosTens: new Float64Array(n),
    fivesThirties: new Float64Array(n),
    butterfly: new Float64Array(n),
    level: r.curve.level,
    slope: r.curve.slope,
    curvature: r.curve.curvature,
    policyRate: r.curve.policyRate,
  };
  for (let i = 0; i < n; i++) {
    const y2 = parYieldAt(r.curve, i, 2);
    const y5 = parYieldAt(r.curve, i, 5);
    const y10 = parYieldAt(r.curve, i, 10);
    const y30 = parYieldAt(r.curve, i, 30);
    out.twosTens[i] = (y10 - y2) * 1e4;
    out.fivesThirties[i] = (y30 - y5) * 1e4;
    out.butterfly[i] = (2 * y5 - y2 - y10) * 1e4;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bond carry / roll-down
// ---------------------------------------------------------------------------

export interface CarryRolldown {
  /** Price change per 100 from accrual and pull-to-par at constant yield, plus coupons paid. */
  carry: number;
  /** Price change per 100 from the yield falling as the bond rolls down the (static) curve. */
  rolldown: number;
  /** Financing cost per 100 over the horizon at the repo rate. */
  financing: number;
  /** carry + rolldown − financing. */
  total: number;
  /** Coupons paid over the horizon per 100. */
  coupons: number;
  yieldNow: number;
  yieldRolled: number;
}

/**
 * Decompose the static-curve return of a bond over `horizonDays` calendar days.
 * The curve and spread are held fixed; only time passes.
 */
export function carryRolldown(
  bond: Bond,
  settle: DayNum,
  curve: NsCurve,
  spread: number,
  horizonDays: number,
  repoRate = 0,
): CarryRolldown {
  const df = (t: number) => curve.discountFactor(t);
  const dirtyNow = dirtyPriceOnCurve(bond, settle, df, spread);
  const yNow = yieldFromDirtyPrice(bond, settle, dirtyNow);
  const later = settle + horizonDays;
  let coupons = 0;
  for (const d of bond.couponDates) if (d > settle && d <= later) coupons += (bond.coupon * 100) / 2;
  if (later >= bond.maturityDate) {
    const total = 100 + coupons - dirtyNow;
    return { carry: total, rolldown: 0, financing: (repoRate * dirtyNow * horizonDays) / 360, total: total - (repoRate * dirtyNow * horizonDays) / 360, coupons, yieldNow: yNow, yieldRolled: yNow };
  }
  const dirtyConstYield = dirtyPriceFromYield(bond, later, yNow);
  const dirtyRolled = dirtyPriceOnCurve(bond, later, df, spread);
  const yRolled = yieldFromDirtyPrice(bond, later, dirtyRolled, yNow);
  const carry = dirtyConstYield + coupons - dirtyNow;
  const rolldown = dirtyRolled - dirtyConstYield;
  const financing = (repoRate * dirtyNow * horizonDays) / 360;
  return { carry, rolldown, financing, total: carry + rolldown - financing, coupons, yieldNow: yNow, yieldRolled: yRolled };
}

export interface BondSnapshot {
  bondIdx: number;
  id: string;
  tenor: Tenor;
  status: string;
  remYears: number;
  ytm: number;
  fittedYtm: number;
  spreadBp: number;
  cleanPrice: number;
  outstanding: number;
  dv01: number;
  modDuration: number;
  specialnessBp: number;
  /** 1-business-day static-curve decomposition (per 100 face). */
  carry: number;
  rolldown: number;
  financing: number;
  /** Realised total return since the previous recorded day (per 100), NaN if unavailable. */
  realised: number;
}

/** Per-bond analytics on a recorded day (row index into records). */
export function bondSnapshots(r: SimResult, dayIdx: number): BondSnapshot[] {
  const rec = r.records;
  const [s, e] = rec.rangeForDay(dayIdx);
  if (e <= s) return [];
  const bondIdx = rec.bondIdx.view();
  const status = rec.status.view();
  const rem = rec.remYears.view();
  const ytm = rec.ytm.view();
  const fitted = rec.fittedYtm.view();
  const spread = rec.spread.view();
  const clean = rec.cleanPrice.view();
  const outstanding = rec.outstanding.view();
  const dv01 = rec.dv01.view();
  const modDur = rec.modDuration.view();
  const special = rec.repoSpecialness.view();
  const today = r.dates[dayIdx];
  const nextDay = r.dates[dayIdx + 1] ?? today + 1;
  const curve = curveAt(r.curve, r.config, dayIdx);
  const gc = r.curve.policyRate[dayIdx] + r.config.liquidity.gcSpread;
  // Previous recorded day for realised returns.
  const k = rec.recordedDays.indexOf(dayIdx);
  const prevDay = k > 0 ? rec.recordedDays[k - 1] : -1;
  const prevRows = new Map<number, number>();
  if (prevDay >= 0) {
    const [ps, pe] = rec.rangeForDay(prevDay);
    for (let i = ps; i < pe; i++) prevRows.set(bondIdx[i], i);
  }
  const statusName = ["WI", "OTR", "old", "double-old", "off-run", "retired"];
  const out: BondSnapshot[] = [];
  for (let i = s; i < e; i++) {
    const b = r.ledger.bonds[bondIdx[i]];
    const settle = Math.max(today, b.issueDate);
    const spreadDec = ytm[i] - fitted[i];
    let cr: CarryRolldown | null = null;
    if (b.coupon > 0) {
      cr = carryRolldown(b, settle, curve, spreadDec, Math.max(1, nextDay - settle), gc - special[i] / 1e4);
    }
    let realised = NaN;
    const pi = prevRows.get(bondIdx[i]);
    if (pi !== undefined && b.coupon > 0) {
      const prevSettle = Math.max(r.dates[prevDay], b.issueDate);
      const dirtyPrev = clean[pi] + accruedInterest(b, prevSettle);
      const dirtyNow = clean[i] + accruedInterest(b, settle);
      let coupons = 0;
      for (const d of b.couponDates) if (d > prevSettle && d <= settle) coupons += (b.coupon * 100) / 2;
      realised = dirtyNow + coupons - dirtyPrev;
    }
    out.push({
      bondIdx: bondIdx[i],
      id: b.id,
      tenor: b.tenor,
      status: statusName[status[i]],
      remYears: rem[i],
      ytm: ytm[i],
      fittedYtm: fitted[i],
      spreadBp: spread[i] * 1e4,
      cleanPrice: clean[i],
      outstanding: outstanding[i],
      dv01: dv01[i],
      modDuration: modDur[i],
      specialnessBp: special[i],
      carry: cr?.carry ?? NaN,
      rolldown: cr?.rolldown ?? NaN,
      financing: cr?.financing ?? NaN,
      realised,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Buyback metrics
// ---------------------------------------------------------------------------

export interface BucketMetrics {
  bucket: number;
  name: string;
  operations: number;
  offered: number;
  bought: number;
  fillRate: number;
  /** Bought-weighted spread to curve (bp). */
  avgSpreadBp: number;
  /** Σ amount × (curve price − paid price) / 100, $bn. Positive = bought below fair value. */
  savingsVsCurve: number;
  /** DV01 removed, $mm per bp. */
  dv01Removed: number;
}

export interface BuybackMetrics {
  buckets: BucketMetrics[];
  totalBought: number;
  totalSavings: number;
  dv01Removed: number;
  /** DV01 added through extra coupon issuance, $mm per bp. */
  dv01Funded: number;
  /** Net duration impact: funded − removed, $mm per bp. */
  netDv01: number;
  cashMgmtBought: number;
  liquidityBought: number;
}

export function buybackMetrics(r: SimResult): BuybackMetrics {
  const buckets = r.config.buyback.buckets.map((b, k): BucketMetrics => ({
    bucket: k,
    name: b.name,
    operations: 0,
    offered: 0,
    bought: 0,
    fillRate: 0,
    avgSpreadBp: 0,
    savingsVsCurve: 0,
    dv01Removed: 0,
  }));
  let dv01Removed = 0;
  let totalSavings = 0;
  let cashMgmtBought = 0;
  let liquidityBought = 0;
  for (const op of r.buyback.operations) {
    const m = buckets[op.bucket];
    m.operations++;
    m.offered += op.offered;
    m.bought += op.accepted;
    m.avgSpreadBp += op.accepted * op.weightedSpreadBp;
    if (op.kind === "cash-mgmt") cashMgmtBought += op.accepted;
    else liquidityBought += op.accepted;
    for (const a of op.accepts) {
      const sav = (a.amount * (a.curvePrice - a.price)) / 100;
      m.savingsVsCurve += sav;
      totalSavings += sav;
      const d = (a.amount * a.dv01 * 1000) / 100; // $bn face × $ per bp per 100 → $mm per bp
      m.dv01Removed += d;
      dv01Removed += d;
    }
  }
  for (const m of buckets) {
    m.fillRate = m.offered > 0 ? m.bought / m.offered : 0;
    m.avgSpreadBp = m.bought > 0 ? m.avgSpreadBp / m.bought : 0;
  }
  let dv01Funded = 0;
  for (const a of r.auctions) dv01Funded += (a.fundingSize * a.dv01 * 1000) / 100;
  return {
    buckets,
    totalBought: liquidityBought + cashMgmtBought,
    totalSavings,
    dv01Removed,
    dv01Funded,
    netDv01: dv01Funded - dv01Removed,
    cashMgmtBought,
    liquidityBought,
  };
}

// ---------------------------------------------------------------------------
// Roll-down tracker
// ---------------------------------------------------------------------------

export interface RolldownPoint {
  dayIdx: number;
  date: DayNum;
  ageYears: number;
  remYears: number;
  bucket: number;
  spreadBp: number;
  /** Modeled probability of being bought in a single operation of its bucket. */
  buybackProbPerOp: number;
  projected: boolean;
}

/** Empirical per-bucket acceptance rate (accepted / offered) from the run. */
export function acceptanceRates(r: SimResult): number[] {
  const nb = r.config.buyback.buckets.length;
  const off = new Array(nb).fill(0);
  const acc = new Array(nb).fill(0);
  for (const op of r.buyback.operations) {
    off[op.bucket] += op.offered;
    acc[op.bucket] += op.accepted;
  }
  return off.map((o, k) => (o > 0 ? acc[k] / o : 0.3));
}

/**
 * A bond's realised path through the maturity buckets and a projection of the
 * rest of its life to maturity, with the modeled per-operation buyback
 * probability at each age.
 */
export function rolldownTracker(r: SimResult, bondId: string): RolldownPoint[] {
  const b = r.ledger.get(bondId);
  if (!b) return [];
  const k = r.ledger.index(bondId);
  const buckets = r.config.buyback.buckets;
  const rates = acceptanceRates(r);
  const bb = r.config.buyback;
  const liq = r.config.liquidity;
  const rec = r.records;
  const prob = (spreadBp: number, bucket: number): number => {
    if (bucket < 0 || !bb.enabled) return 0;
    const pOffer = Math.min(0.95, Math.max(0, bb.offerBaseProb + bb.offerCheapnessSlope * spreadBp));
    return pOffer * rates[bucket];
  };
  const out: RolldownPoint[] = [];
  const dayIdx = rec.dayIdx.view();
  const rem = rec.remYears.view();
  const spread = rec.spread.view();
  for (const row of rec.rowsForBond(k)) {
    const bucket = bucketIndex(rem[row], buckets);
    out.push({
      dayIdx: dayIdx[row],
      date: r.dates[dayIdx[row]],
      ageYears: (r.dates[dayIdx[row]] - b.issueDate) / 365.25,
      remYears: rem[row],
      bucket,
      spreadBp: spread[row] * 1e4,
      buybackProbPerOp: prob(spread[row] * 1e4, bucket),
      projected: false,
    });
  }
  // Projection: monthly steps to maturity using the aging-cheapness model.
  const lastDate = out.length ? out[out.length - 1].date : r.dates[r.dates.length - 1];
  const lastDay = out.length ? out[out.length - 1].dayIdx : r.dates.length - 1;
  for (let d = lastDate + 30; d < b.maturityDate - 31; d += 30) {
    const ageYears = (d - b.issueDate) / 365.25;
    const remYears = yearFrac(d, b.maturityDate);
    const bucket = bucketIndex(remYears, buckets);
    const spreadBp = Math.min(liq.agingCheapnessCapBp, liq.agingCheapnessBpPerYear * ageYears);
    out.push({ dayIdx: lastDay + Math.round(((d - lastDate) * 252) / 365.25), date: d, ageYears, remYears, bucket, spreadBp, buybackProbPerOp: prob(spreadBp, bucket), projected: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregates from records
// ---------------------------------------------------------------------------

/** Mean spread (bp) of off-the-run bonds per bucket on each recorded day. */
export function offRunCheapnessByBucket(r: SimResult): { days: number[]; series: Float64Array[] } {
  const buckets = r.config.buyback.buckets;
  const rec = r.records;
  const status = rec.status.view();
  const rem = rec.remYears.view();
  const spread = rec.spread.view();
  const days = rec.recordedDays;
  const series = buckets.map(() => new Float64Array(days.length).fill(NaN));
  days.forEach((d, di) => {
    const [s, e] = rec.rangeForDay(d);
    const sum = new Array(buckets.length).fill(0);
    const n = new Array(buckets.length).fill(0);
    for (let i = s; i < e; i++) {
      if (status[i] !== STATUS_CODES["off-run"]) continue;
      const k = bucketIndex(rem[i], buckets);
      if (k < 0) continue;
      sum[k] += spread[i] * 1e4;
      n[k]++;
    }
    for (let k = 0; k < buckets.length; k++) if (n[k]) series[k][di] = sum[k] / n[k];
  });
  return { days, series };
}

/** Outstanding by maturity year on a recorded day, with buyback retirements. */
export function supplyLadder(r: SimResult, dayIdx: number): { years: number[]; outstanding: number[]; boughtBack: number[] } {
  const rec = r.records;
  const [s, e] = rec.rangeForDay(dayIdx);
  const bondIdx = rec.bondIdx.view();
  const outstanding = rec.outstanding.view();
  const byYear = new Map<number, { out: number; bb: number }>();
  for (let i = s; i < e; i++) {
    const b = r.ledger.bonds[bondIdx[i]];
    const y = new Date(b.maturityDate * 86_400_000).getUTCFullYear();
    const cur = byYear.get(y) ?? { out: 0, bb: 0 };
    cur.out += outstanding[i];
    cur.bb += b.boughtBack;
    byYear.set(y, cur);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  return { years, outstanding: years.map((y) => byYear.get(y)!.out), boughtBack: years.map((y) => byYear.get(y)!.bb) };
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

export interface PathSummary {
  seed: number;
  y10: Float64Array;
  y2: Float64Array;
  twosTens: Float64Array;
  onOff10: Float64Array;
  specialness10: Float64Array;
  /** Mean off-run cheapness across buckets 1..4 (2y-10y), bp. */
  cheapness: Float64Array;
  regime: Int8Array;
  tail10Mean: number;
  bought: number;
}

export interface Band {
  q: number;
  values: Float64Array;
}

export function summarisePath(r: SimResult): PathSummary {
  const n = r.dates.length;
  const y10 = new Float64Array(n);
  const y2 = new Float64Array(n);
  const twosTens = new Float64Array(n);
  const cheapness = new Float64Array(n);
  const nb = r.liquidity.nBuckets;
  for (let i = 0; i < n; i++) {
    y10[i] = parYieldAt(r.curve, i, 10);
    y2[i] = parYieldAt(r.curve, i, 2);
    twosTens[i] = (y10[i] - y2[i]) * 1e4;
    let s = 0;
    let c = 0;
    for (let k = 1; k <= Math.min(4, nb - 1); k++) {
      const v = r.liquidity.bucketCheapness[i * nb + k];
      if (!Number.isNaN(v)) {
        s += v;
        c++;
      }
    }
    cheapness[i] = c ? s / c : NaN;
  }
  const tails = r.auctions.filter((a) => a.tenor === 10).map((a) => a.tailBp);
  return {
    seed: r.seed,
    y10,
    y2,
    twosTens,
    onOff10: r.liquidity.onOff[10].otrMinusFitted,
    specialness10: r.liquidity.onOff[10].specialness,
    cheapness,
    regime: r.daily.regime,
    tail10Mean: tails.length ? tails.reduce((a, b) => a + b, 0) / tails.length : 0,
    bought: r.ledger.cash.cumBuybacks,
  };
}

/** Run many seeds with bond-level recording off and return per-path summaries. */
export function runBatch(config: SimConfig, seeds: number[], onProgress?: (done: number, total: number) => void): PathSummary[] {
  const cfg: SimConfig = { ...config, run: { ...config.run, recordEveryDays: 0 } };
  const out: PathSummary[] = [];
  seeds.forEach((seed, i) => {
    out.push(summarisePath(simulate(cfg, seed)));
    onProgress?.(i + 1, seeds.length);
  });
  return out;
}

/** Pointwise quantile bands across paths. */
export function quantileBands(paths: ArrayLike<number>[], qs: number[]): Band[] {
  if (paths.length === 0) return qs.map((q) => ({ q, values: new Float64Array(0) }));
  const n = paths[0].length;
  const bands = qs.map((q) => ({ q, values: new Float64Array(n) }));
  const col = new Float64Array(paths.length);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let p = 0; p < paths.length; p++) {
      const v = paths[p][i];
      if (!Number.isNaN(v)) col[m++] = v;
    }
    const sorted = col.subarray(0, m).sort();
    for (const b of bands) {
      if (m === 0) {
        b.values[i] = NaN;
        continue;
      }
      const pos = b.q * (m - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(m - 1, lo + 1);
      b.values[i] = sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
    }
  }
  return bands;
}

/** Simple descriptive statistics. */
export function describe(xs: ArrayLike<number>): { mean: number; sd: number; min: number; max: number; n: number } {
  let s = 0;
  let s2 = 0;
  let n = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    if (Number.isNaN(v)) continue;
    s += v;
    s2 += v * v;
    n++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = n ? s / n : NaN;
  return { mean, sd: n ? Math.sqrt(Math.max(0, s2 / n - mean * mean)) : NaN, min, max, n };
}
