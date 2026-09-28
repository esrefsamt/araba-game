import RAPIER from '@dimforge/rapier3d-compat';
import {
  CLIENT_PREDICTION_FIXED_DELTA_SECONDS as DT,
  VEHICLE_SPAWN_POINTS,
  createClientCodec,
  createServerCodec,
} from '@trailer-arena/shared';
import type { VehicleInputState, VehicleStateSnapshot } from '@trailer-arena/shared';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';

import { VehicleSystem } from '../../server/src/vehicles/VehicleSystem.js';
import { createRoomPhysicsWorld } from '../../server/src/world/PhysicsWorldBuilder.js';
import { visualSteeringAngle } from '../src/entities/WheelVisualKinematics.js';
import { AuthoritativePredictionProxy } from '../src/prediction/AuthoritativePredictionProxy.js';

const UP = new THREE.Vector3(0, 1, 0);

beforeAll(async () => {
  await RAPIER.init();
});

describe('online steering parity', () => {
  it.each([-1, 1])('preserves A/D sign through the network codec (%s)', (steering) => {
    const message = {
      type: 'player_input' as const,
      sequence: 12,
      throttle: 1,
      brake: 0,
      steering,
      handbrake: false,
    };
    const decoded = createServerCodec().decode(createClientCodec().encode(message));
    expect(decoded).toEqual({ ok: true, value: message });
  });

  it.each(
    [0, Math.PI / 2].flatMap((yaw) =>
      [-8, 8].flatMap((speed) => [-1, 1].map((steering) => ({ yaw, speed, steering }))),
    ),
  )('matches server on first steering press: %j', ({ yaw, speed, steering }) => {
    const world = createRoomPhysicsWorld();
    const vehicles = new VehicleSystem(world);
    try {
      const rotation = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
      const vehicle = vehicles.spawnVehicle('driver', {
        position: [...VEHICLE_SPAWN_POINTS[0]!.position],
        rotation: rotation.toArray(),
      });
      for (let tick = 0; tick < 90; tick += 1) {
        vehicles.update(DT);
        vehicles.stepPhysics(DT);
      }
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
      const right = forward.clone().cross(UP);
      vehicle.body.setLinvel(forward.clone().multiplyScalar(speed), true);
      vehicles.update(DT);
      vehicles.stepPhysics(DT);
      const base = vehicle.createSnapshot();
      expect(base.grounded).toBe(true);

      const prediction = new AuthoritativePredictionProxy();
      prediction.resyncFromAuthoritativeState(base);
      prediction.setActive(true);
      const input: VehicleInputState = {
        throttle: 0,
        brake: 0,
        steering,
        handbrake: false,
      };
      // A 100 ms one-way delay gives the client a 100 ms visual lead.
      const predicted = prediction.update(DT, input, base, 0.1, null);
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
      for (const [source, state] of [
        ['server', authoritative],
        ['prediction', predicted],
      ] as const) {
        expect(
          signedHeading(state, right) * steering * Math.sign(speed),
          source + ' heading',
        ).toBeGreaterThan(0);
      }

      const wheelHeading = new THREE.Vector3(0, 0, 1)
        .applyAxisAngle(UP, visualSteeringAngle(steering, speed))
        .applyQuaternion(rotation);
      expect(wheelHeading.dot(right) * steering).toBeGreaterThan(0);
    } finally {
      vehicles.dispose();
      world.free();
    }
  });

  it.each([0, 50, 100, 150])(
    'steers correctly across neutral and rapid A/D transitions at %i ms one-way latency',
    (latencyMs) => {
      const base = vehicleSnapshot();
      const right = new THREE.Vector3(-1, 0, 0);
      const prediction = new AuthoritativePredictionProxy();
      prediction.resyncFromAuthoritativeState(base);
      prediction.setActive(true);
      for (const steering of [0, 1, 1, 0, -1, -1, 0, 1, 0, -1]) {
        const input: VehicleInputState = {
          throttle: 0,
          brake: 0,
          steering,
          handbrake: false,
        };
        const visual = prediction.update(DT, input, base, latencyMs / 1_000, null);
        if (latencyMs === 0) {
          expect(visual.rotation).toEqual(base.rotation);
        } else if (steering !== 0) {
          expect(signedHeading(visual, right) * steering).toBeGreaterThan(0);
        } else {
          expect(visual.rotation).toEqual(base.rotation);
        }
        expect(prediction.metrics.visualCorrectionOffset).toBe(0);
      }
    },
  );
});

function signedHeading(state: VehicleStateSnapshot, right: THREE.Vector3): number {
  return new THREE.Vector3(0, 0, 1)
    .applyQuaternion(new THREE.Quaternion().fromArray(state.rotation))
    .dot(right);
}

function vehicleSnapshot(): VehicleStateSnapshot {
  return {
    playerId: 'driver',
    lastProcessedInputSequence: -1,
    position: [0, 1, 0],
    rotation: [0, 0, 0, 1],
    linearVelocity: [0, 0, 8],
    angularVelocity: [0, 0, 0],
    forwardSpeed: 8,
    lateralSpeed: 0,
    grounded: true,
    surfaceType: 'GROUND',
    onTrailer: false,
    relativeForwardSpeed: 8,
    relativeLateralSpeed: 0,
    wheelContacts: 4,
    trailerDeckContacts: 0,
    trailerRelativePosition: [0, 0, 0],
    flipped: false,
    selfRightAvailable: false,
    ramSlideRemainingTicks: 0,
  };
}
