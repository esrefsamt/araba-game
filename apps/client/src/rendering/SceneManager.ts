import {
  OVAL_TRACK_LAYOUT,
  STATIC_WORLD_BOXES,
  getTrackCenterlinePoint,
  getTrackOffsetPoint,
} from '@trailer-arena/shared';
import * as THREE from 'three';

export class SceneManager {
  public readonly scene = new THREE.Scene();

  public constructor() {
    this.scene.background = new THREE.Color(0xc9e7f2);
    this.scene.fog = new THREE.Fog(0xc9e7f2, 95, 210);
    this.addLights();
    this.addEnvironment();
  }

  public update(_elapsedSeconds: number): void {
    // Visual-only environmental animation can be added here later.
  }

  private addLights(): void {
    const hemisphere = new THREE.HemisphereLight(0xe5f7ff, 0x738a68, 2.1);
    this.scene.add(hemisphere);

    const sun = new THREE.DirectionalLight(0xfff0d6, 3.4);
    sun.position.set(-18, 30, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1_024, 1_024);
    sun.shadow.camera.left = -95;
    sun.shadow.camera.right = 95;
    sun.shadow.camera.top = 65;
    sun.shadow.camera.bottom = -65;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 150;
    sun.shadow.bias = -0.0002;
    this.scene.add(sun);
  }

  private addEnvironment(): void {
    this.addPhysicalWorldGeometry();

    const trackMaterial = new THREE.MeshStandardMaterial({
      color: 0x596b73,
      roughness: 0.92,
      metalness: 0,
      flatShading: true,
    });
    const track = new THREE.Mesh(this.createTrackGeometry(), trackMaterial);
    track.receiveShadow = true;
    this.scene.add(track);

    this.addTrackMarkers();
    this.addScenery();
  }

  private createTrackGeometry(): THREE.BufferGeometry {
    const segmentCount = 160;
    const halfWidth = OVAL_TRACK_LAYOUT.trackWidth / 2;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let index = 0; index <= segmentCount; index += 1) {
      const progress = index / segmentCount;
      const left = getTrackOffsetPoint(progress, halfWidth);
      const right = getTrackOffsetPoint(progress, -halfWidth);
      positions.push(left[0], 0.012, left[2], right[0], 0.012, right[2]);
      uvs.push(0, progress * 12, 1, progress * 12);
      if (index < segmentCount) {
        const base = index * 2;
        indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  private addPhysicalWorldGeometry(): void {
    const materials = {
      ground: new THREE.MeshLambertMaterial({ color: 0x9dcf9a }),
      boundary: new THREE.MeshStandardMaterial({
        color: 0xe7d6ad,
        roughness: 0.85,
        flatShading: true,
      }),
      ramp: new THREE.MeshStandardMaterial({
        color: 0xd18d72,
        roughness: 0.88,
        flatShading: true,
      }),
      barrier: new THREE.MeshStandardMaterial({
        color: 0xe6a981,
        roughness: 0.82,
        flatShading: true,
      }),
    } as const;

    for (const box of STATIC_WORLD_BOXES) {
      const [halfX, halfY, halfZ] = box.halfExtents;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(halfX * 2, halfY * 2, halfZ * 2),
        materials[box.kind],
      );
      mesh.name = box.id;
      mesh.position.fromArray(box.position);
      mesh.quaternion.fromArray(box.rotation);
      mesh.receiveShadow = true;
      mesh.castShadow = box.kind !== 'ground';
      this.scene.add(mesh);
    }
  }

  private addTrackMarkers(): void {
    const markerGeometry = new THREE.BoxGeometry(1.4, 0.04, 0.16);
    const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xf5e9c8 });

    for (let index = 0; index < 64; index += 1) {
      const sample = getTrackCenterlinePoint(index / 64);
      const marker = new THREE.Mesh(markerGeometry, markerMaterial);
      marker.position.set(sample.position[0], 0.055, sample.position[2]);
      marker.rotation.y = Math.atan2(-sample.tangent[2], sample.tangent[0]);
      this.scene.add(marker);
    }
  }

  private addScenery(): void {
    const trunkGeometry = new THREE.CylinderGeometry(0.22, 0.28, 1.25, 6);
    const trunkMaterial = new THREE.MeshLambertMaterial({ color: 0xa87962 });
    const crownGeometry = new THREE.ConeGeometry(1.15, 2.7, 7);
    const crownMaterials = [
      new THREE.MeshLambertMaterial({ color: 0x6da884, flatShading: true }),
      new THREE.MeshLambertMaterial({ color: 0x79b592, flatShading: true }),
      new THREE.MeshLambertMaterial({ color: 0x5f9a77, flatShading: true }),
    ];
    const positions = [
      [-79, -45],
      [-74, 46],
      [-48, 47],
      [76, -46],
      [80, 28],
      [53, 47],
      [-12, 48],
      [14, -48],
    ] as const;

    positions.forEach(([x, z], index) => {
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
      trunk.position.y = 0.62;
      trunk.castShadow = true;
      const crown = new THREE.Mesh(
        crownGeometry,
        crownMaterials[index % crownMaterials.length],
      );
      crown.position.y = 2.25;
      crown.castShadow = true;
      tree.add(trunk, crown);
      tree.position.set(x, 0, z);
      tree.rotation.y = index * 0.71;
      this.scene.add(tree);
    });
  }
}
