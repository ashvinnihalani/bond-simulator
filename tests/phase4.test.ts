import { describe, it, expect } from "vitest";
import { makeConfig, simulate, type AuctionResult } from "../src/engine";

function stats(xs: number[]): { mean: number; sd: number } {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { mean, sd };
}

function tenYearTails(seeds: number[], overrides = {}): AuctionResult[] {
  const out: AuctionResult[] = [];
  for (const seed of seeds) {
    const r = simulate(makeConfig({ run: { horizonYears: 3, recordEveryDays: 0 }, ...overrides }), seed);
    out.push(...r.auctions.filter((a) => a.tenor === 10));
  }
  return out;
}

describe("Phase 4 — auction mechanics", () => {
  it("tails average near zero with realistic dispersion under calm conditions", () => {
    const tails = tenYearTails([1, 2, 3, 4, 5, 6]).map((a) => a.tailBp);
    expect(tails.length).toBeGreaterThan(200);
    const { mean, sd } = stats(tails);
    expect(Math.abs(mean)).toBeLessThan(0.8);
    expect(sd).toBeGreaterThan(0.7);
    expect(sd).toBeLessThan(2.5);
  });

  it("larger auction sizes relative to dealer capacity produce larger tails", () => {
    const small = stats(tenYearTails([1, 2, 3, 4], { issuance: { newIssueSize: { 10: 30 }, reopenSize: { 10: 30 } } }).map((a) => a.tailBp));
    const large = stats(tenYearTails([1, 2, 3, 4], { issuance: { newIssueSize: { 10: 70 }, reopenSize: { 10: 70 } } }).map((a) => a.tailBp));
    expect(large.mean - small.mean).toBeGreaterThan(2);
    // Reduced dealer capacity has the same effect.
    const thin = stats(tenYearTails([1, 2, 3, 4], { auction: { dealerCapacity: { 10: 30 } } }).map((a) => a.tailBp));
    expect(thin.mean).toBeGreaterThan(small.mean + 1);
  });

  it("bid-to-cover and dealer share respond to the tail", () => {
    const res = tenYearTails([1, 2, 3, 4, 5, 6]);
    const weak = res.filter((a) => a.tailBp > 1);
    const strong = res.filter((a) => a.tailBp < -1);
    expect(weak.length).toBeGreaterThan(10);
    expect(strong.length).toBeGreaterThan(10);
    expect(stats(weak.map((a) => a.bidToCover)).mean).toBeLessThan(stats(strong.map((a) => a.bidToCover)).mean);
    expect(stats(weak.map((a) => a.dealerShare)).mean).toBeGreaterThan(stats(strong.map((a) => a.dealerShare)).mean);
    for (const a of res) {
      expect(a.dealerShare + a.indirectShare + a.directShare).toBeCloseTo(1, 10);
      expect(a.bidToCover).toBeGreaterThan(1);
      expect(a.stopYield).toBeCloseTo(a.wiYield + a.tailBp / 1e4, 12);
    }
  });

  it("a tailed auction cheapens the new OTR temporarily and the shock decays", () => {
    // Zero liquidity premia so the recorded spread isolates the auction shock.
    const cfg = makeConfig({
      run: { horizonYears: 1, recordEveryDays: 1 },
      liquidity: { baseRichnessBp: { 2: 0, 3: 0, 5: 0, 7: 0, 10: 0, 20: 0, 30: 0 }, noiseBp: 0, agingCheapnessBpPerYear: 0 },
    });
    const r = simulate(cfg, 7);
    const a = r.auctions.find((x) => x.tenor === 10 && !x.isReopen && Math.abs(x.tailBp) > 1.0)!;
    expect(a).toBeDefined();
    const k = r.ledger.index(a.bondId);
    const rows = r.records.rowsForBond(k);
    const dayIdx = r.records.dayIdx.view();
    const spread = r.records.spread.view();
    const onDay = rows.find((i) => dayIdx[i] === a.dayIdx)!;
    const later = rows.find((i) => dayIdx[i] === a.dayIdx + 15)!;
    const expected = (a.tailBp / 1e4) * cfg.auction.tailPassThrough;
    // Spread on auction day includes the pass-through shock (decayed once), later it has washed out.
    expect(spread[onDay] * 1e4).toBeCloseTo(expected * cfg.auction.tailShockDecay * 1e4, 1);
    expect(Math.abs(spread[later])).toBeLessThan(Math.abs(expected) * 0.05 + 1e-6);
  });
});
