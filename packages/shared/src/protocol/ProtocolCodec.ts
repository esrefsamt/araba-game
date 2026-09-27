import type { ClientMessage } from './ClientMessages.js';
import type { ServerErrorCode } from './MessageTypes.js';
import type { ServerMessage } from './ServerMessages.js';
import type { ConvoyStateSnapshot, RigidBodyStateSnapshot } from '../types/Convoy.js';
import type {
  GamePlayerStateSnapshot,
  GameStateSnapshot,
  RoundResultSnapshot,
} from '../types/GameMode.js';
import type {
  QuaternionTuple,
  Vector3Tuple,
  VehicleStateSnapshot,
} from '../types/Vehicle.js';

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ProtocolCodec<Inbound, Outbound> {
  decode(rawMessage: string): DecodeResult<Inbound>;
  encode(message: Outbound): string;
}

type Decoder<T> = (value: unknown) => DecodeResult<T>;

const SERVER_ERROR_CODES = new Set<ServerErrorCode>([
  'INVALID_MESSAGE',
  'INVALID_PLAYER_NAME',
  'INVALID_ROOM',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'ALREADY_IN_ROOM',
  'UNAUTHORIZED_ACTION',
  'INVALID_GAME_STATE',
  'INTERNAL_ERROR',
]);

class JsonProtocolCodec<Inbound, Outbound> implements ProtocolCodec<Inbound, Outbound> {
  public constructor(private readonly decoder: Decoder<Inbound>) {}

  public decode(rawMessage: string): DecodeResult<Inbound> {
    try {
      return this.decoder(JSON.parse(rawMessage) as unknown);
    } catch {
      return { ok: false, error: 'Message is not valid JSON.' };
    }
  }

  public encode(message: Outbound): string {
    return JSON.stringify(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeClientMessage(value: unknown): DecodeResult<ClientMessage> {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return { ok: false, error: 'Message must be an object with a type.' };
  }

  switch (value.type) {
    case 'join_room': {
      if (typeof value.playerName !== 'string') {
        return { ok: false, error: 'join_room requires a playerName string.' };
      }
      if (value.roomId !== undefined && typeof value.roomId !== 'string') {
        return { ok: false, error: 'roomId must be a string when provided.' };
      }

      const message: ClientMessage =
        value.roomId === undefined
          ? { type: 'join_room', playerName: value.playerName }
          : {
              type: 'join_room',
              playerName: value.playerName,
              roomId: value.roomId,
            };
      return { ok: true, value: message };
    }
    case 'ping':
      if (typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp)) {
        return { ok: false, error: 'ping requires a finite timestamp.' };
      }
      return { ok: true, value: { type: 'ping', timestamp: value.timestamp } };
    case 'player_input':
      if (
        typeof value.sequence !== 'number' ||
        !Number.isSafeInteger(value.sequence) ||
        value.sequence < 0 ||
        !isFiniteNumber(value.throttle) ||
        !isFiniteNumber(value.brake) ||
        !isFiniteNumber(value.steering) ||
        typeof value.handbrake !== 'boolean'
      ) {
        return {
          ok: false,
          error: 'player_input requires a valid sequence and finite input values.',
        };
      }
      return {
        ok: true,
        value: {
          type: 'player_input',
          sequence: value.sequence,
          throttle: value.throttle,
          brake: value.brake,
          steering: value.steering,
          handbrake: value.handbrake,
        },
      };
    case 'reset_vehicle':
      return { ok: true, value: { type: 'reset_vehicle' } };
    case 'self_right_vehicle':
      return { ok: true, value: { type: 'self_right_vehicle' } };
    case 'set_ready':
      return typeof value.ready === 'boolean'
        ? { ok: true, value: { type: 'set_ready', ready: value.ready } }
        : { ok: false, error: 'set_ready requires a ready boolean.' };
    case 'start_match':
      return { ok: true, value: { type: 'start_match' } };
    case 'next_round':
      return { ok: true, value: { type: 'next_round' } };
    case 'debug_teleport_near_trailer':
      return { ok: true, value: { type: 'debug_teleport_near_trailer' } };
    case 'debug_teleport_onto_trailer':
      return { ok: true, value: { type: 'debug_teleport_onto_trailer' } };
    case 'debug_flip_vehicle':
      return { ok: true, value: { type: 'debug_flip_vehicle' } };
    case 'debug_test_underbody':
      return { ok: true, value: { type: 'debug_test_underbody' } };
    case 'debug_test_player_collision':
      return { ok: true, value: { type: 'debug_test_player_collision' } };
    default:
      return { ok: false, error: `Unknown message type: ${value.type}` };
  }
}

function decodeServerMessage(value: unknown): DecodeResult<ServerMessage> {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return { ok: false, error: 'Server message must be an object with a type.' };
  }

