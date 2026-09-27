import { TRUCK_DIMENSIONS } from '@trailer-arena/shared';
import type { RigidBodyStateSnapshot } from '@trailer-arena/shared';
import * as THREE from 'three';

import { SnapshotBuffer } from '../networking/SnapshotBuffer.js';

export class TruckView {
  public readonly object = new THREE.Group();
  private readonly snapshots = new SnapshotBuffer<RigidBodyStateSnapshot>();
  private readonly fromPosition = new THREE.Vector3();
  private readonly toPosition = new THREE.Vector3();
  private readonly fromRotation = new THREE.Quaternion();
  private readonly toRotation = new THREE.Quaternion();

  public constructor(scene: THREE.Scene) {
    this.object.name = 'convoy-truck';
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

  public dispose(scene: THREE.Scene): void {
    disposeObject(scene, this.object);
  }

  private buildModel(): void {
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0xe58f84,
      roughness: 0.74,
      flatShading: true,
    });
    const darkMaterial = new THREE.MeshStandardMaterial({
      color: 0x29363b,
      roughness: 0.9,
      flatShading: true,
    });
    const glassMaterial = new THREE.MeshStandardMaterial({
      color: 0x86b9c5,
      roughness: 0.3,
      metalness: 0.1,
      flatShading: true,
    });
    const grilleMaterial = new THREE.MeshStandardMaterial({
      color: 0x77888b,
      roughness: 0.52,
      metalness: 0.42,
      flatShading: true,
    });
    const lightMaterial = new THREE.MeshStandardMaterial({
      color: 0xffedb5,
      emissive: 0x594514,
      emissiveIntensity: 0.8,
    });
    addBox(
      this.object,
      [TRUCK_DIMENSIONS.width, 1.1, TRUCK_DIMENSIONS.length],
      [0, 0.75, 0],
      bodyMaterial,
    );
    addBox(this.object, [2.8, 2.5, 3.3], [0, 2, 1.15], bodyMaterial);
    const windshield = addBox(
      this.object,
      [2.46, 0.9, 0.08],
      [0, 2.38, 2.82],
      glassMaterial,
    );
    windshield.rotation.x = -0.06;
    for (const x of [-1.415, 1.415]) {
      addBox(this.object, [0.06, 0.82, 1.25], [x, 2.24, 1.4], glassMaterial);
      addBox(this.object, [0.12, 0.1, 0.74], [x * 1.08, 2.3, 2.15], darkMaterial);
    }
    addBox(this.object, [2.8, 0.3, 0.3], [0, 0.55, 3.5], darkMaterial);
    addBox(this.object, [1.9, 0.6, 1.4], [0, 0.7, -3.65], darkMaterial);
    addBox(this.object, [2.25, 0.72, 0.12], [0, 1.28, 2.84], grilleMaterial);
    for (const x of [-0.78, 0.78]) {
      addBox(this.object, [0.48, 0.27, 0.1], [x, 0.94, 2.9], lightMaterial);
    }
    for (let index = -2; index <= 2; index += 1) {
      addBox(this.object, [0.12, 0.52, 0.08], [index * 0.34, 1.3, 2.91], darkMaterial);
    }
    addBox(this.object, [2.25, 0.25, 3.4], [0, 1.25, -2.05], darkMaterial);

    const exhaustGeometry = new THREE.CylinderGeometry(0.11, 0.14, 2.35, 8);
    for (const x of [-1.22, 1.22]) {
      const exhaust = new THREE.Mesh(exhaustGeometry, grilleMaterial);
      exhaust.position.set(x, 2.02, -0.7);
      exhaust.castShadow = true;
      this.object.add(exhaust);
    }

    const wheelGeometry = new THREE.CylinderGeometry(
      TRUCK_DIMENSIONS.wheelRadius,
      TRUCK_DIMENSIONS.wheelRadius,
      0.38,
      10,
    );
    for (const z of [-2.85, -1.65, 2.25]) {
      for (const x of [-1.52, 1.52]) {
        const wheel = new THREE.Mesh(wheelGeometry, darkMaterial);
        wheel.position.set(x, 0.68, z);
        wheel.rotation.z = Math.PI / 2;
        wheel.castShadow = true;
        this.object.add(wheel);
      }
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

function disposeObject(scene: THREE.Scene, object: THREE.Object3D): void {
  scene.remove(object);
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) child.material.forEach((item) => item.dispose());
      else child.material.dispose();
    }
  });
}
