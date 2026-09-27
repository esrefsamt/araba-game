import { TRAILER_CONTACT_GRACE_TICKS } from '@trailer-arena/shared';
import type { SurfaceType } from '@trailer-arena/shared';

export interface TrailerScoreState {
  trailerTicks: number;
  currentStreakTicks: number;
  bestStreakTicks: number;
  isScoringOnTrailer: boolean;
  lastTrailerContactTick: number | null;
}

export function resetTrailerScore(state: TrailerScoreState): void {
  state.trailerTicks = 0;
  state.currentStreakTicks = 0;
  state.bestStreakTicks = 0;
  state.isScoringOnTrailer = false;
  state.lastTrailerContactTick = null;
}

export function updateTrailerScore(
  state: TrailerScoreState,
  tick: number,
  hasDeckSupport: boolean,
  graceTicks = TRAILER_CONTACT_GRACE_TICKS,
): void {
  if (hasDeckSupport) {
    state.lastTrailerContactTick = tick;
  }
  const withinGrace =
    state.lastTrailerContactTick !== null &&
    tick - state.lastTrailerContactTick <= graceTicks;
  state.isScoringOnTrailer = hasDeckSupport || withinGrace;
  if (!state.isScoringOnTrailer) {
    state.currentStreakTicks = 0;
    return;
  }
  state.trailerTicks += 1;
  state.currentStreakTicks += 1;
  state.bestStreakTicks = Math.max(state.bestStreakTicks, state.currentStreakTicks);
}

export function hasTrailerDeckScoringSupport(
  surfaceType: SurfaceType,
  trailerDeckContacts: number,
): boolean {
  return surfaceType === 'TRAILER_DECK' && trailerDeckContacts >= 2;
}
