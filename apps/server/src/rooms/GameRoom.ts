import type RAPIER from '@dimforge/rapier3d-compat';
import {
  MAX_PLAYERS_PER_ROOM,
  SIMULATION_TICK_RATE,
  TRAILER_DIMENSIONS,
} from '@trailer-arena/shared';
import type {
  GameplayEventMessage,
  GameStateSnapshot,
  PlayerInputMessage,
  VehicleStateSnapshot,
  WorldSnapshotMessage,
} from '@trailer-arena/shared';
import type { ConvoyStateSnapshot } from '@trailer-arena/shared';

import { ConvoySystem } from '../convoy/ConvoySystem.js';
import { GameModeSystem, type GameActionResult } from '../gameplay/GameModeSystem.js';
import type { ServerPlayer } from '../players/ServerPlayer.js';
import { VehicleSystem } from '../vehicles/VehicleSystem.js';
import { createRoomPhysicsContext } from '../world/PhysicsWorldBuilder.js';
import { selectRoomSpawn } from './RoomSpawnSelector.js';

export type AddPlayerResult =
  { ok: true } | { ok: false; reason: 'ROOM_FULL' | 'PLAYER_ALREADY_PRESENT' };

export class GameRoom {
  private readonly players = new Map<string, ServerPlayer>();
  private readonly physicsWorld: RAPIER.World;
  private readonly vehicleSystem: VehicleSystem;
  private readonly convoySystem: ConvoySystem;
  private readonly gameModeSystem: GameModeSystem;
  private readonly deckSupportedPlayerIds = new Set<string>();
  private readonly debugUnderbodyCases = new Map<string, number>();
  private debugPlayerCollisionCase = 0;
  private gameplayEventSequence = 0;
  private currentTick = 0;

  public constructor(
    public readonly id: string,
    public readonly capacity = MAX_PLAYERS_PER_ROOM,
  ) {
    const physics = createRoomPhysicsContext();
    const debugRoundSeconds = Number(process.env['DEBUG_ROUND_DURATION_SECONDS'] ?? '');
    this.gameModeSystem = new GameModeSystem(
      process.env['NODE_ENV'] !== 'production' &&
        Number.isFinite(debugRoundSeconds) &&
        debugRoundSeconds > 0
        ? { roundDurationTicks: Math.round(debugRoundSeconds * SIMULATION_TICK_RATE) }
        : {},
    );
    this.physicsWorld = physics.world;
    this.convoySystem = new ConvoySystem(physics.world, physics.surfaces);
    this.vehicleSystem = new VehicleSystem(physics.world, physics.surfaces);
  }

  public get playerCount(): number {
    return this.players.size;
  }

  public get isEmpty(): boolean {
    return this.players.size === 0;
  }

  public get isFull(): boolean {
    return this.players.size >= this.capacity;
  }

  public addPlayer(player: ServerPlayer): AddPlayerResult {
    if (this.players.has(player.id)) {
      return { ok: false, reason: 'PLAYER_ALREADY_PRESENT' };
    }
    if (this.isFull) {
      return { ok: false, reason: 'ROOM_FULL' };
    }

    const vehicle = this.vehicleSystem.spawnVehicle(
      player.id,
      selectRoomSpawn(this.physicsWorld),
    );
    this.players.set(player.id, player);
    this.gameModeSystem.addPlayer(player.id, player.name);
    vehicle.setControlsEnabled(this.gameModeSystem.canPlayerControl(player.id));
    return { ok: true };
  }

  public removePlayer(playerId: string): ServerPlayer | undefined {
    const player = this.players.get(playerId);
    if (player !== undefined) {
      this.vehicleSystem.removeVehicle(playerId);
      this.gameModeSystem.removePlayer(playerId);
      this.players.delete(playerId);
      this.debugUnderbodyCases.delete(playerId);
      this.deckSupportedPlayerIds.delete(playerId);
    }
    return player;
  }

  public hasPlayer(playerId: string): boolean {
    return this.players.has(playerId);
  }

  public getPlayers(): readonly ServerPlayer[] {
    return Array.from(this.players.values());
  }

