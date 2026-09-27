import RAPIER from '@dimforge/rapier3d-compat';
import {
  PLAYER_COLLISION_TUNING,
  SIMULATION_FIXED_DELTA_SECONDS,
  TRAILER_DIMENSIONS,
  VEHICLE_TUNING,
} from '@trailer-arena/shared';
import type { Vector3Tuple } from '@trailer-arena/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ConvoySystem } from '../src/convoy/ConvoySystem.js';
import {
  calculateAdhesionBreakDuration,
  calculateArcadeTargetDeltaVelocity,
  calculateClosingSpeed,
  calculateImpactCurve,
  calculateMassAwareImpactImpulse,
  limitImpactNormal,
  type PlayerImpactMeasurement,
} from '../src/vehicles/PlayerCollisionSystem.js';
import { VehicleSystem } from '../src/vehicles/VehicleSystem.js';
import { createRoomPhysicsContext } from '../src/world/PhysicsWorldBuilder.js';

interface ImpactArena {
  readonly world: RAPIER.World;
  readonly convoy: ConvoySystem;
  readonly vehicles: VehicleSystem;
}

interface ImpactResult {
  readonly displacement: number;
  readonly targetImpactDeltaSpeed: number;
  readonly attackerImpactSpeedLoss: number;
  readonly maximumVerticalSpeed: number;
  readonly maximumUpwardMovement: number;
  readonly maximumTiltDegrees: number;
  readonly maximumRollPitchAngularSpeed: number;
  readonly maximumGroundedTiltDegrees: number;
  readonly maximumGroundedRollPitchAngularSpeed: number;
  readonly maximumGroundedHardLimitTicks: number;
  readonly maximumTrailerTiltDegrees: number;
  readonly maximumTrailerHardLimitTicks: number;
  readonly rolledOver: boolean;
  readonly arcadeAngularVelocityDelta: number;
  readonly closingSpeed: number;
  readonly nativeImpulse: number;
  readonly assistImpulse: number;
  readonly impactCurve: number;
  readonly targetArcadeDeltaVelocity: number;
  readonly attackerReactionRatio: number;
  readonly targetAdhesionBreakSeconds: number;
  readonly finalLocalY: number;
  readonly finalOnTrailer: boolean;
  readonly lateralVelocitySamples: ImpactVelocitySamples;
}

interface ImpactVelocitySamples {
  readonly impact: number;
  readonly after100Milliseconds: number;
  readonly after250Milliseconds: number;
  readonly after500Milliseconds: number;
  readonly after1000Milliseconds: number;
}

interface SideImpactOptions {
  readonly targetZ?: number;
  readonly contactOffsetZ?: number;
  readonly targetYaw?: number;
  readonly attackerYawOffset?: number;
}

const arenas: ImpactArena[] = [];

beforeAll(async () => {
  await RAPIER.init();
});

afterEach(() => {
  for (const arena of arenas) {
    arena.vehicles.dispose();
    arena.convoy.dispose();
    arena.world.free();
  }
  arenas.length = 0;
});

function createArena(): ImpactArena {
  const physics = createRoomPhysicsContext();
  const arena = {
    world: physics.world,
    convoy: new ConvoySystem(physics.world, physics.surfaces),
    vehicles: new VehicleSystem(physics.world, physics.surfaces),
  };
  arenas.push(arena);
  return arena;
}

function disposeArena(arena: ImpactArena): void {
  arena.vehicles.dispose();
  arena.convoy.dispose();
  arena.world.free();
  const index = arenas.indexOf(arena);
  if (index >= 0) arenas.splice(index, 1);
}

function stepArena(arena: ImpactArena, ticks = 1): void {
  for (let tick = 0; tick < ticks; tick += 1) {
    arena.convoy.updateBeforePhysics(SIMULATION_FIXED_DELTA_SECONDS);
    arena.vehicles.update(SIMULATION_FIXED_DELTA_SECONDS);
    arena.vehicles.stepPhysics(SIMULATION_FIXED_DELTA_SECONDS);
  }
}

function placeVehicle(
  arena: ImpactArena,
  playerId: string,
  localPosition: Vector3Tuple,
  localVelocity: Vector3Tuple,
  localYaw = 0,
) {
  const vehicle = arena.vehicles.spawnVehicle(playerId);
  const worldPosition = arena.convoy.trailerLocalToWorld(localPosition);
  const trailerRotation = arena.convoy.trailerBody.rotation();
  const relativeVelocity = rotateVector(localVelocity, trailerRotation);
  const surfaceVelocity = arena.convoy.trailerBody.velocityAtPoint({
    x: worldPosition[0],
    y: worldPosition[1],
    z: worldPosition[2],
  });
  vehicle.body.setTranslation(toVector(worldPosition), true);
  vehicle.body.setRotation(
    multiplyRotations(trailerRotation, {
      x: 0,
      y: Math.sin(localYaw / 2),
      z: 0,
      w: Math.cos(localYaw / 2),
    }),
    true,
  );
  vehicle.body.setLinvel(
    {
      x: surfaceVelocity.x + relativeVelocity.x,
      y: surfaceVelocity.y + relativeVelocity.y,
      z: surfaceVelocity.z + relativeVelocity.z,
    },
    true,
  );
  vehicle.body.setAngvel(arena.convoy.trailerBody.angvel(), true);
  return vehicle;
}

