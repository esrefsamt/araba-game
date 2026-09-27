import type RAPIER from '@dimforge/rapier3d-compat';
import { PLAYER_COLLISION_TUNING } from '@trailer-arena/shared';

import type { ServerVehicle } from './ServerVehicle.js';

interface MotionSample {
  readonly linearVelocity: RAPIER.Vector3;
  surfaceRelativeHorizontalSpeed: number;
}

export interface PlayerImpactMeasurement {
  readonly firstPlayerId: string;
  readonly secondPlayerId: string;
  readonly normal: readonly [number, number, number];
  readonly relativeVelocity: readonly [number, number, number];
  readonly closingSpeed: number;
  readonly nativeImpulse: number;
  readonly assistImpulse: number;
  readonly impactCurve: number;
  readonly targetPlayerId: string;
  readonly attackerPlayerId: string;
  readonly targetArcadeDeltaVelocity: number;
  readonly attackerReactionRatio: number;
  readonly targetAdhesionBreakSeconds: number;
  readonly attackerAdhesionBreakSeconds: number;
  readonly firstVelocityBefore: readonly [number, number, number];
  readonly secondVelocityBefore: readonly [number, number, number];
  readonly firstVelocityAfterNative: readonly [number, number, number];
  readonly secondVelocityAfterNative: readonly [number, number, number];
  readonly firstAngularVelocityAfterNative: readonly [number, number, number];
  readonly secondAngularVelocityAfterNative: readonly [number, number, number];
  readonly firstVelocityAfterAssist: readonly [number, number, number];
  readonly secondVelocityAfterAssist: readonly [number, number, number];
  readonly firstAngularVelocityAfterAssist: readonly [number, number, number];
  readonly secondAngularVelocityAfterAssist: readonly [number, number, number];
}

const ZERO_VECTOR = { x: 0, y: 0, z: 0 };

/**
 * Detects player contacts after Rapier's solver, records the native response,
 * temporarily releases Phase 3.1's neutral trailer anchor, and (for a new,
 * sufficiently fast impact only) applies a bounded horizontal arcade impulse.
 * The target receives the full gameplay response while the attacker receives
 * a smaller counter-impulse, preserving impact feedback without making a
 * successful ram feel like hitting a wall. Keeping this outside the driving
 * controller prevents collision tuning from changing ordinary vehicle input.
 */
export class PlayerCollisionSystem {
  private readonly motionSamples = new Map<string, MotionSample>();
  private readonly assistedPairs = new Set<string>();
  private readonly pairCooldownSeconds = new Map<string, number>();
  private readonly normal = { x: 0, y: 0, z: 0 };
  private readonly assistedNormal = { x: 0, y: 0, z: 0 };
  private readonly impulse = { x: 0, y: 0, z: 0 };
  private readonly attackerCorrectionImpulse = { x: 0, y: 0, z: 0 };
  private readonly pendingImpacts: PlayerImpactMeasurement[] = [];
  private latestImpact: PlayerImpactMeasurement | null = null;

  public get lastImpact(): PlayerImpactMeasurement | null {
    return this.latestImpact;
  }

  public drainImpacts(): PlayerImpactMeasurement[] {
    return this.pendingImpacts.splice(0, this.pendingImpacts.length);
  }

  public capturePreStepMotion(vehicles: ReadonlyMap<string, ServerVehicle>): void {
    for (const [playerId, vehicle] of vehicles) {
      let sample = this.motionSamples.get(playerId);
      if (sample === undefined) {
        sample = {
          linearVelocity: { x: 0, y: 0, z: 0 },
          surfaceRelativeHorizontalSpeed: 0,
        };
        this.motionSamples.set(playerId, sample);
      }
      copyVector(vehicle.body.linvel(), sample.linearVelocity);
      sample.surfaceRelativeHorizontalSpeed = vehicle.surfaceRelativeHorizontalSpeed;
    }
  }