  public setPlayerConnected(playerId: string, connected: boolean): boolean {
    const player = this.players.get(playerId);
    if (player === undefined) return false;
    player.connectionState = connected ? 'CONNECTED' : 'DISCONNECTED_GRACE';
    this.gameModeSystem.setPlayerConnected(playerId, connected);
    this.vehicleSystem.setPlayerControlsEnabled(
      playerId,
      connected && this.gameModeSystem.canPlayerControl(playerId),
    );
    return true;
  }

  public getVehicleSystem(): VehicleSystem {
    return this.vehicleSystem;
  }

  public getConvoySystem(): ConvoySystem {
    return this.convoySystem;
  }

  public getPhysicsWorld(): RAPIER.World {
    return this.physicsWorld;
  }

  public applyPlayerInput(playerId: string, message: PlayerInputMessage): boolean {
    if (!this.players.has(playerId) || !this.gameModeSystem.canPlayerControl(playerId)) {
      return false;
    }
    return this.vehicleSystem.applyPlayerInput(playerId, message);
  }

  public resetVehicle(playerId: string): boolean {
    return (
      this.players.has(playerId) &&
      this.gameModeSystem.canPlayerControl(playerId) &&
      this.vehicleSystem.resetVehicle(playerId)
    );
  }

  public selfRightVehicle(playerId: string): boolean {
    return (
      this.players.has(playerId) &&
      this.gameModeSystem.canPlayerControl(playerId) &&
      this.vehicleSystem.selfRightVehicle(playerId)
    );
  }

  public setPlayerReady(playerId: string, ready: boolean): boolean {
    return this.gameModeSystem.setReady(playerId, ready);
  }

  public startMatch(playerId: string): GameActionResult {
    const result = this.gameModeSystem.startMatch(playerId, this.currentTick);
    if (result.ok) this.resetRoundEntities();
    return result;
  }

  public startNextRound(playerId: string): GameActionResult {
    const result = this.gameModeSystem.nextRound(playerId, this.currentTick);
    if (result.ok) this.resetRoundEntities();
    return result;
  }

  public teleportVehicleNearTrailer(playerId: string): boolean {
    if (!this.players.has(playerId)) {
      return false;
    }
    const spawnPoint = this.convoySystem.getSafeApproachSpawn();
    if (!this.vehicleSystem.teleportVehicle(playerId, spawnPoint)) {
      return false;
    }
    const vehicle = this.vehicleSystem.getVehicle(playerId);
    if (vehicle === undefined) {
      return false;
    }
    const [, rotationY, , rotationW] = spawnPoint.rotation;
    // The development helper gives the car a modest closing speed so a manual
    // ramp test starts immediately instead of requiring a full chase lap.
    const speed = this.convoySystem.currentSpeed + 4;
    vehicle.body.setLinvel(
      {
        x: 2 * rotationY * rotationW * speed,
        y: 0,
        z: (1 - 2 * rotationY * rotationY) * speed,
      },
      true,
    );
    return true;
  }

  public teleportVehicleOntoTrailer(playerId: string): boolean {
    if (!this.players.has(playerId)) {
      return false;
    }
    const playerIndex = Array.from(this.players.keys()).indexOf(playerId);
    const laneOffset = this.players.size > 1 ? (playerIndex % 2 === 0 ? -0.8 : 0.8) : 0;
    const position = this.convoySystem.trailerLocalToWorld([
      laneOffset,
      TRAILER_DIMENSIONS.deckHeight + TRAILER_DIMENSIONS.deckThickness / 2 + 0.82,
      0,
    ]);
    const trailerRotation = this.convoySystem.trailerBody.rotation();
    const vehicle = this.vehicleSystem.getVehicle(playerId);
    if (vehicle === undefined) {
      return false;
    }
    vehicle.teleportTo({
      position,
      rotation: [
        trailerRotation.x,
        trailerRotation.y,
        trailerRotation.z,
        trailerRotation.w,
      ],
    });
    vehicle.body.setLinvel(
      this.convoySystem.trailerBody.velocityAtPoint({
        x: position[0],
        y: position[1],
        z: position[2],
      }),
      true,
    );
    vehicle.body.setAngvel(this.convoySystem.trailerBody.angvel(), true);
    return true;
  }

