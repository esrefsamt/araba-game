import type { PlayerInputMessage, VehicleInputState } from '@trailer-arena/shared';

export const NEUTRAL_VEHICLE_INPUT: Readonly<VehicleInputState> = {
  throttle: 0,
  brake: 0,
  steering: 0,
  handbrake: false,
};

export function sanitizeVehicleInput(
  input: Pick<PlayerInputMessage, 'throttle' | 'brake' | 'steering' | 'handbrake'>,
): VehicleInputState {
  return {
    throttle: clampFinite(input.throttle, 0, 1),
    brake: clampFinite(input.brake, 0, 1),
    steering: clampFinite(input.steering, -1, 1),
    handbrake: input.handbrake === true,
  };
}

function clampFinite(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(maximum, Math.max(minimum, value));
}
