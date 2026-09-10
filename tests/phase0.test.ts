import { describe, it, expect } from "vitest";
import {
  Clock,
  RngManager,
  Rng,
  cholesky,
  makeConfig,
  simulate,
  toDayNum,
  isoFromDayNum,
  weekday,
  usBondMarketHolidays,
  addMonths,
  yearOf,
} from "../src/engine";

describe("Phase 0 — scaffolding", () => {
  it("simulate(config, seed=1) twice produces identical output", () => {
    const cfg = makeConfig({ run: { horizonYears: 1 } });
    const a = simulate(cfg, 1);
    const b = simulate(cfg, 1);
    expect(Array.from(a.policyRate)).toEqual(Array.from(b.policyRate));
    expect(a.dates).toEqual(b.dates);
    const c = simulate(cfg, 2);
    expect(Array.from(c.policyRate)).not.toEqual(Array.from(a.policyRate));
  });

  it("named substreams are independent of each other", () => {
    const m1 = new RngManager(7);
    const m2 = new RngManager(7);
    m2.stream("other").normal(); // consuming another stream must not affect "a"
    expect(m1.stream("a").uniform()).toBe(m2.stream("a").uniform());
  });

  it("rng normal has ~zero mean and unit variance", () => {
    const r = new Rng(123);
    let s = 0;
    let s2 = 0;
    const n = 200_000;
    for (let i = 0; i < n; i++) {
      const x = r.normal();
      s += x;
      s2 += x * x;
    }
    expect(Math.abs(s / n)).toBeLessThan(0.01);
    expect(Math.abs(s2 / n - 1)).toBeLessThan(0.02);
  });

  it("cholesky reproduces the matrix", () => {
    const a = [
      [1, -0.4, 0.1],
      [-0.4, 1, 0.25],
      [0.1, 0.25, 1],
    ];
    const L = cholesky(a);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += L[i][k] * L[j][k];
        expect(s).toBeCloseTo(a[i][j], 12);
      }
  });

  it("weekday and date helpers are correct", () => {
    expect(weekday(toDayNum(1970, 1, 1))).toBe(4); // Thursday
    expect(weekday(toDayNum(2026, 1, 2))).toBe(5); // Friday
    expect(isoFromDayNum(toDayNum(2026, 3, 15))).toBe("2026-03-15");
    expect(isoFromDayNum(addMonths(toDayNum(2026, 1, 31), 1))).toBe("2026-02-28");
    expect(isoFromDayNum(addMonths(toDayNum(2024, 1, 31), 1))).toBe("2024-02-29");
  });

  it("holidays match known dates", () => {
    const h = usBondMarketHolidays(2026).map(isoFromDayNum);
    expect(h).toContain("2026-01-01");
    expect(h).toContain("2026-01-19"); // MLK
    expect(h).toContain("2026-02-16"); // Presidents
    expect(h).toContain("2026-04-03"); // Good Friday
    expect(h).toContain("2026-05-25"); // Memorial
    expect(h).toContain("2026-06-19");
    expect(h).toContain("2026-07-03"); // July 4 observed (Saturday)
    expect(h).toContain("2026-09-07"); // Labor
    expect(h).toContain("2026-10-12"); // Columbus
    expect(h).toContain("2026-11-11");
    expect(h).toContain("2026-11-26"); // Thanksgiving
    expect(h).toContain("2026-12-25");
    const h27 = usBondMarketHolidays(2027).map(isoFromDayNum);
    expect(h27).toContain("2027-03-26"); // Good Friday 2027
  });

  it("calendar skips weekends and holidays over a 10-year horizon", () => {
    const clock = new Clock("2026-01-02", 10);
    expect(clock.length).toBeGreaterThan(2450);
    expect(clock.length).toBeLessThan(2530);
    for (const d of clock.businessDays) {
      expect(weekday(d)).not.toBe(0);
      expect(weekday(d)).not.toBe(6);
      expect(clock.isHoliday(d)).toBe(false);
    }
    // Every year in the horizon has roughly 250-253 business days.
    const byYear = new Map<number, number>();
    for (const d of clock.businessDays) byYear.set(yearOf(d), (byYear.get(yearOf(d)) ?? 0) + 1);
    for (const [y, n] of byYear) {
      if (y === 2026 || y === 2036) continue; // partial edge years
      expect(n).toBeGreaterThanOrEqual(247);
      expect(n).toBeLessThanOrEqual(254);
    }
    expect(clock.isBusinessDay(toDayNum(2026, 12, 25))).toBe(false);
    expect(clock.nextBusinessDay(toDayNum(2026, 12, 25))).toBe(toDayNum(2026, 12, 28));
  });

  it("refunding dates fall in Feb/May/Aug/Nov", () => {
    const clock = new Clock("2026-01-02", 2);
    const dates = clock.refundingDates().map(isoFromDayNum);
    expect(dates).toEqual([
      "2026-02-04",
      "2026-05-06",
      "2026-08-05",
      "2026-11-04",
      "2027-02-03",
      "2027-05-05",
      "2027-08-04",
      "2027-11-03",
    ]);
  });

  it("makeConfig deep-merges overrides", () => {
    const c = makeConfig({ curve: { lambda: 2.5 }, issuance: { newIssueSize: { 10: 45 } as never } });
    expect(c.curve.lambda).toBe(2.5);
    expect(c.curve.termPremium).toBe(0.002);
    expect(c.issuance.newIssueSize[10]).toBe(45);
    expect(c.issuance.newIssueSize[2]).toBe(69);
  });
});
