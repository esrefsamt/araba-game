import { randomUUID } from 'node:crypto';

import {
  MAX_PLAYER_NAME_LENGTH,
  MIN_PLAYER_NAME_LENGTH,
  createServerCodec,
} from '@trailer-arena/shared';
import type {
  ClientMessage,
  ProtocolCodec,
  ServerErrorCode,
  ServerMessage,
} from '@trailer-arena/shared';
import WebSocket from 'ws';
import type { RawData } from 'ws';

import { ServerPlayer } from '../players/ServerPlayer.js';
import type { GameRoom } from '../rooms/GameRoom.js';
import type { RoomManager } from '../rooms/RoomManager.js';

interface ClientConnection {
  readonly clientId: string;
  readonly socket: WebSocket;
  player: ServerPlayer | null;
  roomId: string | null;
  inputWindowStartedAt: number;
  inputMessagesInWindow: number;
  lastResetAt: number;
  lastSelfRightAt: number;
}

const MAX_INPUT_MESSAGES_PER_SECOND = 90;
const RESET_COOLDOWN_MS = 1_000;
const SELF_RIGHT_COOLDOWN_MS = 500;

export class ConnectionManager {
  private readonly connections = new Map<WebSocket, ClientConnection>();
  private readonly connectionsByPlayerId = new Map<string, ClientConnection>();
  private readonly codec: ProtocolCodec<ClientMessage, ServerMessage> =
    createServerCodec();

  public constructor(private readonly roomManager: RoomManager) {}

  public handleConnection(socket: WebSocket): void {
    const connection: ClientConnection = {
      clientId: `client_${randomUUID()}`,
      socket,
      player: null,
      roomId: null,
      inputWindowStartedAt: Date.now(),
      inputMessagesInWindow: 0,
      lastResetAt: 0,
      lastSelfRightAt: 0,
    };
    this.connections.set(socket, connection);

    socket.on('message', (data, isBinary) => {
      this.handleRawMessage(connection, data, isBinary);
    });
    socket.on('close', () => {
      this.handleDisconnect(connection);
    });
    socket.on('error', (error) => {
      console.warn(`[network] ${connection.clientId} socket error:`, error.message);
    });

    this.send(connection, { type: 'connected', clientId: connection.clientId });
    console.info(`[network] connected ${connection.clientId}`);
  }

  public broadcast(message: ServerMessage): void {
    const encoded = this.codec.encode(message);
    for (const connection of this.connections.values()) {
      this.sendEncoded(connection, encoded);
    }
  }

  public broadcastToRoom(
    room: GameRoom,
    message: ServerMessage,
    excludedPlayerId?: string,
  ): void {
    const encoded = this.codec.encode(message);
    for (const player of room.getPlayers()) {
      if (player.id === excludedPlayerId) {
        continue;
      }
      const connection = this.connectionsByPlayerId.get(player.id);
      if (connection !== undefined) {
        this.sendEncoded(connection, encoded);
      }
    }
  }

  private handleRawMessage(
    connection: ClientConnection,
    data: RawData,
    isBinary: boolean,
  ): void {
    if (isBinary) {
      this.sendError(
        connection,
        'INVALID_MESSAGE',
        'Binary messages are not supported yet.',
      );
      return;
    }

    const decoded = this.codec.decode(rawDataToString(data));
    if (!decoded.ok) {
      this.sendError(connection, 'INVALID_MESSAGE', decoded.error);
      return;
    }

    try {
      this.handleMessage(connection, decoded.value);
    } catch (error: unknown) {
      console.error(
        `[network] message handling failed for ${connection.clientId}`,
        error,
      );
      this.sendError(
        connection,
        'INTERNAL_ERROR',
        'The server could not process the message.',
      );
    }
  }

  private handleMessage(connection: ClientConnection, message: ClientMessage): void {
    switch (message.type) {
      case 'ping':
        this.send(connection, { type: 'pong', timestamp: message.timestamp });
        break;
      case 'join_room':
        this.handleJoinRoom(connection, message.playerName, message.roomId);
        break;
      case 'player_input':
        this.handlePlayerInput(connection, message);
        break;
      case 'reset_vehicle':
        this.handleResetVehicle(connection);
        break;
      case 'self_right_vehicle':
        this.handleSelfRightVehicle(connection);
        break;
      case 'set_ready':
        this.handleSetReady(connection, message.ready);
        break;
      case 'start_match':
        this.handleStartMatch(connection);
        break;
      case 'next_round':
        this.handleNextRound(connection);
        break;
      case 'debug_teleport_near_trailer':
        this.handleDebugTeleportNearTrailer(connection);
        break;
      case 'debug_teleport_onto_trailer':
        this.handleDebugTeleportOntoTrailer(connection);
        break;
      case 'debug_flip_vehicle':
        this.handleDebugFlipVehicle(connection);
        break;
      case 'debug_test_underbody':
        this.handleDebugTestUnderbody(connection);
        break;
      case 'debug_test_player_collision':
        this.handleDebugTestPlayerCollision(connection);
        break;
    }
  }

