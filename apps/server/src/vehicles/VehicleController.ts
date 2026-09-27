import type RAPIER from '@dimforge/rapier3d-compat';
import {
  ASPHALT_SURFACE_GRIP,
  CONVOY_TUNING,
  PLAYER_COLLISION_TUNING,
  TRAILER_DIMENSIONS,
  VEHICLE_DIMENSIONS,
  VEHICLE_TUNING,
} from '@trailer-arena/shared';
import type { SurfaceGrip, VehicleInputState } from '@trailer-arena/shared';
import type { SurfaceType } from '@trailer-arena/shared';

import { PLAYER_COLLISION_GROUPS } from '../physics/CollisionGroups.js';
import type { SurfaceRegistry } from '../physics/SurfaceRegistry.js';

const FRONT_WHEELS = [0, 1] as const;
const REAR_WHEELS = [2, 3] as const;
const ALL_WHEELS = [0, 1, 2, 3] as const;
/**
 * Game input describes the direction the driver wants the vehicle's travel to
 * curve: negative is left and positive is right. Rapier's wheel angle uses the
 * opposite sign with our +Z forward / -X axle convention. This conversion is
 * intentionally continuous through zero speed: Rapier's reverse kinematics
 * already invert the trajectory, and another speed-based sign flip makes A/D
 * feel reversed and can flicker while changing direction.
 */
export function inputToRapierSteering(steeringCommand: number): number {
  return -steeringCommand;
}

export function steeringStrengthAtSpeed(forwardSpeed: number): number {
  const speedRatio = Math.min(1, Math.abs(forwardSpeed) / VEHICLE_TUNING.maxForwardSpeed);
  return (
    VEHICLE_TUNING.steeringStrength *
    (1 - speedRatio * VEHICLE_TUNING.highSpeedSteeringReduction)
  );
}

interface MutableVector3 {
  x: number;
  y: number;
  z: number;
}

interface MutableQuaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

interface GroundedOrientationControlOptions {
  readonly maximumRecoveryDegrees?: number;
  readonly recoveryMultiplier?: number;
}

const RAM_SLIDE_ORIENTATION_OPTIONS: GroundedOrientationControlOptions = {
  maximumRecoveryDegrees:
    PLAYER_COLLISION_TUNING.ramSlideOrientationMaximumRecoveryDegrees,
  recoveryMultiplier: PLAYER_COLLISION_TUNING.ramSlideOrientationRecoveryMultiplier,
};

/**
 * Applies arcade orientation control around the wheel support normal. The
 * roll/pitch velocity cap is active before visible tilt develops, while yaw
 * around the support normal remains untouched. Past the soft limit, rotation
 * approaches a surface-upright quaternion which preserves the projected
 * heading. Extreme tilt stays outside this envelope so rare flips and the
 * explicit self-right mechanic remain possible.
 */
export function calculateGroundedOrientationControl(
  rotation: RAPIER.Rotation,
  angularVelocity: RAPIER.Vector3,
  supportNormal: RAPIER.Vector3,
  supportContactCount: number,
  deltaSeconds: number,
  targetAngularVelocity: MutableVector3,
  targetRotation: MutableQuaternion,
  options: GroundedOrientationControlOptions = {},
): boolean {
  copyVector(angularVelocity, targetAngularVelocity);
  copyQuaternion(rotation, targetRotation);
  if (supportContactCount < 2 || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
    return false;
  }

  const supportLength = Math.hypot(supportNormal.x, supportNormal.y, supportNormal.z);
  if (!Number.isFinite(supportLength) || supportLength < 1e-6) return false;
  const normalX = supportNormal.x / supportLength;
  const normalY = supportNormal.y / supportLength;
  const normalZ = supportNormal.z / supportLength;

  const upX = 2 * (rotation.x * rotation.y - rotation.w * rotation.z);
  const upY = 1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z);
  const upZ = 2 * (rotation.y * rotation.z + rotation.w * rotation.x);
  const tiltRadians = Math.acos(
    clamp(upX * normalX + upY * normalY + upZ * normalZ, -1, 1),
  );
  const maximumRecovery = degreesToRadians(
    options.maximumRecoveryDegrees ??
      VEHICLE_TUNING.groundedOrientationMaximumRecoveryDegrees,
  );
  if (tiltRadians >= maximumRecovery) return false;

  const freeAngle = degreesToRadians(VEHICLE_TUNING.groundedOrientationFreeDegrees);
  const softLimit = degreesToRadians(VEHICLE_TUNING.groundedOrientationSoftLimitDegrees);
  const hardLimit = degreesToRadians(VEHICLE_TUNING.groundedOrientationHardLimitDegrees);
  const normalizedTilt = clamp((tiltRadians - freeAngle) / (softLimit - freeAngle), 0, 1);
  const response = normalizedTilt * normalizedTilt * (3 - 2 * normalizedTilt);
  const yawSpeed =
    angularVelocity.x * normalX +
    angularVelocity.y * normalY +
    angularVelocity.z * normalZ;
  const yawX = normalX * yawSpeed;
  const yawY = normalY * yawSpeed;
  const yawZ = normalZ * yawSpeed;
  let tiltX = angularVelocity.x - yawX;
  let tiltY = angularVelocity.y - yawY;
  let tiltZ = angularVelocity.z - yawZ;
  let changed = false;

  if (response > 0) {
    const retention = Math.exp(
      -VEHICLE_TUNING.groundedUprightDamping * response * deltaSeconds,
    );
    tiltX *= retention;
    tiltY *= retention;
    tiltZ *= retention;

    const correctionAxisX = upY * normalZ - upZ * normalY;
    const correctionAxisY = upZ * normalX - upX * normalZ;
    const correctionAxisZ = upX * normalY - upY * normalX;
    const correctionAxisLength = Math.hypot(
      correctionAxisX,
      correctionAxisY,
      correctionAxisZ,
    );
    if (correctionAxisLength > 1e-6) {
      const correctionDelta =
        VEHICLE_TUNING.groundedUprightStrength *
        (options.recoveryMultiplier ?? 1) *
        response *
        deltaSeconds;
      tiltX += (correctionAxisX / correctionAxisLength) * correctionDelta;
      tiltY += (correctionAxisY / correctionAxisLength) * correctionDelta;
      tiltZ += (correctionAxisZ / correctionAxisLength) * correctionDelta;
    }
    changed = true;
  }

  const angularCap =
    tiltRadians >= freeAngle
      ? VEHICLE_TUNING.groundedRollPitchAngularSpeed
      : VEHICLE_TUNING.maxGroundedRollPitchAngularSpeed;
  const tiltAngularSpeed = Math.hypot(tiltX, tiltY, tiltZ);
  if (tiltAngularSpeed > angularCap) {
    const capScale = angularCap / tiltAngularSpeed;
    tiltX *= capScale;
    tiltY *= capScale;
    tiltZ *= capScale;
    changed = true;
  }

  targetAngularVelocity.x = yawX + tiltX;
  targetAngularVelocity.y = yawY + tiltY;
  targetAngularVelocity.z = yawZ + tiltZ;

  if (tiltRadians > softLimit) {
    createSurfaceUprightRotation(rotation, normalX, normalY, normalZ, targetRotation);
    const hardResponse = smoothstep(softLimit, hardLimit, tiltRadians);
    const recoveryDegreesPerSecond =
      lerp(
        VEHICLE_TUNING.groundedSoftRecoveryDegreesPerSecond,
        VEHICLE_TUNING.groundedHardRecoveryDegreesPerSecond,
        hardResponse,
      ) * (options.recoveryMultiplier ?? 1);
    slerpTowardMaximumStep(
      rotation,
      targetRotation,
      degreesToRadians(recoveryDegreesPerSecond) * deltaSeconds,
      targetRotation,
    );
    changed = true;
  }

  return changed;
}

