import { describe, it, expect } from "vitest";
import {
  NsCurve,
  bootstrapDiscountCurve,
  makeConfig,
  simulate,
  parYieldAt,
  policyPath,
  KEY_TENORS,
} from "../src/engine";

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

describe("Phase 1 — curve engine", () => {
  it("Nelson-Siegel reproduces textbook limits", () => {
    const c = new NsCurve(0.05, -0.02, 0.01, 1.8, 0);
    expect(c.zeroRate(1e-6)).toBeCloseTo(0.03, 6); // L + S at the short end
    expect(c.zeroRate(200)).toBeCloseTo(0.05, 3); // L at the long end
    expect(c.discountFactor(0)).toBe(1);
    expect(c.discountFactor(10)).toBeCloseTo(Math.exp(-c.zeroRate(10) * 10), 12);
  });

  it("par yield equals the zero rate on a flat curve (compounding aside)", () => {
    const flat = new NsCurve(0.04, 0, 0, 1.8, 0);
    // Continuous 4% ≈ semi-annual 4.04%.
    expect(flat.parYield(10)).toBeCloseTo(2 * (Math.exp(0.02) - 1), 8);
    expect(flat.parYield(2)).toBeCloseTo(2 * (Math.exp(0.02) - 1), 8);
  });

  it("bootstrapped curve reprices the NS par yields", () => {
    const c = new NsCurve(0.045, -0.012, -0.01, 1.8, 0.002);
    const tenors = [...KEY_TENORS];
    const pars = tenors.map((t) => c.parYield(t));
    const df = bootstrapDiscountCurve(tenors, pars);
    for (let i = 0; i < tenors.length; i++) {
      const tau = tenors[i];
      if (tau <= 0.5) continue;
      const n = Math.ceil(tau * 2 - 1e-9);
      let pv = 0;
      for (let k = 1; k <= n; k++) {
        const t = tau - (n - k) * 0.5;
        const frac = k === 1 ? Math.min(1, t / 0.5) : 1;
        pv += ((frac * pars[i]) / 2) * df(t);
      }
      pv += df(tau);
      expect(pv).toBeCloseTo(1, 9);
      // and the knot discount factors match NS closely
      expect(df(tau)).toBeCloseTo(c.discountFactor(tau), 3);
    }
  });

  it("policy paths follow the scenario", () => {
    const hold = policyPath({ scenario: "hold", initial: 0.04, stepSize: 0, stepEveryDays: 1, numSteps: 0, startAfterDays: 0, custom: [] }, 5);
    expect(Array.from(hold)).toEqual([0.04, 0.04, 0.04, 0.04, 0.04]);
    const hike = policyPath({ scenario: "hike", initial: 0.04, stepSize: 0.0025, stepEveryDays: 2, numSteps: 2, startAfterDays: 1, custom: [] }, 6);
    [0.04, 0.0425, 0.0425, 0.045, 0.045, 0.045].forEach((v, i) => expect(hike[i]).toBeCloseTo(v, 12));
    const custom = policyPath({ scenario: "custom", initial: 0.04, stepSize: 0, stepEveryDays: 1, numSteps: 0, startAfterDays: 0, custom: [[0, 0.05], [2, 0.03]] }, 4);
    expect(Array.from(custom)).toEqual([0.05, 0.05, 0.03, 0.03]);
  });

  it("simulated curves stay within realistic bounds over 10,000+ daily paths", () => {
    // 45 seeds × 1 year ≈ 10,000 daily curves, plus one long 10-year path.
    const cfg = makeConfig({ run: { horizonYears: 1 } });
    let days = 0;
    for (let seed = 1; seed <= 45; seed++) {
      const r = simulate(cfg, seed);
      for (let i = 0; i < r.dates.length; i++) {
        for (const t of KEY_TENORS) {
          const y = parYieldAt(r.curve, i, t);
          expect(y).toBeGreaterThanOrEqual(-0.005);
          expect(y).toBeLessThanOrEqual(0.10);
        }
        days++;
      }
    }
    expect(days).toBeGreaterThan(10_000);
    const long = simulate(makeConfig({ run: { horizonYears: 10 } }), 99);
    for (let i = 0; i < long.dates.length; i++) {
      const y = parYieldAt(long.curve, i, 10);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(0.10);
    }
  });

  it("curve is smooth with positive forwards under normal settings", () => {
    const r = simulate(makeConfig({ run: { horizonYears: 2 } }), 3);
    const cfg = r.config;
    for (let i = 0; i < r.dates.length; i += 25) {
      const c = new NsCurve(r.curve.level[i], r.curve.slope[i], r.curve.curvature[i], cfg.curve.lambda, cfg.curve.termPremium, cfg.curve.minRate, cfg.curve.maxRate);
      for (let t = 0.25; t < 30; t += 0.25) {
        expect(c.forwardRate(t, t + 0.25)).toBeGreaterThan(-0.002);
      }
    }
  });

  it("2s10s spread distribution is in the historical range", () => {
    const spreads: number[] = [];
    for (let seed = 1; seed <= 30; seed++) {
      const r = simulate(makeConfig({ run: { horizonYears: 3 } }), seed);
      for (let i = 0; i < r.dates.length; i += 5) {
        spreads.push((parYieldAt(r.curve, i, 10) - parYieldAt(r.curve, i, 2)) * 1e4);
      }
    }
    expect(quantile(spreads, 0.005)).toBeGreaterThan(-120);
    expect(quantile(spreads, 0.995)).toBeLessThan(320);
    const sd = Math.sqrt(spreads.reduce((a, b) => a + b * b, 0) / spreads.length - (spreads.reduce((a, b) => a + b, 0) / spreads.length) ** 2);
    expect(sd).toBeGreaterThan(20); // it should actually move around
  });

  it("policy hikes flatten the curve via the short-end anchor", () => {
    const hold = simulate(makeConfig({ run: { horizonYears: 2 }, curve: { policy: { scenario: "hold" } } }), 5);
    const hike = simulate(makeConfig({ run: { horizonYears: 2 }, curve: { policy: { scenario: "hike", numSteps: 6, stepSize: 0.0025, stepEveryDays: 42, startAfterDays: 20 } } }), 5);
    const last = hold.dates.length - 1;
    const s2Hold = parYieldAt(hold.curve, last, 2);
    const s2Hike = parYieldAt(hike.curve, last, 2);
    expect(s2Hike - s2Hold).toBeGreaterThan(0.008); // 150bp of hikes lifts the 2y by well over 80bp
    const slopeHold = parYieldAt(hold.curve, last, 10) - parYieldAt(hold.curve, last, 2);
    const slopeHike = parYieldAt(hike.curve, last, 10) - parYieldAt(hike.curve, last, 2);
    expect(slopeHike).toBeLessThan(slopeHold);
  });
});
