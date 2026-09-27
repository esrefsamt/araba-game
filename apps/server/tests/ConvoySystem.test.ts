import RAPIER from '@dimforge/rapier3d-compat';
import {
  CONVOY_TUNING,
  SIMULATION_FIXED_DELTA_SECONDS,
  TRACK_LAP_LENGTH,
  TRAILER_DIMENSIONS,
  TRAILER_RAMP_ANGLE,
  TRAILER_RAMP_GEOMETRY,
  TRUCK_DIMENSIONS,
  VEHICLE_RECOVERY_TUNING,
  createClientCodec,
  getTrackCenterlinePoint,
} from '@trailer-arena/shared';
import type { Vector3Tuple, WorldSnapshotMessage } from '@trailer-arena/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ConvoySystem } from '../src/convoy/ConvoySystem.js';
import { sampleConvoyPath } from '../src/convoy/ConvoyPath.js';
import { ServerPlayer } from '../src/players/ServerPlayer.js';
import { GameRoom } from '../src/rooms/GameRoom.js';
import { VehicleSystem } from '../src/vehicles/VehicleSystem.js';
import { isVehicleFlipped, vehicleUpDot } from '../src/vehicles/VehicleRecovery.js';
import { createRoomPhysicsContext } from '../src/world/PhysicsWorldBuilder.js';

interface TestArena {
  world: RAPIER.World;
  convoy: ConvoySystem;
  vehicles: VehicleSystem;
}

const arenas: TestArena[] = [];
const rooms: GameRoom[] = [];

beforeAll(async () => {
  await RAPIER.init();
});

afterEach(() => {
  for (const room of rooms) room.dispose();
  rooms.length = 0;
  for (const arena of arenas) {
    arena.vehicles.dispose();
    arena.convoy.dispose();
    arena.world.free();
  }
  arenas.length = 0;
});

function createArena(): TestArena {
  const physics = createRoomPhysicsContext();
  const arena = {
    world: physics.world,
    convoy: new ConvoySystem(physics.world, physics.surfaces),
    vehicles: new VehicleSystem(physics.world, physics.surfaces),
  };
  arenas.push(arena);
  return arena;
}

function stepArena(arena: TestArena, ticks = 1): void {
  for (let tick = 0; tick < ticks; tick += 1) {
    arena.convoy.updateBeforePhysics(SIMULATION_FIXED_DELTA_SECONDS);
    arena.vehicles.update(SIMULATION_FIXED_DELTA_SECONDS);
    arena.vehicles.stepPhysics(SIMULATION_FIXED_DELTA_SECONDS);
  }
}

function stepVehiclePhysics(arena: TestArena, ticks = 1): void {
  for (let tick = 0; tick < ticks; tick += 1) {
    arena.vehicles.update(SIMULATION_FIXED_DELTA_SECONDS);
    arena.vehicles.stepPhysics(SIMULATION_FIXED_DELTA_SECONDS);
  }
}

function stepStraightConvoy(arena: TestArena, ticks: number): void {
  const controlledSpeed = 6.9;
  const mutableConvoy = arena.convoy as unknown as { speed: number };
  for (let tick = 0; tick < ticks; tick += 1) {
    mutableConvoy.speed = controlledSpeed;
    stepArena(arena);
  }
}

function prepareTenSecondStraight(arena: TestArena): void {
  const mutableConvoy = arena.convoy as unknown as {
    distanceAlongPath: number;
    speed: number;
  };
  mutableConvoy.distanceAlongPath = CONVOY_TUNING.towDistance;
  mutableConvoy.speed = 6.9;
  stepStraightConvoy(arena, 2);
}

function createRoom(id: string): GameRoom {
  const room = new GameRoom(id);
  rooms.push(room);
  return room;
}

function placeVehicleOnDeck(arena: TestArena, playerId: string): void {
  const vehicle = arena.vehicles.spawnVehicle(playerId);
  const position = arena.convoy.trailerLocalToWorld([
    0,
    TRAILER_DIMENSIONS.deckHeight + TRAILER_DIMENSIONS.deckThickness / 2 + 0.82,
    0,
  ]);
  const rotation = arena.convoy.trailerBody.rotation();
  vehicle.body.setTranslation(tupleToVector(position), true);
  vehicle.body.setRotation(rotation, true);
  vehicle.body.setLinvel(
    arena.convoy.trailerBody.velocityAtPoint(tupleToVector(position)),
    true,
  );
  vehicle.body.setAngvel(arena.convoy.trailerBody.angvel(), true);
}

