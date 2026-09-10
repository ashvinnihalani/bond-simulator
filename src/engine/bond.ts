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
  const regularPrev = addMonths(next, -6);
  const prev = idx === 0 ? Math.max(bond.issueDate, regularPrev) : dates[idx - 1];
  return { prev, next, periodDays: next - regularPrev };
}

/** Accrued interest per 100 face at settlement (ACT/ACT). */
export function accruedInterest(bond: Bond, settle: DayNum): number {
  if (settle <= bond.issueDate || settle >= bond.maturityDate) return 0;
  const { prev, periodDays } = couponPeriod(bond, settle);
  return ((bond.coupon * 100) / 2) * ((settle - prev) / periodDays);
}

/** Remaining cash flows after settlement as [yearsFromSettle, amountPer100] pairs. */
export function cashflows(bond: Bond, settle: DayNum): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const c = (bond.coupon * 100) / 2;
  const n = bond.couponDates.length;
  for (let k = 0; k < n; k++) {
    const d = bond.couponDates[k];
    if (d <= settle) continue;
    let amt = c;
    if (k === 0) {
      // Short/long first coupon: pro-rate by accrual fraction of a regular period.
      const regularPrev = addMonths(d, -6);
      const frac = (d - Math.max(bond.issueDate, regularPrev)) / (d - regularPrev);
      amt = c * Math.min(frac, 1.5);
    }
    if (k === n - 1) amt += 100;
    out.push([yearFrac(settle, d), amt]);
  }
  return out;
}

export type DiscountFn = (tau: number) => number;

/** Dirty price per 100 from a discount-factor function with a parallel zero-rate shift `spread`. */
export function dirtyPriceOnCurve(bond: Bond, settle: DayNum, df: DiscountFn, spread: number): number {
  let pv = 0;
  for (const [t, amt] of cashflows(bond, settle)) {
    pv += amt * df(t) * Math.exp(-spread * t);
  }
  return pv;
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
  const accruedPerUnitCoupon = accruedInterest({ ...bond, coupon: 1 }, settle);
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

/** Street-convention period offsets: fractional periods to each remaining cash flow. */
function periodOffsets(bond: Bond, settle: DayNum): Array<[number, number]> {
  const { next, prev, periodDays } = couponPeriod(bond, settle);
  const w = (next - settle) / periodDays;
  void prev;
  const out: Array<[number, number]> = [];
  const c = (bond.coupon * 100) / 2;
  const n = bond.couponDates.length;
  let j = 0;
  for (let k = 0; k < n; k++) {
    const d = bond.couponDates[k];
    if (d <= settle) continue;
    let amt = c;
    if (k === 0) {
      const regularPrev = addMonths(d, -6);
      const frac = (d - Math.max(bond.issueDate, regularPrev)) / (d - regularPrev);
      amt = c * Math.min(frac, 1.5);
    }
    if (k === n - 1) amt += 100;
    out.push([w + j, amt]);
    j++;
  }
  return out;
}

/** Dirty price from a street-convention semi-annual yield. */
export function dirtyPriceFromYield(bond: Bond, settle: DayNum, y: number): number {
  const offs = periodOffsets(bond, settle);
  const v = 1 / (1 + y / 2);
  let pv = 0;
  for (const [p, amt] of offs) pv += amt * Math.pow(v, p);
  return pv;
}

/** Street-convention yield from a dirty price (Newton with bisection fallback). */
export function yieldFromDirtyPrice(bond: Bond, settle: DayNum, dirty: number): number {
  const offs = periodOffsets(bond, settle);
  if (offs.length === 0) return 0;
  const f = (y: number): number => {
    const v = 1 / (1 + y / 2);
    let pv = 0;
    for (const [p, amt] of offs) pv += amt * Math.pow(v, p);
    return pv - dirty;
  };
  const df = (y: number): number => {
    const v = 1 / (1 + y / 2);
    let d = 0;
    for (const [p, amt] of offs) d += (-p / 2) * amt * Math.pow(v, p + 1);
    return d;
  };
  let y = bond.coupon > 0 ? bond.coupon : 0.04;
  for (let it = 0; it < 50; it++) {
    const fy = f(y);
    const dy = df(y);
    if (Math.abs(dy) < 1e-14) break;
    const step = fy / dy;
    y -= step;
    if (Math.abs(step) < 1e-14) return y;
  }
  if (Math.abs(f(y)) < 1e-9) return y;
  let lo = -0.5;
  let hi = 1.0;
  for (let it = 0; it < 200; it++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) > 0) lo = mid;
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
  const offs = periodOffsets(bond, settle);
  const v = 1 / (1 + y / 2);
  let pv = 0;
  let d1 = 0;
  let d2 = 0;
  for (const [p, amt] of offs) {
    const disc = amt * Math.pow(v, p);
    pv += disc;
    d1 += (p / 2) * disc;
    d2 += ((p / 2) * (p / 2 + 0.5)) * disc;
  }
  const mac = d1 / pv;
  const mod = mac / (1 + y / 2);
  const conv = d2 / pv / Math.pow(1 + y / 2, 2);
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
    couponDates: couponSchedule(args.issueDate, args.maturityDate),
    auctionShock: 0,
    spilloverShock: 0,
    noiseState: 0,
    boughtBack: 0,
  };
}
