/**
 * Treasury buyback program.
 *
 * Liquidity-support operations run per remaining-maturity bucket on a
 * schedule announced at each quarterly refunding; cash-management operations
 * run in the 1mo–2y bucket ahead of tax dates. Each operation is a reverse
 * auction: dealers offer eligible off-the-run CUSIPs, Treasury ranks offers
 * by cheapness to the fitted curve and accepts up to the maximum amount,
 * rejecting anything richer than its reservation spread.
 */

import { dayNumFromISO, yearFrac, yearOf, type DayNum } from "./clock";
import { TENORS, type BuybackBucket, type BuybackConfig, type Tenor } from "./config";
import { dirtyPriceOnCurve, type Bond } from "./bond";
import type { Simulation } from "./simulate";

export type OpKind = "liquidity" | "cash-mgmt";

export interface ScheduledOp {
  day: DayNum;
  bucket: number;
  kind: OpKind;
  maxAmount: number;
  announced: DayNum;
}

export interface AcceptedOffer {
  bondId: string;
  amount: number;
  /** Offer yield spread to the fitted curve (bp, positive = cheap). */
  spreadBp: number;
  price: number;
}

export interface BuybackOperation {
  day: DayNum;
  dayIdx: number;
  bucket: number;
  bucketName: string;
  kind: OpKind;
  maxAmount: number;
  eligible: number;
  nOffers: number;
  offered: number;
  accepted: number;
  nAccepted: number;
  fillRate: number;
  /** Accepted-amount-weighted spread to curve (bp). */
  weightedSpreadBp: number;
  /** Amount-weighted spread of all offers (bp). */
  offeredSpreadBp: number;
  /** Cash paid ($bn). */
  cashPaid: number;
  /** Par value bought minus cash paid: positive = bought below par. */
  parMinusCash: number;
  accepts: AcceptedOffer[];
}

export interface BuybackHistory {
  schedule: ScheduledOp[];
  operations: BuybackOperation[];
  /** Cumulative bought per bucket ($bn). */
  boughtByBucket: number[];
}

/** Tenor whose new issuance funds a bucket (smallest tenor ≥ bucket upper bound). */
export function fundingTenor(bucket: BuybackBucket): Tenor {
  for (const t of TENORS) if (t >= bucket.hi - 1e-9) return t;
  return 30;
}

export class BuybackModule {
  readonly history: BuybackHistory;
  private readonly cfg: BuybackConfig;
  private readonly byDay = new Map<DayNum, ScheduledOp[]>();
  /** Extra coupon issuance owed per tenor ($bn), drawn down by upcoming auctions. */
  readonly pendingCouponFunding: Record<Tenor, number> = { 2: 0, 3: 0, 5: 0, 7: 0, 10: 0, 20: 0, 30: 0 };
  /** Unused cash-management capacity carried forward ($bn). */
  private cashMgmtCarry = 0;
  /** Anticipation state per bucket. */
  private readonly lastEvent: number[];
  private readonly nextOp: Array<ScheduledOp | null>;

