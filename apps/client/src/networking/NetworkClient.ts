import {
  PING_INTERVAL_MS,
  SESSION_GRACE_MS,
  HEARTBEAT_TIMEOUT_MS,
  createClientCodec,
} from '@trailer-arena/shared';
import type {
  ClientMessage,
  ProtocolCodec,
  ServerMessage,
  VehicleInputState,
} from '@trailer-arena/shared';
import { SessionTokenStore } from './SessionTokenStore.js';
import { reconnectDelay } from './ConnectionConfig.js';

export type ConnectionState =
  'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' | 'FAILED';
export type ConnectionStateListener = (state: ConnectionState) => void;
export type ServerMessageListener = (message: ServerMessage) => void;
export type ProtocolErrorListener = (message: string) => void;
export type RoomAction = 'NONE' | 'JOINING' | 'LEAVING';

export interface NetworkSimulationConfig {
  readonly latencyMs: number;
  readonly jitterMs: number;
}

export class NetworkClient {
  private readonly codec: ProtocolCodec<ServerMessage, ClientMessage> =
    createClientCodec();
  private readonly stateListeners = new Set<ConnectionStateListener>();
  private readonly messageListeners = new Set<ServerMessageListener>();
  private readonly protocolErrorListeners = new Set<ProtocolErrorListener>();
  private readonly roomActionListeners = new Set<(action: RoomAction) => void>();
  private pendingRoomAction: RoomAction = 'NONE';
  private leaveTimer: number | null = null;
  private leavingToken: string | null = null;
  private socket: WebSocket | null = null;
  private pingTimer: number | null = null;
  private generation = 0;
  private state: ConnectionState = 'DISCONNECTED';
  private readonly simulatedTimers = new Set<number>();
  private simulationConfig: NetworkSimulationConfig = { latencyMs: 0, jitterMs: 0 };
  private lastOutgoingDeliveryAt = 0;
  private lastIncomingDeliveryAt = 0;
  private retryTimer: number | null = null;
  private connectionTimer: number | null = null;
  private deadlineTimer: number | null = null;
  private healthTimer: number | null = null;
  private retryAttempt = 0;
  private reconnectDeadline: number | null = null;
  private reconnectWindowMs = SESSION_GRACE_MS;
  private lastReceivedAt = 0;
  private stopped = false;
  private autoReconnectAllowed = true;
  private debugPauseUntil = 0;
  private resumeToken: string | null = null;

  public constructor(
    private readonly url: string,
    private readonly tokenStore = new SessionTokenStore(url),
  ) {}

  public get isConnected(): boolean {
    return this.state === 'CONNECTED';
  }

  public get roomAction(): RoomAction {
    return this.pendingRoomAction;
  }

  public onRoomActionChange(listener: (action: RoomAction) => void): () => void {
    this.roomActionListeners.add(listener);
    listener(this.pendingRoomAction);
    return () => this.roomActionListeners.delete(listener);
  }

  public connect(): void {
    if (this.state !== 'DISCONNECTED' && this.state !== 'FAILED') return;
    this.stopped = false;
    this.autoReconnectAllowed = true;
    if (this.tokenStore.read() !== null) this.beginReconnectWindow();
    this.openSocket();
  }

  public connectFresh(): void {
    this.disconnect();
    this.tokenStore.write(null);
    this.connect();
  }

  private openSocket(): void {
    this.clearTimer('retry');
    this.resumeToken = this.tokenStore.read();

    this.generation += 1;
    const currentGeneration = this.generation;
    this.setState(this.resumeToken === null ? 'CONNECTING' : 'RECONNECTING');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.fail('Unable to open the server connection.');
      return;
    }
    this.socket = socket;
    this.connectionTimer = window.setTimeout(() => this.connectionLost(), 5_000);

