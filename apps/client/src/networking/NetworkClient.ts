import { PING_INTERVAL_MS, createClientCodec } from '@trailer-arena/shared';
import type {
  ClientMessage,
  ProtocolCodec,
  ServerMessage,
  VehicleInputState,
} from '@trailer-arena/shared';

export type ConnectionState = 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED';
export type ConnectionStateListener = (state: ConnectionState) => void;
export type ServerMessageListener = (message: ServerMessage) => void;
export type ProtocolErrorListener = (message: string) => void;

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
  private socket: WebSocket | null = null;
  private pingTimer: number | null = null;
  private generation = 0;
  private state: ConnectionState = 'DISCONNECTED';
  private readonly simulatedTimers = new Set<number>();
  private simulationConfig: NetworkSimulationConfig = { latencyMs: 0, jitterMs: 0 };
  private lastOutgoingDeliveryAt = 0;
  private lastIncomingDeliveryAt = 0;

  public constructor(private readonly url: string) {}

  public connect(): void {
    if (this.state !== 'DISCONNECTED') {
      return;
    }

    this.generation += 1;
    const currentGeneration = this.generation;
    this.setState('CONNECTING');

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (currentGeneration !== this.generation) {
        return;
      }
      this.setState('CONNECTED');
      this.startPingTimer();
      this.sendPing();
    });
    socket.addEventListener('message', (event) => {
      if (currentGeneration !== this.generation) {
        return;
      }
      this.scheduleSimulatedDelivery('incoming', () => {
        if (currentGeneration === this.generation) this.handleMessage(event.data);
      });
    });
    socket.addEventListener('close', () => {
      if (currentGeneration !== this.generation) {
        return;
      }
      this.socket = null;
      this.stopPingTimer();
      this.clearSimulatedDeliveries();
      this.setState('DISCONNECTED');
    });
    socket.addEventListener('error', () => {
      if (currentGeneration === this.generation) {
        this.emitProtocolError('WebSocket connection error.');
      }
    });
  }

  public disconnect(): void {
    this.generation += 1;
    this.stopPingTimer();
    this.clearSimulatedDeliveries();
    this.socket?.close(1_000, 'Client disconnecting');
    this.socket = null;
    this.setState('DISCONNECTED');
  }

  public createRoom(playerName: string): boolean {
    return this.send({ type: 'join_room', playerName });
  }

  public joinRoom(playerName: string, roomId: string): boolean {
    return this.send({ type: 'join_room', playerName, roomId });
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
      return;
    }

    for (const listener of this.messageListeners) {
      listener(decoded.value);
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
