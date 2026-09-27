export type GamePhase = 'LOBBY' | 'COUNTDOWN' | 'PLAYING' | 'RESULTS';

export interface GamePlayerStateSnapshot {
  playerId: string;
  playerName: string;
  ready: boolean;
  participant: boolean;
  isScoringOnTrailer: boolean;
  trailerTicks: number;
  currentStreakTicks: number;
  bestStreakTicks: number;
  roundPoints: number;
  sessionPoints: number;
}

export interface RoundResultSnapshot {
  rank: number;
  playerId: string;
  playerName: string;
  trailerTicks: number;
  bestStreakTicks: number;
  roundPoints: number;
  sessionPoints: number;
}

export interface GameStateSnapshot {
  phase: GamePhase;
  hostPlayerId: string | null;
  roundNumber: number;
  stateStartTick: number;
  stateEndTick: number | null;
  players: GamePlayerStateSnapshot[];
  results: RoundResultSnapshot[];
}
