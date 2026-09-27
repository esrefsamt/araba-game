export const ENGINE_AUDIO = {
  idleRpm: 900,
  maxRpm: 6500,
  gearThresholds: [5.4, 10.4, 15.8],
} as const;

export interface EngineAudioState {
  readonly rpm: number;
  readonly load: number;
  readonly gear: number;
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, finite(value, low)));
}

export function selectAudioGear(speed: number): number {
  const absolute = Math.abs(finite(speed));
  return (
    ENGINE_AUDIO.gearThresholds.filter((threshold) => absolute >= threshold).length + 1
  );
}

/** Pure presentation model: no writes to vehicle input, physics or shared tuning. */
export function stepEngineAudio(
  previous: EngineAudioState,
  speed: number,
  throttle: number,
  braking: boolean,
  deltaSeconds: number,
): EngineAudioState {
  const velocity = clamp(Math.abs(finite(speed)), 0, 30);
  const reverse = finite(speed) < -0.3 || throttle < 0;
  const requestedGear = reverse ? 1 : selectAudioGear(velocity);
  const oldGear = Math.round(clamp(previous.gear, 1, 4));
  // Schmitt hysteresis avoids repeated shifts when speed hovers at a boundary.
  let gear = requestedGear;
  if (
    !reverse &&
    requestedGear > oldGear &&
    velocity < ENGINE_AUDIO.gearThresholds[oldGear - 1]! + 0.45
  )
    gear = oldGear;
  if (
    !reverse &&
    requestedGear < oldGear &&
    velocity > ENGINE_AUDIO.gearThresholds[oldGear - 2]! - 0.45
  )
    gear = oldGear;
  const bottom = reverse || gear === 1 ? 0 : ENGINE_AUDIO.gearThresholds[gear - 2]!;
  const top = reverse ? 8 : gear === 4 ? 23 : ENGINE_AUDIO.gearThresholds[gear - 1]!;
  const inGear = clamp((velocity - bottom) / (top - bottom), 0, 1);
  const requestedLoad = braking ? 0.12 : clamp(Math.abs(throttle), 0, 1);
  const target = clamp(
    ENGINE_AUDIO.idleRpm +
      (gear === 1 ? 0 : 1150) +
      inGear * (reverse ? 2600 : 3300) +
      requestedLoad * 1000,
    ENGINE_AUDIO.idleRpm,
    ENGINE_AUDIO.maxRpm,
  );
  const dt = clamp(deltaSeconds, 0, 0.1);
  const rpm = clamp(
    finite(previous.rpm, ENGINE_AUDIO.idleRpm),
    ENGINE_AUDIO.idleRpm,
    ENGINE_AUDIO.maxRpm,
  );
  const alpha = 1 - Math.exp(-dt / (target > rpm ? 0.2 : 0.38));
  return {
    rpm: clamp(rpm + (target - rpm) * alpha, ENGINE_AUDIO.idleRpm, ENGINE_AUDIO.maxRpm),
    load: clamp(
      finite(previous.load) +
        (requestedLoad - finite(previous.load)) * (1 - Math.exp(-dt / 0.16)),
      0,
      1,
    ),
    gear,
  };
}

export function engineMix(state: EngineAudioState, time: number) {
  const rpm = clamp(state.rpm, ENGINE_AUDIO.idleRpm, ENGINE_AUDIO.maxRpm);
  const load = clamp(state.load, 0, 1);
  // Four-stroke V4 firing cadence, with very small cycle variation.
  const variation =
    1 + Math.sin(finite(time) * 7.3) * 0.006 + Math.sin(finite(time) * 11.7) * 0.003;
  return {
    pulseHz: (rpm / 30) * variation,
    bodyGain: 0.026 + load * 0.016,
    harmonicGain: 0.004 + load * 0.003,
    mechanicalGain: 0.009 + load * 0.006,
    intakeGain: 0.003 + load * 0.005,
    cutoffHz: 440 + load * 280 + (rpm / ENGINE_AUDIO.maxRpm) * 180,
  };
}

export function remoteEngineMixScale(distance: number, nearbyVoices: number): number {
  const d = clamp(distance, 0, 1000);
  if (d >= 40) return 0;
  const rolloff = 1 / (1 + (d / 7) ** 2);
  const fade = clamp((40 - d) / 10, 0, 1);
  return (0.16 * rolloff * fade) / Math.sqrt(clamp(nearbyVoices, 1, 7));
}

/** Repeatable noise texture, shared by all voices; no external sound assets. */
export function createEngineNoise(sampleRate: number): Float32Array<ArrayBuffer> {
  const samples = new Float32Array(
    Math.max(1, Math.round(clamp(sampleRate, 8000, 192000) * 2)),
  );
  let seed = 0x61c0ffee;
  let brown = 0;
  for (let index = 0; index < samples.length; index += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const white = ((seed >>> 0) / 0xffffffff) * 2 - 1;
    brown = (brown + white * 0.12) / 1.12;
    // Window the loop seam to avoid a repeated click.
    const seam = Math.min(1, index / 256, (samples.length - 1 - index) / 256);
    samples[index] = (white * 0.45 + brown * 1.8) * 0.42 * seam;
  }
  return samples;
}
