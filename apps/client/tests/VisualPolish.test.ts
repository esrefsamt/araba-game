import {
  INPUT_SEND_RATE,
  NETWORK_UPDATE_RATE,
  PLAYER_COLLISION_TUNING,
  ROUND_DURATION_SECONDS,
  SIMULATION_TICK_RATE,
  SNAPSHOT_RATE,
  VEHICLE_TUNING,
  createClientCodec,
  createServerCodec,
} from '@trailer-arena/shared';
import type {
  GamePlayerStateSnapshot,
  GameplayEventMessage,
} from '@trailer-arena/shared';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { SoundSettingsState } from '../src/audio/AudioManager.js';
import { shouldShowDebugControls } from '../src/debug/DebugPanel.js';
import { GameplayEventDeduplicator } from '../src/effects/GameplayEventDeduplicator.js';
import { ParticlePool } from '../src/effects/ParticlePool.js';
import { SkidMarkSystem } from '../src/effects/SkidMarkSystem.js';
import { deriveHudVisibility, leaderboardPlayerIds } from '../src/ui/GameHud.js';
import {
  playerColorHex,
  playerColorIndex,
  playerPaletteSize,
} from '../src/visuals/PlayerPalette.js';

describe('Phase 6 presentation systems', () => {
  it('assigns deterministic colors from an eight-color palette', () => {
    const id = 'player_deterministic-example';
    expect(playerPaletteSize()).toBe(8);
    expect(playerColorHex(id)).toBe(playerColorHex(id));
    expect(playerColorIndex(id)).toBeGreaterThanOrEqual(0);
    expect(playerColorIndex(id)).toBeLessThan(8);
  });

  it('serializes and validates authoritative RAM gameplay events', () => {
    const message: GameplayEventMessage = {
      type: 'gameplay_event',
      event: {
        eventType: 'ram_hit',
        eventId: 'ROOM:120:4',
        attackerPlayerId: 'attacker',
        targetPlayerId: 'target',
        strength: 0.72,
        position: [4, 1.2, -3],
      },
    };
    const encoded = createServerCodec().encode(message);
    expect(createClientCodec().decode(encoded)).toEqual({ ok: true, value: message });
    expect(
      createClientCodec().decode(
        JSON.stringify({ ...message, event: { ...message.event, strength: 2 } }),
      ).ok,
    ).toBe(false);
  });

  it('deduplicates repeated event ids with bounded history', () => {
    const events = new GameplayEventDeduplicator(3);
    expect(events.accept('a')).toBe(true);
    expect(events.accept('a')).toBe(false);
    events.accept('b');
    events.accept('c');
    events.accept('d');
    expect(events.size).toBe(3);
    expect(events.accept('a')).toBe(true);
  });

  it('keeps particle allocation bounded', () => {
    const scene = new THREE.Scene();
    const pool = new ParticlePool(scene, 5, { color: 0xffffff, size: 0.1, gravity: 2 });
    pool.burst([0, 0, 0], 50, 1, 4);
    expect(pool.activeCount).toBe(5);
    expect(scene.children).toHaveLength(5);
    pool.dispose();
  });

  it('keeps skid marks in a bounded ring', () => {
    const scene = new THREE.Scene();
    const marks = new SkidMarkSystem(scene, 4);
    for (let index = 0; index < 20; index += 1) marks.add([index, 0, 0], 0, 1);
    expect(marks.activeCount).toBe(4);
    expect(scene.children).toHaveLength(4);
    marks.dispose();
  });

  it('stores sound mute and clamps master volume', () => {
    const settings = new SoundSettingsState();
    settings.setEnabled(false);
    settings.setVolume(4);
    expect(settings.enabled).toBe(false);
    expect(settings.volume).toBe(1);
    settings.setVolume(-1);
    expect(settings.volume).toBe(0);
  });

  it('maps each gameplay phase to one HUD presentation', () => {
    expect(deriveHudVisibility('LOBBY')).toEqual({
      lobby: true,
      playing: false,
      results: false,
      countdown: false,
    });
    expect(deriveHudVisibility('COUNTDOWN').countdown).toBe(true);
    expect(deriveHudVisibility('PLAYING').playing).toBe(true);
    expect(deriveHudVisibility('RESULTS').results).toBe(true);
  });

  it('uses authoritative server order for the top-eight leaderboard', () => {
    const players = Array.from({ length: 10 }, (_, index) => player(index));
    players[3]!.participant = false;
    expect(leaderboardPlayerIds(players)).toEqual([
      'p0',
      'p1',
      'p2',
      'p4',
      'p5',
      'p6',
      'p7',
      'p8',
    ]);
  });

  it('preserves Phase 5.2 physics, RAM, scoring, and network tuning', () => {
    expect({
      mass: VEHICLE_TUNING.mass,
      engineForce: VEHICLE_TUNING.engineForce,
      steeringStrength: VEHICLE_TUNING.steeringStrength,
      lateralGrip: VEHICLE_TUNING.lateralGrip,
      ramMaxDelta: PLAYER_COLLISION_TUNING.ramMaximumTargetDeltaVelocity,
      ramReaction: PLAYER_COLLISION_TUNING.ramAttackerReactionRatio,
      roundSeconds: ROUND_DURATION_SECONDS,
      simulationRate: SIMULATION_TICK_RATE,
      snapshotRate: SNAPSHOT_RATE,
      inputRate: INPUT_SEND_RATE,
      debugRate: NETWORK_UPDATE_RATE,
    }).toEqual({
      mass: 1_100,
      engineForce: 6_500,
      steeringStrength: 0.36,
      lateralGrip: 1.02,
      ramMaxDelta: 12,
      ramReaction: 0.2,
      roundSeconds: 90,
      simulationRate: 60,
      snapshotRate: 20,
      inputRate: 30,
      debugRate: 10,
    });
  });

  it('hides development debug controls in production builds', () => {
    expect(shouldShowDebugControls(true)).toBe(true);
    expect(shouldShowDebugControls(false)).toBe(false);
  });
});

function player(index: number): GamePlayerStateSnapshot {
  return {
    playerId: `p${index}`,
    playerName: `Player ${index}`,
    ready: true,
    participant: true,
    isScoringOnTrailer: false,
    trailerTicks: 0,
    currentStreakTicks: 0,
    bestStreakTicks: 0,
    roundPoints: 0,
    sessionPoints: 0,
  };
}
