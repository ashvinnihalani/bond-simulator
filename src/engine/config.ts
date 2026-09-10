/**
 * Every tunable input of the simulator (Appendix A), with sensible defaults.
 *
 * Units: yields and spreads are in decimal (0.04 = 4%) unless the field name
 * ends in `Bp` (basis points). Amounts are in $bn. Durations in business days
 * unless the name ends in `Years`.
 */

export const TENORS = [2, 3, 5, 7, 10, 20, 30] as const;
export type Tenor = (typeof TENORS)[number];

export type PerTenor<T> = Record<Tenor, T>;

export type PolicyScenario = "hold" | "hike" | "cut" | "custom";

export interface PolicyRateConfig {
  scenario: PolicyScenario;
  /** Starting policy rate (decimal). */
  initial: number;
  /** For hike/cut: size of each move (decimal). */
  stepSize: number;
  /** For hike/cut: business days between moves. */
  stepEveryDays: number;
  /** For hike/cut: number of moves before holding. */
  numSteps: number;
  /** For hike/cut: business days before the first move. */
  startAfterDays: number;
  /** For custom: list of [businessDayIndex, rate] knots, held piecewise. */
  custom: Array<[number, number]>;
}

export interface FactorConfig {
  /** Long-run means of level, slope, curvature (decimal). */
  mean: [number, number, number];
  /** Daily mean-reversion speeds (fraction of gap closed per day). */
  speed: [number, number, number];
  /** Daily innovation volatilities (decimal). */
  vol: [number, number, number];
  /** Correlation matrix of the innovations. */
  corr: [[number, number, number], [number, number, number], [number, number, number]];
  /** Initial values (decimal). */
  initial: [number, number, number];
}

export interface CurveConfig {
  policy: PolicyRateConfig;
  factors: FactorConfig;
  /** Nelson-Siegel decay parameter (years). */
  lambda: number;
  /** Term premium added to the long end (decimal, at 30y; scales with tenor). */
  termPremium: number;
  /** Spread of the 1-month point over the policy rate (decimal). */
  shortEndSpread: number;
  /** Daily fraction by which the 1m point is pulled toward policy + spread. */
  shortEndPull: number;
  /** Hard bounds applied to zero rates (decimal). */
  minRate: number;
  maxRate: number;
}

export interface IssuanceConfig {
  /** New-issue auction size per tenor ($bn). */
  newIssueSize: PerTenor<number>;
  /** Reopening auction size per tenor ($bn); only 10/20/30 reopen. */
  reopenSize: PerTenor<number>;
  /** Business days between announcement and auction (WI window). */
  wiWindowDays: number;
  /** Business days between auction and settlement. */
  settlementLagDays: number;
  /** Coupon rounding increment (0.125 = 1/8 of a percent). */
  couponIncrement: number;
  /** Quarterly percent change applied to auction sizes at each refunding (0 = none). */
  sizeGrowthPerRefunding: number;
  /** Years of issuance history to seed at start (30 = full ladder of outstanding CUSIPs). */
  seedHistoryYears: number;
}

export interface AuctionConfig {
  /** Demand elasticity: log change in quantity bid per bp of yield concession. */
  elasticity: number;
  /** Log-demand sensitivity to (supplyRatioRef − supply/capacity). */
  demandSupplySensitivity: number;
  /** Supply-to-capacity ratio at which the expected tail is zero. */
  supplyRatioRef: number;
  /** Log-normal noise on demand at the WI yield (sd). */
  demandNoise: number;
  /** Dealer balance-sheet capacity per tenor ($bn per auction) under calm conditions. */
  dealerCapacity: PerTenor<number>;
  /** Base bid-to-cover mean and sd. */
  bidToCoverMean: number;
  bidToCoverSd: number;
  /** Base take-down shares (dealer / indirect / direct). */
  dealerShareMean: number;
  indirectShareMean: number;
  /** Additional execution noise on the stop-out yield (bp). */
  tailNoiseBp: number;
  /** Log change in bid-to-cover per bp of tail. */
  btcTailSlope: number;
  /** Change in dealer share per bp of tail. */
  dealerShareTailSlope: number;
  /** Fraction of the tail that passes through to the OTR spread as a shock. */
  tailPassThrough: number;
  /** Daily decay factor of the post-auction shock. */
  tailShockDecay: number;
}