function placeVehicleRelativeToBody(
  arena: TestArena,
  playerId: string,
  body: RAPIER.RigidBody,
  localPosition: Vector3Tuple,
  localVelocity: Vector3Tuple,
) {
  const vehicle = arena.vehicles.spawnVehicle(playerId);
  const position = localPointToWorld(body, localPosition);
  const relativeVelocity = rotateByQuaternion(localVelocity, body.rotation());
  const surfaceVelocity = body.velocityAtPoint(tupleToVector(position));
  vehicle.body.setTranslation(tupleToVector(position), true);
  vehicle.body.setRotation(body.rotation(), true);
  vehicle.body.setLinvel(
    {
      x: surfaceVelocity.x + relativeVelocity[0],
      y: surfaceVelocity.y + relativeVelocity[1],
      z: surfaceVelocity.z + relativeVelocity[2],
    },
    true,
  );
  vehicle.body.setAngvel(body.angvel(), true);
  return vehicle;
}

describe('ConvoySystem path and lifecycle', () => {
  it('exists as soon as a room is created', () => {
    const room = createRoom('CONVOY');
    expect(room.getConvoySystem()).toBeInstanceOf(ConvoySystem);
    expect(room.getConvoySystem().truckBody.isKinematic()).toBe(true);
    expect(room.getConvoySystem().trailerBody.isKinematic()).toBe(true);
  });

  it('spawns truck on the shared oval centerline', () => {
    const arena = createArena();
    const snapshot = arena.convoy.createSnapshot();
    const expected = getTrackCenterlinePoint(CONVOY_TUNING.initialPathProgress);
    expect(snapshot.truck.position[0]).toBeCloseTo(expected.position[0], 4);
    expect(snapshot.truck.position[2]).toBeCloseTo(expected.position[2], 4);
  });

  it('moves after fixed simulation ticks and accelerates smoothly', () => {
    const arena = createArena();
    const before = arena.convoy.createSnapshot();
    stepArena(arena, 60);
    const after = arena.convoy.createSnapshot();
    expect(after.pathProgress).not.toBeCloseTo(before.pathProgress, 5);
    expect(after.speed).toBeGreaterThan(3);
    expect(after.speed).toBeLessThan(CONVOY_TUNING.targetSpeed);
  });

  it('approaches target speed after three seconds without overshoot', () => {
    const arena = createArena();
    stepArena(arena, 190);
    expect(arena.convoy.currentSpeed).toBeCloseTo(CONVOY_TUNING.targetSpeed, 3);
    stepArena(arena, 300);
    expect(arena.convoy.currentSpeed).toBeLessThanOrEqual(CONVOY_TUNING.targetSpeed);
  });

  it('loops around the existing oval path', () => {
    const arena = createArena();
    let previousProgress = arena.convoy.pathProgress;
    let looped = false;
    for (let tick = 0; tick < 3_000 && !looped; tick += 1) {
      stepArena(arena);
      const progress = arena.convoy.pathProgress;
      looped = previousProgress > 0.95 && progress < 0.05;
      previousProgress = progress;
    }
    expect(looped).toBe(true);
  });

  it('keeps truck orientation aligned with the path tangent', () => {
    const arena = createArena();
    stepArena(arena, 800);
    const snapshot = arena.convoy.createSnapshot();
    const tangent = sampleConvoyPath(snapshot.pathProgress * TRACK_LAP_LENGTH).tangent;
    const rotation = arena.convoy.truckBody.rotation();
    const forwardX = 2 * (rotation.x * rotation.z + rotation.w * rotation.y);
    const forwardZ = 1 - 2 * (rotation.x ** 2 + rotation.y ** 2);
    expect(forwardX * tangent[0] + forwardZ * tangent[2]).toBeGreaterThan(0.995);
  });

  it('keeps trailer at the configured towing distance', () => {
    const arena = createArena();
    stepArena(arena, 600);
    const truck = arena.convoy.truckBody.translation();
    const trailer = arena.convoy.trailerBody.translation();
    const chordDistance = Math.hypot(truck.x - trailer.x, truck.z - trailer.z);
    expect(chordDistance).toBeGreaterThan(11.5);
    expect(chordDistance).toBeLessThanOrEqual(CONVOY_TUNING.towDistance + 0.1);
  });

  it('round-trips trailer local and world points', () => {
    const arena = createArena();
    stepArena(arena, 700);
    const point: Vector3Tuple = [2.25, 1.7, -4.5];
    const result = arena.convoy.worldToTrailerLocal(
      arena.convoy.trailerLocalToWorld(point),
    );
    expect(result[0]).toBeCloseTo(point[0], 5);
    expect(result[1]).toBeCloseTo(point[1], 5);
    expect(result[2]).toBeCloseTo(point[2], 5);
  });

  it('removes both kinematic bodies when disposed', () => {
    const physics = createRoomPhysicsContext();
    const convoy = new ConvoySystem(physics.world, physics.surfaces);
    const truckHandle = convoy.truckBody.handle;
    const trailerHandle = convoy.trailerBody.handle;
    convoy.dispose();
    expect(physics.world.getRigidBody(truckHandle)).toBeNull();
    expect(physics.world.getRigidBody(trailerHandle)).toBeNull();
    physics.world.free();
  });
});

