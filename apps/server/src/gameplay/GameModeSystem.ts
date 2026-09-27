import {
  COUNTDOWN_TICKS,
  ROUND_DURATION_TICKS,
  TRAILER_CONTACT_GRACE_TICKS,
} from '@trailer-arena/shared';
import type {
  GamePhase,
  GamePlayerStateSnapshot,
  GameStateSnapshot,
  RoundResultSnapshot,
} from '@trailer-arena/shared';

import { pointsForRank, rankPlayers } from './RankingSystem.js';
import {
  resetTrailerScore,
  updateTrailerScore,
  type TrailerScoreState,
} from './TrailerScoringSystem.js';

interface PlayerGameState extends TrailerScoreState {
  readonly playerId: string;
  readonly playerName: string;
  readonly joinOrder: number;
  ready: boolean;
  participant: boolean;
  roundPoints: number;
  sessionPoints: number;
}

export type GameModeTransition = 'PLAYING_STARTED' | 'RESULTS_STARTED' | null;
export type GameActionResult =
  | { ok: true }
  | { ok: false; reason: 'NOT_HOST' | 'INVALID_PHASE' | 'NOT_READY' | 'NO_PLAYER' };

export interface GameModeOptions {
  countdownTicks?: number;
  roundDurationTicks?: number;
  contactGraceTicks?: number;
}

export class GameModeSystem {
  private readonly players = new Map<string, PlayerGameState>();
  private readonly countdownTicks: number;
  private readonly roundDurationTicks: number;
  private readonly contactGraceTicks: number;
  private phase: GamePhase = 'LOBBY';
  private hostPlayerId: string | null = null;
  private roundNumber = 0;
  private stateStartTick = 0;
  private stateEndTick: number | null = null;
  private joinSequence = 0;
  private results: RoundResultSnapshot[] = [];

  public constructor(options: GameModeOptions = {}) {
    this.countdownTicks = options.countdownTicks ?? COUNTDOWN_TICKS;
    this.roundDurationTicks = options.roundDurationTicks ?? ROUND_DURATION_TICKS;
    this.contactGraceTicks = options.contactGraceTicks ?? TRAILER_CONTACT_GRACE_TICKS;
  }

  public get currentPhase(): GamePhase {
    return this.phase;
  }

  public get currentHostPlayerId(): string | null {
    return this.hostPlayerId;
  }

  public addPlayer(playerId: string, playerName: string): void {
    if (this.players.has(playerId)) return;
    const participant = this.phase === 'LOBBY';
    this.players.set(playerId, {
      playerId,
      playerName,
      joinOrder: this.joinSequence,
      ready: false,
      participant,
      trailerTicks: 0,
      currentStreakTicks: 0,
      bestStreakTicks: 0,
      isScoringOnTrailer: false,
      lastTrailerContactTick: null,
      roundPoints: 0,
      sessionPoints: 0,
    });
    this.joinSequence += 1;
    this.hostPlayerId ??= playerId;
  }

  public removePlayer(playerId: string): void {
    if (!this.players.delete(playerId)) return;
    if (this.hostPlayerId === playerId) {
      this.hostPlayerId =
        Array.from(this.players.values()).sort(
          (first, second) => first.joinOrder - second.joinOrder,
        )[0]?.playerId ?? null;
    }
  }

  public setReady(playerId: string, ready: boolean): boolean {
    const player = this.players.get(playerId);
    if (player === undefined || this.phase !== 'LOBBY') return false;
    player.ready = ready;
    return true;
  }

  public startMatch(playerId: string, tick: number): GameActionResult {
    if (!this.players.has(playerId)) return { ok: false, reason: 'NO_PLAYER' };
    if (playerId !== this.hostPlayerId) return { ok: false, reason: 'NOT_HOST' };
    if (this.phase !== 'LOBBY') return { ok: false, reason: 'INVALID_PHASE' };
    if (!this.canStartMatch()) return { ok: false, reason: 'NOT_READY' };
    this.beginCountdown(tick);
    return { ok: true };
  }

