import type RAPIER from '@dimforge/rapier3d-compat';
import {
  CONVOY_TUNING,
  TRACK_LAP_LENGTH,
  TRAILER_DIMENSIONS,
} from '@trailer-arena/shared';
import type {
  ConvoyStateSnapshot,
  QuaternionTuple,
  RigidBodyStateSnapshot,
  Vector3Tuple,
  VehicleSpawnPoint,
} from '@trailer-arena/shared';

import type { SurfaceRegistry } from '../physics/SurfaceRegistry.js';
import { createConvoyBodies } from './ConvoyBodies.js';
import {
  rotationForPathTangent,
  sampleConvoyPath,
  wrapPathDistance,
} from './ConvoyPath.js';

const ZERO_Y = 0;
const DEBUG_APPROACH_GAP = 0.5;

export class ConvoySystem {
  public readonly truckBody: RAPIER.RigidBody;
  public readonly trailerBody: RAPIER.RigidBody;
  public readonly truckColliders: readonly RAPIER.Collider[];
  public readonly trailerColliders: readonly RAPIER.Collider[];
  public readonly trailerSurfaceColliders: readonly RAPIER.Collider[];
  public readonly trailerDeckCollider: RAPIER.Collider;
  public readonly trailerRampCollider: RAPIER.Collider;
  private distanceAlongPath = CONVOY_TUNING.initialPathProgress * TRACK_LAP_LENGTH;
  private speed = 0;

  public constructor(
    private readonly world: RAPIER.World,
    private readonly surfaces: SurfaceRegistry,
  ) {
    const truckSample = sampleConvoyPath(this.distanceAlongPath);
    const trailerSample = sampleConvoyPath(
      this.distanceAlongPath - CONVOY_TUNING.towDistance,
    );
    const bodies = createConvoyBodies(
      world,
      [truckSample.position[0], ZERO_Y, truckSample.position[2]],
      rotationForPathTangent(truckSample.tangent),
      [trailerSample.position[0], ZERO_Y, trailerSample.position[2]],
      rotationForPathTangent(trailerSample.tangent),
    );
    this.truckBody = bodies.truckBody;
    this.trailerBody = bodies.trailerBody;
    this.truckColliders = bodies.truckColliders;
    this.trailerColliders = bodies.trailerColliders;
    this.trailerSurfaceColliders = bodies.trailerSurfaceColliders;
    this.trailerDeckCollider = bodies.trailerDeckCollider;
    this.trailerRampCollider = bodies.trailerRampCollider;
    surfaces.registerTrailer(this.trailerDeckCollider, this.trailerBody, 'TRAILER_DECK');
    surfaces.registerTrailer(this.trailerRampCollider, this.trailerBody, 'TRAILER_RAMP');
  }

  public get currentSpeed(): number {
    return this.speed;
  }

  public get pathProgress(): number {
    return this.distanceAlongPath / TRACK_LAP_LENGTH;
  }

  public updateBeforePhysics(deltaSeconds: number, moving = true): void {
    if (!moving) {
      this.speed = 0;
      this.setNextBodyPose(this.truckBody, this.distanceAlongPath);
      this.setNextBodyPose(
        this.trailerBody,
        this.distanceAlongPath - CONVOY_TUNING.towDistance,
      );
      return;
    }
    const acceleration = CONVOY_TUNING.targetSpeed / CONVOY_TUNING.accelerationSeconds;
    this.speed = Math.min(
      CONVOY_TUNING.targetSpeed,
      this.speed + acceleration * deltaSeconds,
    );
    this.distanceAlongPath = wrapPathDistance(
      this.distanceAlongPath + this.speed * deltaSeconds,
    );
    this.setNextBodyPose(this.truckBody, this.distanceAlongPath);
    this.setNextBodyPose(
      this.trailerBody,
      this.distanceAlongPath - CONVOY_TUNING.towDistance,
    );
  }

