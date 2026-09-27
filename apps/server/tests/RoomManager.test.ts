import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';

import { ServerPlayer } from '../src/players/ServerPlayer.js';
import { RoomManager } from '../src/rooms/RoomManager.js';

beforeAll(async () => {
  await RAPIER.init();
});

function createPlayer(index: number): ServerPlayer {
  return new ServerPlayer(`player-${index}`, `client-${index}`, `Player ${index}`);
}

describe('RoomManager', () => {
  it('creates a room', () => {
    const manager = new RoomManager(() => 'ABC123');

    const room = manager.createRoom();

    expect(room.id).toBe('ABC123');
    expect(manager.getRoom('ABC123')).toBe(room);
    expect(manager.roomCount).toBe(1);
  });

  it('adds a player to a room', () => {
    const manager = new RoomManager(() => 'ABC123');
    const room = manager.createRoom();
    const player = createPlayer(1);

    const result = manager.joinRoom(room.id, player);

    expect(result.ok).toBe(true);
    expect(room.hasPlayer(player.id)).toBe(true);
    expect(room.playerCount).toBe(1);
  });

  it('allows eight players', () => {
    const manager = new RoomManager(() => 'ABC123');
    const room = manager.createRoom();

    for (let index = 1; index <= 8; index += 1) {
      expect(manager.joinRoom(room.id, createPlayer(index)).ok).toBe(true);
    }

    expect(room.playerCount).toBe(8);
    expect(room.isFull).toBe(true);
  });

  it('rejects a ninth player', () => {
    const manager = new RoomManager(() => 'ABC123');
    const room = manager.createRoom();
    for (let index = 1; index <= 8; index += 1) {
      manager.joinRoom(room.id, createPlayer(index));
    }

    const result = manager.joinRoom(room.id, createPlayer(9));

    expect(result).toEqual({ ok: false, reason: 'ROOM_FULL' });
    expect(room.playerCount).toBe(8);
  });

  it('removes a leaving player', () => {
    const manager = new RoomManager(() => 'ABC123');
    const room = manager.createRoom();
    const firstPlayer = createPlayer(1);
    const secondPlayer = createPlayer(2);
    manager.joinRoom(room.id, firstPlayer);
    manager.joinRoom(room.id, secondPlayer);

    manager.leaveRoom(room.id, firstPlayer.id);

    expect(room.hasPlayer(firstPlayer.id)).toBe(false);
    expect(room.hasPlayer(secondPlayer.id)).toBe(true);
    expect(room.playerCount).toBe(1);
  });

  it('deletes a room after its final player leaves', () => {
    const manager = new RoomManager(() => 'ABC123');
    const room = manager.createRoom();
    const player = createPlayer(1);
    manager.joinRoom(room.id, player);

    manager.leaveRoom(room.id, player.id);

    expect(manager.getRoom(room.id)).toBeUndefined();
    expect(manager.roomCount).toBe(0);
  });
});
