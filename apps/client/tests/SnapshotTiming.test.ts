import { REMOTE_EXTRAPOLATION_MAX_MS, SIMULATION_TICK_RATE } from '@trailer-arena/shared';
import type { VehicleStateSnapshot } from '@trailer-arena/shared';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { VehicleView } from '../src/entities/VehicleView.js';
import { InterpolationClock } from '../src/networking/InterpolationClock.js';
import { SnapshotBuffer } from '../src/networking/SnapshotBuffer.js';

describe('snapshot jitter tolerance', () => {
  it('adapts interpolation delay to arrival jitter without exceeding its cap', () => {
    const clock = new InterpolationClock();
    clock.observeSnapshot(0, 0);
    clock.observeSnapshot(3, 50);
    clock.observeSnapshot(6, 150);
    clock.observeSnapshot(9, 170);
    expect(clock.networkJitterMs).toBeGreaterThan(0);
    expect(clock.interpolationDelayMs).toBeGreaterThan(100);
    expect(clock.interpolationDelayMs).toBeLessThanOrEqual(150);
  });

  it('retains ordered snapshots when delayed packets arrive out of order', () => {
    const buffer = new SnapshotBuffer<string>();
    buffer.add(10, 'ten');
    buffer.add(16, 'sixteen');
    buffer.add(13, 'late-thirteen');
    expect(buffer.size).toBe(2);
    expect(buffer.getSample(13)).toMatchObject({
      from: 'ten',
      to: 'sixteen',
      alpha: 0.5,
    });
  });

  it('limits remote extrapolation and freezes after the maximum window', () => {
    const scene = new THREE.Scene();
    const view = new VehicleView('remote', scene);
    view.addSnapshot(0, vehicleSnapshot());
    view.updateRemote(SIMULATION_TICK_RATE, 1 / 60);
    expect(view.object.position.x).toBeCloseTo(
      10 * (REMOTE_EXTRAPOLATION_MAX_MS / 1_000),
      5,
    );
    view.dispose(scene);
  });
});

function vehicleSnapshot(): VehicleStateSnapshot {
  return {
    playerId: 'remote',
    lastProcessedInputSequence: 10,
    position: [0, 1, 0],
    rotation: [0, 0, 0, 1],
    linearVelocity: [10, 0, 0],
    angularVelocity: [0, 0, 0],
    forwardSpeed: 10,
    lateralSpeed: 0,
    grounded: true,
    surfaceType: 'GROUND',
    onTrailer: false,
    relativeForwardSpeed: 10,
    relativeLateralSpeed: 0,
    wheelContacts: 4,
    trailerDeckContacts: 0,
    trailerRelativePosition: [0, 0, 0],
    flipped: false,
    selfRightAvailable: false,
    ramSlideRemainingTicks: 0,
  };
}
