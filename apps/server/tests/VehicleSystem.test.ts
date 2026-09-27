import RAPIER from '@dimforge/rapier3d-compat';
import {
  OVAL_TRACK_LAYOUT,
  PLAYER_COLLISION_TUNING,
  SIMULATION_FIXED_DELTA_SECONDS,
  STATIC_WORLD_BOXES,
  TRACK_LAP_LENGTH,
  createServerCodec,
  getTrackCenterlinePoint,
} from '@trailer-arena/shared';
import type { PlayerInputMessage } from '@trailer-arena/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { sanitizeVehicleInput } from '../src/vehicles/VehicleInput.js';
import {
  inputToRapierSteering,
  steeringStrengthAtSpeed,
} from '../src/vehicles/VehicleController.js';
import { VehicleSystem } from '../src/vehicles/VehicleSystem.js';
import { createRoomPhysicsWorld } from '../src/world/PhysicsWorldBuilder.js';

interface TestWorld {
  world: RAPIER.World;
  vehicles: VehicleSystem;
}

const activeWorlds: TestWorld[] = [];

beforeAll(async () => {
  await RAPIER.init();
});

afterEach(() => {
  for (const testWorld of activeWorlds) {
    testWorld.vehicles.dispose();
    testWorld.world.free();
  }
  activeWorlds.length = 0;
});

function createTestWorld(): TestWorld {
  const world = createRoomPhysicsWorld();
  const testWorld = { world, vehicles: new VehicleSystem(world) };
  activeWorlds.push(testWorld);
  return testWorld;
}

function input(
  sequence: number,
  values: Partial<Omit<PlayerInputMessage, 'type' | 'sequence'>> = {},
): PlayerInputMessage {
  return {
    type: 'player_input',
    sequence,
    throttle: values.throttle ?? 0,
    brake: values.brake ?? 0,
    steering: values.steering ?? 0,
    handbrake: values.handbrake ?? false,
  };
}

describe('vehicle input authority', () => {
  it('clamps finite inputs and neutralizes non-finite values', () => {
    expect(
      sanitizeVehicleInput({
        throttle: 4,
        brake: -2,
        steering: Number.POSITIVE_INFINITY,
        handbrake: true,
      }),
    ).toEqual({ throttle: 1, brake: 0, steering: 0, handbrake: true });
  });

  it('ignores an out-of-order input sequence', () => {
    const { vehicles } = createTestWorld();
    const vehicle = vehicles.spawnVehicle('player-a');

    expect(vehicles.applyPlayerInput('player-a', input(10, { throttle: 0.8 }))).toBe(
      true,
    );
    expect(vehicles.applyPlayerInput('player-a', input(9, { throttle: 0.1 }))).toBe(
      false,
    );

    expect(vehicle.inputSequence).toBe(10);
    expect(vehicle.input.throttle).toBe(0.8);
    expect(vehicle.createSnapshot().lastProcessedInputSequence).toBe(10);
  });

  it('includes the latest processed input sequence in world snapshots', () => {
    const { vehicles } = createTestWorld();
    vehicles.spawnVehicle('player-a');
    vehicles.applyPlayerInput('player-a', input(42, { throttle: 1 }));
    expect(vehicles.createSnapshot()[0]?.lastProcessedInputSequence).toBe(42);
  });

  it('applies input only to the vehicle owned by that player key', () => {
    const { vehicles } = createTestWorld();
    const first = vehicles.spawnVehicle('player-a');
    const second = vehicles.spawnVehicle('player-b');

    vehicles.applyPlayerInput('player-a', input(1, { throttle: 1, steering: -1 }));

    expect(first.input.throttle).toBe(1);
    expect(first.input.steering).toBe(-1);
    expect(second.input.throttle).toBe(0);
    expect(second.input.steering).toBe(0);
  });

  it('rejects malformed player_input payloads without throwing', () => {
    const codec = createServerCodec();
    const malformed = JSON.stringify({
      type: 'player_input',
      sequence: 1,
      throttle: null,
      brake: 0,
      steering: 0,
      handbrake: false,
    });

    expect(() => codec.decode(malformed)).not.toThrow();
    expect(codec.decode(malformed).ok).toBe(false);
  });

  it('rejects client attempts to send an authoritative position', () => {
    const codec = createServerCodec();
    expect(
      codec.decode(
        JSON.stringify({
          type: 'vehicle_state',
          position: [100, 100, 100],
          velocity: [100, 0, 0],
        }),
      ).ok,
    ).toBe(false);
  });
});

