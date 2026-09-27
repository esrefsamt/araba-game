import type {
  RamHitGameplayEvent,
  VehicleInputState,
  VehicleStateSnapshot,
} from '@trailer-arena/shared';
import { OVAL_TRACK_LAYOUT, getTrackCenterlinePoint } from '@trailer-arena/shared';
import type * as THREE from 'three';

import { GameplayEventDeduplicator } from './GameplayEventDeduplicator.js';
import { ParticlePool } from './ParticlePool.js';
import { SkidMarkSystem } from './SkidMarkSystem.js';

const SKID_INTERVAL_SECONDS = 0.055;

export interface RamFeedbackActions {
  cameraShake(strength: number): void;
  playCollision(strength: number): void;
  playRam(strength: number): void;
}

interface PopupSlot {
  readonly element: HTMLDivElement;
  remaining: number;
}

export class ArcadeFeedbackSystem {
  private readonly deduplicator = new GameplayEventDeduplicator();
  private readonly sparks: ParticlePool;
  private readonly debris: ParticlePool;
  private readonly dust: ParticlePool;
  private readonly skidMarks: SkidMarkSystem;
  private readonly popups: PopupSlot[] = [];
  private popupCursor = 0;
  private skidAccumulator = 0;

  public constructor(
    scene: THREE.Scene,
    private readonly overlay: HTMLElement,
    private readonly actions: RamFeedbackActions,
  ) {
    this.sparks = new ParticlePool(scene, 48, {
      color: 0xffd278,
      size: 0.085,
      gravity: 5.5,
    });
    this.debris = new ParticlePool(scene, 24, {
      color: 0x617179,
      size: 0.12,
      gravity: 7,
    });
    this.dust = new ParticlePool(scene, 40, {
      color: 0xc9b38b,
      size: 0.16,
      gravity: -0.18,
    });
    this.skidMarks = new SkidMarkSystem(scene, 96);
    for (let index = 0; index < 4; index += 1) {
      const element = document.createElement('div');
      element.className = 'impact-popup';
      element.hidden = true;
      overlay.append(element);
      this.popups.push({ element, remaining: 0 });
    }
  }

  public handleRamEvent(
    event: RamHitGameplayEvent,
    localPlayerId: string | null,
  ): boolean {
    if (!this.deduplicator.accept(event.eventId)) return false;
    const strength = Math.min(1, Math.max(0, event.strength));
    if (strength > 0.12) {
      this.sparks.burst(
        event.position,
        3 + Math.round(strength * 7),
        1.4 + strength * 2.2,
        hash(event.eventId),
      );
      this.debris.burst(
        event.position,
        2 + Math.round(strength * 3),
        0.7 + strength,
        hash(event.eventId) + 71,
      );
    }
    this.actions.playCollision(strength);
    if (strength >= 0.35) this.actions.playRam(strength);
    if (event.targetPlayerId === localPlayerId) this.actions.cameraShake(strength);
    if (event.attackerPlayerId === localPlayerId && strength >= 0.35) {
      this.showPopup(strength > 0.78 ? 'MASSIVE SHUNT!' : 'SOLID HIT!');
    } else if (event.targetPlayerId === localPlayerId && strength >= 0.45) {
      this.showPopup('WHAM!');
    }
    return true;
  }

  public update(
    deltaSeconds: number,
    state: VehicleStateSnapshot | null,
    input: Readonly<VehicleInputState>,
  ): void {
    this.sparks.update(deltaSeconds);
    this.debris.update(deltaSeconds);
    this.dust.update(deltaSeconds);
    this.skidMarks.update(deltaSeconds);
    for (const popup of this.popups) {
      if (popup.remaining <= 0) continue;
      popup.remaining -= deltaSeconds;
      if (popup.remaining <= 0) popup.element.hidden = true;
    }
    if (state === null || !state.grounded || state.onTrailer) return;
    const slide = Math.abs(state.lateralSpeed);
    const skidding = input.handbrake || slide > 3.2;
    if (!skidding || Math.abs(state.forwardSpeed) < 2.2) {
      this.skidAccumulator = 0;
      return;
    }
    this.skidAccumulator += deltaSeconds;
    if (this.skidAccumulator < SKID_INTERVAL_SECONDS) return;
    this.skidAccumulator %= SKID_INTERVAL_SECONDS;
    const heading = yawFromQuaternion(state.rotation);
    const intensity = Math.min(1, slide / 8 + Number(input.handbrake) * 0.25);
    const onAsphalt = isOnAsphalt(state.position);
    if (onAsphalt) this.skidMarks.add(state.position, heading, intensity);
    if ((!onAsphalt && slide > 2.6) || (onAsphalt && slide > 5.5)) {
      this.dust.burst(
        state.position,
        onAsphalt ? 1 : 3,
        (onAsphalt ? 0.16 : 0.32) + intensity * 0.3,
        Math.floor(performance.now()),
      );
    }
  }

  public clear(): void {
    this.deduplicator.clear();
    for (const popup of this.popups) {
      popup.remaining = 0;
      popup.element.hidden = true;
    }
  }

  public dispose(): void {
    this.sparks.dispose();
    this.debris.dispose();
    this.dust.dispose();
    this.skidMarks.dispose();
    for (const popup of this.popups) popup.element.remove();
  }

  public get debugCounts(): { particles: number; skidMarks: number } {
    return {
      particles:
        this.sparks.activeCount + this.debris.activeCount + this.dust.activeCount,
      skidMarks: this.skidMarks.activeCount,
    };
  }

  private showPopup(text: string): void {
    const popup = this.popups[this.popupCursor]!;
    this.popupCursor = (this.popupCursor + 1) % this.popups.length;
    popup.element.textContent = text;
    popup.element.hidden = false;
    popup.element.classList.remove('impact-popup--animate');
    void popup.element.offsetWidth;
    popup.element.classList.add('impact-popup--animate');
    popup.remaining = 0.85;
  }
}

function yawFromQuaternion(rotation: readonly [number, number, number, number]): number {
  const [x, y, z, w] = rotation;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
}

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result, 31) + value.charCodeAt(index);
  }
  return result;
}

function isOnAsphalt(position: readonly [number, number, number]): boolean {
  let nearestSquared = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 48; index += 1) {
    const sample = getTrackCenterlinePoint(index / 48).position;
    const deltaX = position[0] - sample[0];
    const deltaZ = position[2] - sample[2];
    nearestSquared = Math.min(nearestSquared, deltaX * deltaX + deltaZ * deltaZ);
  }
  return nearestSquared <= (OVAL_TRACK_LAYOUT.trackWidth / 2 + 0.5) ** 2;
}