function runSideImpact(
  speedKmh: number,
  targetX = 0,
  ticksAfterContact = 30,
  options: SideImpactOptions = {},
): ImpactResult {
  const arena = createArena();
  stepArena(arena, 190);
  const speed = speedKmh / 3.6;
  const targetZ = options.targetZ ?? 0;
  const attacker = placeVehicle(
    arena,
    `attacker-${speedKmh}-${targetX}-${targetZ}`,
    [targetX - 3, deckVehicleY(), targetZ + (options.contactOffsetZ ?? 0)],
    [speed, 0, 0],
    Math.PI / 2 + (options.attackerYawOffset ?? 0),
  );
  attacker.applyInput({
    type: 'player_input',
    sequence: 1,
    throttle: 0,
    brake: 0,
    steering: 0,
    handbrake: true,
  });
  const target = placeVehicle(
    arena,
    `target-${speedKmh}-${targetX}-${targetZ}`,
    [targetX, deckVehicleY(), targetZ],
    [0, 0, 0],
    options.targetYaw ?? 0,
  );
  let contacted = false;
  let firstMeasurement: PlayerImpactMeasurement | null = null;
  let ticksAfter = 0;
  let maximumVerticalSpeed = 0;
  let maximumUpwardMovement = 0;
  let maximumTiltDegrees = 0;
  let maximumRollPitchAngularSpeed = 0;
  let maximumGroundedTiltDegrees = 0;
  let maximumGroundedRollPitchAngularSpeed = 0;
  let groundedHardLimitTicks = 0;
  let maximumGroundedHardLimitTicks = 0;
  let maximumTrailerTiltDegrees = 0;
  let trailerHardLimitTicks = 0;
  let maximumTrailerHardLimitTicks = 0;
  const lateralVelocitySamples = [
    Number.NaN,
    Number.NaN,
    Number.NaN,
    Number.NaN,
    Number.NaN,
  ];
  const lateralSampleTicks = [0, 6, 15, 30, 60] as const;
  let rolledOver = false;
  for (let tick = 0; tick < 120; tick += 1) {
    stepArena(arena);
    maximumVerticalSpeed = Math.max(
      maximumVerticalSpeed,
      Math.abs(target.body.linvel().y),
    );
    const currentLocal = arena.convoy.worldToTrailerLocal(
      toTuple(target.body.translation()),
    );
    maximumUpwardMovement = Math.max(
      maximumUpwardMovement,
      currentLocal[1] - deckVehicleY(),
    );
    const rotation = target.body.rotation();
    const up = vehicleUp(rotation);
    const tiltDegrees = (Math.acos(Math.max(-1, Math.min(1, up.y))) * 180) / Math.PI;
    maximumTiltDegrees = Math.max(maximumTiltDegrees, tiltDegrees);
    rolledOver ||= up.y < 0;
    const angular = target.body.angvel();
    const yawSpeed = angular.x * up.x + angular.y * up.y + angular.z * up.z;
    const rollPitchAngularSpeed = Math.hypot(
      angular.x - up.x * yawSpeed,
      angular.y - up.y * yawSpeed,
      angular.z - up.z * yawSpeed,
    );
    maximumRollPitchAngularSpeed = Math.max(
      maximumRollPitchAngularSpeed,
      rollPitchAngularSpeed,
    );
    const snapshot = target.createSnapshot();
    const hasGroundedSupport =
      snapshot.wheelContacts >= 2 && snapshot.surfaceType !== 'AIR';
    if (hasGroundedSupport) {
      maximumGroundedTiltDegrees = Math.max(maximumGroundedTiltDegrees, tiltDegrees);
      maximumGroundedRollPitchAngularSpeed = Math.max(
        maximumGroundedRollPitchAngularSpeed,
        rollPitchAngularSpeed,
      );
      groundedHardLimitTicks =
        tiltDegrees > VEHICLE_TUNING.groundedOrientationHardLimitDegrees + 2
          ? groundedHardLimitTicks + 1
          : 0;
      maximumGroundedHardLimitTicks = Math.max(
        maximumGroundedHardLimitTicks,
        groundedHardLimitTicks,
      );
    } else {
      groundedHardLimitTicks = 0;
    }
    const hasTrailerSupport = hasGroundedSupport && snapshot.onTrailer;
    if (hasTrailerSupport) {
      maximumTrailerTiltDegrees = Math.max(maximumTrailerTiltDegrees, tiltDegrees);
      trailerHardLimitTicks =
        tiltDegrees > VEHICLE_TUNING.groundedOrientationHardLimitDegrees + 2
          ? trailerHardLimitTicks + 1
          : 0;
      maximumTrailerHardLimitTicks = Math.max(
        maximumTrailerHardLimitTicks,
        trailerHardLimitTicks,
      );
    } else {
      trailerHardLimitTicks = 0;
    }
    const impact = arena.vehicles.lastPlayerImpact;
    if (impact !== null) {
      contacted = true;
      firstMeasurement ??= impact;
    }
    if (contacted) {
      if (firstMeasurement !== null) {
        const sampleIndex = lateralSampleTicks.indexOf(
          ticksAfter as (typeof lateralSampleTicks)[number],
        );
        if (sampleIndex >= 0) {
          lateralVelocitySamples[sampleIndex] = impactRelativeLateralSpeed(
            arena,
            target.body,
            firstMeasurement,
            target.playerId,
          );
        }
      }
      ticksAfter += 1;
      if (ticksAfter > ticksAfterContact) break;
    }
  }
  const localTarget = arena.convoy.worldToTrailerLocal(
    toTuple(target.body.translation()),
  );
  const measurement = firstMeasurement;
  if (!contacted || measurement === null) throw new Error('Expected a player impact.');
  const targetIsSecond = measurement.secondPlayerId === target.playerId;
  const targetBefore = targetIsSecond
    ? measurement.secondVelocityBefore
    : measurement.firstVelocityBefore;
  const targetAfter = targetIsSecond
    ? measurement.secondVelocityAfterAssist
    : measurement.firstVelocityAfterAssist;
  const attackerBefore = targetIsSecond
    ? measurement.firstVelocityBefore
    : measurement.secondVelocityBefore;
  const attackerAfter = targetIsSecond
    ? measurement.firstVelocityAfterAssist
    : measurement.secondVelocityAfterAssist;
  const impactDirection = targetIsSecond
    ? measurement.normal
    : (measurement.normal.map((component) => -component) as [number, number, number]);
  const result = {
    displacement: localTarget[0] - targetX,
    targetImpactDeltaSpeed: dotDelta(targetBefore, targetAfter, impactDirection),
    attackerImpactSpeedLoss: -dotDelta(attackerBefore, attackerAfter, impactDirection),
    maximumVerticalSpeed,
    maximumUpwardMovement,
    maximumTiltDegrees,
    maximumRollPitchAngularSpeed,
    maximumGroundedTiltDegrees,
    maximumGroundedRollPitchAngularSpeed,
    maximumGroundedHardLimitTicks,
    maximumTrailerTiltDegrees,
    maximumTrailerHardLimitTicks,
    rolledOver,
    arcadeAngularVelocityDelta: Math.max(
      tupleDistance(
        measurement.firstAngularVelocityAfterNative,
        measurement.firstAngularVelocityAfterAssist,
      ),
      tupleDistance(
        measurement.secondAngularVelocityAfterNative,
        measurement.secondAngularVelocityAfterAssist,
      ),
    ),
    closingSpeed: measurement.closingSpeed,
    nativeImpulse: measurement.nativeImpulse,
    assistImpulse: measurement.assistImpulse,
    impactCurve: measurement.impactCurve,
    targetArcadeDeltaVelocity: measurement.targetArcadeDeltaVelocity,
    attackerReactionRatio: measurement.attackerReactionRatio,
    targetAdhesionBreakSeconds: measurement.targetAdhesionBreakSeconds,
    finalLocalY: localTarget[1],
    finalOnTrailer: target.createSnapshot().onTrailer,
    lateralVelocitySamples: {
      impact: lateralVelocitySamples[0] ?? Number.NaN,
      after100Milliseconds: lateralVelocitySamples[1] ?? Number.NaN,
      after250Milliseconds: lateralVelocitySamples[2] ?? Number.NaN,
      after500Milliseconds: lateralVelocitySamples[3] ?? Number.NaN,
      after1000Milliseconds: lateralVelocitySamples[4] ?? Number.NaN,
    },
  };
  disposeArena(arena);
  return result;
}

