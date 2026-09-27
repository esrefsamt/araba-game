import RAPIER from '@dimforge/rapier3d-compat';
import {
  TRAILER_DIMENSIONS,
  TRAILER_RAMP_ANGLE,
  TRAILER_RAMP_GEOMETRY,
  TRUCK_DIMENSIONS,
} from '@trailer-arena/shared';
import type { QuaternionTuple, Vector3Tuple } from '@trailer-arena/shared';

import { CONVOY_COLLISION_GROUPS } from '../physics/CollisionGroups.js';

export interface ConvoyBodies {
  readonly truckBody: RAPIER.RigidBody;
  readonly trailerBody: RAPIER.RigidBody;
  readonly truckColliders: readonly RAPIER.Collider[];
  readonly trailerColliders: readonly RAPIER.Collider[];
  readonly trailerSurfaceColliders: readonly RAPIER.Collider[];
  readonly trailerDeckCollider: RAPIER.Collider;
  readonly trailerRampCollider: RAPIER.Collider;
}

export function createConvoyBodies(
  world: RAPIER.World,
  truckPosition: Vector3Tuple,
  truckRotation: QuaternionTuple,
  trailerPosition: Vector3Tuple,
  trailerRotation: QuaternionTuple,
): ConvoyBodies {
  const truckBody = createKinematicBody(world, truckPosition, truckRotation);
  const trailerBody = createKinematicBody(world, trailerPosition, trailerRotation);

  const truckColliders = [
    createAttachedCuboid(
      world,
      truckBody,
      [TRUCK_DIMENSIONS.width / 2, 0.55, TRUCK_DIMENSIONS.length / 2],
      [0, 0.75, 0],
    ),
    createAttachedCuboid(
      world,
      truckBody,
      [TRUCK_DIMENSIONS.width / 2 - 0.1, 1.25, 1.65],
      [0, 2.0, 1.15],
    ),
    createAttachedCuboid(world, truckBody, [0.95, 0.3, 0.7], [0, 0.7, -3.65]),
  ];

  const deck = createAttachedCuboid(
    world,
    trailerBody,
    [
      TRAILER_DIMENSIONS.deckWidth / 2,
      TRAILER_DIMENSIONS.deckThickness / 2,
      TRAILER_DIMENSIONS.deckLength / 2,
    ],
    [0, TRAILER_DIMENSIONS.deckHeight, 0],
    undefined,
    0.93,
  );
  const rampRotation: QuaternionTuple = [
    Math.sin(-TRAILER_RAMP_ANGLE / 2),
    0,
    0,
    Math.cos(-TRAILER_RAMP_ANGLE / 2),
  ];
  const ramp = createAttachedCuboid(
    world,
    trailerBody,
    [
      TRAILER_DIMENSIONS.deckWidth / 2 - 0.08,
      TRAILER_DIMENSIONS.rampThickness / 2,
      TRAILER_DIMENSIONS.rampLength / 2,
    ],
    [0, TRAILER_RAMP_GEOMETRY.centerY, TRAILER_RAMP_GEOMETRY.centerZ],
    rampRotation,
    0.93,
  );

  const lipY =
    TRAILER_DIMENSIONS.deckHeight +
    TRAILER_DIMENSIONS.deckThickness / 2 +
    TRAILER_DIMENSIONS.sideLipHeight / 2;
  const lipX = TRAILER_DIMENSIONS.deckWidth / 2 - TRAILER_DIMENSIONS.sideLipThickness / 2;
  const leftLip = createAttachedCuboid(
    world,
    trailerBody,
    [
      TRAILER_DIMENSIONS.sideLipThickness / 2,
      TRAILER_DIMENSIONS.sideLipHeight / 2,
      TRAILER_DIMENSIONS.deckLength / 2,
    ],
    [lipX, lipY, 0],
  );
  const rightLip = createAttachedCuboid(
    world,
    trailerBody,
    [
      TRAILER_DIMENSIONS.sideLipThickness / 2,
      TRAILER_DIMENSIONS.sideLipHeight / 2,
      TRAILER_DIMENSIONS.deckLength / 2,
    ],
    [-lipX, lipY, 0],
  );
  const frontBarrier = createAttachedCuboid(
    world,
    trailerBody,
    [
      TRAILER_DIMENSIONS.deckWidth / 2,
      TRAILER_DIMENSIONS.frontBarrierHeight / 2,
      TRAILER_DIMENSIONS.frontBarrierThickness / 2,
    ],
    [
      0,
      TRAILER_DIMENSIONS.deckHeight +
        TRAILER_DIMENSIONS.deckThickness / 2 +
        TRAILER_DIMENSIONS.frontBarrierHeight / 2,
      TRAILER_DIMENSIONS.deckLength / 2 - TRAILER_DIMENSIONS.frontBarrierThickness / 2,
    ],
  );
  const hitch = createAttachedCuboid(
    world,
    trailerBody,
    [0.55, 0.25, 0.8],
    [0, 0.68, TRAILER_DIMENSIONS.deckLength / 2 + 0.8],
  );
  const underbody = createAttachedCuboid(
    world,
    trailerBody,
    [
      TRAILER_DIMENSIONS.underbodyWidth / 2,
      TRAILER_DIMENSIONS.underbodyHeight / 2,
      TRAILER_DIMENSIONS.underbodyLength / 2,
    ],
    [0, TRAILER_DIMENSIONS.underbodyCenterY, TRAILER_DIMENSIONS.underbodyCenterZ],
  );
  const couplingRailLength = Math.hypot(2.5, 2.1);
  const couplingRailYaw = Math.atan2(2.5, -2.1);
  const leftCouplingRail = createAttachedCuboid(
    world,
    trailerBody,
    [0.18, 0.28, couplingRailLength / 2],
    [1.75, 0.68, 8.45],
    [0, Math.sin(couplingRailYaw / 2), 0, Math.cos(couplingRailYaw / 2)],
  );
  const rightCouplingRail = createAttachedCuboid(
    world,
    trailerBody,
    [0.18, 0.28, couplingRailLength / 2],
    [-1.75, 0.68, 8.45],
    [0, Math.sin(-couplingRailYaw / 2), 0, Math.cos(-couplingRailYaw / 2)],
  );

  return {
    truckBody,
    trailerBody,
    truckColliders,
    trailerColliders: [
      deck,
      ramp,
      leftLip,
      rightLip,
      frontBarrier,
      hitch,
      underbody,
      leftCouplingRail,
      rightCouplingRail,
    ],
    trailerSurfaceColliders: [deck, ramp],
    trailerDeckCollider: deck,
    trailerRampCollider: ramp,
  };
}

function createKinematicBody(
  world: RAPIER.World,
  position: Vector3Tuple,
  rotation: QuaternionTuple,
): RAPIER.RigidBody {
  return world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(position[0], position[1], position[2])
      .setRotation({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] })
      .setCcdEnabled(true),
  );
}

function createAttachedCuboid(
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  halfExtents: Vector3Tuple,
  translation: Vector3Tuple,
  rotation?: QuaternionTuple,
  friction = 0.8,
): RAPIER.Collider {
  const descriptor = RAPIER.ColliderDesc.cuboid(...halfExtents)
    .setTranslation(...translation)
    .setFriction(friction)
    .setRestitution(0.02)
    .setContactSkin(0.01)
    .setCollisionGroups(CONVOY_COLLISION_GROUPS);
  if (rotation !== undefined) {
    descriptor.setRotation({
      x: rotation[0],
      y: rotation[1],
      z: rotation[2],
      w: rotation[3],
    });
  }
  return world.createCollider(descriptor, body);
}
