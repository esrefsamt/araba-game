export const VEHICLE_DIMENSIONS = {
  width: 1.84,
  height: 1.48,
  length: 3.9,
  chassisHeight: 0.78,
  wheelRadius: 0.38,
  wheelWidth: 0.24,
  wheelBase: 2.55,
  trackWidth: 1.62,
} as const;

export const VEHICLE_TUNING = {
  mass: 1_100,
  engineForce: 6_500,
  reverseForce: 2_600,
  brakeForce: 105,
  handbrakeForce: 62,
  maxForwardSpeed: 21,
  maxReverseSpeed: 7,
  reverseEngageSpeed: 0.8,
  steeringStrength: 0.36,
  highSpeedSteeringReduction: 0.6,
  lateralGrip: 1.02,
  handbrakeGripMultiplier: 0.24,
  rollingResistance: 45,
  airDrag: 4.5,
  centerOfMassOffset: -0.32,
  suspensionRestLength: 0.28,
  suspensionStiffness: 42,
  suspensionCompression: 4.4,
  suspensionRelaxation: 5.2,
  maxSuspensionTravel: 0.22,
  maxSuspensionForce: 8_000,
  wheelFrictionSlip: 10.5,
  wheelSideFrictionStiffness: 1,
  linearDamping: 0.04,
  angularDamping: 0.38,
  groundedUprightStrength: 20,
  groundedUprightDamping: 10,
  groundedOrientationFreeDegrees: 8,
  groundedOrientationSoftLimitDegrees: 12,
  groundedOrientationHardLimitDegrees: 20,
  groundedOrientationMaximumRecoveryDegrees: 65,
  groundedSoftRecoveryDegreesPerSecond: 90,
  groundedHardRecoveryDegreesPerSecond: 240,
  groundedRollPitchAngularSpeed: 1.25,
  maxGroundedRollPitchAngularSpeed: 2,
  colliderBorderRadius: 0.16,
} as const;

export interface SurfaceGrip {
  readonly lateralGripMultiplier: number;
  readonly rollingResistanceMultiplier: number;
  readonly wheelSideFrictionMultiplier: number;
}

export const ASPHALT_SURFACE_GRIP: SurfaceGrip = {
  lateralGripMultiplier: 1,
  rollingResistanceMultiplier: 1,
  wheelSideFrictionMultiplier: 1,
};

export const TRAILER_SURFACE_GRIP: SurfaceGrip = {
  lateralGripMultiplier: 0.93,
  rollingResistanceMultiplier: 0.93,
  wheelSideFrictionMultiplier: 0.93,
};
