export interface JoinRoomMessage {
  type: 'join_room';
  playerName: string;
  roomId?: string;
}

export interface ReconnectSessionMessage {
  type: 'reconnect_session';
  sessionToken: string;
}

export interface LeaveRoomMessage {
  type: 'leave_room';
}

export interface PingMessage {
  type: 'ping';
  timestamp: number;
}

export interface PlayerInputMessage {
  type: 'player_input';
  sequence: number;
  throttle: number;
  brake: number;
  steering: number;
  handbrake: boolean;
}

export interface ResetVehicleMessage {
  type: 'reset_vehicle';
}

export interface SelfRightVehicleMessage {
  type: 'self_right_vehicle';
}

export interface SetReadyMessage {
  type: 'set_ready';
  ready: boolean;
}

export interface StartMatchMessage {
  type: 'start_match';
}

export interface NextRoundMessage {
  type: 'next_round';
}

export interface DebugTeleportNearTrailerMessage {
  type: 'debug_teleport_near_trailer';
}

export interface DebugTeleportOntoTrailerMessage {
  type: 'debug_teleport_onto_trailer';
}

export interface DebugFlipVehicleMessage {
  type: 'debug_flip_vehicle';
}

export interface DebugTestUnderbodyMessage {
  type: 'debug_test_underbody';
}

export interface DebugTestPlayerCollisionMessage {
  type: 'debug_test_player_collision';
}

export type ClientMessage =
  | JoinRoomMessage
  | ReconnectSessionMessage
  | LeaveRoomMessage
  | PingMessage
  | PlayerInputMessage
  | ResetVehicleMessage
  | SelfRightVehicleMessage
  | SetReadyMessage
  | StartMatchMessage
  | NextRoundMessage
  | DebugTeleportNearTrailerMessage
  | DebugTeleportOntoTrailerMessage
  | DebugFlipVehicleMessage
  | DebugTestUnderbodyMessage
  | DebugTestPlayerCollisionMessage;
