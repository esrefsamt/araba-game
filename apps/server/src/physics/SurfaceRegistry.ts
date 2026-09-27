import type RAPIER from '@dimforge/rapier3d-compat';
import { ASPHALT_SURFACE_GRIP, TRAILER_SURFACE_GRIP } from '@trailer-arena/shared';
import type { SurfaceGrip, SurfaceType } from '@trailer-arena/shared';

export interface PhysicsSurface {
  readonly type: Exclude<SurfaceType, 'AIR'>;
  readonly grip: SurfaceGrip;
  readonly movingBody: RAPIER.RigidBody | null;
}

const GROUND_SURFACE: PhysicsSurface = {
  type: 'GROUND',
  grip: ASPHALT_SURFACE_GRIP,
  movingBody: null,
};

export class SurfaceRegistry {
  private readonly surfaces = new Map<number, PhysicsSurface>();

  public registerGround(collider: RAPIER.Collider): void {
    this.surfaces.set(collider.handle, GROUND_SURFACE);
  }

  public registerTrailer(
    collider: RAPIER.Collider,
    movingBody: RAPIER.RigidBody,
    type: 'TRAILER_DECK' | 'TRAILER_RAMP',
  ): void {
    this.surfaces.set(collider.handle, {
      type,
      grip: TRAILER_SURFACE_GRIP,
      movingBody,
    });
  }

  public get(collider: RAPIER.Collider | null): PhysicsSurface | null {
    return collider === null ? null : (this.surfaces.get(collider.handle) ?? null);
  }

  public unregister(collider: RAPIER.Collider): void {
    this.surfaces.delete(collider.handle);
  }

  public clear(): void {
    this.surfaces.clear();
  }
}