describe('steering convention', () => {
  it('maps forward left/right commands to Rapier wheel angles', () => {
    expect(inputToRapierSteering(-1)).toBe(1);
    expect(inputToRapierSteering(1)).toBe(-1);
  });

  it('keeps the axis conversion stable while crossing zero speed', () => {
    const sampledSpeeds = [-1, -0.5, 0, 0.5, 1];
    expect(sampledSpeeds.map(() => inputToRapierSteering(-1))).toEqual([1, 1, 1, 1, 1]);
    expect(sampledSpeeds.map(() => inputToRapierSteering(1))).toEqual([
      -1, -1, -1, -1, -1,
    ]);
  });

  it('curves a forward-moving vehicle left for A and right for D', () => {
    const leftWorld = createTestWorld();
    const rightWorld = createTestWorld();
    const leftVehicle = leftWorld.vehicles.spawnVehicle('left-player');
    const rightVehicle = rightWorld.vehicles.spawnVehicle('right-player');
    leftWorld.vehicles.applyPlayerInput(
      'left-player',
      input(1, { throttle: 1, steering: -1 }),
    );
    rightWorld.vehicles.applyPlayerInput(
      'right-player',
      input(1, { throttle: 1, steering: 1 }),
    );

    for (let tick = 0; tick < 150; tick += 1) {
      for (const testWorld of [leftWorld, rightWorld]) {
        testWorld.vehicles.update(SIMULATION_FIXED_DELTA_SECONDS);
        testWorld.vehicles.stepPhysics(SIMULATION_FIXED_DELTA_SECONDS);
      }
    }

    expect(leftVehicle.body.translation().z).toBeLessThan(
      rightVehicle.body.translation().z,
    );
  });

  it('curves a reverse-moving vehicle left for A and right for D', () => {
    const leftWorld = createTestWorld();
    const rightWorld = createTestWorld();
    const leftVehicle = leftWorld.vehicles.spawnVehicle('reverse-left-player');
    const rightVehicle = rightWorld.vehicles.spawnVehicle('reverse-right-player');
    leftWorld.vehicles.applyPlayerInput(
      'reverse-left-player',
      input(1, { brake: 1, steering: -1 }),
    );
    rightWorld.vehicles.applyPlayerInput(
      'reverse-right-player',
      input(1, { brake: 1, steering: 1 }),
    );

    for (let tick = 0; tick < 180; tick += 1) {
      for (const testWorld of [leftWorld, rightWorld]) {
        testWorld.vehicles.update(SIMULATION_FIXED_DELTA_SECONDS);
        testWorld.vehicles.stepPhysics(SIMULATION_FIXED_DELTA_SECONDS);
      }
    }

    expect(leftVehicle.createSnapshot().forwardSpeed).toBeLessThan(-0.5);
    expect(rightVehicle.createSnapshot().forwardSpeed).toBeLessThan(-0.5);
    expect(leftVehicle.body.translation().z).toBeLessThan(
      rightVehicle.body.translation().z,
    );
  });

  it('is agile at 20/40 km/h and progressively softens by 60 km/h', () => {
    const at20Kmh = steeringStrengthAtSpeed(20 / 3.6);
    const at40Kmh = steeringStrengthAtSpeed(40 / 3.6);
    const at60Kmh = steeringStrengthAtSpeed(60 / 3.6);

    expect(at20Kmh).toBeGreaterThan(0.29);
    expect(at40Kmh).toBeGreaterThan(0.24);
    expect(at60Kmh).toBeGreaterThan(0.18);
    expect(at20Kmh).toBeGreaterThan(at40Kmh);
    expect(at40Kmh).toBeGreaterThan(at60Kmh);
  });

  it('keeps steering and throttle authority while recovering from a RAM slide', () => {
    const { vehicles } = createTestWorld();
    const vehicle = vehicles.spawnVehicle('slide-control-player');
    vehicle.body.setTranslation({ x: 0, y: 1.15, z: 0 }, true);
    vehicle.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    vehicle.body.setLinvel({ x: 6, y: 0, z: 2 }, true);
    vehicle.startRamSlide();
    vehicles.applyPlayerInput(vehicle.playerId, input(1, { throttle: 1, steering: 1 }));

    for (let tick = 0; tick < 45; tick += 1) {
      vehicles.update(SIMULATION_FIXED_DELTA_SECONDS);
      vehicles.stepPhysics(SIMULATION_FIXED_DELTA_SECONDS);
    }

    const rotation = vehicle.body.rotation();
    const forwardX = 2 * (rotation.x * rotation.z + rotation.w * rotation.y);
    expect(Math.abs(forwardX)).toBeGreaterThan(0.05);
    expect(vehicle.input.throttle).toBe(1);
    expect(vehicle.input.steering).toBe(1);
    expect(vehicle.ramSlideGripMultiplier).toBeGreaterThan(
      PLAYER_COLLISION_TUNING.ramSlideInitialGripMultiplier,
    );
    expect(JSON.stringify(vehicle.createSnapshot())).not.toMatch(/NaN|Infinity/);
  });
});

