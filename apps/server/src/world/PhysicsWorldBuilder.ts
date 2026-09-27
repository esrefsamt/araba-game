import RAPIER from '@dimforge/rapier3d-compat';
import { STATIC_WORLD_BOXES } from '@trailer-arena/shared';

import { WORLD_COLLISION_GROUPS } from '../physics/CollisionGroups.js';
import { SurfaceRegistry } from '../physics/SurfaceRegistry.js';

export interface RoomPhysicsContext {
  readonly world: RAPIER.World;
  readonly surfaces: SurfaceRegistry;
}

export function createRoomPhysicsContext(): RoomPhysicsContext {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const surfaces = new SurfaceRegistry();

  for (const box of STATIC_WORLD_BOXES) {
    const [x, y, z] = box.position;
    const [halfX, halfY, halfZ] = box.halfExtents;
    const [rotationX, rotationY, rotationZ, rotationW] = box.rotation;
    const collider = RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ)
      .setTranslation(x, y, z)
      .setRotation({
        x: rotationX,
        y: rotationY,
        z: rotationZ,
        w: rotationW,
      })
      .setFriction(box.friction)
      .setRestitution(0.05)
      .setCollisionGroups(WORLD_COLLISION_GROUPS);
    surfaces.registerGround(world.createCollider(collider));
  }

  return { world, surfaces };
}

export function createRoomPhysicsWorld(): RAPIER.World {
  return createRoomPhysicsContext().world;
}