describe('convoy snapshots and room isolation', () => {
  it('includes finite convoy state in room world snapshots', () => {
    const room = createRoom('SNAP01');
    room.update(SIMULATION_FIXED_DELTA_SECONDS, 1);
    const snapshot: WorldSnapshotMessage = {
      type: 'world_snapshot',
      serverTick: 1,
      vehicles: room.createVehicleSnapshot(),
      convoy: room.createConvoySnapshot(),
      gameState: room.createGameStateSnapshot(),
    };
    const decoded = createClientCodec().decode(JSON.stringify(snapshot));
    expect(decoded.ok).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/NaN|Infinity/);
  });

  it('keeps convoy simulation state independent between rooms', () => {
    const first = createRoom('FIRST1');
    const second = createRoom('SECOND');
    for (let tick = 0; tick < 120; tick += 1) {
      first.getConvoySystem().updateBeforePhysics(SIMULATION_FIXED_DELTA_SECONDS);
    }
    expect(first.createConvoySnapshot().pathProgress).not.toBeCloseTo(
      second.createConvoySnapshot().pathProgress,
      5,
    );
  });
});

describe('moving trailer surface physics', () => {
  it('uses deck wheel contacts as real trailer ground', () => {
    const arena = createArena();
    stepArena(arena, 190);
    placeVehicleOnDeck(arena, 'deck-player');
    stepArena(arena, 30);
    const snapshot = arena.vehicles.getVehicle('deck-player')?.createSnapshot();
    expect(snapshot?.grounded).toBe(true);
    expect(snapshot?.surfaceType).toBe('TRAILER_DECK');
    expect(snapshot?.onTrailer).toBe(true);
    expect(snapshot?.wheelContacts).toBe(4);
    expect(snapshot?.trailerDeckContacts).toBe(4);
  });

  it('limits ten-second drift using surface-relative moving-ground physics', () => {
    const arena = createArena();
    stepArena(arena, 190);
    placeVehicleOnDeck(arena, 'drift-player');
    stepArena(arena, 30);
    const vehicle = arena.vehicles.getVehicle('drift-player');
    if (vehicle === undefined) throw new Error('Expected drift test vehicle.');
    const initial = arena.convoy.worldToTrailerLocal(
      vectorToTuple(vehicle.body.translation()),
    );
    let trailerContactTicks = 0;
    for (let tick = 0; tick < 600; tick += 1) {
      stepArena(arena);
      if (vehicle.createSnapshot().onTrailer) trailerContactTicks += 1;
    }
    const final = arena.convoy.worldToTrailerLocal(
      vectorToTuple(vehicle.body.translation()),
    );
    const displacement = Math.hypot(final[0] - initial[0], final[2] - initial[2]);
    expect(
      displacement,
      JSON.stringify({
        initial,
        final,
        trailerContactTicks,
        body: vehicle.body.linvel(),
        rotation: vehicle.body.rotation(),
        snapshot: vehicle.createSnapshot(),
      }),
    ).toBeLessThan(0.5);
    expect(vehicle.createSnapshot().onTrailer).toBe(true);
  });

  it('reports point velocity as linear plus angular cross radius', () => {
    const arena = createArena();
    stepArena(arena, 700);
    const body = arena.convoy.trailerBody;
    const center = body.worldCom();
    const point = arena.convoy.trailerLocalToWorld([2.4, 1.6, -4]);
    const velocity = body.velocityAtPoint(tupleToVector(point));
    const linear = body.linvel();
    const angular = body.angvel();
    const radius = {
      x: point[0] - center.x,
      y: point[1] - center.y,
      z: point[2] - center.z,
    };
    const expected = {
      x: linear.x + angular.y * radius.z - angular.z * radius.y,
      y: linear.y + angular.z * radius.x - angular.x * radius.z,
      z: linear.z + angular.x * radius.y - angular.y * radius.x,
    };
    expect(velocity.x).toBeCloseTo(expected.x, 4);
    expect(velocity.y).toBeCloseTo(expected.y, 4);
    expect(velocity.z).toBeCloseTo(expected.z, 4);
  });

  it.each([
    { label: 'low', speed: 3, ticks: 150 },
    { label: 'medium', speed: 6, ticks: 100 },
    { label: 'high', speed: 10, ticks: 70 },
  ])(
    'drives from the road across the moving ramp at $label speed',
    ({ speed, ticks }) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const arena = createArena();
        stepArena(arena, 190);
        const vehicle = placeVehicleRelativeToBody(
          arena,
          `ramp-player-${attempt}`,
          arena.convoy.trailerBody,
          [0, 1.1, -14.2],
          [0, 0, speed],
        );
        vehicle.applyInput({
          type: 'player_input',
          sequence: 1,
          throttle: 0.7,
          brake: 0,
          steering: 0,
          handbrake: false,
        });
        let touchedTrailer = false;
        let maximumUpwardSpeed = 0;
        let consecutiveContactLossTicks = 0;
        let maximumContactLossTicks = 0;
        let establishedGroundContact = false;
        for (let tick = 0; tick < ticks; tick += 1) {
          stepArena(arena);
          const snapshot = vehicle.createSnapshot();
          touchedTrailer ||= snapshot.onTrailer;
          establishedGroundContact ||= snapshot.wheelContacts > 0;
          maximumUpwardSpeed = Math.max(maximumUpwardSpeed, vehicle.body.linvel().y);
          const localAtTick = arena.convoy.worldToTrailerLocal(
            vectorToTuple(vehicle.body.translation()),
          );
          const withinTransition =
            localAtTick[2] >
              TRAILER_RAMP_GEOMETRY.frontSurfaceZ -
                TRAILER_DIMENSIONS.rampHorizontalLength -
                0.5 && localAtTick[2] < TRAILER_RAMP_GEOMETRY.frontSurfaceZ + 1;
          consecutiveContactLossTicks =
            establishedGroundContact && withinTransition && snapshot.wheelContacts === 0
              ? consecutiveContactLossTicks + 1
              : 0;
          maximumContactLossTicks = Math.max(
            maximumContactLossTicks,
            consecutiveContactLossTicks,
          );
        }
        const local = arena.convoy.worldToTrailerLocal(
          vectorToTuple(vehicle.body.translation()),
        );
        expect(touchedTrailer).toBe(true);
        expect(local[2]).toBeGreaterThan(-TRAILER_DIMENSIONS.deckLength / 2);
        expect(local[1]).toBeGreaterThan(TRAILER_DIMENSIONS.deckHeight);
        expect(maximumUpwardSpeed).toBeLessThan(4.5);
        expect(maximumContactLossTicks).toBeLessThan(24);
      }
    },
  );

  it('responds physically when a player vehicle hits the truck', () => {
    const arena = createArena();
    stepArena(arena, 190);
    const vehicle = placeVehicleRelativeToBody(
      arena,
      'truck-collision-player',
      arena.convoy.truckBody,
      [0, 1.1, TRUCK_DIMENSIONS.length / 2 + 5],
      [0, 0, -14],
    );
    const initialRelativeSpeed = velocityAlongBodyForward(
      vehicle.body.linvel(),
      arena.convoy.truckBody,
    );
    let contacted = false;
    for (let tick = 0; tick < 80; tick += 1) {
      stepArena(arena);
      contacted ||= arena.convoy.truckColliders.some((collider) =>
        hasContact(arena.world, vehicle.collider, collider),
      );
    }
    const finalRelativeSpeed =
      velocityAlongBodyForward(vehicle.body.linvel(), arena.convoy.truckBody) -
      velocityAlongBodyForward(arena.convoy.truckBody.linvel(), arena.convoy.truckBody);
    expect(contacted).toBe(true);
    expect(initialRelativeSpeed).toBeLessThan(0);
    expect(finalRelativeSpeed).toBeGreaterThan(-5);
    expect(JSON.stringify(vehicle.createSnapshot())).not.toMatch(/NaN|Infinity/);
  });

  it('creates a real collision response at a trailer side lip', () => {
    const arena = createArena();
    stepArena(arena, 190);
    const vehicle = placeVehicleRelativeToBody(
      arena,
      'lip-player',
      arena.convoy.trailerBody,
      [2.25, 2.15, 0],
      [3, 0, 0],
    );
    let contacted = false;
    for (let tick = 0; tick < 60; tick += 1) {
      stepArena(arena);
      contacted ||= arena.convoy.trailerColliders
        .slice(2, 4)
        .some((collider) => hasContact(arena.world, vehicle.collider, collider));
    }
    expect(contacted).toBe(true);
    expect(JSON.stringify(vehicle.createSnapshot())).not.toMatch(/NaN|Infinity/);
  });

  it('allows vehicle collision momentum to break neutral deck adhesion', () => {
    const arena = createArena();
    stepArena(arena, 190);
    const attacker = placeVehicleRelativeToBody(
      arena,
      'deck-attacker',
      arena.convoy.trailerBody,
      [-1, 2.46, 0],
      [15, 0, 0],
    );
    attacker.applyInput({
      type: 'player_input',
      sequence: 1,
      throttle: 0,
      brake: 0,
      steering: 0,
      handbrake: true,
    });
    const target = placeVehicleRelativeToBody(
      arena,
      'deck-target',
      arena.convoy.trailerBody,
      [1, 2.46, 0],
      [0, 0, 0],
    );
    let contacted = false;
    for (let tick = 0; tick < 90; tick += 1) {
      stepArena(arena);
      contacted ||= hasContact(arena.world, attacker.collider, target.collider);
    }
    const targetLocal = arena.convoy.worldToTrailerLocal(
      vectorToTuple(target.body.translation()),
    );
    expect(contacted).toBe(true);
    expect(targetLocal[0]).toBeGreaterThan(1.05);
    expect(JSON.stringify(target.createSnapshot())).not.toMatch(/NaN|Infinity/);
  });

  it('computes moving-surface relative velocity near zero at rest', () => {
    const arena = createArena();
    stepArena(arena, 190);
    placeVehicleOnDeck(arena, 'relative-player');
    stepArena(arena, 60);
    const snapshot = arena.vehicles.getVehicle('relative-player')?.createSnapshot();
    expect(Math.abs(snapshot?.relativeForwardSpeed ?? 99)).toBeLessThan(1);
    expect(Math.abs(snapshot?.relativeLateralSpeed ?? 99)).toBeLessThan(1);
  });

  it('teleports a room player safely behind the moving ramp', () => {
    const room = createRoom('DEBUG1');
    const player = new ServerPlayer('debug-player', 'debug-client', 'Debug');
    room.addPlayer(player);
    for (let tick = 0; tick < 190; tick += 1) {
      room.update(SIMULATION_FIXED_DELTA_SECONDS, tick);
    }
    expect(room.teleportVehicleNearTrailer(player.id)).toBe(true);
    const vehicle = room.getVehicleSystem().getVehicle(player.id);
    if (vehicle === undefined) throw new Error('Expected debug vehicle.');
    const trailerLocal = room
      .getConvoySystem()
      .worldToTrailerLocal(vectorToTuple(vehicle.body.translation()));
    expect(trailerLocal[2]).toBeLessThan(
      -TRAILER_DIMENSIONS.deckLength / 2 - TRAILER_DIMENSIONS.rampHorizontalLength,
    );
    expect(Math.hypot(vehicle.body.linvel().x, vehicle.body.linvel().z)).toBeCloseTo(
      room.getConvoySystem().currentSpeed + 4,
      3,
    );
  });
});

