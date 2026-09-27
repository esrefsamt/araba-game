import type { ConvoyStateSnapshot } from '@trailer-arena/shared';
import type * as THREE from 'three';

import { TrailerView } from './TrailerView.js';
import { TruckView } from './TruckView.js';

export class ConvoyView {
  private readonly truck: TruckView;
  private readonly trailer: TrailerView;
  private latestSnapshot: ConvoyStateSnapshot | null = null;

  public constructor(private readonly scene: THREE.Scene) {
    this.truck = new TruckView(scene);
    this.trailer = new TrailerView(scene);
  }

  public applySnapshot(serverTick: number, snapshot: ConvoyStateSnapshot): void {
    this.latestSnapshot = snapshot;
    this.truck.addSnapshot(serverTick, snapshot.truck);
    this.trailer.addSnapshot(serverTick, snapshot.trailer);
  }

  public update(renderTick: number): void {
    this.truck.update(renderTick);
    this.trailer.update(renderTick);
  }

  public getLatestSnapshot(): ConvoyStateSnapshot | null {
    return this.latestSnapshot;
  }

  public writeRenderedTrailerPosition(output: [number, number, number]): void {
    this.trailer.writeRenderedPosition(output);
  }

  public clear(): void {
    this.latestSnapshot = null;
    this.truck.clear();
    this.trailer.clear();
  }

  public dispose(): void {
    this.truck.dispose(this.scene);
    this.trailer.dispose(this.scene);
  }
}
