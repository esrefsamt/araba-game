import { MAX_PREDICTION_TICK_HISTORY } from '@trailer-arena/shared';
import type { VehicleInputState } from '@trailer-arena/shared';

interface AppliedInputTick {
  readonly tick: number;
  readonly input: VehicleInputState;
}

/**
 * Records the input state actually applied by each 60 Hz prediction step.
 * Network packets are only state samples at 30 Hz and must never be treated
 * as physics steps. Reconciliation replays this timeline for the estimated
 * age of the authoritative snapshot.
 */
export class PredictionInputTimeline {
  private readonly ticks: AppliedInputTick[] = [];

  public record(tick: number, input: Readonly<VehicleInputState>): void {
    this.ticks.push({ tick, input: { ...input } });
    if (this.ticks.length > MAX_PREDICTION_TICK_HISTORY) this.ticks.shift();
  }

  public replay(
    startTick: number,
    endTick: number,
    apply: (input: Readonly<VehicleInputState>) => void,
  ): number {
    let applied = 0;
    for (const entry of this.ticks) {
      if (entry.tick < startTick) continue;
      if (entry.tick >= endTick) break;
      apply(entry.input);
      applied += 1;
    }
    return applied;
  }

  public get size(): number {
    return this.ticks.length;
  }

  public clear(): void {
    this.ticks.length = 0;
  }
}
