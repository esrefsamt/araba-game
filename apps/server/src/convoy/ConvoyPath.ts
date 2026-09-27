import { TRACK_LAP_LENGTH, getTrackCenterlinePoint } from '@trailer-arena/shared';
import type { QuaternionTuple, TrackPathSample } from '@trailer-arena/shared';

export function wrapPathDistance(distance: number): number {
  return ((distance % TRACK_LAP_LENGTH) + TRACK_LAP_LENGTH) % TRACK_LAP_LENGTH;
}

export function sampleConvoyPath(distance: number): TrackPathSample {
  return getTrackCenterlinePoint(wrapPathDistance(distance) / TRACK_LAP_LENGTH);
}

export function rotationForPathTangent(
  tangent: readonly [number, number, number],
): QuaternionTuple {
  const yaw = Math.atan2(tangent[0], tangent[2]);
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}
