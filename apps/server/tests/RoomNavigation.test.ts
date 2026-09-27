import { EventEmitter } from 'node:events';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  COUNTDOWN_TICKS,
  SIMULATION_FIXED_DELTA_SECONDS,
  VEHICLE_SPAWN_POINTS,
  createServerCodec,
} from '@trailer-arena/shared';
import type { ServerMessage } from '@trailer-arena/shared';
import type WebSocket from 'ws';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { GameRoom } from '../src/rooms/GameRoom.js';
import { ServerPlayer } from '../src/players/ServerPlayer.js';
import { ConnectionManager } from '../src/networking/ConnectionManager.js';
import { RoomManager } from '../src/rooms/RoomManager.js';

const rooms: GameRoom[] = [];
beforeAll(async () => {
  await RAPIER.init();
});
afterEach(() => {
  for (const room of rooms) room.dispose();
  rooms.length = 0;
});
const input = {
  type: 'player_input' as const,
  sequence: 1,
  throttle: 1,
  brake: 0,
  steering: 0,
  handbrake: false,
};
function player(id: string) {
  return new ServerPlayer(id, `client-${id}`, id);
}
function arena() {
  const room = new GameRoom('ABC123');
  rooms.push(room);
  room.addPlayer(player('host'));
  room.startMatch('host');
  let tick = 0;
  const step = (count: number) => {
    for (let index = 0; index < count; index++)
      room.update(SIMULATION_FIXED_DELTA_SECONDS, ++tick);
  };
  return { room, step };
}

