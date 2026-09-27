import {
  CLIENT_PREDICTION_FIXED_DELTA_SECONDS,
  MAX_PREDICTION_PROXY_LEAD_TICKS,
  MAX_PREDICTION_REPLAY_TICKS,
  PREDICTION_CORRECTION_EVENT_DEGREES,
  PREDICTION_CORRECTION_EVENT_METERS,
} from '@trailer-arena/shared';
import type {
  ConvoyStateSnapshot,
  QuaternionTuple,
  Vector3Tuple,
  VehicleInputState,
  VehicleStateSnapshot,
} from '@trailer-arena/shared';

import type { VehicleTransformWriteDebug } from '../entities/VehicleView.js';
import { simulatePredictionTick } from './LocalVehiclePrediction.js';
import { PendingInputHistory } from './PendingInputHistory.js';
import { PredictionInputTimeline } from './PredictionInputTimeline.js';

const MAX_ALIGNED_HISTORY = 256;

export interface PredictionMetrics {
  readonly active: boolean;
  readonly pendingInputs: number;
  readonly lastSentInput: number;
  readonly lastAcknowledgedInput: number;
  readonly positionError: number;
  readonly velocityError: number;
  readonly rotationErrorDegrees: number;
  readonly visualCorrectionOffset: number;
  readonly predictionLeadOffset: number;
  readonly reconciliationsPerSecond: number;
  readonly replaysPerSecond: number;
  readonly correctionsPerSecond: number;
  readonly hardSnaps: number;
  readonly averagePositionError: number;
  readonly averageVelocityError: number;
  readonly maximumPositionError: number;
  readonly predictionTick: number;
  readonly predictionTicksAhead: number;
  readonly predictedPosition: readonly [number, number, number];
  readonly authoritativePosition: readonly [number, number, number];
  readonly predictedVelocity: readonly [number, number, number];
  readonly authoritativeVelocity: readonly [number, number, number];
  readonly renderWriter: VehicleTransformWriteDebug['source'];
  readonly renderWritesThisFrame: number;
  readonly renderWriterConflicts: number;
}

/**
 * The server's Rapier vehicle remains the physical reference. The client only
 * builds a short-lived visual lead from an interpolated authoritative state.
 * Reconstructing this proxy every frame bounds approximation error and avoids
 * feeding approximate velocity/contact state back into the next render frame.
 */
export class AuthoritativePredictionProxy {
  private readonly pendingInputs = new PendingInputHistory();
  private readonly tickInputs = new PredictionInputTimeline();
  private readonly alignedHistory = new Map<number, VehicleStateSnapshot>();
  private comparisonState: VehicleStateSnapshot | null = null;
  private visualState: VehicleStateSnapshot | null = null;
  private latestAuthoritative: VehicleStateSnapshot | null = null;
  private active = false;
  private accumulatorSeconds = 0;
  private comparisonTick = 0;
  private latestServerTick = 0;
  private lastSentInput = -1;
  private lastAcknowledgedInput = -1;
  private positionError = 0;
  private velocityError = 0;
  private rotationErrorDegrees = 0;
  private predictionLeadOffset = 0;
  private accumulatedPositionError = 0;
  private accumulatedVelocityError = 0;
  private maximumPositionError = 0;
  private alignedSamples = 0;
  private reconciliationEvents = 0;
  private replayedTicks = 0;
  private correctionEvents = 0;
  private hardSnaps = 0;
  private metricWindowSeconds = 0;
  private reconciliationsPerSecond = 0;
  private replaysPerSecond = 0;
  private correctionsPerSecond = 0;
  private renderWriter: VehicleTransformWriteDebug['source'] = 'NONE';
  private renderWritesThisFrame = 0;
  private renderWriterConflicts = 0;

