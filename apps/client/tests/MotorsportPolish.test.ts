import {
  OVAL_TRACK_LAYOUT,
  STATIC_WORLD_BOXES,
  getTrackCenterlinePoint,
} from '@trailer-arena/shared';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { AudioManager } from '../src/audio/AudioManager.js';
import {
  ENGINE_AUDIO,
  createEngineNoise,
  engineMix,
  remoteEngineMixScale,
  selectAudioGear,
  stepEngineAudio,
} from '../src/audio/EngineAudioModel.js';
import {
  MotorsportEnvironment,
  VENUE_LAYOUT,
  createFenceSegments,
} from '../src/rendering/MotorsportEnvironment.js';

function signature(group: THREE.Group) {
  return group.children.map((child) =>
    child instanceof THREE.InstancedMesh
      ? {
          name: child.name,
          count: child.count,
          matrices: Array.from(child.instanceMatrix.array),
          colors:
            child.instanceColor === null ? [] : Array.from(child.instanceColor.array),
        }
      : { name: child.name, position: child.position.toArray() },
  );
}

describe('Phase 6.1 motorsport environment', () => {
  it('rebuilds identical zone positions, occupancy and color variations', () => {
    expect(signature(new MotorsportEnvironment().group)).toEqual(
      signature(new MotorsportEnvironment().group),
    );
  });

  it('closes the fence outside ten metres of grass runoff and preserves the oval', () => {
    const before = structuredClone({
      layout: OVAL_TRACK_LAYOUT,
      boxes: STATIC_WORLD_BOXES,
    });
    const segments = createFenceSegments();
    expect(segments).toHaveLength(96);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const center = getTrackCenterlinePoint(index / segments.length).position;
      expect(
        Math.hypot(segment.start[0] - center[0], segment.start[2] - center[2]),
      ).toBeCloseTo(18, 8);
      expect(segment.end).toEqual(segments[(index + 1) % segments.length]!.start);
      expect(segment.length).toBeGreaterThan(0);
      expect(segment.length).toBeLessThan(6);
    }
    expect({ layout: OVAL_TRACK_LAYOUT, boxes: STATIC_WORLD_BOXES }).toEqual(before);
    expect(OVAL_TRACK_LAYOUT).toMatchObject({
      straightLength: 72,
      turnRadius: 32,
      trackWidth: 16,
    });
  });

  it('uses bounded batches and flat crowd cards, with no added physics boxes', () => {
    const before = structuredClone(STATIC_WORLD_BOXES);
    const venue = new MotorsportEnvironment().group;
    const batches = venue.children.filter(
      (child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh,
    );
    const crowd = batches.filter((batch) => batch.name.includes('crowd-bodies'));
    expect(crowd).toHaveLength(2);
    expect(crowd.reduce((sum, batch) => sum + batch.count, 0)).toBeGreaterThan(400);
    expect(crowd.reduce((sum, batch) => sum + batch.count, 0)).toBeLessThanOrEqual(648);
    expect(venue.children.length).toBeLessThan(30);
    expect(
      batches.every((batch) => !batch.castShadow && batch.userData.collider === false),
    ).toBe(true);
    const wire = batches.find((batch) => batch.name === 'venue-catch-fence-wire')!;
    expect(wire.count).toBe(VENUE_LAYOUT.fenceSegments);
    expect(venue.userData.collider).toBe(false);
    expect(STATIC_WORLD_BOXES).toEqual(before);
    const triangles = batches.reduce(
      (sum, batch) =>
        sum +
        (batch.count *
          (batch.geometry.index?.count ?? batch.geometry.attributes.position!.count)) /
          3,
      0,
    );
    expect(triangles).toBeLessThan(8000);
  });
});

