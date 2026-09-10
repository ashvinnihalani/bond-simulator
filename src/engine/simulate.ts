import { Clock, yearFrac, type DayNum } from "./clock";
import { RngManager, type Rng } from "./rng";
import { FactorProcess, KEY_TENORS, NsCurve } from "./curve";
import { policyPath } from "./policy";
import { TENORS, type SimConfig, type Tenor } from "./config";
import {
  buildAuctionCalendar,
  Ledger,
  mintBond,
  type AuctionEvent,
} from "./issuance";
import {
  dirtyPriceOnCurve,
  dirtyPricePair,
  parCouponOnCurve,
  riskFromYield,
  roundCoupon,
  yieldFromDirtyPrice,
  accruedInterest,
  type Bond,
} from "./bond";
import { BondRecorder, STATUS_CODES } from "./records";
import { makeAuctionModel } from "./auction";

export interface CurveHistory {
  dates: number[];
  policyRate: Float64Array;
  level: Float64Array;
  slope: Float64Array;
  curvature: Float64Array;
  /** Par yields, row-major [day][keyTenorIndex]. */
  parYields: Float64Array;
  keyTenors: readonly number[];
}

export interface AuctionResult {
  day: DayNum;
  dayIdx: number;
  bondId: string;
  tenor: Tenor;
  isReopen: boolean;
  size: number;
  wiYield: number;
  stopYield: number;
  /** Tail in bp (positive = weak). */
  tailBp: number;
  bidToCover: number;
  dealerShare: number;
  indirectShare: number;
  directShare: number;
  coupon: number;
  /** Supply relative to dealer capacity. */
  supplyToCapacity: number;
}

export interface DailyAggregates {
  totalOutstanding: Float64Array;
  cashBalance: Float64Array;
  billsOutstanding: Float64Array;
  regime: Int8Array;
}

export interface SimResult {
  config: SimConfig;
  seed: number;
  dates: number[];
  curve: CurveHistory;
  ledger: Ledger;
  auctions: AuctionResult[];
  records: BondRecorder;
  daily: DailyAggregates;
}

export function curveAt(h: CurveHistory, cfg: SimConfig, i: number): NsCurve {
  return new NsCurve(
    h.level[i],
    h.slope[i],
    h.curvature[i],
    cfg.curve.lambda,
    cfg.curve.termPremium,
    cfg.curve.minRate,
    cfg.curve.maxRate,
  );
}

export function parYieldAt(h: CurveHistory, i: number, tenor: number): number {
  const k = h.keyTenors.indexOf(tenor);
  if (k < 0) throw new Error(`Tenor ${tenor} is not a key tenor`);
  return h.parYields[i * h.keyTenors.length + k];
}

/** Hook for the auction module (Phase 4). Phase 3 uses the trivial version. */
export interface AuctionModel {
  run(args: {
    bond: Bond;
    event: AuctionEvent;
    wiYield: number;
    dayIdx: number;
    capacityMult: number;
    tailMult: number;
  }): Omit<AuctionResult, "day" | "dayIdx" | "bondId" | "tenor" | "isReopen" | "size" | "coupon">;
}

export const trivialAuctionModel: AuctionModel = {
  run: ({ wiYield, event }) => ({
    wiYield,
    stopYield: wiYield,
    tailBp: 0,
    bidToCover: 2.5,
    dealerShare: 0.15,
    indirectShare: 0.68,
    directShare: 0.17,
    supplyToCapacity: event.size / 60,
  }),
};

/**
 * One simulation path. The daily loop calls each module in a fixed order;
 * modules draw from their own RNG streams.
 */
export class Simulation {
  readonly clock: Clock;
  readonly rng: RngManager;
  readonly n: number;
  readonly policy: Float64Array;
  readonly factors: FactorProcess;
  readonly curve: CurveHistory;
  readonly ledger = new Ledger();
  readonly auctions: AuctionResult[] = [];
  readonly records = new BondRecorder();
  readonly daily: DailyAggregates;
  readonly calendar: AuctionEvent[];
  /** Pending events keyed by day. */
  private readonly byAnnounce = new Map<DayNum, AuctionEvent[]>();
  private readonly byAuction = new Map<DayNum, AuctionEvent[]>();
  private readonly bySettle = new Map<DayNum, AuctionEvent[]>();
  auctionModel: AuctionModel;
  /** Per-day multipliers set by the stress module (Phase 7). */
  volMult = 1;
  capacityMult = 1;
  tailMult = 1;
  richnessMult = 1;
  offerMult = 1;
  regime = 0;
  today: DayNum;
  dayIdx = 0;
  currentCurve: NsCurve;