  public setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.accumulatorSeconds = 0;
    if (!active) this.clearTransientHistory();
  }

  public recordInput(sequence: number, input: Readonly<VehicleInputState>): void {
    this.lastSentInput = Math.max(this.lastSentInput, sequence);
    if (!this.active) return;
    this.pendingInputs.add(sequence, input, this.comparisonTick);
  }

  public observeAuthoritative(
    serverTick: number,
    authoritative: VehicleStateSnapshot,
    convoy: ConvoyStateSnapshot | null,
  ): void {
    this.latestServerTick = Math.max(this.latestServerTick, serverTick);
    this.latestAuthoritative = cloneSnapshot(authoritative);
    this.lastAcknowledgedInput = Math.max(
      this.lastAcknowledgedInput,
      authoritative.lastProcessedInputSequence,
    );
    this.pendingInputs.acknowledge(authoritative.lastProcessedInputSequence);

    if (!this.active || this.comparisonState === null) {
      this.initializeComparison(serverTick, authoritative);
      return;
    }

    const aligned = this.alignedHistory.get(serverTick);
    if (aligned !== undefined) this.measureAlignedError(aligned, authoritative);

    const currentTick = Math.max(serverTick, this.comparisonTick);
    const corrected = cloneSnapshot(authoritative);
    let replayed = 0;
    if (currentTick > serverTick) {
      replayed = this.tickInputs.replay(
        serverTick,
        Math.min(currentTick, serverTick + MAX_PREDICTION_REPLAY_TICKS),
        (input) => simulatePredictionTick(corrected, input, convoy),
      );
    }
    this.replayedTicks += replayed;
    this.comparisonState = corrected;
    this.comparisonTick = serverTick + replayed;
    this.alignedHistory.clear();
    this.alignedHistory.set(this.comparisonTick, cloneSnapshot(corrected));
    this.reconciliationEvents += 1;
  }

  public update(
    deltaSeconds: number,
    input: Readonly<VehicleInputState>,
    authoritativeBase: VehicleStateSnapshot,
    leadSeconds: number,
    convoy: ConvoyStateSnapshot | null,
  ): VehicleStateSnapshot {
    this.updateMetricWindow(deltaSeconds);
    this.advanceComparison(deltaSeconds, input, convoy);

    if (this.visualState === null) this.visualState = cloneSnapshot(authoritativeBase);
    copySnapshot(authoritativeBase, this.visualState);
    if (!this.active) {
      this.predictionLeadOffset = 0;
      return this.visualState;
    }

    const leadTicks = Math.min(
      MAX_PREDICTION_PROXY_LEAD_TICKS,
      Math.max(
        0,
        Math.round(Math.max(0, leadSeconds) / CLIENT_PREDICTION_FIXED_DELTA_SECONDS),
      ),
    );
    for (let tick = 0; tick < leadTicks; tick += 1) {
      simulatePredictionTick(
        this.visualState,
        input,
        convoy,
        tick * CLIENT_PREDICTION_FIXED_DELTA_SECONDS,
      );
    }
    this.predictionLeadOffset = distance(
      authoritativeBase.position,
      this.visualState.position,
    );
    return this.visualState;
  }

  public resyncFromAuthoritativeState(
    authoritative: VehicleStateSnapshot,
    serverTick = this.latestServerTick,
  ): void {
    this.clearTransientHistory();
    this.resetMetrics();
    this.latestAuthoritative = cloneSnapshot(authoritative);
    this.visualState = cloneSnapshot(authoritative);
    this.latestServerTick = serverTick;
    this.lastAcknowledgedInput = Math.max(
      this.lastAcknowledgedInput,
      authoritative.lastProcessedInputSequence,
    );
    this.initializeComparison(serverTick, authoritative);
  }

  public prepareForAuthoritativeDiscontinuity(): void {
    this.clearTransientHistory();
    this.resetMetrics();
    this.comparisonState = null;
    this.visualState = null;
    this.predictionLeadOffset = 0;
  }

  public setRenderDiagnostics(debug: VehicleTransformWriteDebug): void {
    this.renderWriter = debug.source;
    this.renderWritesThisFrame = debug.writesThisFrame;
    this.renderWriterConflicts = debug.conflictingWrites;
  }

  public clear(): void {
    this.clearTransientHistory();
    this.resetMetrics();
    this.comparisonState = null;
    this.visualState = null;
    this.latestAuthoritative = null;
    this.active = false;
    this.comparisonTick = 0;
    this.latestServerTick = 0;
    this.lastSentInput = -1;
    this.lastAcknowledgedInput = -1;
    this.renderWriter = 'NONE';
    this.renderWritesThisFrame = 0;
    this.renderWriterConflicts = 0;
  }

  public get latestPredictedState(): VehicleStateSnapshot | null {
    return this.visualState;
  }

  public getVisualSnapshot(): VehicleStateSnapshot {
    if (this.visualState === null) {
      throw new Error('Prediction proxy has no authoritative base state.');
    }
    return this.visualState;
  }

  public get isActive(): boolean {
    return this.active;
  }

  public get metrics(): PredictionMetrics {
    const predicted = this.comparisonState ?? this.visualState;
    const authoritative = this.latestAuthoritative ?? predicted;
    return {
      active: this.active,
      pendingInputs: this.pendingInputs.size,
      lastSentInput: this.lastSentInput,
      lastAcknowledgedInput: this.lastAcknowledgedInput,
      positionError: this.positionError,
      velocityError: this.velocityError,
      rotationErrorDegrees: this.rotationErrorDegrees,
      visualCorrectionOffset: 0,
      predictionLeadOffset: this.predictionLeadOffset,
      reconciliationsPerSecond: this.reconciliationsPerSecond,
      replaysPerSecond: this.replaysPerSecond,
      correctionsPerSecond: this.correctionsPerSecond,
      hardSnaps: this.hardSnaps,
      averagePositionError:
        this.alignedSamples === 0
          ? 0
          : this.accumulatedPositionError / this.alignedSamples,
      averageVelocityError:
        this.alignedSamples === 0
          ? 0
          : this.accumulatedVelocityError / this.alignedSamples,
      maximumPositionError: this.maximumPositionError,
      predictionTick: this.comparisonTick,
      predictionTicksAhead: Math.max(0, this.comparisonTick - this.latestServerTick),
      predictedPosition: predicted?.position ?? [0, 0, 0],
      authoritativePosition: authoritative?.position ?? [0, 0, 0],
      predictedVelocity: predicted?.linearVelocity ?? [0, 0, 0],
      authoritativeVelocity: authoritative?.linearVelocity ?? [0, 0, 0],
      renderWriter: this.renderWriter,
      renderWritesThisFrame: this.renderWritesThisFrame,
      renderWriterConflicts: this.renderWriterConflicts,
    };
  }

  private advanceComparison(
    deltaSeconds: number,
    input: Readonly<VehicleInputState>,
    convoy: ConvoyStateSnapshot | null,
  ): void {
    if (!this.active || this.comparisonState === null) return;
    this.accumulatorSeconds += Math.min(0.25, Math.max(0, deltaSeconds));
    while (this.accumulatorSeconds >= CLIENT_PREDICTION_FIXED_DELTA_SECONDS) {
      this.tickInputs.record(this.comparisonTick, input);
      simulatePredictionTick(this.comparisonState, input, convoy);
      this.comparisonTick += 1;
      this.alignedHistory.set(this.comparisonTick, cloneSnapshot(this.comparisonState));
      trimOldest(this.alignedHistory, MAX_ALIGNED_HISTORY);
      this.accumulatorSeconds -= CLIENT_PREDICTION_FIXED_DELTA_SECONDS;
    }
  }

  private initializeComparison(
    serverTick: number,
    authoritative: VehicleStateSnapshot,
  ): void {
    this.comparisonState = cloneSnapshot(authoritative);
    this.comparisonTick = serverTick;
    this.accumulatorSeconds = 0;
    this.alignedHistory.clear();
    this.alignedHistory.set(serverTick, cloneSnapshot(authoritative));
  }

  private measureAlignedError(
    predicted: VehicleStateSnapshot,
    authoritative: VehicleStateSnapshot,
  ): void {
    this.positionError = distance(predicted.position, authoritative.position);
    this.velocityError = distance(predicted.linearVelocity, authoritative.linearVelocity);
    this.rotationErrorDegrees = quaternionAngleDegrees(
      predicted.rotation,
      authoritative.rotation,
    );
    this.accumulatedPositionError += this.positionError;
    this.accumulatedVelocityError += this.velocityError;
    this.maximumPositionError = Math.max(this.maximumPositionError, this.positionError);
    this.alignedSamples += 1;
    if (
      this.positionError > PREDICTION_CORRECTION_EVENT_METERS ||
      this.rotationErrorDegrees > PREDICTION_CORRECTION_EVENT_DEGREES
    ) {
      this.correctionEvents += 1;
    }
  }

  private updateMetricWindow(deltaSeconds: number): void {
    this.metricWindowSeconds += Math.max(0, deltaSeconds);
    if (this.metricWindowSeconds < 1) return;
    this.reconciliationsPerSecond = this.reconciliationEvents / this.metricWindowSeconds;
    this.replaysPerSecond = this.replayedTicks / this.metricWindowSeconds;
    this.correctionsPerSecond = this.correctionEvents / this.metricWindowSeconds;
    this.metricWindowSeconds = 0;
    this.reconciliationEvents = 0;
    this.replayedTicks = 0;
    this.correctionEvents = 0;
  }

  private clearTransientHistory(): void {
    this.pendingInputs.clear();
    this.tickInputs.clear();
    this.alignedHistory.clear();
    this.accumulatorSeconds = 0;
  }

  private resetMetrics(): void {
    this.positionError = 0;
    this.velocityError = 0;
    this.rotationErrorDegrees = 0;
    this.predictionLeadOffset = 0;
    this.accumulatedPositionError = 0;
    this.accumulatedVelocityError = 0;
    this.maximumPositionError = 0;
    this.alignedSamples = 0;
    this.reconciliationEvents = 0;
    this.replayedTicks = 0;
    this.correctionEvents = 0;
    this.hardSnaps = 0;
    this.metricWindowSeconds = 0;
    this.reconciliationsPerSecond = 0;
    this.replaysPerSecond = 0;
    this.correctionsPerSecond = 0;
  }
}

