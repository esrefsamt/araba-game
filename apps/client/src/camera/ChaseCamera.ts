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
  private target: THREE.Object3D | null = null;

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

    this.desiredPosition
      .copy(this.targetPosition)
      .addScaledVector(this.forward, -7.4)
      .addScaledVector(WORLD_UP, 3.8);
    this.desiredLookAt
      .copy(this.targetPosition)
      .addScaledVector(this.forward, 2.2)
      .addScaledVector(WORLD_UP, 0.65);

    const positionAlpha = 1 - Math.exp(-5.2 * deltaSeconds);
    const lookAlpha = 1 - Math.exp(-7 * deltaSeconds);
    this.camera.position.lerp(this.desiredPosition, positionAlpha);
    this.smoothedLookAt.lerp(this.desiredLookAt, lookAlpha);
    this.camera.up.copy(WORLD_UP);
    this.camera.lookAt(this.smoothedLookAt);

    const speedRatio = Math.min(
      1,
      Math.abs(speedMetersPerSecond) / VEHICLE_TUNING.maxForwardSpeed,
    );
    const targetFov = 60 + speedRatio * 7;
    this.camera.fov += (targetFov - this.camera.fov) * positionAlpha;
    this.camera.updateProjectionMatrix();
  }
}