describe('late join participation and safe spawning', () => {
  it('spawns and immediately enables a PLAYING joiner with zero score in current standings without changing the timer', () => {
    const { room, step } = arena();
    step(COUNTDOWN_TICKS + 60 * 40);
    const before = room.createGameStateSnapshot();
    const hostBody = room.getVehicleSystem().getVehicle('host')!.body;
    room.addPlayer(player('late'));
    const after = room.createGameStateSnapshot();
    expect(after).toMatchObject({
      phase: 'PLAYING',
      stateStartTick: before.stateStartTick,
      stateEndTick: before.stateEndTick,
      roundNumber: before.roundNumber,
    });
    expect(after.players.find((entry) => entry.playerId === 'late')).toMatchObject({
      participant: true,
      trailerTicks: 0,
      currentStreakTicks: 0,
      bestStreakTicks: 0,
      sessionPoints: 0,
    });
    const vehicle = room.getVehicleSystem().getVehicle('late')!;
    expect(room.getVehicleSystem().vehicleCount).toBe(2);
    expect(
      VEHICLE_SPAWN_POINTS.some((point) =>
        point.position.every(
          (value, axis) =>
            Math.abs(value - vehicle.createSnapshot().position[axis]!) < 0.0001,
        ),
      ),
    ).toBe(true);
    expect(vehicle.body.linvel()).toEqual({ x: 0, y: 0, z: 0 });
    expect(vehicle.body.angvel()).toEqual({ x: 0, y: 0, z: 0 });
    expect(vehicle.collider.collisionGroups()).toBe(
      room.getVehicleSystem().getVehicle('host')!.collider.collisionGroups(),
    );
    expect(room.getVehicleSystem().getVehicle('host')!.body).toBe(hostBody);
    expect(room.applyPlayerInput('late', input)).toBe(true);
    step(90);
    expect(Math.abs(vehicle.createSnapshot().forwardSpeed)).toBeGreaterThan(1);
  });

  it('lets the late joiner score from actual trailer contacts for the remaining round', () => {
    const { room, step } = arena();
    step(COUNTDOWN_TICKS + 1);
    room.addPlayer(player('late'));
    room.teleportVehicleOntoTrailer('late');
    step(90);
    const entry = room
      .createGameStateSnapshot()
      .players.find((value) => value.playerId === 'late')!;
    expect(entry.trailerTicks).toBeGreaterThan(0);
    expect(entry.bestStreakTicks).toBeGreaterThan(0);
  });

  it('includes joins in the last countdown tick and enables controls only at PLAYING', () => {
    const { room, step } = arena();
    step(COUNTDOWN_TICKS - 1);
    const deadline = room.createGameStateSnapshot().stateEndTick;
    room.addPlayer(player('late'));
    expect(room.createGameStateSnapshot().players[1]?.participant).toBe(true);
    expect(room.applyPlayerInput('late', input)).toBe(false);
    expect(room.createGameStateSnapshot().stateEndTick).toBe(deadline);
    step(1);
    expect(room.applyPlayerInput('late', input)).toBe(true);
  });

  it('keeps completed RESULTS immutable for a new join and activates that player on the next round', () => {
    const { room, step } = arena();
    step(COUNTDOWN_TICKS + 5400);
    const before = room.createGameStateSnapshot();
    room.addPlayer(player('late'));
    const after = room.createGameStateSnapshot();
    expect(after.phase).toBe('RESULTS');
    expect(after.results).toEqual(before.results);
    expect(after.players.find((entry) => entry.playerId === 'late')).toMatchObject({
      participant: false,
      sessionPoints: 0,
    });
    expect(room.applyPlayerInput('late', input)).toBe(false);
    room.startNextRound('host');
    expect(
      room.createGameStateSnapshot().players.every((entry) => entry.participant),
    ).toBe(true);
    step(COUNTDOWN_TICKS);
    expect(room.applyPlayerInput('late', input)).toBe(true);
  });

  it('skips a player occupying the next normal spawn without resetting that player', () => {
    const { room, step } = arena();
    step(COUNTDOWN_TICKS + 1);
    const occupied = VEHICLE_SPAWN_POINTS[1]!;
    const host = room.getVehicleSystem().getVehicle('host')!;
    host.teleportTo(occupied);
    room.addPlayer(player('late'));
    const late = room.getVehicleSystem().getVehicle('late')!;
    expect(
      late.collider.contactCollider(host.collider, 0)?.distance ?? 1,
    ).toBeGreaterThan(0);
    host
      .createSnapshot()
      .position.forEach((value, axis) =>
        expect(value).toBeCloseTo(occupied.position[axis]!, 4),
      );
  });

  it('skips convoy bodies that block the normal spawn pool, including fresh colliders before a tick', () => {
    const { room } = arena();
    const convoy = room.getConvoySystem();
    const blocked = VEHICLE_SPAWN_POINTS[1]!.position;
    convoy.truckBody.setTranslation({ x: blocked[0], y: 0, z: blocked[2] }, true);
    convoy.trailerBody.setTranslation({ x: blocked[0], y: 0, z: blocked[2] + 9 }, true);
    room.addPlayer(player('late'));
    const late = room.getVehicleSystem().getVehicle('late')!;
    for (const collider of [...convoy.truckColliders, ...convoy.trailerColliders])
      expect(late.collider.contactCollider(collider, 0)?.distance ?? 1).toBeGreaterThan(
        0,
      );
    room.addPlayer(player('fresh'));
    const fresh = room.getVehicleSystem().getVehicle('fresh')!;
    expect(
      late.collider.contactCollider(fresh.collider, 0)?.distance ?? 1,
    ).toBeGreaterThan(0);
  });

  it('uses normal player collision and RAM handling for a mid-round joiner', () => {
    const { room, step } = arena();
    step(COUNTDOWN_TICKS + 1);
    room.addPlayer(player('late'));
    const system = room.getVehicleSystem();
    const host = system.getVehicle('host')!;
    const late = system.getVehicle('late')!;
    host.teleportTo({ position: [-40, 0.82, 0], rotation: [0, 0, 0, 1] });
    late.teleportTo({
      position: [-44, 0.82, 0],
      rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    });
    late.body.setLinvel({ x: 10, y: 0, z: 0 }, true);
    const impacts = [];
    for (let index = 0; index < 50; index++) {
      step(1);
      impacts.push(...system.drainPlayerImpacts());
    }
    expect(
      impacts.some(
        (impact) =>
          impact.attackerPlayerId === 'late' || impact.targetPlayerId === 'late',
      ),
    ).toBe(true);
    expect(Math.abs(host.body.translation().x + 40)).toBeGreaterThan(0.3);
  });
});

