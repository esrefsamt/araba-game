/**
 * Server-authoritative arcade RAM tuning. Rapier remains responsible for
 * contact generation and natural angular response; these values define the
 * intentionally overpowered horizontal gameplay kick layered on top.
 */
export const PLAYER_COLLISION_TUNING = {
  ramEnabled: true,
  ramMinimumClosingSpeed: 2,
  ramFullPowerSpeed: 7,
  ramMinimumTargetDeltaVelocity: 2,
  ramMaximumTargetDeltaVelocity: 12,
  ramAttackerReactionRatio: 0.2,
  ramPairCooldownSeconds: 0.3,
  ramVerticalDeltaVelocityMax: 0,
  ramAdhesionBreakMinSeconds: 0.8,
  ramAdhesionBreakMaxSeconds: 1.5,
  balancedImpactSpeedDifference: 0.75,
  minimumHorizontalNormalRatio: 0.5,
  attackerAdhesionBreakRatio: 0.2,
  // Both tire-grip layers recover gradually after a successful target hit.
  // Wheel friction starts lower because it compounds with explicit lateral grip.
  ramSlideDurationSeconds: 1.2,
  ramSlideInitialGripMultiplier: 0.2,
  ramSlideInitialWheelFrictionMultiplier: 0,
  ramSlideRollingResistanceMultiplier: 0.35,
  ramSlideGripRecoveryCurve: 'ease-in-sextic',
  ramSlideOrientationMaximumRecoveryDegrees: 80,
  ramSlideOrientationRecoveryMultiplier: 2,
} as const;
