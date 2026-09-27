export type FrameHandler = (deltaSeconds: number, elapsedSeconds: number) => void;

const MAX_FRAME_DELTA_SECONDS = 0.1;

export class GameLoop {
  private animationFrameId: number | null = null;
  private previousTimeMs = 0;
  private elapsedSeconds = 0;

  public constructor(private readonly onFrame: FrameHandler) {}

  public start(): void {
    if (this.animationFrameId !== null) {
      return;
    }
    this.previousTimeMs = performance.now();
    this.animationFrameId = requestAnimationFrame(this.frame);
  }

  public stop(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private readonly frame = (timeMs: number): void => {
    const deltaSeconds = Math.min(
      (timeMs - this.previousTimeMs) / 1_000,
      MAX_FRAME_DELTA_SECONDS,
    );
    this.previousTimeMs = timeMs;
    this.elapsedSeconds += deltaSeconds;
    this.onFrame(deltaSeconds, this.elapsedSeconds);
    this.animationFrameId = requestAnimationFrame(this.frame);
  };
}