class Socket extends EventEmitter {
  public readyState = 1;
  public messages: ServerMessage[] = [];
  public send(raw: string, callback?: (error?: Error) => void) {
    this.messages.push(JSON.parse(raw) as ServerMessage);
    callback?.();
  }
  public ping() {}
  public terminate() {
    this.close();
  }
  public close() {
    this.readyState = 3;
    this.emit('close');
  }
  public receive(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
  public joined() {
    return this.messages.filter((message) => message.type === 'room_joined').at(-1)!;
  }
  public token() {
    return this.messages.find((message) => message.type === 'connected')!.sessionToken;
  }
}

describe('session stays connected across intentional room navigation', () => {
  it.each(['LOBBY', 'COUNTDOWN', 'PLAYING', 'RESULTS'] as const)(
    'immediately leaves %s, cleans membership/body, migrates host, and resumes only the menu',
    (phase) => {
      let code = 0;
      const managerRooms = new RoomManager(() => `ROOM${++code}A`);
      const manager = new ConnectionManager(managerRooms, { now: () => 0 });
      const connect = () => {
        const socket = new Socket();
        manager.handleConnection(socket as unknown as WebSocket);
        return socket;
      };
      try {
        const first = connect();
        first.receive({ type: 'join_room', playerName: 'Host' });
        const room = managerRooms.getRoom(first.joined().roomId)!;
        const peer = connect();
        peer.receive({ type: 'join_room', playerName: 'Peer', roomId: room.id });
        if (phase !== 'LOBBY') {
          first.receive({ type: 'set_ready', ready: true });
          peer.receive({ type: 'set_ready', ready: true });
          first.receive({ type: 'start_match' });
        }
        const ticks =
          phase === 'RESULTS'
            ? COUNTDOWN_TICKS + 5400
            : phase === 'PLAYING'
              ? COUNTDOWN_TICKS + 1
              : 0;
        for (let tick = 1; tick <= ticks; tick++)
          managerRooms.update(SIMULATION_FIXED_DELTA_SECONDS, tick);
        expect(room.createGameStateSnapshot().phase).toBe(phase);
        const id = first.joined().playerId;
        first.receive({ type: 'leave_room', playerId: peer.joined().playerId }); // Ownership comes from the socket.
        const ack = first.messages.at(-1)!;
        expect(ack.type).toBe('room_left');
        expect(first.readyState).toBe(1);
        expect(room.hasPlayer(id)).toBe(false);
        expect(room.hasPlayer(peer.joined().playerId)).toBe(true);
        expect(room.getVehicleSystem().getVehicle(id)).toBeUndefined();
        expect(room.createGameStateSnapshot().players).toHaveLength(1);
        expect(room.createGameStateSnapshot().hostPlayerId).toBe(peer.joined().playerId);
        expect(peer.messages).toContainEqual({ type: 'player_left', playerId: id });
        expect(
          createServerCodec().decode(
            JSON.stringify({ type: 'leave_room', playerId: 'forged' }),
          ),
        ).toEqual({ ok: true, value: { type: 'leave_room' } });
        first.close();
        const refreshed = connect();
        if (ack.type !== 'room_left') throw Error('Missing leave acknowledgement');
        refreshed.receive({ type: 'reconnect_session', sessionToken: ack.sessionToken });
        expect(refreshed.messages.at(-1)).toMatchObject({
          type: 'session_resumed',
          roomId: null,
          playerId: null,
          state: null,
        });
      } finally {
        manager.shutdown();
        managerRooms.dispose();
      }
    },
  );

  it('joins another room and creates another on the same socket, with immediate last-player room removal', () => {
    let code = 0;
    const managerRooms = new RoomManager(() => `ROOM${++code}A`);
    const manager = new ConnectionManager(managerRooms, { now: () => 0 });
    const first = new Socket();
    const peer = new Socket();
    try {
      manager.handleConnection(first as unknown as WebSocket);
      manager.handleConnection(peer as unknown as WebSocket);
      first.receive({ type: 'join_room', playerName: 'Host' });
      const old = first.joined();
      peer.receive({ type: 'join_room', playerName: 'Other host' });
      const other = peer.joined();
      first.receive({ type: 'join_room', playerName: 'Host', roomId: other.roomId });
      expect(first.messages.at(-1)).toMatchObject({
        type: 'error',
        code: 'ALREADY_IN_ROOM',
      });
      first.receive({ type: 'leave_room' });
      expect(managerRooms.getRoom(old.roomId)).toBeUndefined();
      first.receive({ type: 'join_room', playerName: 'Host', roomId: other.roomId });
      expect(first.joined().roomId).toBe(other.roomId);
      expect(first.joined().playerId).not.toBe(old.playerId);
      first.receive({ type: 'leave_room' });
      first.receive({ type: 'join_room', playerName: 'Host' });
      expect(first.joined().roomId).not.toBe(old.roomId);
      expect(first.joined().roomId).not.toBe(other.roomId);
      expect(first.readyState).toBe(1);
      expect(manager.sessionCount).toBe(2);
      expect(managerRooms.playerCount).toBe(2);
    } finally {
      manager.shutdown();
      managerRooms.dispose();
    }
  });
});
