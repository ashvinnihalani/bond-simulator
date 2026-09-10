/**
 * Builds plain, structured-clone-safe chart data from a SimResult inside the
 * worker, so the main thread only renders.
 */
import {
  acceptanceRates,
  bondSnapshots,
  buybackMetrics,
  curveMetrics,
  isoFromDayNum,
  nsLoadings,
  offRunCheapnessByBucket,
  quantileBands,
  rolldownTracker,
  runBatch,
  STATUS_CODES,
  STATUS_NAMES,
  supplyLadder,
  TENORS,
  simulate,
  type AuctionResult,
  type BuybackMetrics,
  type BuybackOperation,
  type RolldownPoint,
  type SimConfig,
  type SimResult,
  type Tenor,
} from "../engine";

export interface LifecycleSeries {
  id: string;
  tenor: Tenor;
  auctionDayIdx: number;
  reopenDayIdx: number[];
  buybackDayIdx: number[];
  dayIdx: Int32Array;
  spreadBp: Float64Array;
  status: Int32Array;
}

export interface CarryRow {
  id: string;
  tenor: Tenor;
  status: string;
  remYears: number;
  ytmBp: number;
  spreadBp: number;
  carry: number;
  rolldown: number;
  financing: number;
  dv01: number;
}

export interface ChartData {
  meta: { seed: number; nDays: number; dates: string[]; horizonYears: number; buybackEnabled: boolean; keyTenors: number[]; lambda: number; bucketNames: string[] };
  config: SimConfig;
  curve: {
    parYields: Float64Array;
    level: Float64Array;
    slope: Float64Array;
    curvature: Float64Array;
    policyRate: Float64Array;
    twosTens: Float64Array;
    fivesThirties: Float64Array;
    butterfly: Float64Array;
    regime: Int8Array;
  };
  /** OTR points on recorded days: [snapshotIndex][tenorIndex]. */
  otr: { dayIdx: number[]; remYears: Float64Array; ytm: Float64Array; spreadBp: Float64Array };
  onOff: Record<Tenor, { otrMinusOld: Float64Array; otrMinusDoubleOld: Float64Array; otrMinusFitted: Float64Array; specialness: Float64Array }>;
  offRunFit: { dayIdx: number[]; deltaBp: Record<number, number[]>; rmsBp: number[] };
  auctions: AuctionResult[];
  lifecycle: LifecycleSeries[];
  ladder: { dayIdx: number[]; years: number[]; outstanding: Float64Array[]; boughtBack: Float64Array[] };
  buyback: { operations: BuybackOperation[]; metrics: BuybackMetrics; cheapness: { dayIdx: number[]; series: Float64Array[] }; acceptance: number[] };
  compare: { cheapnessOn: Float64Array; cheapnessOff: Float64Array; onOff10On: Float64Array; onOff10Off: Float64Array; meanOn: number; meanOff: number; peakOn: number; peakOff: number } | null;
  rolldown: { bondId: string; candidates: string[]; points: RolldownPoint[] };
  carry: { dayIdx: number; rows: CarryRow[] };
  fans: { seeds: number; qs: number[]; y10: Float64Array[]; onOff10: Float64Array[]; twosTens: Float64Array[] } | null;
  timing: { runMs: number; compareMs: number; fanMs: number };
}

export interface BuildOptions {
  compare: boolean;
  fanSeeds: number;
  rolldownBondId?: string;
  onProgress?: (msg: string, frac: number) => void;
}

function aggregateCheapness(r: SimResult): Float64Array {
  const n = r.dates.length;
  const nb = r.liquidity.nBuckets;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (let k = 1; k <= Math.min(4, nb - 1); k++) {
      const v = r.liquidity.bucketCheapness[i * nb + k];
      if (!Number.isNaN(v)) {
        s += v;
        c++;
      }
    }
    out[i] = c ? s / c : NaN;
  }
  return out;
}