describe('ramp continuity geometry', () => {
  it('places the ramp bottom within road overlap tolerance', () => {
    const halfLength = TRAILER_DIMENSIONS.rampLength / 2;
    const halfThickness = TRAILER_DIMENSIONS.rampThickness / 2;
    const bottomSurfaceY =
      TRAILER_RAMP_GEOMETRY.centerY +
      Math.cos(TRAILER_RAMP_ANGLE) * halfThickness -
      Math.sin(TRAILER_RAMP_ANGLE) * halfLength;
    expect(bottomSurfaceY).toBeCloseTo(-TRAILER_DIMENSIONS.rampRoadOverlap, 6);
    expect(Math.abs(bottomSurfaceY)).toBeLessThanOrEqual(0.05);
  });

  it('keeps the ramp top flush with and slightly overlapping the deck', () => {
    const halfLength = TRAILER_DIMENSIONS.rampLength / 2;
    const halfThickness = TRAILER_DIMENSIONS.rampThickness / 2;
    const topSurfaceY =
      TRAILER_RAMP_GEOMETRY.centerY +
      Math.cos(TRAILER_RAMP_ANGLE) * halfThickness +
      Math.sin(TRAILER_RAMP_ANGLE) * halfLength;
    expect(topSurfaceY).toBeCloseTo(TRAILER_RAMP_GEOMETRY.deckSurfaceY, 6);
    expect(TRAILER_RAMP_GEOMETRY.frontSurfaceZ).toBeGreaterThan(
      -TRAILER_DIMENSIONS.deckLength / 2,
    );
    expect(TRAILER_DIMENSIONS.rampDeckOverlap).toBeLessThanOrEqual(0.05);
  });
});

