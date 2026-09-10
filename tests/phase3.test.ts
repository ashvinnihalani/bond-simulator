import { describe, it, expect } from "vitest";
import {
  makeConfig,
  simulate,
  Clock,
  buildAuctionCalendar,
  isoFromDayNum,
  TENORS,
  STATUS_CODES,
  bucketIndex,
  type Tenor,
} from "../src/engine";

describe("Phase 3 — issuance and CUSIP lifecycle", () => {
  const cfg = makeConfig({ run: { horizonYears: 2, recordEveryDays: 5 } });

  it("auction calendar follows the monthly / quarterly pattern", () => {
    const clock = new Clock("2026-01-02", 1);
    const evs = buildAuctionCalendar(clock, cfg.issuance, clock.start, clock.end, clock.start);
    const byTenor = (t: Tenor) => evs.filter((e) => e.tenor === t);
    expect(byTenor(2).length).toBe(12);
    expect(byTenor(2).every((e) => !e.isReopen)).toBe(true);
    expect(byTenor(10).filter((e) => !e.isReopen).length).toBe(4);
    expect(byTenor(10).filter((e) => e.isReopen).length).toBe(8);
    expect(byTenor(30).filter((e) => !e.isReopen).length).toBe(4);
    const feb10 = byTenor(10).find((e) => isoFromDayNum(e.dated) === "2026-02-15")!;
    expect(feb10.isReopen).toBe(false);
    expect(isoFromDayNum(feb10.auction)).toBe("2026-02-11");
    expect(isoFromDayNum(feb10.settle)).toBe("2026-02-17"); // 15th is Sunday, 16th is Presidents' Day
    expect(isoFromDayNum(feb10.maturity)).toBe("2036-02-15");
    expect(feb10.id).toBe("T10Y-2026-02");
    const mar10 = byTenor(10).find((e) => isoFromDayNum(e.dated) === "2026-03-15")!;
    expect(mar10.isReopen).toBe(true);
    expect(mar10.id).toBe("T10Y-2026-02");
    for (const e of evs) {
      expect(e.announce).toBeLessThan(e.auction);
      expect(e.auction).toBeLessThan(e.settle);
      expect(clock.isBusinessDay(e.auction)).toBe(true);
      expect(clock.isBusinessDay(e.settle)).toBe(true);
    }
    const jan2 = byTenor(2)[0];
    expect(isoFromDayNum(jan2.dated)).toBe("2026-01-31");
    expect(isoFromDayNum(jan2.settle)).toBe("2026-02-02");
  });

  it("ledger contains the expected number of CUSIPs per tenor after a 2-year run", () => {
    const r = simulate(cfg, 1);
    const live = r.ledger.bonds.filter((b) => b.status !== "retired" && b.status !== "WI");
    const count = (t: Tenor) => live.filter((b) => b.tenor === t).length;
    // Full ladder: 12 new issues per year for 2/3/5/7, 4 per year for 10/20/30,
    // for as many years as the tenor lasts (±1 for boundary timing).
    expect(Math.abs(count(2) - 24)).toBeLessThanOrEqual(1);
    expect(Math.abs(count(3) - 36)).toBeLessThanOrEqual(1);
    expect(Math.abs(count(5) - 60)).toBeLessThanOrEqual(1);
    expect(Math.abs(count(7) - 84)).toBeLessThanOrEqual(1);
    expect(Math.abs(count(10) - 40)).toBeLessThanOrEqual(1);
    expect(Math.abs(count(30) - 120)).toBeLessThanOrEqual(1);
    // 20y was reintroduced in 2020, but the seeded ladder is regular: 4/yr × 20y.
    expect(Math.abs(count(20) - 80)).toBeLessThanOrEqual(1);
    // New CUSIPs minted during the run: 24 each for 2/3/5/7, 8 each for 10/20/30.
    const minted = r.ledger.bonds.filter((b) => b.auctionDate >= r.dates[0] && b.auctionDate < r.dates[r.dates.length - 1]);
    const mintedCount = (t: Tenor) => minted.filter((b) => b.tenor === t).length;
    expect(mintedCount(2)).toBe(24);
    expect(mintedCount(10)).toBe(8);
    expect(mintedCount(30)).toBe(8);
    // Reopenings attach to the quarterly new issue.
    const ten = minted.filter((b) => b.tenor === 10);
    expect(ten.every((b) => b.reopenings === 2 || b.reopenings === 1 || b.reopenings === 0)).toBe(true);
    expect(ten.filter((b) => b.reopenings === 2).length).toBeGreaterThanOrEqual(6);
  });

  it("exactly one OTR per tenor at any recorded day", () => {
    const r = simulate(cfg, 2);
    const status = r.records.status.view();
    const bondIdx = r.records.bondIdx.view();
    for (const d of r.records.recordedDays) {
      const [s, e] = r.records.rangeForDay(d);
      const otr: Record<number, number> = {};
      const old: Record<number, number> = {};
      for (let i = s; i < e; i++) {
        const t = r.ledger.bonds[bondIdx[i]].tenor;
        if (status[i] === STATUS_CODES.OTR) otr[t] = (otr[t] ?? 0) + 1;
        if (status[i] === STATUS_CODES.old) old[t] = (old[t] ?? 0) + 1;
      }
      for (const t of TENORS) {
        expect(otr[t]).toBe(1);
        expect(old[t]).toBe(1);
      }
    }
    // The 10y OTR changes 8 times over two years (quarterly new issues).
    const otrIds = new Set<string>();
    for (const d of r.records.recordedDays) {
      const [s, e] = r.records.rangeForDay(d);
      for (let i = s; i < e; i++) {
        const b = r.ledger.bonds[bondIdx[i]];
        if (b.tenor === 10 && status[i] === STATUS_CODES.OTR) otrIds.add(b.id);
      }
    }
    expect(otrIds.size).toBeGreaterThanOrEqual(8);
    expect(otrIds.size).toBeLessThanOrEqual(9);
  });

  it("total outstanding equals cumulative issuance minus maturities", () => {
    const r = simulate(cfg, 3);
    const cash = r.ledger.cash;
    expect(r.ledger.totalOutstanding()).toBeCloseTo(cash.cumIssuance - cash.cumMaturities - cash.cumBuybacks, 6);
    expect(cash.cumMaturities).toBeGreaterThan(0);
    const last = r.dates.length - 1;
    expect(r.daily.totalOutstanding[last]).toBeCloseTo(r.ledger.totalOutstanding(), 9);
    // Matured bonds are retired with zero outstanding and removed from the chain.
    for (const b of r.ledger.bonds) {
      if (b.maturityDate <= r.dates[last]) {
        expect(b.status).toBe("retired");
        expect(b.outstanding).toBe(0);
      }
    }
    for (const t of TENORS) expect(r.ledger.chain[t].length).toBe(3);
  });

  it("coupons are set at auction just below the stop-out yield", () => {
    const r = simulate(cfg, 4);
    const newIssues = r.auctions.filter((a) => !a.isReopen);
    expect(newIssues.length).toBeGreaterThan(100);
    for (const a of newIssues) {
      expect(a.coupon).toBeLessThanOrEqual(a.stopYield + 1e-12);
      expect(a.stopYield - a.coupon).toBeLessThan(cfg.issuance.couponIncrement);
      const b = r.ledger.get(a.bondId)!;
      expect(b.coupon).toBe(a.coupon);
    }
    const reopens = r.auctions.filter((a) => a.isReopen);
    expect(reopens.length).toBeGreaterThan(40);
  });

  it("roll-down: remaining maturity shrinks and buckets shift over time", () => {
    const r = simulate(cfg, 5);
    const b = r.ledger.bonds.find((x) => x.tenor === 2 && x.status === "off-run" && x.outstanding > 0)!;
    const k = r.ledger.index(b.id);
    const rows = r.records.rowsForBond(k);
    const rem = r.records.remYears.view();
    for (let i = 1; i < rows.length; i++) expect(rem[rows[i]]).toBeLessThan(rem[rows[i - 1]]);
    const buckets = cfg.buyback.buckets;
    expect(bucketIndex(1.5, buckets)).toBe(0);
    expect(bucketIndex(2.5, buckets)).toBe(1);
    expect(bucketIndex(29.9, buckets)).toBe(6);
    expect(bucketIndex(0.01, buckets)).toBe(-1);
  });

  it("two runs on the same seed are identical", () => {
    const a = simulate(cfg, 11);
    const b = simulate(cfg, 11);
    expect(Array.from(a.records.ytm.view())).toEqual(Array.from(b.records.ytm.view()));
    expect(a.auctions.map((x) => x.coupon)).toEqual(b.auctions.map((x) => x.coupon));
  });
});