    socket.addEventListener('open', () => {
      if (currentGeneration !== this.generation) {
        return;
      }
      this.lastReceivedAt = Date.now();
      this.startPingTimer();
      this.sendPing();
      this.healthTimer = window.setInterval(() => {
        if (Date.now() - this.lastReceivedAt >= HEARTBEAT_TIMEOUT_MS)
          this.connectionLost();
      }, 1_000);
    });
    socket.addEventListener('message', (event) => {
      if (currentGeneration !== this.generation) {
        return;
      }
      this.lastReceivedAt = Date.now();
      this.scheduleSimulatedDelivery('incoming', () => {
        if (currentGeneration === this.generation) this.handleMessage(event.data);
      });
    });
    socket.addEventListener('close', () => {
      if (currentGeneration !== this.generation) {
        return;
      }
      this.connectionLost();
    });
    socket.addEventListener('error', () => {
      if (currentGeneration === this.generation) {
        this.emitProtocolError('WebSocket connection error.');
      }
    });
  }

  public disconnect(): void {
    this.stopped = true;
    this.generation += 1;
    this.stopPingTimer();
    this.clearTimer('retry');
    this.clearTimer('connection');
    this.clearTimer('deadline');
    this.clearTimer('health');
    this.reconnectDeadline = null;
    this.retryAttempt = 0;
    this.clearSimulatedDeliveries();
    this.clearLeaveTimer();
    this.leavingToken = null;
    this.setRoomAction('NONE');
    this.socket?.close(1_000, 'Client disconnecting');
    this.socket = null;
    this.setState('DISCONNECTED');
  }

  public createRoom(playerName: string): boolean {
    return this.requestJoin({ type: 'join_room', playerName });
  }

  public joinRoom(playerName: string, roomId: string): boolean {
    return this.requestJoin({ type: 'join_room', playerName, roomId });
  }

  private requestJoin(message: Extract<ClientMessage, { type: 'join_room' }>): boolean {
    if (!this.isConnected || this.pendingRoomAction !== 'NONE') return false;
    this.autoReconnectAllowed = true;
    this.setRoomAction('JOINING');
    const sent = this.send(message);
    if (!sent) this.setRoomAction('NONE');
    return sent;
  }

  public leaveRoom(): boolean {
    if (this.pendingRoomAction !== 'NONE') return false;
    this.autoReconnectAllowed = false;
    this.leavingToken = this.tokenStore.read();
    this.tokenStore.write(null);
    this.resumeToken = null;
    this.clearSimulatedDeliveries();
    this.setRoomAction('LEAVING');
    const sent = this.send({ type: 'leave_room' });
    if (!sent) this.disconnect();
    else
      this.leaveTimer = window.setTimeout(
        () =>
          this.fail('Room leave was not confirmed. Connect again to return to the menu.'),
        5_000,
      );
    return sent;
  }

  private setRoomAction(action: RoomAction): void {
    if (action === this.pendingRoomAction) return;
    this.pendingRoomAction = action;
    for (const listener of this.roomActionListeners) listener(action);
  }

  private clearLeaveTimer(): void {
    if (this.leaveTimer !== null) window.clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
  }

  public debugDisconnectFor(milliseconds: number): void {
    this.debugPauseUntil = Date.now() + Math.max(0, Math.min(30_000, milliseconds));
    this.connectionLost();
  }

  public sendPlayerInput(sequence: number, input: Readonly<VehicleInputState>): boolean {
    return this.send({
      type: 'player_input',
      sequence,
      throttle: input.throttle,
      brake: input.brake,
      steering: input.steering,
      handbrake: input.handbrake,
    });
  }

  public resetVehicle(): boolean {
    return this.send({ type: 'reset_vehicle' });
  }

  public selfRightVehicle(): boolean {
    return this.send({ type: 'self_right_vehicle' });
  }

  public setReady(ready: boolean): boolean {
    return this.send({ type: 'set_ready', ready });
  }

  public startMatch(): boolean {
    return this.send({ type: 'start_match' });
  }

  public nextRound(): boolean {
    return this.send({ type: 'next_round' });
  }

  public debugTeleportNearTrailer(): boolean {
    return this.send({ type: 'debug_teleport_near_trailer' });
  }

  public debugTeleportOntoTrailer(): boolean {
    return this.send({ type: 'debug_teleport_onto_trailer' });
  }

  public debugFlipVehicle(): boolean {
    return this.send({ type: 'debug_flip_vehicle' });
  }

  public debugTestUnderbody(): boolean {
    return this.send({ type: 'debug_test_underbody' });
  }

  public debugTestPlayerCollision(): boolean {
    return this.send({ type: 'debug_test_player_collision' });
  }

  public setNetworkSimulation(config: NetworkSimulationConfig): void {
    this.simulationConfig = {
      latencyMs: clampSimulationValue(config.latencyMs, 0, 200),
      jitterMs: clampSimulationValue(config.jitterMs, 0, 50),
    };
  }

  public onStateChange(listener: ConnectionStateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  public onMessage(listener: ServerMessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  public onProtocolError(listener: ProtocolErrorListener): () => void {
    this.protocolErrorListeners.add(listener);
    return () => this.protocolErrorListeners.delete(listener);
  }

  private send(message: ClientMessage): boolean {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (
      !this.isConnected &&
      message.type !== 'ping' &&
      message.type !== 'reconnect_session'
    )
      return false;
    if (
      this.pendingRoomAction === 'LEAVING' &&
      message.type !== 'leave_room' &&
      message.type !== 'ping'
    )
      return false;
    const encoded = this.codec.encode(message);
    const generation = this.generation;
    this.scheduleSimulatedDelivery('outgoing', () => {
      if (
        generation === this.generation &&
        socket === this.socket &&
        socket.readyState === WebSocket.OPEN
      ) {
        socket.send(encoded);
      }
    });
    return true;
  }

  private scheduleSimulatedDelivery(
    direction: 'incoming' | 'outgoing',
    deliver: () => void,
  ): void {
    const now = performance.now();
    const jitter =
      this.simulationConfig.jitterMs === 0
        ? 0
        : (Math.random() * 2 - 1) * this.simulationConfig.jitterMs;
    const requestedAt = now + Math.max(0, this.simulationConfig.latencyMs + jitter);
    const previousAt =
      direction === 'incoming'
        ? this.lastIncomingDeliveryAt
        : this.lastOutgoingDeliveryAt;
    const deliveryAt = Math.max(requestedAt, previousAt + 0.01);
    if (direction === 'incoming') this.lastIncomingDeliveryAt = deliveryAt;
    else this.lastOutgoingDeliveryAt = deliveryAt;

    if (deliveryAt <= now + 0.1) {
      deliver();
      return;
    }
    const timer = window.setTimeout(() => {
      this.simulatedTimers.delete(timer);
      deliver();
    }, deliveryAt - now);
    this.simulatedTimers.add(timer);
  }

  private clearSimulatedDeliveries(): void {
    for (const timer of this.simulatedTimers) window.clearTimeout(timer);
    this.simulatedTimers.clear();
    this.lastOutgoingDeliveryAt = 0;
    this.lastIncomingDeliveryAt = 0;
  }

  private handleMessage(rawData: unknown): void {
    if (typeof rawData !== 'string') {
      this.emitProtocolError('Received an unsupported non-text server message.');
      return;
    }

    const decoded = this.codec.decode(rawData);
    if (!decoded.ok) {
      this.emitProtocolError(decoded.error);
      if (this.state === 'RECONNECTING') this.fail('Invalid session response.');
      return;
    }

    const message = decoded.value;
    if (message.type === 'connected') {
      this.reconnectWindowMs = message.reconnectWindowMs;
      if (this.resumeToken !== null) {
        this.send({ type: 'reconnect_session', sessionToken: this.resumeToken });
        return; // Never overwrite the saved capability with the provisional token.
      }
      this.tokenStore.write(message.sessionToken);
      this.finishHandshake();
    } else if (message.type === 'session_resumed') {
      if (message.sessionToken !== this.resumeToken) {
        this.fail('Invalid session response.');
        return;
      }
      this.tokenStore.write(message.sessionToken);
      this.finishHandshake();
    } else if (message.type === 'room_left') {
      this.clearLeaveTimer();
      this.leavingToken = null;
      this.tokenStore.write(message.sessionToken);
      this.autoReconnectAllowed = true;
      this.setRoomAction('NONE');
    } else if (message.type === 'room_joined') {
      this.setRoomAction('NONE');
    } else if (message.type === 'error' && this.pendingRoomAction !== 'NONE') {
      if (this.pendingRoomAction === 'LEAVING') {
        this.clearLeaveTimer();
        this.tokenStore.write(this.leavingToken);
        this.leavingToken = null;
        this.autoReconnectAllowed = true;
      }
      this.setRoomAction('NONE');
    } else if (message.type === 'error' && this.state === 'RECONNECTING') {
      for (const listener of this.messageListeners) listener(message);
      this.fail(
        message.code === 'SESSION_ACTIVE'
          ? 'Session is already connected in another tab.'
          : 'Session expired or server restarted.',
      );
      return;
    } else if (this.state !== 'CONNECTED' && message.type !== 'pong') return;

    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  private finishHandshake(): void {
    this.clearTimer('connection');
    this.clearTimer('deadline');
    this.reconnectDeadline = null;
    this.retryAttempt = 0;
    this.resumeToken = null;
    this.setState('CONNECTED');
  }

  private connectionLost(): void {
    if (this.stopped || this.state === 'FAILED') return;
    this.generation += 1;
    this.stopPingTimer();
    this.clearTimer('connection');
    this.clearTimer('health');
    this.clearSimulatedDeliveries();
    this.clearLeaveTimer();
    this.leavingToken = null;
    this.setRoomAction('NONE');
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'Transport interrupted');
    if (!this.autoReconnectAllowed || this.tokenStore.read() === null) {
      this.fail('Connection lost. Please connect again.');
      return;
    }
    this.beginReconnectWindow();
    this.setState('RECONNECTING');
    const delay = Math.max(
      reconnectDelay(this.retryAttempt++),
      this.debugPauseUntil - Date.now(),
    );
    this.clearTimer('retry');
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (this.reconnectDeadline !== null && Date.now() < this.reconnectDeadline)
        this.openSocket();
      else this.fail('Session expired. Please join a room again.');
    }, delay);
  }

  private beginReconnectWindow(): void {
    if (this.reconnectDeadline !== null) return;
    this.reconnectDeadline = Date.now() + this.reconnectWindowMs;
    this.deadlineTimer = window.setTimeout(
      () => this.fail('Session expired or server unavailable. Please join a room again.'),
      this.reconnectWindowMs,
    );
  }

  private fail(message: string): void {
    this.disconnect();
    this.tokenStore.write(null);
    this.setState('FAILED');
    this.emitProtocolError(message);
  }

  private clearTimer(kind: 'retry' | 'connection' | 'deadline' | 'health'): void {
    const key = `${kind}Timer` as const;
    const timer = this[key];
    if (timer !== null) {
      window.clearTimeout(timer);
      this[key] = null;
    }
  }

  private sendPing(): void {
    this.send({ type: 'ping', timestamp: Date.now() });
  }

  private startPingTimer(): void {
    this.stopPingTimer();
    this.pingTimer = window.setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  private stopPingTimer(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  private emitProtocolError(message: string): void {
    for (const listener of this.protocolErrorListeners) {
      listener(message);
    }
  }
}

function clampSimulationValue(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
