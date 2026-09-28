import {
  CLIENT_PREDICTION_FIXED_DELTA_SECONDS,
  MAX_PREDICTION_CATCH_UP_STEPS,
  MAX_PREDICTION_REPLAY_TICKS,
  PLAYER_COLLISION_TUNING,
  PREDICTION_CORRECTION_EVENT_DEGREES,
  PREDICTION_CORRECTION_EVENT_METERS,
  PREDICTION_DRIVEN_WHEEL_COUNT,
  PREDICTION_HARD_SNAP_METERS,
  PREDICTION_MEDIUM_CORRECTION_RATE,
  PREDICTION_SMALL_CORRECTION_RATE,
  PREDICTION_SMALL_ERROR_METERS,
  SIMULATION_TICK_RATE,
  TRAILER_SURFACE_GRIP,
  VEHICLE_DIMENSIONS,
  VEHICLE_TUNING,
} from '@trailer-arena/shared';
import type {
  ConvoyStateSnapshot,
  QuaternionTuple,
  Vector3Tuple,
  VehicleInputState,
  VehicleStateSnapshot,
} from '@trailer-arena/shared';

import { PendingInputHistory } from './PendingInputHistory.js';
import { PredictionInputTimeline } from './PredictionInputTimeline.js';

const NEUTRAL_INPUT: VehicleInputState = {
  throttle: 0,
  brake: 0,
  steering: 0,
  handbrake: false,
};
const IDENTITY_ROTATION: QuaternionTuple = [0, 0, 0, 1];

export interface PredictionMetrics {
  readonly active: boolean;
  readonly pendingInputs: number;
  readonly lastSentInput: number;
  readonly lastAcknowledgedInput: number;
  readonly positionError: number;
  readonly velocityError: number;
  readonly rotationErrorDegrees: number;
  readonly visualCorrectionOffset: number;
  readonly reconciliationsPerSecond: number;
  readonly correctionsPerSecond: number;
  readonly hardSnaps: number;
  readonly averagePositionError: number;
  readonly averageVelocityError: number;
  readonly maximumPositionError: number;
  readonly predictionTick: number;
  readonly predictedPosition: readonly [number, number, number];
  readonly authoritativePosition: readonly [number, number, number];
  readonly predictedVelocity: readonly [number, number, number];
  readonly authoritativeVelocity: readonly [number, number, number];
}

export class LocalVehiclePrediction {
  private readonly pendingInputs = new PendingInputHistory();
  private readonly inputTimeline = new PredictionInputTimeline();
  private predicted: VehicleStateSnapshot | null = null;
  private readonly visualCorrectionPosition: Vector3Tuple = [0, 0, 0];
  private readonly visualCorrectionRotation: QuaternionTuple = [...IDENTITY_ROTATION];
  private visualSnapshot: VehicleStateSnapshot | null = null;
  private accumulatorSeconds = 0;
  private predictionAgeSeconds = 0;
  private predictionTick = 0;
  private active = false;
  private forceHardSnapOnNextState = false;
  private lastSentInput = -1;
  private lastAcknowledgedInput = -1;
  private positionError = 0;
  private velocityError = 0;
  private rotationErrorDegrees = 0;
  private maximumPositionError = 0;
  private hardSnaps = 0;
  private reconciliationEvents = 0;
  private reconciliationsPerSecond = 0;
  private correctionEvents = 0;
  private correctionsPerSecond = 0;
  private metricWindowSeconds = 0;
  private accumulatedError = 0;
  private accumulatedVelocityError = 0;
  private errorSamples = 0;
  private readonly authoritativePosition: Vector3Tuple = [0, 0, 0];
  private readonly authoritativeVelocity: Vector3Tuple = [0, 0, 0];

