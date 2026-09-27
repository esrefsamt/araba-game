import type { QuaternionTuple, Vector3Tuple } from '../types/Vehicle.js';

export interface StaticWorldBox {
  readonly id: string;
  readonly kind: 'ground' | 'boundary' | 'ramp' | 'barrier';
  readonly position: Vector3Tuple;
  readonly halfExtents: Vector3Tuple;
  readonly rotation: QuaternionTuple;
  readonly friction: number;
}

export interface VehicleSpawnPoint {
  readonly position: Vector3Tuple;
  readonly rotation: QuaternionTuple;
}

export interface TrackPathSample {
  readonly position: Vector3Tuple;
  readonly tangent: Vector3Tuple;
}

export const OVAL_TRACK_LAYOUT = {
  center: [0, 0, 0] as Vector3Tuple,
  straightLength: 72,
  straightHalfLength: 36,
  turnRadius: 32,
  trackWidth: 16,
} as const;

export const TRACK_LAP_LENGTH =
  OVAL_TRACK_LAYOUT.straightLength * 2 + Math.PI * 2 * OVAL_TRACK_LAYOUT.turnRadius;
export const WORLD_HALF_EXTENT_X =
  OVAL_TRACK_LAYOUT.straightHalfLength +
  OVAL_TRACK_LAYOUT.turnRadius +
  OVAL_TRACK_LAYOUT.trackWidth / 2 +
  12;
export const WORLD_HALF_EXTENT_Z =
  OVAL_TRACK_LAYOUT.turnRadius + OVAL_TRACK_LAYOUT.trackWidth / 2 + 12;
export const WORLD_RESET_Y = -10;

const IDENTITY_ROTATION: QuaternionTuple = [0, 0, 0, 1];
const RAMP_ANGLE = -0.1;

/** Samples the shared oval centerline by normalized lap progress. */
export function getTrackCenterlinePoint(progress: number): TrackPathSample {
  const wrappedProgress = ((progress % 1) + 1) % 1;
  let distance = wrappedProgress * TRACK_LAP_LENGTH;
  const straightLength = OVAL_TRACK_LAYOUT.straightLength;
  const halfStraight = OVAL_TRACK_LAYOUT.straightHalfLength;
  const radius = OVAL_TRACK_LAYOUT.turnRadius;
  const turnLength = Math.PI * radius;
  const [centerX, centerY, centerZ] = OVAL_TRACK_LAYOUT.center;

  if (distance < straightLength) {
    return {
      position: [centerX - halfStraight + distance, centerY, centerZ - radius],
      tangent: [1, 0, 0],
    };
  }

  distance -= straightLength;
  if (distance < turnLength) {
    const angle = -Math.PI / 2 + distance / radius;
    return {
      position: [
        centerX + halfStraight + Math.cos(angle) * radius,
        centerY,
        centerZ + Math.sin(angle) * radius,
      ],
      tangent: [-Math.sin(angle), 0, Math.cos(angle)],
    };
  }

  distance -= turnLength;
  if (distance < straightLength) {
    return {
      position: [centerX + halfStraight - distance, centerY, centerZ + radius],
      tangent: [-1, 0, 0],
    };
  }

  distance -= straightLength;
  const angle = Math.PI / 2 + distance / radius;
  return {
    position: [
      centerX - halfStraight + Math.cos(angle) * radius,
      centerY,
      centerZ + Math.sin(angle) * radius,
    ],
    tangent: [-Math.sin(angle), 0, Math.cos(angle)],
  };
}

export function getTrackOffsetPoint(progress: number, leftOffset: number): Vector3Tuple {
  const sample = getTrackCenterlinePoint(progress);
  const [tangentX, , tangentZ] = sample.tangent;
  return [
    sample.position[0] - tangentZ * leftOffset,
    sample.position[1],
    sample.position[2] + tangentX * leftOffset,
  ];
}

export const STATIC_WORLD_BOXES: readonly StaticWorldBox[] = [
  {
    id: 'ground',
    kind: 'ground',
    position: [0, -0.3, 0],
    halfExtents: [WORLD_HALF_EXTENT_X, 0.3, WORLD_HALF_EXTENT_Z],
    rotation: IDENTITY_ROTATION,
    friction: 1,
  },
  {
    id: 'infield-test-ramp',
    kind: 'ramp',
    position: [0, 0.18, 0],
    halfExtents: [2.4, 0.18, 3],
    rotation: [Math.sin(RAMP_ANGLE / 2), 0, 0, Math.cos(RAMP_ANGLE / 2)],
    friction: 1,
  },
  {
    id: 'infield-test-block',
    kind: 'barrier',
    position: [0, 0.65, 8],
    halfExtents: [1.5, 0.65, 1.5],
    rotation: IDENTITY_ROTATION,
    friction: 0.85,
  },
];

const SPAWN_PROGRESS = 0.08;
const SPAWN_SAMPLE = getTrackCenterlinePoint(SPAWN_PROGRESS);
const SPAWN_YAW = Math.atan2(SPAWN_SAMPLE.tangent[0], SPAWN_SAMPLE.tangent[2]);
const SPAWN_ROTATION: QuaternionTuple = [
  0,
  Math.sin(SPAWN_YAW / 2),
  0,
  Math.cos(SPAWN_YAW / 2),
];

export const VEHICLE_SPAWN_POINTS: readonly VehicleSpawnPoint[] = Array.from(
  { length: 8 },
  (_, index) => {
    const row = Math.floor(index / 2);
    const lateralOffset = index % 2 === 0 ? -2.3 : 2.3;
    const longitudinalOffset = -row * 5.2;
    const [tangentX, , tangentZ] = SPAWN_SAMPLE.tangent;
    return {
      position: [
        SPAWN_SAMPLE.position[0] +
          tangentX * longitudinalOffset -
          tangentZ * lateralOffset,
        1.15,
        SPAWN_SAMPLE.position[2] +
          tangentZ * longitudinalOffset +
          tangentX * lateralOffset,
      ],
      rotation: SPAWN_ROTATION,
    };
  },
);