describe('shared oval track layout', () => {
  it('has two long straights, broad turns, and a closed shared path', () => {
    expect(OVAL_TRACK_LAYOUT.straightLength).toBe(72);
    expect(OVAL_TRACK_LAYOUT.turnRadius).toBe(32);
    expect(OVAL_TRACK_LAYOUT.trackWidth).toBe(16);
    expect(TRACK_LAP_LENGTH).toBeCloseTo(345.06, 1);
    expect(getTrackCenterlinePoint(0).position).toEqual(
      getTrackCenterlinePoint(1).position,
    );
    expect(getTrackCenterlinePoint(0.25).position[0]).toBeGreaterThan(36);
    expect(getTrackCenterlinePoint(0.75).position[0]).toBeLessThan(-36);
  });

  it('leaves both asphalt edges open to the surrounding grass', () => {
    expect(STATIC_WORLD_BOXES.some((box) => box.kind === 'boundary')).toBe(false);
    expect(STATIC_WORLD_BOXES.some((box) => box.id.startsWith('track-'))).toBe(false);

    const { vehicles } = createTestWorld();
    const vehicle = vehicles.spawnVehicle('off-track-player');
    vehicle.body.setTranslation({ x: 0, y: 1.15, z: 39 }, true);
    vehicle.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    vehicle.body.setLinvel({ x: 0, y: 0, z: 5 }, true);
    vehicles.applyPlayerInput('off-track-player', input(1, { throttle: 1 }));

    for (let tick = 0; tick < 45; tick += 1) {
      vehicles.update(SIMULATION_FIXED_DELTA_SECONDS);
      vehicles.stepPhysics(SIMULATION_FIXED_DELTA_SECONDS);
    }

    expect(vehicle.body.translation().z).toBeGreaterThan(40.5);
    expect(vehicle.body.translation().y).toBeGreaterThan(0.5);
    expect(vehicle.createSnapshot().grounded).toBe(true);
  });

  it('supports a full server-authoritative physics lap on the open track', () => {
    const { vehicles } = createTestWorld();
    const vehicle = vehicles.spawnVehicle('lap-player');
    const sampleCount = 256;
    let previousSample = 0;
    let completedLap = false;
    let maximumSpeed = 0;

    for (let tick = 0; tick < 2_400 && !completedLap; tick += 1) {
      const position = vehicle.body.translation();
      let nearestSample = 0;
      let nearestDistanceSquared = Number.POSITIVE_INFINITY;
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        const sample = getTrackCenterlinePoint(sampleIndex / sampleCount).position;
        const deltaX = sample[0] - position.x;
        const deltaZ = sample[2] - position.z;
        const distanceSquared = deltaX * deltaX + deltaZ * deltaZ;
        if (distanceSquared < nearestDistanceSquared) {
          nearestDistanceSquared = distanceSquared;
          nearestSample = sampleIndex;
        }
      }

      const target = getTrackCenterlinePoint(
        ((nearestSample + 10) % sampleCount) / sampleCount,
      ).position;
      const targetX = target[0] - position.x;
      const targetZ = target[2] - position.z;
      const targetLength = Math.max(0.001, Math.hypot(targetX, targetZ));
      const rotation = vehicle.body.rotation();
      const forwardX = 2 * (rotation.x * rotation.z + rotation.w * rotation.y);
      const forwardZ = 1 - 2 * (rotation.x ** 2 + rotation.y ** 2);
      const desiredX = targetX / targetLength;
      const desiredZ = targetZ / targetLength;
      const signedAngle = Math.atan2(
        forwardX * desiredZ - forwardZ * desiredX,
        forwardX * desiredX + forwardZ * desiredZ,
      );
      const steering = Math.max(-1, Math.min(1, signedAngle * 1.8));

      vehicles.applyPlayerInput('lap-player', input(tick, { throttle: 1, steering }));
      vehicles.update(SIMULATION_FIXED_DELTA_SECONDS);
      vehicles.stepPhysics(SIMULATION_FIXED_DELTA_SECONDS);

      maximumSpeed = Math.max(maximumSpeed, vehicle.createSnapshot().forwardSpeed);
      if (tick > 120 && previousSample > 220 && nearestSample < 30) {
        completedLap = true;
      }
      previousSample = nearestSample;
    }

    expect(completedLap).toBe(true);
    expect(maximumSpeed * 3.6).toBeGreaterThan(60);
  });
});

