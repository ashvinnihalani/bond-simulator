/**
 * Columnar recorder for daily bond-level data. Rows are appended per
 * (day, bond) and stored in growable typed arrays to keep memory compact.
 */

import type { BondStatus } from "./bond";

export const STATUS_CODES: Record<BondStatus, number> = {
  WI: 0,
  OTR: 1,
  old: 2,
  "double-old": 3,
  "off-run": 4,
  retired: 5,
};
export const STATUS_NAMES: BondStatus[] = ["WI", "OTR", "old", "double-old", "off-run", "retired"];

class GrowableF64 {
  buf = new Float64Array(1024);
  n = 0;
  push(v: number): void {
    if (this.n === this.buf.length) {
      const nb = new Float64Array(this.buf.length * 2);
      nb.set(this.buf);
      this.buf = nb;
    }
    this.buf[this.n++] = v;
  }
  view(): Float64Array {
    return this.buf.subarray(0, this.n);
  }
}

class GrowableI32 {
  buf = new Int32Array(1024);
  n = 0;
  push(v: number): void {
    if (this.n === this.buf.length) {
      const nb = new Int32Array(this.buf.length * 2);
      nb.set(this.buf);
      this.buf = nb;
    }
    this.buf[this.n++] = v;
  }
  view(): Int32Array {
    return this.buf.subarray(0, this.n);
  }
}

export interface BondRow {
  dayIdx: number;
  bondIdx: number;
  status: number;
  remYears: number;
  ytm: number;
  fittedYtm: number;
  spread: number;
  cleanPrice: number;
  outstanding: number;
  dv01: number;
  modDuration: number;
  repoSpecialness: number;
}

export class BondRecorder {
  readonly dayIdx = new GrowableI32();
  readonly bondIdx = new GrowableI32();
  readonly status = new GrowableI32();
  readonly remYears = new GrowableF64();
  readonly ytm = new GrowableF64();
  readonly fittedYtm = new GrowableF64();
  readonly spread = new GrowableF64();
  readonly cleanPrice = new GrowableF64();
  readonly outstanding = new GrowableF64();
  readonly dv01 = new GrowableF64();
  readonly modDuration = new GrowableF64();
  readonly repoSpecialness = new GrowableF64();
  /** Start row index of each recorded day, keyed by day index. */
  readonly dayStart = new Map<number, number>();
  readonly recordedDays: number[] = [];

  beginDay(dayIdx: number): void {
    this.dayStart.set(dayIdx, this.dayIdx.n);
    this.recordedDays.push(dayIdx);
  }

  push(r: BondRow): void {
    this.dayIdx.push(r.dayIdx);
    this.bondIdx.push(r.bondIdx);
    this.status.push(r.status);
    this.remYears.push(r.remYears);
    this.ytm.push(r.ytm);
    this.fittedYtm.push(r.fittedYtm);
    this.spread.push(r.spread);
    this.cleanPrice.push(r.cleanPrice);
    this.outstanding.push(r.outstanding);
    this.dv01.push(r.dv01);
    this.modDuration.push(r.modDuration);
    this.repoSpecialness.push(r.repoSpecialness);
  }

  get length(): number {
    return this.dayIdx.n;
  }

  /** Row range [start, end) for a recorded day. */
  rangeForDay(dayIdx: number): [number, number] {
    const start = this.dayStart.get(dayIdx);
    if (start === undefined) return [0, 0];
    const k = this.recordedDays.indexOf(dayIdx);
    const next = this.recordedDays[k + 1];
    const end = next === undefined ? this.length : this.dayStart.get(next)!;
    return [start, end];
  }

  /** Rows for a single bond across all recorded days. */
  rowsForBond(bondIdx: number): number[] {
    const out: number[] = [];
    const b = this.bondIdx.view();
    for (let i = 0; i < b.length; i++) if (b[i] === bondIdx) out.push(i);
    return out;
  }
}
