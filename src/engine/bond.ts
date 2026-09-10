/**
 * Bond object and pricing analytics.
 *
 * Conventions: semi-annual coupons, ACT/ACT accrual, street-convention yield
 * (compounded semi-annually, fractional first period). Prices are per 100 face.
 */

import { addMonths, yearFrac, type DayNum } from "./clock";
import type { Tenor } from "./config";

export type BondStatus = "WI" | "OTR" | "old" | "double-old" | "off-run" | "retired";

export interface Bond {
  /** Synthetic CUSIP-like identifier, e.g. "T10Y-2026-02". */
  id: string;
  tenor: Tenor;
  announceDate: DayNum;
  auctionDate: DayNum;
  /** Dated / issue date: accrual starts here. */
  issueDate: DayNum;
  maturityDate: DayNum;
  /** Annual coupon rate (decimal). Zero until the coupon is set at auction. */
  coupon: number;
  /** Outstanding amount ($bn). */
  outstanding: number;
  /** Cumulative amount ever issued ($bn), before buybacks or maturity. */
  issued: number;
  status: BondStatus;
  /** Idiosyncratic yield spread to the fitted curve (decimal, negative = rich). */
  spread: number;
  /** Number of reopenings so far. */
  reopenings: number;
  lastReopenDate: DayNum | null;
  /** Ascending coupon payment dates, ending with the maturity date. */
  couponDates: DayNum[];
  /** Regular period start (coupon date minus 6 months) for each coupon date. */
  periodStarts: DayNum[];
  /** Cash-flow amount per 100 face at each coupon date; rebuilt when the coupon changes. */
  cfAmounts: number[];
  /** Coupon the cfAmounts were built for. */
  cfCoupon: number;
  /** Transient post-auction shock on the spread (decimal), decays daily. */
  auctionShock: number;
  /** Transient buyback spillover richening (decimal, negative = rich), decays daily. */
  spilloverShock: number;
  /** AR(1) idiosyncratic noise state (decimal). */
  noiseState: number;
  /** Cumulative amount bought back ($bn). */
  boughtBack: number;
}

/** Coupon dates from the maturity stepping back 6 months, keeping those after issue. */
export function couponSchedule(issueDate: DayNum, maturityDate: DayNum): DayNum[] {
  const dates: DayNum[] = [];
  let k = 0;
  for (;;) {
    const d = addMonths(maturityDate, -6 * k);
    if (d <= issueDate) break;
    dates.push(d);
    k++;
    if (k > 200) throw new Error("coupon schedule runaway");
  }
  return dates.reverse();
}

/** Previous and next coupon dates around a settlement date (prev may be the issue date). */
export function couponPeriod(bond: Bond, settle: DayNum): { prev: DayNum; next: DayNum; periodDays: number } {
  const dates = bond.couponDates;
  let idx = 0;
  while (idx < dates.length && dates[idx] <= settle) idx++;
  if (idx >= dates.length) {
    const last = dates[dates.length - 1];
    return { prev: last, next: last, periodDays: 1 };
  }
  const next = dates[idx];
  const regularPrev = bond.periodStarts[idx];
  const prev = idx === 0 ? Math.max(bond.issueDate, regularPrev) : dates[idx - 1];
  return { prev, next, periodDays: next - regularPrev };
}

/** Accrued interest per 100 face at settlement (ACT/ACT). */
export function accruedInterest(bond: Bond, settle: DayNum): number {
  if (settle <= bond.issueDate || settle >= bond.maturityDate) return 0;
  const { prev, periodDays } = couponPeriod(bond, settle);
  return ((bond.coupon * 100) / 2) * ((settle - prev) / periodDays);
}

/** Rebuild the cached cash-flow amounts if the coupon changed. */
export function ensureCashflows(bond: Bond): number[] {
  if (bond.cfCoupon === bond.coupon && bond.cfAmounts.length === bond.couponDates.length) return bond.cfAmounts;
  const c = (bond.coupon * 100) / 2;
  const n = bond.couponDates.length;
  const out = new Array<number>(n);
  for (let k = 0; k < n; k++) {
    const d = bond.couponDates[k];
    let amt = c;
    if (k === 0) {
      // Short/long first coupon: pro-rate by accrual fraction of a regular period.
      const regularPrev = bond.periodStarts[0];
      const frac = (d - Math.max(bond.issueDate, regularPrev)) / (d - regularPrev);
      amt = c * Math.min(frac, 1.5);
    }
    if (k === n - 1) amt += 100;
    out[k] = amt;
  }
  bond.cfAmounts = out;
  bond.cfCoupon = bond.coupon;
  return out;
}

