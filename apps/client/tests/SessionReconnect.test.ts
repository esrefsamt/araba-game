import type {
  ClientMessage,
  ServerMessage,
  WorldSnapshotMessage,
  VehicleStateSnapshot,
} from '@trailer-arena/shared';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NetworkClient } from '../src/networking/NetworkClient.js';
import { SessionTokenStore } from '../src/networking/SessionTokenStore.js';
import { InputTransmitter } from '../src/networking/InputTransmitter.js';
import {
  reconnectDelay,
  resolveWebSocketUrl,
} from '../src/networking/ConnectionConfig.js';
import { friendlyServerError } from '../src/ui/SessionPanel.js';
import { World } from '../src/world/World.js';
import { Game } from '../src/core/Game.js';

class MemoryStorage {
  public readonly data = new Map<string, string>();
  public getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  public setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  public removeItem(key: string): void {
    this.data.delete(key);
  }
}
class Socket extends EventTarget {
  public static readonly OPEN = 1;
  public static instances: Socket[] = [];
  public readyState = 0;
  public sent: ClientMessage[] = [];
  public constructor(public readonly url: string) {
    super();
    Socket.instances.push(this);
  }
  public open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  public send(raw: string): void {
    this.sent.push(JSON.parse(raw) as ClientMessage);
  }
  public close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  public receive(message: ServerMessage): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
}
const URL = 'ws://localhost:3000/';
const TOKEN = 'a'.repeat(64);
const PROVISIONAL = 'b'.repeat(64);
const clients: NetworkClient[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  Socket.instances.length = 0;
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('WebSocket', Socket);
});
afterEach(() => {
  for (const client of clients) client.disconnect();
  clients.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(savedToken: string | null = null, storage = new MemoryStorage()) {
  const store = new SessionTokenStore(URL, storage);
  store.write(savedToken);
  const client = new NetworkClient(URL, store);
  clients.push(client);
  const states: string[] = [];
  client.onStateChange((state) => states.push(state));
  client.connect();
  return { client, states, store, storage, socket: Socket.instances.at(-1)! };
}
function welcome(socket: Socket, token = TOKEN): void {
  socket.open();
  socket.receive({
    type: 'connected',
    clientId: 'transport',
    sessionToken: token,
    reconnectWindowMs: 15_000,
  });
}
function resume(socket: Socket, state: WorldSnapshotMessage | null = null): void {
  socket.receive({
    type: 'session_resumed',
    sessionToken: TOKEN,
    roomId: state === null ? null : 'ABC123',
    playerId: state === null ? null : 'local',
    state,
  });
}

// Exercise Game's real network routing and World without constructing a WebGL renderer.
function roomGame(context: ReturnType<typeof setup>) {
  const world = new World(new THREE.Scene());
  const gameHud = {
    setConnection: vi.fn(),
    clear: vi.fn(),
    setLocalContext: vi.fn(),
    applySnapshot: vi.fn(),
    applyFullSnapshot: vi.fn(),
  };
  const sessionPanel = {
    setRoom: vi.fn(),
    setRoomAction: vi.fn(),
    setConnection: vi.fn(),
    setMessage: vi.fn(),
    setError: vi.fn(),
    showReconnected: vi.fn(),
  };
  const debugPanel = Object.fromEntries(
    [
      'setConnection',
      'setMessage',
      'setPlayerId',
      'setRoomId',
      'clearSnapshotRate',
      'clearRoomTelemetry',
      'setPredictionTelemetry',
      'setGameplayControlsEnabled',
      'setInputSequence',
      'setSnapshotRate',
      'setPing',
      'setServerTick',
    ].map((key) => [key, vi.fn()]),
  );
  const inputManager = { setEnabled: vi.fn() };
  const inputTransmitter = { setEnabled: vi.fn(), resetSequence: vi.fn() };
  const feedback = { clear: vi.fn(), handleRamEvent: vi.fn() };
  const game = Object.create(Game.prototype) as Game;
  Object.assign(game, {
    networkClient: context.client,
    world,
    gameHud,
    sessionPanel,
    debugPanel,
    inputManager,
    inputTransmitter,
    feedback,
    localPlayerId: null,
    snapshotCount: 0,
    snapshotWindowStartedAt: performance.now(),
  });
  (Reflect.get(game, 'bindNetworkEvents') as () => void).call(game);
  context.socket.receive({ type: 'room_joined', roomId: 'ABC123', playerId: 'local' });
  context.socket.receive(snapshot());
  return { world, gameHud, sessionPanel, inputManager, feedback };
}

describe('Game room lifecycle routing', () => {
  it('retains the current room while leave is pending and clears all room views only on ACK', () => {
    const context = setup();
    welcome(context.socket);
    const game = roomGame(context);
    try {
      game.gameHud.clear.mockClear();
      game.sessionPanel.setRoom.mockClear();
      context.client.leaveRoom();
      expect(game.world.getLocalVehicleObject()).not.toBeNull();
      expect(game.gameHud.clear).not.toHaveBeenCalled();
      expect(game.sessionPanel.setRoom).not.toHaveBeenCalled();
      expect(game.inputManager.setEnabled).toHaveBeenLastCalledWith(false);
      context.socket.receive({ ...snapshot(), serverTick: 3 });
      expect(game.inputManager.setEnabled).toHaveBeenLastCalledWith(false);
      context.socket.receive({ type: 'room_left', sessionToken: PROVISIONAL });
      expect(game.world.getLocalVehicleObject()).toBeNull();
      expect(game.world.getConvoySnapshot()).toBeNull();
      expect(game.world.getNetworkMetrics().remoteSnapshotBufferSize).toBe(0);
      expect(game.world.getPredictionMetrics().pendingInputs).toBe(0);
      expect(game.gameHud.clear).toHaveBeenCalledOnce();
      expect(game.sessionPanel.setRoom).toHaveBeenLastCalledWith(null);
      expect(game.feedback.clear).toHaveBeenCalled();
      expect(context.client.isConnected).toBe(true);
    } finally {
      game.world.dispose();
    }
  });

  it('keeps a rejected leave in the current room and enables its controls from the next server state', () => {
    const context = setup();
    welcome(context.socket);
    const game = roomGame(context);
    try {
      game.gameHud.clear.mockClear();
      context.client.leaveRoom();
      context.socket.receive({
        type: 'error',
        code: 'RATE_LIMITED',
        message: 'Slow down',
      });
      context.socket.receive({ ...snapshot(), serverTick: 3 });
      expect(game.gameHud.clear).not.toHaveBeenCalled();
      expect(game.world.getLocalVehicleObject()).not.toBeNull();
      expect(game.inputManager.setEnabled).toHaveBeenLastCalledWith(true);
      expect(context.store.read()).toBe(TOKEN);
    } finally {
      game.world.dispose();
    }
  });
});

describe('session storage and connection lifecycle', () => {
  it('stores the initial capability only after a valid server handshake', () => {
    const context = setup();
    expect(context.store.read()).toBeNull();
    expect(context.client.isConnected).toBe(false);
    welcome(context.socket);
    expect(context.store.read()).toBe(TOKEN);
    expect(context.states).toEqual(['DISCONNECTED', 'CONNECTING', 'CONNECTED']);
  });

  it('restores a tab session after refresh without overwriting it with a provisional token', () => {
    const context = setup(TOKEN);
    welcome(context.socket, PROVISIONAL);
    expect(context.states.at(-1)).toBe('RECONNECTING');
    expect(context.store.read()).toBe(TOKEN);
    expect(context.socket.sent).toContainEqual({
      type: 'reconnect_session',
      sessionToken: TOKEN,
    });
    resume(context.socket);
    expect(context.client.isConnected).toBe(true);
    expect(new SessionTokenStore(URL, context.storage).read()).toBe(TOKEN);
  });

  it('keeps capabilities isolated by endpoint and rejects corrupt storage', () => {
    const storage = new MemoryStorage();
    const store = new SessionTokenStore(URL, storage);
    store.write(TOKEN);
    expect(new SessionTokenStore('wss://other.example/ws', storage).read()).toBeNull();
    storage.setItem(`trailer-arena.session:${URL}`, 'invalid');
    expect(new SessionTokenStore(URL, storage).read()).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it('uses memory when sessionStorage cannot be accessed', () => {
    const store = new SessionTokenStore(URL, {
      getItem: () => {
        throw Error('blocked');
      },
      setItem: () => {
        throw Error('blocked');
      },
      removeItem: () => {
        throw Error('blocked');
      },
    });
    expect(() => store.write(TOKEN)).not.toThrow();
    expect(store.read()).toBe(TOKEN);
  });

  it('waits 500 ms on loss, disables input sends, and restores the original capability', () => {
    const context = setup();
    welcome(context.socket);
    context.socket.close();
    expect(context.states.at(-1)).toBe('RECONNECTING');
    expect(
      context.client.sendPlayerInput(1, {
        throttle: 1,
        brake: 0,
        steering: 0,
        handbrake: false,
      }),
    ).toBe(false);
    vi.advanceTimersByTime(499);
    expect(Socket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    const next = Socket.instances.at(-1)!;
    welcome(next, PROVISIONAL);
    resume(next);
    expect(context.client.isConnected).toBe(true);
    expect(Socket.instances).toHaveLength(2);
    expect(context.store.read()).toBe(TOKEN);
  });

  it('bounds reconnect backoff and stops at the grace deadline even if every socket fails', () => {
    const context = setup();
    welcome(context.socket);
    context.socket.close();
    for (const delay of [500, 1000, 2000, 3000, 5000]) {
      vi.advanceTimersByTime(delay);
      Socket.instances.at(-1)!.close();
    }
    expect(Socket.instances).toHaveLength(6);
    vi.advanceTimersByTime(20_000);
    expect(context.states.at(-1)).toBe('FAILED');
    expect(context.store.read()).toBeNull();
    expect(Socket.instances).toHaveLength(6);
    expect(vi.getTimerCount()).toBe(0);
    expect(Array.from({ length: 9 }, (_, index) => reconnectDelay(index))).toEqual([
      500, 1000, 2000, 3000, 5000, 5000, 5000, 5000, 5000,
    ]);
  });

  it.each([
    'SESSION_EXPIRED',
    'SESSION_ACTIVE',
    'ROOM_NOT_FOUND',
    'INVALID_MESSAGE',
    'RATE_LIMITED',
  ] as const)('stops retries on explicit %s rejection', (code) => {
    const context = setup(TOKEN);
    welcome(context.socket, PROVISIONAL);
    context.socket.receive({ type: 'error', code, message: 'Server rejection' });
    expect(context.states.at(-1)).toBe('FAILED');
    expect(context.store.read()).toBeNull();
    vi.advanceTimersByTime(30_000);
    expect(Socket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans all timers on disposal but retains storage for page refresh', () => {
    const context = setup();
    welcome(context.socket);
    context.client.disconnect();
    vi.advanceTimersByTime(30_000);
    expect(Socket.instances).toHaveLength(1);
    expect(context.store.read()).toBe(TOKEN);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never resumes the abandoned room when the transport is lost before leave acknowledgement', () => {
    const context = setup();
    welcome(context.socket);
    expect(context.client.leaveRoom()).toBe(true);
    expect(context.socket.sent).toContainEqual({ type: 'leave_room' });
    expect(context.store.read()).toBeNull();
    context.socket.close();
    vi.advanceTimersByTime(30_000);
    expect(Socket.instances).toHaveLength(1);
    expect(context.store.read()).toBeNull();
  });

  it('holds a leave transition until acknowledgement, blocks double actions and stale inputs, then joins another room on the same socket', () => {
    const context = setup();
    welcome(context.socket);
    const actions: string[] = [];
    context.client.onRoomActionChange((action) => actions.push(action));
    context.client.setNetworkSimulation({ latencyMs: 150, jitterMs: 0 });
    context.client.sendPlayerInput(99, {
      throttle: 1,
      brake: 0,
      steering: 0,
      handbrake: false,
    });
    expect(context.client.leaveRoom()).toBe(true);
    expect(context.client.isConnected).toBe(true);
    expect(context.client.roomAction).toBe('LEAVING');
    expect(context.client.joinRoom('Same name', 'DEF456')).toBe(false);
    expect(context.client.leaveRoom()).toBe(false);
    expect(
      context.client.sendPlayerInput(100, {
        throttle: 1,
        brake: 0,
        steering: 0,
        handbrake: false,
      }),
    ).toBe(false);
    vi.advanceTimersByTime(150);
    expect(
      context.socket.sent.filter((message) => message.type === 'player_input'),
    ).toHaveLength(0);
    context.socket.receive({ type: 'room_left', sessionToken: PROVISIONAL });
    vi.advanceTimersByTime(150);
    expect(context.client.roomAction).toBe('NONE');
    expect(context.store.read()).toBe(PROVISIONAL);
    expect(context.client.joinRoom('Same name', 'DEF456')).toBe(true);
    vi.advanceTimersByTime(150);
    context.socket.receive({
      type: 'room_joined',
      playerId: 'new-player',
      roomId: 'DEF456',
    });
    vi.advanceTimersByTime(150);
    expect(context.client.roomAction).toBe('NONE');
    expect(Socket.instances).toHaveLength(1);
    expect(actions).toEqual(['NONE', 'LEAVING', 'NONE', 'JOINING', 'NONE']);
  });

  it('restores the current session on a rejected leave and safely recovers from an unconfirmed leave', () => {
    const context = setup();
    welcome(context.socket);
    context.client.leaveRoom();
    context.socket.receive({ type: 'error', code: 'RATE_LIMITED', message: 'Slow down' });
    expect(context.client.roomAction).toBe('NONE');
    expect(context.client.isConnected).toBe(true);
    expect(context.store.read()).toBe(TOKEN);
    context.client.leaveRoom();
    vi.advanceTimersByTime(5000);
    expect(context.states.at(-1)).toBe('FAILED');
    expect(context.client.roomAction).toBe('NONE');
    expect(context.store.read()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes the acknowledged unjoined session without retaining the abandoned room token', () => {
    const context = setup();
    welcome(context.socket);
    context.client.leaveRoom();
    context.socket.receive({ type: 'room_left', sessionToken: PROVISIONAL });
    context.client.disconnect();
    const refreshed = new NetworkClient(URL, new SessionTokenStore(URL, context.storage));
    clients.push(refreshed);
    refreshed.connect();
    const socket = Socket.instances.at(-1)!;
    welcome(socket, 'c'.repeat(64));
    expect(socket.sent).toContainEqual({
      type: 'reconnect_session',
      sessionToken: PROVISIONAL,
    });
    expect(socket.sent).not.toContainEqual({
      type: 'reconnect_session',
      sessionToken: TOKEN,
    });
    socket.receive({
      type: 'session_resumed',
      sessionToken: PROVISIONAL,
      playerId: null,
      roomId: null,
      state: null,
    });
    expect(refreshed.isConnected).toBe(true);
  });

  it('initializes another room with empty old prediction, remote views, snapshot and correction history', () => {
    const scene = new THREE.Scene();
    const world = new World(scene);
    const old = snapshot();
    world.resyncFromSnapshot(old, 'local');
    world.recordLocalInput(99, { throttle: 1, brake: 0, steering: 1, handbrake: false });
    world.applySnapshot({ ...old, serverTick: old.serverTick + 1 });
    world.clear();
    expect(world.getLocalVehicleObject()).toBeNull();
    expect(world.getConvoySnapshot()).toBeNull();
    expect(world.getNetworkMetrics().remoteSnapshotBufferSize).toBe(0);
    expect(world.getPredictionMetrics().pendingInputs).toBe(0);
    const next = snapshot();
    next.vehicles = next.vehicles.map((vehicle) => ({
      ...vehicle,
      playerId: `new-${vehicle.playerId}`,
      lastProcessedInputSequence: -1,
    }));
    next.gameState.players = next.gameState.players.map((player) => ({
      ...player,
      playerId: `new-${player.playerId}`,
    }));
    next.gameState.hostPlayerId = 'new-local';
    world.setLocalPlayerId('new-local');
    world.applySnapshot(next);
    expect(world.getLocalVehicleSnapshot()?.playerId).toBe('new-local');
    expect(world.getPredictionMetrics().pendingInputs).toBe(0);
    expect(world.getPredictionMetrics().visualCorrectionOffset).toBe(0);
    world.updateVisualState(1 / 60, {
      throttle: 0,
      brake: 0,
      steering: 0,
      handbrake: false,
    });
    expect(world.getPredictionMetrics().renderWriterConflicts).toBe(0);
    world.dispose();
  });

  it('reconnects after acknowledged leave using only the new unjoined session', () => {
    const context = setup();
    welcome(context.socket);
    context.client.leaveRoom();
    context.socket.receive({ type: 'room_left', sessionToken: PROVISIONAL });
    context.client.debugDisconnectFor(5000);
    expect(context.states.at(-1)).toBe('RECONNECTING');
    vi.advanceTimersByTime(5000);
    const socket = Socket.instances.at(-1)!;
    welcome(socket, 'c'.repeat(64));
    expect(socket.sent).toContainEqual({
      type: 'reconnect_session',
      sessionToken: PROVISIONAL,
    });
    expect(socket.sent).not.toContainEqual({
      type: 'reconnect_session',
      sessionToken: TOKEN,
    });
    socket.receive({
      type: 'session_resumed',
      sessionToken: PROVISIONAL,
      playerId: null,
      roomId: null,
      state: null,
    });
    expect(context.client.isConnected).toBe(true);
  });

  it('shows a finite initial connection failure and allows a fresh lobby connection after restart', () => {
    const context = setup(TOKEN);
    welcome(context.socket, PROVISIONAL);
    context.socket.receive({
      type: 'error',
      code: 'SESSION_EXPIRED',
      message: 'Server restarted',
    });
    context.client.connectFresh();
    const next = Socket.instances.at(-1)!;
    welcome(next, PROVISIONAL);
    expect(context.client.isConnected).toBe(true);
    expect(context.store.read()).toBe(PROVISIONAL);
    expect(next.sent.some((message) => message.type === 'reconnect_session')).toBe(false);
    context.client.disconnect();
    const unavailable = setup();
    vi.advanceTimersByTime(5_000);
    expect(unavailable.states.at(-1)).toBe('FAILED');
  });

  it('uses a 15-second receive watchdog while tolerating regular traffic and single late packets', () => {
    const context = setup();
    welcome(context.socket);
    vi.advanceTimersByTime(14_000);
    expect(context.client.isConnected).toBe(true);
    context.socket.receive({ type: 'server_tick', tick: 42 });
    vi.advanceTimersByTime(14_000);
    expect(context.client.isConnected).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(context.states.at(-1)).toBe('RECONNECTING');
  });

  it('supports a five-second development interruption and expires a sixteen-second interruption', () => {
    const context = setup();
    welcome(context.socket);
    context.client.debugDisconnectFor(5000);
    vi.advanceTimersByTime(4999);
    expect(Socket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    const next = Socket.instances.at(-1)!;
    welcome(next, PROVISIONAL);
    resume(next);
    expect(context.client.isConnected).toBe(true);
    context.client.debugDisconnectFor(16_000);
    vi.advanceTimersByTime(15_000);
    expect(context.states.at(-1)).toBe('FAILED');
    vi.advanceTimersByTime(5000);
    expect(Socket.instances).toHaveLength(2);
  });

  it('drops simulated stale input deliveries and ignores old-generation snapshots and transient events', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const context = setup();
    context.client.setNetworkSimulation({ latencyMs: 150, jitterMs: 20 });
    welcome(context.socket);
    vi.advanceTimersByTime(150);
    expect(context.client.isConnected).toBe(true);
    const messages: ServerMessage[] = [];
    context.client.onMessage((message) => messages.push(message));
    context.client.sendPlayerInput(100, {
      throttle: 1,
      brake: 0,
      steering: 0,
      handbrake: false,
    });
    context.socket.close();
    vi.advanceTimersByTime(500);
    const next = Socket.instances.at(-1)!;
    welcome(next, PROVISIONAL);
    vi.advanceTimersByTime(300);
    resume(next, snapshot());
    vi.advanceTimersByTime(150);
    expect(context.client.isConnected).toBe(true);
    expect(context.socket.sent.some((message) => message.type === 'player_input')).toBe(
      false,
    );
    context.socket.receive(snapshot());
    context.socket.receive({
      type: 'gameplay_event',
      event: {
        eventType: 'ram_hit',
        eventId: 'old',
        attackerPlayerId: 'local',
        targetPlayerId: 'remote',
        strength: 1,
        position: [0, 0, 0],
      },
    });
    vi.advanceTimersByTime(1000);
    expect(
      messages.filter(
        (message) =>
          message.type === 'world_snapshot' || message.type === 'gameplay_event',
      ),
    ).toHaveLength(0);
    expect(next.sent.filter((message) => message.type === 'player_input')).toHaveLength(
      0,
    );
  });
});

describe('full resync and production client config', () => {
  it('clears pending prediction inputs and old snapshot buffers, then continues server sequence safely', () => {
    const world = new World(new THREE.Scene());
    world.setLocalPlayerId('local');
    for (let tick = 0; tick < 12; tick += 1) {
      const state = snapshot();
      state.serverTick = tick * 3;
      world.applySnapshot(state);
      world.recordLocalInput(tick + 1, {
        throttle: 1,
        brake: 0,
        steering: 0,
        handbrake: false,
      });
      world.updateVisualState(1 / 60, {
        throttle: 1,
        brake: 0,
        steering: 0,
        handbrake: false,
      });
    }
    expect(world.getPredictionMetrics().pendingInputs).toBeGreaterThan(0);
    const old = world.getLocalVehicleObject();
    const full = snapshot();
    full.serverTick = 900;
    full.vehicles[0]!.position = [-20, 0.84, -6];
    full.vehicles[0]!.lastProcessedInputSequence = 42;
    world.resyncFromSnapshot(full, 'local');
    expect(world.getPredictionMetrics().pendingInputs).toBe(0);
    expect(world.getPredictionMetrics().lastAcknowledgedInput).toBe(42);
    expect(world.getNetworkMetrics().remoteSnapshotBufferSize).toBeLessThanOrEqual(1);
    world.updateVisualState(1 / 60, {
      throttle: 0,
      brake: 0,
      steering: 0,
      handbrake: false,
    });
    expect(world.getLocalVehicleObject()).not.toBe(old);
    expect(world.getLocalVehicleObject()?.position.toArray()).toEqual(
      full.vehicles[0]!.position,
    );
    expect(world.getPredictionMetrics().renderWriterConflicts).toBe(0);
    expect(world.getPredictionMetrics().renderWritesThisFrame).toBe(1);
    const send = vi.fn(() => true);
    const sequence = vi.fn();
    const transmitter = new InputTransmitter(
      () => ({ throttle: 0, brake: 0, steering: 0, handbrake: false }),
      send,
      sequence,
    );
    transmitter.resetSequence(42);
    transmitter.setEnabled(true);
    transmitter.start();
    vi.advanceTimersByTime(34);
    expect(send.mock.calls[0]?.[0]).toBe(43);
    expect(sequence.mock.calls[0]?.[0]).toBe(43);
    transmitter.stop();
    world.dispose();
  });

  it('constructs development WS and HTTPS production WSS addresses, including configured paths', () => {
    expect(
      resolveWebSocketUrl(
        undefined,
        { href: 'http://localhost:5173/', protocol: 'http:' },
        true,
      ),
    ).toBe('ws://localhost:3000/');
    expect(
      resolveWebSocketUrl(
        undefined,
        { href: 'https://arena.example/game', protocol: 'https:' },
        false,
      ),
    ).toBe('wss://arena.example/');
    expect(
      resolveWebSocketUrl(
        'wss://game.example/socket',
        { href: 'https://arena.example/', protocol: 'https:' },
        false,
      ),
    ).toBe('wss://game.example/socket');
    expect(() =>
      resolveWebSocketUrl(
        'ws://game.example/',
        { href: 'https://arena.example/', protocol: 'https:' },
        false,
      ),
    ).toThrow('wss');
    expect(() =>
      resolveWebSocketUrl(
        'https://game.example/',
        { href: 'http://localhost/', protocol: 'http:' },
        false,
      ),
    ).toThrow('VITE_WS_URL');
  });

  it('presents useful room/session errors without exposing raw server exceptions', () => {
    for (const code of [
      'ROOM_NOT_FOUND',
      'ROOM_FULL',
      'INVALID_PLAYER_NAME',
      'SESSION_EXPIRED',
      'SESSION_ACTIVE',
    ] as const)
      expect(friendlyServerError(code).length).toBeGreaterThan(20);
    expect(friendlyServerError('INTERNAL_ERROR')).not.toContain('Error:');
  });
});

function vehicle(playerId: string): VehicleStateSnapshot {
  return {
    playerId,
    lastProcessedInputSequence: -1,
    position: [0, 0.84, -6],
    rotation: [0, 0, 0, 1],
    linearVelocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    forwardSpeed: 0,
    lateralSpeed: 0,
    grounded: true,
    surfaceType: 'GROUND',
    onTrailer: false,
    relativeForwardSpeed: 0,
    relativeLateralSpeed: 0,
    wheelContacts: 4,
    trailerDeckContacts: 0,
    trailerRelativePosition: [0, 0, 0],
    flipped: false,
    selfRightAvailable: false,
    ramSlideRemainingTicks: 0,
  };
}
export function snapshot(): WorldSnapshotMessage {
  const body = {
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
    linearVelocity: [0, 0, 0] as [number, number, number],
    angularVelocity: [0, 0, 0] as [number, number, number],
  };
  return {
    type: 'world_snapshot',
    serverTick: 0,
    vehicles: [vehicle('local'), vehicle('remote')],
    convoy: { pathProgress: 0, speed: 0, truck: body, trailer: { ...body } },
    gameState: {
      phase: 'PLAYING',
      hostPlayerId: 'local',
      roundNumber: 1,
      stateStartTick: 0,
      stateEndTick: 5400,
      players: ['local', 'remote'].map((playerId) => ({
        playerId,
        playerName: playerId,
        ready: true,
        participant: true,
        isScoringOnTrailer: false,
        trailerTicks: 10,
        currentStreakTicks: 0,
        bestStreakTicks: 10,
        roundPoints: 0,
        sessionPoints: 10,
        connectionState: 'CONNECTED',
      })),
      results: [],
    },
  };
}
