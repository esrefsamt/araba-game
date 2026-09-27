export const CLIENT_MESSAGE_TYPES = [
  'join_room',
  'reconnect_session',
  'leave_room',
  'ping',
  'player_input',
  'reset_vehicle',
  'self_right_vehicle',
  'set_ready',
  'start_match',
  'next_round',
  'debug_teleport_near_trailer',
  'debug_teleport_onto_trailer',
  'debug_flip_vehicle',
  'debug_test_underbody',
  'debug_test_player_collision',
] as const;
export type ClientMessageType = (typeof CLIENT_MESSAGE_TYPES)[number];

export const SERVER_MESSAGE_TYPES = [
  'connected',
  'session_resumed',
  'room_left',
  'room_joined',
  'player_joined',
  'player_left',
  'pong',
  'server_tick',
  'world_snapshot',
  'gameplay_event',
  'error',
] as const;
export type ServerMessageType = (typeof SERVER_MESSAGE_TYPES)[number];

export type ServerErrorCode =
  | 'INVALID_MESSAGE'
  | 'INVALID_PLAYER_NAME'
  | 'INVALID_ROOM'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ALREADY_IN_ROOM'
  | 'UNAUTHORIZED_ACTION'
  | 'INVALID_GAME_STATE'
  | 'INTERNAL_ERROR'
  | 'SESSION_EXPIRED'
  | 'SESSION_ACTIVE'
  | 'RATE_LIMITED';