/** Remaining cash flows after settlement as [yearsFromSettle, amountPer100] pairs. */
export function cashflows(bond: Bond, settle: DayNum): Array<[number, number]> {
  const amts = ensureCashflows(bond);
  const out: Array<[number, number]> = [];
  for (let k = 0; k < amts.length; k++) {
    const d = bond.couponDates[k];
    if (d <= settle) continue;
    out.push([yearFrac(settle, d), amts[k]]);
  }
  return out;
}

export type DiscountFn = (tau: number) => number;

/** Dirty price per 100 from a discount-factor function with a parallel zero-rate shift `spread`. */
export function dirtyPriceOnCurve(bond: Bond, settle: DayNum, df: DiscountFn, spread: number): number {
  const amts = ensureCashflows(bond);
  const dates = bond.couponDates;
  let pv = 0;
  for (let k = 0; k < amts.length; k++) {
    const d = dates[k];
    if (d <= settle) continue;
    const t = (d - settle) / 365.25;
    pv += amts[k] * df(t) * (spread === 0 ? 1 : Math.exp(-spread * t));
  }
  return pv;
}

/** Dirty prices at zero spread and at `spread`, sharing one pass over the discount factors. */
export function dirtyPricePair(bond: Bond, settle: DayNum, df: DiscountFn, spread: number): [number, number] {
  const amts = ensureCashflows(bond);
  const dates = bond.couponDates;
  let pv0 = 0;
  let pvS = 0;
  for (let k = 0; k < amts.length; k++) {
    const d = dates[k];
    if (d <= settle) continue;
    const t = (d - settle) / 365.25;
    const base = amts[k] * df(t);
    pv0 += base;
    pvS += base * Math.exp(-spread * t);
  }
  return [pv0, pvS];
}

export function cleanPriceOnCurve(bond: Bond, settle: DayNum, df: DiscountFn, spread: number): number {
  return dirtyPriceOnCurve(bond, settle, df, spread) - accruedInterest(bond, settle);
}

/** Coupon that would make the bond price exactly at par (dirty = 100 + accrued) on the curve. */
export function parCouponOnCurve(bond: Bond, settle: DayNum, df: DiscountFn, spread = 0): number {
  const saved = bond.coupon;
  bond.coupon = 1; // 100% coupon -> coupon leg = Σ 50·frac·DF
  const couponLeg = dirtyPriceOnCurve(bond, settle, df, spread) - 100 * dfSpread(bond, settle, df, spread);
  bond.coupon = saved;
  const principalPv = 100 * dfSpread(bond, settle, df, spread);
  bond.coupon = 1;
  const accruedPerUnitCoupon = accruedInterest(bond, settle);
  bond.coupon = saved;
  // price(c) = c·couponLeg + principalPv = 100 + c·accruedPerUnitCoupon
  return (100 - principalPv) / (couponLeg - accruedPerUnitCoupon);
}

function dfSpread(bond: Bond, settle: DayNum, df: DiscountFn, spread: number): number {
  const t = yearFrac(settle, bond.maturityDate);
  return df(t) * Math.exp(-spread * t);
}

/** Round a par yield down to the coupon increment so the bond prices at or just below par. */
export function roundCoupon(parYield: number, increment: number): number {
  return Math.max(0, Math.floor(parYield / increment + 1e-9) * increment);
}

/** First remaining coupon index and the fractional first period, street convention. */
function firstPeriod(bond: Bond, settle: DayNum): { k0: number; w: number } {
  const dates = bond.couponDates;
  let k0 = 0;
  while (k0 < dates.length && dates[k0] <= settle) k0++;
  if (k0 >= dates.length) return { k0, w: 0 };
  const next = dates[k0];
  const periodDays = next - bond.periodStarts[k0];
  return { k0, w: (next - settle) / periodDays };
}

/** Dirty price from a street-convention semi-annual yield. */
export function dirtyPriceFromYield(bond: Bond, settle: DayNum, y: number): number {
  const amts = ensureCashflows(bond);
  const { k0, w } = firstPeriod(bond, settle);
  const v = 1 / (1 + y / 2);
  let disc = Math.pow(v, w);
  let pv = 0;
  for (let k = k0; k < amts.length; k++) {
    pv += amts[k] * disc;
    disc *= v;
  }
  return pv;
}