describe('moving-surface stabilization', () => {
  it('holds a neutral vehicle on a straight-moving deck for ten seconds', () => {
    const arena = createArena();
    prepareTenSecondStraight(arena);
    placeVehicleOnDeck(arena, 'straight-drift');
    const vehicle = arena.vehicles.getVehicle('straight-drift');
    if (vehicle === undefined) throw new Error('Expected straight drift vehicle.');
    const initial = localPointFromBody(
      arena.convoy.trailerBody,
      vectorToTuple(vehicle.body.translation()),
    );
    stepStraightConvoy(arena, 600);
    const final = localPointFromBody(
      arena.convoy.trailerBody,
      vectorToTuple(vehicle.body.translation()),
    );
    const drift = Math.hypot(final[0] - initial[0], final[2] - initial[2]);
    expect(drift, JSON.stringify({ initial, final })).toBeLessThan(0.25);
    expect(vehicle.createSnapshot().wheelContacts).toBe(4);
  });

  it('does not turn shared world speed into relative rolling resistance', () => {
    const arena = createArena();
    prepareTenSecondStraight(arena);
    placeVehicleOnDeck(arena, 'rolling-relative');
    stepStraightConvoy(arena, 120);
    const snapshot = arena.vehicles.getVehicle('rolling-relative')?.createSnapshot();
    expect(
      Math.hypot(...(snapshot?.linearVelocity ?? [0, 0, 0])),
      JSON.stringify({
        trailerVelocity: arena.convoy.trailerBody.linvel(),
        trailerPosition: arena.convoy.trailerBody.translation(),
        snapshot,
      }),
    ).toBeGreaterThan(6);
    expect(
      Math.hypot(
        snapshot?.relativeForwardSpeed ?? 99,
        snapshot?.relativeLateralSpeed ?? 99,
      ),
    ).toBeLessThan(0.5);
  });
});

