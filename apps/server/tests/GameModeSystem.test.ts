import RAPIER from '@dimforge/rapier3d-compat';
import {
  POSITION_POINTS,
  ROUND_DURATION_TICKS,
  SIMULATION_FIXED_DELTA_SECONDS,
  TRAILER_CONTACT_GRACE_TICKS,
  createClientCodec,
  createServerCodec,
} from '@trailer-arena/shared';
import type { WorldSnapshotMessage } from '@trailer-arena/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { GameModeSystem } from '../src/gameplay/GameModeSystem.js';
import { pointsForRank, rankPlayers } from '../src/gameplay/RankingSystem.js';
import {
  hasTrailerDeckScoringSupport,
  resetTrailerScore,
  updateTrailerScore,
  type TrailerScoreState,
} from '../src/gameplay/TrailerScoringSystem.js';
import { ServerPlayer } from '../src/players/ServerPlayer.js';
import { GameRoom } from '../src/rooms/GameRoom.js';

const rooms: GameRoom[] = [];

beforeAll(async () => {
  await RAPIER.init();
});

afterEach(() => {
  for (const room of rooms) room.dispose();
  rooms.length = 0;
});

function createMode(
  options = { countdownTicks: 3, roundDurationTicks: 5, contactGraceTicks: 2 },
): GameModeSystem {
  return new GameModeSystem(options);
}

function addPlayers(mode: GameModeSystem, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    mode.addPlayer(`p${index}`, `Player ${index}`);
  }
}

function readyAll(mode: GameModeSystem, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    expect(mode.setReady(`p${index}`, true)).toBe(true);
  }
}

function startPlaying(mode: GameModeSystem, playerCount = 1, startTick = 10): number {
  addPlayers(mode, playerCount);
  if (playerCount > 1) readyAll(mode, playerCount);
  expect(mode.startMatch('p1', startTick)).toEqual({ ok: true });
  const playingTick = startTick + 3;
  expect(mode.update(playingTick, new Set())).toBe('PLAYING_STARTED');
  return playingTick;
}

function getPlayer(mode: GameModeSystem, playerId: string) {
  return mode.createSnapshot().players.find((player) => player.playerId === playerId)!;
}

describe('Phase 4 game state machine', () => {
  it('starts every room in LOBBY', () => {
    expect(createMode().createSnapshot().phase).toBe('LOBBY');
  });

  it('makes the first player host', () => {
    const mode = createMode();
    addPlayers(mode, 2);
    expect(mode.currentHostPlayerId).toBe('p1');
  });

  it('migrates host to the oldest remaining player', () => {
    const mode = createMode();
    addPlayers(mode, 3);
    mode.removePlayer('p1');
    expect(mode.currentHostPlayerId).toBe('p2');
  });

  it('changes only the requesting player ready state', () => {
    const mode = createMode();
    addPlayers(mode, 2);
    expect(mode.setReady('p2', true)).toBe(true);
    expect(getPlayer(mode, 'p1').ready).toBe(false);
    expect(getPlayer(mode, 'p2').ready).toBe(true);
  });

  it('rejects a non-host start request', () => {
    const mode = createMode();
    addPlayers(mode, 2);
    readyAll(mode, 2);
    expect(mode.startMatch('p2', 0)).toEqual({ ok: false, reason: 'NOT_HOST' });
  });

  it('allows a single host to start without ready gating', () => {
    const mode = createMode();
    addPlayers(mode, 1);
    expect(mode.startMatch('p1', 5)).toEqual({ ok: true });
    expect(mode.createSnapshot().phase).toBe('COUNTDOWN');
  });

  it('requires every player to be ready in multiplayer', () => {
    const mode = createMode();
    addPlayers(mode, 2);
    mode.setReady('p1', true);
    expect(mode.startMatch('p1', 0)).toEqual({ ok: false, reason: 'NOT_READY' });
  });

  it('transitions to PLAYING after the authoritative countdown', () => {
    const mode = createMode();
    addPlayers(mode, 1);
    mode.startMatch('p1', 10);
    expect(mode.update(12, new Set())).toBeNull();
    expect(mode.createSnapshot().phase).toBe('COUNTDOWN');
    expect(mode.update(13, new Set())).toBe('PLAYING_STARTED');
    expect(mode.createSnapshot().phase).toBe('PLAYING');
  });

  it('locks GameRoom vehicle input during countdown', () => {
    const room = createRoom();
    const player = createPlayer('p1');
    room.addPlayer(player);
    room.startMatch(player.id);
    expect(
      room.applyPlayerInput(player.id, {
        type: 'player_input',
        sequence: 1,
        throttle: 1,
        brake: 0,
        steering: 0,
        handbrake: false,
      }),
    ).toBe(false);
    expect(room.getVehicleSystem().getVehicle(player.id)?.input.throttle).toBe(0);
  });

  it('resets round score fields when countdown begins', () => {
    const mode = createMode();
    const playingTick = startPlaying(mode);
    mode.update(playingTick + 1, new Set(['p1']));
    mode.update(playingTick + 5, new Set());
    mode.nextRound('p1', playingTick + 6);
    expect(getPlayer(mode, 'p1')).toMatchObject({
      trailerTicks: 0,
      currentStreakTicks: 0,
      bestStreakTicks: 0,
      isScoringOnTrailer: false,
    });
  });

  it('preserves session points across next round reset', () => {
    const mode = createMode();
    const playingTick = startPlaying(mode);
    mode.update(playingTick + 5, new Set());
    expect(getPlayer(mode, 'p1').sessionPoints).toBe(10);
    mode.nextRound('p1', playingTick + 6);
    expect(getPlayer(mode, 'p1').sessionPoints).toBe(10);
  });

  it('uses the configured default 90 second round duration', () => {
    const mode = new GameModeSystem();
    addPlayers(mode, 1);
    mode.startMatch('p1', 0);
    mode.update(180, new Set());
    const snapshot = mode.createSnapshot();
    expect(snapshot.stateEndTick! - snapshot.stateStartTick).toBe(ROUND_DURATION_TICKS);
  });
});

