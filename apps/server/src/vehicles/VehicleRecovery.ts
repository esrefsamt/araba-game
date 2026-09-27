import RAPIER from '@dimforge/rapier3d-compat';
import { VEHICLE_RECOVERY_TUNING } from '@trailer-arena/shared';

import { VEHICLE_SUPPORT_QUERY_GROUPS } from '../physics/CollisionGroups.js';

const DOWN = { x: 0, y: -1, z: 0 };
const ZERO = { x: 0, y: 0, z: 0 };

export function vehicleUpDot(rotation: RAPIER.Rotation): number {
  return 1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z);
}

export function isVehicleFlipped(rotation: RAPIER.Rotation): boolean {
  return vehicleUpDot(rotation) < VEHICLE_RECOVERY_TUNING.flippedUpDotThreshold;
}

export class VehicleRecovery {
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, DOWN);
  private flippedSeconds = 0;
  private supported = false;
  private supportSurfaceY = 0;
  private supportRelativeSpeed = Number.POSITIVE_INFINITY;
  private readonly supportPoint = { x: 0, y: 0, z: 0 };
  private readonly supportVelocity = { x: 0, y: 0, z: 0 };

  public constructor(
    private readonly world: RAPIER.World,
    private readonly body: RAPIER.RigidBody,
    private readonly collider: RAPIER.Collider,
  ) {}

  public get flipped(): boolean {
    return isVehicleFlipped(this.body.rotation());
  }

  public get available(): boolean {
    return (
      this.flipped &&
      this.supported &&
      this.flippedSeconds >= VEHICLE_RECOVERY_TUNING.requiredFlippedSeconds &&
      this.supportRelativeSpeed <= VEHICLE_RECOVERY_TUNING.maximumSpeed
    );
  }

  public update(deltaSeconds: number): void {
    this.supported = this.updateSupport();
    if (
      this.flipped &&
      this.supported &&
      this.supportRelativeSpeed <= VEHICLE_RECOVERY_TUNING.maximumSpeed
    ) {
      this.flippedSeconds += deltaSeconds;
    } else {
      this.flippedSeconds = 0;
    }
  }

  public requestSelfRight(): boolean {
    if (!this.available) {
      return false;
    }
    if (!this.updateSupport()) {
      return false;
    }

    const rotation = this.body.rotation();
    let forwardX = 2 * (rotation.x * rotation.z + rotation.w * rotation.y);
    let forwardZ = 1 - 2 * (rotation.x * rotation.x + rotation.y * rotation.y);
    const forwardLength = Math.hypot(forwardX, forwardZ);
    if (forwardLength < 0.1) {
      forwardX = 0;
      forwardZ = 1;
    } else {
      forwardX /= forwardLength;
      forwardZ /= forwardLength;
    }
    const yaw = Math.atan2(forwardX, forwardZ);
    const position = this.body.translation();
    this.body.setTranslation(
      {
        x: position.x,
        y: this.supportSurfaceY + VEHICLE_RECOVERY_TUNING.safeSurfaceOffset,
        z: position.z,
      },
      true,
    );
    this.body.setRotation(
      { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
      true,
    );
    const velocity = this.body.linvel();
    const relativeVelocityX = velocity.x - this.supportVelocity.x;
    const relativeVelocityZ = velocity.z - this.supportVelocity.z;
    const horizontalSpeed = Math.hypot(relativeVelocityX, relativeVelocityZ);
    const retainedSpeed = Math.min(
      VEHICLE_RECOVERY_TUNING.maximumRetainedHorizontalSpeed,
      horizontalSpeed * VEHICLE_RECOVERY_TUNING.retainedHorizontalSpeed,
    );
    const velocityScale = horizontalSpeed > 0.001 ? retainedSpeed / horizontalSpeed : 0;
    this.body.setLinvel(
      {
        x: this.supportVelocity.x + relativeVelocityX * velocityScale,
        y: this.supportVelocity.y,
        z: this.supportVelocity.z + relativeVelocityZ * velocityScale,
      },
      true,
    );
    this.body.setAngvel(ZERO, true);
    this.body.resetForces(true);
    this.body.resetTorques(true);
    this.flippedSeconds = 0;
    return true;
  }

  public resetState(): void {
    this.flippedSeconds = 0;
    this.supported = false;
    this.supportRelativeSpeed = Number.POSITIVE_INFINITY;
  }

  private updateSupport(): boolean {
    const position = this.body.translation();
    this.ray.origin.x = position.x;
    this.ray.origin.y = position.y + 0.25;
    this.ray.origin.z = position.z;
    const hit = this.world.castRay(
      this.ray,
      VEHICLE_RECOVERY_TUNING.supportRayLength,
      false,
      undefined,
      VEHICLE_SUPPORT_QUERY_GROUPS,
      this.collider,
      this.body,
    );
    if (hit === null) {
      this.supportRelativeSpeed = Number.POSITIVE_INFINITY;
      return false;
    }
    this.supportSurfaceY = this.ray.origin.y - hit.timeOfImpact;
    this.supportPoint.x = position.x;
    this.supportPoint.y = this.supportSurfaceY;
    this.supportPoint.z = position.z;
    const supportBody = hit.collider.parent();
    if (supportBody === null) {
      this.supportVelocity.x = 0;
      this.supportVelocity.y = 0;
      this.supportVelocity.z = 0;
    } else {
      supportBody.velocityAtPoint(this.supportPoint, this.supportVelocity);
    }
    const velocity = this.body.linvel();
    this.supportRelativeSpeed = Math.hypot(
      velocity.x - this.supportVelocity.x,
      velocity.y - this.supportVelocity.y,
      velocity.z - this.supportVelocity.z,
    );
    return true;
  }
}
