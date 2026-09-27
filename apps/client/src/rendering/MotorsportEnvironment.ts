import { OVAL_TRACK_LAYOUT, getTrackOffsetPoint } from '@trailer-arena/shared';
import * as THREE from 'three';

import { InfieldEnvironment } from './InfieldEnvironment.js';

// Client presentation only. No Rapier bodies, sensors or shared world boxes.
export const VENUE_LAYOUT = {
  fenceSegments: 96,
  fenceHeight: 3.4,
  runoff: 10,
  mainStand: { x: 0, z: -58, width: 60, rows: 8, columns: 66, facing: 1 },
  secondaryStand: { x: 16, z: 58, width: 28, rows: 4, columns: 30, facing: -1 },
  spectatorBooths: [
    [-27, 62],
    [-18, 62],
    [-9, 62],
  ],
  serviceVehicles: [
    [-29, 8],
    [-29, 13],
    [-29, 18],
  ],
  billboards: [
    { text: 'FULL SEND MOTORS', x: 64, z: -48, yaw: -0.85 },
    { text: 'GRIP OPTIONAL', x: -58, z: 50, yaw: 2.6 },
    { text: 'TRACKSIDE SUPPLY', x: -12, z: 54, yaw: Math.PI },
  ],
} as const;

export function createFenceSegments() {
  const offset = -(OVAL_TRACK_LAYOUT.trackWidth / 2 + VENUE_LAYOUT.runoff);
  return Array.from({ length: VENUE_LAYOUT.fenceSegments }, (_, index) => {
    const start = getTrackOffsetPoint(index / VENUE_LAYOUT.fenceSegments, offset);
    const end = getTrackOffsetPoint((index + 1) / VENUE_LAYOUT.fenceSegments, offset);
    return {
      start,
      end,
      x: (start[0] + end[0]) / 2,
      z: (start[2] + end[2]) / 2,
      length: Math.hypot(end[0] - start[0], end[2] - start[2]),
      yaw: Math.atan2(start[2] - end[2], end[0] - start[0]),
    };
  });
}

interface Instance {
  position: readonly [number, number, number];
  scale: readonly [number, number, number];
  yaw: number;
  color?: number;
}

