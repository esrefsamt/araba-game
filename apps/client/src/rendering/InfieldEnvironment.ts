import { INFIELD_LAYOUT, getInfieldTransform } from '@trailer-arena/shared';
import type { InfieldElement } from '@trailer-arena/shared';
import * as THREE from 'three';

/** Shared positions and solid primitive dimensions; batched client presentation. */
export class InfieldEnvironment {
  public readonly group = new THREE.Group();

  public constructor() {
    this.group.name = 'infield-service-facility';
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const canopy = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4);
    canopy.rotateY(Math.PI / 4);
    const geometries = {
      box: new THREE.BoxGeometry(1, 1, 1),
      cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
      canopy,
    };
    const transform = new THREE.Object3D();
    for (const kind of ['box', 'cylinder', 'canopy'] as const) {
      const elements = INFIELD_LAYOUT.filter((element) => element.geometry === kind);
      const mesh = new THREE.InstancedMesh(geometries[kind], material, elements.length);
      mesh.name = `infield-${kind}`;
      mesh.userData.elementIds = elements.map((element) => element.id);
      mesh.userData.collisionElementIds = elements
        .filter((element) => element.collision)
        .map((element) => element.id);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      elements.forEach((element, index) => {
        const { position, rotation, size } = getInfieldTransform(element);
        transform.position.fromArray(position);
        transform.quaternion.fromArray(rotation);
        transform.scale.fromArray(size);
        transform.updateMatrix();
        mesh.setMatrixAt(index, transform.matrix);
        mesh.setColorAt(index, new THREE.Color(element.color));
      });
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }
    this.addSigns(INFIELD_LAYOUT.filter((element) => element.geometry === 'sign'));
  }

  private addSigns(elements: readonly InfieldElement[]): void {
    let map: THREE.CanvasTexture | undefined;
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = 2048;
      canvas.height = 1024;
      const context = canvas.getContext('2d');
      if (context !== null) {
        elements.forEach((element, index) => {
          const x = (index % 4) * 512;
          const y = Math.floor(index / 4) * 128;
          context.fillStyle = '#253c46';
          context.fillRect(x, y, 512, 128);
          context.fillStyle = '#e9bb60';
          context.fillRect(x, y + 115, 512, 13);
          context.fillStyle = '#f7ead0';
          context.font = '900 54px system-ui, sans-serif';
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.fillText(element.text ?? '', x + 256, y + 59, 486);
        });
        map = new THREE.CanvasTexture(canvas);
        map.colorSpace = THREE.SRGBColorSpace;
      }
    }
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const transform = new THREE.Object3D();
    const vertex = new THREE.Vector3();
    elements.forEach((element, index) => {
      const { position, rotation, size } = getInfieldTransform(element);
      transform.position.fromArray(position);
      transform.quaternion.fromArray(rotation);
      transform.scale.fromArray(size);
      transform.updateMatrix();
      const u = (index % 4) / 4;
      const v = 1 - (Math.floor(index / 4) + 1) / 8;
      // Four face corners with atlas UVs. Signs are merged into one draw call.
      for (const [x, y] of [
        [-0.5, -0.5],
        [0.5, -0.5],
        [0.5, 0.5],
        [-0.5, 0.5],
      ]) {
        vertex.set(x!, y!, 0).applyMatrix4(transform.matrix);
        positions.push(vertex.x, vertex.y, vertex.z);
        uvs.push(u + (x! + 0.5) / 4, v + (y! + 0.5) / 8);
      }
      const base = index * 4;
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        ...(map === undefined ? { color: 0x253c46 } : { map }),
        side: THREE.DoubleSide,
      }),
    );
    mesh.name = 'infield-sign-atlas';
    this.group.add(mesh);
  }
}
