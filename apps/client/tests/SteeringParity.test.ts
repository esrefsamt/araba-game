import RAPIER from '@dimforge/rapier3d-compat';
import {
  CLIENT_PREDICTION_FIXED_DELTA_SECONDS as DT,
  VEHICLE_SPAWN_POINTS,
} from '@trailer-arena/shared';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';

import { VehicleSystem } from '../../server/src/vehicles/VehicleSystem.js';
import { createRoomPhysicsWorld } from '../../server/src/world/PhysicsWorldBuilder.js';
import { visualSteeringAngle } from '../src/entities/WheelVisualKinematics.js';
import { AuthoritativePredictionProxy } from '../src/prediction/AuthoritativePredictionProxy.js';

beforeAll(async () => {
  await RAPIER.init();
});

describe('online steering direction parity', () => {
  it.each(
    [0, Math.PI / 2].flatMap((yaw) =>
      [-8, 8].flatMap((speed) => [-1, 1].map((steering) => ({ yaw, speed, steering }))),
    ),
  )('matches Rapier on the first press: %j', ({ yaw, speed, steering }) => {
    const world = createRoomPhysicsWorld();
    const vehicles = new VehicleSystem(world);
    try {
      const rotation = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        yaw,
      );
      const vehicle = vehicles.spawnVehicle('driver', {
        position: [...VEHICLE_SPAWN_POINTS[0]!.position],
        rotation: rotation.toArray(),
      });
      for (let tick = 0; tick < 90; tick += 1) {
        vehicles.update(DT);
        vehicles.stepPhysics(DT);
      }
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
      // Camera/driver right is forward cross world-up when looking along +Z.
      const right = forward.clone().cross(new THREE.Vector3(0, 1, 0));
      vehicle.body.setLinvel(forward.clone().multiplyScalar(speed), true);
      vehicles.update(DT);
      vehicles.stepPhysics(DT);
      const base = vehicle.createSnapshot();
      expect(base.grounded).toBe(true);

      const proxy = new AuthoritativePredictionProxy();
      proxy.resyncFromAuthoritativeState(base);
      proxy.setActive(true);
      const input = { throttle: 0, brake: 0, steering, handbrake: false };
      proxy.update(DT, { ...input, steering: 0 }, base, 0.1, null);
      const predicted = proxy.update(DT, input, base, 0.1, null);
      vehicles.applyPlayerInput('driver', {
        type: 'player_input',
        sequence: 1,
        ...input,
      });
      for (let tick = 0; tick < 6; tick += 1) {
        vehicles.update(DT);
        vehicles.stepPhysics(DT);
      }
      const authoritative = vehicle.createSnapshot();
      for (const [name, state] of [
        ['server', authoritative],
        ['prediction', predicted],
      ] as const) {
        const displacement = new THREE.Vector3()
          .fromArray(state.position)
          .sub(new THREE.Vector3().fromArray(base.position));
        const heading = new THREE.Vector3(0, 0, 1).applyQuaternion(
          new THREE.Quaternion().fromArray(state.rotation),
        );
        if (speed > 0) {
          expect(
            displacement.dot(right) * steering,
            name + ' displacement',
          ).toBeGreaterThan(0);
        }
        // In reverse the front tire impulse can briefly move the chassis
        // sideways before the arc develops; heading must still match Rapier.
        expect(
          heading.dot(right) * steering * Math.sign(speed),
          name + ' heading',
        ).toBeGreaterThan(0);
      }
      const wheelHeading = new THREE.Vector3(0, 0, 1)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), visualSteeringAngle(steering, speed))
        .applyQuaternion(rotation);
      expect(wheelHeading.dot(right) * steering).toBeGreaterThan(0);
    } finally {
      vehicles.dispose();
      world.free();
    }
  });
});
