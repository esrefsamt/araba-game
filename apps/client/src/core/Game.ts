import type { ServerMessage } from '@trailer-arena/shared';

import { DebugPanel } from '../debug/DebugPanel.js';
import { InputManager } from '../input/InputManager.js';
import { InputTransmitter } from '../networking/InputTransmitter.js';
import { NetworkClient } from '../networking/NetworkClient.js';
import { ChaseCamera } from '../camera/ChaseCamera.js';
import { Renderer } from '../rendering/Renderer.js';
import { SceneManager } from '../rendering/SceneManager.js';
import { World } from '../world/World.js';
import { GameHud } from '../ui/GameHud.js';
import { GameLoop } from './GameLoop.js';

const DEFAULT_WEBSOCKET_URL = 'ws://localhost:3000';

export class Game {
  private readonly renderer: Renderer;
  private readonly sceneManager = new SceneManager();
  private readonly chaseCamera = new ChaseCamera();
  private readonly networkClient = new NetworkClient(
    import.meta.env.VITE_WS_URL ?? DEFAULT_WEBSOCKET_URL,
  );
  private readonly inputManager = new InputManager();
  private readonly gameHud: GameHud;
  private readonly world = new World(this.sceneManager.scene);
  private readonly debugPanel: DebugPanel;
  private readonly inputTransmitter: InputTransmitter;
  private readonly gameLoop: GameLoop;
  private snapshotCount = 0;
  private snapshotWindowStartedAt = performance.now();
  private telemetryAccumulator = 0;
  private localPlayerId: string | null = null;