  public processEvents(
    events: RAPIER.EventQueue,
    vehicles: ReadonlyMap<string, ServerVehicle>,
    deltaSeconds: number,
  ): void {
    this.updatePairCooldowns(deltaSeconds);
    const byCollider = new Map<number, readonly [string, ServerVehicle]>();
    const stoppedPairs = new Set<string>();
    for (const entry of vehicles) byCollider.set(entry[1].collider.handle, entry);

    events.drainCollisionEvents((firstHandle, secondHandle, started) => {
      if (started) return;
      const first = byCollider.get(firstHandle);
      const second = byCollider.get(secondHandle);
      if (first !== undefined && second !== undefined) {
        stoppedPairs.add(makePairKey(first[0], second[0]));
      }
    });

    events.drainContactForceEvents((event) => {
      const firstEntry = byCollider.get(event.collider1());
      const secondEntry = byCollider.get(event.collider2());
      if (firstEntry === undefined || secondEntry === undefined) return;
      const [firstPlayerId, first] = firstEntry;
      const [secondPlayerId, second] = secondEntry;
      const pairKey = makePairKey(firstPlayerId, secondPlayerId);
      if (this.assistedPairs.has(pairKey)) {
        return;
      }
      if ((this.pairCooldownSeconds.get(pairKey) ?? 0) > 0) {
        // Mark this cooldown-suppressed contact as consumed too. Otherwise a
        // pair that stays touching could receive a delayed RAM when the timer
        // expires without ever separating and creating a new impact.
        this.assistedPairs.add(pairKey);
        return;
      }

      const firstSample = this.motionSamples.get(firstPlayerId);
      const secondSample = this.motionSamples.get(secondPlayerId);
      if (firstSample === undefined || secondSample === undefined) return;

      event.maxForceDirection(this.normal);
      orientNormalFromFirstToSecond(
        first.body.translation(),
        second.body.translation(),
        this.normal,
        this.normal,
      );
      const relativeVelocity = {
        x: secondSample.linearVelocity.x - firstSample.linearVelocity.x,
        y: secondSample.linearVelocity.y - firstSample.linearVelocity.y,
        z: secondSample.linearVelocity.z - firstSample.linearVelocity.z,
      };
      const closingSpeed = calculateClosingSpeed(relativeVelocity, this.normal);
      if (closingSpeed <= 0) {
        return;
      }

      this.assistedPairs.add(pairKey);
      const firstAfterNative = toTuple(first.body.linvel());
      const secondAfterNative = toTuple(second.body.linvel());
      const firstAngularAfterNative = toTuple(first.body.angvel());
      const secondAngularAfterNative = toTuple(second.body.angvel());
      const canAssist = limitImpactNormal(this.normal, this.assistedNormal);
      const balancedImpact =
        Math.abs(
          firstSample.surfaceRelativeHorizontalSpeed -
            secondSample.surfaceRelativeHorizontalSpeed,
        ) <= PLAYER_COLLISION_TUNING.balancedImpactSpeedDifference;
      const firstIsAttacker =
        balancedImpact ||
        firstSample.surfaceRelativeHorizontalSpeed >=
          secondSample.surfaceRelativeHorizontalSpeed;
      const attacker = firstIsAttacker ? first : second;
      const target = firstIsAttacker ? second : first;
      const attackerSample = firstIsAttacker ? firstSample : secondSample;
      const attackerPlayerId = firstIsAttacker ? firstPlayerId : secondPlayerId;
      const targetPlayerId = firstIsAttacker ? secondPlayerId : firstPlayerId;
      const directionSign = firstIsAttacker ? 1 : -1;
      this.assistedNormal.x *= directionSign;
      this.assistedNormal.y *= directionSign;
      this.assistedNormal.z *= directionSign;

      const impactCurve = calculateImpactCurve(closingSpeed);
      const targetArcadeDeltaVelocity = canAssist
        ? calculateArcadeTargetDeltaVelocity(closingSpeed)
        : 0;
      const assistImpulse = calculateMassAwareImpactImpulse(
        closingSpeed,
        target.body.mass(),
      );
      const attackerReactionRatio = balancedImpact
        ? 1
        : PLAYER_COLLISION_TUNING.ramAttackerReactionRatio;
      const calculatedTargetAdhesionBreakSeconds =
        calculateAdhesionBreakDuration(closingSpeed);
      const targetAdhesionBreakSeconds =
        targetArcadeDeltaVelocity > 0
          ? Math.max(
              calculatedTargetAdhesionBreakSeconds,
              PLAYER_COLLISION_TUNING.ramSlideDurationSeconds,
            )
          : calculatedTargetAdhesionBreakSeconds;
      const attackerAdhesionBreakSeconds = balancedImpact
        ? targetAdhesionBreakSeconds
        : targetAdhesionBreakSeconds * PLAYER_COLLISION_TUNING.attackerAdhesionBreakRatio;

      if (targetAdhesionBreakSeconds > 0) {
        target.suspendTrailerAdhesion(targetAdhesionBreakSeconds);
        attacker.suspendTrailerAdhesion(attackerAdhesionBreakSeconds);
      }

      if (assistImpulse > 0) {
        target.startRamSlide();
        this.pairCooldownSeconds.set(
          pairKey,
          PLAYER_COLLISION_TUNING.ramPairCooldownSeconds,
        );
        this.impulse.x = this.assistedNormal.x * assistImpulse;
        this.impulse.y = 0;
        this.impulse.z = this.assistedNormal.z * assistImpulse;
        target.body.applyImpulse(this.impulse, true);
        if (balancedImpact) {
          this.attackerCorrectionImpulse.x = -this.impulse.x;
          this.attackerCorrectionImpulse.y = 0;
          this.attackerCorrectionImpulse.z = -this.impulse.z;
        } else {
          // Native equal-mass resolution can stop a successful rammer outright.
          // Preserve Rapier's separation, vertical and angular response, but
          // correct horizontal velocity to the explicit arcade reaction target.
          const attackerVelocity = attacker.body.linvel();
          const desiredX =
            attackerSample.linearVelocity.x -
            this.assistedNormal.x * targetArcadeDeltaVelocity * attackerReactionRatio;
          const desiredZ =
            attackerSample.linearVelocity.z -
            this.assistedNormal.z * targetArcadeDeltaVelocity * attackerReactionRatio;
          this.attackerCorrectionImpulse.x =
            (desiredX - attackerVelocity.x) * attacker.body.mass();
          this.attackerCorrectionImpulse.y = 0;
          this.attackerCorrectionImpulse.z =
            (desiredZ - attackerVelocity.z) * attacker.body.mass();
        }
        attacker.body.applyImpulse(this.attackerCorrectionImpulse, true);
      }

      this.latestImpact = {
        firstPlayerId,
        secondPlayerId,
        normal: toTuple(this.normal),
        relativeVelocity: toTuple(relativeVelocity),
        closingSpeed,
        nativeImpulse: event.totalForceMagnitude() * deltaSeconds,
        assistImpulse,
        impactCurve,
        targetPlayerId,
        attackerPlayerId,
        targetArcadeDeltaVelocity,
        attackerReactionRatio,
        targetAdhesionBreakSeconds,
        attackerAdhesionBreakSeconds,
        firstVelocityBefore: toTuple(firstSample.linearVelocity),
        secondVelocityBefore: toTuple(secondSample.linearVelocity),
        firstVelocityAfterNative: firstAfterNative,
        secondVelocityAfterNative: secondAfterNative,
        firstAngularVelocityAfterNative: firstAngularAfterNative,
        secondAngularVelocityAfterNative: secondAngularAfterNative,
        firstVelocityAfterAssist: toTuple(first.body.linvel()),
        secondVelocityAfterAssist: toTuple(second.body.linvel()),
        firstAngularVelocityAfterAssist: toTuple(first.body.angvel()),
        secondAngularVelocityAfterAssist: toTuple(second.body.angvel()),
      };
      this.pendingImpacts.push(this.latestImpact);
    });

    // A CCD impact can start and stop inside the same physics step while still
    // producing a contact-force event. Clear after processing forces so that
    // the event is assisted once now and the same pair can collide again later.
    for (const pairKey of stoppedPairs) this.assistedPairs.delete(pairKey);
  }

