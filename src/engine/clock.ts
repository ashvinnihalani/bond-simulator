/**
 * Business-day calendar for the simulator.
 *
 * Dates are represented as integer "day numbers" (days since 1970-01-01 UTC)
 * to keep arithmetic fast and allocation-free inside the daily loop.
 */

const MS_PER_DAY = 86_400_000;

export type DayNum = number;

export function toDayNum(y: number, m: number, d: number): DayNum {
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

export function fromDayNum(n: DayNum): Date {
  return new Date(n * MS_PER_DAY);
}

export function dayNumFromISO(iso: string): DayNum {
  const [y, m, d] = iso.split("-").map(Number);
  return toDayNum(y, m, d);
}

export function isoFromDayNum(n: DayNum): string {
  return fromDayNum(n).toISOString().slice(0, 10);
}

export function yearOf(n: DayNum): number {
  return fromDayNum(n).getUTCFullYear();
}

export function monthOf(n: DayNum): number {
  return fromDayNum(n).getUTCMonth() + 1;
}

export function dayOfMonth(n: DayNum): number {
  return fromDayNum(n).getUTCDate();
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekday(n: DayNum): number {
  return ((n % 7) + 11) % 7; // 1970-01-01 was a Thursday (4)
}

export function isWeekend(n: DayNum): boolean {
  const w = weekday(n);
  return w === 0 || w === 6;
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInYear(y: number): number {
  return isLeapYear(y) ? 366 : 365;
}

/** Add calendar months, clamping the day of month (e.g. Jan 31 + 1m = Feb 28). */
export function addMonths(n: DayNum, months: number): DayNum {
  const d = fromDayNum(n);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(y, m + 1, 0)); // last day of target month
  const clampedDay = Math.min(day, target.getUTCDate());
  return toDayNum(target.getUTCFullYear(), target.getUTCMonth() + 1, clampedDay);
}

export function addYears(n: DayNum, years: number): DayNum {
  return addMonths(n, 12 * years);
}

/** Year fraction between two day numbers, ACT/365.25 (used for curve tenors). */
export function yearFrac(from: DayNum, to: DayNum): number {
  return (to - from) / 365.25;
}

function nthWeekdayOfMonth(y: number, m: number, wd: number, nth: number): DayNum {
  const first = toDayNum(y, m, 1);
  const offset = (wd - weekday(first) + 7) % 7;
  return first + offset + 7 * (nth - 1);
}

function lastWeekdayOfMonth(y: number, m: number, wd: number): DayNum {
  const last = toDayNum(y, m + 1, 0);
  const offset = (weekday(last) - wd + 7) % 7;
  return last - offset;
}

/** Anonymous Gregorian algorithm for Easter Sunday. */
function easterSunday(y: number): DayNum {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return toDayNum(y, month, day);
}

/** Saturday -> Friday, Sunday -> Monday. */
function observed(n: DayNum): DayNum {
  const w = weekday(n);
  if (w === 6) return n - 1;
  if (w === 0) return n + 1;
  return n;
}

/**
 * US bond-market (SIFMA-style) holidays for a year. Good Friday is included
 * because the Treasury cash market is closed even though it is not a federal
 * holiday.
 */
export function usBondMarketHolidays(y: number): DayNum[] {
  const h: DayNum[] = [
    observed(toDayNum(y, 1, 1)), // New Year's Day
    nthWeekdayOfMonth(y, 1, 1, 3), // MLK Day
    nthWeekdayOfMonth(y, 2, 1, 3), // Presidents' Day
    easterSunday(y) - 2, // Good Friday
    lastWeekdayOfMonth(y, 5, 1), // Memorial Day
    observed(toDayNum(y, 6, 19)), // Juneteenth
    observed(toDayNum(y, 7, 4)), // Independence Day
    nthWeekdayOfMonth(y, 9, 1, 1), // Labor Day
    nthWeekdayOfMonth(y, 10, 1, 2), // Columbus Day
    observed(toDayNum(y, 11, 11)), // Veterans Day
    nthWeekdayOfMonth(y, 11, 4, 4), // Thanksgiving
    observed(toDayNum(y, 12, 25)), // Christmas
  ];
  // New Year's observed on Friday Dec 31 of the previous year rolls into `y-1`;
  // handle the case where next year's Jan 1 is a Saturday.
  if (weekday(toDayNum(y + 1, 1, 1)) === 6) h.push(toDayNum(y, 12, 31));
  return h.filter((d) => yearOf(d) === y).sort((a, b) => a - b);
}

/**
 * Simulation clock. Precomputes the business-day sequence for the horizon,
 * exposes quarter/refunding boundaries and tenor arithmetic.
 */
export class Clock {
  readonly start: DayNum;
  readonly end: DayNum;
  readonly businessDays: DayNum[];
  private readonly holidaySet: Set<DayNum>;
  private readonly bdIndex: Map<DayNum, number>;

  constructor(startISO: string, horizonYears: number) {
    this.start = dayNumFromISO(startISO);
    this.end = addYears(this.start, horizonYears);
    this.holidaySet = new Set<DayNum>();
    // Include a margin of years on either side so bond maturity dates beyond
    // the horizon can still be rolled to business days.
    for (let y = yearOf(this.start) - 1; y <= yearOf(this.end) + 31; y++) {
      for (const d of usBondMarketHolidays(y)) this.holidaySet.add(d);
    }
    this.businessDays = [];
    for (let d = this.start; d < this.end; d++) {
      if (this.isBusinessDay(d)) this.businessDays.push(d);
    }
    this.bdIndex = new Map();
    this.businessDays.forEach((d, i) => this.bdIndex.set(d, i));
  }

  isHoliday(n: DayNum): boolean {
    return this.holidaySet.has(n);
  }

  isBusinessDay(n: DayNum): boolean {
    return !isWeekend(n) && !this.holidaySet.has(n);
  }

  /** Roll forward to the next business day (inclusive). */
  nextBusinessDay(n: DayNum): DayNum {
    while (!this.isBusinessDay(n)) n++;
    return n;
  }

  /** Roll backward to the previous business day (inclusive). */
  prevBusinessDay(n: DayNum): DayNum {
    while (!this.isBusinessDay(n)) n--;
    return n;
  }

  /** Add business days (can be negative). */
  addBusinessDays(n: DayNum, k: number): DayNum {
    let d = n;
    const step = k >= 0 ? 1 : -1;
    let remaining = Math.abs(k);
    while (remaining > 0) {
      d += step;
      if (this.isBusinessDay(d)) remaining--;
    }
    return d;
  }

  /** Index of a business day within the horizon, or -1. */
  indexOf(n: DayNum): number {
    return this.bdIndex.get(n) ?? -1;
  }

  /** Days in the simulation. */
  get length(): number {
    return this.businessDays.length;
  }

  /** Whether the given day is the first business day of its calendar month. */
  isFirstBusinessDayOfMonth(n: DayNum): boolean {
    return this.isBusinessDay(n) && monthOf(this.prevBusinessDay(n - 1)) !== monthOf(n);
  }

  /**
   * Quarterly refunding announcement dates: the first Wednesday of February,
   * May, August and November (rolled forward if a holiday).
   */
  refundingDates(): DayNum[] {
    const out: DayNum[] = [];
    for (let y = yearOf(this.start); y <= yearOf(this.end); y++) {
      for (const m of [2, 5, 8, 11]) {
        const d = this.nextBusinessDay(nthWeekdayOfMonth(y, m, 3, 1));
        if (d >= this.start && d < this.end) out.push(d);
      }
    }
    return out;
  }

  /** Calendar quarter index (0-based) relative to the simulation start. */
  quarterIndex(n: DayNum): number {
    const y0 = yearOf(this.start);
    const q0 = Math.floor((monthOf(this.start) - 1) / 3);
    const y = yearOf(n);
    const q = Math.floor((monthOf(n) - 1) / 3);
    return (y - y0) * 4 + (q - q0);
  }

  /** Whether `n` is the first business day of a calendar quarter. */
  isQuarterStart(n: DayNum): boolean {
    return this.isFirstBusinessDayOfMonth(n) && (monthOf(n) - 1) % 3 === 0;
  }
}