  switch (value.type) {
    case 'connected':
      return typeof value.clientId === 'string'
        ? { ok: true, value: { type: 'connected', clientId: value.clientId } }
        : { ok: false, error: 'connected requires clientId.' };
    case 'room_joined':
      return typeof value.roomId === 'string' && typeof value.playerId === 'string'
        ? {
            ok: true,
            value: {
              type: 'room_joined',
              roomId: value.roomId,
              playerId: value.playerId,
            },
          }
        : { ok: false, error: 'room_joined requires roomId and playerId.' };
    case 'player_joined':
      return typeof value.playerId === 'string' && typeof value.playerName === 'string'
        ? {
            ok: true,
            value: {
              type: 'player_joined',
              playerId: value.playerId,
              playerName: value.playerName,
            },
          }
        : { ok: false, error: 'player_joined requires player data.' };
    case 'player_left':
      return typeof value.playerId === 'string'
        ? { ok: true, value: { type: 'player_left', playerId: value.playerId } }
        : { ok: false, error: 'player_left requires playerId.' };
    case 'pong':
      return typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)
        ? { ok: true, value: { type: 'pong', timestamp: value.timestamp } }
        : { ok: false, error: 'pong requires a finite timestamp.' };
    case 'server_tick':
      return typeof value.tick === 'number' &&
        Number.isSafeInteger(value.tick) &&
        value.tick >= 0
        ? { ok: true, value: { type: 'server_tick', tick: value.tick } }
        : { ok: false, error: 'server_tick requires a non-negative integer.' };
    case 'world_snapshot': {
      if (
        typeof value.serverTick !== 'number' ||
        !Number.isSafeInteger(value.serverTick) ||
        value.serverTick < 0 ||
        !Array.isArray(value.vehicles)
      ) {
        return { ok: false, error: 'world_snapshot has invalid metadata.' };
      }

      const vehicles: VehicleStateSnapshot[] = [];
      for (const vehicle of value.vehicles) {
        const decodedVehicle = decodeVehicleSnapshot(vehicle);
        if (decodedVehicle === null) {
          return { ok: false, error: 'world_snapshot contains invalid vehicle data.' };
        }
        vehicles.push(decodedVehicle);
      }
      const convoy = decodeConvoySnapshot(value.convoy);
      if (convoy === null) {
        return { ok: false, error: 'world_snapshot contains invalid convoy data.' };
      }
      const gameState = decodeGameStateSnapshot(value.gameState);
      if (gameState === null) {
        return { ok: false, error: 'world_snapshot contains invalid game state.' };
      }
      return {
        ok: true,
        value: {
          type: 'world_snapshot',
          serverTick: value.serverTick,
          vehicles,
          convoy,
          gameState,
        },
      };
    }
    case 'error':
      return isServerErrorCode(value.code) && typeof value.message === 'string'
        ? {
            ok: true,
            value: {
              type: 'error',
              code: value.code,
              message: value.message,
            },
          }
        : { ok: false, error: 'error requires code and message.' };
    default:
      return { ok: false, error: `Unknown server message type: ${value.type}` };
  }
}

