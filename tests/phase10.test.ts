import { describe, it, expect } from "vitest";
import { calibrateCurve, calibrateBuybacks, compareMoments, fitAr1, fitNsFactors, makeConfig, moments, parseYieldCsv, simulate, parYieldAt, KEY_TENORS, NsCurve, Rng, type YieldObservation } from "../src/engine";

describe("Phase 10 — calibration against (synthetic) history", () => {
  it("recovers Nelson-Siegel factors from a curve's own zero rates", () => {
    const c = new NsCurve(0.045, -0.012, -0.01, 1.8, 0);
    const yields: Record<number, number> = {};
    for (const t of KEY_TENORS) yields[t] = c.zeroRate(t);
    const f = fitNsFactors(yields, 1.8)!;
    expect(f[0]).toBeCloseTo(0.045, 8);
    expect(f[1]).toBeCloseTo(-0.012, 8);
    expect(f[2]).toBeCloseTo(-0.01, 8);
  });

  it("AR(1) estimator recovers mean, speed and vol", () => {
    const rng = new Rng(5);
    const x: number[] = [0.05];
    for (let i = 1; i < 20000; i++) x.push(x[i - 1] + 0.01 * (0.04 - x[i - 1]) + 0.0005 * rng.normal());
    const f = fitAr1(x);
    expect(f.mean).toBeCloseTo(0.04, 3);
    expect(Math.abs(f.speed - 0.01)).toBeLessThan(0.003);
    expect(Math.abs(f.vol / 0.0005 - 1)).toBeLessThan(0.03);
  });

  it("calibrating on simulated history reproduces the generating parameters within tolerance", () => {
    // Use one long simulated path as if it were history (policy held, calm regime).
    const cfg = makeConfig({
      run: { horizonYears: 12, recordEveryDays: 0 },
      stress: { transition: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
      curve: { shortEndPull: 0 },
    });
    const r = simulate(cfg, 4);
    const history: YieldObservation[] = [];
    for (let i = 0; i < r.dates.length; i++) {
      const yields: Record<number, number> = {};
      for (const t of KEY_TENORS) yields[t] = parYieldAt(r.curve, i, t);
      history.push({ date: String(r.dates[i]), yields });
    }
    const cal = calibrateCurve(history, cfg.curve.lambda);
    // Par yields are not zero rates, so allow a few bp of fit error and ~30% on dynamics.
    expect(cal.series.rmseBp.reduce((a, b) => a + b, 0) / cal.series.rmseBp.length).toBeLessThan(6);
    const gen = cfg.curve.factors;
    expect(Math.abs(cal.factors.vol[0] / gen.vol[0] - 1)).toBeLessThan(0.3);
    expect(Math.abs(cal.factors.vol[1] / gen.vol[1] - 1)).toBeLessThan(0.35);
    expect(Math.abs(cal.factors.mean[0] - gen.mean[0])).toBeLessThan(0.01);
    expect(cal.factors.corr[0][1]).toBeLessThan(0); // level/slope innovations negatively correlated as generated
    // Checkpoint 10: simulated moments of the 10y are within a tolerance band of "history".
    const sim = simulate(makeConfig({ ...cfg, ...cal.overlay, run: { ...cfg.run, horizonYears: 12 } }), 9);
    const y10Sim = Array.from({ length: sim.dates.length }, (_, i) => parYieldAt(sim.curve, i, 10) * 1e4);
    const y10Hist = history.map((h) => h.yields[10] * 1e4);
    const cmp = compareMoments(moments(y10Sim), moments(y10Hist));
    expect(cmp.mean).toBeLessThan(0.15);
    expect(cmp.dsd).toBeLessThan(0.3);
    expect(cmp.ac1).toBeLessThan(0.05);
  });

  it("buyback calibration scales offer volume toward the historical offer-to-max ratio", () => {
    const ops = [
      { bucket: "7-10y", offered: 9, accepted: 2, maxAmount: 2 },
      { bucket: "7-10y", offered: 6, accepted: 2, maxAmount: 2 },
      { bucket: "2-3y", offered: 12, accepted: 4, maxAmount: 4 },
    ];
    const cal = calibrateBuybacks(ops, { offerBaseProb: 0.08, offerSizeFraction: 0.012 }, 6);
    expect(cal.byBucket["7-10y"].ops).toBe(2);
    expect(cal.byBucket["7-10y"].fillRate).toBeCloseTo((2 / 9 + 2 / 6) / 2, 10);
    // Historical offered/max ≈ 3.4 vs simulated 6 → offer parameters shrink.
    expect(cal.overlay.buyback!.offerBaseProb!).toBeLessThan(0.08);
    expect(cal.overlay.buyback!.offerSizeFraction!).toBeLessThan(0.012);
  });

  it("parses a FRED-style CSV", () => {
    const csv = "DATE,DGS2,DGS10,DGS30\n2025-01-02,4.25,4.57,4.79\n2025-01-03,.,4.60,4.81\n2025-01-06,4.28,4.62,4.85\n";
    const h = parseYieldCsv(csv);
    expect(h.length).toBe(2); // the row with only two valid yields is dropped
    expect(h[0].yields[10]).toBeCloseTo(0.0457, 10);
    expect(h[1].date).toBe("2025-01-06");
  });
});
