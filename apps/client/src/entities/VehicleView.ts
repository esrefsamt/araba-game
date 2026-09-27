import {
  REMOTE_EXTRAPOLATION_MAX_TICKS,
  SIMULATION_TICK_RATE,
  VEHICLE_DIMENSIONS,
} from '@trailer-arena/shared';
import type { VehicleStateSnapshot } from '@trailer-arena/shared';
import * as THREE from 'three';

import { SnapshotBuffer } from '../networking/SnapshotBuffer.js';

export type VehicleTransformWriteSource = 'PREDICTION' | 'INTERPOLATION';

export interface VehicleTransformWriteDebug {
  readonly source: VehicleTransformWriteSource | 'NONE';
  readonly writesThisFrame: number;
  readonly conflictingWrites: number;
}

export class VehicleView {
  public readonly object = new THREE.Group();
  private readonly snapshots = new SnapshotBuffer<VehicleStateSnapshot>();
  private readonly fromRotation = new THREE.Quaternion();
  private readonly toRotation = new THREE.Quaternion();
  private readonly extrapolatedRotation = new THREE.Quaternion();
  private readonly angularAxis = new THREE.Vector3();
  private readonly wheels: THREE.Mesh[] = [];
  private sampledState: VehicleStateSnapshot | null = null;
  private transformWriteSource: VehicleTransformWriteSource | 'NONE' = 'NONE';
  private writesThisFrame = 0;
  private conflictingWrites = 0;

  public constructor(
    public readonly playerId: string,
    scene: THREE.Scene,
  ) {
    this.object.name = `vehicle-${playerId}`;
    this.buildModel();
    scene.add(this.object);
  }

  public addSnapshot(serverTick: number, state: VehicleStateSnapshot): void {
    this.snapshots.add(serverTick, state);
  }

  public beginRenderFrame(): void {
    this.transformWriteSource = 'NONE';
    this.writesThisFrame = 0;
  }

  public updateRemote(renderTick: number, deltaSeconds: number): void {
    const state = this.sampleAuthoritativeState(renderTick);
    if (state === null) return;
    this.writeTransform(state, deltaSeconds, 'INTERPOLATION');
  }

  public applyPredictedState(
    state: VehicleStateSnapshot,
    deltaSeconds: number,
    platformRenderOffset?: readonly [number, number, number],
  ): void {
    this.recordTransformWrite('PREDICTION');
    this.object.position.fromArray(state.position);
    if (platformRenderOffset !== undefined) {
      this.object.position.x += platformRenderOffset[0];
      this.object.position.y += platformRenderOffset[1];
      this.object.position.z += platformRenderOffset[2];
    }
    this.object.quaternion.fromArray(state.rotation);
    this.rotateWheels(state.forwardSpeed, deltaSeconds);
  }

  public sampleAuthoritativeState(renderTick: number): VehicleStateSnapshot | null {
    const sample = this.snapshots.getSample(renderTick);
    if (sample === null) return null;
    const discrete = sample.alpha < 0.5 ? sample.from : sample.to;
    if (this.sampledState === null) this.sampledState = cloneSnapshot(discrete);
    const target = this.sampledState;
    copySnapshot(discrete, target);

    lerpTuple(sample.from.position, sample.to.position, sample.alpha, target.position);
    lerpTuple(
      sample.from.linearVelocity,
      sample.to.linearVelocity,
      sample.alpha,
      target.linearVelocity,
    );
    lerpTuple(
      sample.from.angularVelocity,
      sample.to.angularVelocity,
      sample.alpha,
      target.angularVelocity,
    );
    target.forwardSpeed = lerp(
      sample.from.forwardSpeed,
      sample.to.forwardSpeed,
      sample.alpha,
    );
    target.lateralSpeed = lerp(
      sample.from.lateralSpeed,
      sample.to.lateralSpeed,
      sample.alpha,
    );
    target.relativeForwardSpeed = lerp(
      sample.from.relativeForwardSpeed,
      sample.to.relativeForwardSpeed,
      sample.alpha,
    );
    target.relativeLateralSpeed = lerp(
      sample.from.relativeLateralSpeed,
      sample.to.relativeLateralSpeed,
      sample.alpha,
    );
    this.fromRotation.fromArray(sample.from.rotation);
    this.toRotation.fromArray(sample.to.rotation);
    this.extrapolatedRotation.slerpQuaternions(
      this.fromRotation,
      this.toRotation,
      sample.alpha,
    );
    this.extrapolatedRotation.toArray(target.rotation);

    const extrapolationTicks = Math.min(
      sample.extrapolationTicks,
      REMOTE_EXTRAPOLATION_MAX_TICKS,
    );
    if (extrapolationTicks > 0) {
      const seconds = extrapolationTicks / SIMULATION_TICK_RATE;
      target.position[0] += sample.to.linearVelocity[0] * seconds;
      target.position[1] += sample.to.linearVelocity[1] * seconds;
      target.position[2] += sample.to.linearVelocity[2] * seconds;
      applyAngularExtrapolationToSnapshot(
        target,
        seconds,
        this.angularAxis,
        this.fromRotation,
        this.toRotation,
      );
    }
    return target;
  }