export interface LiquidityConfig {
  /** Base on-the-run richness at issuance per tenor (bp, positive = rich). */
  baseRichnessBp: PerTenor<number>;
  /** Half-life of richness decay (business days). */
  halfLifeDays: number;
  /** Additional cheapness per year of age for deep off-the-runs (bp/year). */
  agingCheapnessBpPerYear: number;
  /** Maximum aging cheapness (bp). */
  agingCheapnessCapBp: number;
  /** Daily idiosyncratic spread noise (bp) — AR(1) with the given persistence. */
  noiseBp: number;
  noisePersistence: number;
  /** Richness of the WI relative to the fitted curve as a fraction of base richness. */
  wiRichnessFraction: number;
  /** Repo: GC rate = policy + gcSpread. Specialness = sensitivity × richness. */
  gcSpread: number;
  specialnessSensitivity: number;
  /** Feedback: fraction of expected specialness carry priced into richness. */
  specialnessFeedback: number;
}

export interface BuybackBucket {
  name: string;
  /** Remaining maturity bounds in years [lo, hi). */
  lo: number;
  hi: number;
  /** Max purchase per operation ($bn). */
  maxPerOp: number;
  /** Liquidity-support operations per quarter. */
  opsPerQuarter: number;
}

export interface BuybackConfig {
  enabled: boolean;
  buckets: BuybackBucket[];
  /** Per-CUSIP cap as a share of outstanding. */
  perCusipCap: number;
  /** Treasury will not pay above this spread rich to the curve (bp; negative = must be cheap). */
  reservationSpreadBp: number;
  /** Dealer offer propensity: base probability an eligible CUSIP is offered. */
  offerBaseProb: number;
  /** Extra offer probability per bp of cheapness. */
  offerCheapnessSlope: number;
  /** Offered size as a fraction of outstanding (median), log-normal sd. */
  offerSizeFraction: number;
  offerSizeSigma: number;
  /** Dealer markup over current spread on offers (bp). */
  offerMarkupBp: number;
  /** Fraction of the accepted CUSIP's spread that is compressed toward zero. */
  spreadCompression: number;
  /** Spillover richening to other bonds in the bucket (bp per $bn bought) and daily decay. */
  spilloverBpPerBn: number;
  spilloverDecay: number;
  /** Fraction of the expected effect priced in from announcement. */
  anticipationFraction: number;
  /** Funding mix: fraction of buyback cash raised via bills (rest via coupons). */
  billFundingShare: number;
  /** Cash-management ops: max per op ($bn), tax dates (MM-DD), carry-forward toggle. */
  cashMgmtMaxPerOp: number;
  cashMgmtTaxDates: string[];
  cashMgmtCarryForward: boolean;
  /** Exclude bonds reopened within this many business days. */
  recentReopenExclusionDays: number;
  /** Minimum age (business days) since issuance for eligibility. */
  minAgeDays: number;
}

export interface StressConfig {
  /** Regime names in order: calm, elevated, crisis. */
  transition: [[number, number, number], [number, number, number], [number, number, number]];
  /** Multipliers by regime for each channel. */
  richnessMult: [number, number, number];
  capacityMult: [number, number, number];
  volMult: [number, number, number];
  offerVolumeMult: [number, number, number];
  tailMult: [number, number, number];
  /** Scripted events override the Markov chain. */
  events: Array<{ startDay: number; durationDays: number; regime: 0 | 1 | 2 }>;
  initialRegime: 0 | 1 | 2;
}

export interface RunConfig {
  /** ISO start date. */
  startDate: string;
  horizonYears: number;
  seed: number;
  numPaths: number;
  /** Record bond-level daily data every N business days (1 = every day). */
  recordEveryDays: number;
}

export interface SimConfig {
  run: RunConfig;
  curve: CurveConfig;
  issuance: IssuanceConfig;
  auction: AuctionConfig;
  liquidity: LiquidityConfig;
  buyback: BuybackConfig;
  stress: StressConfig;
}

