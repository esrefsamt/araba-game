import {
  CLIENT_PREDICTION_FIXED_DELTA_SECONDS,
  MAX_PENDING_INPUTS,
} from '@trailer-arena/shared';
import type {
  ConvoyStateSnapshot,
  VehicleInputState,
  VehicleStateSnapshot,
} from '@trailer-arena/shared';
import { describe, expect, it } from 'vitest';

import {
  LocalVehiclePrediction,
  simulatePredictionTick,
} from '../src/prediction/LocalVehiclePrediction.js';
import { calculateMovingPlatformRenderOffset } from '../src/prediction/MovingPlatformAlignment.js';
import { PendingInputHistory } from '../src/prediction/PendingInputHistory.js';
import { PredictionInputTimeline } from '../src/prediction/PredictionInputTimeline.js';

const THROTTLE: VehicleInputState = {
  throttle: 1,
  brake: 0,
  steering: 0,
  handbrake: false,
};
const NEUTRAL: VehicleInputState = {
  throttle: 0,
  brake: 0,
  steering: 0,
  handbrake: false,
};

describe('pending input history', () => {
  it('removes acknowledged inputs and preserves unacknowledged inputs', () => {
    const history = new PendingInputHistory();
    history.add(1, THROTTLE, 0);
    history.add(2, NEUTRAL, 2);
    history.add(3, THROTTLE, 4);
    history.acknowledge(2);
    expect(history.entries.map((entry) => entry.sequence)).toEqual([3]);
  });

  it('stays bounded and requests a safe resync after overflow', () => {
    const history = new PendingInputHistory();
    for (let sequence = 0; sequence < MAX_PENDING_INPUTS + 10; sequence += 1) {
      history.add(sequence, THROTTLE, sequence * 2);
    }
    expect(history.size).toBe(MAX_PENDING_INPUTS);
    expect(history.didOverflow).toBe(true);
  });

  it('replays exact 60 Hz applied-input ticks instead of network packets', () => {
    const timeline = new PredictionInputTimeline();
    for (let tick = 100; tick < 106; tick += 1) timeline.record(tick, THROTTLE);
    let replayed = 0;
    expect(timeline.replay(102, 106, () => (replayed += 1))).toBe(4);
    expect(replayed).toBe(4);
  });
});