  public setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.accumulatorSeconds = 0;
    if (!active) this.pendingInputs.clear();
  }

  public recordInput(sequence: number, input: Readonly<VehicleInputState>): void {
    this.lastSentInput = Math.max(this.lastSentInput, sequence);
    if (!this.active) return;
    this.pendingInputs.add(sequence, input, this.predictionTick);
    if (this.pendingInputs.didOverflow) this.forceHardSnapOnNextState = true;
  }

  public update(
    deltaSeconds: number,
    input: Readonly<VehicleInputState>,
    convoy: ConvoyStateSnapshot | null,
  ): void {
    this.updateMetricWindow(deltaSeconds);
    if (!this.active || this.predicted === null) return;
    this.accumulatorSeconds += Math.min(Math.max(deltaSeconds, 0), 0.25);
    let steps = 0;
    while (
      this.accumulatorSeconds >= CLIENT_PREDICTION_FIXED_DELTA_SECONDS &&
      steps < MAX_PREDICTION_CATCH_UP_STEPS
    ) {
      this.inputTimeline.record(this.predictionTick, input);
      simulatePredictionTick(this.predicted, input, convoy, this.predictionAgeSeconds);
      this.predictionTick += 1;
      this.predictionAgeSeconds += CLIENT_PREDICTION_FIXED_DELTA_SECONDS;
      this.accumulatorSeconds -= CLIENT_PREDICTION_FIXED_DELTA_SECONDS;
      steps += 1;
    }
    if (steps === MAX_PREDICTION_CATCH_UP_STEPS) {
      this.accumulatorSeconds %= CLIENT_PREDICTION_FIXED_DELTA_SECONDS;
    }
    this.decayVisualCorrection(deltaSeconds);
  }

  public reconcile(
    authoritative: VehicleStateSnapshot,
    convoy: ConvoyStateSnapshot | null,
    snapshotAgeSeconds = 0,
  ): void {
    copyVector(authoritative.position, this.authoritativePosition);
    copyVector(authoritative.linearVelocity, this.authoritativeVelocity);
    this.lastAcknowledgedInput = Math.max(
      this.lastAcknowledgedInput,
      authoritative.lastProcessedInputSequence,
    );
    this.pendingInputs.acknowledge(authoritative.lastProcessedInputSequence);

    if (!this.active || this.predicted === null) {
      this.resyncFromAuthoritativeState(authoritative);
      return;
    }

    const previousVisual = this.getVisualSnapshot();
    const corrected = cloneVehicleSnapshot(authoritative);
    let replayAgeSeconds = 0;
    const replayTicks = Math.min(
      MAX_PREDICTION_REPLAY_TICKS,
      Math.max(
        0,
        Math.round(
          Math.max(0, snapshotAgeSeconds) / CLIENT_PREDICTION_FIXED_DELTA_SECONDS,
        ),
      ),
    );
    this.inputTimeline.replay(
      this.predictionTick - replayTicks,
      this.predictionTick,
      (input) => {
        simulatePredictionTick(corrected, input, convoy, replayAgeSeconds);
        replayAgeSeconds += CLIENT_PREDICTION_FIXED_DELTA_SECONDS;
      },
    );

    this.positionError = distance(this.predicted.position, corrected.position);
    this.velocityError = distance(
      this.predicted.linearVelocity,
      corrected.linearVelocity,
    );
    this.rotationErrorDegrees = quaternionAngleDegrees(
      this.predicted.rotation,
      corrected.rotation,
    );
    this.accumulatedError += this.positionError;
    this.accumulatedVelocityError += this.velocityError;
    this.maximumPositionError = Math.max(this.maximumPositionError, this.positionError);
    this.errorSamples += 1;
    this.reconciliationEvents += 1;

    const hardSnap =
      this.forceHardSnapOnNextState || this.positionError >= PREDICTION_HARD_SNAP_METERS;
    this.predicted = corrected;
    this.predictionAgeSeconds = replayAgeSeconds;
    this.forceHardSnapOnNextState = false;

    if (hardSnap) {
      zeroCorrection(this.visualCorrectionPosition, this.visualCorrectionRotation);
      this.hardSnaps += 1;
      this.visualSnapshot = cloneVehicleSnapshot(corrected);
      return;
    }

    if (
      this.positionError > PREDICTION_CORRECTION_EVENT_METERS ||
      this.rotationErrorDegrees > PREDICTION_CORRECTION_EVENT_DEGREES
    ) {
      this.correctionEvents += 1;
      this.visualCorrectionPosition[0] =
        previousVisual.position[0] - corrected.position[0];
      this.visualCorrectionPosition[1] =
        previousVisual.position[1] - corrected.position[1];
      this.visualCorrectionPosition[2] =
        previousVisual.position[2] - corrected.position[2];
      writeShortestRotationDelta(
        previousVisual.rotation,
        corrected.rotation,
        this.visualCorrectionRotation,
      );
    }
  }

  public prepareForAuthoritativeDiscontinuity(): void {
    this.pendingInputs.clear();
    this.inputTimeline.clear();
    this.forceHardSnapOnNextState = true;
  }

  public resyncFromAuthoritativeState(authoritative: VehicleStateSnapshot): void {
    this.pendingInputs.clear();
    this.inputTimeline.clear();
    this.predicted = cloneVehicleSnapshot(authoritative);
    this.visualSnapshot = cloneVehicleSnapshot(authoritative);
    copyVector(authoritative.position, this.authoritativePosition);
    copyVector(authoritative.linearVelocity, this.authoritativeVelocity);
    this.lastAcknowledgedInput = Math.max(
      this.lastAcknowledgedInput,
      authoritative.lastProcessedInputSequence,
    );
    this.positionError = 0;
    this.velocityError = 0;
    this.rotationErrorDegrees = 0;
    this.accumulatorSeconds = 0;
    this.predictionAgeSeconds = 0;
    this.forceHardSnapOnNextState = false;
    zeroCorrection(this.visualCorrectionPosition, this.visualCorrectionRotation);
  }

  public clear(): void {
    this.pendingInputs.clear();
    this.inputTimeline.clear();
    this.predicted = null;
    this.visualSnapshot = null;
    this.active = false;
    this.accumulatorSeconds = 0;
    this.predictionAgeSeconds = 0;
    this.forceHardSnapOnNextState = false;
    this.lastSentInput = -1;
    this.lastAcknowledgedInput = -1;
    this.positionError = 0;
    this.velocityError = 0;
    this.rotationErrorDegrees = 0;
    this.maximumPositionError = 0;
    this.hardSnaps = 0;
    this.reconciliationEvents = 0;
    this.reconciliationsPerSecond = 0;
    this.correctionEvents = 0;
    this.correctionsPerSecond = 0;
    this.metricWindowSeconds = 0;
    this.accumulatedError = 0;
    this.accumulatedVelocityError = 0;
    this.errorSamples = 0;
    this.predictionTick = 0;
    this.authoritativePosition.fill(0);
    this.authoritativeVelocity.fill(0);
    zeroCorrection(this.visualCorrectionPosition, this.visualCorrectionRotation);
  }

  public getVisualSnapshot(): VehicleStateSnapshot {
    if (this.predicted === null) {
      throw new Error('Prediction has not received an authoritative state.');
    }
    if (this.visualSnapshot === null) {
      this.visualSnapshot = cloneVehicleSnapshot(this.predicted);
    }
    copyVehicleSnapshot(this.predicted, this.visualSnapshot);
    this.visualSnapshot.position[0] += this.visualCorrectionPosition[0];
    this.visualSnapshot.position[1] += this.visualCorrectionPosition[1];
    this.visualSnapshot.position[2] += this.visualCorrectionPosition[2];
    multiplyQuaternion(
      this.visualCorrectionRotation,
      this.predicted.rotation,
      this.visualSnapshot.rotation,
    );
    normalizeQuaternion(this.visualSnapshot.rotation);
    return this.visualSnapshot;
  }

  public get latestPredictedState(): VehicleStateSnapshot | null {
    return this.predicted;
  }

  public get predictedAgeSeconds(): number {
    return this.predictionAgeSeconds;
  }

  public get isActive(): boolean {
    return this.active;
  }

  public get metrics(): PredictionMetrics {
    return {
      active: this.active,
      pendingInputs: this.pendingInputs.size,
      lastSentInput: this.lastSentInput,
      lastAcknowledgedInput: this.lastAcknowledgedInput,
      positionError: this.positionError,
      velocityError: this.velocityError,
      rotationErrorDegrees: this.rotationErrorDegrees,
      visualCorrectionOffset: Math.hypot(...this.visualCorrectionPosition),
      reconciliationsPerSecond: this.reconciliationsPerSecond,
      correctionsPerSecond: this.correctionsPerSecond,
      hardSnaps: this.hardSnaps,
      averagePositionError:
        this.errorSamples === 0 ? 0 : this.accumulatedError / this.errorSamples,
      averageVelocityError:
        this.errorSamples === 0 ? 0 : this.accumulatedVelocityError / this.errorSamples,
      maximumPositionError: this.maximumPositionError,
      predictionTick: this.predictionTick,
      predictedPosition: this.predicted?.position ?? this.authoritativePosition,
      authoritativePosition: this.authoritativePosition,
      predictedVelocity: this.predicted?.linearVelocity ?? this.authoritativeVelocity,
      authoritativeVelocity: this.authoritativeVelocity,
    };
  }

  private decayVisualCorrection(deltaSeconds: number): void {
    const correctionMagnitude = Math.hypot(...this.visualCorrectionPosition);
    const rate =
      correctionMagnitude < PREDICTION_SMALL_ERROR_METERS
        ? PREDICTION_SMALL_CORRECTION_RATE
        : PREDICTION_MEDIUM_CORRECTION_RATE;
    const retention = Math.exp(-rate * Math.max(0, deltaSeconds));
    this.visualCorrectionPosition[0] *= retention;
    this.visualCorrectionPosition[1] *= retention;
    this.visualCorrectionPosition[2] *= retention;
    slerpQuaternion(
      IDENTITY_ROTATION,
      this.visualCorrectionRotation,
      retention,
      this.visualCorrectionRotation,
    );
  }

  private updateMetricWindow(deltaSeconds: number): void {
    this.metricWindowSeconds += Math.max(0, deltaSeconds);
    if (this.metricWindowSeconds < 1) return;
    this.reconciliationsPerSecond = this.reconciliationEvents / this.metricWindowSeconds;
    this.correctionsPerSecond = this.correctionEvents / this.metricWindowSeconds;
    this.metricWindowSeconds = 0;
    this.reconciliationEvents = 0;
    this.correctionEvents = 0;
  }
}