describe('Phase 6.1 engine presentation', () => {
  const idle = { rpm: 900, load: 0, gear: 1 };
  it('keeps idle alive while braking and models audio-only gears deterministically', () => {
    expect(stepEngineAudio(idle, 0, 0, true, 1 / 60).rpm).toBeGreaterThanOrEqual(900);
    expect([0, 6, 11, 17].map(selectAudioGear)).toEqual([1, 2, 3, 4]);
    expect(selectAudioGear(-11)).toBe(3);
    const rising = stepEngineAudio({ rpm: 4200, load: 1, gear: 1 }, 6, 1, false, 1 / 60);
    expect(rising.gear).toBe(2);
    expect(rising.rpm).toBeGreaterThan(4100);
    expect(rising.rpm).toBeLessThan(4200);
    expect(stepEngineAudio(rising, 5.3, 1, false, 1 / 60).gear).toBe(2);
    expect(stepEngineAudio(rising, 4.9, 1, false, 1 / 60).gear).toBe(1);
  });

  it('produces bounded finite parameters even for invalid snapshots or frame timing', () => {
    for (const value of [NaN, Infinity, -Infinity, -1e9, 0, 1e9]) {
      const state = stepEngineAudio(
        { rpm: value, load: value, gear: value },
        value,
        value,
        true,
        value,
      );
      expect(state.rpm).toBeGreaterThanOrEqual(ENGINE_AUDIO.idleRpm);
      expect(state.rpm).toBeLessThanOrEqual(ENGINE_AUDIO.maxRpm);
      expect(state.load).toBeGreaterThanOrEqual(0);
      expect(state.load).toBeLessThanOrEqual(1);
      const mix = engineMix(state, value);
      expect(Object.values(mix).every(Number.isFinite)).toBe(true);
      expect(mix.pulseHz).toBeGreaterThan(20);
      expect(mix.cutoffHz).toBeLessThanOrEqual(900);
    }
  });

  it('smooths a complete acceleration, cruise, reverse and braking sequence', () => {
    let state = idle;
    let maximumStep = 0;
    for (let frame = 0; frame < 3600; frame += 1) {
      const speed = frame < 1200 ? frame / 60 : frame < 2400 ? 20 : -4;
      const next = stepEngineAudio(
        state,
        speed,
        frame < 2400 ? 1 : -1,
        frame > 3000,
        1 / 60,
      );
      maximumStep = Math.max(maximumStep, Math.abs(next.rpm - state.rpm));
      expect(next.rpm).toBeGreaterThanOrEqual(900);
      expect(next.rpm).toBeLessThanOrEqual(6500);
      state = next;
    }
    expect(maximumStep).toBeLessThan(250);
    expect(state.gear).toBe(1);
  });

  it('keeps seven remote voices collectively below half a local engine', () => {
    expect(remoteEngineMixScale(0, 1)).toBeLessThanOrEqual(0.16);
    expect(remoteEngineMixScale(0, 7) * 7).toBeLessThan(0.5);
    expect(remoteEngineMixScale(25, 1)).toBeLessThan(0.015);
    expect(remoteEngineMixScale(40, 1)).toBe(0);
    expect(remoteEngineMixScale(10, 1)).toBeLessThan(remoteEngineMixScale(0, 1));
  });

  it('generates a deterministic non-tonal mechanical texture with a silent seam', () => {
    const noise = createEngineNoise(8000);
    expect(noise).toEqual(createEngineNoise(8000));
    expect(noise[0]).toBe(0);
    expect(Math.abs(noise[noise.length - 1]!)).toBe(0);
    expect(
      Array.from(noise).every((value) => Number.isFinite(value) && Math.abs(value) < 1),
    ).toBe(true);
  });

  it('preserves toggle and context-free lifecycle before the first gesture', async () => {
    const audio = new AudioManager();
    expect(audio.toggleEnabled()).toBe(false);
    await audio.unlock();
    audio.updateLocalEngine(21, 1, 0);
    audio.updateRemoteEngines([], [0, 0, 0]);
    expect(audio.settings.enabled).toBe(false);
    expect(audio.toggleEnabled()).toBe(true);
    audio.dispose();
    audio.dispose();
  });
});
