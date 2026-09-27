export const CONVOY_TUNING = {
  targetSpeed: 11,
  accelerationSeconds: 3,
  initialPathProgress: 0.58,
  towDistance: 13,
  trailerGrip: 0.93,
  neutralSurfaceAdhesion: 1,
  neutralSurfaceAdhesionMaxRelativeSpeed: 1.5,
  neutralSurfaceAdhesionBreakawaySpeed: 2.5,
  neutralSurfaceTiltAngularRetention: 0.35,
  neutralSurfaceUprightStrength: 3,
  neutralSurfacePositionCorrection: 3,
  neutralSurfaceMaxCorrectionSpeed: 1.25,
} as const;

export const TRUCK_DIMENSIONS = {
  width: 3,
  height: 3.3,
  length: 6.8,
  bodyCenterHeight: 1.65,
  wheelRadius: 0.68,
} as const;

const TRAILER_DECK_LENGTH = 16;
const TRAILER_DECK_HEIGHT = 1.5;
const TRAILER_DECK_THICKNESS = 0.24;
const TRAILER_RAMP_HORIZONTAL_LENGTH = 6;
const TRAILER_RAMP_ROAD_OVERLAP = 0.03;
const TRAILER_RAMP_DECK_OVERLAP = 0.04;
const TRAILER_RAMP_SURFACE_RISE =
  TRAILER_DECK_HEIGHT + TRAILER_DECK_THICKNESS / 2 + TRAILER_RAMP_ROAD_OVERLAP;

export const TRAILER_RAMP_ANGLE = Math.atan2(
  TRAILER_RAMP_SURFACE_RISE,
  TRAILER_RAMP_HORIZONTAL_LENGTH,
);
const TRAILER_RAMP_LENGTH = Math.hypot(
  TRAILER_RAMP_HORIZONTAL_LENGTH,
  TRAILER_RAMP_SURFACE_RISE,
);

export const TRAILER_DIMENSIONS = {
  deckLength: TRAILER_DECK_LENGTH,
  deckWidth: 7,
  deckHeight: TRAILER_DECK_HEIGHT,
  deckThickness: TRAILER_DECK_THICKNESS,
  rampLength: TRAILER_RAMP_LENGTH,
  rampHorizontalLength: TRAILER_RAMP_HORIZONTAL_LENGTH,
  rampThickness: 0.2,
  rampRoadOverlap: TRAILER_RAMP_ROAD_OVERLAP,
  rampDeckOverlap: TRAILER_RAMP_DECK_OVERLAP,
  sideLipHeight: 0.3,
  sideLipThickness: 0.22,
  frontBarrierHeight: 0.8,
  frontBarrierThickness: 0.28,
  wheelRadius: 0.62,
  underbodyWidth: 6.4,
  underbodyHeight: 1,
  underbodyLength: 14.7,
  underbodyCenterY: 0.75,
  underbodyCenterZ: 0.35,
} as const;

const rampTopMeanY =
  (TRAILER_DECK_HEIGHT + TRAILER_DECK_THICKNESS / 2 - TRAILER_RAMP_ROAD_OVERLAP) / 2;
const rampFrontTopLocalZ =
  -Math.sin(TRAILER_RAMP_ANGLE) * (TRAILER_DIMENSIONS.rampThickness / 2) +
  Math.cos(TRAILER_RAMP_ANGLE) * (TRAILER_RAMP_LENGTH / 2);

export const TRAILER_RAMP_GEOMETRY = {
  centerY:
    rampTopMeanY - Math.cos(TRAILER_RAMP_ANGLE) * (TRAILER_DIMENSIONS.rampThickness / 2),
  centerZ: -TRAILER_DECK_LENGTH / 2 + TRAILER_RAMP_DECK_OVERLAP - rampFrontTopLocalZ,
  roadSurfaceY: -TRAILER_RAMP_ROAD_OVERLAP,
  deckSurfaceY: TRAILER_DECK_HEIGHT + TRAILER_DECK_THICKNESS / 2,
  frontSurfaceZ: -TRAILER_DECK_LENGTH / 2 + TRAILER_RAMP_DECK_OVERLAP,
} as const;

export const VEHICLE_RECOVERY_TUNING = {
  flippedUpDotThreshold: 0.45,
  maximumSpeed: 2,
  requiredFlippedSeconds: 1.2,
  supportRayLength: 2.5,
  safeSurfaceOffset: 1.02,
  retainedHorizontalSpeed: 0.2,
  maximumRetainedHorizontalSpeed: 1,
} as const;