/**
 * Rapier 0.20 exposes a stable DynamicRayCastVehicleController, so Phase 2 uses
 * its real suspension/contact impulses on a dynamic chassis. Small additional
 * drag and lateral forces tune the result toward predictable arcade handling.
 */
export class VehicleController {
  private readonly controller: RAPIER.DynamicRayCastVehicleController;
  private readonly force = { x: 0, y: 0, z: 0 };
  private readonly contactPoint = { x: 0, y: 0, z: 0 };
  private readonly pointVelocity = { x: 0, y: 0, z: 0 };
  private readonly surfaceVelocity = { x: 0, y: 0, z: 0 };
  private readonly previousSurfaceVelocity = { x: 0, y: 0, z: 0 };
  private readonly surfaceAngularVelocity = { x: 0, y: 0, z: 0 };
  private readonly previousSurfaceAngularVelocity = { x: 0, y: 0, z: 0 };
  private readonly adhesionTargetPoint = { x: 0, y: 0, z: 0 };
  private readonly rotatedVector = { x: 0, y: 0, z: 0 };
  private readonly stabilizedAngularVelocity = { x: 0, y: 0, z: 0 };
  private readonly stabilizedRotation = { x: 0, y: 0, z: 0, w: 1 };
  private readonly supportNormal = { x: 0, y: 1, z: 0 };
  private readonly wheelContactNormal = { x: 0, y: 1, z: 0 };
  private input: Readonly<VehicleInputState> = {
    throttle: 0,
    brake: 0,
    steering: 0,
    handbrake: false,
  };
  private surfaceGrip: SurfaceGrip = ASPHALT_SURFACE_GRIP;
  private forwardSpeed = 0;
  private lateralSpeed = 0;
  private grounded = false;
  private surfaceType: SurfaceType = 'AIR';
  private wheelContactCount = 0;
  private supportContactCount = 0;
  private trailerDeckContactCount = 0;
  private movingSurfaceBody: RAPIER.RigidBody | null = null;
  private neutralSurfaceAdhesionActive = false;
  private neutralSurfaceAdhesionSuspensionSeconds = 0;
  private ramSlideRemainingSeconds = 0;
  private ramSlideDurationSeconds = 0;
  private adhesionAnchorLocalX = 0;
  private adhesionAnchorLocalZ = 0;

  public constructor(
    private readonly world: RAPIER.World,
    private readonly chassis: RAPIER.RigidBody,
    private readonly surfaces: SurfaceRegistry,
  ) {
    this.controller = world.createVehicleController(chassis);
    this.controller.indexUpAxis = 1;
    this.controller.setIndexForwardAxis = 2;
    this.configureWheels();
  }

  public get currentForwardSpeed(): number {
    return this.forwardSpeed;
  }

  public get currentLateralSpeed(): number {
    return this.lateralSpeed;
  }

  public get currentSurfaceRelativeHorizontalSpeed(): number {
    return Math.hypot(this.forwardSpeed, this.lateralSpeed);
  }

  public get isGrounded(): boolean {
    return this.grounded;
  }

  public get currentSurfaceType(): SurfaceType {
    return this.surfaceType;
  }

  public get isOnTrailerSurface(): boolean {
    return isTrailerSurface(this.surfaceType);
  }

  public get currentWheelContactCount(): number {
    return this.wheelContactCount;
  }

  public get currentTrailerDeckContactCount(): number {
    return this.trailerDeckContactCount;
  }

