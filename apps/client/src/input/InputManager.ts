import type { VehicleInputState } from '@trailer-arena/shared';

const CONTROLLED_KEYS = new Set([
  'KeyW',
  'KeyS',
  'KeyA',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
]);

export class InputManager {
  private readonly pressedKeys = new Set<string>();
  private readonly state: VehicleInputState = {
    throttle: 0,
    brake: 0,
    steering: 0,
    handbrake: false,
  };
  private selfRightHandler: (() => void) | null = null;
  private enabled = false;

  public onSelfRight(handler: () => void): void {
    this.selfRightHandler = handler;
  }

  public start(): void {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
  }

  public stop(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    this.clear();
  }

  public getState(): Readonly<VehicleInputState> {
    return this.state;
  }

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (
      this.enabled &&
      event.code === 'KeyR' &&
      !event.repeat &&
      !isEditableTarget(event.target)
    ) {
      event.preventDefault();
      this.selfRightHandler?.();
      return;
    }
    if (
      !this.enabled ||
      !CONTROLLED_KEYS.has(event.code) ||
      isEditableTarget(event.target)
    ) {
      return;
    }
    event.preventDefault();
    this.pressedKeys.add(event.code);
    this.updateState();
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    if (!CONTROLLED_KEYS.has(event.code)) {
      return;
    }
    event.preventDefault();
    this.pressedKeys.delete(event.code);
    this.updateState();
  };

  private readonly handleBlur = (): void => {
    this.clear();
  };

  private clear(): void {
    this.pressedKeys.clear();
    this.updateState();
  }

  private updateState(): void {
    this.state.throttle = this.isPressed('KeyW', 'ArrowUp') ? 1 : 0;
    this.state.brake = this.isPressed('KeyS', 'ArrowDown') ? 1 : 0;
    const steerLeft = this.isPressed('KeyA', 'ArrowLeft') ? -1 : 0;
    const steerRight = this.isPressed('KeyD', 'ArrowRight') ? 1 : 0;
    this.state.steering = steerLeft + steerRight;
    this.state.handbrake = this.pressedKeys.has('Space');
  }

  private isPressed(primary: string, alternate: string): boolean {
    return this.pressedKeys.has(primary) || this.pressedKeys.has(alternate);
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