describe('trailer underbody collision safety', () => {
  it('blocks a vehicle center from entering below the trailer deck', () => {
    const arena = createArena();
    stepArena(arena, 190);
    const vehicle = placeVehicleRelativeToBody(
      arena,
      'underbody-player',
      arena.convoy.trailerBody,
      [5.2, 0.68, 0],
      [-10, 0, 0],
    );
    vehicle.body.setRotation(
      multiplyQuaternions(arena.convoy.trailerBody.rotation(), {
        x: 0,
        y: -Math.SQRT1_2,
        z: 0,
        w: Math.SQRT1_2,
      }),
      true,
    );
    vehicle.applyInput({
      type: 'player_input',
      sequence: 1,
      throttle: 1,
      brake: 0,
      steering: 0,
      handbrake: false,
    });
    let contacted = false;
    for (let tick = 0; tick < 90; tick += 1) {
      stepArena(arena);
      contacted ||= hasContact(
        arena.world,
        vehicle.collider,
        arena.convoy.trailerColliders[6]!,
      );
    }
    const local = arena.convoy.worldToTrailerLocal(
      vectorToTuple(vehicle.body.translation()),
    );
    expect(contacted).toBe(true);
    expect(Math.abs(local[0])).toBeGreaterThan(3.55);
  });

  it('deflects the connection danger zone instead of trapping the vehicle', () => {
    const arena = createArena();
    stepArena(arena, 190);
    const vehicle = placeVehicleRelativeToBody(
      arena,
      'connection-player',
      arena.convoy.trailerBody,
      [3.8, 0.75, 10.2],
      [-7, 0, -3],
    );
    let contacted = false;
    for (let tick = 0; tick < 120; tick += 1) {
      stepArena(arena);
      contacted ||= arena.convoy.trailerColliders
        .slice(7)
        .some((collider) => hasContact(arena.world, vehicle.collider, collider));
    }
    const local = arena.convoy.worldToTrailerLocal(
      vectorToTuple(vehicle.body.translation()),
    );
    expect(contacted).toBe(true);
    expect(Math.hypot(local[0], local[2] - 8.8)).toBeGreaterThan(0.65);
    expect(Math.hypot(vehicle.body.linvel().x, vehicle.body.linvel().z)).toBeGreaterThan(
      0.05,
    );
  });
});

