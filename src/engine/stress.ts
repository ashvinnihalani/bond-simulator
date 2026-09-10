/**
 * Liquidity / stress regimes.
 *
 * A three-state Markov chain (calm / elevated / crisis) evolves daily; scripted
 * events override it for controlled experiments. The regime sets multipliers
 * consumed by the other modules on the same day.
 */

import type { StressConfig } from "./config";
import type { Rng } from "./rng";
import type { Simulation } from "./simulate";

export const REGIME_NAMES = ["calm", "elevated", "crisis"] as const;

export class StressModule {
  regime: 0 | 1 | 2;
  private readonly cfg: StressConfig;
  private readonly rng: Rng;
  /** Regime held before a scripted event, restored when the event ends. */
  private preEvent: 0 | 1 | 2 | null = null;

  constructor(private readonly sim: Simulation) {
    this.cfg = sim.config.stress;
    this.rng = sim.streamFor("stress");
    this.regime = this.cfg.initialRegime;
    this.apply();
  }

  /** Advance the chain one day and apply the regime's multipliers. */
  daily(): void {
    const i = this.sim.dayIdx;
    // Always draw so the stream is independent of scripted overrides.
    const u = this.rng.uniform();
    const scripted = this.cfg.events.find((e) => i >= e.startDay && i < e.startDay + e.durationDays);
    if (scripted) {
      if (this.preEvent === null) this.preEvent = this.regime;
      this.regime = scripted.regime;
    } else {
      if (this.preEvent !== null) {
        this.regime = this.preEvent;
        this.preEvent = null;
      }
      const row = this.cfg.transition[this.regime];
      let acc = 0;
      let next: 0 | 1 | 2 = this.regime;
      for (let k = 0; k < 3; k++) {
        acc += row[k];
        if (u < acc) {
          next = k as 0 | 1 | 2;
          break;
        }
      }
      this.regime = next;
    }
    this.apply();
  }

  private apply(): void {
    const r = this.regime;
    const s = this.sim;
    s.regime = r;
    s.volMult = this.cfg.volMult[r];
    s.capacityMult = this.cfg.capacityMult[r];
    s.tailMult = this.cfg.tailMult[r];
    s.richnessMult = this.cfg.richnessMult[r];
    s.offerMult = this.cfg.offerVolumeMult[r];
  }
}
