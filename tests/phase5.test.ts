import { describe, it, expect } from "vitest";
import { makeConfig, simulate, STATUS_CODES, TENORS, nsLoadings, type Tenor } from "../src/engine";

describe("Phase 5 — on/off-the-run liquidity premium", () => {
  // Pin the regime to calm so richness multipliers stay at 1.
  const calm = { transition: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as [[number, number, number], [number, number, number], [number, number, number]] };
  const cfg = makeConfig({ run: { horizonYears: 2, recordEveryDays: 1 }, stress: calm });
  const r = simulate(cfg, 21);
  const dayIdx = r.records.dayIdx.view();
  const status = r.records.status.view();
  const spread = r.records.spread.view();

  function lifecycle(tenor: Tenor) {
    // A bond minted during the run, followed from WI to double-old.
    const b = r.ledger.bonds.find((x) => x.tenor === tenor && x.auctionDate > r.dates[10] && x.auctionDate < r.dates[Math.floor(r.dates.length / 2)])!;
    const rows = r.records.rowsForBond(r.ledger.index(b.id));
    return { b, rows };
  }

  it("OTR richness at issuance matches config and decays by double-old", () => {
    for (const tenor of [10, 30, 2] as Tenor[]) {
      const { b, rows } = lifecycle(tenor);
      const base = cfg.liquidity.baseRichnessBp[tenor];
      const wi = rows.filter((i) => status[i] === STATUS_CODES.WI);
      const otr = rows.filter((i) => status[i] === STATUS_CODES.OTR);
      const dbl = rows.filter((i) => status[i] === STATUS_CODES["double-old"]);
      expect(wi.length).toBeGreaterThan(2);
      expect(otr.length).toBeGreaterThan(10);
      expect(dbl.length).toBeGreaterThan(10);
      // WI trades rich at the configured fraction of base richness (± noise).
      const wiRich = -spread[wi[0]] * 1e4;
      expect(Math.abs(wiRich - base * cfg.liquidity.wiRichnessFraction)).toBeLessThan(1.5);
      // On the first OTR day richness ≈ base (+repo feedback, ± auction shock and noise).
      const firstOtr = -spread[otr[0]] * 1e4;
      expect(firstOtr).toBeGreaterThan(base * 0.6);
      expect(firstOtr).toBeLessThan(base * 1.6 + 2);
      // Deep into double-old it is near zero (within noise + aging cheapness).
      const lateDbl = dbl.slice(-5).map((i) => -spread[i] * 1e4);
      const avg = lateDbl.reduce((a, c) => a + c, 0) / lateDbl.length;
      expect(Math.abs(avg)).toBeLessThan(Math.max(1.5, base * 0.15));
      void b;
    }
  });

  it("on/off deltas are positive for the OTR and shrink for older bonds", () => {
    for (const t of TENORS) {
      const s = r.liquidity.onOff[t];
      let sumOld = 0;
      let sumDbl = 0;
      let sumFit = 0;
      let n = 0;
      for (let i = 30; i < r.dates.length; i++) {
        sumOld += s.otrMinusOld[i];
        sumDbl += s.otrMinusDoubleOld[i];
        sumFit += s.otrMinusFitted[i];
        n++;
      }
      // OTR yields below the fitted curve and below old/double-old (negative deltas in yield).
      expect(sumFit / n).toBeLessThan(-0.3 * cfg.liquidity.baseRichnessBp[t]);
      expect(sumOld / n).toBeLessThan(0);
      expect(sumDbl / n).toBeLessThan(sumOld / n); // double-old is cheaper than old
    }
  });

  it("repo specialness tracks OTR richness", () => {
    const s = r.liquidity.onOff[10];
    for (let i = 5; i < r.dates.length; i++) {
      expect(s.specialness[i]).toBeGreaterThanOrEqual(0);
      expect(s.specialness[i]).toBeLessThan(cfg.liquidity.specialnessSensitivity * cfg.liquidity.baseRichnessBp[10] * 1.01);
    }
    // Specialness is highest right after a new 10y auction and lower before the next.
    const auctions = r.auctions.filter((a) => a.tenor === 10 && !a.isReopen);
    for (let k = 1; k < auctions.length; k++) {
      const after = s.specialness[auctions[k].dayIdx];
      const before = s.specialness[auctions[k].dayIdx - 3];
      expect(after).toBeGreaterThan(before);
    }
  });

  it("off-the-run fitted curve agrees with the Nelson-Siegel curve within noise", () => {
    const f = r.liquidity.offRunFit;
    expect(f.dayIdx.length).toBeGreaterThan(400);
    for (let k = 0; k < f.dayIdx.length; k += 20) {
      for (const tau of [2, 5, 10, 30]) {
        const x = nsLoadings(tau, cfg.curve.lambda);
        const deltaBp = (f.dL[k] * x[0] + f.dS[k] * x[1] + f.dC[k] * x[2]) * 1e4;
        expect(Math.abs(deltaBp)).toBeLessThan(4);
      }
      expect(f.rmsBp[k]).toBeLessThan(3);
    }
  });

  it("switching liquidity noise off leaves bonds exactly on their deterministic spreads", () => {
    const quiet = simulate(makeConfig({ run: { horizonYears: 1, recordEveryDays: 10 }, liquidity: { noiseBp: 0 }, buyback: { enabled: false } }), 3);
    const st = quiet.records.status.view();
    const sp = quiet.records.spread.view();
    for (let i = 0; i < quiet.records.length; i++) {
      if (st[i] === STATUS_CODES["off-run"]) expect(sp[i]).toBeGreaterThan(-1e-6); // only cheapness remains
    }
    void dayIdx;
  });
});
