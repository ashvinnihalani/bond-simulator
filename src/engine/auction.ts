/**
 * Auction mechanics.
 *
 * Demand is a downward-sloping curve in yield space:
 *   Q(y) = D_base · exp(elasticity · (y − y_WI) in bp)
 * where D_base, the quantity demanded at the WI yield, shrinks as supply grows
 * relative to dealer capacity and is hit by log-normal noise. The stop-out
 * yield solves Q(stop) = size, so
 *   tail = ln(size / D_base) / elasticity.
 */

import type { Rng } from "./rng";
import type { AuctionConfig } from "./config";
import type { AuctionModel } from "./simulate";

export function makeAuctionModel(cfg: AuctionConfig, rng: Rng): AuctionModel {
  return {
    run: ({ event, wiYield, capacityMult, tailMult }) => {
      const capacity = cfg.dealerCapacity[event.tenor] * capacityMult;
      const supplyToCapacity = event.size / capacity;
      // Demand at the WI yield relative to supply.
      const logDemand =
        cfg.demandSupplySensitivity * (cfg.supplyRatioRef - supplyToCapacity) +
        cfg.demandNoise * tailMult * rng.normal();
      const dBase = event.size * Math.exp(logDemand);
      const demandAt = (yieldBp: number): number => dBase * Math.exp(cfg.elasticity * (yieldBp - wiYield * 1e4));
      // Invert Q(stop) = size, then add pure execution noise.
      let tailBp = Math.log(event.size / dBase) / cfg.elasticity + cfg.tailNoiseBp * tailMult * rng.normal();
      // Guard: the closed form must agree with the demand curve.
      const check = demandAt(wiYield * 1e4 + Math.log(event.size / dBase) / cfg.elasticity);
      if (Math.abs(check - event.size) > 1e-6 * event.size) throw new Error("auction demand inversion failed");
      tailBp = Math.max(-25, Math.min(25, tailBp));
      const stopYield = wiYield + tailBp / 1e4;

      const bidToCover = Math.max(
        1.05,
        cfg.bidToCoverMean * Math.exp(-cfg.btcTailSlope * tailBp - 0.4 * (supplyToCapacity - cfg.supplyRatioRef)) +
          cfg.bidToCoverSd * rng.normal(),
      );
      const dealerShare = clamp(cfg.dealerShareMean + cfg.dealerShareTailSlope * tailBp + 0.03 * rng.normal(), 0.04, 0.6);
      const indirectShare = clamp(cfg.indirectShareMean - 0.6 * cfg.dealerShareTailSlope * tailBp + 0.04 * rng.normal(), 0.2, 1 - dealerShare - 0.02);
      const directShare = 1 - dealerShare - indirectShare;
      return {
        wiYield,
        stopYield,
        tailBp,
        bidToCover,
        dealerShare,
        indirectShare,
        directShare,
        supplyToCapacity,
      };
    },
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