  public nextRound(playerId: string, tick: number): GameActionResult {
    if (!this.players.has(playerId)) return { ok: false, reason: 'NO_PLAYER' };
    if (playerId !== this.hostPlayerId) return { ok: false, reason: 'NOT_HOST' };
    if (this.phase !== 'RESULTS') return { ok: false, reason: 'INVALID_PHASE' };
    this.beginCountdown(tick);
    return { ok: true };
  }

  public update(
    tick: number,
    deckSupportedPlayerIds: ReadonlySet<string>,
  ): GameModeTransition {
    let transition: GameModeTransition = null;
    if (
      this.phase === 'COUNTDOWN' &&
      this.stateEndTick !== null &&
      tick >= this.stateEndTick
    ) {
      this.phase = 'PLAYING';
      this.stateStartTick = tick;
      this.stateEndTick = tick + this.roundDurationTicks;
      transition = 'PLAYING_STARTED';
    }

    if (this.phase !== 'PLAYING') return transition;
    if (this.stateEndTick !== null && tick >= this.stateEndTick) {
      this.finishRound(tick);
      return 'RESULTS_STARTED';
    }

    for (const player of this.players.values()) {
      if (!player.participant) continue;
      updateTrailerScore(
        player,
        tick,
        deckSupportedPlayerIds.has(player.playerId),
        this.contactGraceTicks,
      );
    }
    return transition;
  }

  public canPlayerControl(playerId: string): boolean {
    return this.phase === 'PLAYING' && (this.players.get(playerId)?.participant ?? false);
  }

  public createSnapshot(): GameStateSnapshot {
    const orderedPlayers =
      this.phase === 'LOBBY'
        ? Array.from(this.players.values()).sort(
            (first, second) => first.joinOrder - second.joinOrder,
          )
        : rankPlayers(this.players.values());
    return {
      phase: this.phase,
      hostPlayerId: this.hostPlayerId,
      roundNumber: this.roundNumber,
      stateStartTick: this.stateStartTick,
      stateEndTick: this.stateEndTick,
      players: orderedPlayers.map(toPlayerSnapshot),
      results: this.results.map((result) => ({ ...result })),
    };
  }

  public dispose(): void {
    this.players.clear();
    this.results = [];
    this.hostPlayerId = null;
  }

  private canStartMatch(): boolean {
    if (this.players.size === 0) return false;
    if (this.players.size === 1) return true;
    return Array.from(this.players.values()).every((player) => player.ready);
  }

  private beginCountdown(tick: number): void {
    this.phase = 'COUNTDOWN';
    this.stateStartTick = tick;
    this.stateEndTick = tick + this.countdownTicks;
    this.roundNumber += 1;
    this.results = [];
    for (const player of this.players.values()) {
      player.participant = true;
      player.ready = false;
      player.roundPoints = 0;
      resetTrailerScore(player);
    }
  }

  private finishRound(tick: number): void {
    this.phase = 'RESULTS';
    this.stateStartTick = tick;
    this.stateEndTick = null;
    const standings = rankPlayers(
      Array.from(this.players.values()).filter((player) => player.participant),
    );
    this.results = standings.map((player, index) => {
      player.isScoringOnTrailer = false;
      const roundPoints = pointsForRank(index + 1);
      player.roundPoints = roundPoints;
      player.sessionPoints += roundPoints;
      return {
        rank: index + 1,
        playerId: player.playerId,
        playerName: player.playerName,
        trailerTicks: player.trailerTicks,
        bestStreakTicks: player.bestStreakTicks,
        roundPoints,
        sessionPoints: player.sessionPoints,
      };
    });
  }
}

function toPlayerSnapshot(player: PlayerGameState): GamePlayerStateSnapshot {
  return {
    playerId: player.playerId,
    playerName: player.playerName,
    ready: player.ready,
    participant: player.participant,
    isScoringOnTrailer: player.isScoringOnTrailer,
    trailerTicks: player.trailerTicks,
    currentStreakTicks: player.currentStreakTicks,
    bestStreakTicks: player.bestStreakTicks,
    roundPoints: player.roundPoints,
    sessionPoints: player.sessionPoints,
  };
}
