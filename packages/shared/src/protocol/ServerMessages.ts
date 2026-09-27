import type { ServerErrorCode } from './MessageTypes.js';
import type { ConvoyStateSnapshot } from '../types/Convoy.js';
import type { Vector3Tuple, VehicleStateSnapshot } from '../types/Vehicle.js';
import type { GameStateSnapshot } from '../types/GameMode.js';

export interface ConnectedMessage {
  type: 'connected';
  clientId: string;
  sessionToken: string;
  reconnectWindowMs: number;
}

export interface SessionResumedMessage {
  type: 'session_resumed';
  sessionToken: string;
  roomId: string | null;
  playerId: string | null;
  state: WorldSnapshotMessage | null;
}

export interface RoomLeftMessage {
  type: 'room_left';
  sessionToken: string;
}

export interface RoomJoinedMessage {
  type: 'room_joined';
  roomId: string;
  playerId: string;
}

export interface PlayerJoinedMessage {
  type: 'player_joined';
  playerId: string;
  playerName: string;
}

export interface PlayerLeftMessage {
  type: 'player_left';
  playerId: string;
}

export interface PongMessage {
  type: 'pong';
  timestamp: number;
}

export interface ServerTickMessage {
  type: 'server_tick';
  tick: number;
}

export interface WorldSnapshotMessage {
  type: 'world_snapshot';
  serverTick: number;
  vehicles: VehicleStateSnapshot[];
  convoy: ConvoyStateSnapshot;
  gameState: GameStateSnapshot;
}

export interface RamHitGameplayEvent {
  eventType: 'ram_hit';
  eventId: string;
  attackerPlayerId: string;
  targetPlayerId: string;
  strength: number;
  position: Vector3Tuple;
}

export interface GameplayEventMessage {
  type: 'gameplay_event';
  event: RamHitGameplayEvent;
}

export interface ErrorMessage {
  type: 'error';
  code: ServerErrorCode;
  message: string;
}

export type ServerMessage =
  | ConnectedMessage
  | SessionResumedMessage
  | RoomLeftMessage
  | RoomJoinedMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | PongMessage
  | ServerTickMessage
  | WorldSnapshotMessage
  | GameplayEventMessage
  | ErrorMessage;
