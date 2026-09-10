/**
 * Auction calendar, CUSIP lifecycle and the Treasury ledger.
 */

import {
  addYears,
  monthOf,
  toDayNum,
  yearOf,
  type Clock,
  type DayNum,
} from "./clock";
import { TENORS, type IssuanceConfig, type Tenor } from "./config";
import { makeBond, type Bond, type BondStatus } from "./bond";

export interface AuctionEvent {
  tenor: Tenor;
  announce: DayNum;
  auction: DayNum;
  /** Settlement (cash) date — next business day on or after the dated date. */
  settle: DayNum;
  /** Dated / issue date used for accrual (15th or month-end). */
  dated: DayNum;
  maturity: DayNum;
  isReopen: boolean;
  /** Auction size ($bn). */
  size: number;
  /** CUSIP id: the new issue's id, shared by its reopenings. */
  id: string;
}

interface Rule {
  /** nth occurrence of the weekday in the month. */
  week: number;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  settle: "mid" | "eom";
  /** Months with a new issue; null = every month. */
  newIssueMonths: number[] | null;
}

/** Approximation of the Treasury's regular auction pattern. */
export const AUCTION_RULES: Record<Tenor, Rule> = {
  2: { week: 4, weekday: 2, settle: "eom", newIssueMonths: null },
  3: { week: 2, weekday: 2, settle: "mid", newIssueMonths: null },
  5: { week: 4, weekday: 3, settle: "eom", newIssueMonths: null },
  7: { week: 4, weekday: 4, settle: "eom", newIssueMonths: null },
  10: { week: 2, weekday: 3, settle: "mid", newIssueMonths: [2, 5, 8, 11] },
  20: { week: 3, weekday: 3, settle: "eom", newIssueMonths: [2, 5, 8, 11] },
  30: { week: 2, weekday: 4, settle: "mid", newIssueMonths: [2, 5, 8, 11] },
};

function nthWeekday(y: number, m: number, wd: number, nth: number): DayNum {
  const first = toDayNum(y, m, 1);
  const w = ((first % 7) + 11) % 7;
  return first + ((wd - w + 7) % 7) + 7 * (nth - 1);
}

export function bondId(tenor: Tenor, dated: DayNum): string {
  const y = yearOf(dated);
  const m = String(monthOf(dated)).padStart(2, "0");
  return `T${tenor}Y-${y}-${m}`;
}

/**
 * Build all auction events with dated dates in [fromDay, toDay). Sizes grow by
 * `sizeGrowthPerRefunding` at each refunding date after `growthFrom`.
 */
export function buildAuctionCalendar(
  clock: Clock,
  cfg: IssuanceConfig,
  fromDay: DayNum,
  toDay: DayNum,
  growthFrom: DayNum,
): AuctionEvent[] {
  const events: AuctionEvent[] = [];
  const refundings = clock.refundingDates();
  const growthFactor = (d: DayNum): number => {
    if (cfg.sizeGrowthPerRefunding === 0) return 1;
    let k = 0;
    for (const r of refundings) if (r > growthFrom && r <= d) k++;
    return Math.pow(1 + cfg.sizeGrowthPerRefunding, k);
  };

  const y0 = yearOf(fromDay);
  const y1 = yearOf(toDay);
  const lastNewIssue: Partial<Record<Tenor, string>> = {};

  for (let y = y0 - 1; y <= y1; y++) {
    for (let m = 1; m <= 12; m++) {
      for (const tenor of TENORS) {
        const rule = AUCTION_RULES[tenor];
        const dated = rule.settle === "mid" ? toDayNum(y, m, 15) : toDayNum(y, m + 1, 0);
        const isReopen = rule.newIssueMonths !== null && !rule.newIssueMonths.includes(m);
        let auction = clock.nextBusinessDay(nthWeekday(y, m, rule.weekday, rule.week));
        const settle = clock.nextBusinessDay(dated);
        if (auction >= settle) auction = clock.prevBusinessDay(settle - 1);
        const announce = clock.addBusinessDays(auction, -cfg.wiWindowDays);
        const id = isReopen ? lastNewIssue[tenor] : bondId(tenor, dated);
        if (!isReopen) lastNewIssue[tenor] = id;
        if (dated < fromDay || dated >= toDay) continue;
        if (isReopen && !id) continue; // reopening before any seeded new issue
        const base = isReopen ? cfg.reopenSize[tenor] : cfg.newIssueSize[tenor];
        if (base <= 0) continue;
        events.push({
          tenor,
          announce,
          auction,
          settle,
          dated,
          maturity: addYears(dated, tenor),
          isReopen,
          size: base * growthFactor(auction),
          id: id as string,
        });
      }
    }
  }
  events.sort((a, b) => a.auction - b.auction || a.tenor - b.tenor);
  return events;
}

