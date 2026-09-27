import RAPIER from '@dimforge/rapier3d-compat';
import type {
  PlayerInputMessage,
  VehicleSpawnPoint,
  VehicleStateSnapshot,
} from '@trailer-arena/shared';

import { SurfaceRegistry } from '../physics/SurfaceRegistry.js';
import { ServerVehicle } from './ServerVehicle.js';
import {
  PlayerCollisionSystem,
  type PlayerImpactMeasurement,
} from './PlayerCollisionSystem.js';
import { VehicleSpawner } from './VehicleSpawner.js';

export class VehicleSystem {
  private readonly vehicles = new Map<string, ServerVehicle>();
  private readonly spawner: VehicleSpawner;
  private readonly playerCollisions: PlayerCollisionSystem;
  private readonly physicsEvents = new RAPIER.EventQueue(true);

  public constructor(
    private readonly world: RAPIER.World,
    private readonly surfaces = new SurfaceRegistry(),
  ) {
    this.spawner = new VehicleSpawner(world);
    this.playerCollisions = new PlayerCollisionSystem();
  }

  public get vehicleCount(): number {
    return this.vehicles.size;
  }

  public get lastPlayerImpact(): PlayerImpactMeasurement | null {
    return this.playerCollisions.lastImpact;
  }

  public drainPlayerImpacts(): PlayerImpactMeasurement[] {
    return this.playerCollisions.drainImpacts();
  }

  public spawnVehicle(playerId: string, spawnPoint?: VehicleSpawnPoint): ServerVehicle {
    const existingVehicle = this.vehicles.get(playerId);
    if (existingVehicle !== undefined) {
      return existingVehicle;
    }

    const spawned = this.spawner.spawn(spawnPoint);
    const vehicle = new ServerVehicle(
      playerId,
      this.world,
      spawned.body,
      spawned.collider,
      spawned.spawnPoint,
      this.surfaces,
    );
    this.vehicles.set(playerId, vehicle);
    return vehicle;
  }

  public removeVehicle(playerId: string): boolean {
    const vehicle = this.vehicles.get(playerId);
    if (vehicle === undefined) {
      return false;
    }
    vehicle.dispose();
    this.vehicles.delete(playerId);
    this.playerCollisions.removePlayer(playerId);
    return true;
  }

  public getVehicle(playerId: string): ServerVehicle | undefined {
    return this.vehicles.get(playerId);
  }

  public applyPlayerInput(playerId: string, message: PlayerInputMessage): boolean {
    return this.vehicles.get(playerId)?.applyInput(message) ?? false;
  }

  public resetVehicle(playerId: string): boolean {
    const vehicle = this.vehicles.get(playerId);
    if (vehicle === undefined) {
      return false;
    }
    vehicle.reset();
    return true;
  }

  public selfRightVehicle(playerId: string): boolean {
    return this.vehicles.get(playerId)?.selfRight() ?? false;
  }

  public setPlayerControlsEnabled(playerId: string, enabled: boolean): boolean {
    const vehicle = this.vehicles.get(playerId);
    if (vehicle === undefined) return false;
    vehicle.setControlsEnabled(enabled);
    return true;
  }

  public setAllControlsEnabled(enabled: boolean): void {
    for (const vehicle of this.vehicles.values()) {
      vehicle.setControlsEnabled(enabled);
    }
  }

  public resetVehicles(playerIds: Iterable<string>): void {
    for (const playerId of playerIds) {
      this.vehicles.get(playerId)?.reset();
    }
  }

  public teleportVehicle(playerId: string, spawnPoint: VehicleSpawnPoint): boolean {
    const vehicle = this.vehicles.get(playerId);
    if (vehicle === undefined) {
      return false;
    }
    vehicle.teleportTo(spawnPoint);
    return true;
  }

  public update(deltaSeconds: number): void {
    for (const vehicle of this.vehicles.values()) {
      vehicle.update(deltaSeconds);
    }
    this.playerCollisions.capturePreStepMotion(this.vehicles);
  }

  public afterPhysicsStep(): void {
    this.playerCollisions.processEvents(
      this.physicsEvents,
      this.vehicles,
      this.world.timestep,
    );
    for (const vehicle of this.vehicles.values()) {
      vehicle.afterPhysicsStep();
    }
  }

  public stepPhysics(deltaSeconds: number): void {
    this.world.timestep = deltaSeconds;
    this.world.step(this.physicsEvents);
    this.afterPhysicsStep();
  }

  public createSnapshot(): VehicleStateSnapshot[] {
    const snapshot: VehicleStateSnapshot[] = [];
    for (const vehicle of this.vehicles.values()) {
      snapshot.push(vehicle.createSnapshot());
    }
    return snapshot;
  }

  public dispose(): void {
    for (const vehicle of this.vehicles.values()) {
      vehicle.dispose();
    }
    this.vehicles.clear();
    this.playerCollisions.clear();
    this.physicsEvents.free();
  }
}
