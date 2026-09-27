import type { RigidBodyStateSnapshot, Vector3Tuple } from '@trailer-arena/shared';

/**
 * Local prediction runs near the present while convoy visuals intentionally
 * render behind a jitter buffer. This translation keeps a predicted car at
 * the same platform-relative point without moving remote entities off their
 * shared authoritative render timeline.
 */
export function calculateMovingPlatformRenderOffset(
  latestPlatform: RigidBodyStateSnapshot,
  predictedAgeSeconds: number,
  renderedPlatformPosition: Vector3Tuple,
  output: Vector3Tuple,
): Vector3Tuple {
  output[0] =
    renderedPlatformPosition[0] -
    (latestPlatform.position[0] + latestPlatform.linearVelocity[0] * predictedAgeSeconds);
  output[1] =
    renderedPlatformPosition[1] -
    (latestPlatform.position[1] + latestPlatform.linearVelocity[1] * predictedAgeSeconds);
  output[2] =
    renderedPlatformPosition[2] -
    (latestPlatform.position[2] + latestPlatform.linearVelocity[2] * predictedAgeSeconds);
  return output;
}
