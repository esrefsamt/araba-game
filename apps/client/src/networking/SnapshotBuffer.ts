const MAX_BUFFERED_SNAPSHOTS = 32;

interface BufferedSnapshot<T> {
  serverTick: number;
  state: T;
}

export interface SnapshotSample<T> {
  from: T;
  to: T;
  alpha: number;
  extrapolationTicks: number;
}

export class SnapshotBuffer<T> {
  private readonly snapshots: BufferedSnapshot<T>[] = [];
  private sample: SnapshotSample<T> | null = null;

  public add(serverTick: number, state: T): void {
    const latest = this.snapshots.at(-1);
    if (latest !== undefined && serverTick <= latest.serverTick) {
      return;
    }
    this.snapshots.push({ serverTick, state });
    if (this.snapshots.length > MAX_BUFFERED_SNAPSHOTS) {
      this.snapshots.shift();
    }
  }

  public getSample(renderTick: number): SnapshotSample<T> | null {
    const first = this.snapshots[0];
    if (first === undefined) {
      return null;
    }
    if (renderTick <= first.serverTick) {
      return this.setSample(first.state, first.state, 0, 0);
    }
    if (this.snapshots.length === 1) {
      return this.setSample(
        first.state,
        first.state,
        0,
        Math.max(0, renderTick - first.serverTick),
      );
    }

    for (let index = 1; index < this.snapshots.length; index += 1) {
      const next = this.snapshots[index];
      const previous = this.snapshots[index - 1];
      if (next !== undefined && previous !== undefined && renderTick <= next.serverTick) {
        const alpha = Math.min(
          1,
          Math.max(
            0,
            (renderTick - previous.serverTick) /
              Math.max(1, next.serverTick - previous.serverTick),
          ),
        );
        return this.setSample(previous.state, next.state, alpha, 0);
      }
    }

    const latest = this.snapshots.at(-1);
    if (latest === undefined) {
      return null;
    }
    return this.setSample(
      latest.state,
      latest.state,
      0,
      Math.max(0, renderTick - latest.serverTick),
    );
  }

  public getLatest(): T | null {
    return this.snapshots.at(-1)?.state ?? null;
  }

  public get size(): number {
    return this.snapshots.length;
  }

  public clear(): void {
    this.snapshots.length = 0;
    this.sample = null;
  }

  private setSample(
    from: T,
    to: T,
    alpha: number,
    extrapolationTicks: number,
  ): SnapshotSample<T> {
    if (this.sample === null) {
      this.sample = { from, to, alpha, extrapolationTicks };
    } else {
      this.sample.from = from;
      this.sample.to = to;
      this.sample.alpha = alpha;
      this.sample.extrapolationTicks = extrapolationTicks;
    }
    return this.sample;
  }
}
