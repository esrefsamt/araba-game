import { POSITION_POINTS } from '@trailer-arena/shared';

export interface RankablePlayer {
  readonly playerId: string;
  readonly joinOrder: number;
  readonly trailerTicks: number;
  readonly bestStreakTicks: number;
}

export function rankPlayers<T extends RankablePlayer>(players: Iterable<T>): T[] {
  return Array.from(players).sort(
    (first, second) =>
      second.trailerTicks - first.trailerTicks ||
      second.bestStreakTicks - first.bestStreakTicks ||
      first.joinOrder - second.joinOrder ||
      first.playerId.localeCompare(second.playerId),
  );
}

export function pointsForRank(rank: number): number {
  return POSITION_POINTS[rank - 1] ?? 0;
}