  public removePlayer(playerId: string): void {
    this.motionSamples.delete(playerId);
    for (const pairKey of this.assistedPairs) {
      if (pairKey.startsWith(`${playerId}\0`) || pairKey.endsWith(`\0${playerId}`)) {
        this.assistedPairs.delete(pairKey);
      }
    }
    for (const pairKey of this.pairCooldownSeconds.keys()) {
      if (pairKey.startsWith(`${playerId}\0`) || pairKey.endsWith(`\0${playerId}`)) {
        this.pairCooldownSeconds.delete(pairKey);
      }
    }
  }

  public clear(): void {
    this.motionSamples.clear();
    this.assistedPairs.clear();
    this.pairCooldownSeconds.clear();
    this.pendingImpacts.length = 0;
    this.latestImpact = null;
  }

  private updatePairCooldowns(deltaSeconds: number): void {
    for (const [pairKey, remainingSeconds] of this.pairCooldownSeconds) {
      const nextRemaining = remainingSeconds - deltaSeconds;
      if (nextRemaining <= 0) {
        this.pairCooldownSeconds.delete(pairKey);
      } else {
        this.pairCooldownSeconds.set(pairKey, nextRemaining);
      }
    }
  }
}

export function calculateClosingSpeed(
  relativeVelocity: RAPIER.Vector3,
  collisionNormal: RAPIER.Vector3,
): number {
  return Math.max(
    0,
    -(
      relativeVelocity.x * collisionNormal.x +
      relativeVelocity.y * collisionNormal.y +
      relativeVelocity.z * collisionNormal.z
    ),
  );
}