export function simulatePredictionTick(
  state: VehicleStateSnapshot,
  input: Readonly<VehicleInputState> = NEUTRAL_INPUT,
  convoy: ConvoyStateSnapshot | null = null,
  surfaceAgeSeconds = 0,
): void {
  const dt = CLIENT_PREDICTION_FIXED_DELTA_SECONDS;
  const forward = horizontalForward(state.rotation);
  const right = [forward[2], 0, -forward[0]] as Vector3Tuple;
  const surfaceVelocity = state.onTrailer
    ? movingSurfaceVelocity(convoy, state.position, surfaceAgeSeconds)
    : ([0, 0, 0] as Vector3Tuple);
  let relativeX = state.linearVelocity[0] - surfaceVelocity[0];
  let relativeZ = state.linearVelocity[2] - surfaceVelocity[2];
  let forwardSpeed = relativeX * forward[0] + relativeZ * forward[2];
  let lateralSpeed = relativeX * right[0] + relativeZ * right[2];

  const slideProgress = Math.min(
    1,
    Math.max(
      0,
      1 -
        state.ramSlideRemainingTicks /
          (PLAYER_COLLISION_TUNING.ramSlideDurationSeconds * SIMULATION_TICK_RATE),
    ),
  );
  const gripRecovery =
    state.ramSlideRemainingTicks <= 0
      ? 1
      : PLAYER_COLLISION_TUNING.ramSlideInitialGripMultiplier +
        (1 - PLAYER_COLLISION_TUNING.ramSlideInitialGripMultiplier) * slideProgress ** 6;
  const surfaceGrip = state.onTrailer ? TRAILER_SURFACE_GRIP.lateralGripMultiplier : 1;
  const handbrakeGrip = input.handbrake ? VEHICLE_TUNING.handbrakeGripMultiplier : 1;
  lateralSpeed *= Math.exp(
    -VEHICLE_TUNING.lateralGrip * surfaceGrip * handbrakeGrip * gripRecovery * dt,
  );

  if (input.throttle > 0) {
    if (forwardSpeed < -VEHICLE_TUNING.reverseEngageSpeed) {
      forwardSpeed = moveToward(forwardSpeed, 0, 10.5 * input.throttle * dt);
    } else {
      const curve = Math.max(
        0,
        1 - (Math.max(0, forwardSpeed) / VEHICLE_TUNING.maxForwardSpeed) ** 2,
      );
      forwardSpeed +=
        ((VEHICLE_TUNING.engineForce * PREDICTION_DRIVEN_WHEEL_COUNT) /
          VEHICLE_TUNING.mass) *
        input.throttle *
        curve *
        dt;
    }
  } else if (input.brake > 0) {
    if (forwardSpeed > VEHICLE_TUNING.reverseEngageSpeed) {
      forwardSpeed = moveToward(forwardSpeed, 0, 10.5 * input.brake * dt);
    } else {
      const ratio = Math.min(
        1,
        Math.abs(Math.min(0, forwardSpeed)) / VEHICLE_TUNING.maxReverseSpeed,
      );
      forwardSpeed -=
        ((VEHICLE_TUNING.reverseForce * PREDICTION_DRIVEN_WHEEL_COUNT) /
          VEHICLE_TUNING.mass) *
        input.brake *
        Math.max(0, 1 - ratio ** 2) *
        dt;
    }
  }

  const rollingAcceleration =
    (VEHICLE_TUNING.rollingResistance / VEHICLE_TUNING.mass) *
    (state.ramSlideRemainingTicks > 0
      ? PLAYER_COLLISION_TUNING.ramSlideRollingResistanceMultiplier
      : 1);
  forwardSpeed = moveToward(
    forwardSpeed,
    0,
    (rollingAcceleration +
      (VEHICLE_TUNING.airDrag / VEHICLE_TUNING.mass) * forwardSpeed ** 2) *
      dt,
  );
  const linearDampingRetention = Math.exp(-VEHICLE_TUNING.linearDamping * dt);
  forwardSpeed *= linearDampingRetention;
  lateralSpeed *= linearDampingRetention;

  const speedRatio = Math.min(1, Math.abs(forwardSpeed) / VEHICLE_TUNING.maxForwardSpeed);
  const steeringStrength =
    VEHICLE_TUNING.steeringStrength *
    (1 - speedRatio * VEHICLE_TUNING.highSpeedSteeringReduction);
  const stationaryScale = Math.min(1, Math.abs(forwardSpeed) / 0.65);
  const steeringYawDelta =
    input.steering *
    steeringStrength *
    stationaryScale *
    (forwardSpeed / VEHICLE_DIMENSIONS.wheelBase) *
    dt;
  const surfaceYawDelta =
    state.onTrailer && convoy !== null ? convoy.trailer.angularVelocity[1] * dt : 0;
  const yawDelta = steeringYawDelta + surfaceYawDelta;
  if (Math.abs(yawDelta) > 1e-8) {
    const yawRotation: QuaternionTuple = [
      0,
      Math.sin(yawDelta / 2),
      0,
      Math.cos(yawDelta / 2),
    ];
    multiplyQuaternion(yawRotation, state.rotation, state.rotation);
    normalizeQuaternion(state.rotation);
  }

  const updatedForward = horizontalForward(state.rotation);
  const updatedRight = [updatedForward[2], 0, -updatedForward[0]] as Vector3Tuple;
  relativeX = updatedForward[0] * forwardSpeed + updatedRight[0] * lateralSpeed;
  relativeZ = updatedForward[2] * forwardSpeed + updatedRight[2] * lateralSpeed;
  state.linearVelocity[0] = surfaceVelocity[0] + relativeX;
  state.linearVelocity[2] = surfaceVelocity[2] + relativeZ;
  if (state.grounded) state.linearVelocity[1] = surfaceVelocity[1];
  else state.linearVelocity[1] -= 9.81 * dt;

  state.position[0] += state.linearVelocity[0] * dt;
  state.position[1] += state.linearVelocity[1] * dt;
  state.position[2] += state.linearVelocity[2] * dt;
  state.forwardSpeed = forwardSpeed;
  state.relativeForwardSpeed = forwardSpeed;
  state.lateralSpeed = lateralSpeed;
  state.relativeLateralSpeed = lateralSpeed;
  state.ramSlideRemainingTicks = Math.max(0, state.ramSlideRemainingTicks - 1);
}

