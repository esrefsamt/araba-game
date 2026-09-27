import RAPIER from '@dimforge/rapier3d-compat';
import { INFIELD_LAYOUT, getInfieldTransform } from '@trailer-arena/shared';

import { WORLD_COLLISION_GROUPS } from '../physics/CollisionGroups.js';
import type { SurfaceRegistry } from '../physics/SurfaceRegistry.js';

export function addInfieldColliders(
  world: RAPIER.World,
  surfaces: SurfaceRegistry,
): ReadonlyMap<string, RAPIER.Collider> {
  const colliders = new Map<string, RAPIER.Collider>();
  for (const element of INFIELD_LAYOUT) {
    if (!element.collision) continue;
    const {
      position: [x, y, z],
      rotation: [qx, qy, qz, qw],
      size: [width, height, depth],
    } = getInfieldTransform(element);
    const shape =
      element.geometry === 'cylinder'
        ? RAPIER.ColliderDesc.cylinder(height / 2, width / 2)
        : RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2);
    const collider = world.createCollider(
      shape
        .setTranslation(x, y, z)
        .setRotation({ x: qx, y: qy, z: qz, w: qw })
        .setFriction(0.8)
        .setRestitution(0.02)
        .setCollisionGroups(WORLD_COLLISION_GROUPS),
    );
    surfaces.registerGround(collider);
    colliders.set(element.id, collider);
  }
  return colliders;
}
