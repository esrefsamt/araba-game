import { randomUUID } from 'node:crypto';

import {
  MAX_PLAYER_NAME_LENGTH,
  MIN_PLAYER_NAME_LENGTH,
  createServerCodec,
  SESSION_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  isSessionToken,
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
import { SessionRegistry, type PlayerSession } from './SessionRegistry.js';
import { serverLogger } from '../server/ServerLogger.js';

interface ClientConnection {
  readonly clientId: string;
  readonly socket: WebSocket;
  player: ServerPlayer | null;
  roomId: string | null;
  inputWindowStartedAt: number;
  inputMessagesInWindow: number;
  lastResetAt: number;
  lastSelfRightAt: number;
  session: PlayerSession;
  lastReceivedAt: number;
  lastHeartbeatAt: number;
  actionWindowStartedAt: number;
  actionsInWindow: number;
}

export interface ConnectionManagerOptions {
  graceMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  now?: () => number;
}

const MAX_INPUT_MESSAGES_PER_SECOND = 90;
const RESET_COOLDOWN_MS = 1_000;
const SELF_RIGHT_COOLDOWN_MS = 500;

export class ConnectionManager {
  private readonly connections = new Map<WebSocket, ClientConnection>();
  private readonly connectionsByPlayerId = new Map<string, ClientConnection>();
  private readonly codec: ProtocolCodec<ClientMessage, ServerMessage> =
    createServerCodec();
  private readonly sessions: SessionRegistry;
  private readonly graceMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly now: () => number;
  private nextMaintenanceAt = 0;
  private shuttingDown = false;

  public constructor(
    private readonly roomManager: RoomManager,
    options: ConnectionManagerOptions = {},
  ) {
    this.graceMs = options.graceMs ?? SESSION_GRACE_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.sessions = new SessionRegistry(this.graceMs);
  }

  public get sessionCount(): number {
    return this.sessions.size;
  }

  public maintainConnections(): void {
    const now = this.now();
    if (now < this.nextMaintenanceAt || this.shuttingDown) return;
    this.nextMaintenanceAt = now + 1_000;
    for (const connection of this.connections.values()) {
      if (now - connection.lastReceivedAt >= this.heartbeatTimeoutMs) {
        this.handleDisconnect(connection);
        connection.socket.terminate();
      } else if (
        now - connection.lastHeartbeatAt >= this.heartbeatIntervalMs &&
        connection.socket.readyState === WebSocket.OPEN
      ) {
        connection.lastHeartbeatAt = now;
        connection.socket.ping();
      }
    }
    this.expireSessions(now);
  }

  public shutdown(): void {
    this.shuttingDown = true;
    this.connections.clear();
    this.connectionsByPlayerId.clear();
    this.sessions.clear();
  }

  public handleConnection(socket: WebSocket): void {
    if (this.shuttingDown) {
      socket.close(1001, 'Server shutting down');
      return;
    }
    const clientId = `client_${randomUUID()}`;
    const now = this.now();
    const connection: ClientConnection = {
      clientId,
      socket,
      player: null,
      roomId: null,
      inputWindowStartedAt: Date.now(),
      inputMessagesInWindow: 0,
      lastResetAt: 0,
      lastSelfRightAt: 0,
      session: this.sessions.create(clientId),
      lastReceivedAt: now,
      lastHeartbeatAt: now,
      actionWindowStartedAt: now,
      actionsInWindow: 0,
    };
    this.connections.set(socket, connection);

    socket.on('message', (data, isBinary) => {
      this.handleRawMessage(connection, data, isBinary);
    });
    socket.on('close', () => {
      this.handleDisconnect(connection);
    });
    socket.on('pong', () => {
      connection.lastReceivedAt = this.now();
    });
    socket.on('error', (error) => {
      serverLogger.warn(`[network] ${connection.clientId} socket error:`, error.message);
    });

    this.send(connection, {
      type: 'connected',
      clientId: connection.clientId,
      sessionToken: connection.session.token,
      reconnectWindowMs: this.graceMs,
    });
    serverLogger.info(`[network] connected ${connection.clientId}`);
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
    // Messages already queued on a detached socket cannot control its resumed player.
    if (this.connections.get(connection.socket) !== connection || this.shuttingDown)
      return;
    connection.lastReceivedAt = this.now();
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
      serverLogger.error(
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
    if (
      (message.type === 'join_room' ||
        message.type === 'reconnect_session' ||
        message.type === 'leave_room') &&
      !this.allowSessionAction(connection)
    )
      return;
    switch (message.type) {
      case 'reconnect_session':
        this.handleReconnect(connection, message.sessionToken);
        break;
      case 'leave_room':
        this.handleLeaveRoom(connection);
        break;
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
    connection.session.player = player;
    connection.session.roomId = room.id;
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
    this.broadcastToRoom(room, room.createWorldSnapshot());
    serverLogger.info(`[room ${room.id}] joined ${player.name} (${player.id})`);
  }

  private handleReconnect(connection: ClientConnection, token: string): void {
    const now = this.now();
    this.expireSessions(now);
    if (connection.player !== null || !isSessionToken(token)) {
      this.sendError(
        connection,
        'SESSION_ACTIVE',
        'This connection already owns a session.',
      );
      return;
    }
    const session = this.sessions.get(token);
    if (session === undefined) {
      this.sendError(
        connection,
        'SESSION_EXPIRED',
        'Session expired or server restarted.',
      );
      return;
    }
    const active = Array.from(this.connections.values()).find(
      (other) => other.clientId === session.activeConnectionId,
    );
    if (
      active !== undefined &&
      (active.socket.readyState !== WebSocket.OPEN ||
        now - active.lastReceivedAt >= this.heartbeatTimeoutMs)
    ) {
      this.handleDisconnect(active);
      active.socket.terminate();
    }
    if (session.activeConnectionId !== null) {
      this.sendError(connection, 'SESSION_ACTIVE', 'This session is already connected.');
      return;
    }
    const room =
      session.roomId === null ? undefined : this.roomManager.getRoom(session.roomId);
    if (
      session.player !== null &&
      (room === undefined || !room.hasPlayer(session.player.id))
    ) {
      this.sessions.remove(session);
      this.sendError(connection, 'SESSION_EXPIRED', 'Room no longer exists.');
      return;
    }
    if (!this.sessions.claim(session, connection.clientId, now)) {
      this.sendError(connection, 'SESSION_EXPIRED', 'Reconnect window expired.');
      return;
    }
    this.sessions.remove(connection.session); // Discard this transport's provisional token.
    connection.session = session;
    connection.player = session.player;
    connection.roomId = session.roomId;
    if (session.player !== null && room !== undefined) {
      this.connectionsByPlayerId.set(session.player.id, connection);
      room.setPlayerConnected(session.player.id, true);
    }
    this.send(connection, {
      type: 'session_resumed',
      sessionToken: session.token,
      playerId: session.player?.id ?? null,
      roomId: session.roomId,
      state: room?.createWorldSnapshot() ?? null,
    });
  }

  private handleLeaveRoom(connection: ClientConnection): void {
    const { player, roomId } = connection;
    this.sessions.remove(connection.session);
    if (player !== null && roomId !== null) {
      this.connectionsByPlayerId.delete(player.id);
      const room = this.roomManager.getRoom(roomId);
      this.roomManager.leaveRoom(roomId, player.id);
      if (room !== undefined)
        this.broadcastToRoom(room, { type: 'player_left', playerId: player.id });
    }
    connection.player = null;
    connection.roomId = null;
    connection.session = this.sessions.create(connection.clientId);
    this.send(connection, { type: 'room_left', sessionToken: connection.session.token });
  }

  private allowSessionAction(connection: ClientConnection): boolean {
    const now = this.now();
    if (now - connection.actionWindowStartedAt >= 10_000) {
      connection.actionWindowStartedAt = now;
      connection.actionsInWindow = 0;
    }
    connection.actionsInWindow += 1;
    if (connection.actionsInWindow <= 6) return true;
    this.sendError(
      connection,
      'RATE_LIMITED',
      'Too many room/session requests. Please wait.',
    );
    return false;
  }

  private expireSessions(now: number): void {
    for (const session of this.sessions.expire(now)) {
      const { player, roomId } = session;
      if (player === null || roomId === null) continue;
      const room = this.roomManager.getRoom(roomId);
      this.roomManager.leaveRoom(roomId, player.id);
      if (room !== undefined)
        this.broadcastToRoom(room, { type: 'player_left', playerId: player.id });
    }
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
      room?.setPlayerConnected(player.id, false);
      serverLogger.info(`[room ${roomId}] grace started for ${player.id}`);
    }
    this.sessions.disconnect(connection.session, connection.clientId, this.now());
    serverLogger.info(`[network] disconnected ${connection.clientId}`);
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
      connection.socket.send(encoded, (error) => {
        if (error) {
          this.handleDisconnect(connection);
          connection.socket.terminate();
        }
      });
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
