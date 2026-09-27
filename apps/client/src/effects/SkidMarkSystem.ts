import * as THREE from 'three';

interface SkidSlot {
  readonly mesh: THREE.Mesh;
  age: number;
}

export class SkidMarkSystem {
  private readonly slots: SkidSlot[] = [];
  private readonly geometry = new THREE.PlaneGeometry(0.18, 1.05);
  private cursor = 0;

  public constructor(
    private readonly scene: THREE.Scene,
    public readonly capacity = 96,
  ) {
    for (let index = 0; index < capacity; index += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: 0x29353a,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      });
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      scene.add(mesh);
      this.slots.push({ mesh, age: 0 });
    }
  }

  public add(
    position: readonly [number, number, number],
    headingRadians: number,
    intensity: number,
  ): void {
    const slot = this.slots[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.capacity;
    slot.mesh.position.set(position[0], 0.025, position[2]);
    slot.mesh.rotation.z = -headingRadians;
    slot.mesh.visible = true;
    slot.age = 0;
    (slot.mesh.material as THREE.MeshBasicMaterial).opacity =
      0.1 + Math.min(1, Math.max(0, intensity)) * 0.32;
  }

  public update(deltaSeconds: number): void {
    for (const slot of this.slots) {
      if (!slot.mesh.visible) continue;
      slot.age += Math.max(0, deltaSeconds);
      if (slot.age > 12) {
        slot.mesh.visible = false;
        continue;
      }
      const material = slot.mesh.material as THREE.MeshBasicMaterial;
      if (slot.age > 8) material.opacity *= Math.exp(-1.8 * deltaSeconds);
    }
  }

  public get activeCount(): number {
    return this.slots.reduce((count, slot) => count + Number(slot.mesh.visible), 0);
  }

  public dispose(): void {
    for (const slot of this.slots) {
      this.scene.remove(slot.mesh);
      (slot.mesh.material as THREE.Material).dispose();
    }
    this.geometry.dispose();
  }
}