/** Street-convention yield from a dirty price (Newton with bisection fallback). */
export function yieldFromDirtyPrice(bond: Bond, settle: DayNum, dirty: number, guess?: number): number {
  const amts = ensureCashflows(bond);
  const { k0, w } = firstPeriod(bond, settle);
  if (k0 >= amts.length) return 0;
  // Returns [price - dirty, dPrice/dy].
  const eval2 = (y: number): [number, number] => {
    const v = 1 / (1 + y / 2);
    let disc = Math.pow(v, w);
    let pv = 0;
    let d = 0;
    let p = w;
    for (let k = k0; k < amts.length; k++) {
      const a = amts[k] * disc;
      pv += a;
      d += (-p / 2) * a * v;
      disc *= v;
      p += 1;
    }
    return [pv - dirty, d];
  };
  let y = guess ?? (bond.coupon > 0 ? bond.coupon : 0.04);
  for (let it = 0; it < 50; it++) {
    const [fy, dy] = eval2(y);
    if (Math.abs(dy) < 1e-14) break;
    const step = fy / dy;
    y -= step;
    if (Math.abs(step) < 1e-13) return y;
  }
  if (Math.abs(eval2(y)[0]) < 1e-9) return y;
  let lo = -0.5;
  let hi = 1.0;
  for (let it = 0; it < 200; it++) {
    const mid = 0.5 * (lo + hi);
    if (eval2(mid)[0] > 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export interface RiskMetrics {
  dirtyPrice: number;
  cleanPrice: number;
  accrued: number;
  ytm: number;
  /** Modified duration (years). */
  modDuration: number;
  /** Macaulay duration (years). */
  macDuration: number;
  /** Convexity (years², per unit yield). */
  convexity: number;
  /** Dollar value of 1bp per 100 face. */
  dv01: number;
}

/** Full risk metrics from a street-convention yield. */
export function riskFromYield(bond: Bond, settle: DayNum, y: number): RiskMetrics {
  const amts = ensureCashflows(bond);
  const { k0, w } = firstPeriod(bond, settle);
  const v = 1 / (1 + y / 2);
  let disc = Math.pow(v, w);
  let pv = 0;
  let d1 = 0;
  let d2 = 0;
  let p = w;
  for (let k = k0; k < amts.length; k++) {
    const a = amts[k] * disc;
    pv += a;
    d1 += (p / 2) * a;
    d2 += (p / 2) * (p / 2 + 0.5) * a;
    disc *= v;
    p += 1;
  }
  const mac = pv > 0 ? d1 / pv : 0;
  const mod = mac / (1 + y / 2);
  const conv = pv > 0 ? d2 / pv / Math.pow(1 + y / 2, 2) : 0;
  const accrued = accruedInterest(bond, settle);
  return {
    dirtyPrice: pv,
    cleanPrice: pv - accrued,
    accrued,
    ytm: y,
    modDuration: mod,
    macDuration: mac,
    convexity: conv,
    dv01: (mod * pv) / 10_000,
  };
}

/** Remaining maturity in years from a date. */
export function remainingYears(bond: Bond, date: DayNum): number {
  return yearFrac(date, bond.maturityDate);
}

/** Age in calendar days since the original issue date. */
export function ageDays(bond: Bond, date: DayNum): number {
  return date - bond.issueDate;
}

/** Construct a bond shell; the coupon is set later at auction. */
export function makeBond(args: {
  id: string;
  tenor: Tenor;
  announceDate: DayNum;
  auctionDate: DayNum;
  issueDate: DayNum;
  maturityDate: DayNum;
  coupon?: number;
  outstanding?: number;
  status?: BondStatus;
  spread?: number;
}): Bond {
  const couponDates = couponSchedule(args.issueDate, args.maturityDate);
  return {
    id: args.id,
    tenor: args.tenor,
    announceDate: args.announceDate,
    auctionDate: args.auctionDate,
    issueDate: args.issueDate,
    maturityDate: args.maturityDate,
    coupon: args.coupon ?? 0,
    outstanding: args.outstanding ?? 0,
    issued: args.outstanding ?? 0,
    status: args.status ?? "WI",
    spread: args.spread ?? 0,
    reopenings: 0,
    lastReopenDate: null,
    couponDates,
    periodStarts: couponDates.map((d) => addMonths(d, -6)),
    cfAmounts: [],
    cfCoupon: -1,
    auctionShock: 0,
    spilloverShock: 0,
    noiseState: 0,
    boughtBack: 0,
  };
}