describe('trailer scoring and ranking', () => {
  it('requires at least two real deck wheel contacts', () => {
    expect(hasTrailerDeckScoringSupport('TRAILER_DECK', 2)).toBe(true);
    expect(hasTrailerDeckScoringSupport('TRAILER_DECK', 1)).toBe(false);
  });

  it('does not score ordinary asphalt ground contact', () => {
    expect(hasTrailerDeckScoringSupport('GROUND', 4)).toBe(false);
  });

  it('does not score grass represented by the non-deck world surface', () => {
    expect(hasTrailerDeckScoringSupport('GROUND', 0)).toBe(false);
  });

  it('does not score trailer ramp contact', () => {
    expect(hasTrailerDeckScoringSupport('TRAILER_RAMP', 4)).toBe(false);
  });

  it('does not score truck support without a registered deck identity', () => {
    expect(hasTrailerDeckScoringSupport('GROUND', 0)).toBe(false);
  });

  it('does not score while airborne', () => {
    expect(hasTrailerDeckScoringSupport('AIR', 0)).toBe(false);
  });

  it('increments trailer ticks for deck support', () => {
    const mode = createMode();
    const tick = startPlaying(mode);
    mode.update(tick + 1, new Set(['p1']));
    expect(getPlayer(mode, 'p1')).toMatchObject({
      trailerTicks: 1,
      currentStreakTicks: 1,
      isScoringOnTrailer: true,
    });
  });

  it('stops scoring after contact grace expires', () => {
    const mode = createMode();
    const tick = startPlaying(mode);
    mode.update(tick + 1, new Set(['p1']));
    mode.update(tick + 2, new Set());
    mode.update(tick + 3, new Set());
    expect(getPlayer(mode, 'p1').isScoringOnTrailer).toBe(true);
    mode.update(tick + 4, new Set());
    expect(getPlayer(mode, 'p1').isScoringOnTrailer).toBe(false);
  });

  it('keeps total time when a player returns to the deck', () => {
    const mode = createMode({
      countdownTicks: 3,
      roundDurationTicks: 10,
      contactGraceTicks: 2,
    });
    const tick = startPlaying(mode);
    mode.update(tick + 1, new Set(['p1']));
    mode.update(tick + 4, new Set());
    const beforeReturn = getPlayer(mode, 'p1').trailerTicks;
    mode.update(tick + 5, new Set(['p1']));
    expect(getPlayer(mode, 'p1').trailerTicks).toBe(beforeReturn + 1);
  });

  it('resets current streak after falling off', () => {
    const mode = createMode();
    const tick = startPlaying(mode);
    mode.update(tick + 1, new Set(['p1']));
    mode.update(tick + 4, new Set());
    expect(getPlayer(mode, 'p1').currentStreakTicks).toBe(0);
  });

  it('preserves best streak after falling off', () => {
    const mode = createMode();
    const tick = startPlaying(mode);
    mode.update(tick + 1, new Set(['p1']));
    mode.update(tick + 2, new Set(['p1']));
    mode.update(tick + 5, new Set());
    expect(getPlayer(mode, 'p1').bestStreakTicks).toBe(2);
  });

  it('uses the 150 ms default contact grace', () => {
    expect(TRAILER_CONTACT_GRACE_TICKS).toBe(9);
  });

  it('ranks total trailer time descending', () => {
    const ranked = rankPlayers([
      { playerId: 'a', joinOrder: 0, trailerTicks: 3, bestStreakTicks: 3 },
      { playerId: 'b', joinOrder: 1, trailerTicks: 8, bestStreakTicks: 4 },
    ]);
    expect(ranked.map((player) => player.playerId)).toEqual(['b', 'a']);
  });

  it('breaks ties by best streak then join order', () => {
    const ranked = rankPlayers([
      { playerId: 'a', joinOrder: 0, trailerTicks: 8, bestStreakTicks: 2 },
      { playerId: 'b', joinOrder: 2, trailerTicks: 8, bestStreakTicks: 4 },
      { playerId: 'c', joinOrder: 1, trailerTicks: 8, bestStreakTicks: 4 },
    ]);
    expect(ranked.map((player) => player.playerId)).toEqual(['c', 'b', 'a']);
  });

  it('assigns the configured eight-player points table', () => {
    expect(Array.from({ length: 8 }, (_, index) => pointsForRank(index + 1))).toEqual(
      POSITION_POINTS,
    );
  });

  it('handles all-zero standings deterministically', () => {
    const ranked = rankPlayers([
      { playerId: 'later', joinOrder: 1, trailerTicks: 0, bestStreakTicks: 0 },
      { playerId: 'first', joinOrder: 0, trailerTicks: 0, bestStreakTicks: 0 },
    ]);
    expect(ranked.map((player) => player.playerId)).toEqual(['first', 'later']);
  });

  it('resets a standalone trailer score without touching external session state', () => {
    const state: TrailerScoreState = {
      trailerTicks: 8,
      currentStreakTicks: 3,
      bestStreakTicks: 5,
      isScoringOnTrailer: true,
      lastTrailerContactTick: 20,
    };
    updateTrailerScore(state, 21, true, 2);
    resetTrailerScore(state);
    expect(state).toEqual({
      trailerTicks: 0,
      currentStreakTicks: 0,
      bestStreakTicks: 0,
      isScoringOnTrailer: false,
      lastTrailerContactTick: null,
    });
  });
});

