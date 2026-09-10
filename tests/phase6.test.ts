import { describe, it, expect } from "vitest";
import { makeConfig, simulate, STATUS_CODES, bucketIndex, isoFromDayNum, monthOf, dayOfMonth, type SimResult, type PartialConfig } from "../src/engine";

/** Mean recorded spread (bp) of off-the-run bonds by bucket over all recorded days. */
function meanCheapnessByBucket(r: SimResult): number[] {
  const buckets = r.config.buyback.buckets;
  const sum = new Array(buckets.length).fill(0);
  const n = new Array(buckets.length).fill(0);
  const status = r.records.status.view();
  const rem = r.records.remYears.view();
  const spread = r.records.spread.view();
  for (let i = 0; i < r.records.length; i++) {
    if (status[i] !== STATUS_CODES["off-run"]) continue;
    const b = bucketIndex(rem[i], buckets);
    if (b < 0) continue;
    sum[b] += spread[i] * 1e4;
    n[b]++;
  }
  return sum.map((s, k) => (n[k] ? s / n[k] : 0));
}

const base: PartialConfig = { run: { horizonYears: 2, recordEveryDays: 2 } };

describe("Phase 6 — Treasury buyback program", () => {
  it("with buybacks off, output is bit-identical to a run where the module never acts", () => {
    const off = simulate(makeConfig({ ...base, buyback: { enabled: false } }), 8);
    const inert = simulate(makeConfig({ ...base, buyback: { enabled: true, offerBaseProb: 0, offerCheapnessSlope: 0, anticipationFraction: 0 } }), 8);
    expect(inert.buyback.operations.length).toBeGreaterThan(20);
    expect(inert.buyback.operations.every((o) => o.accepted === 0 && o.nOffers === 0)).toBe(true);
    expect(off.buyback.operations.length).toBe(0);
    expect(Array.from(off.records.ytm.view())).toEqual(Array.from(inert.records.ytm.view()));
    expect(Array.from(off.records.spread.view())).toEqual(Array.from(inert.records.spread.view()));
    expect(Array.from(off.records.outstanding.view())).toEqual(Array.from(inert.records.outstanding.view()));
    expect(off.auctions.map((a) => a.stopYield)).toEqual(inert.auctions.map((a) => a.stopYield));
    expect(Array.from(off.curve.parYields)).toEqual(Array.from(inert.curve.parYields));
  });

  it("buybacks reduce average off-the-run cheapness in each bucket, more so with larger sizes", () => {
    const off = simulate(makeConfig({ ...base, buyback: { enabled: false } }), 9);
    const on = simulate(makeConfig({ ...base, buyback: { enabled: true } }), 9);
    const cOff = meanCheapnessByBucket(off);
    const cOn = meanCheapnessByBucket(on);
    for (let b = 0; b < cOff.length; b++) {
      expect(cOn[b]).toBeLessThan(cOff[b]);
    }
    const bigBuckets = makeConfig({ ...base, buyback: { enabled: true } });
    bigBuckets.buyback.buckets[4].maxPerOp = 12; // 7-10y
    const big = simulate(bigBuckets, 9);
    const cBig = meanCheapnessByBucket(big);
    expect(cOff[4] - cBig[4]).toBeGreaterThan(cOff[4] - cOn[4]);
    expect(on.buyback.operations.reduce((s, o) => s + o.accepted, 0)).toBeGreaterThan(20);
  });

  it("no bill, WI, OTR, or retired bond ever appears in an accepted list; caps are respected", () => {
    const r = simulate(makeConfig({ ...base, buyback: { enabled: true } }), 10);
    const buckets = r.config.buyback.buckets;
    let totalAccepted = 0;
    for (const op of r.buyback.operations) {
      expect(op.accepted).toBeLessThanOrEqual(op.maxAmount + 1e-9);
      const perBond = new Map<string, number>();
      for (const a of op.accepts) {
        const b = r.ledger.get(a.bondId)!;
        expect(b).toBeDefined();
        expect(b.id.startsWith("T")).toBe(true); // coupon securities only; bills never enter the ledger
        expect(b.auctionDate).toBeLessThan(op.day); // not WI on the operation day
        expect(b.maturityDate).toBeGreaterThan(op.day); // not retired on the operation day
        // The bond must not have been OTR on the operation day: check auction ordering.
        const otrOnDay = r.ledger.bonds.some((x) => x.tenor === b.tenor && x.auctionDate <= op.day && x.auctionDate > b.auctionDate && x.status !== "WI");
        expect(otrOnDay).toBe(true);
        perBond.set(a.bondId, (perBond.get(a.bondId) ?? 0) + a.amount);
        expect(a.spreadBp).toBeGreaterThanOrEqual(r.config.buyback.reservationSpreadBp);
        // Remaining maturity in the operation's bucket as of the op day.
        const rem = (b.maturityDate - op.day) / 365.25;
        expect(rem).toBeGreaterThanOrEqual(buckets[op.bucket].lo - 1e-9);
        expect(rem).toBeLessThan(buckets[op.bucket].hi);
      }
      for (const [id, amt] of perBond) {
        const b = r.ledger.get(id)!;
        expect(amt).toBeLessThanOrEqual(r.config.buyback.perCusipCap * b.issued + 1e-9);
      }
      totalAccepted += op.accepted;
    }
    expect(totalAccepted).toBeCloseTo(r.ledger.cash.cumBuybacks, 9);
    expect(r.ledger.totalOutstanding()).toBeCloseTo(r.ledger.cash.cumIssuance - r.ledger.cash.cumMaturities - r.ledger.cash.cumBuybacks, 6);
    // Accepted offers are ranked cheapest-first within an operation.
    for (const op of r.buyback.operations) {
      for (let k = 1; k < op.accepts.length; k++) expect(op.accepts[k].spreadBp).toBeLessThanOrEqual(op.accepts[k - 1].spreadBp + 1e-12);
    }
  });

  it("fill rates fall when the reservation spread is tight and rise when it is loose", () => {
    const tight = simulate(makeConfig({ ...base, buyback: { enabled: true, reservationSpreadBp: 3 } }), 11);
    const loose = simulate(makeConfig({ ...base, buyback: { enabled: true, reservationSpreadBp: -20 } }), 11);
    const fill = (r: SimResult) => {
      const ops = r.buyback.operations.filter((o) => o.offered > 0);
      return ops.reduce((s, o) => s + o.fillRate, 0) / ops.length;
    };
    expect(fill(tight)).toBeLessThan(0.5);
    expect(fill(loose)).toBeGreaterThan(fill(tight) + 0.1);
    expect(fill(loose)).toBeGreaterThan(0.3);
    expect(loose.buyback.operations.some((o) => o.offered > 0 && o.fillRate === 1)).toBe(true);
    expect(loose.buyback.operations.every((o) => o.fillRate <= 1 + 1e-12)).toBe(true);
  });

  it("schedule: every bucket gets operations each quarter; cash-management ops sit before tax dates", () => {
    const r = simulate(makeConfig({ ...base, buyback: { enabled: true } }), 12);
    const sched = r.buyback.schedule;
    const buckets = r.config.buyback.buckets;
    const refundings = [r.dates[0], ...new Set(r.buyback.schedule.map((o) => o.announced))].sort((a, b) => a - b);
    for (let k = 0; k < refundings.length - 1; k++) {
      for (let b = 0; b < buckets.length; b++) {
        const n = sched.filter((o) => o.kind === "liquidity" && o.bucket === b && o.announced === refundings[k]).length;
        expect(n).toBeGreaterThanOrEqual(1);
      }
    }
    const cm = sched.filter((o) => o.kind === "cash-mgmt");
    expect(cm.length).toBeGreaterThanOrEqual(7);
    for (const o of cm) {
      expect(o.bucket).toBe(0);
      const d = o.day;
      const taxDays = r.config.buyback.cashMgmtTaxDates.map((md) => Number(md.slice(0, 2)) * 100 + Number(md.slice(3)));
      const mm = monthOf(d) * 100 + dayOfMonth(d);
      // Within ~12 calendar days before a tax date.
      expect(taxDays.some((t) => t - mm >= 3 && t - mm <= 12)).toBe(true);
      expect(o.announced).toBeLessThanOrEqual(d);
      expect(isoFromDayNum(d).length).toBe(10);
    }
    // Every scheduled op ran, at most one liquidity op per bucket per day.
    expect(r.buyback.operations.length).toBe(sched.length);
  });

  it("funding: bills and coupon issuance absorb liquidity buybacks; cash-management reduces bills", () => {
    const r = simulate(makeConfig({ ...base, buyback: { enabled: true } }), 13);
    const liq = r.buyback.operations.filter((o) => o.kind === "liquidity").reduce((s, o) => s + o.accepted, 0);
    const cm = r.buyback.operations.filter((o) => o.kind === "cash-mgmt").reduce((s, o) => s + o.accepted, 0);
    const share = r.config.buyback.billFundingShare;
    expect(r.ledger.cash.billsOutstanding).toBeCloseTo(share * liq - cm, 6);
    // Coupon funding shows up as larger auction sizes relative to a buyback-off run.
    const off = simulate(makeConfig({ ...base, buyback: { enabled: false } }), 13);
    const sizeOn = r.auctions.reduce((s, a) => s + a.size, 0);
    const sizeOff = off.auctions.reduce((s, a) => s + a.size, 0);
    expect(sizeOn).toBeGreaterThan(sizeOff);
    expect(sizeOn - sizeOff).toBeLessThanOrEqual((1 - share) * liq + 1e-6);
  });
});
