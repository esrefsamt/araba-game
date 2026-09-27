import { SIMULATION_FIXED_DELTA_SECONDS, VEHICLE_TUNING } from '@trailer-arena/shared';
import { describe, expect, it } from 'vitest';

import { calculateGroundedOrientationControl } from '../src/vehicles/VehicleController.js';

const WORLD_UP = { x: 0, y: 1, z: 0 };
const targetAngular = { x: 0, y: 0, z: 0 };
const targetRotation = { x: 0, y: 0, z: 0, w: 1 };

describe('hard grounded arcade orientation control', () => {
  it('does not mutate horizontal linear velocity while correcting orientation', () => {
    const linearVelocity = { x: 10, y: 0.2, z: -4 };
    const before = { ...linearVelocity };
    calculateGroundedOrientationControl(
      axisAngle({ x: 0, y: 0, z: 1 }, 25),
      { x: 5, y: 2, z: 4 },
      WORLD_UP,
      4,
      SIMULATION_FIXED_DELTA_SECONDS,
      targetAngular,
      targetRotation,
    );
    expect(linearVelocity).toEqual(before);
  });

  it('rapidly recovers rotation beyond the hard grounded limit without snapping', () => {
    let rotation = axisAngle({ x: 0, y: 0, z: 1 }, 30);
    const beforeTilt = tiltFromNormalDegrees(rotation, WORLD_UP);
    const applied = calculateGroundedOrientationControl(
      rotation,
      { x: 0, y: 0, z: 0 },
      WORLD_UP,
      4,
      SIMULATION_FIXED_DELTA_SECONDS,
      targetAngular,
      targetRotation,
    );
    expect(applied).toBe(true);
    expect(tiltFromNormalDegrees(targetRotation, WORLD_UP)).toBeLessThan(beforeTilt);
    expect(tiltFromNormalDegrees(targetRotation, WORLD_UP)).toBeGreaterThan(20);
    for (let tick = 0; tick < 3; tick += 1) {
      rotation = { ...targetRotation };
      calculateGroundedOrientationControl(
        rotation,
        { x: 0, y: 0, z: 0 },
        WORLD_UP,
        4,
        SIMULATION_FIXED_DELTA_SECONDS,
        targetAngular,
        targetRotation,
      );
    }
    expect(tiltFromNormalDegrees(targetRotation, WORLD_UP)).toBeLessThanOrEqual(
      VEHICLE_TUNING.groundedOrientationHardLimitDegrees,
    );
  });

  it('leaves mild visual body roll inside the free range untouched', () => {
    const rotation = axisAngle({ x: 0, y: 0, z: 1 }, 6);
    const angularVelocity = { x: 0, y: 0.5, z: 0.4 };
    expect(
      calculateGroundedOrientationControl(
        rotation,
        angularVelocity,
        WORLD_UP,
        4,
        SIMULATION_FIXED_DELTA_SECONDS,
        targetAngular,
        targetRotation,
      ),
    ).toBe(false);
    expect(targetRotation).toEqual(rotation);
    expect(targetAngular).toEqual(angularVelocity);
  });

  it('preserves yaw angular velocity around the support normal', () => {
    const rotation = multiplyQuaternions(
      axisAngle(WORLD_UP, 45),
      axisAngle({ x: 0, y: 0, z: 1 }, 18),
    );
    const angularVelocity = { x: 4, y: 3.25, z: 2 };
    calculateGroundedOrientationControl(
      rotation,
      angularVelocity,
      WORLD_UP,
      4,
      SIMULATION_FIXED_DELTA_SECONDS,
      targetAngular,
      targetRotation,
    );
    expect(dot(targetAngular, WORLD_UP)).toBeCloseTo(3.25, 8);
  });

  it('caps excessive grounded roll angular speed before tilt develops', () => {
    calculateGroundedOrientationControl(
      identityQuaternion(),
      { x: 0, y: 1.5, z: 8 },
      WORLD_UP,
      4,
      SIMULATION_FIXED_DELTA_SECONDS,
      targetAngular,
      targetRotation,
    );
    expect(Math.abs(targetAngular.z)).toBeCloseTo(
      VEHICLE_TUNING.maxGroundedRollPitchAngularSpeed,
      8,
    );
    expect(targetAngular.y).toBeCloseTo(1.5, 8);
  });

  it('caps excessive grounded pitch angular speed before tilt develops', () => {
    calculateGroundedOrientationControl(
      identityQuaternion(),
      { x: 8, y: -2.25, z: 0 },
      WORLD_UP,
      4,
      SIMULATION_FIXED_DELTA_SECONDS,
      targetAngular,
      targetRotation,
    );
    expect(Math.abs(targetAngular.x)).toBeCloseTo(
      VEHICLE_TUNING.maxGroundedRollPitchAngularSpeed,
      8,
    );
    expect(targetAngular.y).toBeCloseTo(-2.25, 8);
  });

  it('does not correct an airborne or single-wheel vehicle', () => {
    const rotation = axisAngle({ x: 0, y: 0, z: 1 }, 30);
    const angularVelocity = { x: 1, y: 2, z: 3 };
    for (const contacts of [0, 1]) {
      expect(
        calculateGroundedOrientationControl(
          rotation,
          angularVelocity,
          WORLD_UP,
          contacts,
          SIMULATION_FIXED_DELTA_SECONDS,
          targetAngular,
          targetRotation,
        ),
      ).toBe(false);
      expect(targetAngular).toEqual(angularVelocity);
      expect(targetRotation).toEqual(rotation);
    }
  });

  it('leaves extreme grounded tilt outside the recovery envelope for rare flips', () => {
    const rotation = axisAngle({ x: 0, y: 0, z: 1 }, 75);
    const angularVelocity = { x: 0, y: 0.5, z: 0.8 };
    expect(
      calculateGroundedOrientationControl(
        rotation,
        angularVelocity,
        WORLD_UP,
        4,
        SIMULATION_FIXED_DELTA_SECONDS,
        targetAngular,
        targetRotation,
      ),
    ).toBe(false);
    expect(targetRotation).toEqual(rotation);
    expect(targetAngular).toEqual(angularVelocity);
  });

  it('treats an aligned ramp normal as upright instead of forcing world-up pitch', () => {
    const rampRotation = axisAngle({ x: 1, y: 0, z: 0 }, 16);
    const rampNormal = vehicleUp(rampRotation);
    const angularVelocity = { x: 0.7, y: 0.2, z: 0 };
    expect(
      calculateGroundedOrientationControl(
        rampRotation,
        angularVelocity,
        rampNormal,
        4,
        SIMULATION_FIXED_DELTA_SECONDS,
        targetAngular,
        targetRotation,
      ),
    ).toBe(false);
    expect(targetRotation).toEqual(rampRotation);
    expect(targetAngular).toEqual(angularVelocity);
  });

  it('preserves projected heading during hard orientation recovery', () => {
    const rotation = multiplyQuaternions(
      axisAngle(WORLD_UP, 50),
      axisAngle({ x: 0, y: 0, z: 1 }, 28),
    );
    const headingBefore = projectedForward(rotation, WORLD_UP);
    calculateGroundedOrientationControl(
      rotation,
      { x: 0, y: 0, z: 0 },
      WORLD_UP,
      4,
      SIMULATION_FIXED_DELTA_SECONDS,
      targetAngular,
      targetRotation,
    );
    const headingAfter = projectedForward(targetRotation, WORLD_UP);
    expect(dot(headingAfter, headingBefore)).toBeGreaterThan(0.999);
    expect(tiltFromNormalDegrees(targetRotation, WORLD_UP)).toBeLessThan(28);
    expect(
      [
        targetRotation.x,
        targetRotation.y,
        targetRotation.z,
        targetRotation.w,
        targetAngular.x,
        targetAngular.y,
        targetAngular.z,
      ].every(Number.isFinite),
    ).toBe(true);
  });
});

interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

interface Vector3 {
  x: number;
  y: number;
  z: number;
}

function identityQuaternion(): Quaternion {
  return { x: 0, y: 0, z: 0, w: 1 };
}

function axisAngle(axis: Vector3, degrees: number): Quaternion {
  const halfAngle = (degrees * Math.PI) / 360;
  const sine = Math.sin(halfAngle);
  return {
    x: axis.x * sine,
    y: axis.y * sine,
    z: axis.z * sine,
    w: Math.cos(halfAngle),
  };
}

function multiplyQuaternions(first: Quaternion, second: Quaternion): Quaternion {
  return {
    x: first.w * second.x + first.x * second.w + first.y * second.z - first.z * second.y,
    y: first.w * second.y - first.x * second.z + first.y * second.w + first.z * second.x,
    z: first.w * second.z + first.x * second.y - first.y * second.x + first.z * second.w,
    w: first.w * second.w - first.x * second.x - first.y * second.y - first.z * second.z,
  };
}

function vehicleUp(rotation: Quaternion): Vector3 {
  return {
    x: 2 * (rotation.x * rotation.y - rotation.w * rotation.z),
    y: 1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z),
    z: 2 * (rotation.y * rotation.z + rotation.w * rotation.x),
  };
}

function vehicleForward(rotation: Quaternion): Vector3 {
  return {
    x: 2 * (rotation.x * rotation.z + rotation.w * rotation.y),
    y: 2 * (rotation.y * rotation.z - rotation.w * rotation.x),
    z: 1 - 2 * (rotation.x * rotation.x + rotation.y * rotation.y),
  };
}

function tiltFromNormalDegrees(rotation: Quaternion, normal: Vector3): number {
  const up = vehicleUp(rotation);
  return (Math.acos(Math.max(-1, Math.min(1, dot(up, normal)))) * 180) / Math.PI;
}

function projectedForward(rotation: Quaternion, normal: Vector3): Vector3 {
  const forward = vehicleForward(rotation);
  const normalComponent = dot(forward, normal);
  const projected = {
    x: forward.x - normal.x * normalComponent,
    y: forward.y - normal.y * normalComponent,
    z: forward.z - normal.z * normalComponent,
  };
  const length = Math.hypot(projected.x, projected.y, projected.z);
  return {
    x: projected.x / length,
    y: projected.y / length,
    z: projected.z / length,
  };
}

function dot(first: Vector3, second: Vector3): number {
  return first.x * second.x + first.y * second.y + first.z * second.z;
}