  constructor(
    public readonly config: SimConfig,
    public readonly seed: number = config.run.seed,
  ) {
    this.clock = new Clock(config.run.startDate, config.run.horizonYears);
    this.rng = new RngManager(seed);
    this.n = this.clock.length;
    this.policy = policyPath(config.curve.policy, this.n);
    this.factors = new FactorProcess(config.curve, this.rng.stream("curve"));
    this.auctionModel = makeAuctionModel(config.auction, this.rng.stream("auction"));
    const nk = KEY_TENORS.length;
    this.curve = {
      dates: this.clock.businessDays,
      policyRate: this.policy,
      level: new Float64Array(this.n),
      slope: new Float64Array(this.n),
      curvature: new Float64Array(this.n),
      parYields: new Float64Array(this.n * nk),
      keyTenors: KEY_TENORS,
    };
    this.daily = {
      totalOutstanding: new Float64Array(this.n),
      cashBalance: new Float64Array(this.n),
      billsOutstanding: new Float64Array(this.n),
      regime: new Int8Array(this.n),
    };
    this.today = this.clock.start;
    this.currentCurve = this.factors.curve();

    // Calendar covers seeded history plus the horizon.
    const histStart = this.clock.start - Math.round(365.25 * config.issuance.seedHistoryYears) - 40;
    this.calendar = buildAuctionCalendar(this.clock, config.issuance, histStart, this.clock.end + 40, this.clock.start);
    for (const ev of this.calendar) {
      if (ev.announce >= this.clock.start) push(this.byAnnounce, ev.announce, ev);
      if (ev.auction >= this.clock.start) push(this.byAuction, ev.auction, ev);
      if (ev.settle >= this.clock.start) push(this.bySettle, ev.settle, ev);
    }
    this.seedHistory();
  }

  /** Create bonds that exist on day 0 from the historical part of the calendar. */
  private seedHistory(): void {
    const start = this.clock.start;
    const rng = this.rng.stream("seed-history");
    const c = this.currentCurve;
    const df = (t: number) => c.discountFactor(t);
    const perTenorNew: Record<Tenor, AuctionEvent[]> = { 2: [], 3: [], 5: [], 7: [], 10: [], 20: [], 30: [] };
    for (const ev of this.calendar) {
      if (ev.auction >= start) continue; // handled in the loop
      if (ev.maturity <= start) continue;
      if (ev.isReopen) {
        const b = this.ledger.get(ev.id);
        if (b) {
          if (ev.settle < start) {
            b.outstanding += ev.size;
            b.issued += ev.size;
            b.reopenings++;
            b.lastReopenDate = ev.settle;
          }
        }
        continue;
      }
      const bond = mintBond(ev);
      // Historical coupon: today's par coupon for the remaining life, plus
      // noise standing in for the historical rate environment.
      const par = parCouponOnCurve(bond, start, df);
      const hist = par + rng.gaussian(0, 0.01);
      bond.coupon = roundCoupon(Math.max(0.00125, hist), this.config.issuance.couponIncrement);
      bond.status = "off-run";
      if (ev.settle < start) {
        bond.outstanding = ev.size;
        bond.issued = ev.size;
      }
      this.ledger.add(bond);
      perTenorNew[ev.tenor].push(ev);
    }
    // Establish the status chain from the most recent new issues per tenor.
    for (const tenor of TENORS) {
      const evs = perTenorNew[tenor].sort((a, b) => a.auction - b.auction);
      for (const ev of evs) this.ledger.promote(this.ledger.get(ev.id)!);
    }
    // Bonds announced before start but auctioned on/after start are WI.
    for (const ev of this.calendar) {
      if (ev.isReopen || ev.announce >= start || ev.auction < start) continue;
      this.ledger.add(mintBond(ev));
    }
    this.ledger.cash.cumIssuance = this.ledger.totalOutstanding();
    this.ledger.cash.balance = 0;
  }

  /** Curve-implied yield of a bond as of a settlement date (spread applied). */
  yieldOnCurve(bond: Bond, settle: DayNum, spread: number): number {
    const c = this.currentCurve;
    const dirty = dirtyPriceOnCurve(bond, settle, (t) => c.discountFactor(t), spread);
    return yieldFromDirtyPrice(bond, settle, dirty);
  }

  /** Run the whole horizon. */
  run(): SimResult {
    for (let i = 0; i < this.n; i++) this.step(i);
    return this.result();
  }

