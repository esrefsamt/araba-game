import type {
  ConvoyStateSnapshot,
  GamePhase,
  VehicleInputState,
  VehicleStateSnapshot,
  WorldSnapshotMessage,
} from '@trailer-arena/shared';
import type * as THREE from 'three';

import { ConvoyView } from '../entities/ConvoyView.js';
import { VehicleManager } from '../entities/VehicleManager.js';
import { InterpolationClock } from '../networking/InterpolationClock.js';
import {
  AuthoritativePredictionProxy,
  type PredictionMetrics,
} from '../prediction/AuthoritativePredictionProxy.js';

export interface WorldNetworkMetrics {
  readonly jitterMs: number;
  readonly interpolationDelayMs: number;
  readonly remoteSnapshotBufferSize: number;
}

export class World {
  private readonly vehicles: VehicleManager;
  private readonly convoy: ConvoyView;
  private readonly interpolationClock = new InterpolationClock();
  private readonly prediction = new AuthoritativePredictionProxy();
  private localPlayerId: string | null = null;
  private gamePhase: GamePhase = 'LOBBY';
  private localParticipant = false;
  private predictionEnabled = true;
  private roundTripLatencyMs = 0;

  public constructor(scene: THREE.Scene) {
    this.vehicles = new VehicleManager(scene);
    this.convoy = new ConvoyView(scene);
  }

  public setLocalPlayerId(playerId: string): void {
    this.localPlayerId = playerId;
    this.vehicles.setLocalPlayerId(playerId);
  }

  public applySnapshot(snapshot: WorldSnapshotMessage): void {
    this.interpolationClock.observeSnapshot(snapshot.serverTick);
    this.vehicles.applySnapshot(snapshot);
    this.convoy.applySnapshot(snapshot.serverTick, snapshot.convoy);
    const localState = snapshot.vehicles.find(
      (vehicle) => vehicle.playerId === this.localPlayerId,
    );
    if (localState === undefined) return;
    this.localParticipant =
      snapshot.gameState.players.find((player) => player.playerId === this.localPlayerId)
        ?.participant ?? false;
    const predictionActive =
      this.predictionEnabled &&
      snapshot.gameState.phase === 'PLAYING' &&
      this.localParticipant;
    if (snapshot.gameState.phase !== this.gamePhase) {
      this.prediction.prepareForAuthoritativeDiscontinuity();
      this.gamePhase = snapshot.gameState.phase;
    }
    this.prediction.setActive(predictionActive);
    if (predictionActive) {
      this.prediction.observeAuthoritative(
        snapshot.serverTick,
        localState,
        snapshot.convoy,
      );
    } else {
      this.prediction.resyncFromAuthoritativeState(localState, snapshot.serverTick);
    }
  }

  public removeVehicle(playerId: string): void {
    this.vehicles.removeVehicle(playerId);
  }

  public updateVisualState(
    deltaSeconds: number,
    input: Readonly<VehicleInputState>,
  ): void {
    const renderTick = this.interpolationClock.getRenderTick();
    this.vehicles.beginRenderFrame();
    this.vehicles.update(renderTick, deltaSeconds);
    this.convoy.update(renderTick);
    if (this.prediction.isActive) {
      const authoritativeBase = this.vehicles.sampleLocalAuthoritativeState(renderTick);
      if (authoritativeBase !== null) {
        // At zero RTT this is exactly the same authoritative/interpolated pose
        // as Prediction OFF. Artificial latency only adds a short, bounded
        // visual lead; it never becomes the next frame's physical base.
        const leadSeconds = authoritativeBase.onTrailer
          ? 0
          : this.roundTripLatencyMs / 2_000;
        const visualState = this.prediction.update(
          deltaSeconds,
          input,
          authoritativeBase,
          leadSeconds,
          this.convoy.getLatestSnapshot(),
        );
        this.vehicles.applyLocalPredictedState(visualState, deltaSeconds);
      }
    } else {
      this.vehicles.updateLocalAuthoritative(renderTick, deltaSeconds);
    }
    this.prediction.setRenderDiagnostics(this.vehicles.getLocalTransformWriteDebug());
  }

  public recordLocalInput(sequence: number, input: Readonly<VehicleInputState>): void {
    this.prediction.recordInput(sequence, input);
  }

  public setPredictionEnabled(enabled: boolean): void {
    if (this.predictionEnabled === enabled) return;
    this.predictionEnabled = enabled;
    const active = enabled && this.gamePhase === 'PLAYING' && this.localParticipant;
    if (active) {
      const authoritative = this.vehicles.getLocalSnapshot();
      if (authoritative !== null) {
        this.prediction.resyncFromAuthoritativeState(authoritative);
      }
    }
    this.prediction.setActive(active);
  }

  public setRoundTripLatencyMs(roundTripLatencyMs: number): void {
    if (!Number.isFinite(roundTripLatencyMs)) return;
    this.roundTripLatencyMs = Math.min(1_000, Math.max(0, roundTripLatencyMs));
  }

  public get isPredictionEnabled(): boolean {
    return this.predictionEnabled;
  }

  public prepareForAuthoritativeDiscontinuity(): void {
    this.prediction.prepareForAuthoritativeDiscontinuity();
  }

  public forceResync(): boolean {
    const authoritative = this.vehicles.getLocalSnapshot();
    if (authoritative === null) return false;
    this.prediction.resyncFromAuthoritativeState(authoritative);
    return true;
  }

  public getPredictionMetrics(): PredictionMetrics {
    return this.prediction.metrics;
  }

  public getNetworkMetrics(): WorldNetworkMetrics {
    return {
      jitterMs: this.interpolationClock.networkJitterMs,
      interpolationDelayMs: this.interpolationClock.interpolationDelayMs,
      remoteSnapshotBufferSize: this.vehicles.getRemoteSnapshotBufferSize(),
    };
  }

  public getLocalVehicleObject(): THREE.Object3D | null {
    return this.vehicles.getLocalObject();
  }

  public getLocalVehicleSnapshot(): VehicleStateSnapshot | null {
    if (this.prediction.isActive && this.prediction.latestPredictedState !== null) {
      return this.prediction.getVisualSnapshot();
    }
    return this.vehicles.getLocalSnapshot();
  }

  public getConvoySnapshot(): ConvoyStateSnapshot | null {
    return this.convoy.getLatestSnapshot();
  }

  public clear(): void {
    this.vehicles.clear();
    this.convoy.clear();
    this.interpolationClock.reset();
    this.prediction.clear();
    this.localPlayerId = null;
    this.gamePhase = 'LOBBY';
    this.localParticipant = false;
    this.roundTripLatencyMs = 0;
  }

  public dispose(): void {
    this.clear();
    this.convoy.dispose();
  }
}
