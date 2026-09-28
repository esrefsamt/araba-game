import { VEHICLE_DIMENSIONS, VEHICLE_TUNING } from '@trailer-arena/shared';
import type { VehicleStateSnapshot } from '@trailer-arena/shared';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { VehicleView } from '../src/entities/VehicleView.js';
import {
  WheelVisualKinematics,
  visualSteeringAngle,
  wheelAngularSpeed,
} from '../src/entities/WheelVisualKinematics.js';

function state(overrides: Partial<VehicleStateSnapshot> = {}): VehicleStateSnapshot {
  return {
    playerId: 'driver',
    lastProcessedInputSequence: 0,
    position: [0, 0.84, 0],
    rotation: [0, 0, 0, 1],
    linearVelocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    forwardSpeed: 0,
    lateralSpeed: 0,
    grounded: true,
    surfaceType: 'GROUND',
    onTrailer: false,
    relativeForwardSpeed: 0,
    relativeLateralSpeed: 0,
    wheelContacts: 4,
    trailerDeckContacts: 0,
    trailerRelativePosition: [0, 0, 0],
    flipped: false,
    selfRightAvailable: false,
    ramSlideRemainingTicks: 0,
    ...overrides,
  };
}
function view() {
  const scene = new THREE.Scene();
  const vehicle = new VehicleView('driver', scene);
  return { scene, vehicle };
}
function wheels(vehicle: VehicleView) {
  return vehicle.object.children.filter((object) =>
    object.name.startsWith('wheel-steer-'),
  );
}
function advance(vehicle: VehicleView, snapshot: VehicleStateSnapshot, frames = 60) {
  for (let frame = 0; frame < frames; frame += 1) {
    vehicle.beginRenderFrame();
    vehicle.applyPredictedState(snapshot, 1 / 60);
  }
  vehicle.object.updateMatrixWorld(true);
}

describe('longitudinal wheel kinematics', () => {
  it.each([-7, 0, 6, 21])('uses v/r for %s m/s longitudinal speed', (speed) => {
    expect(wheelAngularSpeed(speed, 0.38)).toBeCloseTo(speed / 0.38, 12);
    const motion = new WheelVisualKinematics();
    motion.update(speed, null, 4, 1 / 60);
    expect(motion.spin).toBeCloseTo(speed / VEHICLE_DIMENSIONS.wheelRadius / 60, 12);
  });

  it('reverses the spin sign while keeping the input steering convention', () => {
    const forward = new WheelVisualKinematics();
    const reverse = new WheelVisualKinematics();
    forward.update(5, -1, 4, 1 / 60);
    reverse.update(-5, -1, 4, 1 / 60);
    expect(reverse.spin).toBeCloseTo(-forward.spin);
    expect(reverse.steering).toBeCloseTo(forward.steering);
    expect(reverse.steering).toBeGreaterThan(0);
  });

  it('smooths a snapshot speed discontinuity and settles promptly on the new sign', () => {
    const motion = new WheelVisualKinematics();
    motion.update(6, null, 4, 1 / 60);
    const before = motion.spin;
    motion.update(-6, null, 4, 1 / 60);
    expect(motion.spin - before).toBeGreaterThan(0);
    for (let frame = 0; frame < 30; frame += 1) motion.update(-6, null, 4, 1 / 60);
    const settled = motion.spin;
    motion.update(-6, null, 4, 1 / 60);
    const difference = Math.atan2(
      Math.sin(motion.spin - settled),
      Math.cos(motion.spin - settled),
    );
    expect(difference).toBeCloseTo(-6 / VEHICLE_DIMENSIONS.wheelRadius / 60, 3);
  });

  it('keeps angles and wheel centers finite for corrupt samples, extreme numbers and long pauses', () => {
    const motion = new WheelVisualKinematics();
    for (const value of [
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      0,
      1e20,
    ]) {
      for (let index = 0; index < 100; index += 1)
        motion.update(value, value, value, value);
      expect([motion.spin, motion.steering, motion.centerY].every(Number.isFinite)).toBe(
        true,
      );
      expect(Math.abs(motion.spin)).toBeLessThanOrEqual(Math.PI);
      expect(Number.isFinite(wheelAngularSpeed(value, Number.MIN_VALUE))).toBe(true);
    }
    expect(wheelAngularSpeed(3, 0)).toBe(0);
    expect(wheelAngularSpeed(3, NaN)).toBe(0);
    expect(visualSteeringAngle(Infinity, 0)).toBe(0);
  });

  it('uses the existing suspension rest length and nominal compression without physics writes', () => {
    const motion = new WheelVisualKinematics();
    const restCenter =
      -VEHICLE_DIMENSIONS.chassisHeight * 0.3 - VEHICLE_TUNING.suspensionRestLength;
    expect(motion.centerY).toBeCloseTo(restCenter);
    for (let frame = 0; frame < 120; frame += 1) motion.update(0, null, 4, 1 / 60);
    const wheelBottom = 0.84 + motion.centerY - VEHICLE_DIMENSIONS.wheelRadius;
    expect(Math.abs(wheelBottom)).toBeLessThan(0.02);
    for (let frame = 0; frame < 120; frame += 1) motion.update(0, null, 0, 1 / 60);
    expect(motion.centerY).toBeCloseTo(restCenter, 5);
  });
});