  result(): SimResult {
    return {
      config: this.config,
      seed: this.seed,
      dates: this.clock.businessDays,
      curve: this.curve,
      ledger: this.ledger,
      auctions: this.auctions,
      records: this.records,
      daily: this.daily,
    };
  }

  /** Module hooks filled in by later phases. */
  preCurveHooks: Array<(sim: Simulation) => void> = [];
  postIssuanceHooks: Array<(sim: Simulation) => void> = [];
  preRecordHooks: Array<(sim: Simulation) => void> = [];

  step(i: number): void {
    this.dayIdx = i;
    this.today = this.clock.businessDays[i];
    for (const h of this.preCurveHooks) h(this);

    // 1. Curve
    this.factors.step(this.policy[i], this.volMult);
    this.currentCurve = this.factors.curve();
    this.curve.level[i] = this.factors.L;
    this.curve.slope[i] = this.factors.S;
    this.curve.curvature[i] = this.factors.C;
    const nk = KEY_TENORS.length;
    for (let k = 0; k < nk; k++) this.curve.parYields[i * nk + k] = this.currentCurve.parYield(KEY_TENORS[k]);

    // 2. Issuance lifecycle
    this.processAnnouncements();
    this.processAuctions();
    this.processSettlements();
    this.processCouponsAndMaturities();
    this.decayShocks();
    for (const h of this.postIssuanceHooks) h(this);

    for (const h of this.preRecordHooks) h(this);

    // 3. Record
    this.daily.totalOutstanding[i] = this.ledger.totalOutstanding();
    this.daily.cashBalance[i] = this.ledger.cash.balance;
    this.daily.billsOutstanding[i] = this.ledger.cash.billsOutstanding;
    this.daily.regime[i] = this.regime;
    const every = this.config.run.recordEveryDays;
    if (every > 0 && (i % every === 0 || i === this.n - 1)) this.recordDay();
  }

  private processAnnouncements(): void {
    const evs = this.byAnnounce.get(this.today);
    if (!evs) return;
    for (const ev of evs) {
      if (!ev.isReopen) {
        if (!this.ledger.get(ev.id)) this.ledger.add(mintBond(ev));
      }
      this.ledger.events.push({ day: this.today, kind: "announce", bondId: ev.id, tenor: ev.tenor, amount: ev.size });
    }
  }

  private processAuctions(): void {
    const evs = this.byAuction.get(this.today);
    if (!evs) return;
    for (const ev of evs) {
      const bond = this.ledger.get(ev.id);
      if (!bond) continue;
      // WI yield: the bond's curve-implied yield at settlement, including its
      // current idiosyncratic spread (set by the liquidity module).
      const wiYield = this.yieldOnCurve(bond, ev.settle, this.effectiveSpread(bond));
      const res = this.auctionModel.run({
        bond,
        event: ev,
        wiYield,
        dayIdx: this.dayIdx,
        capacityMult: this.capacityMult,
        tailMult: this.tailMult,
      });
      let coupon = bond.coupon;
      if (!ev.isReopen) {
        coupon = roundCoupon(Math.max(0.00125, res.stopYield), this.config.issuance.couponIncrement);
        bond.coupon = coupon;
        this.ledger.promote(bond);
      } else {
        bond.reopenings++;
        bond.lastReopenDate = this.today;
      }
      // A tail passes through to the bond's spread as a decaying shock.
      const tailShock = (res.tailBp / 1e4) * this.config.auction.tailPassThrough;
      bond.auctionShock += tailShock;
      const result: AuctionResult = {
        day: this.today,
        dayIdx: this.dayIdx,
        bondId: ev.id,
        tenor: ev.tenor,
        isReopen: ev.isReopen,
        size: ev.size,
        coupon,
        ...res,
      };
      this.auctions.push(result);
      this.ledger.events.push({
        day: this.today,
        kind: ev.isReopen ? "reopen" : "auction",
        bondId: ev.id,
        tenor: ev.tenor,
        amount: ev.size,
        detail: { tailBp: res.tailBp, bidToCover: res.bidToCover, stopYield: res.stopYield },
      });
    }
  }

