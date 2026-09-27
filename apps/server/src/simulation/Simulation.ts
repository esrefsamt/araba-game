import { performance } from 'node:perf_hooks';

import RAPIER from '@dimforge/rapier3d-compat';
import { SIMULATION_FIXED_DELTA_SECONDS } from '@trailer-arena/shared';

const MAX_FRAME_DELTA_SECONDS = 0.25;
const MAX_CATCH_UP_STEPS = 8;

export type SimulationStepHandler = (deltaSeconds: number, tick: number) => void;

export class Simulation {
  private timer: NodeJS.Timeout | null = null;
  private previousTimeMs = 0;
  private accumulatorSeconds = 0;
  private running = false;
  private initialized = false;
  private tick = 0;

  public constructor(private readonly onStep: SimulationStepHandler) {}

  public get currentTick(): number {
    return this.tick;
  }

  public async initialize(): Promise<void> {
    await RAPIER.init();
    this.initialized = true;
  }

  public start(): void {
    if (this.running) {
      return;
    }
    if (!this.initialized) {
      throw new Error('Simulation must be initialized before it starts.');
    }
    this.running = true;
    this.previousTimeMs = performance.now();
    this.accumulatorSeconds = 0;
    this.scheduleNextLoop(0);
  }

  public stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private readonly loop = (): void => {
    if (!this.running) {
      return;
    }

    const nowMs = performance.now();
    const elapsedSeconds = Math.min(
      (nowMs - this.previousTimeMs) / 1_000,
      MAX_FRAME_DELTA_SECONDS,
    );
    this.previousTimeMs = nowMs;
    this.accumulatorSeconds += elapsedSeconds;

    let steps = 0;
    while (
      this.accumulatorSeconds >= SIMULATION_FIXED_DELTA_SECONDS &&
      steps < MAX_CATCH_UP_STEPS
    ) {
      this.tick += 1;
      this.onStep(SIMULATION_FIXED_DELTA_SECONDS, this.tick);
      this.accumulatorSeconds -= SIMULATION_FIXED_DELTA_SECONDS;
      steps += 1;
    }

    if (steps === MAX_CATCH_UP_STEPS) {
      this.accumulatorSeconds %= SIMULATION_FIXED_DELTA_SECONDS;
    }

    const delayMs = Math.max(
      0,
      (SIMULATION_FIXED_DELTA_SECONDS - this.accumulatorSeconds) * 1_000,
    );
    this.scheduleNextLoop(delayMs);
  };

  private scheduleNextLoop(delayMs: number): void {
    this.timer = setTimeout(this.loop, delayMs);
  }
}