export function calculateMassAwareImpactImpulse(
  closingSpeed: number,
  targetMass: number,
): number {
  if (!Number.isFinite(targetMass) || targetMass <= 0) {
    return 0;
  }
  return calculateArcadeTargetDeltaVelocity(closingSpeed) * targetMass;
}

export function calculateImpactCurve(closingSpeed: number): number {
  if (!Number.isFinite(closingSpeed)) return 0;
  const speedRange =
    PLAYER_COLLISION_TUNING.ramFullPowerSpeed -
    PLAYER_COLLISION_TUNING.ramMinimumClosingSpeed;
  const normalized = clamp(
    (closingSpeed - PLAYER_COLLISION_TUNING.ramMinimumClosingSpeed) / speedRange,
    0,
    1,
  );
  return normalized * normalized * (3 - 2 * normalized);
}

export function calculateArcadeTargetDeltaVelocity(closingSpeed: number): number {
  if (
    !PLAYER_COLLISION_TUNING.ramEnabled ||
    !Number.isFinite(closingSpeed) ||
    closingSpeed < PLAYER_COLLISION_TUNING.ramMinimumClosingSpeed
  ) {
    return 0;
  }
  const curve = calculateImpactCurve(closingSpeed);
  return (
    PLAYER_COLLISION_TUNING.ramMinimumTargetDeltaVelocity +
    (PLAYER_COLLISION_TUNING.ramMaximumTargetDeltaVelocity -
      PLAYER_COLLISION_TUNING.ramMinimumTargetDeltaVelocity) *
      curve
  );
}

export function calculateAdhesionBreakDuration(closingSpeed: number): number {
  if (
    !Number.isFinite(closingSpeed) ||
    closingSpeed < PLAYER_COLLISION_TUNING.ramMinimumClosingSpeed
  ) {
    return 0;
  }
  const curve = calculateImpactCurve(closingSpeed);
  return (
    PLAYER_COLLISION_TUNING.ramAdhesionBreakMinSeconds +
    (PLAYER_COLLISION_TUNING.ramAdhesionBreakMaxSeconds -
      PLAYER_COLLISION_TUNING.ramAdhesionBreakMinSeconds) *
      curve
  );
}

export function limitImpactNormal(
  collisionNormal: RAPIER.Vector3,
  target: RAPIER.Vector3 = { ...ZERO_VECTOR },
): boolean {
  const horizontalLength = Math.hypot(collisionNormal.x, collisionNormal.z);
  if (horizontalLength < PLAYER_COLLISION_TUNING.minimumHorizontalNormalRatio) {
    target.x = 0;
    target.y = 0;
    target.z = 0;
    return false;
  }
  target.x = collisionNormal.x / horizontalLength;
  target.y = 0;
  target.z = collisionNormal.z / horizontalLength;
  return true;
}

function orientNormalFromFirstToSecond(
  firstPosition: RAPIER.Vector3,
  secondPosition: RAPIER.Vector3,
  rawNormal: RAPIER.Vector3,
  target: RAPIER.Vector3,
): void {
  const centerDeltaX = secondPosition.x - firstPosition.x;
  const centerDeltaY = secondPosition.y - firstPosition.y;
  const centerDeltaZ = secondPosition.z - firstPosition.z;
  const direction =
    rawNormal.x * centerDeltaX + rawNormal.y * centerDeltaY + rawNormal.z * centerDeltaZ <
    0
      ? -1
      : 1;
  target.x = rawNormal.x * direction;
  target.y = rawNormal.y * direction;
  target.z = rawNormal.z * direction;
}

function copyVector(source: RAPIER.Vector3, target: RAPIER.Vector3): void {
  target.x = source.x;
  target.y = source.y;
  target.z = source.z;
}

function toTuple(vector: RAPIER.Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z];
}

function makePairKey(firstPlayerId: string, secondPlayerId: string): string {
  return firstPlayerId < secondPlayerId
    ? `${firstPlayerId}\0${secondPlayerId}`
    : `${secondPlayerId}\0${firstPlayerId}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