  public constructor(container: HTMLElement) {
    this.renderer = new Renderer(container);
    this.debugPanel = new DebugPanel({
      createRoom: (playerName) => {
        if (!this.networkClient.createRoom(playerName)) {
          this.debugPanel.setMessage('Cannot create a room while disconnected.', true);
        }
      },
      joinRoom: (playerName, roomId) => {
        if (!this.networkClient.joinRoom(playerName, roomId)) {
          this.debugPanel.setMessage('Cannot join a room while disconnected.', true);
        }
      },
      resetVehicle: () => {
        if (this.networkClient.resetVehicle()) {
          this.world.prepareForAuthoritativeDiscontinuity();
        } else {
          this.debugPanel.setMessage('Cannot reset while disconnected.', true);
        }
      },
      forceResync: () => {
        if (this.world.forceResync()) {
          this.debugPanel.setMessage('Prediction resynced from authoritative state.');
        } else {
          this.debugPanel.setMessage('No authoritative vehicle state available.', true);
        }
      },
      setNetworkSimulation: (latencyMs, jitterMs) => {
        this.networkClient.setNetworkSimulation({ latencyMs, jitterMs });
        // The development queue applies latency independently in both
        // directions, so this is the exact RTT baseline until the next pong.
        this.world.setRoundTripLatencyMs(latencyMs * 2);
        this.debugPanel.setMessage(
          `Network simulation: ${latencyMs} ms latency, ±${jitterMs} ms jitter.`,
        );
      },
      setLocalPredictionEnabled: (enabled) => {
        this.world.setPredictionEnabled(enabled);
        this.debugPanel.setMessage(
          `Local prediction ${enabled ? 'enabled' : 'disabled'}.`,
        );
      },
      teleportNearTrailer: () => {
        if (this.networkClient.debugTeleportNearTrailer()) {
          this.world.prepareForAuthoritativeDiscontinuity();
        } else {
          this.debugPanel.setMessage('Cannot teleport while disconnected.', true);
        }
      },
      teleportOntoTrailer: () => {
        if (this.networkClient.debugTeleportOntoTrailer()) {
          this.world.prepareForAuthoritativeDiscontinuity();
        } else {
          this.debugPanel.setMessage('Cannot teleport while disconnected.', true);
        }
      },
      flipVehicle: () => {
        if (this.networkClient.debugFlipVehicle()) {
          this.world.prepareForAuthoritativeDiscontinuity();
        } else {
          this.debugPanel.setMessage('Cannot flip while disconnected.', true);
        }
      },
      testUnderbody: () => {
        if (this.networkClient.debugTestUnderbody()) {
          this.world.prepareForAuthoritativeDiscontinuity();
        } else {
          this.debugPanel.setMessage(
            'Cannot run collision test while disconnected.',
            true,
          );
        }
      },
      testPlayerCollision: () => {
        if (this.networkClient.debugTestPlayerCollision()) {
          this.world.prepareForAuthoritativeDiscontinuity();
        } else {
          this.debugPanel.setMessage(
            'Collision test needs a connected two-player room.',
            true,
          );
        }
      },
    });
    this.gameHud = new GameHud({
      setReady: (ready) => {
        if (!this.networkClient.setReady(ready)) {
          this.debugPanel.setMessage('Cannot change ready state.', true);
        }
      },
      startMatch: () => {
        if (!this.networkClient.startMatch()) {
          this.debugPanel.setMessage('Cannot start match while disconnected.', true);
        }
      },
      nextRound: () => {
        if (!this.networkClient.nextRound()) {
          this.debugPanel.setMessage('Cannot start next round.', true);
        }
      },
    });
    this.inputTransmitter = new InputTransmitter(
      () => this.inputManager.getState(),
      (sequence, input) => this.networkClient.sendPlayerInput(sequence, input),
      (sequence, input) => {
        this.debugPanel.setInputSequence(sequence);
        this.world.recordLocalInput(sequence, input);
      },
    );
    this.inputManager.onSelfRight(() => {
      if (this.networkClient.selfRightVehicle()) {
        this.world.prepareForAuthoritativeDiscontinuity();
      } else {
        this.debugPanel.setMessage('Cannot self-right while disconnected.', true);
      }
    });
    this.gameLoop = new GameLoop((deltaSeconds, elapsedSeconds) => {
      this.world.updateVisualState(deltaSeconds, this.inputManager.getState());
      this.gameHud.update();
      const localVehicle = this.world.getLocalVehicleObject();
      const localSnapshot = this.world.getLocalVehicleSnapshot();
      const convoySnapshot = this.world.getConvoySnapshot();
      this.chaseCamera.setTarget(localVehicle);
      this.chaseCamera.update(deltaSeconds, localSnapshot?.forwardSpeed ?? 0);
      this.updateTelemetry(deltaSeconds, localSnapshot, convoySnapshot);
      this.sceneManager.update(elapsedSeconds);
      this.renderer.render(this.sceneManager.scene, this.chaseCamera.camera);
    });

    this.bindNetworkEvents();
    window.addEventListener('resize', this.handleResize);
  }

  public start(): void {
    this.inputManager.start();
    this.inputTransmitter.start();
    this.networkClient.connect();
    this.gameLoop.start();
  }

  public dispose(): void {
    window.removeEventListener('resize', this.handleResize);
    this.gameLoop.stop();
    this.networkClient.disconnect();
    this.inputTransmitter.stop();
    this.inputManager.stop();
    this.world.dispose();
    this.renderer.dispose();
  }