describe('player impact math', () => {
  it('computes closing speed only while bodies approach along the normal', () => {
    expect(calculateClosingSpeed({ x: -5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBe(5);
    expect(calculateClosingSpeed({ x: 5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBe(0);
  });

  it('keeps a 5 km/h contact below the RAM threshold', () => {
    expect(calculateArcadeTargetDeltaVelocity(5 / 3.6)).toBe(0);
    expect(calculateMassAwareImpactImpulse(5 / 3.6, VEHICLE_TUNING.mass)).toBe(0);
  });

  it('uses a monotonic smoothstep RAM response', () => {
    const ten = calculateImpactCurve(10 / 3.6);
    const fifteen = calculateImpactCurve(15 / 3.6);
    const twenty = calculateImpactCurve(20 / 3.6);
    const thirty = calculateImpactCurve(30 / 3.6);
    expect(ten).toBeGreaterThan(0);
    expect(fifteen).toBeGreaterThan(ten);
    expect(twenty).toBeGreaterThan(fifteen);
    expect(thirty).toBeGreaterThan(twenty);
    expect(thirty).toBe(1);
  });

  it('converts target delta-V to a mass-aware impulse and caps the response', () => {
    expect(calculateMassAwareImpactImpulse(100, VEHICLE_TUNING.mass)).toBe(
      PLAYER_COLLISION_TUNING.ramMaximumTargetDeltaVelocity * VEHICLE_TUNING.mass,
    );
    expect(calculateArcadeTargetDeltaVelocity(100)).toBe(
      PLAYER_COLLISION_TUNING.ramMaximumTargetDeltaVelocity,
    );
  });

  it('makes the arcade assist purely horizontal without flattening native contacts', () => {
    const target = { x: 0, y: 0, z: 0 };
    expect(limitImpactNormal({ x: 1, y: 2, z: 0 }, target)).toBe(true);
    expect(target.y).toBe(PLAYER_COLLISION_TUNING.ramVerticalDeltaVelocityMax);
    expect(Math.hypot(target.x, target.z)).toBeCloseTo(1, 6);
    expect(limitImpactNormal({ x: 0.1, y: 0.99, z: 0 }, target)).toBe(false);
  });

  it('scales adhesion release from medium to strong impacts', () => {
    const medium = calculateAdhesionBreakDuration(20 / 3.6);
    const strong = calculateAdhesionBreakDuration(30 / 3.6);
    expect(medium).toBeGreaterThanOrEqual(
      PLAYER_COLLISION_TUNING.ramAdhesionBreakMinSeconds,
    );
    expect(strong).toBeGreaterThan(medium);
    expect(strong).toBeLessThanOrEqual(
      PLAYER_COLLISION_TUNING.ramAdhesionBreakMaxSeconds,
    );
  });
});

describe('server-authoritative player collision tuning', () => {
  it('preserves a visible 20 km/h RAM slide through the recovery window', () => {
    const result = runSideImpact(20, 0, 61);
    expect(result.lateralVelocitySamples.impact).toBeGreaterThan(10);
    expect(result.lateralVelocitySamples.after100Milliseconds).toBeGreaterThan(8);
    expect(result.lateralVelocitySamples.after250Milliseconds).toBeGreaterThan(6);
    expect(result.lateralVelocitySamples.after500Milliseconds).toBeGreaterThan(4);
    expect(result.lateralVelocitySamples.after1000Milliseconds).toBeGreaterThan(2);
    expect(result.rolledOver).toBe(false);
  });

  it('smoothly recovers RAM slide grip without changing normal vehicle grip', () => {
    const arena = createArena();
    const vehicle = arena.vehicles.spawnVehicle('slide-recovery');
    expect(vehicle.ramSlideGripMultiplier).toBe(1);
    vehicle.startRamSlide();
    const initialGrip = vehicle.ramSlideGripMultiplier;
    expect(initialGrip).toBe(PLAYER_COLLISION_TUNING.ramSlideInitialGripMultiplier);
    expect(vehicle.ramSlideRemainingSeconds).toBe(
      PLAYER_COLLISION_TUNING.ramSlideDurationSeconds,
    );

    const recoveredGrip: number[] = [];
    for (let sample = 0; sample < 4; sample += 1) {
      stepArena(arena, 15);
      recoveredGrip.push(vehicle.ramSlideGripMultiplier);
    }
    expect(recoveredGrip[0]).toBeGreaterThan(initialGrip);
    expect(recoveredGrip[1]).toBeGreaterThan(recoveredGrip[0] ?? 0);
    expect(recoveredGrip[2]).toBeGreaterThan(recoveredGrip[1] ?? 0);
    expect(recoveredGrip[3]).toBeGreaterThan(recoveredGrip[2] ?? 0);
    stepArena(arena, 12);
    expect(vehicle.ramSlideRemainingSeconds).toBe(0);
    expect(vehicle.ramSlideGripMultiplier).toBe(1);
  });

  it('keeps at least eight of ten 15 km/h side RAM targets upright', () => {
    const results = Array.from({ length: 10 }, () => runSideImpact(15, 0, 60));
    expect(results.filter((result) => result.rolledOver)).toHaveLength(0);
    expect(Math.min(...results.map((result) => result.displacement))).toBeGreaterThan(7);
  });

  it('keeps at least 98 of 100 varied 20 km/h side RAM targets upright', () => {
    const results = Array.from({ length: 100 }, (_, index) => {
      const variant = sideImpactVariant(index);
      return runSideImpact(20, variant.targetX, 60, variant.options);
    });
    expect(results.filter((result) => result.rolledOver).length).toBeLessThanOrEqual(2);
    expect(average(results.map((result) => result.displacement))).toBeGreaterThan(8);
    expect(
      average(results.map((result) => result.targetImpactDeltaSpeed)),
    ).toBeGreaterThan(8);
    expect(
      Math.max(...results.map((result) => result.maximumGroundedRollPitchAngularSpeed)),
    ).toBeLessThanOrEqual(VEHICLE_TUNING.maxGroundedRollPitchAngularSpeed + 0.05);
    expect(
      Math.max(...results.map((result) => result.maximumGroundedHardLimitTicks)),
    ).toBeLessThanOrEqual(6);
    expect(
      Math.max(...results.map((result) => result.maximumTrailerTiltDegrees)),
    ).toBeLessThanOrEqual(VEHICLE_TUNING.groundedOrientationSoftLimitDegrees);
    expect(
      Math.max(...results.map((result) => result.maximumTrailerHardLimitTicks)),
    ).toBe(0);
  });

  it('keeps 30 km/h RAM horizontal and strong without forcing every rollover', () => {
    const results = Array.from({ length: 10 }, (_, index) => {
      const variant = sideImpactVariant(index * 7);
      return runSideImpact(30, variant.targetX, 60, variant.options);
    });
    expect(results.filter((result) => result.rolledOver).length).toBeLessThanOrEqual(1);
    expect(average(results.map((result) => result.displacement))).toBeGreaterThan(12);
  });

  it('applies the extra arcade RAM at center of mass without angular delta', () => {
    const result = runSideImpact(20, 0, 2);
    expect(result.assistImpulse).toBeGreaterThan(0);
    expect(result.targetImpactDeltaSpeed).toBeGreaterThan(8);
    expect(result.arcadeAngularVelocityDelta).toBeLessThan(1e-6);
  });
  it('keeps equal player mass and conservative native collider materials', () => {
    const arena = createArena();
    const first = arena.vehicles.spawnVehicle('mass-a');
    const second = arena.vehicles.spawnVehicle('mass-b');
    expect(first.body.mass()).toBeCloseTo(VEHICLE_TUNING.mass, 4);
    expect(second.body.mass()).toBeCloseTo(first.body.mass(), 4);
    expect(first.collider.restitution()).toBeLessThanOrEqual(0.1);
    expect(first.collider.friction()).toBeLessThanOrEqual(0.81);
  });

  it('keeps a 5 km/h physical contact gentle', () => {
    const result = runSideImpact(5, 0, 20);
    expect(result.assistImpulse).toBe(0);
    expect(result.targetArcadeDeltaVelocity).toBe(0);
    expect(Math.abs(result.displacement)).toBeLessThan(1);
  });

  it('starts the explicit RAM response at 10 km/h', () => {
    const result = runSideImpact(10, 0, 40);
    expect(result.targetArcadeDeltaVelocity).toBeGreaterThanOrEqual(2);
    expect(result.targetArcadeDeltaVelocity).toBeLessThan(4);
    expect(result.displacement).toBeGreaterThan(1);
  });

  it('makes 15, 20 and 30 km/h RAM impacts progressively stronger', () => {
    const ten = runSideImpact(10);
    const fifteen = runSideImpact(15);
    const twenty = runSideImpact(20);
    const thirty = runSideImpact(30);
    expect(fifteen.targetArcadeDeltaVelocity).toBeGreaterThan(
      ten.targetArcadeDeltaVelocity,
    );
    expect(twenty.targetArcadeDeltaVelocity).toBeGreaterThan(
      fifteen.targetArcadeDeltaVelocity,
    );
    expect(twenty.displacement).toBeGreaterThan(ten.displacement);
    expect(thirty.assistImpulse).toBeGreaterThan(twenty.assistImpulse);
    expect(thirty.targetImpactDeltaSpeed).toBeGreaterThan(twenty.targetImpactDeltaSpeed);
    expect(thirty.displacement).toBeGreaterThan(twenty.displacement);
    expect(fifteen.targetArcadeDeltaVelocity).toBeGreaterThanOrEqual(5);
    expect(twenty.targetArcadeDeltaVelocity).toBeGreaterThanOrEqual(8);
    expect(thirty.targetArcadeDeltaVelocity).toBe(12);
    expect(twenty.targetAdhesionBreakSeconds).toBeGreaterThanOrEqual(1);
    expect(thirty.targetAdhesionBreakSeconds).toBe(1.5);
  });

  it('gives the attacker a smaller counter-reaction than the target assist', () => {
    const result = runSideImpact(25, 0, 2);
    expect(result.targetImpactDeltaSpeed).toBeGreaterThan(0);
    expect(result.attackerImpactSpeedLoss).toBeGreaterThan(0);
    expect(result.attackerReactionRatio).toBe(
      PLAYER_COLLISION_TUNING.ramAttackerReactionRatio,
    );
    expect(result.attackerImpactSpeedLoss).toBeCloseTo(
      result.targetArcadeDeltaVelocity * result.attackerReactionRatio,
      1,
    );
    expect(result.closingSpeed - result.attackerImpactSpeedLoss).toBeGreaterThan(2);
  });

  it('does not exceed the configured horizontal knockback cap', () => {
    const forty = runSideImpact(40);
    expect(forty.targetArcadeDeltaVelocity).toBeLessThanOrEqual(
      PLAYER_COLLISION_TUNING.ramMaximumTargetDeltaVelocity,
    );
    expect(forty.assistImpulse).toBeLessThanOrEqual(
      PLAYER_COLLISION_TUNING.ramMaximumTargetDeltaVelocity * VEHICLE_TUNING.mass,
    );
  });

  it('keeps a head-on collision finite and vertically controlled', () => {
    const arena = createArena();
    stepArena(arena, 190);
    const first = placeVehicle(arena, 'head-a', [0, deckVehicleY(), -2.2], [0, 0, 5.5]);
    const second = placeVehicle(arena, 'head-b', [0, deckVehicleY(), 2.2], [0, 0, -5.5]);
    stepArena(arena, 60);
    expect(JSON.stringify([first.createSnapshot(), second.createSnapshot()])).not.toMatch(
      /NaN|Infinity/,
    );
    expect(Math.abs(first.body.linvel().y)).toBeLessThan(6);
    expect(Math.abs(second.body.linvel().y)).toBeLessThan(6);
    expect(
      Math.hypot(
        first.body.translation().x - second.body.translation().x,
        first.body.translation().z - second.body.translation().z,
      ),
    ).toBeGreaterThan(1.5);
  });

  it('keeps a rear-end collision finite and transfers forward momentum', () => {
    const arena = createArena();
    stepArena(arena, 190);
    const attacker = placeVehicle(arena, 'rear-a', [0, deckVehicleY(), -4], [0, 0, 7]);
    const target = placeVehicle(arena, 'rear-b', [0, deckVehicleY(), 0], [0, 0, 0]);
    stepArena(arena, 50);
    const targetLocal = arena.convoy.worldToTrailerLocal(
      toTuple(target.body.translation()),
    );
    expect(targetLocal[2]).toBeGreaterThan(0.3);
    expect(horizontalRelativeSpeed(arena, attacker.body)).toBeLessThan(7);
    expect(JSON.stringify(arena.vehicles.lastPlayerImpact)).not.toMatch(/NaN|Infinity/);
  });

  it('keeps extra side-impact vertical speed below the configured safety envelope', () => {
    const result = runSideImpact(30);
    expect(PLAYER_COLLISION_TUNING.ramVerticalDeltaVelocityMax).toBe(0);
    expect(result.maximumVerticalSpeed).toBeLessThan(6);
    expect(result.maximumUpwardMovement).toBeLessThan(0.5);
  });

  it('does not create unbounded speed across repeated separated impacts', () => {
    const arena = createArena();
    stepArena(arena, 190);
    let maximumSpeed = 0;
    let previousImpact = arena.vehicles.lastPlayerImpact;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const attacker = placeVehicle(
        arena,
        'repeat-a',
        [-3, deckVehicleY(), 0],
        [8.33, 0, 0],
        Math.PI / 2,
      );
      const target = placeVehicle(arena, 'repeat-b', [0, deckVehicleY(), 0], [0, 0, 0]);
      stepArena(arena, 35);
      expect(arena.vehicles.lastPlayerImpact).not.toBe(previousImpact);
      expect(arena.vehicles.lastPlayerImpact?.assistImpulse).toBeGreaterThan(0);
      previousImpact = arena.vehicles.lastPlayerImpact;
      maximumSpeed = Math.max(
        maximumSpeed,
        horizontalRelativeSpeed(arena, attacker.body),
        horizontalRelativeSpeed(arena, target.body),
      );
      placeVehicle(arena, 'repeat-a', [-12, deckVehicleY(), 0], [0, 0, 0]);
      placeVehicle(arena, 'repeat-b', [12, deckVehicleY(), 0], [0, 0, 0]);
      stepArena(
        arena,
        Math.ceil(
          PLAYER_COLLISION_TUNING.ramPairCooldownSeconds / SIMULATION_FIXED_DELTA_SECONDS,
        ) + 2,
      );
    }
    expect(maximumSpeed).toBeLessThan(25);
  });

  it('knocks off at least four of five 20 km/h hits from 2.5m inside the lip', () => {
    let knockOffs = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = runSideImpact(20, 1, 120);
      if (
        !result.finalOnTrailer ||
        result.displacement > 1.2 ||
        result.finalLocalY < TRAILER_DIMENSIONS.deckHeight
      ) {
        knockOffs += 1;
      }
    }
    expect(knockOffs).toBeGreaterThanOrEqual(4);
  });

  it('slides an edge target past the side lip instead of defaulting to a rollover', () => {
    const result = runSideImpact(20, 1, 90);
    expect(result.displacement).toBeGreaterThan(10);
    expect(result.rolledOver).toBe(false);
  });

  it('releases collision grip temporarily and then reanchors at the current position', () => {
    const arena = createArena();
    stepArena(arena, 190);
    const attacker = placeVehicle(
      arena,
      'adhesion-attacker',
      [-3, deckVehicleY(), 0],
      [20 / 3.6, 0, 0],
      Math.PI / 2,
    );
    attacker.applyInput({
      type: 'player_input',
      sequence: 1,
      throttle: 0,
      brake: 0,
      steering: 0,
      handbrake: true,
    });
    const target = placeVehicle(
      arena,
      'adhesion-target',
      [0, deckVehicleY(), 0],
      [0, 0, 0],
    );
    stepArena(arena, 30);
    expect(arena.vehicles.lastPlayerImpact?.targetAdhesionBreakSeconds).toBeGreaterThan(
      PLAYER_COLLISION_TUNING.ramAdhesionBreakMinSeconds,
    );
    expect(target.ramSlideGripMultiplier).toBeGreaterThan(
      PLAYER_COLLISION_TUNING.ramSlideInitialGripMultiplier,
    );
    expect(target.ramSlideGripMultiplier).toBeLessThan(1);
    expect(target.trailerAdhesionSuspended).toBe(true);
    expect(attacker.ramSlideGripMultiplier).toBe(1);
    const ticksUntilSlideEnd = Math.max(
      0,
      Math.floor(target.ramSlideRemainingSeconds / SIMULATION_FIXED_DELTA_SECONDS) - 1,
    );
    stepArena(arena, ticksUntilSlideEnd);
    expect(target.ramSlideRemainingSeconds).toBeGreaterThan(0);
    expect(target.trailerAdhesionSuspended).toBe(true);
    placeVehicle(arena, target.playerId, [1, deckVehicleY(), 1.5], [0, 0, 0]);
    stepArena(arena, 120);
    expect(target.ramSlideGripMultiplier).toBe(1);
    expect(target.trailerAdhesionSuspended).toBe(false);
    const displaced = arena.convoy.worldToTrailerLocal(
      toTuple(target.body.translation()),
    );
    stepArena(arena, 360);
    const settled = arena.convoy.worldToTrailerLocal(toTuple(target.body.translation()));
    expect(displaced[0]).toBeGreaterThan(0.75);
    expect(settled[0]).toBeGreaterThan(0.75);
    expect(Math.hypot(settled[0] - displaced[0], settled[2] - displaced[2])).toBeLessThan(
      1.25,
    );
    expect(target.createSnapshot().onTrailer).toBe(true);
  });

  it('applies arcade assist once during one persistent contact', () => {
    const arena = createArena();
    stepArena(arena, 190);
    placeVehicle(arena, 'persistent-a', [-2, deckVehicleY(), 0], [3, 0, 0], Math.PI / 2);
    placeVehicle(arena, 'persistent-b', [0, deckVehicleY(), 0], [0, 0, 0]);
    let impactReference = arena.vehicles.lastPlayerImpact;
    for (let tick = 0; tick < 90; tick += 1) {
      stepArena(arena);
      const current = arena.vehicles.lastPlayerImpact;
      if (impactReference === null && current !== null) impactReference = current;
    }
    expect(impactReference).not.toBeNull();
    expect(arena.vehicles.lastPlayerImpact).toBe(impactReference);
  });

  it('suppresses a same-pair recontact during the RAM cooldown', () => {
    const arena = createArena();
    stepArena(arena, 190);
    placeVehicle(
      arena,
      'cooldown-a',
      [-3, deckVehicleY(), 0],
      [30 / 3.6, 0, 0],
      Math.PI / 2,
    );
    placeVehicle(arena, 'cooldown-b', [0, deckVehicleY(), 0], [0, 0, 0]);
    let firstRam: PlayerImpactMeasurement | null = null;
    for (let tick = 0; tick < 20; tick += 1) {
      stepArena(arena);
      firstRam ??= arena.vehicles.lastPlayerImpact;
      if (firstRam !== null) break;
    }
    expect(firstRam?.assistImpulse).toBeGreaterThan(0);

    placeVehicle(
      arena,
      'cooldown-a',
      [-3, deckVehicleY(), 0],
      [30 / 3.6, 0, 0],
      Math.PI / 2,
    );
    placeVehicle(arena, 'cooldown-b', [0, deckVehicleY(), 0], [0, 0, 0]);
    stepArena(arena, 5);
    expect(arena.vehicles.lastPlayerImpact).toBe(firstRam);
  });

  it('allows a different attacker to RAM a target that is still sliding', () => {
    const arena = createArena();
    stepArena(arena, 190);
    const firstAttacker = placeVehicle(
      arena,
      'multi-first',
      [-3, deckVehicleY(), 0],
      [15 / 3.6, 0, 0],
      Math.PI / 2,
    );
    firstAttacker.applyInput({
      type: 'player_input',
      sequence: 1,
      throttle: 0,
      brake: 0,
      steering: 0,
      handbrake: true,
    });
    const target = placeVehicle(arena, 'multi-target', [0, deckVehicleY(), 0], [0, 0, 0]);
    stepArena(arena, 8);
    const firstImpact = arena.vehicles.lastPlayerImpact;
    expect(firstImpact).not.toBeNull();
    expect(horizontalRelativeSpeed(arena, target.body)).toBeGreaterThan(0.5);

    placeVehicle(arena, firstAttacker.playerId, [-12, deckVehicleY(), 0], [0, 0, 0]);
    const movingTargetLocal = arena.convoy.worldToTrailerLocal(
      toTuple(target.body.translation()),
    );
    placeVehicle(
      arena,
      'multi-second',
      [movingTargetLocal[0] - 3, deckVehicleY(), movingTargetLocal[2]],
      [20, 0, 0],
      Math.PI / 2,
    );
    let secondImpact: PlayerImpactMeasurement | null = null;
    for (let tick = 0; tick < 60; tick += 1) {
      stepArena(arena);
      const candidate = arena.vehicles.lastPlayerImpact;
      if (
        candidate !== null &&
        candidate !== firstImpact &&
        (candidate.firstPlayerId === 'multi-second' ||
          candidate.secondPlayerId === 'multi-second') &&
        candidate.assistImpulse > 0
      ) {
        secondImpact = candidate;
        break;
      }
    }
    expect(secondImpact).not.toBe(firstImpact);
    expect(
      secondImpact?.firstPlayerId === 'multi-second' ||
        secondImpact?.secondPlayerId === 'multi-second',
    ).toBe(true);
    expect(secondImpact?.assistImpulse).toBeGreaterThan(0);
    expect(JSON.stringify(target.createSnapshot())).not.toMatch(/NaN|Infinity/);
  });

  it('creates a strong RAM after an eight-metre throttle run-up', () => {
    const arena = createArena();
    stepArena(arena, 190);
    const attacker = placeVehicle(
      arena,
      'short-run-attacker',
      [0, deckVehicleY(), -6],
      [0, 0, 0],
      0,
    );
    attacker.applyInput({
      type: 'player_input',
      sequence: 1,
      throttle: 1,
      brake: 0,
      steering: 0,
      handbrake: false,
    });
    const target = placeVehicle(
      arena,
      'short-run-target',
      [0, deckVehicleY(), 2],
      [0, 0, 0],
    );
    let impact: PlayerImpactMeasurement | null = null;
    for (let tick = 0; tick < 300; tick += 1) {
      stepArena(arena);
      impact ??= arena.vehicles.lastPlayerImpact;
      if (impact !== null) break;
    }
    expect(impact).not.toBeNull();
    expect(impact?.targetArcadeDeltaVelocity).toBeGreaterThanOrEqual(5);
    stepArena(arena, 30);
    const targetLocal = arena.convoy.worldToTrailerLocal(
      toTuple(target.body.translation()),
    );
    expect(targetLocal[2] - 2).toBeGreaterThan(3);
  });

  it('preserves collision-free ten-second trailer stability', () => {
    const arena = createArena();
    stepArena(arena, 190);
    const vehicle = placeVehicle(
      arena,
      'neutral-stability',
      [0, deckVehicleY(), 0],
      [0, 0, 0],
    );
    stepArena(arena, 120);
    const start = arena.convoy.worldToTrailerLocal(toTuple(vehicle.body.translation()));
    stepArena(arena, 600);
    const end = arena.convoy.worldToTrailerLocal(toTuple(vehicle.body.translation()));
    expect(Math.hypot(end[0] - start[0], end[2] - start[2])).toBeLessThan(0.25);
  });
});

function deckVehicleY(): number {
  return TRAILER_DIMENSIONS.deckHeight + TRAILER_DIMENSIONS.deckThickness / 2 + 0.82;
}

function horizontalRelativeSpeed(arena: ImpactArena, body: RAPIER.RigidBody): number {
  const velocity = body.linvel();
  const surface = arena.convoy.trailerBody.velocityAtPoint(body.translation());
  return Math.hypot(velocity.x - surface.x, velocity.z - surface.z);
}

function impactRelativeLateralSpeed(
  arena: ImpactArena,
  body: RAPIER.RigidBody,
  measurement: PlayerImpactMeasurement,
  targetPlayerId: string,
): number {
  const velocity = body.linvel();
  const surface = arena.convoy.trailerBody.velocityAtPoint(body.translation());
  const direction =
    measurement.secondPlayerId === targetPlayerId
      ? measurement.normal
      : (measurement.normal.map((component) => -component) as [number, number, number]);
  return Math.abs(
    (velocity.x - surface.x) * direction[0] + (velocity.z - surface.z) * direction[2],
  );
}

function rotateVector(vector: Vector3Tuple, rotation: RAPIER.Rotation): RAPIER.Vector3 {
  const [x, y, z] = vector;
  const tx = 2 * (rotation.y * z - rotation.z * y);
  const ty = 2 * (rotation.z * x - rotation.x * z);
  const tz = 2 * (rotation.x * y - rotation.y * x);
  return {
    x: x + rotation.w * tx + (rotation.y * tz - rotation.z * ty),
    y: y + rotation.w * ty + (rotation.z * tx - rotation.x * tz),
    z: z + rotation.w * tz + (rotation.x * ty - rotation.y * tx),
  };
}

function multiplyRotations(
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

function toVector(tuple: Vector3Tuple): RAPIER.Vector3 {
  return { x: tuple[0], y: tuple[1], z: tuple[2] };
}

function toTuple(vector: RAPIER.Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z];
}

function dotDelta(
  before: readonly [number, number, number],
  after: readonly [number, number, number],
  direction: readonly [number, number, number],
): number {
  return (
    (after[0] - before[0]) * direction[0] +
    (after[1] - before[1]) * direction[1] +
    (after[2] - before[2]) * direction[2]
  );
}

function vehicleUp(rotation: RAPIER.Rotation): RAPIER.Vector3 {
  return {
    x: 2 * (rotation.x * rotation.y - rotation.w * rotation.z),
    y: 1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z),
    z: 2 * (rotation.y * rotation.z + rotation.w * rotation.x),
  };
}

function tupleDistance(
  first: readonly [number, number, number],
  second: readonly [number, number, number],
): number {
  return Math.hypot(second[0] - first[0], second[1] - first[1], second[2] - first[2]);
}

function sideImpactVariant(index: number): {
  readonly targetX: number;
  readonly options: SideImpactOptions;
} {
  const targetXs = [-1, -0.5, 0, 0.5, 1] as const;
  const targetZs = [-3, -1.5, 0, 1.5, 3] as const;
  const contactOffsets = [-0.55, -0.25, 0, 0.25, 0.55] as const;
  const targetYaws = [-0.18, -0.09, 0, 0.09, 0.18] as const;
  const attackerYawOffsets = [-0.08, -0.04, 0, 0.04, 0.08] as const;
  return {
    targetX: targetXs[index % targetXs.length] ?? 0,
    options: {
      targetZ: targetZs[Math.floor(index / 5) % targetZs.length] ?? 0,
      contactOffsetZ: contactOffsets[Math.floor(index / 25) % contactOffsets.length] ?? 0,
      targetYaw: targetYaws[Math.floor(index / 3) % targetYaws.length] ?? 0,
      attackerYawOffset:
        attackerYawOffsets[Math.floor(index / 7) % attackerYawOffsets.length] ?? 0,
    },
  };
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