describe('local vehicle prediction', () => {
  it('replays inputs the server has not acknowledged', () => {
    const prediction = activePrediction(vehicleSnapshot());
    prediction.recordInput(1, THROTTLE);
    prediction.update(CLIENT_PREDICTION_FIXED_DELTA_SECONDS * 2, THROTTLE, null);
    prediction.reconcile(
      vehicleSnapshot({ lastProcessedInputSequence: -1 }),
      null,
      CLIENT_PREDICTION_FIXED_DELTA_SECONDS * 2,
    );
    expect(prediction.metrics.pendingInputs).toBe(1);
    expect(prediction.latestPredictedState?.forwardSpeed).toBeGreaterThan(0);
    expect(prediction.latestPredictedState?.position[2]).toBeGreaterThan(0);
  });

  it('does not replay an acknowledged input', () => {
    const prediction = activePrediction(vehicleSnapshot());
    prediction.recordInput(1, THROTTLE);
    prediction.update(CLIENT_PREDICTION_FIXED_DELTA_SECONDS * 2, THROTTLE, null);
    prediction.reconcile(vehicleSnapshot({ lastProcessedInputSequence: 1 }), null);
    expect(prediction.metrics.pendingInputs).toBe(0);
    expect(prediction.latestPredictedState?.position).toEqual([0, 1, 0]);
  });

  it('uses the server sequence acknowledgement to trim replay history', () => {
    const prediction = activePrediction(vehicleSnapshot());
    prediction.recordInput(1, THROTTLE);
    prediction.recordInput(2, THROTTLE);
    prediction.reconcile(vehicleSnapshot({ lastProcessedInputSequence: 1 }), null);
    expect(prediction.metrics.pendingInputs).toBe(1);
    expect(prediction.metrics.lastAcknowledgedInput).toBe(1);
  });

  it('smoothly decays a small reconciliation correction', () => {
    const prediction = activePrediction(vehicleSnapshot());
    prediction.reconcile(vehicleSnapshot({ position: [0.1, 1, 0] }), null);
    const before = prediction.getVisualSnapshot().position[0];
    prediction.update(0.1, NEUTRAL, null);
    const after = prediction.getVisualSnapshot().position[0];
    expect(prediction.metrics.positionError).toBeCloseTo(0.1, 5);
    expect(before).toBeCloseTo(0, 5);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(0.1);
    expect(prediction.metrics.hardSnaps).toBe(0);
  });

  it('does not create visual correction inside the reconciliation dead zone', () => {
    const prediction = activePrediction(vehicleSnapshot());
    prediction.reconcile(vehicleSnapshot({ position: [0.02, 1, 0] }), null);
    expect(prediction.metrics.positionError).toBeCloseTo(0.02, 5);
    expect(prediction.metrics.visualCorrectionOffset).toBe(0);
    expect(prediction.getVisualSnapshot().position[0]).toBeCloseTo(0.02, 5);
  });

  it('does not accumulate an existing visual correction on a tiny follow-up', () => {
    const prediction = activePrediction(vehicleSnapshot());
    prediction.reconcile(vehicleSnapshot({ position: [0.2, 1, 0] }), null);
    const firstOffset = prediction.metrics.visualCorrectionOffset;
    prediction.reconcile(vehicleSnapshot({ position: [0.2, 1, 0] }), null);
    expect(prediction.metrics.visualCorrectionOffset).toBeCloseTo(firstOffset, 6);
  });

  it('decays visual correction toward zero', () => {
    const prediction = activePrediction(vehicleSnapshot());
    prediction.reconcile(vehicleSnapshot({ position: [0.2, 1, 0] }), null);
    prediction.update(1, NEUTRAL, null);
    expect(prediction.metrics.visualCorrectionOffset).toBeLessThan(0.001);
  });

  it('treats q and -q as the same rotation', () => {
    const prediction = activePrediction(vehicleSnapshot());
    prediction.reconcile(vehicleSnapshot({ rotation: [0, 0, 0, -1] }), null);
    expect(prediction.metrics.rotationErrorDegrees).toBe(0);
    expect(prediction.metrics.visualCorrectionOffset).toBe(0);
    expect(prediction.metrics.correctionsPerSecond).toBe(0);
  });

  it('hard snaps a severe authoritative desync', () => {
    const prediction = activePrediction(vehicleSnapshot());
    prediction.reconcile(vehicleSnapshot({ position: [8, 1, 0] }), null);
    expect(prediction.getVisualSnapshot().position[0]).toBe(8);
    expect(prediction.metrics.hardSnaps).toBe(1);
  });

  it.each(['reset', 'self-right', 'round spawn'])(
    'clears stale input replay for a %s discontinuity',
    () => {
      const prediction = activePrediction(vehicleSnapshot());
      prediction.recordInput(1, THROTTLE);
      prediction.prepareForAuthoritativeDiscontinuity();
      expect(prediction.metrics.pendingInputs).toBe(0);
      prediction.reconcile(vehicleSnapshot({ position: [4, 1, 2] }), null);
      expect(prediction.getVisualSnapshot().position).toEqual([4, 1, 2]);
    },
  );

  it('does not predict movement while controls are outside PLAYING', () => {
    const prediction = new LocalVehiclePrediction();
    prediction.resyncFromAuthoritativeState(vehicleSnapshot());
    prediction.setActive(false);
    prediction.update(1, THROTTLE, null);
    expect(prediction.latestPredictedState?.position).toEqual([0, 1, 0]);
  });

  it('predicts immediately at a fixed 60 Hz while PLAYING', () => {
    const prediction = activePrediction(vehicleSnapshot());
    prediction.update(CLIENT_PREDICTION_FIXED_DELTA_SECONDS * 2, THROTTLE, null);
    expect(prediction.latestPredictedState?.forwardSpeed).toBeGreaterThan(0);
    expect(prediction.latestPredictedState?.position[2]).toBeGreaterThan(0);
  });

  it('keeps physics time independent from the 30 Hz network send cadence', () => {
    const withPackets = activePrediction(vehicleSnapshot());
    const withoutPackets = activePrediction(vehicleSnapshot());
    for (let tick = 0; tick < 60; tick += 1) {
      withPackets.update(CLIENT_PREDICTION_FIXED_DELTA_SECONDS, THROTTLE, null);
      withoutPackets.update(CLIENT_PREDICTION_FIXED_DELTA_SECONDS, THROTTLE, null);
      if (tick % 2 === 0) withPackets.recordInput(tick / 2, THROTTLE);
    }
    expect(withPackets.latestPredictedState?.position).toEqual(
      withoutPackets.latestPredictedState?.position,
    );
    expect(withPackets.metrics.predictionTick).toBe(60);
  });

  it('stays within straight-line tolerance for ten seconds of fixed-step reconciliation', () => {
    const prediction = activePrediction(vehicleSnapshot());
    const authority = vehicleSnapshot();
    let sequence = 0;
    for (let tick = 1; tick <= 600; tick += 1) {
      simulatePredictionTick(authority, THROTTLE);
      prediction.update(CLIENT_PREDICTION_FIXED_DELTA_SECONDS, THROTTLE, null);
      if (tick % 2 === 0) {
        sequence += 1;
        prediction.recordInput(sequence, THROTTLE);
      }
      if (tick % 3 === 0) {
        authority.lastProcessedInputSequence = sequence;
        prediction.reconcile(authority, null);
      }
    }
    expect(prediction.metrics.averagePositionError).toBeLessThan(0.05);
    expect(prediction.metrics.maximumPositionError).toBeLessThan(0.1);
    expect(prediction.metrics.averageVelocityError).toBeLessThan(0.05);
  });

  it('keeps prediction state finite during long simulation', () => {
    const prediction = activePrediction(vehicleSnapshot());
    for (let tick = 0; tick < 1_200; tick += 1) {
      prediction.update(CLIENT_PREDICTION_FIXED_DELTA_SECONDS, THROTTLE, null);
    }
    const state = prediction.latestPredictedState;
    expect(state).not.toBeNull();
    expect(
      [...(state?.position ?? []), ...(state?.linearVelocity ?? [])].every(
        Number.isFinite,
      ),
    ).toBe(true);
  });

  it('full resync clears prediction buffers and adopts authority', () => {
    const prediction = activePrediction(vehicleSnapshot());
    prediction.recordInput(5, THROTTLE);
    prediction.resyncFromAuthoritativeState(
      vehicleSnapshot({ position: [2, 1, 3], lastProcessedInputSequence: 5 }),
    );
    expect(prediction.metrics.pendingInputs).toBe(0);
    expect(prediction.getVisualSnapshot().position).toEqual([2, 1, 3]);
  });

  it('keeps neutral trailer-relative prediction stable on a moving surface', () => {
    const convoy = convoySnapshot();
    const prediction = activePrediction(
      vehicleSnapshot({
        position: [0, 2, 0],
        linearVelocity: [11, 0, 0],
        onTrailer: true,
        surfaceType: 'TRAILER_DECK',
      }),
    );
    for (let tick = 0; tick < 600; tick += 1) {
      prediction.update(CLIENT_PREDICTION_FIXED_DELTA_SECONDS, NEUTRAL, convoy);
    }
    const predictedX = prediction.latestPredictedState?.position[0] ?? 0;
    const extrapolatedTrailerX =
      convoy.trailer.position[0] + convoy.trailer.linearVelocity[0] * 10;
    expect(Math.abs(predictedX - extrapolatedTrailerX)).toBeLessThan(0.05);
  });

  it('preserves authoritative RAM velocity and slide state during reconciliation', () => {
    const prediction = activePrediction(vehicleSnapshot());
    prediction.reconcile(
      vehicleSnapshot({
        linearVelocity: [8, 0, 0],
        ramSlideRemainingTicks: 60,
      }),
      null,
    );
    prediction.update(CLIENT_PREDICTION_FIXED_DELTA_SECONDS, NEUTRAL, null);
    expect(prediction.latestPredictedState?.ramSlideRemainingTicks).toBe(59);
    expect(prediction.latestPredictedState?.linearVelocity[0]).toBeGreaterThan(7.9);
  });
});

describe('moving platform render alignment', () => {
  it('maps present-time prediction back onto the buffered trailer timeline', () => {
    const trailer = convoySnapshot().trailer;
    const offset: [number, number, number] = [0, 0, 0];
    calculateMovingPlatformRenderOffset(trailer, 0.15, [0.55, 0, 0], offset);
    expect(offset[0]).toBeCloseTo(-1.1, 5);
    expect(1.65 + offset[0]).toBeCloseTo(0.55, 5);
  });
});

function activePrediction(snapshot: VehicleStateSnapshot): LocalVehiclePrediction {
  const prediction = new LocalVehiclePrediction();
  prediction.resyncFromAuthoritativeState(snapshot);
  prediction.setActive(true);
  return prediction;
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

function convoySnapshot(): ConvoyStateSnapshot {
  const body = {
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    linearVelocity: [11, 0, 0] as [number, number, number],
    angularVelocity: [0, 0, 0] as [number, number, number],
  };
  return { pathProgress: 0.5, speed: 11, truck: { ...body }, trailer: { ...body } };
}
