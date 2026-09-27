import type { ServerMessage } from '@trailer-arena/shared';

import { AudioManager } from '../audio/AudioManager.js';
import { DebugPanel } from '../debug/DebugPanel.js';
import { ArcadeFeedbackSystem } from '../effects/ArcadeFeedbackSystem.js';
import { InputManager } from '../input/InputManager.js';
import { InputTransmitter } from '../networking/InputTransmitter.js';
import { NetworkClient } from '../networking/NetworkClient.js';
import { loadClientConfig } from '../config/ClientConfig.js';
import { ChaseCamera } from '../camera/ChaseCamera.js';
import { Renderer } from '../rendering/Renderer.js';
import { SceneManager } from '../rendering/SceneManager.js';
import { World } from '../world/World.js';
import { GameHud } from '../ui/GameHud.js';
import { SessionPanel, friendlyServerError } from '../ui/SessionPanel.js';
import { GameLoop } from './GameLoop.js';

export class Game {
  private readonly renderer: Renderer;
  private readonly sceneManager = new SceneManager();
  private readonly chaseCamera = new ChaseCamera();
  private readonly networkClient = new NetworkClient(
    loadClientConfig(import.meta.env, window.location).webSocketUrl,
  );
  private readonly inputManager = new InputManager();
  private readonly audio = new AudioManager();
  private readonly gameHud: GameHud;
  private readonly sessionPanel: SessionPanel;
  private readonly world = new World(this.sceneManager.scene);
  private readonly debugPanel: DebugPanel;
  private readonly feedback: ArcadeFeedbackSystem;
  private readonly inputTransmitter: InputTransmitter;
  private readonly gameLoop: GameLoop;
  private snapshotCount = 0;
  private snapshotWindowStartedAt = performance.now();
  private telemetryAccumulator = 0;
  private renderStatsAccumulator = 0;
  private renderFrames = 0;
  private localPlayerId: string | null = null;