export const DEFAULT_CONFIG: SimConfig = {
  run: {
    startDate: "2026-01-02",
    horizonYears: 3,
    seed: 1,
    numPaths: 1,
    recordEveryDays: 1,
  },
  curve: {
    policy: {
      scenario: "hold",
      initial: 0.04,
      stepSize: 0.0025,
      stepEveryDays: 63,
      numSteps: 4,
      startAfterDays: 40,
      custom: [
        [0, 0.04],
        [250, 0.035],
        [500, 0.03],
      ],
    },
    factors: {
      mean: [0.045, -0.01, -0.005],
      speed: [0.002, 0.006, 0.01],
      vol: [0.00045, 0.0006, 0.0012],
      corr: [
        [1, -0.4, 0.1],
        [-0.4, 1, 0.25],
        [0.1, 0.25, 1],
      ],
      initial: [0.045, -0.005, -0.01],
    },
    lambda: 1.8,
    termPremium: 0.002,
    shortEndSpread: 0.0005,
    shortEndPull: 0.08,
    minRate: 0.0,
    maxRate: 0.12,
  },
  issuance: {
    newIssueSize: { 2: 69, 3: 58, 5: 70, 7: 44, 10: 39, 20: 16, 30: 22 },
    reopenSize: { 2: 0, 3: 0, 5: 0, 7: 0, 10: 42, 20: 13, 30: 25 },
    wiWindowDays: 5,
    settlementLagDays: 2,
    couponIncrement: 0.00125,
    sizeGrowthPerRefunding: 0,
    seedHistoryYears: 30,
  },
  auction: {
    elasticity: 0.12,
    demandSupplySensitivity: 0.7,
    supplyRatioRef: 0.7,
    demandNoise: 0.13,
    dealerCapacity: { 2: 90, 3: 80, 5: 85, 7: 60, 10: 55, 20: 25, 30: 32 },
    bidToCoverMean: 2.5,
    bidToCoverSd: 0.15,
    dealerShareMean: 0.15,
    indirectShareMean: 0.68,
    tailNoiseBp: 0.4,
    btcTailSlope: 0.04,
    dealerShareTailSlope: 0.02,
    tailPassThrough: 0.6,
    tailShockDecay: 0.7,
  },
  liquidity: {
    baseRichnessBp: { 2: 1.5, 3: 1.5, 5: 2.5, 7: 2.0, 10: 4.0, 20: 3.0, 30: 5.0 },
    halfLifeDays: 30,
    agingCheapnessBpPerYear: 0.4,
    agingCheapnessCapBp: 6,
    noiseBp: 0.6,
    noisePersistence: 0.85,
    wiRichnessFraction: 0.7,
    gcSpread: 0.0005,
    specialnessSensitivity: 8,
    specialnessFeedback: 0.3,
  },
  buyback: {
    enabled: true,
    buckets: [
      { name: "1mo-2y", lo: 1 / 12, hi: 2, maxPerOp: 4, opsPerQuarter: 2 },
      { name: "2-3y", lo: 2, hi: 3, maxPerOp: 4, opsPerQuarter: 2 },
      { name: "3-5y", lo: 3, hi: 5, maxPerOp: 4, opsPerQuarter: 2 },
      { name: "5-7y", lo: 5, hi: 7, maxPerOp: 4, opsPerQuarter: 2 },
      { name: "7-10y", lo: 7, hi: 10, maxPerOp: 4, opsPerQuarter: 2 },
      { name: "10-20y", lo: 10, hi: 20, maxPerOp: 2, opsPerQuarter: 1 },
      { name: "20-30y", lo: 20, hi: 30, maxPerOp: 2, opsPerQuarter: 1 },
    ],
    perCusipCap: 0.1,
    reservationSpreadBp: 0.5,
    offerBaseProb: 0.15,
    offerCheapnessSlope: 0.08,
    offerSizeFraction: 0.02,
    offerSizeSigma: 0.6,
    offerMarkupBp: 0.5,
    spreadCompression: 0.5,
    spilloverBpPerBn: 0.15,
    spilloverDecay: 0.9,
    anticipationFraction: 0.3,
    billFundingShare: 0.7,
    cashMgmtMaxPerOp: 10,
    cashMgmtTaxDates: ["04-15", "06-15", "09-15", "12-15"],
    cashMgmtCarryForward: true,
    recentReopenExclusionDays: 20,
    minAgeDays: 60,
  },
  stress: {
    transition: [
      [0.992, 0.008, 0.0],
      [0.03, 0.965, 0.005],
      [0.0, 0.06, 0.94],
    ],
    richnessMult: [1, 2, 4],
    capacityMult: [1, 0.75, 0.5],
    volMult: [1, 1.6, 2.8],
    offerVolumeMult: [1, 1.5, 2.5],
    tailMult: [1, 1.5, 2.5],
    events: [],
    initialRegime: 0,
  },
};

type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export type PartialConfig = DeepPartial<SimConfig>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const b = (base as Record<string, unknown>)[key];
    const o = override[key];
    out[key] = isPlainObject(b) && isPlainObject(o) ? deepMerge(b, o) : o === undefined ? b : o;
  }
  return out as T;
}

/** Build a full config from partial overrides on top of the defaults. */
export function makeConfig(overrides: PartialConfig = {}): SimConfig {
  return deepMerge(structuredClone(DEFAULT_CONFIG), overrides);
}

/** Deep clone a config for safe mutation. */
export function cloneConfig(c: SimConfig): SimConfig {
  return structuredClone(c);
}