  public get currentRamSlideGripMultiplier(): number {
    return lerp(
      PLAYER_COLLISION_TUNING.ramSlideInitialGripMultiplier,
      1,
      this.ramSlideRecoveryProgress,
    );
  }

  public get currentRamSlideRollingResistanceMultiplier(): number {
    return lerp(
      PLAYER_COLLISION_TUNING.ramSlideRollingResistanceMultiplier,
      1,
      this.ramSlideRecoveryProgress,
    );
  }

  public get currentRamSlideWheelFrictionMultiplier(): number {
    return lerp(
      PLAYER_COLLISION_TUNING.ramSlideInitialWheelFrictionMultiplier,
      1,
      this.ramSlideRecoveryProgress,
    );
  }

  public get currentRamSlideRemainingSeconds(): number {
    return this.ramSlideRemainingSeconds;
  }

  public get isNeutralSurfaceAdhesionSuspended(): boolean {
    return this.neutralSurfaceAdhesionSuspensionSeconds > 0;
  }

  public setInput(input: Readonly<VehicleInputState>): void {
    this.input = input;
  }

  public setSurfaceGrip(surfaceGrip: SurfaceGrip): void {
    this.surfaceGrip = surfaceGrip;
  }

  public suspendNeutralSurfaceAdhesion(durationSeconds: number): void {
    this.neutralSurfaceAdhesionActive = false;
    this.neutralSurfaceAdhesionSuspensionSeconds = Math.max(
      this.neutralSurfaceAdhesionSuspensionSeconds,
      Math.max(0, durationSeconds),
    );
  }

  public startRamSlide(
    durationSeconds = PLAYER_COLLISION_TUNING.ramSlideDurationSeconds,
  ): void {
    const finiteDuration = Number.isFinite(durationSeconds)
      ? Math.max(0, durationSeconds)
      : 0;
    if (finiteDuration <= 0) return;
    // Keep the response surface-independent so asphalt and trailer impacts use
    // the same authoritative state instead of a trailer-only friction hack.
    this.ramSlideDurationSeconds = finiteDuration;
    this.ramSlideRemainingSeconds = finiteDuration;
  }

  public resetTransientState(): void {
    this.neutralSurfaceAdhesionActive = false;
    this.neutralSurfaceAdhesionSuspensionSeconds = 0;
    this.ramSlideRemainingSeconds = 0;
    this.ramSlideDurationSeconds = 0;
  }

  public update(deltaSeconds: number): void {
    this.neutralSurfaceAdhesionSuspensionSeconds = Math.max(
      0,
      this.neutralSurfaceAdhesionSuspensionSeconds - deltaSeconds,
    );
    this.ramSlideRemainingSeconds = Math.max(
      0,
      this.ramSlideRemainingSeconds - deltaSeconds,
    );
    const rotation = this.chassis.rotation();
    const velocity = this.chassis.linvel();

    const forwardX = 2 * (rotation.x * rotation.z + rotation.w * rotation.y);
    const forwardY = 2 * (rotation.y * rotation.z - rotation.w * rotation.x);
    const forwardZ = 1 - 2 * (rotation.x ** 2 + rotation.y ** 2);
    const rightX = 1 - 2 * (rotation.y ** 2 + rotation.z ** 2);
    const rightY = 2 * (rotation.x * rotation.y + rotation.w * rotation.z);
    const rightZ = 2 * (rotation.x * rotation.z - rotation.w * rotation.y);

    this.updateRelativeSpeeds(
      velocity,
      forwardX,
      forwardY,
      forwardZ,
      rightX,
      rightY,
      rightZ,
    );

    const steeringAtSpeed = steeringStrengthAtSpeed(this.forwardSpeed);
    const steeringFromRestScale = Math.min(1, Math.abs(this.forwardSpeed) / 0.65);
    const steeringAngle =
      inputToRapierSteering(this.input.steering) *
      steeringAtSpeed *
      steeringFromRestScale;

    for (const wheelIndex of FRONT_WHEELS) {
      this.controller.setWheelSteering(wheelIndex, steeringAngle);
    }

    const drive = this.calculateDrive();
    for (const wheelIndex of REAR_WHEELS) {
      this.controller.setWheelEngineForce(wheelIndex, drive.engineForce);
    }
    for (const wheelIndex of FRONT_WHEELS) {
      this.controller.setWheelEngineForce(wheelIndex, 0);
    }

    for (const wheelIndex of ALL_WHEELS) {
      this.controller.setWheelBrake(wheelIndex, drive.brakeForce);
      this.controller.setWheelSideFrictionStiffness(
        wheelIndex,
        this.sideFrictionForWheel(wheelIndex),
      );
    }
    if (this.input.handbrake) {
      for (const wheelIndex of REAR_WHEELS) {
        this.controller.setWheelBrake(
          wheelIndex,
          Math.max(drive.brakeForce, VEHICLE_TUNING.handbrakeForce),
        );
      }
    }

    this.controller.updateVehicle(
      deltaSeconds,
      undefined,
      PLAYER_COLLISION_GROUPS,
      (collider) => collider.parent()?.handle !== this.chassis.handle,
    );
    this.grounded = ALL_WHEELS.some((wheelIndex) =>
      this.controller.wheelIsInContact(wheelIndex),
    );
    this.previousSurfaceVelocity.x = this.surfaceVelocity.x;
    this.previousSurfaceVelocity.y = this.surfaceVelocity.y;
    this.previousSurfaceVelocity.z = this.surfaceVelocity.z;
    this.previousSurfaceAngularVelocity.x = this.surfaceAngularVelocity.x;
    this.previousSurfaceAngularVelocity.y = this.surfaceAngularVelocity.y;
    this.previousSurfaceAngularVelocity.z = this.surfaceAngularVelocity.z;
    const wasOnTrailer = isTrailerSurface(this.surfaceType);
    this.updateSurfaceContact();
    if (wasOnTrailer && isTrailerSurface(this.surfaceType)) {
      this.inheritSurfaceVelocityDelta();
    }
    this.applyNeutralMovingSurfaceAdhesion();
    this.updateRelativeSpeeds(
      this.chassis.linvel(),
      forwardX,
      forwardY,
      forwardZ,
      rightX,
      rightY,
      rightZ,
    );

    this.applyDrag(forwardX, forwardY, forwardZ, deltaSeconds);
    if (this.grounded) {
      this.applyLateralGrip(rightX, rightY, rightZ, deltaSeconds);
    }
  }

