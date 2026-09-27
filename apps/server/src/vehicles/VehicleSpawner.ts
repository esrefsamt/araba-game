import RAPIER from '@dimforge/rapier3d-compat';
import {
  VEHICLE_DIMENSIONS,
  VEHICLE_SPAWN_POINTS,
  VEHICLE_TUNING,
} from '@trailer-arena/shared';
import type { VehicleSpawnPoint } from '@trailer-arena/shared';

import { PLAYER_COLLISION_GROUPS } from '../physics/CollisionGroups.js';

export interface SpawnedVehicleBody {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly spawnPoint: VehicleSpawnPoint;
}

export class VehicleSpawner {
  private nextSpawnIndex = 0;

  public constructor(private readonly world: RAPIER.World) {}

  public spawn(): SpawnedVehicleBody {
    const spawnPoint =
      VEHICLE_SPAWN_POINTS[this.nextSpawnIndex % VEHICLE_SPAWN_POINTS.length];
    if (spawnPoint === undefined) {
      throw new Error('At least one vehicle spawn point is required.');
    }
    this.nextSpawnIndex += 1;

    const [positionX, positionY, positionZ] = spawnPoint.position;
    const [rotationX, rotationY, rotationZ, rotationW] = spawnPoint.rotation;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(positionX, positionY, positionZ)
        .setRotation({
          x: rotationX,
          y: rotationY,
          z: rotationZ,
          w: rotationW,
        })
        .setLinearDamping(VEHICLE_TUNING.linearDamping)
        .setAngularDamping(VEHICLE_TUNING.angularDamping)
        .setAdditionalSolverIterations(2)
        .setCcdEnabled(true)
        .setCanSleep(true),
    );

    const halfWidth = VEHICLE_DIMENSIONS.width / 2;
    const halfHeight = VEHICLE_DIMENSIONS.chassisHeight / 2;
    const halfLength = VEHICLE_DIMENSIONS.length / 2;
    const mass = VEHICLE_TUNING.mass;
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(
        halfWidth - VEHICLE_TUNING.colliderBorderRadius,
        halfHeight - VEHICLE_TUNING.colliderBorderRadius,
        halfLength - VEHICLE_TUNING.colliderBorderRadius,
        VEHICLE_TUNING.colliderBorderRadius,
      )
        .setMassProperties(
          mass,
          { x: 0, y: VEHICLE_TUNING.centerOfMassOffset, z: 0 },
          {
            x:
              (mass / 12) *
              (VEHICLE_DIMENSIONS.chassisHeight ** 2 + VEHICLE_DIMENSIONS.length ** 2),
            y:
              (mass / 12) *
              (VEHICLE_DIMENSIONS.width ** 2 + VEHICLE_DIMENSIONS.length ** 2),
            z:
              (mass / 12) *
              (VEHICLE_DIMENSIONS.width ** 2 + VEHICLE_DIMENSIONS.chassisHeight ** 2),
          },
          { x: 0, y: 0, z: 0, w: 1 },
        )
        .setFriction(0.8)
        .setRestitution(0.08)
        .setContactSkin(0.02)
        .setActiveEvents(
          RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS,
        )
        .setCollisionGroups(PLAYER_COLLISION_GROUPS),
      body,
    );

    return { body, collider, spawnPoint };
  }
}