  public resetForRound(): void {
    this.speed = 0;
    this.distanceAlongPath = CONVOY_TUNING.initialPathProgress * TRACK_LAP_LENGTH;
    this.setBodyPoseImmediately(this.truckBody, this.distanceAlongPath);
    this.setBodyPoseImmediately(
      this.trailerBody,
      this.distanceAlongPath - CONVOY_TUNING.towDistance,
    );
  }

  public createSnapshot(): ConvoyStateSnapshot {
    return {
      pathProgress: this.pathProgress,
      speed: this.speed,
      truck: createBodySnapshot(this.truckBody),
      trailer: createBodySnapshot(this.trailerBody),
    };
  }

  public trailerLocalToWorld(point: Vector3Tuple): Vector3Tuple {
    const translation = this.trailerBody.translation();
    const rotated = rotateVector(point, this.trailerBody.rotation());
    return [
      translation.x + rotated[0],
      translation.y + rotated[1],
      translation.z + rotated[2],
    ];
  }

  public worldToTrailerLocal(point: Vector3Tuple): Vector3Tuple {
    const translation = this.trailerBody.translation();
    const rotation = this.trailerBody.rotation();
    return rotateVector(
      [point[0] - translation.x, point[1] - translation.y, point[2] - translation.z],
      [-rotation.x, -rotation.y, -rotation.z, rotation.w],
    );
  }

  public getSafeApproachSpawn(): VehicleSpawnPoint {
    const position = this.trailerLocalToWorld([
      0,
      1.15,
      -TRAILER_DIMENSIONS.deckLength / 2 -
        TRAILER_DIMENSIONS.rampHorizontalLength -
        DEBUG_APPROACH_GAP,
    ]);
    const rotation = this.trailerBody.rotation();
    return {
      position,
      rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
    };
  }

  public dispose(): void {
    for (const collider of this.trailerSurfaceColliders) {
      this.surfaces.unregister(collider);
    }
    this.world.removeRigidBody(this.truckBody);
    this.world.removeRigidBody(this.trailerBody);
  }

  private setNextBodyPose(body: RAPIER.RigidBody, distance: number): void {
    const sample = sampleConvoyPath(distance);
    const rotation = rotationForPathTangent(sample.tangent);
    body.setNextKinematicTranslation({
      x: sample.position[0],
      y: ZERO_Y,
      z: sample.position[2],
    });
    body.setNextKinematicRotation({
      x: rotation[0],
      y: rotation[1],
      z: rotation[2],
      w: rotation[3],
    });
  }

  private setBodyPoseImmediately(body: RAPIER.RigidBody, distance: number): void {
    const sample = sampleConvoyPath(distance);
    const rotation = rotationForPathTangent(sample.tangent);
    const translation = { x: sample.position[0], y: ZERO_Y, z: sample.position[2] };
    const quaternion = {
      x: rotation[0],
      y: rotation[1],
      z: rotation[2],
      w: rotation[3],
    };
    body.setTranslation(translation, true);
    body.setRotation(quaternion, true);
    body.setNextKinematicTranslation(translation);
    body.setNextKinematicRotation(quaternion);
  }
}

function createBodySnapshot(body: RAPIER.RigidBody): RigidBodyStateSnapshot {
  const position = body.translation();
  const rotation = body.rotation();
  const linearVelocity = body.linvel();
  const angularVelocity = body.angvel();
  return {
    position: [position.x, position.y, position.z],
    rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
    linearVelocity: [linearVelocity.x, linearVelocity.y, linearVelocity.z],
    angularVelocity: [angularVelocity.x, angularVelocity.y, angularVelocity.z],
  };
}

function rotateVector(
  vector: Vector3Tuple,
  rotation: QuaternionTuple | RAPIER.Rotation,
): Vector3Tuple {
  const { x, y, z, w } = Array.isArray(rotation)
    ? { x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] }
    : rotation;
  const tx = 2 * (y * vector[2] - z * vector[1]);
  const ty = 2 * (z * vector[0] - x * vector[2]);
  const tz = 2 * (x * vector[1] - y * vector[0]);
  return [
    vector[0] + w * tx + (y * tz - z * ty),
    vector[1] + w * ty + (z * tx - x * tz),
    vector[2] + w * tz + (x * ty - y * tx),
  ];
}