describe('server-authoritative self-right recovery', () => {
  it('detects flipped rotations but not an upright vehicle', () => {
    expect(isVehicleFlipped({ x: 0, y: 0, z: 1, w: 0 })).toBe(true);
    expect(isVehicleFlipped({ x: 0, y: 0, z: 0, w: 1 })).toBe(false);
    expect(vehicleUpDot({ x: 0, y: 0, z: 0, w: 1 })).toBeCloseTo(1);
  });

  it('rejects recovery until the supported low-speed flip dwell expires', () => {
    const arena = createArena();
    const vehicle = arena.vehicles.spawnVehicle('recovery-wait');
    vehicle.body.setTranslation({ x: 0, y: 0.55, z: 0 }, true);
    vehicle.body.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true);
    vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    stepVehiclePhysics(
      arena,
      Math.floor(VEHICLE_RECOVERY_TUNING.requiredFlippedSeconds * 60) - 2,
    );
    expect(vehicle.selfRight()).toBe(false);
  });

  it('rejects airborne and fast-moving recovery attempts', () => {
    const arena = createArena();
    const vehicle = arena.vehicles.spawnVehicle('recovery-invalid');
    vehicle.body.setTranslation({ x: 0, y: 8, z: 0 }, true);
    vehicle.body.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true);
    stepVehiclePhysics(arena, 90);
    expect(vehicle.selfRight()).toBe(false);

    vehicle.body.setTranslation({ x: 0, y: 0.55, z: 0 }, true);
    vehicle.body.setLinvel({ x: 8, y: 0, z: 0 }, true);
    stepVehiclePhysics(arena, 90);
    expect(vehicle.selfRight()).toBe(false);
  });

  it('uprights a supported vehicle without non-finite state', () => {
    const arena = createArena();
    const vehicle = arena.vehicles.spawnVehicle('recovery-ground');
    vehicle.body.setTranslation({ x: 2, y: 0.55, z: 3 }, true);
    vehicle.body.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true);
    vehicle.body.setLinvel({ x: 0.2, y: 0, z: 0.1 }, true);
    stepVehiclePhysics(arena, 90);
    expect(vehicle.selfRight()).toBe(true);
    expect(vehicleUpDot(vehicle.body.rotation())).toBeGreaterThan(0.99);
    expect(vehicle.body.translation().y).toBeGreaterThan(0.9);
    expect(JSON.stringify(vehicle.createSnapshot())).not.toMatch(/NaN|Infinity/);
  });

  it('preserves the horizontal heading when uprighting', () => {
    const arena = createArena();
    const vehicle = arena.vehicles.spawnVehicle('recovery-heading');
    const yaw = 0.8;
    vehicle.body.setTranslation({ x: -2, y: 0.55, z: 1 }, true);
    vehicle.body.setRotation(
      multiplyQuaternions(
        { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
        { x: 0, y: 0, z: 1, w: 0 },
      ),
      true,
    );
    stepVehiclePhysics(arena, 90);
    const headingBefore = rotateByQuaternion([0, 0, 1], vehicle.body.rotation());
    const headingLength = Math.hypot(headingBefore[0], headingBefore[2]);
    expect(vehicle.selfRight()).toBe(true);
    const forward = rotateByQuaternion([0, 0, 1], vehicle.body.rotation());
    expect(forward[0]).toBeCloseTo(headingBefore[0] / headingLength, 5);
    expect(forward[2]).toBeCloseTo(headingBefore[2] / headingLength, 5);
  });

  it('self-rights safely above the trailer deck rather than inside it', () => {
    const arena = createArena();
    stepArena(arena, 190);
    const vehicle = arena.vehicles.spawnVehicle('recovery-deck');
    const position = arena.convoy.trailerLocalToWorld([0, 2.02, 0]);
    const trailerRotation = arena.convoy.trailerBody.rotation();
    const upsideDown = multiplyQuaternions(trailerRotation, { x: 0, y: 0, z: 1, w: 0 });
    vehicle.body.setTranslation(tupleToVector(position), true);
    vehicle.body.setRotation(upsideDown, true);
    vehicle.body.setLinvel(arena.convoy.trailerBody.linvel(), true);
    vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    stepArena(arena, 90);
    expect(vehicle.selfRight()).toBe(true);
    const local = arena.convoy.worldToTrailerLocal(
      vectorToTuple(vehicle.body.translation()),
    );
    expect(local[1]).toBeGreaterThan(TRAILER_RAMP_GEOMETRY.deckSurfaceY + 0.9);
    expect(vehicleUpDot(vehicle.body.rotation())).toBeGreaterThan(0.99);
    expect(local[1] - 0.39).toBeGreaterThan(TRAILER_RAMP_GEOMETRY.deckSurfaceY);
    stepArena(arena, 60);
    const settledLocal = arena.convoy.worldToTrailerLocal(
      vectorToTuple(vehicle.body.translation()),
    );
    expect(vehicle.createSnapshot().onTrailer).toBe(true);
    expect(Math.hypot(settledLocal[0], settledLocal[2])).toBeLessThan(1);
  });
});