function movingSurfaceVelocity(
  convoy: ConvoyStateSnapshot | null,
  point: Vector3Tuple,
  surfaceAgeSeconds: number,
): Vector3Tuple {
  if (convoy === null) return [0, 0, 0];
  const body = convoy.trailer;
  const rx = point[0] - (body.position[0] + body.linearVelocity[0] * surfaceAgeSeconds);
  const ry = point[1] - (body.position[1] + body.linearVelocity[1] * surfaceAgeSeconds);
  const rz = point[2] - (body.position[2] + body.linearVelocity[2] * surfaceAgeSeconds);
  return [
    body.linearVelocity[0] + body.angularVelocity[1] * rz - body.angularVelocity[2] * ry,
    body.linearVelocity[1] + body.angularVelocity[2] * rx - body.angularVelocity[0] * rz,
    body.linearVelocity[2] + body.angularVelocity[0] * ry - body.angularVelocity[1] * rx,
  ];
}

function horizontalForward(rotation: QuaternionTuple): Vector3Tuple {
  const x = 2 * (rotation[0] * rotation[2] + rotation[3] * rotation[1]);
  const z = 1 - 2 * (rotation[0] ** 2 + rotation[1] ** 2);
  const length = Math.hypot(x, z);
  return length < 1e-6 ? [0, 0, 1] : [x / length, 0, z / length];
}