  public afterPhysicsStep(deltaSeconds: number): void {
    const rotation = this.chassis.rotation();
    const angularVelocity = this.chassis.angvel();
    if (
      calculateGroundedOrientationControl(
        rotation,
        angularVelocity,
        this.supportNormal,
        this.supportContactCount,
        deltaSeconds,
        this.stabilizedAngularVelocity,
        this.stabilizedRotation,
        this.ramSlideRemainingSeconds > 0 ? RAM_SLIDE_ORIENTATION_OPTIONS : undefined,
      )
    ) {
      this.chassis.setAngvel(this.stabilizedAngularVelocity, true);
      if (
        rotation.x !== this.stabilizedRotation.x ||
        rotation.y !== this.stabilizedRotation.y ||
        rotation.z !== this.stabilizedRotation.z ||
        rotation.w !== this.stabilizedRotation.w
      ) {
        this.chassis.setRotation(this.stabilizedRotation, true);
      }
    }
  }

  private updateRelativeSpeeds(
    velocity: RAPIER.Vector,
    forwardX: number,
    forwardY: number,
    forwardZ: number,
    rightX: number,
    rightY: number,
    rightZ: number,
  ): void {
    const relativeVelocityX = velocity.x - this.surfaceVelocity.x;
    const relativeVelocityY = velocity.y - this.surfaceVelocity.y;
    const relativeVelocityZ = velocity.z - this.surfaceVelocity.z;
    this.forwardSpeed =
      relativeVelocityX * forwardX +
      relativeVelocityY * forwardY +
      relativeVelocityZ * forwardZ;
    this.lateralSpeed =
      relativeVelocityX * rightX +
      relativeVelocityY * rightY +
      relativeVelocityZ * rightZ;
  }

  private inheritSurfaceVelocityDelta(): void {
    const mass = this.chassis.mass();
    this.force.x = (this.surfaceVelocity.x - this.previousSurfaceVelocity.x) * mass;
    this.force.y = (this.surfaceVelocity.y - this.previousSurfaceVelocity.y) * mass;
    this.force.z = (this.surfaceVelocity.z - this.previousSurfaceVelocity.z) * mass;
    this.chassis.applyImpulse(this.force, true);
    const angularVelocity = this.chassis.angvel();
    this.chassis.setAngvel(
      {
        x:
          angularVelocity.x +
          this.surfaceAngularVelocity.x -
          this.previousSurfaceAngularVelocity.x,
        y:
          angularVelocity.y +
          this.surfaceAngularVelocity.y -
          this.previousSurfaceAngularVelocity.y,
        z:
          angularVelocity.z +
          this.surfaceAngularVelocity.z -
          this.previousSurfaceAngularVelocity.z,
      },
      true,
    );
  }

