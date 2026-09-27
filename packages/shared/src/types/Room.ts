import type { PlayerSummary } from './Player.js';

export type RoomId = string;

export interface RoomSummary {
  roomId: RoomId;
  players: readonly PlayerSummary[];
}