  public debugFlipVehicle(playerId: string): boolean {
    if (!this.players.has(playerId)) {
      return false;
    }
    const vehicle = this.vehicleSystem.getVehicle(playerId);
    if (vehicle === undefined) {
      return false;
    }
    const rotation = vehicle.body.rotation();
    vehicle.body.setRotation(
      {
        x: rotation.y,
        y: -rotation.x,
        z: rotation.w,
        w: -rotation.z,
      },
      true,
    );
    vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    vehicle.body.resetForces(true);
    vehicle.body.resetTorques(true);
    return true;
  }

  public debugTestUnderbody(playerId: string): boolean {
    if (!this.players.has(playerId)) {
      return false;
    }
    const vehicle = this.vehicleSystem.getVehicle(playerId);
    if (vehicle === undefined) {
      return false;
    }
    const testCases = [
      { position: [5.2, 0.72, 0], velocity: [-10, 0, 0] },
      { position: [4.6, 0.72, -10], velocity: [-2.5, 0, 8] },
      { position: [3.8, 0.75, 10.2], velocity: [-7, 0, -3] },
    ] as const;
    const caseIndex = this.debugUnderbodyCases.get(playerId) ?? 0;
    this.debugUnderbodyCases.set(playerId, (caseIndex + 1) % testCases.length);
    const testCase = testCases[caseIndex % testCases.length]!;
    const position = this.convoySystem.trailerLocalToWorld([
      testCase.position[0],
      testCase.position[1],
      testCase.position[2],
    ]);
    const trailerRotation = this.convoySystem.trailerBody.rotation();
    const localYaw = Math.atan2(testCase.velocity[0], testCase.velocity[2]);
    const localYawRotation = {
      x: 0,
      y: Math.sin(localYaw / 2),
      z: 0,
      w: Math.cos(localYaw / 2),
    };
    const rotation = multiplyRotations(trailerRotation, localYawRotation);
    vehicle.teleportTo({
      position,
      rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
    });
    const rotatedVelocity = rotateVector(testCase.velocity, trailerRotation);
    const surfaceVelocity = this.convoySystem.trailerBody.velocityAtPoint({
      x: position[0],
      y: position[1],
      z: position[2],
    });
    vehicle.body.setLinvel(
      {
        x: surfaceVelocity.x + rotatedVelocity.x,
        y: surfaceVelocity.y + rotatedVelocity.y,
        z: surfaceVelocity.z + rotatedVelocity.z,
      },
      true,
    );
    return true;
  }