  private bindNetworkEvents(): void {
    this.networkClient.onStateChange((state) => {
      this.debugPanel.setConnection(state);
      if (state === 'DISCONNECTED') {
        this.world.clear();
        this.localPlayerId = null;
        this.gameHud.setLocalContext(null, null);
        this.setGameplayInputEnabled(false);
      }
    });
    this.networkClient.onProtocolError((message) => {
      this.debugPanel.setMessage(message, true);
    });
    this.networkClient.onMessage((message) => {
      this.handleServerMessage(message);
    });
  }

  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'connected':
        this.debugPanel.setMessage('Server handshake complete.');
        break;
      case 'room_joined':
        this.localPlayerId = message.playerId;
        this.debugPanel.setPlayerId(message.playerId);
        this.debugPanel.setRoomId(message.roomId);
        this.world.setLocalPlayerId(message.playerId);
        this.gameHud.setLocalContext(message.playerId, message.roomId);
        this.snapshotCount = 0;
        this.snapshotWindowStartedAt = performance.now();
        this.debugPanel.clearSnapshotRate();
        this.debugPanel.setMessage(`Joined room ${message.roomId}.`);
        break;
      case 'player_joined':
        this.debugPanel.setMessage(`${message.playerName} joined the room.`);
        break;
      case 'player_left':
        this.world.removeVehicle(message.playerId);
        this.debugPanel.setMessage(`Player ${shortId(message.playerId)} left the room.`);
        break;
      case 'pong':
        {
          const roundTripLatencyMs = Math.max(0, Date.now() - message.timestamp);
          this.debugPanel.setPing(roundTripLatencyMs);
          this.world.setRoundTripLatencyMs(roundTripLatencyMs);
        }
        break;
      case 'server_tick':
        this.debugPanel.setServerTick(message.tick);
        break;
      case 'world_snapshot':
        this.world.applySnapshot(message);
        this.gameHud.applySnapshot(message.gameState, message.serverTick);
        this.setGameplayInputEnabled(
          message.gameState.phase === 'PLAYING' &&
            (message.gameState.players.find(
              (player) => player.playerId === this.localPlayerId,
            )?.participant ??
              false),
        );
        this.recordSnapshot();
        break;
      case 'error':
        this.debugPanel.setMessage(`${message.code}: ${message.message}`, true);
        break;
    }
  }

  private setGameplayInputEnabled(enabled: boolean): void {
    this.inputManager.setEnabled(enabled);
    this.inputTransmitter.setEnabled(enabled);
    this.debugPanel.setGameplayControlsEnabled(enabled);
  }

  private readonly handleResize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.resize(width, height);
    this.chaseCamera.resize(width, height);
  };

  private recordSnapshot(): void {
    this.snapshotCount += 1;
    const now = performance.now();
    const elapsedSeconds = (now - this.snapshotWindowStartedAt) / 1_000;
    if (elapsedSeconds >= 1) {
      this.debugPanel.setSnapshotRate(this.snapshotCount / elapsedSeconds);
      this.snapshotCount = 0;
      this.snapshotWindowStartedAt = now;
    }
  }

  private updateTelemetry(
    deltaSeconds: number,
    snapshot:
      Extract<ServerMessage, { type: 'world_snapshot' }>['vehicles'][number] | null,
    convoy: Extract<ServerMessage, { type: 'world_snapshot' }>['convoy'] | null,
  ): void {
    this.telemetryAccumulator += deltaSeconds;
    if (this.telemetryAccumulator < 0.1 || snapshot === null) {
      return;
    }
    this.telemetryAccumulator = 0;
    const [velocityX, velocityY, velocityZ] = snapshot.linearVelocity;
    const speed = Math.hypot(velocityX, velocityY, velocityZ);
    const input = this.inputManager.getState();
    this.debugPanel.setVehicleTelemetry(
      speed,
      snapshot.position,
      snapshot.forwardSpeed,
      snapshot.lateralSpeed,
      snapshot.grounded,
      input.throttle,
      input.steering,
      snapshot.surfaceType,
      snapshot.onTrailer,
      snapshot.relativeForwardSpeed,
      snapshot.relativeLateralSpeed,
      snapshot.wheelContacts,
      snapshot.trailerRelativePosition,
      snapshot.flipped,
      snapshot.selfRightAvailable,
    );
    if (convoy !== null) {
      this.debugPanel.setConvoyTelemetry(convoy.speed, convoy.pathProgress);
    }
    this.debugPanel.setPredictionTelemetry(
      this.world.getPredictionMetrics(),
      this.world.getNetworkMetrics(),
    );
  }
}

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 12)}…`;
}
