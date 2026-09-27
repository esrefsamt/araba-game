import RAPIER from '@dimforge/rapier3d-compat';
import { VEHICLE_DIMENSIONS, VEHICLE_SPAWN_POINTS } from '@trailer-arena/shared';
import type { VehicleSpawnPoint } from '@trailer-arena/shared';

/** Spawn policy only: the regular chassis/controller/collision tuning stays unchanged. */
export function selectRoomSpawn(world: RAPIER.World): VehicleSpawnPoint {
  const clearance = new RAPIER.Cuboid(
    VEHICLE_DIMENSIONS.width / 2 + 0.1,
    VEHICLE_DIMENSIONS.chassisHeight / 2 + 0.1,
    VEHICLE_DIMENSIONS.length / 2 + 0.1,
  );
  // Try the normal grid first; bounded extra rows cover a convoy blocking its last free slot.
  for (let extraRow = 0; extraRow <= 8; extraRow += 1) {
    for (const point of VEHICLE_SPAWN_POINTS) {
      const [x, y, z] = point.position;
      const [, ry, , rw] = point.rotation;
      const distance = extraRow * (VEHICLE_DIMENSIONS.length + 1.2);
      const position = {
        x: x - 2 * ry * rw * distance,
        y,
        z: z - (1 - 2 * ry * ry) * distance,
      };
      const [qx, qy, qz, qw] = point.rotation;
      const rotation = { x: qx, y: qy, z: qz, w: qw };
      let occupied = false;
      // Direct collider queries also see players created since the last physics tick.
      world.forEachCollider((collider) => {
        if (
          !occupied &&
          !collider.isSensor() &&
          collider.intersectsShape(clearance, position, rotation)
        )
          occupied = true;
      });
      if (!occupied)
        return {
          position: [position.x, position.y, position.z],
          rotation: point.rotation,
        };
    }
  }
  throw new Error('No unobstructed room spawn is currently available.');
}
