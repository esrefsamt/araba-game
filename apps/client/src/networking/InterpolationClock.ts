import {
  INTERPOLATION_BASE_DELAY_MS,
  INTERPOLATION_JITTER_MULTIPLIER,
  INTERPOLATION_MAX_DELAY_MS,
  SIMULATION_TICK_RATE,
} from '@trailer-arena/shared';

export class InterpolationClock {
  private latestServerTick = 0;
  private latestSnapshotReceivedAt = 0;
  private averageArrivalIntervalMs = 50;
  private jitterMs = 0;
  private observedSnapshots = 0;

  public observeSnapshot(serverTick: number, receivedAt = performance.now()): void {
    if (serverTick < this.latestServerTick) {
      return;
    }
    if (this.observedSnapshots > 0) {
      const interval = Math.max(0, receivedAt - this.latestSnapshotReceivedAt);
      const error = Math.abs(interval - this.averageArrivalIntervalMs);
      this.averageArrivalIntervalMs += (interval - this.averageArrivalIntervalMs) * 0.1;
      this.jitterMs += (error - this.jitterMs) * 0.1;
    }
    this.latestServerTick = serverTick;
    this.latestSnapshotReceivedAt = receivedAt;
    this.observedSnapshots += 1;
  }

  public getRenderTick(now = performance.now()): number {
    const ticksSinceLatestSnapshot =
      ((now - this.latestSnapshotReceivedAt) / 1_000) * SIMULATION_TICK_RATE;
    const interpolationDelayTicks =
      (this.interpolationDelayMs * SIMULATION_TICK_RATE) / 1_000;
    return this.latestServerTick + ticksSinceLatestSnapshot - interpolationDelayTicks;
  }

  public get interpolationDelayMs(): number {
    return Math.min(
      INTERPOLATION_MAX_DELAY_MS,
      INTERPOLATION_BASE_DELAY_MS + this.jitterMs * INTERPOLATION_JITTER_MULTIPLIER,
    );
  }

  public get networkJitterMs(): number {
    return this.jitterMs;
  }

  public reset(): void {
    this.latestServerTick = 0;
    this.latestSnapshotReceivedAt = 0;
    this.averageArrivalIntervalMs = 50;
    this.jitterMs = 0;
    this.observedSnapshots = 0;
  }
}
