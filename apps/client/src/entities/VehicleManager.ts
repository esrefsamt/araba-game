import type { VehicleStateSnapshot, WorldSnapshotMessage } from '@trailer-arena/shared';
import type * as THREE from 'three';

import { VehicleView } from './VehicleView.js';
import type { VehicleTransformWriteDebug } from './VehicleView.js';

export class VehicleManager {
  private readonly vehicles = new Map<string, VehicleView>();
  private localPlayerId: string | null = null;

  public constructor(private readonly scene: THREE.Scene) {}

  public setLocalPlayerId(playerId: string): void {
    this.localPlayerId = playerId;
  }

  public applySnapshot(snapshot: WorldSnapshotMessage): void {
    for (const vehicleState of snapshot.vehicles) {
      let view = this.vehicles.get(vehicleState.playerId);
      if (view === undefined) {
        view = new VehicleView(vehicleState.playerId, this.scene);
        this.vehicles.set(vehicleState.playerId, view);
      }
      view.addSnapshot(snapshot.serverTick, vehicleState);
    }
  }

  public beginRenderFrame(): void {
    for (const vehicle of this.vehicles.values()) vehicle.beginRenderFrame();
  }

  public update(renderTick: number, deltaSeconds: number): void {
    for (const [playerId, vehicle] of this.vehicles) {
      if (playerId !== this.localPlayerId) {
        vehicle.updateRemote(renderTick, deltaSeconds);
      }
    }
  }

  public applyLocalPredictedState(
    state: VehicleStateSnapshot,
    deltaSeconds: number,
    platformRenderOffset?: readonly [number, number, number],
  ): void {
    if (state.playerId !== this.localPlayerId) return;
    this.vehicles
      .get(state.playerId)
      ?.applyPredictedState(state, deltaSeconds, platformRenderOffset);
  }

  public updateLocalAuthoritative(renderTick: number, deltaSeconds: number): void {
    if (this.localPlayerId === null) return;
    this.vehicles.get(this.localPlayerId)?.updateRemote(renderTick, deltaSeconds);
  }

  public sampleLocalAuthoritativeState(renderTick: number): VehicleStateSnapshot | null {
    if (this.localPlayerId === null) return null;
    return (
      this.vehicles.get(this.localPlayerId)?.sampleAuthoritativeState(renderTick) ?? null
    );
  }

  public getLocalTransformWriteDebug(): VehicleTransformWriteDebug {
    if (this.localPlayerId === null) {
      return { source: 'NONE', writesThisFrame: 0, conflictingWrites: 0 };
    }
    return (
      this.vehicles.get(this.localPlayerId)?.transformWriteDebug ?? {
        source: 'NONE',
        writesThisFrame: 0,
        conflictingWrites: 0,
      }
    );
  }

  public getRemoteSnapshotBufferSize(): number {
    let maximum = 0;
    for (const [playerId, vehicle] of this.vehicles) {
      if (playerId !== this.localPlayerId) {
        maximum = Math.max(maximum, vehicle.snapshotBufferSize);
      }
    }
    return maximum;
  }

  public removeVehicle(playerId: string): void {
    const vehicle = this.vehicles.get(playerId);
    if (vehicle !== undefined) {
      vehicle.dispose(this.scene);
      this.vehicles.delete(playerId);
    }
  }

  public getLocalObject(): THREE.Object3D | null {
    if (this.localPlayerId === null) {
      return null;
    }
    return this.vehicles.get(this.localPlayerId)?.object ?? null;
  }

  public getVehicleObject(playerId: string): THREE.Object3D | null {
    return this.vehicles.get(playerId)?.object ?? null;
  }

  public getLocalSnapshot(): VehicleStateSnapshot | null {
    if (this.localPlayerId === null) {
      return null;
    }
    return this.vehicles.get(this.localPlayerId)?.getLatestSnapshot() ?? null;
  }

  public clear(): void {
    for (const vehicle of this.vehicles.values()) {
      vehicle.dispose(this.scene);
    }
    this.vehicles.clear();
    this.localPlayerId = null;
  }
}