  /**
   * Rapier's ray-cast vehicle applies suspension against kinematic ground but
   * does not fully preserve the chassis' tangential velocity while that ground
   * follows a curved path.  At neutral input we model the static-friction part
   * of a tyre contact explicitly: the body stays dynamic, but a bounded impulse
   * removes relative horizontal slip and matches the platform's yaw rate.
   * Driver input disables this assistance so accelerating, braking and sliding
   * on the trailer continue to use the normal tyre/controller forces.
   */
  private applyNeutralMovingSurfaceAdhesion(): void {
    if (this.neutralSurfaceAdhesionSuspensionSeconds > 0) {
      this.neutralSurfaceAdhesionActive = false;
      return;
    }
    const hasDriverInput =
      this.input.throttle > 0.001 ||
      this.input.brake > 0.001 ||
      Math.abs(this.input.steering) > 0.001 ||
      this.input.handbrake;
    if (hasDriverInput) {
      this.neutralSurfaceAdhesionActive = false;
      return;
    }
    if (!isTrailerSurface(this.surfaceType) || this.movingSurfaceBody === null) {
      if (this.surfaceType === 'GROUND') {
        this.neutralSurfaceAdhesionActive = false;
      }
      return;
    }

    const velocity = this.chassis.linvel();
    const relativeHorizontalSpeed = Math.hypot(
      velocity.x - this.surfaceVelocity.x,
      velocity.z - this.surfaceVelocity.z,
    );
    if (
      this.neutralSurfaceAdhesionActive &&
      relativeHorizontalSpeed > CONVOY_TUNING.neutralSurfaceAdhesionBreakawaySpeed
    ) {
      this.neutralSurfaceAdhesionActive = false;
      return;
    }
    if (
      !this.neutralSurfaceAdhesionActive &&
      relativeHorizontalSpeed > CONVOY_TUNING.neutralSurfaceAdhesionMaxRelativeSpeed
    ) {
      return;
    }
    if (!this.neutralSurfaceAdhesionActive) {
      this.captureAdhesionAnchor(this.movingSurfaceBody);
      if (!this.isAdhesionAnchorSafelyOnDeck()) {
        return;
      }
    }
    this.neutralSurfaceAdhesionActive = true;
    const mass = this.chassis.mass();
    const adhesion = CONVOY_TUNING.neutralSurfaceAdhesion;
    this.updateAdhesionTarget(this.movingSurfaceBody);
    this.movingSurfaceBody.velocityAtPoint(this.adhesionTargetPoint, this.pointVelocity);
    const centerOfMass = this.chassis.worldCom(this.contactPoint);
    const errorX = this.adhesionTargetPoint.x - centerOfMass.x;
    const errorZ = this.adhesionTargetPoint.z - centerOfMass.z;
    const correctionX = clampMagnitude(
      errorX * CONVOY_TUNING.neutralSurfacePositionCorrection,
      CONVOY_TUNING.neutralSurfaceMaxCorrectionSpeed,
    );
    const correctionZ = clampMagnitude(
      errorZ * CONVOY_TUNING.neutralSurfacePositionCorrection,
      CONVOY_TUNING.neutralSurfaceMaxCorrectionSpeed,
    );
    this.force.x = (this.pointVelocity.x + correctionX - velocity.x) * mass * adhesion;
    this.force.y = 0;
    this.force.z = (this.pointVelocity.z + correctionZ - velocity.z) * mass * adhesion;
    this.chassis.applyImpulse(this.force, true);

    const angularVelocity = this.chassis.angvel();
    const currentSurfaceYaw =
      angularVelocity.x * this.supportNormal.x +
      angularVelocity.y * this.supportNormal.y +
      angularVelocity.z * this.supportNormal.z;
    const desiredSurfaceYaw =
      this.surfaceAngularVelocity.x * this.supportNormal.x +
      this.surfaceAngularVelocity.y * this.supportNormal.y +
      this.surfaceAngularVelocity.z * this.supportNormal.z;
    const matchedSurfaceYaw =
      currentSurfaceYaw + (desiredSurfaceYaw - currentSurfaceYaw) * adhesion;
    const rotation = this.chassis.rotation();
    const upX = 2 * (rotation.x * rotation.y - rotation.w * rotation.z);
    const upY = 1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z);
    const upZ = 2 * (rotation.y * rotation.z + rotation.w * rotation.x);
    const correctionAxisX = upY * this.supportNormal.z - upZ * this.supportNormal.y;
    const correctionAxisY = upZ * this.supportNormal.x - upX * this.supportNormal.z;
    const correctionAxisZ = upX * this.supportNormal.y - upY * this.supportNormal.x;
    const tiltAngularRetention = CONVOY_TUNING.neutralSurfaceTiltAngularRetention;
    const uprightStrength = CONVOY_TUNING.neutralSurfaceUprightStrength;
    this.chassis.setAngvel(
      {
        x:
          (angularVelocity.x - this.supportNormal.x * currentSurfaceYaw) *
            tiltAngularRetention +
          correctionAxisX * uprightStrength +
          this.supportNormal.x * matchedSurfaceYaw,
        y:
          (angularVelocity.y - this.supportNormal.y * currentSurfaceYaw) *
            tiltAngularRetention +
          correctionAxisY * uprightStrength +
          this.supportNormal.y * matchedSurfaceYaw,
        z:
          (angularVelocity.z - this.supportNormal.z * currentSurfaceYaw) *
            tiltAngularRetention +
          correctionAxisZ * uprightStrength +
          this.supportNormal.z * matchedSurfaceYaw,
      },
      true,
    );
  }

  private captureAdhesionAnchor(surfaceBody: RAPIER.RigidBody): void {
    const center = this.chassis.worldCom(this.contactPoint);
    const translation = surfaceBody.translation();
    const rotation = surfaceBody.rotation();
    const offsetX = center.x - translation.x;
    const offsetY = center.y - translation.y;
    const offsetZ = center.z - translation.z;
    const local = rotateVectorByQuaternion(
      offsetX,
      offsetY,
      offsetZ,
      -rotation.x,
      -rotation.y,
      -rotation.z,
      rotation.w,
      this.rotatedVector,
    );
    this.adhesionAnchorLocalX = local.x;
    this.adhesionAnchorLocalZ = local.z;
  }

  private isAdhesionAnchorSafelyOnDeck(): boolean {
    const maximumAnchorX =
      TRAILER_DIMENSIONS.deckWidth / 2 - VEHICLE_DIMENSIONS.width / 2;
    const maximumAnchorZ =
      TRAILER_DIMENSIONS.deckLength / 2 - VEHICLE_DIMENSIONS.length / 2;
    return (
      Math.abs(this.adhesionAnchorLocalX) <= maximumAnchorX &&
      Math.abs(this.adhesionAnchorLocalZ) <= maximumAnchorZ
    );
  }

  private updateAdhesionTarget(surfaceBody: RAPIER.RigidBody): void {
    const translation = surfaceBody.translation();
    const rotation = surfaceBody.rotation();
    const rotated = rotateVectorByQuaternion(
      this.adhesionAnchorLocalX,
      0,
      this.adhesionAnchorLocalZ,
      rotation.x,
      rotation.y,
      rotation.z,
      rotation.w,
      this.rotatedVector,
    );
    this.adhesionTargetPoint.x = translation.x + rotated.x;
    this.adhesionTargetPoint.y = this.chassis.worldCom(this.contactPoint).y;
    this.adhesionTargetPoint.z = translation.z + rotated.z;
  }

  private updateSurfaceContact(): void {
    this.surfaceVelocity.x = 0;
    this.surfaceVelocity.y = 0;
    this.surfaceVelocity.z = 0;
    this.surfaceAngularVelocity.x = 0;
    this.surfaceAngularVelocity.y = 0;
    this.surfaceAngularVelocity.z = 0;
    this.surfaceType = this.grounded ? 'GROUND' : 'AIR';
    this.surfaceGrip = ASPHALT_SURFACE_GRIP;
    this.wheelContactCount = 0;
    this.supportContactCount = 0;
    this.trailerDeckContactCount = 0;
    this.supportNormal.x = 0;
    this.supportNormal.y = 0;
    this.supportNormal.z = 0;
    this.movingSurfaceBody = null;
    let movingContactCount = 0;
    let rampContactCount = 0;
    let movingSurfaceBody: RAPIER.RigidBody | null = null;

    for (const wheelIndex of ALL_WHEELS) {
      if (!this.controller.wheelIsInContact(wheelIndex)) {
        continue;
      }
      this.wheelContactCount += 1;
      const surface = this.surfaces.get(this.controller.wheelGroundObject(wheelIndex));
      if (surface === null) {
        continue;
      }
      const contactNormal = this.controller.wheelContactNormal(
        wheelIndex,
        this.wheelContactNormal,
      );
      if (contactNormal !== null) {
        const orientation = contactNormal.y < 0 ? -1 : 1;
        this.supportNormal.x += contactNormal.x * orientation;
        this.supportNormal.y += contactNormal.y * orientation;
        this.supportNormal.z += contactNormal.z * orientation;
        this.supportContactCount += 1;
      }
      if (surface.type === 'TRAILER_DECK') {
        this.trailerDeckContactCount += 1;
        this.surfaceType = 'TRAILER_DECK';
        this.surfaceGrip = surface.grip;
      } else if (surface.type === 'TRAILER_RAMP') {
        rampContactCount += 1;
        if (this.trailerDeckContactCount === 0) {
          this.surfaceType = 'TRAILER_RAMP';
        }
        this.surfaceGrip = surface.grip;
      }
      if (surface.movingBody === null) {
        continue;
      }
      const contactPoint = this.controller.wheelContactPoint(
        wheelIndex,
        this.contactPoint,
      );
      if (contactPoint === null) {
        continue;
      }
      movingSurfaceBody = surface.movingBody;
      this.movingSurfaceBody = surface.movingBody;
      const angularVelocity = surface.movingBody.angvel();
      this.surfaceAngularVelocity.x += angularVelocity.x;
      this.surfaceAngularVelocity.y += angularVelocity.y;
      this.surfaceAngularVelocity.z += angularVelocity.z;
      movingContactCount += 1;
    }

    if (movingContactCount > 0 && movingSurfaceBody !== null) {
      const centerOfMass = this.chassis.worldCom(this.contactPoint);
      movingSurfaceBody.velocityAtPoint(centerOfMass, this.pointVelocity);
      this.surfaceVelocity.x = this.pointVelocity.x;
      this.surfaceVelocity.y = this.pointVelocity.y;
      this.surfaceVelocity.z = this.pointVelocity.z;
      this.surfaceAngularVelocity.x /= movingContactCount;
      this.surfaceAngularVelocity.y /= movingContactCount;
      this.surfaceAngularVelocity.z /= movingContactCount;
    }
    if (this.trailerDeckContactCount === 0 && rampContactCount > 0) {
      this.surfaceType = 'TRAILER_RAMP';
    }
    const supportNormalLength = Math.hypot(
      this.supportNormal.x,
      this.supportNormal.y,
      this.supportNormal.z,
    );
    if (supportNormalLength > 1e-6) {
      this.supportNormal.x /= supportNormalLength;
      this.supportNormal.y /= supportNormalLength;
      this.supportNormal.z /= supportNormalLength;
    } else {
      this.supportNormal.x = 0;
      this.supportNormal.y = 1;
      this.supportNormal.z = 0;
      this.supportContactCount = 0;
    }
  }

  public dispose(): void {
    this.world.removeVehicleController(this.controller);
  }

  private configureWheels(): void {
    const halfTrack = VEHICLE_DIMENSIONS.trackWidth / 2;
    const halfWheelBase = VEHICLE_DIMENSIONS.wheelBase / 2;
    const connectionY = -VEHICLE_DIMENSIONS.chassisHeight * 0.3;
    const wheelPositions = [
      { x: halfTrack, y: connectionY, z: halfWheelBase },
      { x: -halfTrack, y: connectionY, z: halfWheelBase },
      { x: halfTrack, y: connectionY, z: -halfWheelBase },
      { x: -halfTrack, y: connectionY, z: -halfWheelBase },
    ];

    for (const position of wheelPositions) {
      this.controller.addWheel(
        position,
        { x: 0, y: -1, z: 0 },
        { x: -1, y: 0, z: 0 },
        VEHICLE_TUNING.suspensionRestLength,
        VEHICLE_DIMENSIONS.wheelRadius,
      );
    }

    for (const wheelIndex of ALL_WHEELS) {
      this.controller.setWheelSuspensionStiffness(
        wheelIndex,
        VEHICLE_TUNING.suspensionStiffness,
      );
      this.controller.setWheelSuspensionCompression(
        wheelIndex,
        VEHICLE_TUNING.suspensionCompression,
      );
      this.controller.setWheelSuspensionRelaxation(
        wheelIndex,
        VEHICLE_TUNING.suspensionRelaxation,
      );
      this.controller.setWheelMaxSuspensionTravel(
        wheelIndex,
        VEHICLE_TUNING.maxSuspensionTravel,
      );
      this.controller.setWheelMaxSuspensionForce(
        wheelIndex,
        VEHICLE_TUNING.maxSuspensionForce,
      );
      this.controller.setWheelFrictionSlip(wheelIndex, VEHICLE_TUNING.wheelFrictionSlip);
      this.controller.setWheelSideFrictionStiffness(
        wheelIndex,
        VEHICLE_TUNING.wheelSideFrictionStiffness,
      );
    }
  }

  private calculateDrive(): { engineForce: number; brakeForce: number } {
    let engineForce = 0;
    let brakeForce = 0;

    if (this.input.throttle > 0) {
      if (this.forwardSpeed < -VEHICLE_TUNING.reverseEngageSpeed) {
        brakeForce = this.input.throttle * VEHICLE_TUNING.brakeForce;
      } else {
        const curve = Math.max(
          0,
          1 - (Math.max(0, this.forwardSpeed) / VEHICLE_TUNING.maxForwardSpeed) ** 2,
        );
        engineForce = this.input.throttle * VEHICLE_TUNING.engineForce * curve;
      }
    } else if (this.input.brake > 0) {
      if (this.forwardSpeed > VEHICLE_TUNING.reverseEngageSpeed) {
        brakeForce = this.input.brake * VEHICLE_TUNING.brakeForce;
      } else {
        const reverseRatio = Math.min(
          1,
          Math.abs(Math.min(0, this.forwardSpeed)) / VEHICLE_TUNING.maxReverseSpeed,
        );
        engineForce =
          -this.input.brake *
          VEHICLE_TUNING.reverseForce *
          Math.max(0, 1 - reverseRatio ** 2);
      }
    }

    return { engineForce, brakeForce };
  }

  private sideFrictionForWheel(wheelIndex: number): number {
    const handbrakeMultiplier =
      this.input.handbrake && wheelIndex >= 2
        ? VEHICLE_TUNING.handbrakeGripMultiplier
        : 1;
    return (
      VEHICLE_TUNING.wheelSideFrictionStiffness *
      this.surfaceGrip.wheelSideFrictionMultiplier *
      handbrakeMultiplier *
      this.currentRamSlideWheelFrictionMultiplier
    );
  }

  private applyDrag(
    forwardX: number,
    forwardY: number,
    forwardZ: number,
    deltaSeconds: number,
  ): void {
    const dragMagnitude =
      -this.forwardSpeed *
      (VEHICLE_TUNING.rollingResistance *
        this.surfaceGrip.rollingResistanceMultiplier *
        this.currentRamSlideRollingResistanceMultiplier +
        VEHICLE_TUNING.airDrag * Math.abs(this.forwardSpeed));
    this.force.x = forwardX * dragMagnitude * deltaSeconds;
    this.force.y = forwardY * dragMagnitude * deltaSeconds;
    this.force.z = forwardZ * dragMagnitude * deltaSeconds;
    this.chassis.applyImpulse(this.force, true);
  }

  private applyLateralGrip(
    rightX: number,
    rightY: number,
    rightZ: number,
    deltaSeconds: number,
  ): void {
    const handbrakeMultiplier = this.input.handbrake
      ? VEHICLE_TUNING.handbrakeGripMultiplier
      : 1;
    const gripForce =
      -this.lateralSpeed *
      VEHICLE_TUNING.mass *
      VEHICLE_TUNING.lateralGrip *
      this.surfaceGrip.lateralGripMultiplier *
      handbrakeMultiplier *
      this.currentRamSlideGripMultiplier;
    this.force.x = rightX * gripForce * deltaSeconds;
    this.force.y = rightY * gripForce * deltaSeconds;
    this.force.z = rightZ * gripForce * deltaSeconds;
    this.chassis.applyImpulse(this.force, true);
  }

  private get ramSlideRecoveryProgress(): number {
    if (this.ramSlideRemainingSeconds <= 0 || this.ramSlideDurationSeconds <= 0) {
      return 1;
    }
    const linearProgress = clamp(
      1 - this.ramSlideRemainingSeconds / this.ramSlideDurationSeconds,
      0,
      1,
    );
    if (PLAYER_COLLISION_TUNING.ramSlideGripRecoveryCurve === 'ease-in-sextic') {
      return linearProgress ** 6;
    }
    return linearProgress;
  }
}

