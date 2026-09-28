import { VEHICLE_DIMENSIONS, VEHICLE_TUNING } from '@trailer-arena/shared';

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, finite(value)));
}

export function wheelAngularSpeed(longitudinalSpeed: number, radius: number): number {
  return radius > 0 && Number.isFinite(radius)
    ? finite(finite(longitudinalSpeed) / radius)
    : 0;
}

export function visualSteeringAngle(input: number, longitudinalSpeed: number): number {
  const ratio = Math.min(
    1,
    Math.abs(finite(longitudinalSpeed)) / VEHICLE_TUNING.maxForwardSpeed,
  );
  // Three.js +Y turns +Z forward toward +X (right). No reverse sign flip.
  return (
    clamp(input, -1, 1) *
    VEHICLE_TUNING.steeringStrength *
    (1 - ratio * VEHICLE_TUNING.highSpeedSteeringReduction)
  );
}

export class WheelVisualKinematics {
  public spin = 0;
  public steering = 0;
  public centerY =
    -VEHICLE_DIMENSIONS.chassisHeight * 0.3 - VEHICLE_TUNING.suspensionRestLength;
  private speed: number | null = null;

  public update(
    longitudinalSpeed: number,
    steeringInput: number | null,
    contacts: number,
    dt: number,
  ): void {
    const delta = clamp(dt, 0, 0.1);
    const speed = clamp(longitudinalSpeed, -100, 100);
    this.speed =
      this.speed === null
        ? speed
        : this.speed + (speed - this.speed) * (1 - Math.exp(-delta / 0.065));
    if (Math.abs(speed) < 0.03) this.speed = 0;
    this.spin = Math.atan2(
      Math.sin(
        this.spin + wheelAngularSpeed(this.speed, VEHICLE_DIMENSIONS.wheelRadius) * delta,
      ),
      Math.cos(
        this.spin + wheelAngularSpeed(this.speed, VEHICLE_DIMENSIONS.wheelRadius) * delta,
      ),
    );
    const steering =
      steeringInput === null ? 0 : visualSteeringAngle(steeringInput, speed);
    this.steering += (steering - this.steering) * (1 - Math.exp(-delta / 0.055));
    // Raycast suspension telemetry is not networked. Approximate only the static
    // spring compression; never infer vertical motion from yaw or wheel spin.
    const compression =
      ((9.81 / (4 * VEHICLE_TUNING.suspensionStiffness)) * clamp(contacts, 0, 4)) / 4;
    const center =
      -VEHICLE_DIMENSIONS.chassisHeight * 0.3 -
      VEHICLE_TUNING.suspensionRestLength +
      compression;
    this.centerY += (center - this.centerY) * (1 - Math.exp(-delta / 0.09));
  }
}
