import * as THREE from 'three';

interface ParticleSlot {
  readonly mesh: THREE.Mesh;
  readonly velocity: THREE.Vector3;
  lifetime: number;
  remaining: number;
}

export interface ParticlePoolStyle {
  readonly color: number;
  readonly size: number;
  readonly gravity: number;
}

export class ParticlePool {
  private readonly slots: ParticleSlot[] = [];
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private cursor = 0;

  public constructor(
    private readonly scene: THREE.Scene,
    public readonly capacity: number,
    private readonly style: ParticlePoolStyle,
  ) {
    this.geometry = new THREE.TetrahedronGeometry(style.size, 0);
    this.material = new THREE.MeshBasicMaterial({
      color: style.color,
      transparent: true,
      depthWrite: false,
      opacity: 0.9,
    });
    for (let index = 0; index < capacity; index += 1) {
      const mesh = new THREE.Mesh(this.geometry, this.material.clone());
      mesh.visible = false;
      mesh.frustumCulled = true;
      scene.add(mesh);
      this.slots.push({
        mesh,
        velocity: new THREE.Vector3(),
        lifetime: 0,
        remaining: 0,
      });
    }
  }

  public burst(
    position: readonly [number, number, number],
    count: number,
    strength: number,
    seed = 0,
  ): void {
    const boundedCount = Math.min(this.capacity, Math.max(0, Math.floor(count)));
    for (let index = 0; index < boundedCount; index += 1) {
      const slot = this.slots[this.cursor]!;
      this.cursor = (this.cursor + 1) % this.capacity;
      const angle = hashUnit(seed + index * 3) * Math.PI * 2;
      const spread = 0.8 + hashUnit(seed + index * 3 + 1) * 1.8;
      const lift = 0.35 + hashUnit(seed + index * 3 + 2) * 1.1;
      slot.mesh.position.set(...position);
      slot.mesh.rotation.set(angle, angle * 0.7, angle * 0.3);
      slot.velocity.set(
        Math.cos(angle) * spread * strength,
        lift * strength,
        Math.sin(angle) * spread * strength,
      );
      slot.lifetime = 0.28 + hashUnit(seed + index + 17) * 0.3;
      slot.remaining = slot.lifetime;
      slot.mesh.visible = true;
      slot.mesh.scale.setScalar(0.7 + hashUnit(seed + index + 29) * 0.65);
      (slot.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9;
    }
  }

  public update(deltaSeconds: number): void {
    const dt = Math.min(0.05, Math.max(0, deltaSeconds));
    for (const slot of this.slots) {
      if (slot.remaining <= 0) continue;
      slot.remaining -= dt;
      if (slot.remaining <= 0) {
        slot.mesh.visible = false;
        continue;
      }
      slot.velocity.y -= this.style.gravity * dt;
      slot.mesh.position.addScaledVector(slot.velocity, dt);
      slot.mesh.rotation.x += dt * 7;
      slot.mesh.rotation.z += dt * 5;
      (slot.mesh.material as THREE.MeshBasicMaterial).opacity =
        0.9 * (slot.remaining / slot.lifetime);
    }
  }

  public get activeCount(): number {
    let count = 0;
    for (const slot of this.slots) if (slot.mesh.visible) count += 1;
    return count;
  }

  public dispose(): void {
    for (const slot of this.slots) {
      this.scene.remove(slot.mesh);
      (slot.mesh.material as THREE.Material).dispose();
    }
    this.geometry.dispose();
    this.material.dispose();
  }
}

function hashUnit(seed: number): number {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43_758.5453;
  return value - Math.floor(value);
}
