import { describe, it, expect } from "vitest";
import {
  makeConfig,
  simulate,
  curveMetrics,
  bondSnapshots,
  buybackMetrics,
  rolldownTracker,
  runBatch,
  quantileBands,
  offRunCheapnessByBucket,
  supplyLadder,
  describe as stats,
  type PartialConfig,
} from "../src/engine";

const calm = { transition: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as [[number, number, number], [number, number, number], [number, number, number]] };

describe("Phase 8 — analytics layer", () => {
  it("curve metrics are consistent with key-tenor par yields", () => {
    const r = simulate(makeConfig({ run: { horizonYears: 1, recordEveryDays: 0 } }), 1);
    const m = curveMetrics(r);
    expect(m.twosTens.length).toBe(r.dates.length);
    expect(stats(m.twosTens).sd).toBeGreaterThan(0);
    expect(Math.abs(stats(m.butterfly).mean)).toBeLessThan(100);
    expect(m.fivesThirties[0]).toBeCloseTo((r.curve.parYields[10] - r.curve.parYields[6]) * 1e4, 9);
  });

  it("carry + roll-down reproduces the realised 1-day return on a static curve", () => {
    // Freeze everything: no factor dynamics, no policy moves, no liquidity effects.
    const frozen: PartialConfig = {
      run: { horizonYears: 1, recordEveryDays: 1 },
      curve: { factors: { speed: [0, 0, 0], vol: [0, 0, 0] }, shortEndPull: 0 },
      liquidity: { baseRichnessBp: { 2: 0, 3: 0, 5: 0, 7: 0, 10: 0, 20: 0, 30: 0 }, noiseBp: 0, agingCheapnessBpPerYear: 0 },
      auction: { demandNoise: 0, tailNoiseBp: 0, tailPassThrough: 0 },
      buyback: { enabled: false },
      stress: calm,
    };
    const r = simulate(makeConfig(frozen), 1);
    let checked = 0;
    for (const d of [50, 120, 200]) {
      // Decomposition on day d looks forward to d+1; realised on d+1 looks back to d.
      const today = bondSnapshots(r, d);
      const next = new Map(bondSnapshots(r, d + 1).map((s) => [s.bondIdx, s]));
      for (const s of today) {
        const n = next.get(s.bondIdx);
        if (!n || Number.isNaN(n.realised) || s.status === "WI" || n.status === "WI") continue;
        const b = r.ledger.bonds[s.bondIdx];
        if (b.issueDate > r.dates[d]) continue; // settles between the two days
        expect(Math.abs(s.carry + s.rolldown - n.realised)).toBeLessThan(1e-9);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
    // Sanity: carry is positive for coupon bonds and roll-down positive on an upward-sloping curve.
    const snaps = bondSnapshots(r, 120).filter((s) => s.status === "off-run" && s.remYears > 3 && s.remYears < 10);
    expect(snaps.every((s) => s.carry > 0)).toBe(true);
    expect(snaps.filter((s) => s.rolldown > 0).length).toBeGreaterThan(snaps.length * 0.8);
  });

  it("buyback metrics reconcile with operations and report duration impact", () => {
    const r = simulate(makeConfig({ run: { horizonYears: 2, recordEveryDays: 5 } }), 2);
    const m = buybackMetrics(r);
    const bought = r.buyback.operations.reduce((s, o) => s + o.accepted, 0);
    expect(m.totalBought).toBeCloseTo(bought, 9);
    expect(m.buckets.reduce((s, b) => s + b.bought, 0)).toBeCloseTo(bought, 9);
    expect(m.dv01Removed).toBeGreaterThan(0);
    expect(m.dv01Funded).toBeGreaterThan(0);
    // With 70% bill funding, net duration is removed from the market.
    expect(m.netDv01).toBeLessThan(0);
    // With all-coupon funding in the matching tenor, net duration is roughly neutral.
    const neutral = buybackMetrics(simulate(makeConfig({ run: { horizonYears: 2, recordEveryDays: 0 }, buyback: { billFundingShare: 0 } }), 2));
    expect(Math.abs(neutral.netDv01)).toBeLessThan(neutral.dv01Removed * 0.6);
    expect(neutral.dv01Funded).toBeGreaterThan(m.dv01Funded * 2);
    // Buying cheap bonds below the curve produces positive savings on average.
    expect(m.totalSavings).toBeGreaterThan(0);
    for (const b of m.buckets) {
      expect(b.fillRate).toBeGreaterThanOrEqual(0);
      expect(b.fillRate).toBeLessThanOrEqual(1);
    }
  });

  it("roll-down tracker follows a note into the 1mo-2y bucket", () => {
    const r = simulate(makeConfig({ run: { horizonYears: 2, recordEveryDays: 5 } }), 3);
    const note = r.ledger.bonds.find((b) => b.tenor === 3 && b.auctionDate > r.dates[5] && b.auctionDate < r.dates[100])!;
    const path = rolldownTracker(r, note.id);
    expect(path.length).toBeGreaterThan(50);
    for (let i = 1; i < path.length; i++) expect(path[i].remYears).toBeLessThan(path[i - 1].remYears);
    expect([1, 2]).toContain(path[0].bucket); // starts at 3.0y remaining, then 2-3y
    expect(path[path.length - 1].bucket).toBe(0); // projected into 1mo-2y
    expect(path.some((p) => p.projected)).toBe(true);
    expect(path.every((p) => p.buybackProbPerOp >= 0 && p.buybackProbPerOp <= 1)).toBe(true);
    const ladder = supplyLadder(r, r.records.recordedDays[10]);
    expect(ladder.years.length).toBeGreaterThan(25);
    expect(ladder.outstanding.reduce((a, b) => a + b, 0)).toBeCloseTo(r.daily.totalOutstanding[r.records.recordedDays[10]], 6);
    const cheap = offRunCheapnessByBucket(r);
    expect(cheap.series.length).toBe(r.config.buyback.buckets.length);
  });

  it("batch of seeds runs fast enough for 200 × 5 years within a few minutes", () => {
    const cfg = makeConfig({ run: { horizonYears: 2 } });
    const t0 = performance.now();
    const paths = runBatch(cfg, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const elapsed = performance.now() - t0;
    const perSimYear = elapsed / 20;
    // Extrapolate to 200 seeds × 5 years.
    expect(perSimYear * 1000).toBeLessThan(180_000);
    expect(paths.length).toBe(10);
    const bands = quantileBands(paths.map((p) => p.y10), [0.05, 0.5, 0.95]);
    for (let i = 0; i < bands[0].values.length; i++) {
      expect(bands[0].values[i]).toBeLessThanOrEqual(bands[1].values[i]);
      expect(bands[1].values[i]).toBeLessThanOrEqual(bands[2].values[i]);
    }
    expect(bands[2].values[300] - bands[0].values[300]).toBeGreaterThan(0.002);
    expect(stats(paths[0].cheapness).n).toBeGreaterThan(400);
  });
});