function isTrailerSurface(surfaceType: SurfaceType): boolean {
  return surfaceType === 'TRAILER_DECK' || surfaceType === 'TRAILER_RAMP';
}

function clampMagnitude(value: number, maximumMagnitude: number): number {
  return Math.max(-maximumMagnitude, Math.min(maximumMagnitude, value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function createSurfaceUprightRotation(
  rotation: RAPIER.Rotation,
  normalX: number,
  normalY: number,
  normalZ: number,
  target: MutableQuaternion,
): void {
  const forwardX = 2 * (rotation.x * rotation.z + rotation.w * rotation.y);
  const forwardY = 2 * (rotation.y * rotation.z - rotation.w * rotation.x);
  const forwardZ = 1 - 2 * (rotation.x * rotation.x + rotation.y * rotation.y);
  const forwardNormalDot = forwardX * normalX + forwardY * normalY + forwardZ * normalZ;
  let projectedForwardX = forwardX - normalX * forwardNormalDot;
  let projectedForwardY = forwardY - normalY * forwardNormalDot;
  let projectedForwardZ = forwardZ - normalZ * forwardNormalDot;
  let forwardLength = Math.hypot(projectedForwardX, projectedForwardY, projectedForwardZ);
  if (forwardLength < 1e-6) {
    projectedForwardX = normalY;
    projectedForwardY = -normalX;
    projectedForwardZ = 0;
    forwardLength = Math.hypot(projectedForwardX, projectedForwardY);
  }
  projectedForwardX /= forwardLength;
  projectedForwardY /= forwardLength;
  projectedForwardZ /= forwardLength;

  let rightX = normalY * projectedForwardZ - normalZ * projectedForwardY;
  let rightY = normalZ * projectedForwardX - normalX * projectedForwardZ;
  let rightZ = normalX * projectedForwardY - normalY * projectedForwardX;
  const rightLength = Math.hypot(rightX, rightY, rightZ);
  rightX /= rightLength;
  rightY /= rightLength;
  rightZ /= rightLength;
  projectedForwardX = rightY * normalZ - rightZ * normalY;
  projectedForwardY = rightZ * normalX - rightX * normalZ;
  projectedForwardZ = rightX * normalY - rightY * normalX;

  quaternionFromBasis(
    rightX,
    rightY,
    rightZ,
    normalX,
    normalY,
    normalZ,
    projectedForwardX,
    projectedForwardY,
    projectedForwardZ,
    target,
  );
}

function quaternionFromBasis(
  rightX: number,
  rightY: number,
  rightZ: number,
  upX: number,
  upY: number,
  upZ: number,
  forwardX: number,
  forwardY: number,
  forwardZ: number,
  target: MutableQuaternion,
): void {
  const trace = rightX + upY + forwardZ;
  if (trace > 0) {
    const scale = Math.sqrt(trace + 1) * 2;
    target.w = 0.25 * scale;
    target.x = (upZ - forwardY) / scale;
    target.y = (forwardX - rightZ) / scale;
    target.z = (rightY - upX) / scale;
  } else if (rightX > upY && rightX > forwardZ) {
    const scale = Math.sqrt(1 + rightX - upY - forwardZ) * 2;
    target.w = (upZ - forwardY) / scale;
    target.x = 0.25 * scale;
    target.y = (upX + rightY) / scale;
    target.z = (forwardX + rightZ) / scale;
  } else if (upY > forwardZ) {
    const scale = Math.sqrt(1 + upY - rightX - forwardZ) * 2;
    target.w = (forwardX - rightZ) / scale;
    target.x = (upX + rightY) / scale;
    target.y = 0.25 * scale;
    target.z = (forwardY + upZ) / scale;
  } else {
    const scale = Math.sqrt(1 + forwardZ - rightX - upY) * 2;
    target.w = (rightY - upX) / scale;
    target.x = (forwardX + rightZ) / scale;
    target.y = (forwardY + upZ) / scale;
    target.z = 0.25 * scale;
  }
  normalizeQuaternion(target);
}

function slerpTowardMaximumStep(
  current: RAPIER.Rotation,
  desired: MutableQuaternion,
  maximumStepRadians: number,
  target: MutableQuaternion,
): void {
  let dot =
    current.x * desired.x +
    current.y * desired.y +
    current.z * desired.z +
    current.w * desired.w;
  let desiredSign = 1;
  if (dot < 0) {
    dot = -dot;
    desiredSign = -1;
  }
  dot = clamp(dot, -1, 1);
  const angularDistance = 2 * Math.acos(dot);
  if (angularDistance <= maximumStepRadians || angularDistance < 1e-6) return;
  const alpha = maximumStepRadians / angularDistance;
  const desiredX = desired.x * desiredSign;
  const desiredY = desired.y * desiredSign;
  const desiredZ = desired.z * desiredSign;
  const desiredW = desired.w * desiredSign;
  if (dot > 0.9995) {
    target.x = lerp(current.x, desiredX, alpha);
    target.y = lerp(current.y, desiredY, alpha);
    target.z = lerp(current.z, desiredZ, alpha);
    target.w = lerp(current.w, desiredW, alpha);
    normalizeQuaternion(target);
    return;
  }
  const theta = Math.acos(dot);
  const sineTheta = Math.sin(theta);
  const currentWeight = Math.sin((1 - alpha) * theta) / sineTheta;
  const desiredWeight = Math.sin(alpha * theta) / sineTheta;
  target.x = current.x * currentWeight + desiredX * desiredWeight;
  target.y = current.y * currentWeight + desiredY * desiredWeight;
  target.z = current.z * currentWeight + desiredZ * desiredWeight;
  target.w = current.w * currentWeight + desiredW * desiredWeight;
  normalizeQuaternion(target);
}

function normalizeQuaternion(target: MutableQuaternion): void {
  const length = Math.hypot(target.x, target.y, target.z, target.w);
  target.x /= length;
  target.y /= length;
  target.z /= length;
  target.w /= length;
}

function copyVector(source: RAPIER.Vector3, target: MutableVector3): void {
  target.x = source.x;
  target.y = source.y;
  target.z = source.z;
}

function copyQuaternion(source: RAPIER.Rotation, target: MutableQuaternion): void {
  target.x = source.x;
  target.y = source.y;
  target.z = source.z;
  target.w = source.w;
}

function smoothstep(minimum: number, maximum: number, value: number): number {
  const normalized = clamp((value - minimum) / (maximum - minimum), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

function lerp(start: number, end: number, alpha: number): number {
  return start + (end - start) * alpha;
}

function rotateVectorByQuaternion(
  vectorX: number,
  vectorY: number,
  vectorZ: number,
  quaternionX: number,
  quaternionY: number,
  quaternionZ: number,
  quaternionW: number,
  target: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const tx = 2 * (quaternionY * vectorZ - quaternionZ * vectorY);
  const ty = 2 * (quaternionZ * vectorX - quaternionX * vectorZ);
  const tz = 2 * (quaternionX * vectorY - quaternionY * vectorX);
  target.x = vectorX + quaternionW * tx + (quaternionY * tz - quaternionZ * ty);
  target.y = vectorY + quaternionW * ty + (quaternionZ * tx - quaternionX * tz);
  target.z = vectorZ + quaternionW * tz + (quaternionX * ty - quaternionY * tx);
  return target;
}
