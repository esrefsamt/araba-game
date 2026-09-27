import { VEHICLE_TUNING } from '@trailer-arena/shared';
import * as THREE from 'three';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export class ChaseCamera {
  public readonly camera: THREE.PerspectiveCamera;
  private readonly targetPosition = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly desiredPosition = new THREE.Vector3();
  private readonly desiredLookAt = new THREE.Vector3();
  private readonly smoothedLookAt = new THREE.Vector3(0, 0.5, 0);
  private readonly smoothedPosition = new THREE.Vector3(18, 22, 28);
  private readonly shakeOffset = new THREE.Vector3();
  private target: THREE.Object3D | null = null;
  private shakeRemaining = 0;
  private shakeMagnitude = 0;

  public constructor() {
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      350,
    );
    this.camera.position.set(18, 22, 28);
    this.camera.lookAt(this.smoothedLookAt);
  }

  public setTarget(target: THREE.Object3D | null): void {
    this.target = target;
  }

  public resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  public addImpactShake(strength: number): void {
    const amount = THREE.MathUtils.clamp(strength, 0, 1);
    if (amount < 0.2) return;
    this.shakeRemaining = Math.max(this.shakeRemaining, 0.11 + amount * 0.12);
    this.shakeMagnitude = Math.max(this.shakeMagnitude, 0.035 + amount * 0.12);
  }

  public update(deltaSeconds: number, speedMetersPerSecond: number): void {
    if (this.target === null) {
      return;
    }

    this.target.getWorldPosition(this.targetPosition);
    this.forward.set(0, 0, 1).applyQuaternion(this.target.quaternion);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 0.001) {
      this.forward.set(0, 0, 1);
    } else {
      this.forward.normalize();
    }

    const speedRatio = Math.min(
      1,
      Math.abs(speedMetersPerSecond) / VEHICLE_TUNING.maxForwardSpeed,
    );
    const chaseDistance = 7.4 + speedRatio * 0.85;
    const chaseHeight = 3.8 + speedRatio * 0.18;
    this.desiredPosition
      .copy(this.targetPosition)
      .addScaledVector(this.forward, -chaseDistance)
      .addScaledVector(WORLD_UP, chaseHeight);
    this.desiredLookAt
      .copy(this.targetPosition)
      .addScaledVector(this.forward, 2.2)
      .addScaledVector(WORLD_UP, 0.65);

    const positionAlpha = 1 - Math.exp(-5.2 * deltaSeconds);
    const lookAlpha = 1 - Math.exp(-7 * deltaSeconds);
    this.smoothedPosition.lerp(this.desiredPosition, positionAlpha);
    this.smoothedLookAt.lerp(this.desiredLookAt, lookAlpha);
    this.camera.position.copy(this.smoothedPosition);
    if (this.shakeRemaining > 0) {
      this.shakeRemaining = Math.max(0, this.shakeRemaining - deltaSeconds);
      const decay = Math.min(1, this.shakeRemaining / 0.16);
      const phase = this.shakeRemaining * 127;
      this.shakeOffset.set(
        Math.sin(phase * 1.7),
        Math.sin(phase * 2.3 + 1.2) * 0.55,
        Math.cos(phase * 1.9) * 0.45,
      );
      this.camera.position.addScaledVector(this.shakeOffset, this.shakeMagnitude * decay);
      if (this.shakeRemaining === 0) this.shakeMagnitude = 0;
    }
    this.camera.up.copy(WORLD_UP);
    this.camera.lookAt(this.smoothedLookAt);

    const targetFov = 60 + speedRatio * 7;
    this.camera.fov += (targetFov - this.camera.fov) * positionAlpha;
    this.camera.updateProjectionMatrix();
  }
}
