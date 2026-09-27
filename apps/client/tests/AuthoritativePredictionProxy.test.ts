import { CLIENT_PREDICTION_FIXED_DELTA_SECONDS } from '@trailer-arena/shared';
import type { VehicleInputState, VehicleStateSnapshot } from '@trailer-arena/shared';
import { describe, expect, it } from 'vitest';

import { AuthoritativePredictionProxy } from '../src/prediction/AuthoritativePredictionProxy.js';
import { simulatePredictionTick } from '../src/prediction/LocalVehiclePrediction.js';

const DT = CLIENT_PREDICTION_FIXED_DELTA_SECONDS;
const NEUTRAL: VehicleInputState = {
  throttle: 0,
  brake: 0,
  steering: 0,
  handbrake: false,
};
const THROTTLE: VehicleInputState = { ...NEUTRAL, throttle: 1 };
const STEER_LEFT: VehicleInputState = { ...THROTTLE, steering: -1 };
const BRAKE: VehicleInputState = { ...NEUTRAL, brake: 1 };

describe('authoritative local prediction proxy', () => {
  it('renders the exact authoritative base at zero latency', () => {
    const prediction = activeProxy(vehicleSnapshot());
    const authority = vehicleSnapshot({
      position: [4, 1.2, -3],
      linearVelocity: [8, 0.1, 2],
      angularVelocity: [0.1, 0.2, 0.3],
    });
    const visual = prediction.update(DT, THROTTLE, authority, 0, null);
    expect(visual).toEqual(authority);
    expect(prediction.metrics.predictionLeadOffset).toBe(0);
    expect(prediction.metrics.visualCorrectionOffset).toBe(0);
  });

  it('keeps 600 zero-latency straight ticks identical to authority', () => {
    const prediction = activeProxy(vehicleSnapshot());
    const authority = vehicleSnapshot();
    for (let tick = 1; tick <= 600; tick += 1) {
      simulatePredictionTick(authority, THROTTLE);
      const visual = prediction.update(DT, THROTTLE, authority, 0, null);
      expect(visual.position).toEqual(authority.position);
      expect(visual.linearVelocity).toEqual(authority.linearVelocity);
      if (tick % 3 === 0) prediction.observeAuthoritative(tick, authority, null);
    }
    expect(prediction.metrics.hardSnaps).toBe(0);
    expect(prediction.metrics.visualCorrectionOffset).toBe(0);
  });

  it('keeps steering sequence parity because authority remains the render base', () => {
    const prediction = activeProxy(vehicleSnapshot());
    const authority = vehicleSnapshot();
    for (let tick = 0; tick < 360; tick += 1) {
      const input = tick < 120 || tick >= 240 ? THROTTLE : STEER_LEFT;
      simulatePredictionTick(authority, input);
      expect(prediction.update(DT, input, authority, 0, null).rotation).toEqual(
        authority.rotation,
      );
    }
  });

  it('keeps forward, brake, and reverse sequence parity at zero latency', () => {
    const prediction = activeProxy(vehicleSnapshot());
    const authority = vehicleSnapshot();
    for (let tick = 0; tick < 420; tick += 1) {
      const input = tick < 120 ? THROTTLE : BRAKE;
      simulatePredictionTick(authority, input);
      const visual = prediction.update(DT, input, authority, 0, null);
      expect(visual.position).toEqual(authority.position);
      expect(visual.forwardSpeed).toBe(authority.forwardSpeed);
    }
  });

  it('uses sixty fixed steps for one second independently of 30 Hz packets', () => {
    const prediction = activeProxy(vehicleSnapshot());
    const authority = vehicleSnapshot();
    for (let tick = 0; tick < 60; tick += 1) {
      if (tick % 2 === 0) prediction.recordInput(tick / 2 + 1, THROTTLE);
      prediction.update(DT, THROTTLE, authority, 0, null);
    }
    expect(prediction.metrics.predictionTick).toBe(60);
    expect(prediction.metrics.pendingInputs).toBe(30);
  });

  it('compares an authoritative snapshot with the prediction at the same tick', () => {
    const prediction = activeProxy(vehicleSnapshot());
    const states = advancePrediction(prediction, 6, THROTTLE);
    prediction.observeAuthoritative(3, states[2]!, null);
    expect(prediction.metrics.positionError).toBeCloseTo(0, 8);
    expect(prediction.metrics.velocityError).toBeCloseTo(0, 8);
    expect(prediction.metrics.predictionTick).toBe(6);
  });

  it('does not compare an old server snapshot to the current predicted state', () => {
    const prediction = activeProxy(vehicleSnapshot());
    const states = advancePrediction(prediction, 9, THROTTLE);
    prediction.observeAuthoritative(3, states[2]!, null);
    expect(distance(states[8]!.position, states[2]!.position)).toBeGreaterThan(0);
    expect(prediction.metrics.positionError).toBeCloseTo(0, 8);
  });

  it('acknowledges packet history without treating packets as physics ticks', () => {
    const prediction = activeProxy(vehicleSnapshot());
    prediction.recordInput(1, THROTTLE);
    prediction.recordInput(2, THROTTLE);
    prediction.update(DT * 4, THROTTLE, vehicleSnapshot(), 0, null);
    prediction.observeAuthoritative(
      2,
      vehicleSnapshot({ lastProcessedInputSequence: 2 }),
      null,
    );
    expect(prediction.metrics.pendingInputs).toBe(0);
    expect(prediction.metrics.lastAcknowledgedInput).toBe(2);
    expect(prediction.metrics.predictionTick).toBe(4);
  });

  it('replays each post-snapshot physics tick at most once', () => {
    const prediction = activeProxy(vehicleSnapshot());
    advancePrediction(prediction, 6, THROTTLE);
    prediction.observeAuthoritative(3, vehicleSnapshot(), null);
    expect(prediction.metrics.predictionTick).toBe(6);
  });

  it('keeps visual correction energy at zero across repeated snapshots', () => {
    const prediction = activeProxy(vehicleSnapshot());
    for (let tick = 1; tick <= 30; tick += 1) {
      prediction.update(DT, THROTTLE, vehicleSnapshot(), 0, null);
      prediction.observeAuthoritative(tick, vehicleSnapshot(), null);
    }
    expect(prediction.metrics.visualCorrectionOffset).toBe(0);
  });

  it('treats quaternion q and -q as the same aligned rotation', () => {
    const prediction = activeProxy(vehicleSnapshot());
    prediction.update(DT, NEUTRAL, vehicleSnapshot(), 0, null);
    prediction.observeAuthoritative(
      1,
      vehicleSnapshot({ rotation: [0, 0, 0, -1] }),
      null,
    );
    expect(prediction.metrics.rotationErrorDegrees).toBe(0);
  });

  it('clears stale history when prediction is toggled', () => {
    const prediction = activeProxy(vehicleSnapshot());
    prediction.recordInput(4, THROTTLE);
    prediction.setActive(false);
    prediction.resyncFromAuthoritativeState(
      vehicleSnapshot({ linearVelocity: [7, 0, 0] }),
      20,
    );
    prediction.setActive(true);
    expect(prediction.metrics.pendingInputs).toBe(0);
    expect(prediction.metrics.predictedVelocity).toEqual([7, 0, 0]);
  });

  it('bounds artificial-latency prediction instead of accumulating it', () => {
    const prediction = activeProxy(vehicleSnapshot());
    const authority = vehicleSnapshot();
    const first = prediction.update(DT, THROTTLE, authority, 0.1, null);
    const firstPosition = [...first.position];
    const second = prediction.update(DT, THROTTLE, authority, 0.1, null);
    expect(second.position).toEqual(firstPosition);
  });

  it('keeps long-running proxy state finite', () => {
    const prediction = activeProxy(vehicleSnapshot());
    const authority = vehicleSnapshot();
    for (let tick = 0; tick < 1_200; tick += 1) {
      simulatePredictionTick(authority, THROTTLE);
      prediction.update(DT, THROTTLE, authority, 0.15, null);
    }
    expect(
      [
        ...prediction.getVisualSnapshot().position,
        ...prediction.getVisualSnapshot().linearVelocity,
      ].every(Number.isFinite),
    ).toBe(true);
  });
});

function activeProxy(snapshot: VehicleStateSnapshot): AuthoritativePredictionProxy {
  const prediction = new AuthoritativePredictionProxy();
  prediction.resyncFromAuthoritativeState(snapshot, 0);
  prediction.setActive(true);
  return prediction;
}

function advancePrediction(
  prediction: AuthoritativePredictionProxy,
  ticks: number,
  input: VehicleInputState,
): VehicleStateSnapshot[] {
  const base = vehicleSnapshot();
  const states: VehicleStateSnapshot[] = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    simulatePredictionTick(base, input);
    prediction.update(DT, input, base, 0, null);
    states.push(cloneSnapshot(base));
  }
  return states;
}

function vehicleSnapshot(
  overrides: Partial<VehicleStateSnapshot> = {},
): VehicleStateSnapshot {
  return {
    playerId: 'local',
    lastProcessedInputSequence: -1,
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

function distance(
  first: readonly [number, number, number],
  second: readonly [number, number, number],
): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}
