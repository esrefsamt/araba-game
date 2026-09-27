import { MAX_PENDING_INPUTS } from '@trailer-arena/shared';
import type { VehicleInputState } from '@trailer-arena/shared';

export interface PendingInput {
  readonly sequence: number;
  readonly input: VehicleInputState;
  readonly predictionTick: number;
}

export class PendingInputHistory {
  private readonly pending: PendingInput[] = [];
  private overflowed = false;

  public add(
    sequence: number,
    input: Readonly<VehicleInputState>,
    predictionTick: number,
  ): void {
    this.pending.push({
      sequence,
      input: { ...input },
      predictionTick: Math.max(0, Math.floor(predictionTick)),
    });
    if (this.pending.length > MAX_PENDING_INPUTS) {
      this.pending.shift();
      this.overflowed = true;
    }
  }

  public acknowledge(lastProcessedSequence: number): void {
    let removeCount = 0;
    while (
      removeCount < this.pending.length &&
      this.pending[removeCount]!.sequence <= lastProcessedSequence
    ) {
      removeCount += 1;
    }
    if (removeCount > 0) this.pending.splice(0, removeCount);
  }

  public get entries(): readonly PendingInput[] {
    return this.pending;
  }

  public get size(): number {
    return this.pending.length;
  }

  public get didOverflow(): boolean {
    return this.overflowed;
  }

  public clear(): void {
    this.pending.length = 0;
    this.overflowed = false;
  }
}
