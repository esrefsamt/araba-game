import {
  TRAILER_DIMENSIONS,
  TRAILER_RAMP_ANGLE,
  TRAILER_RAMP_GEOMETRY,
} from '@trailer-arena/shared';
import type { RigidBodyStateSnapshot } from '@trailer-arena/shared';
import * as THREE from 'three';

import { SnapshotBuffer } from '../networking/SnapshotBuffer.js';

export class TrailerView {
  public readonly object = new THREE.Group();
  private readonly snapshots = new SnapshotBuffer<RigidBodyStateSnapshot>();
  private readonly fromPosition = new THREE.Vector3();
  private readonly toPosition = new THREE.Vector3();
  private readonly fromRotation = new THREE.Quaternion();
  private readonly toRotation = new THREE.Quaternion();

  public constructor(scene: THREE.Scene) {
    this.object.name = 'convoy-trailer';
    this.object.visible = false;
    this.buildModel();
    scene.add(this.object);
  }

  public addSnapshot(serverTick: number, snapshot: RigidBodyStateSnapshot): void {
    this.object.visible = true;
    this.snapshots.add(serverTick, snapshot);
  }

  public update(renderTick: number): void {
    const sample = this.snapshots.getSample(renderTick);
    if (sample === null) return;
    this.fromPosition.fromArray(sample.from.position);
    this.toPosition.fromArray(sample.to.position);
    this.object.position.lerpVectors(this.fromPosition, this.toPosition, sample.alpha);
    this.fromRotation.fromArray(sample.from.rotation);
    this.toRotation.fromArray(sample.to.rotation);
    this.object.quaternion.slerpQuaternions(
      this.fromRotation,
      this.toRotation,
      sample.alpha,
    );
  }

  public clear(): void {
    this.snapshots.clear();
    this.object.visible = false;
  }

  public writeRenderedPosition(output: [number, number, number]): void {
    output[0] = this.object.position.x;
    output[1] = this.object.position.y;
    output[2] = this.object.position.z;
  }