describe('round results, late join and protocol authority', () => {
  it('transitions to RESULTS at the exact round end tick', () => {
    const mode = createMode();
    const tick = startPlaying(mode);
    expect(mode.update(tick + 4, new Set())).toBeNull();
    expect(mode.update(tick + 5, new Set())).toBe('RESULTS_STARTED');
    expect(mode.createSnapshot().phase).toBe('RESULTS');
  });

  it('freezes standings and awards position points', () => {
    const mode = createMode();
    const tick = startPlaying(mode, 2);
    mode.update(tick + 1, new Set(['p2']));
    mode.update(tick + 2, new Set(['p2']));
    mode.update(tick + 5, new Set());
    const results = mode.createSnapshot().results;
    expect(results.map((result) => result.playerId)).toEqual(['p2', 'p1']);
    expect(results.map((result) => result.roundPoints)).toEqual([10, 7]);
    expect(results.map((result) => result.sessionPoints)).toEqual([10, 7]);
  });

  it('keeps session points cumulative over two rounds', () => {
    const mode = createMode();
    const firstPlaying = startPlaying(mode);
    mode.update(firstPlaying + 5, new Set());
    mode.nextRound('p1', firstPlaying + 6);
    mode.update(firstPlaying + 9, new Set());
    mode.update(firstPlaying + 14, new Set());
    expect(getPlayer(mode, 'p1').sessionPoints).toBe(20);
  });

  it('immediately activates a player joining during PLAYING', () => {
    const mode = createMode();
    startPlaying(mode);
    mode.addPlayer('late', 'Late Player');
    expect(getPlayer(mode, 'late').participant).toBe(true);
    expect(mode.canPlayerControl('late')).toBe(true);
  });

  it('promotes a late joiner to participant on next round', () => {
    const mode = createMode();
    const tick = startPlaying(mode);
    mode.update(tick + 5, new Set());
    mode.addPlayer('late', 'Late Player');
    expect(getPlayer(mode, 'late').participant).toBe(false);
    mode.nextRound('p1', tick + 6);
    expect(getPlayer(mode, 'late').participant).toBe(true);
  });

  it('removes a leaving player safely from active ranking', () => {
    const mode = createMode();
    startPlaying(mode, 2);
    mode.removePlayer('p2');
    expect(mode.createSnapshot().players.map((player) => player.playerId)).toEqual([
      'p1',
    ]);
  });

  it('keeps finalized results frozen when a player leaves after the round', () => {
    const mode = createMode();
    const tick = startPlaying(mode, 2);
    mode.update(tick + 5, new Set());
    const finalized = mode.createSnapshot().results;
    mode.removePlayer('p1');
    expect(mode.createSnapshot().results).toEqual(finalized);
  });

  it('disposes all state without timers or retained players', () => {
    const mode = createMode();
    addPlayers(mode, 2);
    mode.dispose();
    expect(mode.createSnapshot()).toMatchObject({
      hostPlayerId: null,
      players: [],
      results: [],
    });
  });

  it('includes authoritative gameplay state in a world snapshot', () => {
    const room = createRoom();
    room.addPlayer(createPlayer('p1'));
    const message: WorldSnapshotMessage = {
      type: 'world_snapshot',
      serverTick: 0,
      vehicles: room.createVehicleSnapshot(),
      convoy: room.createConvoySnapshot(),
      gameState: room.createGameStateSnapshot(),
    };
    const decoded = createClientCodec().decode(JSON.stringify(message));
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.value.type === 'world_snapshot') {
      expect(decoded.value.gameState.phase).toBe('LOBBY');
      expect(decoded.value.gameState.hostPlayerId).toBe('p1');
    }
  });

  it('never accepts client-authored trailer or session scores', () => {
    const codec = createServerCodec();
    const decoded = codec.decode(
      JSON.stringify({
        type: 'set_ready',
        ready: true,
        trailerTicks: 99_999,
        sessionPoints: 99_999,
        phase: 'RESULTS',
      }),
    );
    expect(decoded).toEqual({ ok: true, value: { type: 'set_ready', ready: true } });
  });

  it('establishes real deck scoring through GameRoom physics contacts', () => {
    const room = createRoom();
    const player = createPlayer('p1');
    room.addPlayer(player);
    room.startMatch(player.id);
    stepRoom(room, 1, 180);
    expect(room.createGameStateSnapshot().phase).toBe('PLAYING');
    room.teleportVehicleOntoTrailer(player.id);
    stepRoom(room, 181, 90);
    const vehicle = room.createVehicleSnapshot()[0];
    const gamePlayer = room.createGameStateSnapshot().players[0];
    expect(vehicle?.surfaceType).toBe('TRAILER_DECK');
    expect(vehicle?.trailerDeckContacts).toBeGreaterThanOrEqual(2);
    expect(gamePlayer?.trailerTicks).toBeGreaterThan(0);
  });
});

function createRoom(): GameRoom {
  const room = new GameRoom(`MODE${rooms.length}`);
  rooms.push(room);
  return room;
}

function createPlayer(id: string): ServerPlayer {
  return new ServerPlayer(id, `client-${id}`, `Player ${id}`);
}

function stepRoom(room: GameRoom, firstTick: number, count: number): void {
  for (let offset = 0; offset < count; offset += 1) {
    room.update(SIMULATION_FIXED_DELTA_SECONDS, firstTick + offset);
  }
}
