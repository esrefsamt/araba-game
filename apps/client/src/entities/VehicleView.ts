import {
  REMOTE_EXTRAPOLATION_MAX_TICKS,
  SIMULATION_TICK_RATE,
  VEHICLE_DIMENSIONS,
} from '@trailer-arena/shared';
import type { VehicleStateSnapshot } from '@trailer-arena/shared';
import * as THREE from 'three';

import { SnapshotBuffer } from '../networking/SnapshotBuffer.js';
import { playerColorHex } from '../visuals/PlayerPalette.js';
import { WheelVisualKinematics } from './WheelVisualKinematics.js';

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
  private readonly wheelSpins: THREE.Group[] = [];
  private readonly wheelPivots: THREE.Group[] = [];
  private readonly frontWheelPivots: THREE.Group[] = [];
  private readonly wheelMotion = new WheelVisualKinematics();
  private wheelSteeringInput: number | null = null;
  private nameplate: THREE.Sprite | null = null;
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
    this.animateWheels(state, deltaSeconds);
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

  public setPlayerIdentity(playerName: string, isLocal: boolean): void {
    if (isLocal) {
      if (this.nameplate !== null) this.nameplate.visible = false;
      return;
    }
    if (this.nameplate === null && typeof document !== 'undefined') {
      this.nameplate = createNameplate(playerName, playerColorHex(this.playerId));
      this.object.add(this.nameplate);
    }
    if (this.nameplate !== null) this.nameplate.visible = true;
  }

  public updateNameplate(cameraPosition: THREE.Vector3): void {
    if (this.nameplate === null) return;
    const distance = cameraPosition.distanceTo(this.object.position);
    this.nameplate.visible = distance < 52;
    (this.nameplate.material as THREE.SpriteMaterial).opacity = THREE.MathUtils.clamp(
      1 - (distance - 22) / 30,
      0,
      1,
    );
  }

  public setWheelSteeringInput(input: number | null): void {
    this.wheelSteeringInput = input;
  }

  private animateWheels(state: VehicleStateSnapshot, deltaSeconds: number): void {
    // On a moving trailer, use motion relative to the support rather than spinning
    // parked wheels at the convoy's world speed. Lateral RAM velocity is excluded.
    const longitudinalSpeed = state.onTrailer
      ? state.relativeForwardSpeed
      : state.forwardSpeed;
    this.wheelMotion.update(
      longitudinalSpeed,
      this.wheelSteeringInput,
      state.wheelContacts,
      deltaSeconds,
    );
    for (const spin of this.wheelSpins) spin.rotation.x = this.wheelMotion.spin;
    for (const pivot of this.frontWheelPivots) {
      pivot.rotation.y = this.wheelMotion.steering;
    }
    for (const pivot of this.wheelPivots) {
      pivot.position.y = this.wheelMotion.centerY;
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
    this.animateWheels(state, deltaSeconds);
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
      } else if (child instanceof THREE.Sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      }
    });
  }

  private buildModel(): void {
    const bodyColor = playerColorHex(this.playerId);
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
      color: 0x8ebbc8,
      roughness: 0.35,
      metalness: 0.12,
      flatShading: true,
    });
    const chromeMaterial = new THREE.MeshStandardMaterial({
      color: 0xc7d2cf,
      roughness: 0.45,
      metalness: 0.4,
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
    body.scale.set(1, 0.88, 0.98);
    body.position.y = 0.02;
    body.castShadow = true;
    body.receiveShadow = true;
    this.object.add(body);

    const hood = new THREE.Mesh(new THREE.BoxGeometry(1.58, 0.26, 1.24), bodyMaterial);
    hood.position.set(0, 0.43, 1.12);
    hood.castShadow = true;
    this.object.add(hood);

    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.48, 0.72, 1.58), glassMaterial);
    cabin.position.set(0, 0.75, -0.33);
    cabin.scale.set(0.94, 1, 0.9);
    cabin.castShadow = true;
    this.object.add(cabin);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.38, 0.12, 1.42), bodyMaterial);
    roof.position.set(0, 1.12, -0.35);
    roof.castShadow = true;
    this.object.add(roof);

    const windshield = new THREE.Mesh(
      new THREE.BoxGeometry(1.24, 0.46, 0.045),
      glassMaterial,
    );
    windshield.position.set(0, 0.78, 0.39);
    windshield.rotation.x = -0.16;
    this.object.add(windshield);
    for (const x of [-0.755, 0.755]) {
      const sideWindow = new THREE.Mesh(
        new THREE.BoxGeometry(0.045, 0.4, 0.82),
        glassMaterial,
      );
      sideWindow.position.set(x, 0.8, -0.34);
      this.object.add(sideWindow);
    }

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

    const tailMaterial = new THREE.MeshStandardMaterial({
      color: 0xe65f62,
      emissive: 0x521414,
      emissiveIntensity: 0.7,
    });
    for (const x of [-0.61, 0.61]) {
      const taillight = new THREE.Mesh(lightGeometry, tailMaterial);
      taillight.position.set(x, 0.09, -1.99);
      this.object.add(taillight);
    }

    const roofDetail = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.11, 0.28),
      chromeMaterial,
    );
    roofDetail.position.set(0, 1.235, -0.42);
    this.object.add(roofDetail);

    const archGeometry = new THREE.TorusGeometry(0.46, 0.085, 5, 10, Math.PI);
    for (const z of [
      VEHICLE_DIMENSIONS.wheelBase / 2,
      -VEHICLE_DIMENSIONS.wheelBase / 2,
    ]) {
      for (const x of [-0.92, 0.92]) {
        const arch = new THREE.Mesh(archGeometry, bodyMaterial);
        arch.position.set(x, -0.11, z);
        arch.rotation.y = Math.PI / 2;
        this.object.add(arch);
      }
    }

    const wheelGeometry = new THREE.CylinderGeometry(
      VEHICLE_DIMENSIONS.wheelRadius,
      VEHICLE_DIMENSIONS.wheelRadius,
      VEHICLE_DIMENSIONS.wheelWidth,
      10,
    );
    const halfTrack = VEHICLE_DIMENSIONS.trackWidth / 2 + 0.08;
    const halfWheelBase = VEHICLE_DIMENSIONS.wheelBase / 2;
    const spokeGeometry = new THREE.BoxGeometry(
      0.025,
      VEHICLE_DIMENSIONS.wheelRadius * 1.4,
      0.07,
    );
    for (const z of [halfWheelBase, -halfWheelBase]) {
      for (const x of [halfTrack, -halfTrack]) {
        const pivot = new THREE.Group();
        pivot.name = `wheel-steer-${z > 0 ? 'front' : 'rear'}-${x > 0 ? 'right' : 'left'}`;
        pivot.position.set(x, this.wheelMotion.centerY, z);
        const spin = new THREE.Group();
        spin.name = 'wheel-spin';
        const wheel = new THREE.Mesh(wheelGeometry, darkMaterial);
        wheel.name = 'wheel-mesh';
        // Cylinder's native +Y axle is aligned to +X once, below both pivots.
        wheel.rotation.z = -Math.PI / 2;
        wheel.castShadow = true;
        const spoke = new THREE.Mesh(spokeGeometry, chromeMaterial);
        spoke.position.x = Math.sign(x) * (VEHICLE_DIMENSIONS.wheelWidth / 2 + 0.014);
        spoke.name = 'wheel-spoke';
        spin.add(wheel, spoke);
        pivot.add(spin);
        this.object.add(pivot);
        this.wheelPivots.push(pivot);
        if (z > 0) this.frontWheelPivots.push(pivot);
        this.wheelSpins.push(spin);
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

function createNameplate(playerName: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (context !== null) {
    context.fillStyle = 'rgba(28, 41, 48, 0.82)';
    context.beginPath();
    context.roundRect(4, 6, 248, 50, 18);
    context.fill();
    context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    context.fillRect(14, 20, 8, 22);
    context.fillStyle = '#f6fbfa';
    context.font = '700 24px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(playerName.slice(0, 16), 137, 32, 205);
  }
  const material = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas),
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.position.set(0, 2.05, 0);
  sprite.scale.set(3.2, 0.8, 1);
  sprite.renderOrder = 10;
  return sprite;
}
