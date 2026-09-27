import RAPIER from '@dimforge/rapier3d-compat';
import { INFIELD_LAYOUT, OVAL_TRACK_LAYOUT } from '@trailer-arena/shared';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';

import { createRoomPhysicsContext } from '../../server/src/world/PhysicsWorldBuilder.js';
import { VehicleSystem } from '../../server/src/vehicles/VehicleSystem.js';
import { VehicleView } from '../src/entities/VehicleView.js';
import { InfieldEnvironment } from '../src/rendering/InfieldEnvironment.js';

beforeAll(async () => {
  await RAPIER.init();
});

function dispose(environment: InfieldEnvironment): void {
  const materials = new Set<THREE.Material>();
  environment.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material])
      materials.add(material);
  });
  for (const material of materials) material.dispose();
}

describe('shared infield presentation and authoritative colliders', () => {
  it('keeps rendered wheel bottoms near the actual settled Rapier ground contact', () => {
    const { world, surfaces } = createRoomPhysicsContext();
    const vehicles = new VehicleSystem(world, surfaces);
    vehicles.spawnVehicle('driver');
    vehicles.teleportVehicle('driver', {
      position: [-5, 1.15, -6],
      rotation: [0, 0, 0, 1],
    });
    const scene = new THREE.Scene();
    const view = new VehicleView('driver', scene);
    for (let tick = 0; tick < 240; tick += 1) {
      vehicles.update(1 / 60);
      vehicles.stepPhysics(1 / 60);
      view.beginRenderFrame();
      view.applyPredictedState(vehicles.createSnapshot()[0]!, 1 / 60);
    }
    view.object.updateMatrixWorld(true);
    expect(vehicles.createSnapshot()[0]!.wheelContacts).toBe(4);
    for (const child of view.object.children.filter((object) =>
      object.name.startsWith('wheel-steer-'),
    )) {
      const bottom = new THREE.Box3().setFromObject(child).min.y;
      expect(Math.abs(bottom)).toBeLessThan(0.03);
    }
    view.dispose(scene);
    vehicles.dispose();
    world.free();
  });

  it('builds deterministic instance buffers without mutating the shared layout', () => {
    const original = JSON.stringify(INFIELD_LAYOUT);
    const first = new InfieldEnvironment();
    const second = new InfieldEnvironment();
    for (const child of first.group.children) {
      const other = second.group.getObjectByName(child.name)!;
      if (child instanceof THREE.InstancedMesh && other instanceof THREE.InstancedMesh) {
        expect(Array.from(child.instanceMatrix.array)).toEqual(
          Array.from(other.instanceMatrix.array),
        );
        expect(child.userData.elementIds).toEqual(other.userData.elementIds);
      }
    }
    expect(new Set(INFIELD_LAYOUT.map((element) => element.id)).size).toBe(
      INFIELD_LAYOUT.length,
    );
    expect(JSON.stringify(INFIELD_LAYOUT)).toBe(original);
    dispose(first);
    dispose(second);
  });

  it('matches actual client instance transforms and footprints to actual server collider shapes', () => {
    const environment = new InfieldEnvironment();
    const { world, infieldColliders } = createRoomPhysicsContext();
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    let matched = 0;
    for (const child of environment.group.children) {
      if (!(child instanceof THREE.InstancedMesh)) continue;
      const ids = child.userData.elementIds as string[];
      ids.forEach((id, index) => {
        const collider = infieldColliders.get(id);
        const element = INFIELD_LAYOUT.find((item) => item.id === id)!;
        expect(collider !== undefined).toBe(element.collision);
        if (collider === undefined) return;
        matched += 1;
        child.getMatrixAt(index, matrix);
        matrix.decompose(position, rotation, scale);
        const translation = collider.translation();
        const quaternion = collider.rotation();
        for (const axis of ['x', 'y', 'z'] as const)
          expect(position[axis]).toBeCloseTo(translation[axis], 5);
        expect(
          rotation.angleTo(
            new THREE.Quaternion(quaternion.x, quaternion.y, quaternion.z, quaternion.w),
          ),
        ).toBeLessThan(1e-5);
        if (element.geometry === 'cylinder') {
          expect(collider.radius() * 2).toBeCloseTo(scale.x, 5);
          expect(collider.halfHeight() * 2).toBeCloseTo(scale.y, 5);
          // Ten-sided visual cylinders differ from the round collider by < 3 cm.
          expect(collider.radius() * (1 - Math.cos(Math.PI / 10))).toBeLessThan(0.03);
        } else {
          const half = collider.halfExtents()!;
          for (const axis of ['x', 'y', 'z'] as const)
            expect(half[axis] * 2).toBeCloseTo(scale[axis], 5);
          const bounds = new THREE.Box3()
            .setFromBufferAttribute(
              child.geometry.getAttribute('position') as THREE.BufferAttribute,
            )
            .applyMatrix4(matrix);
          expect(bounds.getSize(new THREE.Vector3()).distanceTo(scale)).toBeLessThan(
            1e-4,
          );
        }
      });
    }
    expect(matched).toBe(infieldColliders.size);
    expect(matched).toBeGreaterThan(25);
    world.free();
    dispose(environment);
  });

  it('keeps every obstacle footprint inside the oval inner edge', () => {
    const innerRadius = OVAL_TRACK_LAYOUT.turnRadius - OVAL_TRACK_LAYOUT.trackWidth / 2;
    for (const element of INFIELD_LAYOUT.filter((item) => item.collision)) {
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          const x = element.position[0] + (sx * element.size[0]) / 2;
          const z = element.position[2] + (sz * element.size[2]) / 2;
          const capX = Math.max(0, Math.abs(x) - OVAL_TRACK_LAYOUT.straightHalfLength);
          expect(Math.hypot(capX, z), element.id).toBeLessThan(innerRadius - 0.25);
        }
    }
  });

  it('provides five connected facility zones and three distinct landmark clusters', () => {
    expect(new Set(INFIELD_LAYOUT.map((element) => element.zone))).toEqual(
      new Set(['SERVICE', 'CONTROL', 'PADDOCK', 'RECOVERY', 'ACCESS']),
    );
    for (const id of [
      'service-garage-0',
      'race-control-building',
      'timing-tower-board',
      'team-tent-0-roof',
      'recovery-tow-truck',
      'cross-service-road',
    ])
      expect(INFIELD_LAYOUT.some((element) => element.id === id)).toBe(true);
    expect(
      INFIELD_LAYOUT.filter((element) => element.id.match(/^team-tent-\d-roof$/)),
    ).toHaveLength(3);
  });

  it('batches the complete infield into four draws with shared primitive materials', () => {
    const environment = new InfieldEnvironment();
    expect(environment.group.children).toHaveLength(4);
    const batches = environment.group.children.filter(
      (child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh,
    );
    expect(new Set(batches.map((mesh) => mesh.material)).size).toBe(1);
    const triangles = batches.reduce(
      (sum, mesh) => sum + (mesh.geometry.getIndex()!.count / 3) * mesh.count,
      0,
    );
    expect(triangles).toBeLessThan(4500);
    expect(batches.reduce((sum, mesh) => sum + mesh.count, 0)).toBe(
      INFIELD_LAYOUT.filter((element) => element.geometry !== 'sign').length,
    );
    dispose(environment);
  });
});