  constructor(private readonly sim: Simulation) {
    this.cfg = sim.config.buyback;
    const nb = this.cfg.buckets.length;
    this.history = { schedule: [], operations: [], boughtByBucket: new Array(nb).fill(0) };
    this.lastEvent = new Array(nb).fill(sim.clock.start);
    this.nextOp = new Array(nb).fill(null);
    if (!this.cfg.enabled) return;
    this.buildSchedule();
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Generate the full schedule: one announcement per refunding period. */
  private buildSchedule(): void {
    const clock = this.sim.clock;
    const anchors = [clock.start, ...clock.refundingDates().filter((d) => d > clock.start), clock.end];
    for (let k = 0; k < anchors.length - 1; k++) {
      const from = anchors[k];
      const to = anchors[k + 1];
      const span = to - from;
      // Liquidity-support: ops evenly spaced through the period, staggered by bucket.
      this.cfg.buckets.forEach((b, bi) => {
        const ops = k === 0 && span < 60 ? Math.max(1, Math.round((b.opsPerQuarter * span) / 91)) : b.opsPerQuarter;
        for (let j = 0; j < ops; j++) {
          let day = clock.nextBusinessDay(Math.round(from + ((j + 0.5) / ops) * span));
          day = clock.addBusinessDays(day, bi % 4);
          if (day >= to || day >= clock.end) continue;
          this.addOp({ day, bucket: bi, kind: "liquidity", maxAmount: b.maxPerOp, announced: from });
        }
      });
      // Cash-management: one op in the 1mo–2y bucket 5 business days before each tax date.
      const cmBucket = 0;
      for (const y of [yearOf(from), yearOf(to)]) {
        for (const md of this.cfg.cashMgmtTaxDates) {
          const tax = dayNumFromISO(`${y}-${md}`);
          if (tax < from || tax >= to) continue;
          const day = clock.addBusinessDays(clock.prevBusinessDay(tax), -5);
          if (day < from || day >= clock.end) continue;
          this.addOp({ day, bucket: cmBucket, kind: "cash-mgmt", maxAmount: this.cfg.cashMgmtMaxPerOp, announced: from });
        }
      }
    }
    this.history.schedule.sort((a, b) => a.day - b.day || a.bucket - b.bucket);
  }

  private addOp(op: ScheduledOp): void {
    this.history.schedule.push(op);
    const arr = this.byDay.get(op.day);
    if (arr) arr.push(op);
    else this.byDay.set(op.day, [op]);
  }

  /** Whether a bond may be offered in a bucket today. */
  isEligible(b: Bond, bucket: BuybackBucket): boolean {
    if (b.status === "WI" || b.status === "OTR" || b.status === "retired") return false;
    if (b.outstanding <= 0.01) return false;
    if (b.coupon <= 0) return false;
    const rem = yearFrac(this.sim.today, b.maturityDate);
    if (rem < bucket.lo || rem >= bucket.hi) return false;
    const today = this.sim.today;
    if (b.lastReopenDate !== null && this.sim.clock.addBusinessDays(b.lastReopenDate, this.cfg.recentReopenExclusionDays) > today) return false;
    if (((today - b.issueDate) * 252) / 365.25 < this.cfg.minAgeDays) return false;
    return true;
  }

  /** Daily hook: anticipation ramp, then any operations scheduled today. */
  daily(): void {
    if (!this.cfg.enabled) return;
    this.updateAnticipation();
    const ops = this.byDay.get(this.sim.today);
    if (!ops) return;
    for (const op of ops) this.runOperation(op);
  }

  private updateAnticipation(): void {
    const today = this.sim.today;
    const buckets = this.cfg.buckets;
    // Find the next scheduled op per bucket (schedule is sorted by day).
    for (let bi = 0; bi < buckets.length; bi++) {
      const cur = this.nextOp[bi];
      if (cur && cur.day >= today) continue;
      this.nextOp[bi] = this.history.schedule.find((o) => o.bucket === bi && o.day >= today && o.announced <= today) ?? null;
    }
    const frac = this.cfg.anticipationFraction;
    for (const b of this.sim.ledger.bonds) {
      b.anticipation = 0;
      if (frac === 0 || b.status === "retired") continue;
      for (let bi = 0; bi < buckets.length; bi++) {
        const op = this.nextOp[bi];
        if (!op) continue;
        if (!this.isEligible(b, buckets[bi])) continue;
        const ramp = Math.min(1, Math.max(0, (today - this.lastEvent[bi]) / Math.max(1, op.day - this.lastEvent[bi])));
        const expectedBp = this.cfg.spilloverBpPerBn * op.maxAmount + this.cfg.spreadCompression * Math.max(0, this.sim.effectiveSpread(b) * 1e4) * 0.25;
        b.anticipation = (-frac * expectedBp * ramp) / 1e4;
        break;
      }
    }
  }

  private runOperation(op: ScheduledOp): void {
    const sim = this.sim;
    const rng = sim.streamFor("buyback");
    const bucket = this.cfg.buckets[op.bucket];
    const c = sim.currentCurve;
    const df = (t: number) => c.discountFactor(t);
    let maxAmount = op.maxAmount;
    if (op.kind === "cash-mgmt" && this.cfg.cashMgmtCarryForward) maxAmount += this.cashMgmtCarry;

    interface Offer {
      bond: Bond;
      amount: number;
      spreadBp: number;
      price: number;
    }
    const offers: Offer[] = [];
    let eligible = 0;
    for (const b of sim.ledger.bonds) {
      if (!this.isEligible(b, bucket)) continue;
      eligible++;
      const spreadBp = sim.effectiveSpread(b) * 1e4;
      const p = Math.min(0.95, Math.max(0, this.cfg.offerBaseProb + this.cfg.offerCheapnessSlope * spreadBp) * sim.offerMult);
      // Always draw so the stream is independent of the outcome.
      const u = rng.uniform();
      const z = rng.normal();
      if (u >= p) continue;
      const size = Math.min(
        b.outstanding * this.cfg.perCusipCap,
        b.outstanding * this.cfg.offerSizeFraction * Math.exp(this.cfg.offerSizeSigma * z) * sim.offerMult,
      );
      if (size <= 0.001) continue;
      // Dealers ask for a better price than market: offer yield spread is lower by the markup.
      const offerSpreadBp = spreadBp - this.cfg.offerMarkupBp;
      const price = dirtyPriceOnCurve(b, sim.today, df, offerSpreadBp / 1e4);
      offers.push({ bond: b, amount: size, spreadBp: offerSpreadBp, price });
    }
    // Rank by cheapness (highest spread to curve first).
    offers.sort((a, b) => b.spreadBp - a.spreadBp || a.bond.id.localeCompare(b.bond.id));
    let remaining = maxAmount;
    let offered = 0;
    let offeredSpreadWeighted = 0;
    let accepted = 0;
    let spreadWeighted = 0;
    let cashPaid = 0;
    const accepts: AcceptedOffer[] = [];
    for (const o of offers) {
      offered += o.amount;
      offeredSpreadWeighted += o.amount * o.spreadBp;
      if (remaining <= 1e-9) continue;
      if (o.spreadBp < this.cfg.reservationSpreadBp) continue;
      const amt = Math.min(o.amount, remaining);
      remaining -= amt;
      accepted += amt;
      spreadWeighted += amt * o.spreadBp;
      const cash = (amt * o.price) / 100;
      cashPaid += cash;
      accepts.push({ bondId: o.bond.id, amount: amt, spreadBp: o.spreadBp, price: o.price });
      // Effects on the CUSIP.
      o.bond.outstanding -= amt;
      o.bond.boughtBack += amt;
      const cur = sim.effectiveSpread(o.bond);
      if (cur > 0) o.bond.buybackAdj -= this.cfg.spreadCompression * cur;
      sim.ledger.events.push({ day: sim.today, kind: "buyback", bondId: o.bond.id, tenor: o.bond.tenor, amount: amt, detail: { spreadBp: o.spreadBp, price: o.price } });
    }
    // Spillover richening for the rest of the bucket.
    if (accepted > 0) {
      const shock = (-this.cfg.spilloverBpPerBn * accepted) / 1e4;
      for (const b of sim.ledger.bonds) {
        if (b.status === "retired" || b.status === "WI") continue;
        const rem = yearFrac(sim.today, b.maturityDate);
        if (rem >= bucket.lo && rem < bucket.hi) b.spilloverShock += shock;
      }
    }
    // Funding and cash.
    sim.ledger.cash.balance -= cashPaid;
    sim.ledger.cash.cumBuybacks += accepted;
    if (op.kind === "cash-mgmt") {
      sim.ledger.cash.billsOutstanding -= accepted;
      // Unused capacity carries forward, capped at one operation's base size.
      if (this.cfg.cashMgmtCarryForward) this.cashMgmtCarry = Math.min(this.cfg.cashMgmtMaxPerOp, Math.max(0, maxAmount - accepted));
    } else {
      sim.ledger.cash.billsOutstanding += this.cfg.billFundingShare * accepted;
      this.pendingCouponFunding[fundingTenor(bucket)] += (1 - this.cfg.billFundingShare) * accepted;
    }
    this.history.boughtByBucket[op.bucket] += accepted;
    this.lastEvent[op.bucket] = sim.today;
    this.history.operations.push({
      day: sim.today,
      dayIdx: sim.dayIdx,
      bucket: op.bucket,
      bucketName: bucket.name,
      kind: op.kind,
      maxAmount,
      eligible,
      nOffers: offers.length,
      offered,
      accepted,
      nAccepted: accepts.length,
      fillRate: offered > 0 ? accepted / offered : 0,
      weightedSpreadBp: accepted > 0 ? spreadWeighted / accepted : 0,
      offeredSpreadBp: offered > 0 ? offeredSpreadWeighted / offered : 0,
      cashPaid,
      parMinusCash: accepted - cashPaid,
      accepts,
    });
  }

  /** Extra size to add to an auction of `tenor`, drawing down the funding pool. */
  drawCouponFunding(tenor: Tenor): number {
    if (!this.cfg.enabled) return 0;
    const owed = this.pendingCouponFunding[tenor];
    if (owed <= 1e-9) return 0;
    // Spread over roughly the next three auctions of the tenor.
    const take = Math.min(owed, Math.max(owed / 3, 0.5));
    this.pendingCouponFunding[tenor] -= take;
    return take;
  }
}