export function buildChartData(r: SimResult, opts: BuildOptions, timing: { runMs: number }): ChartData {
  const cfg = r.config;
  const n = r.dates.length;
  const cm = curveMetrics(r);
  const rec = r.records;
  const bondIdx = rec.bondIdx.view();
  const status = rec.status.view();
  const rem = rec.remYears.view();
  const ytm = rec.ytm.view();
  const spread = rec.spread.view();

  // OTR snapshots on every recorded day.
  const otrDays = rec.recordedDays;
  const otrRem = new Float64Array(otrDays.length * 7).fill(NaN);
  const otrYtm = new Float64Array(otrDays.length * 7).fill(NaN);
  const otrSpread = new Float64Array(otrDays.length * 7).fill(NaN);
  otrDays.forEach((d, di) => {
    const [s, e] = rec.rangeForDay(d);
    for (let i = s; i < e; i++) {
      if (status[i] !== STATUS_CODES.OTR) continue;
      const t = TENORS.indexOf(r.ledger.bonds[bondIdx[i]].tenor);
      otrRem[di * 7 + t] = rem[i];
      otrYtm[di * 7 + t] = ytm[i];
      otrSpread[di * 7 + t] = spread[i] * 1e4;
    }
  });

  // Lifecycle series for bonds minted during the run.
  const lifecycle: LifecycleSeries[] = [];
  const start = r.dates[0];
  const minted = r.ledger.bonds.map((b, k) => ({ b, k })).filter(({ b }) => b.auctionDate >= start);
  const rowsByBond = new Map<number, number[]>();
  for (let i = 0; i < rec.length; i++) {
    const arr = rowsByBond.get(bondIdx[i]);
    if (arr) arr.push(i);
    else rowsByBond.set(bondIdx[i], [i]);
  }
  const dayIdxArr = rec.dayIdx.view();
  const dayIndexOf = (day: number): number => r.dates.indexOf(day);
  for (const { b, k } of minted) {
    const rows = rowsByBond.get(k) ?? [];
    lifecycle.push({
      id: b.id,
      tenor: b.tenor,
      auctionDayIdx: dayIndexOf(b.auctionDate),
      reopenDayIdx: r.ledger.events.filter((e) => e.kind === "reopen" && e.bondId === b.id).map((e) => dayIndexOf(e.day)),
      buybackDayIdx: r.ledger.events.filter((e) => e.kind === "buyback" && e.bondId === b.id).map((e) => dayIndexOf(e.day)),
      dayIdx: Int32Array.from(rows, (i) => dayIdxArr[i]),
      spreadBp: Float64Array.from(rows, (i) => spread[i] * 1e4),
      status: Int32Array.from(rows, (i) => status[i]),
    });
  }

  // Supply ladder at ~24 snapshots.
  const stride = Math.max(1, Math.floor(otrDays.length / 24));
  const ladderDays = otrDays.filter((_, i) => i % stride === 0 || i === otrDays.length - 1);
  const yearSet = new Set<number>();
  const ladders = ladderDays.map((d) => supplyLadder(r, d));
  for (const l of ladders) for (const y of l.years) yearSet.add(y);
  const years = [...yearSet].sort((a, b) => a - b);
  const ladderOut = ladders.map((l) => {
    const out = new Float64Array(years.length);
    l.years.forEach((y, i) => (out[years.indexOf(y)] = l.outstanding[i]));
    return out;
  });
  const ladderBb = ladders.map((l) => {
    const out = new Float64Array(years.length);
    l.years.forEach((y, i) => (out[years.indexOf(y)] = l.boughtBack[i]));
    return out;
  });

  // Off-run curve deltas at key tenors.
  const f = r.liquidity.offRunFit;
  const deltaBp: Record<number, number[]> = {};
  for (const tau of [2, 5, 10, 30]) {
    const x = nsLoadings(tau, cfg.curve.lambda);
    deltaBp[tau] = f.dL.map((_, k) => (f.dL[k] * x[0] + f.dS[k] * x[1] + f.dC[k] * x[2]) * 1e4);
  }

  // Roll-down tracker: a note minted early in the run (5y by default).
  const candidates = minted.filter(({ b }) => b.tenor <= 10).map(({ b }) => b.id);
  const rolldownId = opts.rolldownBondId && candidates.includes(opts.rolldownBondId) ? opts.rolldownBondId : (minted.find(({ b }) => b.tenor === 5)?.b.id ?? candidates[0] ?? "");

  // Carry / roll-down on the last recorded day.
  const lastDay = otrDays[otrDays.length - 1];
  const carryRows: CarryRow[] = bondSnapshots(r, lastDay)
    .filter((s) => s.status !== "WI" && s.outstanding > 0)
    .sort((a, b) => a.remYears - b.remYears)
    .map((s) => ({ id: s.id, tenor: s.tenor, status: s.status, remYears: s.remYears, ytmBp: s.ytm * 1e4, spreadBp: s.spreadBp, carry: s.carry, rolldown: s.rolldown, financing: s.financing, dv01: s.dv01 }));

  // Comparison run with buybacks toggled.
  let compare: ChartData["compare"] = null;
  let compareMs = 0;
  if (opts.compare) {
    opts.onProgress?.("Running comparison (buybacks toggled)…", 0.5);
    const t0 = performance.now();
    const alt = simulate({ ...cfg, run: { ...cfg.run, recordEveryDays: 0 }, buyback: { ...cfg.buyback, enabled: !cfg.buyback.enabled } }, r.seed);
    compareMs = performance.now() - t0;
    const on = cfg.buyback.enabled ? r : alt;
    const off = cfg.buyback.enabled ? alt : r;
    const cOn = aggregateCheapness(on);
    const cOff = aggregateCheapness(off);
    const mean = (a: Float64Array) => {
      const v = Array.from(a).filter((x) => !Number.isNaN(x));
      return v.reduce((p, q) => p + q, 0) / Math.max(1, v.length);
    };
    compare = {
      cheapnessOn: cOn,
      cheapnessOff: cOff,
      meanOn: mean(cOn),
      meanOff: mean(cOff),
      onOff10On: on.liquidity.onOff[10].otrMinusFitted,
      onOff10Off: off.liquidity.onOff[10].otrMinusFitted,
      peakOn: Math.max(...Array.from(cOn).filter((v) => !Number.isNaN(v))),
      peakOff: Math.max(...Array.from(cOff).filter((v) => !Number.isNaN(v))),
    };
  }

  // Fan charts across seeds.
  let fans: ChartData["fans"] = null;
  let fanMs = 0;
  if (opts.fanSeeds > 1) {
    const t0 = performance.now();
    const seeds = Array.from({ length: opts.fanSeeds }, (_, i) => r.seed + i);
    const paths = runBatch(cfg, seeds, (done, total) => opts.onProgress?.(`Fan charts: seed ${done}/${total}`, 0.6 + (0.4 * done) / total));
    const qs = [0.05, 0.25, 0.5, 0.75, 0.95];
    fans = {
      seeds: opts.fanSeeds,
      qs,
      y10: quantileBands(paths.map((p) => p.y10), qs).map((b) => b.values),
      onOff10: quantileBands(paths.map((p) => p.onOff10), qs).map((b) => b.values),
      twosTens: quantileBands(paths.map((p) => p.twosTens), qs).map((b) => b.values),
    };
    fanMs = performance.now() - t0;
  }

  const cheap = offRunCheapnessByBucket(r);
  return {
    meta: {
      seed: r.seed,
      nDays: n,
      dates: r.dates.map(isoFromDayNum),
      horizonYears: cfg.run.horizonYears,
      buybackEnabled: cfg.buyback.enabled,
      keyTenors: [...r.curve.keyTenors],
      lambda: cfg.curve.lambda,
      bucketNames: cfg.buyback.buckets.map((b) => b.name),
    },
    config: cfg,
    curve: {
      parYields: r.curve.parYields,
      level: r.curve.level,
      slope: r.curve.slope,
      curvature: r.curve.curvature,
      policyRate: r.curve.policyRate,
      twosTens: cm.twosTens,
      fivesThirties: cm.fivesThirties,
      butterfly: cm.butterfly,
      regime: r.daily.regime,
    },
    otr: { dayIdx: otrDays, remYears: otrRem, ytm: otrYtm, spreadBp: otrSpread },
    onOff: r.liquidity.onOff,
    offRunFit: { dayIdx: f.dayIdx, deltaBp, rmsBp: f.rmsBp },
    auctions: r.auctions,
    lifecycle,
    ladder: { dayIdx: ladderDays, years, outstanding: ladderOut, boughtBack: ladderBb },
    buyback: { operations: r.buyback.operations, metrics: buybackMetrics(r), cheapness: { dayIdx: cheap.days, series: cheap.series }, acceptance: acceptanceRates(r) },
    compare,
    rolldown: { bondId: rolldownId, candidates, points: rolldownId ? rolldownTracker(r, rolldownId) : [] },
    carry: { dayIdx: lastDay, rows: carryRows },
    fans,
    timing: { runMs: timing.runMs, compareMs, fanMs },
  };
}

