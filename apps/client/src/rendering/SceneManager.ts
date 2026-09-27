import {
  OVAL_TRACK_LAYOUT,
  STATIC_WORLD_BOXES,
  getTrackCenterlinePoint,
  getTrackOffsetPoint,
} from '@trailer-arena/shared';
import * as THREE from 'three';

import { MotorsportEnvironment } from './MotorsportEnvironment.js';

export class SceneManager {
  public readonly scene = new THREE.Scene();

  public constructor() {
    this.scene.background = new THREE.Color(0xcce8f2);
    this.scene.fog = new THREE.Fog(0xd5e9e7, 105, 225);
    this.addSky();
    this.addLights();
    this.addEnvironment();
  }

  private addSky(): void {
    const geometry = new THREE.SphereGeometry(205, 24, 12);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x82c7e3) },
        horizonColor: { value: new THREE.Color(0xe9f2df) },
      },
      vertexShader: `varying float vHeight; void main(){ vHeight = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 topColor; uniform vec3 horizonColor; varying float vHeight; void main(){ float blend = smoothstep(-0.12, 0.72, vHeight); gl_FragColor = vec4(mix(horizonColor, topColor, blend), 1.0); }`,
    });
    const sky = new THREE.Mesh(geometry, material);
    sky.name = 'pastel-sky-dome';
    this.scene.add(sky);
  }

  private addLights(): void {
    const hemisphere = new THREE.HemisphereLight(0xe8f8ff, 0x789468, 2.25);
    this.scene.add(hemisphere);

    const sun = new THREE.DirectionalLight(0xfff1d2, 3.2);
    sun.position.set(-24, 34, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2_048, 2_048);
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
      color: 0x424c51,
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
      ground: new THREE.MeshLambertMaterial({ color: 0x9aab79 }),
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
    const markers = new THREE.InstancedMesh(markerGeometry, markerMaterial, 64);
    const transform = new THREE.Object3D();
    for (let index = 0; index < 64; index += 1) {
      const sample = getTrackCenterlinePoint(index / 64);
      transform.position.set(sample.position[0], 0.055, sample.position[2]);
      transform.rotation.y = Math.atan2(-sample.tangent[2], sample.tangent[0]);
      transform.updateMatrix();
      markers.setMatrixAt(index, transform.matrix);
    }
    this.scene.add(markers);

    const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xf7e6bd });
    for (const offset of [
      -OVAL_TRACK_LAYOUT.trackWidth / 2 + 0.28,
      OVAL_TRACK_LAYOUT.trackWidth / 2 - 0.28,
    ]) {
      const points: THREE.Vector3[] = [];
      for (let index = 0; index <= 160; index += 1) {
        const point = getTrackOffsetPoint(index / 160, offset);
        points.push(new THREE.Vector3(point[0], 0.058, point[2]));
      }
      this.scene.add(
        new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), edgeMaterial),
      );
    }

    const start = getTrackCenterlinePoint(0);
    const tileGeometry = new THREE.BoxGeometry(0.8, 0.035, 0.8);
    const tiles = new THREE.InstancedMesh(
      tileGeometry,
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      40,
    );
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 20; column += 1) {
        transform.position.set(
          start.position[0] + row * 0.82,
          0.065,
          start.position[2] - 7.6 + column * 0.8,
        );
        transform.rotation.set(0, 0, 0);
        transform.updateMatrix();
        const index = row * 20 + column;
        tiles.setMatrixAt(index, transform.matrix);
        tiles.setColorAt(
          index,
          new THREE.Color((row + column) % 2 === 0 ? 0xf6efe0 : 0x35434a),
        );
      }
    }
    this.scene.add(tiles);
  }

  private addScenery(): void {
    this.scene.add(new MotorsportEnvironment().group);
  }
}
