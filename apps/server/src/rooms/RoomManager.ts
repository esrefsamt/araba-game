import { randomInt } from 'node:crypto';

import { ROOM_ID_LENGTH } from '@trailer-arena/shared';

import type { ServerPlayer } from '../players/ServerPlayer.js';
import { GameRoom } from './GameRoom.js';
import { serverLogger } from '../server/ServerLogger.js';

const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_ID_GENERATION_ATTEMPTS = 100;

export type RoomIdGenerator = () => string;

export type JoinRoomResult =
  | { ok: true; room: GameRoom }
  | { ok: false; reason: 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'PLAYER_ALREADY_PRESENT' };

export class RoomManager {
  private readonly rooms = new Map<string, GameRoom>();

  public constructor(private readonly roomIdGenerator: RoomIdGenerator = createRoomId) {}

  public get roomCount(): number {
    return this.rooms.size;
  }

  public get playerCount(): number {
    let count = 0;
    for (const room of this.rooms.values()) count += room.playerCount;
    return count;
  }

  public createRoom(): GameRoom {
    for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
      const roomId = this.roomIdGenerator();
      if (!this.rooms.has(roomId)) {
        const room = new GameRoom(roomId);
        this.rooms.set(roomId, room);
        serverLogger.info(`[room ${roomId}] created`);
        return room;
      }
    }

    throw new Error('Unable to generate a unique room ID.');
  }

  public getRoom(roomId: string): GameRoom | undefined {
    return this.rooms.get(roomId);
  }

  public joinRoom(roomId: string, player: ServerPlayer): JoinRoomResult {
    const room = this.rooms.get(roomId);
    if (room === undefined) {
      return { ok: false, reason: 'ROOM_NOT_FOUND' };
    }

    const result = room.addPlayer(player);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, room };
  }

  public leaveRoom(roomId: string, playerId: string): ServerPlayer | undefined {
    const room = this.rooms.get(roomId);
    if (room === undefined) {
      return undefined;
    }

    const removedPlayer = room.removePlayer(playerId);
    if (room.isEmpty) {
      this.rooms.delete(roomId);
      room.dispose();
      serverLogger.info(`[room ${roomId}] destroyed`);
    }
    return removedPlayer;
  }

  public update(deltaSeconds: number, tick: number): void {
    for (const room of this.rooms.values()) {
      room.update(deltaSeconds, tick);
    }
  }

  public forEachRoom(callback: (room: GameRoom) => void): void {
    for (const room of this.rooms.values()) {
      callback(room);
    }
  }

  public dispose(): void {
    for (const room of this.rooms.values()) {
      room.dispose();
      serverLogger.info(`[room ${room.id}] destroyed during shutdown`);
    }
    this.rooms.clear();
  }
}

function createRoomId(): string {
  let roomId = '';
  for (let index = 0; index < ROOM_ID_LENGTH; index += 1) {
    roomId += ROOM_ID_ALPHABET[randomInt(ROOM_ID_ALPHABET.length)];
  }
  return roomId;
}
