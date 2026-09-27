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
    addBox(
      this.object,
      [TRUCK_DIMENSIONS.width, 1.1, TRUCK_DIMENSIONS.length],
      [0, 0.75, 0],
      bodyMaterial,
    );
    addBox(this.object, [2.8, 2.5, 3.3], [0, 2, 1.15], bodyMaterial);
    addBox(this.object, [2.48, 0.95, 0.08], [0, 2.35, 2.82], glassMaterial);
    addBox(this.object, [2.8, 0.3, 0.3], [0, 0.55, 3.5], darkMaterial);
    addBox(this.object, [1.9, 0.6, 1.4], [0, 0.7, -3.65], darkMaterial);

    const wheelGeometry = new THREE.CylinderGeometry(
      TRUCK_DIMENSIONS.wheelRadius,
      TRUCK_DIMENSIONS.wheelRadius,
      0.38,
      10,
    );
    for (const z of [-2.25, 2.25]) {
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
): void {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
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