function tupleToVector(tuple: Vector3Tuple): RAPIER.Vector3 {
  return { x: tuple[0], y: tuple[1], z: tuple[2] };
}

function vectorToTuple(vector: RAPIER.Vector): Vector3Tuple {
  return [vector.x, vector.y, vector.z];
}

function localPointToWorld(body: RAPIER.RigidBody, point: Vector3Tuple): Vector3Tuple {
  const translation = body.translation();
  const rotated = rotateByQuaternion(point, body.rotation());
  return [
    translation.x + rotated[0],
    translation.y + rotated[1],
    translation.z + rotated[2],
  ];
}

function localPointFromBody(body: RAPIER.RigidBody, point: Vector3Tuple): Vector3Tuple {
  const translation = body.translation();
  const rotation = body.rotation();
  return rotateByQuaternion(
    [point[0] - translation.x, point[1] - translation.y, point[2] - translation.z],
    { x: -rotation.x, y: -rotation.y, z: -rotation.z, w: rotation.w },
  );
}

function multiplyQuaternions(
  first: RAPIER.Rotation,
  second: RAPIER.Rotation,
): RAPIER.Rotation {
  return {
    x: first.w * second.x + first.x * second.w + first.y * second.z - first.z * second.y,
    y: first.w * second.y - first.x * second.z + first.y * second.w + first.z * second.x,
    z: first.w * second.z + first.x * second.y - first.y * second.x + first.z * second.w,
    w: first.w * second.w - first.x * second.x - first.y * second.y - first.z * second.z,
  };
}

function rotateByQuaternion(
  vector: Vector3Tuple,
  rotation: RAPIER.Rotation,
): Vector3Tuple {
  const tx = 2 * (rotation.y * vector[2] - rotation.z * vector[1]);
  const ty = 2 * (rotation.z * vector[0] - rotation.x * vector[2]);
  const tz = 2 * (rotation.x * vector[1] - rotation.y * vector[0]);
  return [
    vector[0] + rotation.w * tx + (rotation.y * tz - rotation.z * ty),
    vector[1] + rotation.w * ty + (rotation.z * tx - rotation.x * tz),
    vector[2] + rotation.w * tz + (rotation.x * ty - rotation.y * tx),
  ];
}

function velocityAlongBodyForward(
  velocity: RAPIER.Vector,
  body: RAPIER.RigidBody,
): number {
  const forward = rotateByQuaternion([0, 0, 1], body.rotation());
  return velocity.x * forward[0] + velocity.y * forward[1] + velocity.z * forward[2];
}

function hasContact(
  world: RAPIER.World,
  first: RAPIER.Collider,
  second: RAPIER.Collider,
): boolean {
  let contacted = false;
  world.contactPair(first, second, () => {
    contacted = true;
  });
  return contacted;
}
