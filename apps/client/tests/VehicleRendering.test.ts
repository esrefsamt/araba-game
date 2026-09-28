import type { VehicleStateSnapshot, WorldSnapshotMessage } from '@trailer-arena/shared';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { VehicleManager } from '../src/entities/VehicleManager.js';
import { World } from '../src/world/World.js';

const NEUTRAL_INPUT = {
  throttle: 0,
  brake: 0,
  steering: 0,
  handbrake: false,
} as const;

describe('local and remote rendering authority', () => {
  it.each([true, false])(
    'routes local steering only to local wheels with prediction enabled=%s',
    (predictionEnabled) => {
      const world = new World(new THREE.Scene());
      world.setLocalPlayerId('local');
      world.applySnapshot(worldSnapshot(true));
      world.setPredictionEnabled(predictionEnabled);
      for (let frame = 0; frame < 60; frame += 1)
        world.updateVisualState(1 / 60, { ...NEUTRAL_INPUT, steering: -1 });
      const local = world.getLocalVehicleObject()!;
      const remote = local.parent!.getObjectByName('vehicle-remote')!;
      expect(local.getObjectByName('wheel-steer-front-right')!.rotation.y).toBeLessThan(
        -0.3,
      );
      expect(remote.getObjectByName('wheel-steer-front-right')!.rotation.y).toBe(0);
      expect(world.getPredictionMetrics().renderWritesThisFrame).toBe(1);
      expect(world.getPredictionMetrics().renderWriterConflicts).toBe(0);
      expect(world.getPredictionMetrics().renderWriter).toBe(
        predictionEnabled ? 'PREDICTION' : 'INTERPOLATION',
      );
      world.dispose();
    },
  );

  it('applies prediction only to the local vehicle while remotes stay snapshot-driven', () => {
    const scene = new THREE.Scene();
    const manager = new VehicleManager(scene);
    manager.setLocalPlayerId('local');
    manager.applySnapshot(worldSnapshot());
    manager.beginRenderFrame();
    manager.applyLocalPredictedState(
      vehicleSnapshot('local', { position: [5, 1, 0] }),
      1 / 60,
    );
    manager.update(0, 1 / 60);

    expect(manager.getVehicleObject('local')?.position.x).toBe(5);
    expect(manager.getVehicleObject('remote')?.position.x).toBe(2);
    expect(manager.getLocalTransformWriteDebug()).toEqual({
      source: 'PREDICTION',
      writesThisFrame: 1,
      conflictingWrites: 0,
    });
    manager.clear();
  });

  it('never applies remote interpolation to the local mesh in prediction mode', () => {
    const scene = new THREE.Scene();
    const manager = new VehicleManager(scene);
    manager.setLocalPlayerId('local');
    manager.applySnapshot(worldSnapshot());
    manager.beginRenderFrame();
    manager.update(0, 1 / 60);
    manager.applyLocalPredictedState(vehicleSnapshot('local'), 1 / 60);

    expect(manager.getLocalTransformWriteDebug().writesThisFrame).toBe(1);
    expect(manager.getLocalTransformWriteDebug().source).toBe('PREDICTION');
    expect(manager.getLocalTransformWriteDebug().conflictingWrites).toBe(0);
    manager.clear();
  });

  it('samples authority without mutating buffered server snapshots', () => {
    const scene = new THREE.Scene();
    const manager = new VehicleManager(scene);
    const snapshot = worldSnapshot();
    manager.setLocalPlayerId('local');
    manager.applySnapshot(snapshot);
    const sampled = manager.sampleLocalAuthoritativeState(0);
    expect(sampled).not.toBeNull();
    sampled!.position[0] = 99;
    sampled!.linearVelocity[0] = 99;
    expect(snapshot.vehicles[0]!.position[0]).toBe(0);
    expect(snapshot.vehicles[0]!.linearVelocity[0]).toBe(0);
    manager.clear();
  });

  it('falls back to authoritative interpolation when local prediction is disabled', () => {
    const scene = new THREE.Scene();
    const world = new World(scene);
    world.setLocalPlayerId('local');
    world.applySnapshot(worldSnapshot(true));
    const cameraTarget = world.getLocalVehicleObject();

    world.setPredictionEnabled(false);
    world.updateVisualState(1 / 60, NEUTRAL_INPUT);
    expect(world.getPredictionMetrics().active).toBe(false);
    expect(world.getPredictionMetrics().renderWriter).toBe('INTERPOLATION');
    expect(world.getPredictionMetrics().renderWritesThisFrame).toBe(1);
    expect(world.getLocalVehicleObject()).toBe(cameraTarget);
    expect(world.getLocalVehicleObject()?.position.x).toBe(0);

    world.setPredictionEnabled(true);
    world.updateVisualState(1 / 60, NEUTRAL_INPUT);
    expect(world.getPredictionMetrics().active).toBe(true);
    expect(world.getPredictionMetrics().renderWriter).toBe('PREDICTION');
    expect(world.getPredictionMetrics().renderWritesThisFrame).toBe(1);
    expect(world.getPredictionMetrics().renderWriterConflicts).toBe(0);
    expect(world.getLocalVehicleObject()).toBe(cameraTarget);
    world.dispose();
  });
});

function worldSnapshot(participant = false): WorldSnapshotMessage {
  const body = {
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    linearVelocity: [0, 0, 0] as [number, number, number],
    angularVelocity: [0, 0, 0] as [number, number, number],
  };
  return {
    type: 'world_snapshot',
    serverTick: 0,
    vehicles: [
      vehicleSnapshot('local'),
      vehicleSnapshot('remote', { position: [2, 1, 0] }),
    ],
    convoy: {
      pathProgress: 0,
      speed: 0,
      truck: { ...body },
      trailer: { ...body },
    },
    gameState: {
      phase: 'PLAYING',
      hostPlayerId: 'local',
      roundNumber: 1,
      stateStartTick: 0,
      stateEndTick: 5_400,
      players: participant
        ? [
            {
              playerId: 'local',
              playerName: 'Local',
              ready: true,
              participant: true,
              isScoringOnTrailer: false,
              trailerTicks: 0,
              currentStreakTicks: 0,
              bestStreakTicks: 0,
              roundPoints: 0,
              sessionPoints: 0,
            },
          ]
        : [],
      results: [],
    },
  };
}

function vehicleSnapshot(
  playerId: string,
  overrides: Partial<VehicleStateSnapshot> = {},
): VehicleStateSnapshot {
  return {
    playerId,
    lastProcessedInputSequence: 0,
    position: [0, 1, 0],
    rotation: [0, 0, 0, 1],
    linearVelocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    forwardSpeed: 0,
    lateralSpeed: 0,
    grounded: true,
    surfaceType: 'GROUND',
    onTrailer: false,
    relativeForwardSpeed: 0,
    relativeLateralSpeed: 0,
    wheelContacts: 4,
    trailerDeckContacts: 0,
    trailerRelativePosition: [0, 0, 0],
    flipped: false,
    selfRightAvailable: false,
    ramSlideRemainingTicks: 0,
    ...overrides,
  };
}
