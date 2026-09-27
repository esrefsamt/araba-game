export const CLIENT_MESSAGE_TYPES = [
  'join_room',
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
  'room_joined',
  'player_joined',
  'player_left',
  'pong',
  'server_tick',
  'world_snapshot',
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
  | 'INTERNAL_ERROR';