export interface TreasuryCash {
  /** Cumulative net cash position ($bn): proceeds in, redemptions and coupons out. */
  balance: number;
  cumIssuance: number;
  cumMaturities: number;
  cumCoupons: number;
  cumBuybacks: number;
  /** Bills outstanding used as a funding balance ($bn). */
  billsOutstanding: number;
}

export interface LedgerEvent {
  day: DayNum;
  kind: "announce" | "auction" | "reopen" | "settle" | "mature" | "buyback";
  bondId: string;
  tenor: Tenor;
  amount: number;
  detail?: Record<string, number>;
}

/** All outstanding and historical CUSIPs plus the status chain per tenor. */
export class Ledger {
  readonly bonds: Bond[] = [];
  private readonly byId = new Map<string, number>();
  /** Status chain per tenor: [OTR, old, double-old] ids. */
  readonly chain: Record<Tenor, string[]> = { 2: [], 3: [], 5: [], 7: [], 10: [], 20: [], 30: [] };
  readonly cash: TreasuryCash = {
    balance: 0,
    cumIssuance: 0,
    cumMaturities: 0,
    cumCoupons: 0,
    cumBuybacks: 0,
    billsOutstanding: 0,
  };
  readonly events: LedgerEvent[] = [];

  add(bond: Bond): number {
    const idx = this.bonds.length;
    this.bonds.push(bond);
    this.byId.set(bond.id, idx);
    return idx;
  }

  get(id: string): Bond | undefined {
    const i = this.byId.get(id);
    return i === undefined ? undefined : this.bonds[i];
  }

  index(id: string): number {
    return this.byId.get(id) ?? -1;
  }

  /** Promote a newly auctioned bond to OTR and age the chain. */
  promote(bond: Bond): void {
    const c = this.chain[bond.tenor];
    c.unshift(bond.id);
    const statuses: BondStatus[] = ["OTR", "old", "double-old"];
    for (let k = 0; k < c.length; k++) {
      const b = this.get(c[k])!;
      if (b.status === "retired") continue;
      b.status = k < 3 ? statuses[k] : "off-run";
    }
    while (c.length > 3) c.pop();
  }

  otr(tenor: Tenor): Bond | undefined {
    const id = this.chain[tenor][0];
    return id ? this.get(id) : undefined;
  }

  /** Live (non-retired, non-WI) bonds. */
  outstanding(): Bond[] {
    return this.bonds.filter((b) => b.status !== "retired" && b.status !== "WI");
  }

  totalOutstanding(): number {
    let s = 0;
    for (const b of this.bonds) if (b.status !== "retired") s += b.outstanding;
    return s;
  }
}

/** Assign a remaining-maturity bucket index, or -1 if none matches. */
export function bucketIndex(remYears: number, buckets: Array<{ lo: number; hi: number }>): number {
  for (let i = 0; i < buckets.length; i++) {
    if (remYears >= buckets[i].lo && remYears < buckets[i].hi) return i;
  }
  return -1;
}

/** Create the WI shell for a new-issue event. */
export function mintBond(ev: AuctionEvent): Bond {
  return makeBond({
    id: ev.id,
    tenor: ev.tenor,
    announceDate: ev.announce,
    auctionDate: ev.auction,
    issueDate: ev.dated,
    maturityDate: ev.maturity,
    status: "WI",
  });
}
