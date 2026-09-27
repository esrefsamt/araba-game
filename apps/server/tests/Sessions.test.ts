import { EventEmitter } from 'node:events';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  COUNTDOWN_TICKS,
  createServerCodec,
  createClientCodec,
  isSessionToken,
} from '@trailer-arena/shared';
import type { ServerMessage } from '@trailer-arena/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

import { ConnectionManager } from '../src/networking/ConnectionManager.js';
import { SessionRegistry } from '../src/networking/SessionRegistry.js';
import { RoomManager } from '../src/rooms/RoomManager.js';

class Socket extends EventEmitter {
  public readyState = 1;
  public messages: ServerMessage[] = [];
  public pings = 0;
  public send(raw: string, callback?: (error?: Error) => void): void {
    this.messages.push(JSON.parse(raw) as ServerMessage);
    callback?.();
  }
  public ping(): void {
    this.pings += 1;
  }
  public close(): void {
    this.drop();
  }
  public terminate(): void {
    this.drop();
  }
  public drop(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
  public receive(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }
  public token(): string {
    return this.messages.find((message) => message.type === 'connected')!.sessionToken;
  }
  public joined() {
    return this.messages.find((message) => message.type === 'room_joined')!;
  }
  public resumed() {
    return this.messages.find((message) => message.type === 'session_resumed')!;
  }
  public error() {
    return this.messages.filter((message) => message.type === 'error').at(-1);
  }
}
const active: ReturnType<typeof setup>[] = [];
beforeAll(async () => {
  await RAPIER.init();
});
afterEach(() => {
  for (const context of active) {
    context.manager.shutdown();
    context.rooms.dispose();
  }
  active.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function setup() {
  let now = 0;
  let tick = 0;
  const rooms = new RoomManager(() => 'ABC123');
  const manager = new ConnectionManager(rooms, { now: () => now });
  const connect = () => {
    const socket = new Socket();
    manager.handleConnection(socket as unknown as WebSocket);
    return socket;
  };
  const first = connect();
  first.receive({ type: 'join_room', playerName: 'Host' });
  const room = rooms.getRoom(first.joined().roomId)!;
  const context = {
    manager,
    rooms,
    room,
    first,
    connect,
    advance: (milliseconds: number) => {
      now += milliseconds;
      manager.maintainConnections();
    },
    step: (count: number) => {
      for (let index = 0; index < count; index += 1) rooms.update(1 / 60, ++tick);
    },
    second: () => {
      const socket = connect();
      socket.receive({ type: 'join_room', playerName: 'Crew', roomId: room.id });
      return socket;
    },
    resume: (socket: Socket) => {
      const next = connect();
      next.receive({ type: 'reconnect_session', sessionToken: socket.token() });
      return next;
    },
    play: () => {
      first.receive({ type: 'start_match' });
      context.step(COUNTDOWN_TICKS + 1);
      expect(room.createGameStateSnapshot().phase).toBe('PLAYING');
    },
  };
  active.push(context);
  return context;
}

describe('session capabilities and room membership', () => {
  it('issues a 256-bit unique random token on every initial connection', () => {
    const registry = new SessionRegistry();
    const tokens = Array.from(
      { length: 100 },
      (_, index) => registry.create(`transport-${index}`).token,
    );
    expect(tokens.every(isSessionToken)).toBe(true);
    expect(new Set(tokens).size).toBe(100);
    const context = setup();
    expect(isSessionToken(context.first.token())).toBe(true);
    expect(context.first.messages[0]).toMatchObject({
      type: 'connected',
      reconnectWindowMs: 15_000,
    });
  });

  it('retains room membership, body and ready state during unexpected disconnect', () => {
    const context = setup();
    const id = context.first.joined().playerId;
    context.first.receive({ type: 'set_ready', ready: true });
    const body = context.room.getVehicleSystem().getVehicle(id)!.body.handle;
    context.first.drop();
    expect(context.room.playerCount).toBe(1);
    expect(context.room.getVehicleSystem().vehicleCount).toBe(1);
    expect(context.room.createGameStateSnapshot().players[0]).toMatchObject({
      ready: true,
      connectionState: 'DISCONNECTED_GRACE',
    });
    context.advance(5_000);
    const resumed = context.resume(context.first).resumed();
    expect(resumed.playerId).toBe(id);
    expect(resumed.roomId).toBe(context.room.id);
    expect(resumed.state?.gameState.players[0]?.ready).toBe(true);
    expect(context.room.getVehicleSystem().getVehicle(id)!.body.handle).toBe(body);
    expect(context.manager.sessionCount).toBe(1);
  });

  it('removes intentional leaves immediately and invalidates the old token', () => {
    const context = setup();
    const id = context.first.joined().playerId;
    context.first.receive({ type: 'leave_room' });
    expect(context.rooms.roomCount).toBe(0);
    expect(context.first.messages.at(-1)?.type).toBe('room_left');
    const next = context.resume(context.first);
    expect(next.error()?.code).toBe('SESSION_EXPIRED');
    expect(
      next.messages.some(
        (message) => message.type === 'session_resumed' && message.playerId === id,
      ),
    ).toBe(false);
  });

  it('can resume a connected capability that had not joined any room', () => {
    const context = setup();
    const empty = context.connect();
    empty.drop();
    expect(context.resume(empty).resumed()).toMatchObject({
      playerId: null,
      roomId: null,
      state: null,
    });
  });

  it('rejects an active token without replacing the controlling socket', () => {
    const context = setup();
    const duplicate = context.resume(context.first);
    expect(duplicate.error()?.code).toBe('SESSION_ACTIVE');
    expect(context.first.readyState).toBe(1);
    expect(context.room.playerCount).toBe(1);
  });

  it('reclaims a dead stale socket at heartbeat timeout without a duplicate body', () => {
    const context = setup();
    const bodyCount = context.room.getPhysicsWorld().bodies.len();
    context.advance(15_000);
    expect(context.first.readyState).toBe(3);
    expect(context.resume(context.first).resumed().playerId).toBe(
      context.first.joined().playerId,
    );
    expect(context.room.getPhysicsWorld().bodies.len()).toBe(bodyCount);
  });

  it.each(['garbage', 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(8000), {}, null])(
    'rejects malformed tokens without a crash or identity mutation (%s)',
    (token) => {
      const context = setup();
      const next = context.connect();
      expect(() =>
        next.receive({ type: 'reconnect_session', sessionToken: token }),
      ).not.toThrow();
      expect(next.error()?.code).toBe('INVALID_MESSAGE');
      expect(context.room.playerCount).toBe(1);
    },
  );

  it('rejects a well-formed unknown token', () => {
    const context = setup();
    const next = context.connect();
    next.receive({ type: 'reconnect_session', sessionToken: 'a'.repeat(64) });
    expect(next.error()?.code).toBe('SESSION_EXPIRED');
  });

  it('bounds create/join/reconnect requests independently of player input protection', () => {
    const context = setup();
    const next = context.connect();
    for (let index = 0; index < 7; index += 1)
      next.receive({ type: 'join_room', playerName: 'Crew', roomId: 'ZZZZZZ' });
    expect(next.error()?.code).toBe('RATE_LIMITED');
    context.advance(10_000);
    next.receive({ type: 'join_room', playerName: 'Crew', roomId: 'ABC123' });
    expect(next.joined().roomId).toBe('ABC123');
  });
});

describe('disconnect control and authoritative resync', () => {
  it('neutralizes held throttle/steering immediately and ignores detached socket input', () => {
    const context = setup();
    context.play();
    const id = context.first.joined().playerId;
    const command = {
      type: 'player_input',
      sequence: 42,
      throttle: 1,
      steering: -1,
      brake: 0,
      handbrake: true,
    };
    context.first.receive(command);
    const vehicle = context.room.getVehicleSystem().getVehicle(id)!;
    expect(vehicle.input.throttle).toBe(1);
    context.first.drop();
    expect(vehicle.input).toEqual({
      throttle: 0,
      brake: 0,
      steering: 0,
      handbrake: false,
    });
    context.first.receive({ ...command, sequence: 43 });
    expect(vehicle.inputSequence).toBe(42);
    const next = context.resume(context.first);
    expect(
      next.resumed().state?.vehicles.find((state) => state.playerId === id)
        ?.lastProcessedInputSequence,
    ).toBe(42);
    next.receive(command);
    expect(vehicle.input.throttle).toBe(0);
    next.receive({ ...command, sequence: 43 });
    expect(vehicle.input.throttle).toBe(1);
    context.first.receive({ ...command, sequence: 44 });
    expect(vehicle.inputSequence).toBe(43);
  });

  it('freezes trailer scoring immediately and restores accumulated round/session score and the same vehicle', () => {
    vi.stubEnv('DEBUG_ROUND_DURATION_SECONDS', '2');
    const context = setup();
    context.play();
    context.step(125);
    expect(context.room.createGameStateSnapshot().phase).toBe('RESULTS');
    const points = context.room.createGameStateSnapshot().players[0]!.sessionPoints;
    expect(points).toBeGreaterThan(0);
    context.first.receive({ type: 'next_round' });
    context.step(COUNTDOWN_TICKS + 1);
    const id = context.first.joined().playerId;
    context.room.teleportVehicleOntoTrailer(id);
    context.step(35);
    const score = context.room.createGameStateSnapshot().players[0]!.trailerTicks;
    expect(score).toBeGreaterThan(0);
    const count = context.room.getPhysicsWorld().bodies.len();
    context.first.drop();
    context.step(30);
    expect(context.room.createGameStateSnapshot().players[0]).toMatchObject({
      trailerTicks: score,
      isScoringOnTrailer: false,
      sessionPoints: points,
    });
    const resumed = context.resume(context.first).resumed();
    expect(resumed.state?.gameState.players[0]).toMatchObject({
      trailerTicks: score,
      sessionPoints: points,
      connectionState: 'CONNECTED',
    });
    expect(context.room.getPhysicsWorld().bodies.len()).toBe(count);
    context.step(10);
    expect(
      context.room.createGameStateSnapshot().players[0]!.trailerTicks,
    ).toBeGreaterThan(score);
  });

  it('sends one full canonical snapshot with timers, host, identities, all vehicles and convoy, without event history', () => {
    const context = setup();
    const second = context.second();
    context.first.receive({ type: 'set_ready', ready: true });
    second.receive({ type: 'set_ready', ready: true });
    context.play();
    context.first.drop();
    context.step(10);
    const message = context.resume(context.first).resumed();
    expect(message.state).toEqual(context.room.createWorldSnapshot());
    expect(message.state?.vehicles).toHaveLength(2);
    expect(message.state?.gameState.stateEndTick).toBeGreaterThan(
      message.state!.serverTick,
    );
    expect(Object.keys(message.state!).sort()).toEqual([
      'convoy',
      'gameState',
      'serverTick',
      'type',
      'vehicles',
    ]);
    const codec = createClientCodec();
    expect(codec.decode(JSON.stringify(message)).ok).toBe(true);
    expect(message.state?.gameState.hostPlayerId).toBe(second.joined().playerId);
  });

  it('restores the same RESULTS screen and session points after refresh-like reconnect', () => {
    vi.stubEnv('DEBUG_ROUND_DURATION_SECONDS', '1');
    const context = setup();
    context.play();
    context.step(65);
    const result = context.room.createGameStateSnapshot();
    expect(result.phase).toBe('RESULTS');
    context.first.drop();
    const resumed = context.resume(context.first).resumed();
    expect(resumed.state?.gameState.results).toEqual(result.results);
    expect(resumed.state?.gameState.roundNumber).toBe(result.roundNumber);
    expect(resumed.state?.gameState.phase).toBe('RESULTS');
  });
});

describe('grace expiry, slots, hosts and heartbeat', () => {
  it('keeps a grace player in the eight-player capacity, then frees its slot and body exactly at expiry', () => {
    const context = setup();
    const players = [context.first];
    for (let index = 1; index < 8; index += 1) players.push(context.second());
    const id = context.first.joined().playerId;
    const bodyCount = context.room.getPhysicsWorld().bodies.len();
    context.first.drop();
    const ninth = context.second();
    expect(ninth.error()?.code).toBe('ROOM_FULL');
    expect(context.room.playerCount).toBe(8);
    context.advance(14_999);
    expect(context.room.hasPlayer(id)).toBe(true);
    for (const player of players.slice(1)) player.receive({ type: 'ping', timestamp: 0 });
    // Reconnect validation expires tokens even between central maintenance sweeps.
    context.advance(1);
    expect(context.resume(context.first).error()?.code).toBe('SESSION_EXPIRED');
    expect(context.room.getVehicleSystem().getVehicle(id)).toBeUndefined();
    expect(context.room.getPhysicsWorld().bodies.len()).toBe(bodyCount - 1);
    ninth.receive({ type: 'join_room', playerName: 'Ninth', roomId: context.room.id });
    expect(ninth.joined().roomId).toBe(context.room.id);
    expect(context.room.playerCount).toBe(8);
  });

  it('disposes an empty room and expired token through the central sweep', () => {
    const context = setup();
    context.first.drop();
    context.advance(15_000);
    expect(context.rooms.roomCount).toBe(0);
    expect(context.manager.sessionCount).toBe(0);
  });

  it('migrates host immediately to the oldest connected player and does not steal it on reconnect', () => {
    const context = setup();
    const second = context.second();
    context.first.drop();
    expect(context.room.createGameStateSnapshot().hostPlayerId).toBe(
      second.joined().playerId,
    );
    second.receive({ type: 'start_match' });
    expect(context.room.createGameStateSnapshot().phase).toBe('COUNTDOWN');
    const resumed = context.resume(context.first).resumed();
    expect(resumed.state?.gameState.hostPlayerId).toBe(second.joined().playerId);
  });

  it('restores host to the first returning player when all players are disconnected', () => {
    const context = setup();
    const second = context.second();
    context.first.drop();
    second.drop();
    expect(context.room.createGameStateSnapshot().hostPlayerId).toBeNull();
    const resumed = context.resume(context.first).resumed();
    expect(resumed.state?.gameState.hostPlayerId).toBe(context.first.joined().playerId);
  });

  it('sends native heartbeat after five seconds and starts grace after fifteen seconds without responses', () => {
    const context = setup();
    context.advance(5_000);
    expect(context.first.pings).toBe(1);
    context.advance(9_000);
    expect(context.first.readyState).toBe(1);
    context.advance(1_000);
    expect(context.first.readyState).toBe(3);
    expect(context.room.createGameStateSnapshot().players[0]?.connectionState).toBe(
      'DISCONNECTED_GRACE',
    );
    context.advance(15_000);
    expect(context.rooms.roomCount).toBe(0);
  });

  it('accepts delayed native pong and application traffic without false disconnects', () => {
    const context = setup();
    context.advance(14_000);
    context.first.emit('pong');
    context.advance(14_000);
    expect(context.first.readyState).toBe(1);
    context.first.receive({ type: 'ping', timestamp: 1 });
    context.advance(14_000);
    expect(context.first.readyState).toBe(1);
  });

  it('regenerates colliding room codes without overwriting existing rooms', () => {
    const generate = vi
      .fn()
      .mockReturnValueOnce('AAAAAA')
      .mockReturnValueOnce('AAAAAA')
      .mockReturnValueOnce('BBBBBB');
    const rooms = new RoomManager(generate);
    const first = rooms.createRoom();
    const second = rooms.createRoom();
    expect(first.id).toBe('AAAAAA');
    expect(second.id).toBe('BBBBBB');
    expect(generate).toHaveBeenCalledTimes(3);
    expect(rooms.getRoom(first.id)).toBe(first);
    rooms.dispose();
  });

  it('validates the typed resume protocol rather than trusting player/score claims', () => {
    const decoded = createServerCodec().decode(
      JSON.stringify({
        type: 'reconnect_session',
        sessionToken: 'b'.repeat(64),
        playerId: 'fake',
        host: true,
        score: 999,
      }),
    );
    expect(decoded).toEqual({
      ok: true,
      value: { type: 'reconnect_session', sessionToken: 'b'.repeat(64) },
    });
  });
});