  public get transformWriteDebug(): VehicleTransformWriteDebug {
    return {
      source: this.transformWriteSource,
      writesThisFrame: this.writesThisFrame,
      conflictingWrites: this.conflictingWrites,
    };
  }

  public get snapshotBufferSize(): number {
    return this.snapshots.size;
  }

  private rotateWheels(forwardSpeed: number, deltaSeconds: number): void {
    const wheelRotation = (forwardSpeed * deltaSeconds) / VEHICLE_DIMENSIONS.wheelRadius;
    for (const wheel of this.wheels) {
      wheel.rotateX(wheelRotation);
    }
  }

  private writeTransform(
    state: VehicleStateSnapshot,
    deltaSeconds: number,
    source: VehicleTransformWriteSource,
  ): void {
    this.recordTransformWrite(source);
    this.object.position.fromArray(state.position);
    this.object.quaternion.fromArray(state.rotation);
    this.rotateWheels(state.forwardSpeed, deltaSeconds);
  }

  private recordTransformWrite(source: VehicleTransformWriteSource): void {
    if (this.writesThisFrame > 0 && this.transformWriteSource !== source) {
      this.conflictingWrites += 1;
    }
    this.transformWriteSource = source;
    this.writesThisFrame += 1;
  }

  public getLatestSnapshot(): VehicleStateSnapshot | null {
    return this.snapshots.getLatest();
  }

  public dispose(scene: THREE.Scene): void {
    scene.remove(this.object);
    this.object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((material) => material.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
  }

  private buildModel(): void {
    const bodyColor = colorFromPlayerId(this.playerId);
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: bodyColor,
      roughness: 0.72,
      metalness: 0.03,
      flatShading: true,
    });
    const darkMaterial = new THREE.MeshStandardMaterial({
      color: 0x27353c,
      roughness: 0.9,
      flatShading: true,
    });
    const glassMaterial = new THREE.MeshStandardMaterial({
      color: 0x92bac4,
      roughness: 0.35,
      metalness: 0.12,
      flatShading: true,
    });

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(
        VEHICLE_DIMENSIONS.width,
        VEHICLE_DIMENSIONS.chassisHeight,
        VEHICLE_DIMENSIONS.length,
        1,
        1,
        2,
      ),
      bodyMaterial,
    );
    body.position.y = 0.05;
    body.castShadow = true;
    body.receiveShadow = true;
    this.object.add(body);

    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.72, 1.7), glassMaterial);
    cabin.position.set(0, 0.73, -0.3);
    cabin.scale.set(0.94, 1, 0.9);
    cabin.castShadow = true;
    this.object.add(cabin);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.38, 0.12, 1.42), bodyMaterial);
    roof.position.set(0, 1.12, -0.35);
    roof.castShadow = true;
    this.object.add(roof);

    const bumperGeometry = new THREE.BoxGeometry(1.68, 0.18, 0.16);
    const frontBumper = new THREE.Mesh(bumperGeometry, darkMaterial);
    frontBumper.position.set(0, -0.18, 2.01);
    frontBumper.castShadow = true;
    this.object.add(frontBumper);
    const rearBumper = frontBumper.clone();
    rearBumper.position.z = -2.01;
    this.object.add(rearBumper);

    const lightGeometry = new THREE.BoxGeometry(0.34, 0.18, 0.08);
    const headlightMaterial = new THREE.MeshStandardMaterial({
      color: 0xffefb3,
      emissive: 0x4b421f,
    });
    for (const x of [-0.58, 0.58]) {
      const headlight = new THREE.Mesh(lightGeometry, headlightMaterial);
      headlight.position.set(x, 0.12, 1.99);
      this.object.add(headlight);
    }

    const wheelGeometry = new THREE.CylinderGeometry(
      VEHICLE_DIMENSIONS.wheelRadius,
      VEHICLE_DIMENSIONS.wheelRadius,
      VEHICLE_DIMENSIONS.wheelWidth,
      10,
    );
    const halfTrack = VEHICLE_DIMENSIONS.trackWidth / 2 + 0.08;
    const halfWheelBase = VEHICLE_DIMENSIONS.wheelBase / 2;
    for (const z of [halfWheelBase, -halfWheelBase]) {
      for (const x of [halfTrack, -halfTrack]) {
        const wheel = new THREE.Mesh(wheelGeometry, darkMaterial);
        wheel.position.set(x, -0.34, z);
        wheel.rotation.z = Math.PI / 2;
        wheel.castShadow = true;
        this.object.add(wheel);
        this.wheels.push(wheel);
      }
    }
  }
}