/** CSV of daily bond-level data from the recorder. */
export function bondLevelCsv(r: SimResult): string {
  const rec = r.records;
  const bondIdx = rec.bondIdx.view();
  const dayIdx = rec.dayIdx.view();
  const status = rec.status.view();
  const rem = rec.remYears.view();
  const ytm = rec.ytm.view();
  const fitted = rec.fittedYtm.view();
  const clean = rec.cleanPrice.view();
  const out = rec.outstanding.view();
  const dv01 = rec.dv01.view();
  const dur = rec.modDuration.view();
  const spec = rec.repoSpecialness.view();
  const lines = ["date,cusip,tenor,status,coupon,maturity,remaining_years,ytm,fitted_ytm,spread_bp,clean_price,outstanding_bn,dv01,mod_duration,repo_specialness_bp"];
  for (let i = 0; i < rec.length; i++) {
    const b = r.ledger.bonds[bondIdx[i]];
    lines.push(
      [
        isoFromDayNum(r.dates[dayIdx[i]]),
        b.id,
        b.tenor,
        STATUS_NAMES[status[i]],
        b.coupon.toFixed(5),
        isoFromDayNum(b.maturityDate),
        rem[i].toFixed(4),
        ytm[i].toFixed(6),
        fitted[i].toFixed(6),
        ((ytm[i] - fitted[i]) * 1e4).toFixed(3),
        clean[i].toFixed(4),
        out[i].toFixed(3),
        dv01[i].toFixed(5),
        dur[i].toFixed(4),
        spec[i].toFixed(2),
      ].join(","),
    );
  }
  return lines.join("\n");
}
