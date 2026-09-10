/**
 * Slider / select specifications for the key inputs. Each control edits one
 * path in the SimConfig; values are read and written generically.
 */
import type { SimConfig } from "../engine";

export interface SliderSpec {
  kind: "slider";
  path: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Display multiplier and unit, e.g. 1e4 and "bp" for decimal rates. */
  scale?: number;
  unit?: string;
  help?: string;
}
export interface SelectSpec {
  kind: "select";
  path: string;
  label: string;
  options: Array<{ value: string | number; label: string }>;
  help?: string;
}
export interface ToggleSpec {
  kind: "toggle";
  path: string;
  label: string;
  help?: string;
}
export type ControlSpec = SliderSpec | SelectSpec | ToggleSpec;

export interface ControlGroup {
  title: string;
  controls: ControlSpec[];
}

export const CONTROL_GROUPS: ControlGroup[] = [
  {
    title: "Run",
    controls: [
      { kind: "slider", path: "run.horizonYears", label: "Horizon", min: 1, max: 6, step: 1, unit: "y" },
      { kind: "slider", path: "run.seed", label: "Seed", min: 1, max: 999, step: 1 },
      { kind: "slider", path: "run.recordEveryDays", label: "Record bonds every", min: 1, max: 10, step: 1, unit: "days", help: "Bond-level recording stride (1 = daily; larger is faster)." },
    ],
  },
  {
    title: "Policy & curve",
    controls: [
      {
        kind: "select",
        path: "curve.policy.scenario",
        label: "Policy path",
        options: [
          { value: "hold", label: "Hold" },
          { value: "hike", label: "Hike cycle" },
          { value: "cut", label: "Cut cycle" },
          { value: "custom", label: "Custom knots" },
        ],
      },
      { kind: "slider", path: "curve.policy.initial", label: "Initial policy rate", min: 0, max: 0.08, step: 0.0025, scale: 100, unit: "%" },
      { kind: "slider", path: "curve.policy.stepSize", label: "Move size", min: 0.001, max: 0.01, step: 0.00125, scale: 1e4, unit: "bp" },
      { kind: "slider", path: "curve.policy.numSteps", label: "Number of moves", min: 1, max: 12, step: 1 },
      { kind: "slider", path: "curve.policy.stepEveryDays", label: "Days between moves", min: 21, max: 126, step: 21 },
      { kind: "slider", path: "curve.factors.mean.0", label: "Level long-run mean", min: 0.01, max: 0.08, step: 0.0025, scale: 100, unit: "%" },
      { kind: "slider", path: "curve.factors.mean.1", label: "Slope long-run mean", min: -0.04, max: 0.02, step: 0.0025, scale: 1e4, unit: "bp" },
      { kind: "slider", path: "curve.factors.vol.0", label: "Level daily vol", min: 0.0001, max: 0.0012, step: 0.00005, scale: 1e4, unit: "bp" },
      { kind: "slider", path: "curve.factors.vol.1", label: "Slope daily vol", min: 0.0001, max: 0.0015, step: 0.00005, scale: 1e4, unit: "bp" },
      { kind: "slider", path: "curve.factors.speed.0", label: "Level mean reversion", min: 0, max: 0.02, step: 0.001, unit: "/day" },
      { kind: "slider", path: "curve.lambda", label: "Nelson-Siegel λ", min: 0.5, max: 5, step: 0.1, unit: "y" },
      { kind: "slider", path: "curve.termPremium", label: "Term premium (30y)", min: -0.01, max: 0.02, step: 0.0005, scale: 1e4, unit: "bp" },
      { kind: "slider", path: "curve.shortEndPull", label: "Short-end anchor pull", min: 0, max: 0.5, step: 0.01, unit: "/day" },
    ],
  },
  {
    title: "Issuance & auctions",
    controls: [
      { kind: "slider", path: "issuance.newIssueSize.2", label: "2y auction size", min: 20, max: 120, step: 1, unit: "$bn" },
      { kind: "slider", path: "issuance.newIssueSize.5", label: "5y auction size", min: 20, max: 120, step: 1, unit: "$bn" },
      { kind: "slider", path: "issuance.newIssueSize.10", label: "10y new-issue size", min: 10, max: 90, step: 1, unit: "$bn" },
      { kind: "slider", path: "issuance.reopenSize.10", label: "10y reopening size", min: 10, max: 90, step: 1, unit: "$bn" },
      { kind: "slider", path: "issuance.newIssueSize.30", label: "30y new-issue size", min: 5, max: 60, step: 1, unit: "$bn" },
      { kind: "slider", path: "issuance.sizeGrowthPerRefunding", label: "Size growth per refunding", min: 0, max: 0.1, step: 0.005, scale: 100, unit: "%" },
      { kind: "slider", path: "issuance.wiWindowDays", label: "WI window", min: 1, max: 10, step: 1, unit: "days" },
      { kind: "slider", path: "auction.elasticity", label: "Demand elasticity", min: 0.02, max: 0.4, step: 0.01, unit: "/bp" },
      { kind: "slider", path: "auction.dealerCapacity.10", label: "10y dealer capacity", min: 20, max: 120, step: 1, unit: "$bn" },
      { kind: "slider", path: "auction.demandNoise", label: "Demand noise", min: 0, max: 0.4, step: 0.01 },
      { kind: "slider", path: "auction.tailPassThrough", label: "Tail pass-through to OTR", min: 0, max: 1, step: 0.05 },
      { kind: "slider", path: "auction.tailShockDecay", label: "Tail shock daily decay", min: 0.3, max: 0.98, step: 0.01 },
    ],
  },
  {
    title: "Liquidity premium",
    controls: [
      { kind: "slider", path: "liquidity.baseRichnessBp.2", label: "2y base richness", min: 0, max: 10, step: 0.25, unit: "bp" },
      { kind: "slider", path: "liquidity.baseRichnessBp.5", label: "5y base richness", min: 0, max: 10, step: 0.25, unit: "bp" },
      { kind: "slider", path: "liquidity.baseRichnessBp.10", label: "10y base richness", min: 0, max: 15, step: 0.25, unit: "bp" },
      { kind: "slider", path: "liquidity.baseRichnessBp.30", label: "30y base richness", min: 0, max: 15, step: 0.25, unit: "bp" },
      { kind: "slider", path: "liquidity.halfLifeDays", label: "Richness half-life (10y cycle)", min: 5, max: 120, step: 1, unit: "days" },
      { kind: "slider", path: "liquidity.agingCheapnessBpPerYear", label: "Aging cheapness slope", min: 0, max: 2, step: 0.05, unit: "bp/y" },
      { kind: "slider", path: "liquidity.agingCheapnessCapBp", label: "Aging cheapness cap", min: 0, max: 15, step: 0.5, unit: "bp" },
      { kind: "slider", path: "liquidity.noiseBp", label: "Idiosyncratic noise", min: 0, max: 3, step: 0.1, unit: "bp" },
      { kind: "slider", path: "liquidity.specialnessSensitivity", label: "Repo specialness sensitivity", min: 0, max: 30, step: 1, unit: "×" },
      { kind: "slider", path: "liquidity.specialnessFeedback", label: "Specialness feedback", min: 0, max: 1, step: 0.05 },
    ],
  },
  {
    title: "Buybacks",
    controls: [
      { kind: "toggle", path: "buyback.enabled", label: "Buyback program on" },
      { kind: "slider", path: "buyback.buckets.0.maxPerOp", label: "1mo–2y max per op", min: 0, max: 20, step: 0.5, unit: "$bn" },
      { kind: "slider", path: "buyback.buckets.1.maxPerOp", label: "2–3y max per op", min: 0, max: 20, step: 0.5, unit: "$bn" },
      { kind: "slider", path: "buyback.buckets.2.maxPerOp", label: "3–5y max per op", min: 0, max: 20, step: 0.5, unit: "$bn" },
      { kind: "slider", path: "buyback.buckets.3.maxPerOp", label: "5–7y max per op", min: 0, max: 20, step: 0.5, unit: "$bn" },
      { kind: "slider", path: "buyback.buckets.4.maxPerOp", label: "7–10y max per op", min: 0, max: 20, step: 0.5, unit: "$bn" },
      { kind: "slider", path: "buyback.buckets.5.maxPerOp", label: "10–20y max per op", min: 0, max: 20, step: 0.5, unit: "$bn" },
      { kind: "slider", path: "buyback.buckets.6.maxPerOp", label: "20–30y max per op", min: 0, max: 20, step: 0.5, unit: "$bn" },
      { kind: "slider", path: "buyback.buckets.4.opsPerQuarter", label: "7–10y ops per quarter", min: 1, max: 6, step: 1 },
      { kind: "slider", path: "buyback.cashMgmtMaxPerOp", label: "Cash-management max per op", min: 0, max: 40, step: 1, unit: "$bn" },
      { kind: "slider", path: "buyback.perCusipCap", label: "Per-CUSIP cap", min: 0.01, max: 0.5, step: 0.01, scale: 100, unit: "%" },
      { kind: "slider", path: "buyback.reservationSpreadBp", label: "Reservation spread", min: -10, max: 5, step: 0.25, unit: "bp" },
      { kind: "slider", path: "buyback.offerBaseProb", label: "Dealer offer propensity", min: 0, max: 0.5, step: 0.01 },
      { kind: "slider", path: "buyback.offerCheapnessSlope", label: "Offer propensity per bp cheap", min: 0, max: 0.3, step: 0.01, unit: "/bp" },
      { kind: "slider", path: "buyback.offerSizeFraction", label: "Offer size (share of outstanding)", min: 0.001, max: 0.05, step: 0.001, scale: 100, unit: "%" },
      { kind: "slider", path: "buyback.spreadCompression", label: "Spread compression on purchase", min: 0, max: 1, step: 0.05 },
      { kind: "slider", path: "buyback.spilloverBpPerBn", label: "Spillover strength", min: 0, max: 1, step: 0.02, unit: "bp/$bn" },
      { kind: "slider", path: "buyback.spilloverDecay", label: "Spillover daily decay", min: 0.5, max: 0.99, step: 0.01 },
      { kind: "slider", path: "buyback.anticipationFraction", label: "Anticipation fraction", min: 0, max: 1, step: 0.05 },
      { kind: "slider", path: "buyback.billFundingShare", label: "Bill funding share", min: 0, max: 1, step: 0.05, scale: 100, unit: "%" },
      { kind: "toggle", path: "buyback.cashMgmtCarryForward", label: "Cash-management carry-forward" },
    ],
  },
  {
    title: "Stress",
    controls: [
      { kind: "slider", path: "stress.transition.0.1", label: "P(calm → elevated)", min: 0, max: 0.05, step: 0.001, scale: 100, unit: "%/day" },
      { kind: "slider", path: "stress.transition.1.2", label: "P(elevated → crisis)", min: 0, max: 0.05, step: 0.001, scale: 100, unit: "%/day" },
      { kind: "slider", path: "stress.richnessMult.2", label: "Crisis richness multiplier", min: 1, max: 8, step: 0.5, unit: "×" },
      { kind: "slider", path: "stress.capacityMult.2", label: "Crisis capacity multiplier", min: 0.1, max: 1, step: 0.05, unit: "×" },
      { kind: "slider", path: "stress.volMult.2", label: "Crisis vol multiplier", min: 1, max: 5, step: 0.1, unit: "×" },
      { kind: "slider", path: "stress.offerVolumeMult.2", label: "Crisis offer-volume multiplier", min: 1, max: 5, step: 0.25, unit: "×" },
      { kind: "toggle", path: "ui.scriptedCrisis", label: "Scripted crisis event", help: "Force a crisis regime for a window (controlled experiment)." },
      { kind: "slider", path: "ui.crisisStartDay", label: "Crisis start", min: 0, max: 1500, step: 10, unit: "day" },
      { kind: "slider", path: "ui.crisisDays", label: "Crisis duration", min: 5, max: 200, step: 5, unit: "days" },
    ],
  },
];

/** UI-only settings that are translated into config before a run. */
export interface UiSettings {
  scriptedCrisis: boolean;
  crisisStartDay: number;
  crisisDays: number;
  compare: boolean;
  fanSeeds: number;
}

export const DEFAULT_UI: UiSettings = { scriptedCrisis: false, crisisStartDay: 300, crisisDays: 40, compare: true, fanSeeds: 12 };

export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

export function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split(".");
  const root = structuredClone(obj) as unknown as Record<string, unknown>;
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = cur[keys[i]];
    cur[keys[i]] = Array.isArray(next) ? [...next] : { ...(next as Record<string, unknown>) };
    cur = cur[keys[i]] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
  return root as unknown as T;
}

/** Apply UI-only settings to a config copy. */
export function applyUi(config: SimConfig, ui: UiSettings): SimConfig {
  const c = structuredClone(config);
  c.stress.events = ui.scriptedCrisis ? [{ startDay: ui.crisisStartDay, durationDays: ui.crisisDays, regime: 2 }] : [];
  return c;
}