  private handleJoinRoom(
    connection: ClientConnection,
    rawPlayerName: string,
    rawRoomId: string | undefined,
  ): void {
    if (connection.player !== null) {
      this.sendError(
        connection,
        'ALREADY_IN_ROOM',
        'This connection is already in a room.',
      );
      return;
    }

    const playerName = rawPlayerName.trim();
    if (!isValidPlayerName(playerName)) {
      this.sendError(
        connection,
        'INVALID_PLAYER_NAME',
        `Player name must contain ${MIN_PLAYER_NAME_LENGTH}-${MAX_PLAYER_NAME_LENGTH} visible characters.`,
      );
      return;
    }

    const player = new ServerPlayer(
      `player_${randomUUID()}`,
      connection.clientId,
      playerName,
    );

    let room: GameRoom;
    if (rawRoomId === undefined) {
      room = this.roomManager.createRoom();
      const result = room.addPlayer(player);
      if (!result.ok) {
        throw new Error(`New room rejected its first player: ${result.reason}`);
      }
    } else {
      const roomId = rawRoomId.trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(roomId)) {
        this.sendError(
          connection,
          'INVALID_ROOM',
          'Room code must be six letters or digits.',
        );
        return;
      }

      const result = this.roomManager.joinRoom(roomId, player);
      if (!result.ok) {
        const errorCode: ServerErrorCode =
          result.reason === 'ROOM_FULL' ? 'ROOM_FULL' : 'ROOM_NOT_FOUND';
        const errorMessage =
          result.reason === 'ROOM_FULL'
            ? 'The room is full.'
            : 'The room does not exist.';
        this.sendError(connection, errorCode, errorMessage);
        return;
      }
      room = result.room;
    }

    connection.player = player;
    connection.roomId = room.id;
    this.connectionsByPlayerId.set(player.id, connection);

    this.send(connection, {
      type: 'room_joined',
      roomId: room.id,
      playerId: player.id,
    });

    for (const existingPlayer of room.getPlayers()) {
      if (existingPlayer.id !== player.id) {
        this.send(connection, {
          type: 'player_joined',
          playerId: existingPlayer.id,
          playerName: existingPlayer.name,
        });
      }
    }

