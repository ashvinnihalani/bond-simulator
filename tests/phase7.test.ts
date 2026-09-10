import { describe, it, expect } from "vitest";
import { makeConfig, simulate, STATUS_CODES, bucketIndex, type SimResult, type PartialConfig } from "../src/engine";

const calmOnly: PartialConfig["stress"] = {
  transition: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
};
const crisis = { startDay: 300, durationDays: 40, regime: 2 as const };

function mean(xs: ArrayLike<number>, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += xs[i];
  return s / (to - from);
}

/** Daily mean off-the-run spread (bp) in a bucket from the recorder. */
function bucketCheapnessSeries(r: SimResult, bucket: number): Map<number, number> {
  const out = new Map<number, number>();
  const status = r.records.status.view();
  const rem = r.records.remYears.view();
  const spread = r.records.spread.view();
  for (const d of r.records.recordedDays) {
    const [s, e] = r.records.rangeForDay(d);
    let sum = 0;
    let n = 0;
    for (let i = s; i < e; i++) {
      if (status[i] !== STATUS_CODES["off-run"]) continue;
      if (bucketIndex(rem[i], r.config.buyback.buckets) !== bucket) continue;
      sum += spread[i] * 1e4;
      n++;
    }
    if (n) out.set(d, sum / n);
  }
  return out;
}

describe("Phase 7 — stress regimes", () => {
  it("Markov chain visits every regime with the configured persistence", () => {
    const r = simulate(makeConfig({ run: { horizonYears: 10, recordEveryDays: 0 }, buyback: { enabled: false } }), 2);
    const counts = [0, 0, 0];
    let switches = 0;
    for (let i = 0; i < r.dates.length; i++) {
      counts[r.daily.regime[i]]++;
      if (i > 0 && r.daily.regime[i] !== r.daily.regime[i - 1]) switches++;
    }
    expect(counts[0]).toBeGreaterThan(counts[1]);
    expect(counts[1]).toBeGreaterThan(0);
    expect(counts[2]).toBeGreaterThan(0);
    expect(switches).toBeGreaterThan(5);
    expect(switches).toBeLessThan(200);
  });

  it("scripted crisis widens the 10y on/off spread by the configured multiple", () => {
    const base: PartialConfig = { run: { horizonYears: 2, recordEveryDays: 0 }, buyback: { enabled: false } };
    const calm = simulate(makeConfig({ ...base, stress: calmOnly }), 5);
    const stressed = simulate(makeConfig({ ...base, stress: { ...calmOnly, events: [crisis] } }), 5);
    const a = calm.liquidity.onOff[10].otrMinusFitted;
    const b = stressed.liquidity.onOff[10].otrMinusFitted;
    // Identical before the event (same seed, independent streams).
    expect(mean(b, 200, 300)).toBeCloseTo(mean(a, 200, 300), 8);
    const ratio = mean(b, 305, 340) / mean(a, 305, 340);
    const cfgMult = stressed.config.stress.richnessMult[2];
    expect(ratio).toBeGreaterThan(cfgMult * 0.75);
    expect(ratio).toBeLessThan(cfgMult * 1.25);
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(5);
    // Repo specialness scales with it, and auction tails are wider under stress.
    expect(mean(stressed.liquidity.onOff[10].specialness, 305, 340)).toBeGreaterThan(mean(calm.liquidity.onOff[10].specialness, 305, 340) * 2.5);
    const inWindow = (r: SimResult) => r.auctions.filter((x) => x.dayIdx >= 300 && x.dayIdx < 340);
    const absTail = (r: SimResult) => inWindow(r).reduce((s, x) => s + Math.abs(x.tailBp), 0) / inWindow(r).length;
    expect(absTail(stressed)).toBeGreaterThan(absTail(calm));
    // Curve is more volatile during the crisis.
    const dv = (r: SimResult) => {
      let s = 0;
      for (let i = 301; i < 340; i++) s += (r.curve.level[i] - r.curve.level[i - 1]) ** 2;
      return Math.sqrt(s / 39);
    };
    expect(dv(stressed)).toBeGreaterThan(dv(calm) * 1.8);
    // Regime is recorded.
    expect(stressed.daily.regime[310]).toBe(2);
    expect(stressed.daily.regime[299]).toBe(0);
    expect(stressed.daily.regime[340]).toBe(0);
  });

  it("buybacks dampen peak off-the-run widening during a scripted crisis", () => {
    const base: PartialConfig = { run: { horizonYears: 2, recordEveryDays: 1 }, stress: { ...calmOnly, events: [crisis] } };
    const off = simulate(makeConfig({ ...base, buyback: { enabled: false } }), 6);
    const on = simulate(makeConfig({ ...base, buyback: { enabled: true } }), 6);
    let dampened = 0;
    for (const bucket of [2, 3, 4]) {
      const sOff = bucketCheapnessSeries(off, bucket);
      const sOn = bucketCheapnessSeries(on, bucket);
      let peakOff = -Infinity;
      let peakOn = -Infinity;
      for (let d = 300; d < 340; d++) {
        peakOff = Math.max(peakOff, sOff.get(d) ?? -Infinity);
        peakOn = Math.max(peakOn, sOn.get(d) ?? -Infinity);
      }
      if (peakOn < peakOff) dampened++;
    }
    expect(dampened).toBe(3);
    // Offer volume rises in the crisis.
    const ops = on.buyback.operations;
    const inCrisis = ops.filter((o) => o.dayIdx >= 300 && o.dayIdx < 340 && o.kind === "liquidity");
    const calmOps = ops.filter((o) => (o.dayIdx < 300 || o.dayIdx >= 340) && o.kind === "liquidity");
    const avgOffered = (xs: typeof ops) => xs.reduce((s, o) => s + o.offered, 0) / xs.length;
    expect(inCrisis.length).toBeGreaterThan(3);
    expect(avgOffered(inCrisis)).toBeGreaterThan(avgOffered(calmOps) * 1.3);
  });
});