  public dispose(scene: THREE.Scene): void {
    scene.remove(this.object);
    this.object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (Array.isArray(child.material))
          child.material.forEach((item) => item.dispose());
        else child.material.dispose();
      }
    });
  }

  private buildModel(): void {
    const deckMaterial = new THREE.MeshStandardMaterial({
      color: 0xe4c98f,
      roughness: 0.88,
      flatShading: true,
    });
    const frameMaterial = new THREE.MeshStandardMaterial({
      color: 0x48575b,
      roughness: 0.86,
      flatShading: true,
    });
    const tireMaterial = new THREE.MeshStandardMaterial({
      color: 0x273338,
      roughness: 0.95,
      flatShading: true,
    });
    const plankMaterials = [0xe9cf98, 0xddbd7e, 0xf0d8a6].map(
      (color) =>
        new THREE.MeshStandardMaterial({ color, roughness: 0.92, flatShading: true }),
    );
    const warningMaterial = new THREE.MeshStandardMaterial({
      color: 0xf2c55f,
      roughness: 0.78,
      flatShading: true,
    });
    addBox(
      this.object,
      [
        TRAILER_DIMENSIONS.deckWidth,
        TRAILER_DIMENSIONS.deckThickness,
        TRAILER_DIMENSIONS.deckLength,
      ],
      [0, TRAILER_DIMENSIONS.deckHeight, 0],
      deckMaterial,
    );
    const plankWidth = (TRAILER_DIMENSIONS.deckWidth - 0.3) / 9;
    for (let index = 0; index < 9; index += 1) {
      addBox(
        this.object,
        [plankWidth - 0.035, 0.028, TRAILER_DIMENSIONS.deckLength - 0.22],
        [
          -TRAILER_DIMENSIONS.deckWidth / 2 + 0.15 + plankWidth * (index + 0.5),
          TRAILER_DIMENSIONS.deckHeight + TRAILER_DIMENSIONS.deckThickness / 2 + 0.015,
          0,
        ],
        plankMaterials[index % plankMaterials.length]!,
      );
    }
    const ramp = addBox(
      this.object,
      [
        TRAILER_DIMENSIONS.deckWidth - 0.16,
        TRAILER_DIMENSIONS.rampThickness,
        TRAILER_DIMENSIONS.rampLength,
      ],
      [0, TRAILER_RAMP_GEOMETRY.centerY, TRAILER_RAMP_GEOMETRY.centerZ],
      deckMaterial,
    );
    ramp.rotation.x = -TRAILER_RAMP_ANGLE;
    for (const x of [-2.5, 0, 2.5]) {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, 0.025, TRAILER_DIMENSIONS.rampLength - 0.28),
        warningMaterial,
      );
      stripe.position.set(x, TRAILER_DIMENSIONS.rampThickness / 2 + 0.018, 0);
      stripe.castShadow = false;
      ramp.add(stripe);
    }

    const lipY =
      TRAILER_DIMENSIONS.deckHeight +
      TRAILER_DIMENSIONS.deckThickness / 2 +
      TRAILER_DIMENSIONS.sideLipHeight / 2;
    const lipX =
      TRAILER_DIMENSIONS.deckWidth / 2 - TRAILER_DIMENSIONS.sideLipThickness / 2;
    for (const x of [-lipX, lipX]) {
      addBox(
        this.object,
        [
          TRAILER_DIMENSIONS.sideLipThickness,
          TRAILER_DIMENSIONS.sideLipHeight,
          TRAILER_DIMENSIONS.deckLength,
        ],
        [x, lipY, 0],
        frameMaterial,
      );
    }
    addBox(
      this.object,
      [
        TRAILER_DIMENSIONS.deckWidth,
        TRAILER_DIMENSIONS.frontBarrierHeight,
        TRAILER_DIMENSIONS.frontBarrierThickness,
      ],
      [
        0,
        TRAILER_DIMENSIONS.deckHeight +
          TRAILER_DIMENSIONS.deckThickness / 2 +
          TRAILER_DIMENSIONS.frontBarrierHeight / 2,
        TRAILER_DIMENSIONS.deckLength / 2 - TRAILER_DIMENSIONS.frontBarrierThickness / 2,
      ],
      frameMaterial,
    );
    for (const z of [-6.2, -2.2, 1.8, 5.8]) {
      addBox(
        this.object,
        [TRAILER_DIMENSIONS.deckWidth - 0.45, 0.16, 0.24],
        [0, TRAILER_DIMENSIONS.deckHeight - 0.34, z],
        frameMaterial,
      );
    }
    addBox(this.object, [1.1, 0.5, 1.6], [0, 0.68, 8.8], frameMaterial);
    addBox(
      this.object,
      [
        TRAILER_DIMENSIONS.underbodyWidth,
        TRAILER_DIMENSIONS.underbodyHeight,
        TRAILER_DIMENSIONS.underbodyLength,
      ],
      [0, TRAILER_DIMENSIONS.underbodyCenterY, TRAILER_DIMENSIONS.underbodyCenterZ],
      frameMaterial,
    );
    const couplingRailLength = Math.hypot(2.5, 2.1);
    const couplingRailYaw = Math.atan2(2.5, -2.1);
    for (const side of [-1, 1]) {
      const rail = addBox(
        this.object,
        [0.36, 0.56, couplingRailLength],
        [side * 1.75, 0.68, 8.45],
        frameMaterial,
      );
      rail.rotation.y = side * couplingRailYaw;
    }

    const wheelGeometry = new THREE.CylinderGeometry(
      TRAILER_DIMENSIONS.wheelRadius,
      TRAILER_DIMENSIONS.wheelRadius,
      0.38,
      10,
    );
    for (const z of [2.8, 4.4]) {
      for (const x of [-3.52, 3.52]) {
        const wheel = new THREE.Mesh(wheelGeometry, tireMaterial);
        wheel.position.set(x, TRAILER_DIMENSIONS.wheelRadius, z);
        wheel.rotation.z = Math.PI / 2;
        wheel.castShadow = true;
        this.object.add(wheel);
      }
    }
    const tailLightMaterial = new THREE.MeshStandardMaterial({
      color: 0xe85d62,
      emissive: 0x4e1415,
      emissiveIntensity: 0.8,
    });
    for (const x of [-2.75, 2.75]) {
      addBox(
        this.object,
        [0.42, 0.24, 0.12],
        [x, 0.72, -TRAILER_DIMENSIONS.deckLength / 2 - 0.05],
        tailLightMaterial,
      );
    }
  }
}

function addBox(
  parent: THREE.Group,
  size: readonly [number, number, number],
  position: readonly [number, number, number],
  material: THREE.Material,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
