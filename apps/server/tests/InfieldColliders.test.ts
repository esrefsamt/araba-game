import RAPIER from '@dimforge/rapier3d-compat';
import {
  INFIELD_LAYOUT,
  SIMULATION_FIXED_DELTA_SECONDS as DT,
  STATIC_WORLD_BOXES,
} from '@trailer-arena/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { WORLD_COLLISION_GROUPS } from '../src/physics/CollisionGroups.js';
import { VehicleSystem } from '../src/vehicles/VehicleSystem.js';
import { createRoomPhysicsContext } from '../src/world/PhysicsWorldBuilder.js';

const contexts: ReturnType<typeof createRoomPhysicsContext>[] = [];
const systems: VehicleSystem[] = [];
beforeAll(async () => {
  await RAPIER.init();
});
afterEach(() => {
  for (const vehicles of systems) vehicles.dispose();
  for (const { world } of contexts) world.free();
  systems.length = 0;
  contexts.length = 0;
});
function context() {
  const result = createRoomPhysicsContext();
  contexts.push(result);
  return result;
}

describe('authoritative infield collision coverage', () => {
  it('creates only collision-enabled visible solids, with static low-bounce world contacts', () => {
    const { world, surfaces, infieldColliders } = context();
    expect([...infieldColliders.keys()]).toEqual(
      INFIELD_LAYOUT.filter((element) => element.collision).map((element) => element.id),
    );
    expect(world.colliders.len()).toBe(STATIC_WORLD_BOXES.length + infieldColliders.size);
    for (const collider of infieldColliders.values()) {
      expect(collider.parent()).toBeNull();
      expect(collider.isSensor()).toBe(false);
      expect(collider.restitution()).toBeCloseTo(0.02);
      expect(collider.collisionGroups()).toBe(WORLD_COLLISION_GROUPS);
      expect(surfaces.get(collider)?.type).toBe('GROUND');
      expect(surfaces.get(collider)?.movingBody).toBeNull();
    }
    for (const element of INFIELD_LAYOUT.filter((item) => !item.collision))
      expect(infieldColliders.has(element.id)).toBe(false);
  });

  it.each([
    { name: 'cross service road', start: [-40, -6], end: [40, -6], yaw: Math.PI / 2 },
    { name: 'west access', start: [-38, -6], end: [-38, 16], yaw: 0 },
    { name: 'east access', start: [38, -6], end: [38, 7], yaw: 0 },
    { name: 'paddock access', start: [10, 3], end: [37, 3], yaw: Math.PI / 2 },
    { name: 'tent open front', start: [24, 6], end: [24, 11.2], yaw: 0 },
  ])(
    'keeps the car-sized $name corridor free of invisible obstacles',
    ({ start, end, yaw }) => {
      const { world } = context();
      world.step();
      const hit = world.castShape(
        { x: start[0]!, y: 1, z: start[1]! },
        { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
        { x: end[0]! - start[0]!, y: 0, z: end[1]! - start[1]! },
        new RAPIER.Cuboid(0.92, 0.39, 1.95),
        0,
        1,
        true,
      );
      expect(hit).toBeNull();
    },
  );

  it('hits a visible tent post while leaving the roof footprint open below it', () => {
    const { infieldColliders } = context();
    const post = infieldColliders.get('team-tent-1-post-1--1')!;
    expect(post.containsPoint({ x: 27.1, y: 1, z: 10.6 })).toBe(true);
    expect(infieldColliders.has('team-tent-1-roof')).toBe(false);
  });
});

describe('player collisions with infield props', () => {
  const obstacles = [
    { id: 'service-garage-0', approach: 1 },
    { id: 'maintenance-van', approach: -1 },
    { id: 'service-tires-a', approach: 1 },
    { id: 'service-crate', approach: 1 },
    { id: 'timing-tower-base', approach: -1 },
  ];
  it.each(
    obstacles.flatMap((obstacle) => [6, 21].map((speed) => ({ ...obstacle, speed }))),
  )(
    'blocks a $speed m/s player at $id without launching it, then allows reverse escape',
    ({ id, approach, speed }) => {
      const { world, surfaces, infieldColliders } = context();
      const vehicles = new VehicleSystem(world, surfaces);
      systems.push(vehicles);
      const vehicle = vehicles.spawnVehicle('driver');
      const element = INFIELD_LAYOUT.find((item) => item.id === id)!;
      const [x, , z] = element.position;
      const face = z + (approach * element.size[2]) / 2;
      vehicles.teleportVehicle('driver', {
        position: [x, 0.86, face + approach * 5.8],
        rotation: approach === 1 ? [0, 1, 0, 0] : [0, 0, 0, 1],
      });
      vehicle.body.setLinvel({ x: 0, y: 0, z: -approach * speed }, true);
      vehicles.applyPlayerInput('driver', {
        type: 'player_input',
        sequence: 1,
        throttle: 1,
        brake: 0,
        steering: 0,
        handbrake: false,
      });
      let touched = false;
      for (let tick = 0; tick < 150; tick += 1) {
        vehicles.update(DT);
        vehicles.stepPhysics(DT);
        world.contactPairsWith(infieldColliders.get(id)!, (other) => {
          if (other.handle === vehicle.collider.handle) touched = true;
        });
        const position = vehicle.body.translation();
        expect(position.y).toBeLessThan(3.5);
        expect(Math.abs(vehicle.body.linvel().y)).toBeLessThan(12);
        expect(approach * (position.z - face), id).toBeGreaterThan(0.8);
      }
      expect(touched).toBe(true);
      expect(vehicles.drainPlayerImpacts()).toEqual([]);
      const contactPosition = vehicle.body.translation();
      vehicles.applyPlayerInput('driver', {
        type: 'player_input',
        sequence: 2,
        throttle: 0,
        brake: 1,
        steering: 0,
        handbrake: false,
      });
      for (let tick = 0; tick < 180; tick += 1) {
        vehicles.update(DT);
        vehicles.stepPhysics(DT);
      }
      expect(
        approach * (vehicle.body.translation().z - contactPosition.z),
      ).toBeGreaterThan(2);
      const propPosition = infieldColliders.get(id)!.translation();
      expect(propPosition.x).toBeCloseTo(x);
      expect(propPosition.z).toBeCloseTo(z);
    },
  );
});