function decodeVehicleSnapshot(value: unknown): VehicleStateSnapshot | null {
  if (!isRecord(value) || typeof value.playerId !== 'string') {
    return null;
  }

  const position = decodeVector3(value.position);
  const rotation = decodeQuaternion(value.rotation);
  const linearVelocity = decodeVector3(value.linearVelocity);
  const angularVelocity = decodeVector3(value.angularVelocity);
  const trailerRelativePosition = decodeVector3(value.trailerRelativePosition);
  if (
    position === null ||
    rotation === null ||
    linearVelocity === null ||
    angularVelocity === null ||
    trailerRelativePosition === null ||
    !isIntegerAtLeast(value.lastProcessedInputSequence, -1) ||
    !isFiniteNumber(value.forwardSpeed) ||
    !isFiniteNumber(value.lateralSpeed) ||
    typeof value.grounded !== 'boolean' ||
    !isSurfaceType(value.surfaceType) ||
    typeof value.onTrailer !== 'boolean' ||
    !isFiniteNumber(value.relativeForwardSpeed) ||
    !isFiniteNumber(value.relativeLateralSpeed) ||
    typeof value.wheelContacts !== 'number' ||
    !Number.isSafeInteger(value.wheelContacts) ||
    value.wheelContacts < 0 ||
    value.wheelContacts > 4 ||
    typeof value.trailerDeckContacts !== 'number' ||
    !Number.isSafeInteger(value.trailerDeckContacts) ||
    value.trailerDeckContacts < 0 ||
    value.trailerDeckContacts > 4 ||
    typeof value.flipped !== 'boolean' ||
    typeof value.selfRightAvailable !== 'boolean' ||
    !isNonNegativeInteger(value.ramSlideRemainingTicks)
  ) {
    return null;
  }

  return {
    playerId: value.playerId,
    lastProcessedInputSequence: value.lastProcessedInputSequence,
    position,
    rotation,
    linearVelocity,
    angularVelocity,
    forwardSpeed: value.forwardSpeed,
    lateralSpeed: value.lateralSpeed,
    grounded: value.grounded,
    surfaceType: value.surfaceType,
    onTrailer: value.onTrailer,
    relativeForwardSpeed: value.relativeForwardSpeed,
    relativeLateralSpeed: value.relativeLateralSpeed,
    wheelContacts: value.wheelContacts,
    trailerDeckContacts: value.trailerDeckContacts,
    trailerRelativePosition,
    flipped: value.flipped,
    selfRightAvailable: value.selfRightAvailable,
    ramSlideRemainingTicks: value.ramSlideRemainingTicks,
  };
}

function decodeConvoySnapshot(value: unknown): ConvoyStateSnapshot | null {
  if (
    !isRecord(value) ||
    !isFiniteNumber(value.pathProgress) ||
    value.pathProgress < 0 ||
    value.pathProgress >= 1 ||
    !isFiniteNumber(value.speed)
  ) {
    return null;
  }
  const truck = decodeRigidBodySnapshot(value.truck);
  const trailer = decodeRigidBodySnapshot(value.trailer);
  return truck === null || trailer === null
    ? null
    : { pathProgress: value.pathProgress, speed: value.speed, truck, trailer };
}

function decodeRigidBodySnapshot(value: unknown): RigidBodyStateSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const position = decodeVector3(value.position);
  const rotation = decodeQuaternion(value.rotation);
  const linearVelocity = decodeVector3(value.linearVelocity);
  const angularVelocity = decodeVector3(value.angularVelocity);
  return position === null ||
    rotation === null ||
    linearVelocity === null ||
    angularVelocity === null
    ? null
    : { position, rotation, linearVelocity, angularVelocity };
}

function isSurfaceType(value: unknown): value is VehicleStateSnapshot['surfaceType'] {
  return (
    value === 'AIR' ||
    value === 'GROUND' ||
    value === 'TRAILER_DECK' ||
    value === 'TRAILER_RAMP'
  );
}