describe('VehicleSystem lifecycle and physics', () => {
  it('creates a dynamic physical vehicle entity', () => {
    const { vehicles } = createTestWorld();

    const vehicle = vehicles.spawnVehicle('player-a');

    expect(vehicles.vehicleCount).toBe(1);
    expect(vehicle.body.isDynamic()).toBe(true);
    expect(vehicle.collider.parent()?.handle).toBe(vehicle.body.handle);
  });

  it('removes the vehicle when its player leaves', () => {
    const { vehicles } = createTestWorld();
    vehicles.spawnVehicle('player-a');

    expect(vehicles.removeVehicle('player-a')).toBe(true);

    expect(vehicles.vehicleCount).toBe(0);
    expect(vehicles.getVehicle('player-a')).toBeUndefined();
  });

  it('resets a fallen vehicle to its spawn with zero velocity', () => {
    const { vehicles } = createTestWorld();
    const vehicle = vehicles.spawnVehicle('player-a');
    const initialPosition = { ...vehicle.body.translation() };
    vehicle.body.setTranslation({ x: 8, y: -20, z: 4 }, true);
    vehicle.body.setLinvel({ x: 5, y: -3, z: 7 }, true);
    vehicle.body.setAngvel({ x: 1, y: 2, z: 3 }, true);

    vehicles.afterPhysicsStep();

    const position = vehicle.body.translation();
    expect(position.x).toBeCloseTo(initialPosition.x, 5);
    expect(position.y).toBeCloseTo(initialPosition.y, 5);
    expect(position.z).toBeCloseTo(initialPosition.z, 5);
    expect(vehicle.body.linvel()).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(vehicle.body.angvel()).toMatchObject({ x: 0, y: 0, z: 0 });
  });

  it('accelerates forward after deterministic throttle ticks', () => {
    const { vehicles } = createTestWorld();
    const vehicle = vehicles.spawnVehicle('player-a');
    vehicles.applyPlayerInput('player-a', input(1, { throttle: 1 }));

    for (let tick = 0; tick < 120; tick += 1) {
      vehicles.update(SIMULATION_FIXED_DELTA_SECONDS);
      vehicles.stepPhysics(SIMULATION_FIXED_DELTA_SECONDS);
    }

    expect(vehicle.createSnapshot().grounded).toBe(true);
    expect(vehicle.createSnapshot().forwardSpeed).toBeGreaterThan(0.5);
  });

  it('drives over the test ramp and is stopped by the physical barrier', () => {
    const { vehicles } = createTestWorld();
    const vehicle = vehicles.spawnVehicle('player-a');
    vehicle.body.setTranslation({ x: 0, y: 1.15, z: -6 }, true);
    vehicle.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    vehicles.applyPlayerInput('player-a', input(1, { throttle: 1 }));

    for (let tick = 0; tick < 240; tick += 1) {
      vehicles.update(SIMULATION_FIXED_DELTA_SECONDS);
      vehicles.stepPhysics(SIMULATION_FIXED_DELTA_SECONDS);
    }

    const snapshot = vehicle.createSnapshot();
    expect(Math.abs(snapshot.position[0])).toBeLessThan(1);
    expect(snapshot.position[2]).toBeGreaterThan(4);
    expect(snapshot.position[2]).toBeLessThan(5.5);
    expect(snapshot.position[1]).toBeGreaterThan(0.6);
    expect(snapshot.position[1]).toBeLessThan(2);
    expect(Math.abs(snapshot.forwardSpeed)).toBeLessThan(0.5);
  });

  it('keeps vehicle-to-vehicle collision and momentum on the server', () => {
    const { vehicles } = createTestWorld();
    const first = vehicles.spawnVehicle('player-a');
    const second = vehicles.spawnVehicle('player-b');
    first.body.setTranslation({ x: -20, y: 1, z: -3 }, true);
    first.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    first.body.setLinvel({ x: 0, y: 0, z: 5 }, true);
    second.body.setTranslation({ x: -20, y: 1, z: 3 }, true);
    second.body.setRotation({ x: 0, y: 1, z: 0, w: 0 }, true);
    second.body.setLinvel({ x: 0, y: 0, z: -5 }, true);

    for (let tick = 0; tick < 75; tick += 1) {
      vehicles.update(SIMULATION_FIXED_DELTA_SECONDS);
      vehicles.stepPhysics(SIMULATION_FIXED_DELTA_SECONDS);
    }

    const impact = vehicles.lastPlayerImpact;
    expect(first.body.translation().z).toBeLessThan(second.body.translation().z);
    expect(impact).not.toBeNull();
    expect(impact?.targetArcadeDeltaVelocity).toBeGreaterThan(0);
    expect(impact?.targetArcadeDeltaVelocity).toBeLessThanOrEqual(
      PLAYER_COLLISION_TUNING.ramMaximumTargetDeltaVelocity,
    );
    expect([first.body.linvel().z, second.body.linvel().z].every(Number.isFinite)).toBe(
      true,
    );
    expect(Math.abs(first.body.linvel().z)).toBeLessThan(18);
    expect(Math.abs(second.body.linvel().z)).toBeLessThan(18);
  });
});