  public debugTestPlayerCollision(playerId: string): boolean {
    if (!this.players.has(playerId) || this.players.size < 2) {
      return false;
    }
    const playerIds = Array.from(this.players.keys());
    const first = this.vehicleSystem.getVehicle(playerIds[0]!);
    const second = this.vehicleSystem.getVehicle(playerIds[1]!);
    if (first === undefined || second === undefined) {
      return false;
    }
    const cases = [
      {
        name: 'SIDE 10 KM/H',
        firstPosition: [-3, 0, 0],
        firstVelocity: [10 / 3.6, 0, 0],
        firstYaw: Math.PI / 2,
        secondPosition: [0, 0, 0],
        secondVelocity: [0, 0, 0],
        secondYaw: 0,
      },
      {
        name: 'SIDE 15 KM/H',
        firstPosition: [-3, 0, 0],
        firstVelocity: [15 / 3.6, 0, 0],
        firstYaw: Math.PI / 2,
        secondPosition: [0, 0, 0],
        secondVelocity: [0, 0, 0],
        secondYaw: 0,
      },
      {
        name: 'SIDE 20 KM/H',
        firstPosition: [-3, 0, 0],
        firstVelocity: [20 / 3.6, 0, 0],
        firstYaw: Math.PI / 2,
        secondPosition: [0, 0, 0],
        secondVelocity: [0, 0, 0],
        secondYaw: 0,
      },
      {
        name: 'SIDE 30 KM/H',
        firstPosition: [-3, 0, 0],
        firstVelocity: [30 / 3.6, 0, 0],
        firstYaw: Math.PI / 2,
        secondPosition: [0, 0, 0],
        secondVelocity: [0, 0, 0],
        secondYaw: 0,
      },
      {
        name: 'EDGE 20 KM/H · 2.5M INSIDE',
        firstPosition: [-2, 0, 0],
        firstVelocity: [20 / 3.6, 0, 0],
        firstYaw: Math.PI / 2,
        secondPosition: [1, 0, 0],
        secondVelocity: [0, 0, 0],
        secondYaw: 0,
      },
      {
        name: 'LOW SPEED 5 KM/H',
        firstPosition: [-0.9, 0, 0],
        firstVelocity: [5 / 3.6, 0, 0],
        firstYaw: 0,
        secondPosition: [0.9, 0, 0],
        secondVelocity: [0, 0, 0],
        secondYaw: 0,
      },
      {
        name: 'HEAD ON',
        firstPosition: [0, 0, -2.2],
        firstVelocity: [0, 0, 5.5],
        firstYaw: 0,
        secondPosition: [0, 0, 2.2],
        secondVelocity: [0, 0, -5.5],
        secondYaw: Math.PI,
      },
      {
        name: 'REAR END',
        firstPosition: [0, 0, -4],
        firstVelocity: [0, 0, 7],
        firstYaw: 0,
        secondPosition: [0, 0, 0],
        secondVelocity: [0, 0, 0],
        secondYaw: 0,
      },
      {
        name: 'MULTI HIT SETUP 20 KM/H',
        firstPosition: [-3, 0, 0],
        firstVelocity: [20 / 3.6, 0, 0],
        firstYaw: Math.PI / 2,
        secondPosition: [0, 0, 0],
        secondVelocity: [0, 0, 0],
        secondYaw: 0,
      },
      {
        name: 'MULTI HIT FOLLOW-UP',
        preserveSecond: true,
        firstPosition: [-3, 0, 0],
        firstVelocity: [12, 0, 0],
        firstYaw: Math.PI / 2,
        secondPosition: [0, 0, 0],
        secondVelocity: [0, 0, 0],
        secondYaw: 0,
      },
      {
        name: 'SHORT RUN 8M · HOLD THROTTLE',
        firstPosition: [0, 0, -6],
        firstVelocity: [0, 0, 0],
        firstYaw: 0,
        secondPosition: [0, 0, 2],
        secondVelocity: [0, 0, 0],
        secondYaw: 0,
      },
    ] as const;
    const testCase = cases[this.debugPlayerCollisionCase % cases.length]!;
    this.debugPlayerCollisionCase = (this.debugPlayerCollisionCase + 1) % cases.length;
    if ('preserveSecond' in testCase && testCase.preserveSecond) {
      const targetPosition = second.body.translation();
      const targetLocal = this.convoySystem.worldToTrailerLocal([
        targetPosition.x,
        targetPosition.y,
        targetPosition.z,
      ]);
      this.placeVehicleForCollisionTest(
        first,
        [targetLocal[0] - 3, 0, targetLocal[2]],
        testCase.firstVelocity,
        testCase.firstYaw,
      );
    } else {
      this.placeVehicleForCollisionTest(
        first,
        testCase.firstPosition,
        testCase.firstVelocity,
        testCase.firstYaw,
      );
      this.placeVehicleForCollisionTest(
        second,
        testCase.secondPosition,
        testCase.secondVelocity,
        testCase.secondYaw,
      );
    }
    console.info(`[room ${this.id}] player collision test: ${testCase.name}`);
    return true;
  }

  private placeVehicleForCollisionTest(
    vehicle: NonNullable<ReturnType<VehicleSystem['getVehicle']>>,
    localPosition: readonly [number, number, number],
    localVelocity: readonly [number, number, number],
    localYaw: number,
  ): void {
    const deckY =
      TRAILER_DIMENSIONS.deckHeight + TRAILER_DIMENSIONS.deckThickness / 2 + 0.82;
    const position = this.convoySystem.trailerLocalToWorld([
      localPosition[0],
      deckY,
      localPosition[2],
    ]);
    const trailerRotation = this.convoySystem.trailerBody.rotation();
    const rotation = multiplyRotations(trailerRotation, {
      x: 0,
      y: Math.sin(localYaw / 2),
      z: 0,
      w: Math.cos(localYaw / 2),
    });
    vehicle.teleportTo({
      position,
      rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
    });
    const relativeVelocity = rotateVector(localVelocity, trailerRotation);
    const surfaceVelocity = this.convoySystem.trailerBody.velocityAtPoint({
      x: position[0],
      y: position[1],
      z: position[2],
    });
    vehicle.body.setLinvel(
      {
        x: surfaceVelocity.x + relativeVelocity.x,
        y: surfaceVelocity.y + relativeVelocity.y,
        z: surfaceVelocity.z + relativeVelocity.z,
      },
      true,
    );
    vehicle.body.setAngvel(this.convoySystem.trailerBody.angvel(), true);
  }