describe('actual player wheel hierarchy', () => {
  it.each([-1, 1])(
    'steers both front wheels in input direction %s, including at rest and in reverse',
    (command) => {
      const { scene, vehicle } = view();
      vehicle.setWheelSteeringInput(command);
      for (const speed of [0, -3, 3]) {
        advance(vehicle, state({ forwardSpeed: speed }));
        for (const pivot of wheels(vehicle)) {
          const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(pivot.quaternion);
          if (pivot.name.includes('front')) {
            const driverRight = new THREE.Vector3(-1, 0, 0);
            expect(Math.sign(forward.dot(driverRight))).toBe(command);
            expect(pivot.rotation.y).toBeCloseTo(visualSteeringAngle(command, speed), 3);
          } else expect(pivot.rotation.y).toBe(0);
        }
      }
      vehicle.dispose(scene);
    },
  );

  it('spins both sides about the steered X axle without wobble or Euler overwrites', () => {
    const { scene, vehicle } = view();
    vehicle.setWheelSteeringInput(1);
    let previousSpin = 0;
    for (let frame = 0; frame < 600; frame += 1) {
      advance(vehicle, state({ forwardSpeed: 5 }), 1);
      const phases: number[] = [];
      for (const pivot of wheels(vehicle)) {
        const spin = pivot.getObjectByName('wheel-spin')!;
        const mesh = spin.getObjectByName('wheel-mesh')!;
        expect(mesh.parent).toBe(spin);
        expect(spin.parent).toBe(pivot);
        expect(spin.rotation.y).toBe(0);
        expect(spin.rotation.z).toBe(0);
        expect(pivot.rotation.x).toBe(0);
        expect(pivot.rotation.z).toBe(0);
        const expectedAxle = new THREE.Vector3(1, 0, 0).applyQuaternion(pivot.quaternion);
        const meshRotation = mesh.getWorldQuaternion(new THREE.Quaternion());
        const actualAxle = new THREE.Vector3(0, 1, 0).applyQuaternion(meshRotation);
        expect(actualAxle.distanceTo(expectedAxle)).toBeLessThan(1e-6);
        phases.push(spin.rotation.x);
      }
      expect(new Set(phases).size).toBe(1);
      expect(
        Math.atan2(
          Math.sin(phases[0]! - previousSpin),
          Math.cos(phases[0]! - previousSpin),
        ),
      ).toBeCloseTo(5 / VEHICLE_DIMENSIONS.wheelRadius / 60, 6);
      previousSpin = phases[0]!;
    }
    vehicle.dispose(scene);
  });

  it('ignores world speed magnitude and lateral RAM slide velocity', () => {
    const normal = view();
    const sliding = view();
    advance(normal.vehicle, state({ forwardSpeed: 3, linearVelocity: [0, 0, 3] }));
    advance(
      sliding.vehicle,
      state({
        forwardSpeed: 3,
        lateralSpeed: 28,
        linearVelocity: [28, 0, 3],
        angularVelocity: [0, 3, 0],
        ramSlideRemainingTicks: 30,
      }),
    );
    for (let index = 0; index < 4; index += 1)
      expect(
        wheels(normal.vehicle)[index]!.getObjectByName('wheel-spin')!.rotation.x,
      ).toBe(wheels(sliding.vehicle)[index]!.getObjectByName('wheel-spin')!.rotation.x);
    normal.vehicle.dispose(normal.scene);
    sliding.vehicle.dispose(sliding.scene);
  });

  it('leaves a car resting on a moving trailer with stationary wheels', () => {
    const { scene, vehicle } = view();
    advance(
      vehicle,
      state({
        onTrailer: true,
        forwardSpeed: 8,
        relativeForwardSpeed: 0,
        linearVelocity: [0, 0, 8],
      }),
    );
    for (const pivot of wheels(vehicle))
      expect(pivot.getObjectByName('wheel-spin')!.rotation.x).toBe(0);
    vehicle.dispose(scene);
  });

  it('animates remote snapshot speed with neutral steering despite angular velocity', () => {
    const { scene, vehicle } = view();
    vehicle.addSnapshot(0, state({ forwardSpeed: -4, angularVelocity: [0, 6, 0] }));
    vehicle.beginRenderFrame();
    vehicle.updateRemote(0, 1 / 60);
    for (const pivot of wheels(vehicle)) {
      expect(pivot.rotation.y).toBe(0);
      expect(pivot.getObjectByName('wheel-spin')!.rotation.x).toBeCloseTo(
        -4 / VEHICLE_DIMENSIONS.wheelRadius / 60,
      );
    }
    expect(vehicle.transformWriteDebug).toEqual({
      source: 'INTERPOLATION',
      writesThisFrame: 1,
      conflictingWrites: 0,
    });
    vehicle.dispose(scene);
  });

  it('never mutates the supplied prediction state or adds a chassis transform writer', () => {
    const { scene, vehicle } = view();
    const snapshot = state({ forwardSpeed: 6 });
    const original = JSON.stringify(snapshot);
    vehicle.setWheelSteeringInput(-1);
    advance(vehicle, snapshot);
    expect(JSON.stringify(snapshot)).toBe(original);
    expect(vehicle.object.position.toArray()).toEqual(snapshot.position);
    expect(vehicle.object.quaternion.toArray()).toEqual(snapshot.rotation);
    expect(vehicle.transformWriteDebug).toEqual({
      source: 'PREDICTION',
      writesThisFrame: 1,
      conflictingWrites: 0,
    });
    vehicle.dispose(scene);
  });
});