/** Designer-defined zones, with shared geometry and one draw per batch. */
export class MotorsportEnvironment {
  public readonly group = new THREE.Group();
  private readonly batches = new Map<
    string,
    {
      geometry: THREE.BufferGeometry;
      material: THREE.Material;
      instances: Instance[];
    }
  >();
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private readonly metal = new THREE.MeshLambertMaterial({ color: 0x657179 });
  private readonly concrete = new THREE.MeshLambertMaterial({ color: 0xc2c2b4 });
  private readonly colored = new THREE.MeshLambertMaterial({ color: 0xffffff });
  private readonly dark = new THREE.MeshLambertMaterial({ color: 0x28363c });
  private readonly crowdMaterial = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
  });

  public constructor() {
    this.group.name = 'motorsport-venue-visual-only';
    this.group.userData.collider = false;
    this.addCatchFence();
    this.addGrandstand('main', VENUE_LAYOUT.mainStand);
    this.addGrandstand('secondary', VENUE_LAYOUT.secondaryStand);
    this.addSpectatorCluster();
    this.addInfield();
    this.addStartFinish();
    this.addLightsAndBackground();
    for (const board of VENUE_LAYOUT.billboards) {
      this.sign(board.text, board.x, 4.4, board.z, 10, 2.5, board.yaw);
      for (const dx of [-3.7, 3.7]) {
        this.cube(
          'metal',
          [board.x + Math.cos(board.yaw) * dx, 2, board.z - Math.sin(board.yaw) * dx],
          [0.15, 4, 0.15],
        );
      }
    }
    this.flush();
  }

  private instance(
    key: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    instance: Instance,
  ): void {
    let batch = this.batches.get(key);
    if (batch === undefined) {
      batch = { geometry, material, instances: [] };
      this.batches.set(key, batch);
    }
    batch.instances.push(instance);
  }

  private cube(
    key: 'metal' | 'concrete' | 'colored' | 'dark',
    position: Instance['position'],
    scale: Instance['scale'],
    yaw = 0,
    color?: number,
  ): void {
    const material = {
      metal: this.metal,
      concrete: this.concrete,
      colored: this.colored,
      dark: this.dark,
    }[key];
    this.instance(key, this.box, material, {
      position,
      scale,
      yaw,
      ...(color === undefined ? {} : { color }),
    });
  }

  private flush(): void {
    const transform = new THREE.Object3D();
    for (const [key, batch] of this.batches) {
      const mesh = new THREE.InstancedMesh(
        batch.geometry,
        batch.material,
        batch.instances.length,
      );
      mesh.name = `venue-${key}`;
      mesh.userData.collider = false;
      batch.instances.forEach((instance, index) => {
        transform.position.fromArray(instance.position);
        transform.scale.fromArray(instance.scale);
        transform.rotation.set(0, instance.yaw, 0);
        transform.updateMatrix();
        mesh.setMatrixAt(index, transform.matrix);
        if (instance.color !== undefined)
          mesh.setColorAt(index, new THREE.Color(instance.color));
      });
      mesh.computeBoundingSphere();
      // Large static batches deliberately skip shadow passes; sun shading remains.
      this.group.add(mesh);
    }
  }

  private addCatchFence(): void {
    // A cutout grid instead of thousands of separate wire meshes or alpha blending.
    const pixels = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const i = (y * 64 + x) * 4;
        pixels.set([112, 131, 139, x % 16 === 0 || y % 16 === 0 ? 255 : 0], i);
      }
    }
    const texture = new THREE.DataTexture(pixels, 64, 64);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(6, 5);
    texture.needsUpdate = true;
    const wire = new THREE.MeshBasicMaterial({
      map: texture,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
    const panel = new THREE.PlaneGeometry(1, 1);
    const railMaterial = new THREE.MeshLambertMaterial({
      color: 0x657179,
      side: THREE.DoubleSide,
    });
    for (const segment of createFenceSegments()) {
      this.instance('catch-fence-wire', panel, wire, {
        position: [segment.x, VENUE_LAYOUT.fenceHeight / 2, segment.z],
        scale: [segment.length, VENUE_LAYOUT.fenceHeight, 1],
        yaw: segment.yaw,
      });
      this.cube('metal', [segment.start[0], 1.75, segment.start[2]], [0.12, 3.5, 0.12]);
      for (const height of [0.45, 3.4])
        this.instance('catch-fence-rails', panel, railMaterial, {
          position: [segment.x, height, segment.z],
          scale: [segment.length, 0.055, 1],
          yaw: segment.yaw,
        });
    }
  }

  private addGrandstand(
    name: string,
    stand: {
      x: number;
      z: number;
      width: number;
      rows: number;
      columns: number;
      facing: number;
    },
  ): void {
    const body = new THREE.PlaneGeometry(0.36, 0.48);
    const head = new THREE.PlaneGeometry(0.24, 0.26);
    const palette = [0xdb705b, 0xecc86b, 0x4c9baa, 0xe5e1d2, 0x36536e, 0x8d668d];
    for (let row = 0; row < stand.rows; row += 1) {
      const z = stand.z - stand.facing * row * 1.12;
      const y = 0.65 + row * 0.56;
      this.cube('concrete', [stand.x, y, z], [stand.width, 0.3, 1.1]);
      this.cube(
        'colored',
        [stand.x, y + 0.21, z],
        [stand.width, 0.12, 0.4],
        0,
        row % 2 === 0 ? 0x446d7e : 0xc18a51,
      );
      for (let column = 0; column < stand.columns; column += 1) {
        // Two aisles; stable color/occupancy variation without scattered placement.
        if (
          column % 22 === 10 ||
          column % 22 === 11 ||
          (row * 17 + column * 7) % 13 === 0
        )
          continue;
        const x =
          stand.x -
          stand.width / 2 +
          0.6 +
          (column * (stand.width - 1.2)) / (stand.columns - 1);
        this.instance(`${name}-crowd-bodies`, body, this.crowdMaterial, {
          position: [x, y + 0.49, z],
          scale: [1, 1, 1],
          yaw: 0,
          color: palette[(column * 7 + row * 11) % palette.length]!,
        });
        this.instance(`${name}-crowd-heads`, head, this.crowdMaterial, {
          position: [x, y + 0.86, z],
          scale: [1, 1, 1],
          yaw: 0,
          color: (column + row) % 3 === 0 ? 0xb77953 : 0xe5b58a,
        });
      }
      for (const aisleX of [-stand.width / 6, stand.width / 6])
        this.cube('metal', [stand.x + aisleX, y + 0.17, z], [0.8, 0.1, 1]);
    }
    for (let x = -stand.width / 2; x <= stand.width / 2; x += 6)
      this.cube('metal', [stand.x + x, 2, stand.z - stand.facing * 4], [0.18, 4, 7]);
    if (name === 'main') {
      this.cube('metal', [stand.x, 7.1, stand.z - 4], [stand.width + 2, 0.22, 12]);
      for (const x of [-29, -14, 14, 29])
        this.cube('metal', [x, 3.5, stand.z - 9], [0.2, 7, 0.2]);
      this.sign('COUNTY SHUNT MOTOR CLUB', 0, 6.1, stand.z + 1, 29, 1.25, 0);
    }
    this.cube(
      'dark',
      [stand.x, 0.01, stand.z - stand.facing * 4],
      [stand.width + 4, 0.04, 14],
    );
  }

  private addSpectatorCluster(): void {
    const roof = new THREE.ConeGeometry(1, 1, 4);
    VENUE_LAYOUT.spectatorBooths.forEach(([x, z], index) => {
      this.instance('tent-roofs', roof, this.colored, {
        position: [x, 3.3, z],
        scale: [3.8, 1.8, 3.8],
        yaw: Math.PI / 4,
        color: [0xe0a452, 0x65adb4, 0xd67e66][index]!,
      });
      this.cube('colored', [x, 0.85, z], [4.8, 1.7, 2.4], 0, 0xe5dac2);
      for (const dx of [-2.4, 2.4])
        for (const dz of [-2.4, 2.4])
          this.cube('metal', [x + dx, 1.6, z + dz], [0.075, 3.2, 0.075]);
    });
    this.sign('FOOD / FAN ZONE', -18, 2.4, 59.5, 6, 0.85, Math.PI);
    for (const [x, z] of [
      [-33, 57],
      [34, 57],
      [-32, -54],
      [32, -54],
    ]) {
      this.cube('metal', [x!, 3, z!], [0.09, 6, 0.09]);
      this.cube(
        'colored',
        [x! + 0.9, 5.45, z!],
        [1.7, 0.85, 0.04],
        0,
        x! < 0 ? 0xe6ad54 : 0x61b8c3,
      );
    }
  }

  private addInfield(): void {
    this.group.add(new InfieldEnvironment().group);
  }

  private vehicle(x: number, z: number, color: number): void {
    this.cube('colored', [x, 0.8, z], [2, 0.8, 3.8], 0, color);
    this.cube('dark', [x, 1.45, z + 0.2], [1.8, 0.65, 1.8]);
    for (const dx of [-1, 1])
      for (const dz of [-1.2, 1.2])
        this.cube('dark', [x + dx, 0.45, z + dz], [0.3, 0.65, 0.65]);
  }

  private addStartFinish(): void {
    // Progress zero is the original start line at x=-36 on the main straight.
    for (const z of [-43, -21]) this.cube('metal', [-36, 4.5, z], [0.25, 9, 0.25]);
    this.cube('metal', [-36, 8.6, -32], [0.35, 0.5, 22]);
    this.sign('COUNTY SHUNT  /  START', -35.75, 8.25, -32, 18, 1.1, Math.PI / 2);
    for (let index = 0; index < 5; index += 1)
      this.cube(
        'colored',
        [-35.65, 7.3, -35 + index * 1.5],
        [0.12, 0.38, 0.38],
        0,
        index === 4 ? 0x8bba70 : 0xc45143,
      );
    this.cube('concrete', [-40, 1.7, -45], [4.2, 3.4, 3.5]);
    this.sign('START / FINISH', -40, 3.8, -43.15, 5.5, 0.85, 0);
  }

  private addLightsAndBackground(): void {
    for (const progress of [0.04, 0.17, 0.3, 0.43, 0.54, 0.67, 0.8, 0.93]) {
      const point = getTrackOffsetPoint(progress, -23);
      this.cube('metal', [point[0], 6.5, point[2]], [0.17, 13, 0.17]);
      this.cube('metal', [point[0], 12.6, point[2]], [2.8, 0.18, 0.3]);
      this.cube('colored', [point[0], 12.3, point[2]], [2.6, 0.35, 0.3], 0, 0xffecc3);
    }
    // Visual ground extension does not extend the driveable physical world.
    this.cube('colored', [0, -0.36, 0], [300, 0.06, 230], 0, 0x89947b);
    const hill = new THREE.IcosahedronGeometry(1, 0);
    for (let index = 0; index < 12; index += 1) {
      const angle = (index / 12) * Math.PI * 2;
      this.instance('hills', hill, this.colored, {
        position: [Math.cos(angle) * 138, -2, Math.sin(angle) * 110],
        scale: [22, 10 + (index % 3) * 2, 18],
        yaw: angle,
        color: index % 2 ? 0x7e9279 : 0x8b9c80,
      });
    }
    const tree = new THREE.ConeGeometry(1, 1, 6);
    for (let index = 0; index < 32; index += 1) {
      const angle = (index / 32) * Math.PI * 2;
      const x = Math.cos(angle) * 113;
      const z = Math.sin(angle) * 89;
      this.cube('colored', [x, 0.8, z], [0.3, 1.6, 0.3], 0, 0x80674d);
      this.instance('distant-trees', tree, this.colored, {
        position: [x, 3.3, z],
        scale: [1.7, 4.6, 1.7],
        yaw: index * 0.71,
        color: index % 2 ? 0x607e68 : 0x719379,
      });
    }
    // Entrance lane and an aligned service parking grid behind the fan zone.
    this.cube('dark', [0, -0.28, 79], [85, 0.03, 5]);
    for (let index = 0; index < 8; index += 1) {
      this.vehicle(-28 + index * 7, 72, index % 2 ? 0x738b97 : 0xbdad84);
      this.cube('concrete', [-31 + index * 7, -0.26, 72], [0.12, 0.03, 5]);
    }
    this.sign('COUNTY SHUNT  /  ENTRANCE', -42, 3.3, 76, 9, 1.4, Math.PI);
  }

  private sign(
    text: string,
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    yaw: number,
  ): void {
    // Canvas is optional so geometry generation also works in headless regression tests.
    let map: THREE.CanvasTexture | undefined;
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 128;
      const context = canvas.getContext('2d');
      if (context !== null) {
        context.fillStyle = '#243740';
        context.fillRect(0, 0, 1024, 128);
        context.fillStyle = '#efbe63';
        context.fillRect(0, 115, 1024, 13);
        context.fillStyle = '#f4ead2';
        context.font = '900 64px system-ui, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(text, 512, 59, 980);
        map = new THREE.CanvasTexture(canvas);
        map.colorSpace = THREE.SRGBColorSpace;
      }
    }
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({
        ...(map === undefined ? { color: 0x243740 } : { map }),
        side: THREE.DoubleSide,
      }),
    );
    mesh.name = `venue-sign-${text}`;
    mesh.position.set(x, y, z);
    mesh.rotation.y = yaw;
    this.group.add(mesh);
  }
}