function cloneSnapshot(state: VehicleStateSnapshot): VehicleStateSnapshot {
  return {
    ...state,
    position: [...state.position],
    rotation: [...state.rotation],
    linearVelocity: [...state.linearVelocity],
    angularVelocity: [...state.angularVelocity],
    trailerRelativePosition: [...state.trailerRelativePosition],
  };
}

function copySnapshot(source: VehicleStateSnapshot, target: VehicleStateSnapshot): void {
  target.playerId = source.playerId;
  target.lastProcessedInputSequence = source.lastProcessedInputSequence;
  target.position.splice(0, 3, ...source.position);
  target.rotation.splice(0, 4, ...source.rotation);
  target.linearVelocity.splice(0, 3, ...source.linearVelocity);
  target.angularVelocity.splice(0, 3, ...source.angularVelocity);
  target.forwardSpeed = source.forwardSpeed;
  target.lateralSpeed = source.lateralSpeed;
  target.grounded = source.grounded;
  target.surfaceType = source.surfaceType;
  target.onTrailer = source.onTrailer;
  target.relativeForwardSpeed = source.relativeForwardSpeed;
  target.relativeLateralSpeed = source.relativeLateralSpeed;
  target.wheelContacts = source.wheelContacts;
  target.trailerDeckContacts = source.trailerDeckContacts;
  target.trailerRelativePosition.splice(0, 3, ...source.trailerRelativePosition);
  target.flipped = source.flipped;
  target.selfRightAvailable = source.selfRightAvailable;
  target.ramSlideRemainingTicks = source.ramSlideRemainingTicks;
}

function lerpTuple(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  alpha: number,
  target: [number, number, number],
): void {
  target[0] = lerp(from[0], to[0], alpha);
  target[1] = lerp(from[1], to[1], alpha);
  target[2] = lerp(from[2], to[2], alpha);
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

function applyAngularExtrapolationToSnapshot(
  state: VehicleStateSnapshot,
  seconds: number,
  angularAxis: THREE.Vector3,
  rotation: THREE.Quaternion,
  delta: THREE.Quaternion,
): void {
  angularAxis.fromArray(state.angularVelocity);
  const angularSpeed = angularAxis.length();
  if (angularSpeed < 1e-5) return;
  angularAxis.multiplyScalar(1 / angularSpeed);
  delta.setFromAxisAngle(angularAxis, angularSpeed * seconds);
  rotation.fromArray(state.rotation);
  rotation.premultiply(delta).normalize().toArray(state.rotation);
}

function colorFromPlayerId(playerId: string): THREE.Color {
  let hash = 2_166_136_261;
  for (let index = 0; index < playerId.length; index += 1) {
    hash ^= playerId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const hue = ((hash >>> 0) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.55, 0.68);
}
