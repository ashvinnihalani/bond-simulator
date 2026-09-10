import { describe, it, expect } from "vitest";
import {
  NsCurve,
  makeBond,
  toDayNum,
  addYears,
  dirtyPriceOnCurve,
  cleanPriceOnCurve,
  yieldFromDirtyPrice,
  dirtyPriceFromYield,
  parCouponOnCurve,
  roundCoupon,
  riskFromYield,
  accruedInterest,
  couponSchedule,
  isoFromDayNum,
} from "../src/engine";

const issue = toDayNum(2026, 2, 17);
const ten = () => makeBond({ id: "T10", tenor: 10, announceDate: issue - 7, auctionDate: issue - 2, issueDate: issue, maturityDate: addYears(issue, 10), coupon: 0.04, outstanding: 39, status: "OTR" });

describe("Phase 2 — bond object and pricing", () => {
  it("coupon schedule is semi-annual ending at maturity", () => {
    const b = ten();
    expect(b.couponDates.length).toBe(20);
    expect(isoFromDayNum(b.couponDates[0])).toBe("2026-08-17");
    expect(b.couponDates[19]).toBe(b.maturityDate);
    // odd first period
    const s = couponSchedule(toDayNum(2026, 3, 1), toDayNum(2028, 2, 15));
    expect(s.map(isoFromDayNum)).toEqual(["2026-08-15", "2027-02-15", "2027-08-15", "2028-02-15"]);
  });

  it("accrued interest is ACT/ACT", () => {
    const b = ten();
    expect(accruedInterest(b, issue)).toBe(0);
    const settle = issue + 91;
    const period = b.couponDates[0] - issue; // 181 days Feb 17 -> Aug 17
    expect(accruedInterest(b, settle)).toBeCloseTo(2 * (91 / period), 12);
    expect(accruedInterest(b, b.couponDates[0])).toBe(0); // resets on coupon date
  });

  it("price -> yield -> price round-trips within 1e-8", () => {
    const b = ten();
    const c = new NsCurve(0.045, -0.012, -0.01, 1.8, 0.002);
    for (const spread of [0, 0.0003, -0.0002]) {
      for (const offset of [0, 45, 200, 1000, 3000]) {
        const settle = issue + offset;
        const dirty = dirtyPriceOnCurve(b, settle, (t) => c.discountFactor(t), spread);
        const y = yieldFromDirtyPrice(b, settle, dirty);
        const back = dirtyPriceFromYield(b, settle, y);
        expect(Math.abs(back - dirty)).toBeLessThan(1e-8);
      }
    }
  });

  it("a bond with zero idiosyncratic spread prices exactly on the fitted curve", () => {
    const c = new NsCurve(0.045, -0.012, -0.01, 1.8, 0.002);
    const df = (t: number) => c.discountFactor(t);
    const b = ten();
    const par = parCouponOnCurve(b, issue, df);
    b.coupon = par;
    expect(dirtyPriceOnCurve(b, issue, df, 0)).toBeCloseTo(100, 10);
    expect(cleanPriceOnCurve(b, issue, df, 0)).toBeCloseTo(100, 10);
    // par coupon is close to the curve's key-tenor par yield
    expect(Math.abs(par - c.parYield(10))).toBeLessThan(0.0002);
    // with a positive (cheap) spread the price falls; yield spread ≈ zero shift
    const yFair = yieldFromDirtyPrice(b, issue, dirtyPriceOnCurve(b, issue, df, 0));
    const yCheap = yieldFromDirtyPrice(b, issue, dirtyPriceOnCurve(b, issue, df, 0.0005));
    expect(Math.abs((yCheap - yFair) / 0.0005 - 1)).toBeLessThan(0.03); // compounding convention slippage only
  });

  it("coupon rounding puts the price just below par", () => {
    const c = new NsCurve(0.045, -0.012, -0.01, 1.8, 0.002);
    const df = (t: number) => c.discountFactor(t);
    const b = ten();
    const par = parCouponOnCurve(b, issue, df);
    b.coupon = roundCoupon(par, 0.00125);
    expect(b.coupon).toBeLessThanOrEqual(par);
    expect(par - b.coupon).toBeLessThan(0.00125);
    expect(Math.round(b.coupon / 0.00125)).toBeCloseTo(b.coupon / 0.00125, 9);
    const px = cleanPriceOnCurve(b, issue, df, 0);
    expect(px).toBeLessThanOrEqual(100);
    expect(px).toBeGreaterThan(99);
    expect(roundCoupon(0.04375, 0.00125)).toBeCloseTo(0.04375, 12);
    expect(roundCoupon(0.04374, 0.00125)).toBeCloseTo(0.0425, 12);
  });

  it("duration of a par 10y bond is 8-9 years at 4% yields", () => {
    const b = ten();
    const r = riskFromYield(b, issue, 0.04);
    expect(r.dirtyPrice).toBeCloseTo(100, 8);
    expect(r.modDuration).toBeGreaterThan(8);
    expect(r.modDuration).toBeLessThan(9);
    expect(r.macDuration).toBeGreaterThan(r.modDuration);
    expect(r.dv01).toBeCloseTo(r.modDuration / 100, 6);
    expect(r.convexity).toBeGreaterThan(70);
    expect(r.convexity).toBeLessThan(90);
    // numerical check of dv01
    const up = dirtyPriceFromYield(b, issue, 0.0401);
    const dn = dirtyPriceFromYield(b, issue, 0.0399);
    expect((dn - up) / 2).toBeCloseTo(r.dv01, 4);
  });
});