  public constructor(container: HTMLElement) {
    this.renderer = new Renderer(container);
    this.feedback = new ArcadeFeedbackSystem(
      this.sceneManager.scene,
      getRequiredElement('feedback-overlay'),
      {
        cameraShake: (strength) => this.chaseCamera.addImpactShake(strength),
        playCollision: (strength) => this.audio.playCollision(strength),
        playRam: (strength) => this.audio.playRam(strength),
      },
    );
    this.debugPanel = new DebugPanel({
      disconnectFor: (milliseconds) => {
        if (import.meta.env.DEV) this.networkClient.debugDisconnectFor(milliseconds);
      },
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
      playAudioCue: (cue) => this.audio.playCue(cue),
      toggleSound: () => this.audio.toggleEnabled(),
    });
    this.sessionPanel = new SessionPanel({
      createRoom: (name) => {
        if (!this.networkClient.createRoom(name))
          this.sessionPanel.setMessage('Connect to the server first.');
      },
      joinRoom: (name, code) => {
        if (!this.networkClient.joinRoom(name, code))
          this.sessionPanel.setMessage('Connect to the server first.');
      },
      leaveRoom: () => {
        this.networkClient.leaveRoom();
      },
      connectFresh: () => {
        this.clearRoomState();
        this.networkClient.connectFresh();
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
    this.gameLoop = new GameLoop((deltaSeconds) => {
      const input = this.inputManager.getState();
      this.world.updateVisualState(deltaSeconds, input);
      this.gameHud.update();
      this.sessionPanel.update();
      const localVehicle = this.world.getLocalVehicleObject();
      const localSnapshot = this.world.getLocalVehicleSnapshot();
      const convoySnapshot = this.world.getConvoySnapshot();
      this.chaseCamera.setTarget(localVehicle);
      this.chaseCamera.update(deltaSeconds, localSnapshot?.forwardSpeed ?? 0);
      this.world.updateNameplates(this.chaseCamera.camera.position);
      this.feedback.update(deltaSeconds, localSnapshot, input);
      this.audio.updateLocalEngine(
        localSnapshot?.forwardSpeed ?? 0,
        input.throttle,
        localSnapshot?.lateralSpeed ?? 0,
        deltaSeconds,
        input.brake > 0,
        localSnapshot !== null,
      );
      this.audio.updateRemoteEngines(
        this.world.getRemoteEngineStates(),
        [
          this.chaseCamera.camera.position.x,
          this.chaseCamera.camera.position.y,
          this.chaseCamera.camera.position.z,
        ],
        deltaSeconds,
      );
      this.updateTelemetry(deltaSeconds, localSnapshot, convoySnapshot);
      this.renderer.render(this.sceneManager.scene, this.chaseCamera.camera);
      this.updateRenderStats(deltaSeconds);
    });

    this.bindNetworkEvents();
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('pointerdown', this.handleFirstInteraction);
    window.addEventListener('keydown', this.handleFirstInteraction);
  }

  public start(): void {
    this.inputManager.start();
    this.inputTransmitter.start();
    this.networkClient.connect();
    this.gameLoop.start();
  }

  public dispose(): void {
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('pointerdown', this.handleFirstInteraction);
    window.removeEventListener('keydown', this.handleFirstInteraction);
    this.gameLoop.stop();
    this.networkClient.disconnect();
    this.inputTransmitter.stop();
    this.inputManager.stop();
    this.world.dispose();
    this.feedback.dispose();
    this.audio.dispose();
    this.renderer.dispose();
  }

  private bindNetworkEvents(): void {
    this.networkClient.onRoomActionChange((action) => {
      this.sessionPanel.setRoomAction(action);
      this.gameHud.setConnection(this.networkClient.isConnected && action === 'NONE');
      if (action === 'LEAVING') {
        this.setGameplayInputEnabled(false);
        this.world.prepareForAuthoritativeDiscontinuity();
      }
    });
    this.networkClient.onStateChange((state) => {
      this.debugPanel.setConnection(state);
      this.sessionPanel.setConnection(state);
      this.gameHud.setConnection(
        state === 'CONNECTED' && this.networkClient.roomAction === 'NONE',
      );
      if (state === 'RECONNECTING' || state === 'CONNECTING') {
        this.world.prepareForAuthoritativeDiscontinuity();
        this.setGameplayInputEnabled(false);
      } else if (state === 'DISCONNECTED' || state === 'FAILED') {
        this.clearRoomState();
      }
    });
    this.networkClient.onProtocolError((message) => {
      this.debugPanel.setMessage(message, true);
      this.sessionPanel.setMessage(message);
    });
    this.networkClient.onMessage((message) => {
      this.handleServerMessage(message);
    });
  }

  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'room_left':
        this.clearRoomState();
        break;
      case 'session_resumed': {
        const { playerId, roomId, state } = message;
        this.clearRoomState();
        if (playerId !== null && roomId !== null && state !== null) {
          this.localPlayerId = playerId;
          this.debugPanel.setPlayerId(playerId);
          this.debugPanel.setRoomId(roomId);
          this.sessionPanel.setRoom(roomId);
          this.world.resyncFromSnapshot(state, playerId);
          this.gameHud.setLocalContext(playerId, roomId);
          this.gameHud.applyFullSnapshot(state.gameState, state.serverTick);
          const local = state.vehicles.find((vehicle) => vehicle.playerId === playerId)!;
          this.inputTransmitter.resetSequence(local.lastProcessedInputSequence);
          this.setGameplayInputEnabled(
            state.gameState.phase === 'PLAYING' &&
              (state.gameState.players.find((player) => player.playerId === playerId)
                ?.participant ??
                false),
          );
          this.debugPanel.setMessage('Session restored from full authoritative state.');
        }
        this.sessionPanel.showReconnected();
        break;
      }
      case 'connected':
        this.debugPanel.setMessage('Server handshake complete.');
        break;
      case 'room_joined':
        this.clearRoomState();
        this.localPlayerId = message.playerId;
        this.debugPanel.setPlayerId(message.playerId);
        this.debugPanel.setRoomId(message.roomId);
        this.world.setLocalPlayerId(message.playerId);
        this.gameHud.setLocalContext(message.playerId, message.roomId);
        this.sessionPanel.setRoom(message.roomId);
        this.inputTransmitter.resetSequence(-1);
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
        if (!this.networkClient.isConnected || this.localPlayerId === null) break;
        this.world.applySnapshot(message);
        this.gameHud.applySnapshot(message.gameState, message.serverTick);
        this.setGameplayInputEnabled(
          this.networkClient.roomAction === 'NONE' &&
            message.gameState.phase === 'PLAYING' &&
            (message.gameState.players.find(
              (player) => player.playerId === this.localPlayerId,
            )?.participant ??
              false),
        );
        this.recordSnapshot();
        break;
      case 'gameplay_event':
        if (this.networkClient.isConnected && this.localPlayerId !== null)
          this.feedback.handleRamEvent(message.event, this.localPlayerId);
        break;
      case 'error':
        this.debugPanel.setMessage(friendlyServerError(message.code), true);
        this.sessionPanel.setError(message.code);
        break;
    }
  }

  private setGameplayInputEnabled(enabled: boolean): void {
    this.inputManager.setEnabled(enabled);
    this.inputTransmitter.setEnabled(enabled);
    this.debugPanel.setGameplayControlsEnabled(enabled);
  }

  private clearRoomState(): void {
    this.world.clear();
    this.feedback.clear();
    this.localPlayerId = null;
    this.gameHud.clear();
    this.sessionPanel.setRoom(null);
    this.inputTransmitter.resetSequence(-1);
    this.debugPanel.clearRoomTelemetry();
    this.debugPanel.setPredictionTelemetry(
      this.world.getPredictionMetrics(),
      this.world.getNetworkMetrics(),
    );
    this.debugPanel.setPlayerId(null);
    this.debugPanel.setRoomId(null);
    this.snapshotCount = 0;
    this.snapshotWindowStartedAt = performance.now();
    this.setGameplayInputEnabled(false);
  }

  private readonly handleResize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.resize(width, height);
    this.chaseCamera.resize(width, height);
  };

  private readonly handleFirstInteraction = (): void => {
    void this.audio.unlock();
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

  private updateRenderStats(deltaSeconds: number): void {
    this.renderStatsAccumulator += deltaSeconds;
    this.renderFrames += 1;
    if (this.renderStatsAccumulator < 0.5) return;
    const stats = this.renderer.stats;
    this.debugPanel.setRenderStats(
      this.renderFrames / this.renderStatsAccumulator,
      stats.drawCalls,
      stats.triangles,
    );
    this.renderStatsAccumulator = 0;
    this.renderFrames = 0;
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

function getRequiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Required element #${id} is missing.`);
  return element;
}

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 12)}…`;
}