    this.broadcastToRoom(
      room,
      {
        type: 'player_joined',
        playerId: player.id,
        playerName: player.name,
      },
      player.id,
    );
    console.info(`[room ${room.id}] joined ${player.name} (${player.id})`);
  }

  private handlePlayerInput(
    connection: ClientConnection,
    message: Extract<ClientMessage, { type: 'player_input' }>,
  ): void {
    const { player, roomId } = connection;
    if (player === null || roomId === null || !this.allowInputMessage(connection)) {
      return;
    }
    this.roomManager.getRoom(roomId)?.applyPlayerInput(player.id, message);
  }

  private handleResetVehicle(connection: ClientConnection): void {
    const { player, roomId } = connection;
    const now = Date.now();
    if (
      player === null ||
      roomId === null ||
      now - connection.lastResetAt < RESET_COOLDOWN_MS
    ) {
      return;
    }
    connection.lastResetAt = now;
    this.roomManager.getRoom(roomId)?.resetVehicle(player.id);
  }

  private handleSelfRightVehicle(connection: ClientConnection): void {
    const { player, roomId } = connection;
    const now = Date.now();
    if (
      player === null ||
      roomId === null ||
      now - connection.lastSelfRightAt < SELF_RIGHT_COOLDOWN_MS
    ) {
      return;
    }
    connection.lastSelfRightAt = now;
    this.roomManager.getRoom(roomId)?.selfRightVehicle(player.id);
  }

  private handleSetReady(connection: ClientConnection, ready: boolean): void {
    const { player, roomId } = connection;
    if (player === null || roomId === null) return;
    if (!this.roomManager.getRoom(roomId)?.setPlayerReady(player.id, ready)) {
      this.sendError(
        connection,
        'INVALID_GAME_STATE',
        'Ready state can only be changed in the lobby.',
      );
    }
  }

  private handleStartMatch(connection: ClientConnection): void {
    const { player, roomId } = connection;
    if (player === null || roomId === null) return;
    const result = this.roomManager.getRoom(roomId)?.startMatch(player.id);
    if (result !== undefined && !result.ok) {
      this.sendGameActionError(connection, result.reason);
    }
  }

  private handleNextRound(connection: ClientConnection): void {
    const { player, roomId } = connection;
    if (player === null || roomId === null) return;
    const result = this.roomManager.getRoom(roomId)?.startNextRound(player.id);
    if (result !== undefined && !result.ok) {
      this.sendGameActionError(connection, result.reason);
    }
  }

  private sendGameActionError(
    connection: ClientConnection,
    reason: 'NOT_HOST' | 'INVALID_PHASE' | 'NOT_READY' | 'NO_PLAYER',
  ): void {
    if (reason === 'NOT_HOST') {
      this.sendError(
        connection,
        'UNAUTHORIZED_ACTION',
        'Only the room host can do that.',
      );
      return;
    }
    const message =
      reason === 'NOT_READY'
        ? 'All players must be ready before the match starts.'
        : 'That action is not available in the current match phase.';
    this.sendError(connection, 'INVALID_GAME_STATE', message);
  }

  private handleDebugTeleportNearTrailer(connection: ClientConnection): void {
    if (process.env['NODE_ENV'] === 'production') {
      return;
    }
    const { player, roomId } = connection;
    if (player === null || roomId === null) {
      return;
    }
    this.roomManager.getRoom(roomId)?.teleportVehicleNearTrailer(player.id);
  }

  private handleDebugTeleportOntoTrailer(connection: ClientConnection): void {
    if (process.env['NODE_ENV'] === 'production') {
      return;
    }
    const { player, roomId } = connection;
    if (player !== null && roomId !== null) {
      this.roomManager.getRoom(roomId)?.teleportVehicleOntoTrailer(player.id);
    }
  }

  private handleDebugFlipVehicle(connection: ClientConnection): void {
    if (process.env['NODE_ENV'] === 'production') {
      return;
    }
    const { player, roomId } = connection;
    if (player !== null && roomId !== null) {
      this.roomManager.getRoom(roomId)?.debugFlipVehicle(player.id);
    }
  }

  private handleDebugTestUnderbody(connection: ClientConnection): void {
    if (process.env['NODE_ENV'] === 'production') {
      return;
    }
    const { player, roomId } = connection;
    if (player !== null && roomId !== null) {
      this.roomManager.getRoom(roomId)?.debugTestUnderbody(player.id);
    }
  }

  private handleDebugTestPlayerCollision(connection: ClientConnection): void {
    if (process.env['NODE_ENV'] === 'production') {
      return;
    }
    const { player, roomId } = connection;
    if (player !== null && roomId !== null) {
      this.roomManager.getRoom(roomId)?.debugTestPlayerCollision(player.id);
    }
  }

  private allowInputMessage(connection: ClientConnection): boolean {
    const now = Date.now();
    if (now - connection.inputWindowStartedAt >= 1_000) {
      connection.inputWindowStartedAt = now;
      connection.inputMessagesInWindow = 0;
    }
    connection.inputMessagesInWindow += 1;
    return connection.inputMessagesInWindow <= MAX_INPUT_MESSAGES_PER_SECOND;
  }

  private handleDisconnect(connection: ClientConnection): void {
    if (!this.connections.delete(connection.socket)) {
      return;
    }

    const { player, roomId } = connection;
    if (player !== null && roomId !== null) {
      this.connectionsByPlayerId.delete(player.id);
      const room = this.roomManager.getRoom(roomId);
      this.roomManager.leaveRoom(roomId, player.id);
      if (room !== undefined) {
        this.broadcastToRoom(room, { type: 'player_left', playerId: player.id });
      }
      console.info(`[room ${roomId}] left ${player.name} (${player.id})`);
    }
    console.info(`[network] disconnected ${connection.clientId}`);
  }

  private sendError(
    connection: ClientConnection,
    code: ServerErrorCode,
    message: string,
  ): void {
    this.send(connection, { type: 'error', code, message });
  }

  private send(connection: ClientConnection, message: ServerMessage): void {
    this.sendEncoded(connection, this.codec.encode(message));
  }

  private sendEncoded(connection: ClientConnection, encoded: string): void {
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(encoded);
    }
  }
}

function isValidPlayerName(playerName: string): boolean {
  const characters = Array.from(playerName);
  const containsControlCharacter = characters.some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  return (
    characters.length >= MIN_PLAYER_NAME_LENGTH &&
    characters.length <= MAX_PLAYER_NAME_LENGTH &&
    !containsControlCharacter
  );
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return data.toString('utf8');
}