function decodeGameStateSnapshot(value: unknown): GameStateSnapshot | null {
  if (
    !isRecord(value) ||
    !isGamePhase(value.phase) ||
    (value.hostPlayerId !== null && typeof value.hostPlayerId !== 'string') ||
    !isNonNegativeInteger(value.roundNumber) ||
    !isNonNegativeInteger(value.stateStartTick) ||
    (value.stateEndTick !== null && !isNonNegativeInteger(value.stateEndTick)) ||
    !Array.isArray(value.players) ||
    !Array.isArray(value.results)
  ) {
    return null;
  }

  const players: GamePlayerStateSnapshot[] = [];
  for (const player of value.players) {
    const decoded = decodeGamePlayerState(player);
    if (decoded === null) return null;
    players.push(decoded);
  }
  const results: RoundResultSnapshot[] = [];
  for (const result of value.results) {
    const decoded = decodeRoundResult(result);
    if (decoded === null) return null;
    results.push(decoded);
  }
  return {
    phase: value.phase,
    hostPlayerId: value.hostPlayerId,
    roundNumber: value.roundNumber,
    stateStartTick: value.stateStartTick,
    stateEndTick: value.stateEndTick,
    players,
    results,
  };
}

function decodeGamePlayerState(value: unknown): GamePlayerStateSnapshot | null {
  if (
    !isRecord(value) ||
    typeof value.playerId !== 'string' ||
    typeof value.playerName !== 'string' ||
    typeof value.ready !== 'boolean' ||
    typeof value.participant !== 'boolean' ||
    typeof value.isScoringOnTrailer !== 'boolean' ||
    !isNonNegativeInteger(value.trailerTicks) ||
    !isNonNegativeInteger(value.currentStreakTicks) ||
    !isNonNegativeInteger(value.bestStreakTicks) ||
    !isNonNegativeInteger(value.roundPoints) ||
    !isNonNegativeInteger(value.sessionPoints)
  ) {
    return null;
  }
  return {
    playerId: value.playerId,
    playerName: value.playerName,
    ready: value.ready,
    participant: value.participant,
    isScoringOnTrailer: value.isScoringOnTrailer,
    trailerTicks: value.trailerTicks,
    currentStreakTicks: value.currentStreakTicks,
    bestStreakTicks: value.bestStreakTicks,
    roundPoints: value.roundPoints,
    sessionPoints: value.sessionPoints,
  };
}

function decodeRoundResult(value: unknown): RoundResultSnapshot | null {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.rank) ||
    value.rank < 1 ||
    typeof value.playerId !== 'string' ||
    typeof value.playerName !== 'string' ||
    !isNonNegativeInteger(value.trailerTicks) ||
    !isNonNegativeInteger(value.bestStreakTicks) ||
    !isNonNegativeInteger(value.roundPoints) ||
    !isNonNegativeInteger(value.sessionPoints)
  ) {
    return null;
  }
  return {
    rank: value.rank,
    playerId: value.playerId,
    playerName: value.playerName,
    trailerTicks: value.trailerTicks,
    bestStreakTicks: value.bestStreakTicks,
    roundPoints: value.roundPoints,
    sessionPoints: value.sessionPoints,
  };
}

function isGamePhase(value: unknown): value is GameStateSnapshot['phase'] {
  return (
    value === 'LOBBY' ||
    value === 'COUNTDOWN' ||
    value === 'PLAYING' ||
    value === 'RESULTS'
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function decodeVector3(value: unknown): Vector3Tuple | null {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !isFiniteNumber(value[0]) ||
    !isFiniteNumber(value[1]) ||
    !isFiniteNumber(value[2])
  ) {
    return null;
  }
  return [value[0], value[1], value[2]];
}

function decodeQuaternion(value: unknown): QuaternionTuple | null {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !isFiniteNumber(value[0]) ||
    !isFiniteNumber(value[1]) ||
    !isFiniteNumber(value[2]) ||
    !isFiniteNumber(value[3])
  ) {
    return null;
  }
  return [value[0], value[1], value[2], value[3]];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isServerErrorCode(value: unknown): value is ServerErrorCode {
  return typeof value === 'string' && SERVER_ERROR_CODES.has(value as ServerErrorCode);
}

export function createClientCodec(): ProtocolCodec<ServerMessage, ClientMessage> {
  return new JsonProtocolCodec(decodeServerMessage);
}

export function createServerCodec(): ProtocolCodec<ClientMessage, ServerMessage> {
  return new JsonProtocolCodec(decodeClientMessage);
}
