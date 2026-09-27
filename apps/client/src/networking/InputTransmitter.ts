import { INPUT_SEND_INTERVAL_MS } from '@trailer-arena/shared';
import type { VehicleInputState } from '@trailer-arena/shared';

export type InputProvider = () => Readonly<VehicleInputState>;
export type InputSender = (
  sequence: number,
  input: Readonly<VehicleInputState>,
) => boolean;
export type SequenceListener = (
  sequence: number,
  input: Readonly<VehicleInputState>,
) => void;

export class InputTransmitter {
  private timer: number | null = null;
  private sequence = 0;
  private enabled = false;

  public constructor(
    private readonly getInput: InputProvider,
    private readonly sendInput: InputSender,
    private readonly onSequence: SequenceListener,
  ) {}

  public start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = window.setInterval(() => this.transmit(), INPUT_SEND_INTERVAL_MS);
  }

  public stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  private transmit(): void {
    if (!this.enabled) return;
    const nextSequence = this.sequence + 1;
    const input = this.getInput();
    if (this.sendInput(nextSequence, input)) {
      this.sequence = nextSequence;
      this.onSequence(this.sequence, input);
    }
  }
}