function cloneSnapshot(state: VehicleStateSnapshot): VehicleStateSnapshot {
  return {
    ...state,
    position: [...state.position],
    rotation: [...state.rotation],
    linearVelocity: [...state.linearVelocity],
    angularVelocity: [...state.angularVelocity],
    trailerRelativePosition: [...state.trailerRelativePosition],
  };
}

function copySnapshot(source: VehicleStateSnapshot, target: VehicleStateSnapshot): void {
  target.playerId = source.playerId;
  target.lastProcessedInputSequence = source.lastProcessedInputSequence;
  target.position.splice(0, 3, ...source.position);
  target.rotation.splice(0, 4, ...source.rotation);
  target.linearVelocity.splice(0, 3, ...source.linearVelocity);
  target.angularVelocity.splice(0, 3, ...source.angularVelocity);
  target.forwardSpeed = source.forwardSpeed;
  target.lateralSpeed = source.lateralSpeed;
  target.grounded = source.grounded;
  target.surfaceType = source.surfaceType;
  target.onTrailer = source.onTrailer;
  target.relativeForwardSpeed = source.relativeForwardSpeed;
  target.relativeLateralSpeed = source.relativeLateralSpeed;
  target.wheelContacts = source.wheelContacts;
  target.trailerDeckContacts = source.trailerDeckContacts;
  target.trailerRelativePosition.splice(0, 3, ...source.trailerRelativePosition);
  target.flipped = source.flipped;
  target.selfRightAvailable = source.selfRightAvailable;
  target.ramSlideRemainingTicks = source.ramSlideRemainingTicks;
}

function distance(first: Vector3Tuple, second: Vector3Tuple): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

function quaternionAngleDegrees(first: QuaternionTuple, second: QuaternionTuple): number {
  const dot = Math.abs(
    first[0] * second[0] +
      first[1] * second[1] +
      first[2] * second[2] +
      first[3] * second[3],
  );
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

function trimOldest<T>(map: Map<number, T>, maximumSize: number): void {
  while (map.size > maximumSize) {
    const oldest = map.keys().next().value as number | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}