function cloneVehicleSnapshot(state: VehicleStateSnapshot): VehicleStateSnapshot {
  return {
    ...state,
    position: [...state.position],
    rotation: [...state.rotation],
    linearVelocity: [...state.linearVelocity],
    angularVelocity: [...state.angularVelocity],
    trailerRelativePosition: [...state.trailerRelativePosition],
  };
}

function copyVehicleSnapshot(
  source: VehicleStateSnapshot,
  target: VehicleStateSnapshot,
): void {
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

function zeroCorrection(position: Vector3Tuple, rotation: QuaternionTuple): void {
  position.fill(0);
  rotation.splice(0, 4, ...IDENTITY_ROTATION);
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

function inverseQuaternion(rotation: QuaternionTuple): QuaternionTuple {
  return [-rotation[0], -rotation[1], -rotation[2], rotation[3]];
}

function writeShortestRotationDelta(
  from: QuaternionTuple,
  to: QuaternionTuple,
  output: QuaternionTuple,
): void {
  const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + from[3] * to[3];
  const sign = dot < 0 ? -1 : 1;
  const alignedTo: QuaternionTuple = [
    to[0] * sign,
    to[1] * sign,
    to[2] * sign,
    to[3] * sign,
  ];
  multiplyQuaternion(from, inverseQuaternion(alignedTo), output);
  normalizeQuaternion(output);
}

function copyVector(source: Vector3Tuple, target: Vector3Tuple): void {
  target[0] = source[0];
  target[1] = source[1];
  target[2] = source[2];
}

function multiplyQuaternion(
  first: QuaternionTuple,
  second: QuaternionTuple,
  output: QuaternionTuple,
): void {
  const [ax, ay, az, aw] = first;
  const [bx, by, bz, bw] = second;
  output[0] = aw * bx + ax * bw + ay * bz - az * by;
  output[1] = aw * by - ax * bz + ay * bw + az * bx;
  output[2] = aw * bz + ax * by - ay * bx + az * bw;
  output[3] = aw * bw - ax * bx - ay * by - az * bz;
}

function normalizeQuaternion(rotation: QuaternionTuple): void {
  const length = Math.hypot(...rotation);
  if (length < 1e-9) {
    rotation.splice(0, 4, ...IDENTITY_ROTATION);
    return;
  }
  for (let index = 0; index < 4; index += 1) rotation[index]! /= length;
}

function slerpQuaternion(
  from: QuaternionTuple,
  to: QuaternionTuple,
  alpha: number,
  output: QuaternionTuple,
): void {
  let dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + from[3] * to[3];
  const sign = dot < 0 ? -1 : 1;
  dot = Math.abs(dot);
  const safeAlpha = Math.min(1, Math.max(0, alpha));
  if (dot > 0.9995) {
    for (let index = 0; index < 4; index += 1) {
      output[index] = from[index]! + (to[index]! * sign - from[index]!) * safeAlpha;
    }
    normalizeQuaternion(output);
    return;
  }
  const angle = Math.acos(Math.min(1, dot));
  const denominator = Math.sin(angle);
  const fromWeight = Math.sin((1 - safeAlpha) * angle) / denominator;
  const toWeight = Math.sin(safeAlpha * angle) / denominator;
  for (let index = 0; index < 4; index += 1) {
    output[index] = from[index]! * fromWeight + to[index]! * sign * toWeight;
  }
}

function moveToward(value: number, target: number, maximumDelta: number): number {
  if (value < target) return Math.min(target, value + maximumDelta);
  return Math.max(target, value - maximumDelta);
}