  public createVehicleSnapshot(): VehicleStateSnapshot[] {
    const snapshots = this.vehicleSystem.createSnapshot();
    for (const snapshot of snapshots) {
      snapshot.trailerRelativePosition = this.convoySystem.worldToTrailerLocal(
        snapshot.position,
      );
    }
    return snapshots;
  }

  public createConvoySnapshot(): ConvoyStateSnapshot {
    return this.convoySystem.createSnapshot();
  }

  public createGameStateSnapshot(): GameStateSnapshot {
    const snapshot = this.gameModeSystem.createSnapshot();
    for (const state of snapshot.players)
      state.connectionState =
        this.players.get(state.playerId)?.connectionState ?? 'DISCONNECTED_GRACE';
    return snapshot;
  }

  public createWorldSnapshot(): WorldSnapshotMessage {
    return {
      type: 'world_snapshot',
      serverTick: this.currentTick,
      vehicles: this.createVehicleSnapshot(),
      convoy: this.createConvoySnapshot(),
      gameState: this.createGameStateSnapshot(),
    };
  }

  public drainGameplayEvents(): GameplayEventMessage[] {
    return this.vehicleSystem.drainPlayerImpacts().map((impact) => {
      const targetPosition = this.vehicleSystem
        .getVehicle(impact.targetPlayerId)
        ?.body.translation();
      return {
        type: 'gameplay_event',
        event: {
          eventType: 'ram_hit',
          eventId: `${this.id}:${this.currentTick}:${this.gameplayEventSequence++}`,
          attackerPlayerId: impact.attackerPlayerId,
          targetPlayerId: impact.targetPlayerId,
          strength: impact.impactCurve,
          position: targetPosition
            ? [targetPosition.x, targetPosition.y, targetPosition.z]
            : [0, 0, 0],
        },
      };
    });
  }

  public update(deltaSeconds: number, tick: number): void {
    this.currentTick = tick;
    this.convoySystem.updateBeforePhysics(
      deltaSeconds,
      this.gameModeSystem.currentPhase === 'PLAYING',
    );
    this.vehicleSystem.update(deltaSeconds);
    this.vehicleSystem.stepPhysics(deltaSeconds);
    this.deckSupportedPlayerIds.clear();
    for (const player of this.players.values()) {
      if (
        this.vehicleSystem.getVehicle(player.id)?.hasTrailerDeckScoringSupport === true
      ) {
        this.deckSupportedPlayerIds.add(player.id);
      }
    }
    const transition = this.gameModeSystem.update(tick, this.deckSupportedPlayerIds);
    if (transition === 'PLAYING_STARTED') {
      this.vehicleSystem.setAllControlsEnabled(false);
      for (const player of this.gameModeSystem.createSnapshot().players) {
        if (player.participant && this.players.get(player.playerId)?.isConnected) {
          this.vehicleSystem.setPlayerControlsEnabled(player.playerId, true);
        }
      }
    } else if (transition === 'RESULTS_STARTED') {
      this.vehicleSystem.setAllControlsEnabled(false);
    }
  }

  public dispose(): void {
    this.vehicleSystem.dispose();
    this.convoySystem.dispose();
    this.players.clear();
    this.debugUnderbodyCases.clear();
    this.deckSupportedPlayerIds.clear();
    this.gameModeSystem.dispose();
    this.physicsWorld.free();
  }

  private resetRoundEntities(): void {
    this.vehicleSystem.setAllControlsEnabled(false);
    this.vehicleSystem.resetVehicles(this.players.keys());
    this.convoySystem.resetForRound();
  }
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

function rotateVector(
  vector: readonly [number, number, number],
  rotation: RAPIER.Rotation,
): RAPIER.Vector3 {
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