  private processSettlements(): void {
    const evs = this.bySettle.get(this.today);
    if (!evs) return;
    for (const ev of evs) {
      const bond = this.ledger.get(ev.id);
      if (!bond) continue;
      const c = this.currentCurve;
      const dirty = dirtyPriceOnCurve(bond, this.today, (t) => c.discountFactor(t), this.effectiveSpread(bond));
      const proceeds = (ev.size * dirty) / 100;
      bond.outstanding += ev.size;
      bond.issued += ev.size;
      this.ledger.cash.balance += proceeds;
      this.ledger.cash.cumIssuance += ev.size;
      this.ledger.events.push({ day: this.today, kind: "settle", bondId: ev.id, tenor: ev.tenor, amount: ev.size });
    }
  }

  private processCouponsAndMaturities(): void {
    const prev = this.clock.businessDays[this.dayIdx - 1] ?? this.today - 1;
    for (const b of this.ledger.bonds) {
      if (b.status === "retired" || b.status === "WI" || b.outstanding <= 0) continue;
      // Coupons whose payment date fell in (prev, today] are paid today.
      for (const d of b.couponDates) {
        if (d > prev && d <= this.today) {
          const c = (b.outstanding * b.coupon) / 2;
          this.ledger.cash.balance -= c;
          this.ledger.cash.cumCoupons += c;
        }
      }
      if (b.maturityDate <= this.today) {
        this.ledger.cash.balance -= b.outstanding;
        this.ledger.cash.cumMaturities += b.outstanding;
        this.ledger.events.push({ day: this.today, kind: "mature", bondId: b.id, tenor: b.tenor, amount: b.outstanding });
        b.outstanding = 0;
        b.status = "retired";
        const chain = this.ledger.chain[b.tenor];
        const k = chain.indexOf(b.id);
        if (k >= 0) chain.splice(k, 1);
      }
    }
  }

  /** Transient shocks decay geometrically each business day. */
  private decayShocks(): void {
    const a = this.config.auction.tailShockDecay;
    const s = this.config.buyback.spilloverDecay;
    for (const b of this.ledger.bonds) {
      if (b.status === "retired") continue;
      if (b.auctionShock !== 0) {
        b.auctionShock *= a;
        if (Math.abs(b.auctionShock) < 1e-9) b.auctionShock = 0;
      }
      if (b.spilloverShock !== 0) {
        b.spilloverShock *= s;
        if (Math.abs(b.spilloverShock) < 1e-9) b.spilloverShock = 0;
      }
    }
  }

  /** Total spread used for pricing: idiosyncratic + transient shocks. */
  effectiveSpread(bond: Bond): number {
    return bond.spread + bond.auctionShock + bond.spilloverShock + bond.noiseState;
  }

  private recordDay(): void {
    this.records.beginDay(this.dayIdx);
    const c = this.currentCurve;
    const df = (t: number) => c.discountFactor(t);
    for (let k = 0; k < this.ledger.bonds.length; k++) {
      const b = this.ledger.bonds[k];
      if (b.status === "retired") continue;
      if (b.status === "WI" && b.coupon === 0) {
        // WI trades on yield; use the par coupon as a stand-in for pricing.
        const par = parCouponOnCurve(b, Math.max(this.today, b.issueDate), df);
        b.coupon = par;
        this.recordBond(k, b, df);
        b.coupon = 0;
        continue;
      }
      this.recordBond(k, b, df);
    }
  }

  private recordBond(k: number, b: Bond, df: (t: number) => number): void {
    const settle = Math.max(this.today, b.issueDate);
    const spread = this.effectiveSpread(b);
    const [fittedDirty, dirty] = dirtyPricePair(b, settle, df, spread);
    const fittedYtm = yieldFromDirtyPrice(b, settle, fittedDirty, b.coupon > 0 ? b.coupon : undefined);
    const ytm = yieldFromDirtyPrice(b, settle, dirty, fittedYtm + spread);
    const risk = riskFromYield(b, settle, ytm);
    this.records.push({
      dayIdx: this.dayIdx,
      bondIdx: k,
      status: STATUS_CODES[b.status],
      remYears: yearFrac(this.today, b.maturityDate),
      ytm,
      fittedYtm,
      spread: ytm - fittedYtm,
      cleanPrice: dirty - accruedInterest(b, settle),
      outstanding: b.outstanding,
      dv01: risk.dv01,
      modDuration: risk.modDuration,
      repoSpecialness: this.repoSpecialness(b),
    });
  }

  /** Overridden by the liquidity module (Phase 5). */
  repoSpecialness(_bond: Bond): number {
    return 0;
  }

  streamFor(name: string): Rng {
    return this.rng.stream(name);
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

/** Convenience wrapper: build and run one path. */
export function simulate(config: SimConfig, seed: number = config.run.seed): SimResult {
  return new Simulation(config, seed).run();
}
