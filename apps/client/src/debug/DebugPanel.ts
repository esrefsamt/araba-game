import type { ConnectionState } from '../networking/NetworkClient.js';
import type { PredictionMetrics } from '../prediction/AuthoritativePredictionProxy.js';
import type { WorldNetworkMetrics } from '../world/World.js';

export interface DebugPanelActions {
  disconnectFor(milliseconds: number): void;
  createRoom(playerName: string): void;
  joinRoom(playerName: string, roomId: string): void;
  resetVehicle(): void;
  forceResync(): void;
  setNetworkSimulation(latencyMs: number, jitterMs: number): void;
  setLocalPredictionEnabled(enabled: boolean): void;
  teleportNearTrailer(): void;
  teleportOntoTrailer(): void;
  flipVehicle(): void;
  testUnderbody(): void;
  testPlayerCollision(): void;
}

export class DebugPanel {
  private readonly root = getElement('debug-panel');
  private readonly connectionElement = getElement('connection-status');
  private readonly playerIdElement = getElement('player-id');
  private readonly roomIdElement = getElement('room-id');
  private readonly pingElement = getElement('ping');
  private readonly serverTickElement = getElement('server-tick');
  private readonly vehicleSpeedElement = getElement('vehicle-speed');
  private readonly vehiclePositionElement = getElement('vehicle-position');
  private readonly snapshotRateElement = getElement('snapshot-rate');
  private readonly inputSequenceElement = getElement('input-sequence');
  private readonly vehicleDebugElement = getElement('vehicle-debug');
  private readonly convoyDebugElement = getElement('convoy-debug');
  private readonly surfaceDebugElement = getElement('surface-debug');
  private readonly trailerDebugElement = getElement('trailer-debug');
  private readonly recoveryDebugElement = getElement('recovery-debug');
  private readonly predictionStatusElement = getElement('prediction-status');
  private readonly pendingInputsElement = getElement('pending-inputs');
  private readonly inputAckElement = getElement('input-ack');
  private readonly predictionErrorElement = getElement('prediction-error');
  private readonly predictionAverageErrorElement = getElement('prediction-average-error');
  private readonly visualCorrectionOffsetElement = getElement('visual-correction-offset');
  private readonly predictionLeadOffsetElement = getElement('prediction-lead-offset');
  private readonly reconciliationStatsElement = getElement('reconciliation-stats');
  private readonly predictionReplaysElement = getElement('prediction-replays');
  private readonly correctionStatsElement = getElement('correction-stats');
  private readonly predictionTickElement = getElement('prediction-tick');
  private readonly predictionWriterElement = getElement('prediction-writer');
  private readonly predictionStateElement = getElement('prediction-state');
  private readonly predictionVelocityElement = getElement('prediction-velocity');
  private readonly snapshotBufferElement = getElement('snapshot-buffer');
  private readonly networkJitterElement = getElement('network-jitter');
  private readonly renderStatsElement = getElement('render-stats');
  private readonly messageElement = getElement('network-message');
  private readonly playerNameInput = getInput('player-name');
  private readonly roomCodeInput = getInput('room-code');
  private readonly createButton = getButton('create-room');
  private readonly joinButton = getButton('join-room');
  private readonly resetButton = getButton('reset-vehicle');
  private readonly teleportButton = getButton('teleport-trailer');
  private readonly teleportOntoButton = getButton('teleport-onto-trailer');
  private readonly flipButton = getButton('flip-vehicle');
  private readonly underbodyButton = getButton('test-underbody');
  private readonly playerCollisionButton = getButton('test-player-collision');
  private readonly forceResyncButton = getButton('force-resync');
  private readonly networkSimulationControls = getElement('network-simulation-controls');
  private readonly predictionToggle = getButton('prediction-toggle');
  private readonly latencySelect = getSelect('network-latency');
  private readonly jitterSelect = getSelect('network-jitter-select');
  private predictionEnabled = true;

  public constructor(actions: DebugPanelActions) {
    const disconnectFive = getButton('disconnect-five');
    const disconnectExpire = getButton('disconnect-expire');
    disconnectFive.hidden = disconnectExpire.hidden = !import.meta.env.DEV;
    disconnectFive.addEventListener('click', () => actions.disconnectFor(5_000));
    disconnectExpire.addEventListener('click', () => actions.disconnectFor(16_000));
    this.createButton.addEventListener('click', () => {
      actions.createRoom(this.playerNameInput.value);
    });
    this.joinButton.addEventListener('click', () => {
      actions.joinRoom(this.playerNameInput.value, this.roomCodeInput.value);
    });
    this.roomCodeInput.addEventListener('input', () => {
      this.roomCodeInput.value = this.roomCodeInput.value.toUpperCase();
    });
    this.roomCodeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        this.joinButton.click();
      }
    });
    this.resetButton.addEventListener('click', () => actions.resetVehicle());
    this.teleportButton.addEventListener('click', () => actions.teleportNearTrailer());
    this.teleportOntoButton.addEventListener('click', () =>
      actions.teleportOntoTrailer(),
    );
    this.flipButton.addEventListener('click', () => actions.flipVehicle());
    this.underbodyButton.addEventListener('click', () => actions.testUnderbody());
    this.playerCollisionButton.addEventListener('click', () =>
      actions.testPlayerCollision(),
    );
    this.forceResyncButton.addEventListener('click', () => actions.forceResync());
    const updateNetworkSimulation = (): void => {
      actions.setNetworkSimulation(
        Number(this.latencySelect.value),
        Number(this.jitterSelect.value),
      );
    };
    this.latencySelect.addEventListener('change', updateNetworkSimulation);
    this.jitterSelect.addEventListener('change', updateNetworkSimulation);
    this.predictionToggle.addEventListener('click', () => {
      this.predictionEnabled = !this.predictionEnabled;
      actions.setLocalPredictionEnabled(this.predictionEnabled);
      this.updatePredictionToggle();
    });
    this.updatePredictionToggle();
    if (!shouldShowDebugControls(import.meta.env.DEV)) {
      this.root.hidden = true;
      this.teleportButton.hidden = true;
      this.teleportOntoButton.hidden = true;
      this.flipButton.hidden = true;
      this.underbodyButton.hidden = true;
      this.playerCollisionButton.hidden = true;
      this.forceResyncButton.hidden = true;
      this.networkSimulationControls.hidden = true;
      this.predictionToggle.hidden = true;
    }
  }

  public setConnection(state: ConnectionState): void {
    this.connectionElement.textContent = state;
    this.connectionElement.dataset['state'] = state.toLowerCase();
    const connected = state === 'CONNECTED';
    this.createButton.disabled = !connected;
    this.joinButton.disabled = !connected;

    if (state === 'CONNECTING') {
      this.setMessage('Connecting to server…');
    } else if (state === 'DISCONNECTED') {
      this.setMessage('Disconnected. Restart the server or reload the page.', true);
      this.setPlayerId(null);
      this.setRoomId(null);
      this.setPing(null);
      this.resetButton.disabled = true;
      this.teleportButton.disabled = true;
      this.teleportOntoButton.disabled = true;
      this.flipButton.disabled = true;
      this.underbodyButton.disabled = true;
      this.playerCollisionButton.disabled = true;
      this.forceResyncButton.disabled = true;
    } else if (state === 'CONNECTED') {
      this.setMessage('Connected. Create or join a room.');
    } else {
      this.setMessage(
        state === 'RECONNECTING'
          ? 'Reconnecting; your room slot is reserved.'
          : 'Connection failed. Return to lobby.',
        state === 'FAILED',
      );
      this.resetButton.disabled =
        this.teleportButton.disabled =
        this.teleportOntoButton.disabled =
        this.flipButton.disabled =
        this.underbodyButton.disabled =
        this.playerCollisionButton.disabled =
        this.forceResyncButton.disabled =
          true;
    }
  }

  public setPlayerId(playerId: string | null): void {
    this.playerIdElement.textContent = playerId ?? '—';
    this.playerIdElement.title = playerId ?? '';
    this.resetButton.disabled = playerId === null;
    this.teleportButton.disabled = playerId === null || !import.meta.env.DEV;
    this.teleportOntoButton.disabled = playerId === null || !import.meta.env.DEV;
    this.flipButton.disabled = playerId === null || !import.meta.env.DEV;
    this.underbodyButton.disabled = playerId === null || !import.meta.env.DEV;
    this.playerCollisionButton.disabled = playerId === null || !import.meta.env.DEV;
    this.forceResyncButton.disabled = playerId === null || !import.meta.env.DEV;
  }

  public setRoomId(roomId: string | null): void {
    this.roomIdElement.textContent = roomId ?? '—';
  }

  public setGameplayControlsEnabled(enabled: boolean): void {
    this.resetButton.disabled = !enabled;
  }

  public setPing(pingMs: number | null): void {
    this.pingElement.textContent = pingMs === null ? '—' : `${pingMs} ms`;
  }

  public setServerTick(tick: number): void {
    this.serverTickElement.textContent = tick.toLocaleString('en-US');
  }

  public setInputSequence(sequence: number): void {
    this.inputSequenceElement.textContent = sequence.toLocaleString('en-US');
  }

  public setSnapshotRate(rate: number): void {
    this.snapshotRateElement.textContent = `${rate.toFixed(1)} Hz`;
  }

  public clearSnapshotRate(): void {
    this.snapshotRateElement.textContent = '—';
  }

  public clearRoomTelemetry(): void {
    this.clearSnapshotRate();
    this.setInputSequence(0);
    this.vehicleSpeedElement.textContent = '0 km/h';
    for (const element of [
      this.vehiclePositionElement,
      this.vehicleDebugElement,
      this.convoyDebugElement,
      this.surfaceDebugElement,
      this.trailerDebugElement,
      this.recoveryDebugElement,
    ])
      element.textContent = '—';
  }

  public setVehicleTelemetry(
    speedMetersPerSecond: number,
    position: readonly [number, number, number],
    forwardSpeed: number,
    lateralSpeed: number,
    grounded: boolean,
    throttle: number,
    steering: number,
    surfaceType: string,
    onTrailer: boolean,
    relativeForwardSpeed: number,
    relativeLateralSpeed: number,
    wheelContacts: number,
    trailerRelativePosition: readonly [number, number, number],
    flipped: boolean,
    selfRightAvailable: boolean,
  ): void {
    this.vehicleSpeedElement.textContent = `${Math.abs(speedMetersPerSecond * 3.6).toFixed(0)} km/h`;
    this.vehiclePositionElement.textContent = position
      .map((component) => component.toFixed(1))
      .join('  ');
    this.vehicleDebugElement.textContent = `F ${forwardSpeed.toFixed(1)} · L ${lateralSpeed.toFixed(1)} · ${grounded ? 'GROUND' : 'AIR'} · T ${throttle.toFixed(0)} · S ${steering.toFixed(0)}`;
    this.surfaceDebugElement.textContent = `Ground body: ${surfaceType} · Wheels ${wheelContacts}/4`;
    const relativeSpeed = Math.hypot(relativeForwardSpeed, relativeLateralSpeed);
    this.trailerDebugElement.textContent = `${onTrailer ? 'ON DECK' : 'OFF DECK'} · ${relativeSpeed.toFixed(2)} m/s · ${trailerRelativePosition.map((value) => value.toFixed(1)).join(' ')}`;
    this.recoveryDebugElement.textContent = `Flipped ${flipped ? 'YES' : 'NO'} · Self-right ${selfRightAvailable ? 'YES' : 'NO'} · R`;
  }

  public setConvoyTelemetry(speed: number, pathProgress: number): void {
    this.convoyDebugElement.textContent = `${(speed * 3.6).toFixed(1)} km/h · ${(pathProgress * 100).toFixed(1)}%`;
  }

  public setPredictionTelemetry(
    prediction: PredictionMetrics,
    network: WorldNetworkMetrics,
  ): void {
    this.predictionStatusElement.textContent = prediction.active ? 'ON' : 'OFF';
    this.pendingInputsElement.textContent = String(prediction.pendingInputs);
    this.inputAckElement.textContent = `${prediction.lastSentInput} / ${prediction.lastAcknowledgedInput}`;
    this.predictionErrorElement.textContent = `${prediction.positionError.toFixed(3)} m · ${prediction.velocityError.toFixed(3)} m/s · ${prediction.rotationErrorDegrees.toFixed(1)}°`;
    this.predictionAverageErrorElement.textContent = `${prediction.averagePositionError.toFixed(3)} m · max ${prediction.maximumPositionError.toFixed(3)} m · vel ${prediction.averageVelocityError.toFixed(3)} m/s`;
    this.visualCorrectionOffsetElement.textContent = `${prediction.visualCorrectionOffset.toFixed(3)} m`;
    this.predictionLeadOffsetElement.textContent = `${prediction.predictionLeadOffset.toFixed(3)} m · ${prediction.predictionTicksAhead} ticks`;
    this.reconciliationStatsElement.textContent = `${prediction.reconciliationsPerSecond.toFixed(1)}/s`;
    this.predictionReplaysElement.textContent = `${prediction.replaysPerSecond.toFixed(1)} ticks/s`;
    this.correctionStatsElement.textContent = `${prediction.correctionsPerSecond.toFixed(1)}/s · ${prediction.hardSnaps} snaps`;
    this.predictionTickElement.textContent =
      prediction.predictionTick.toLocaleString('en-US');
    this.predictionWriterElement.textContent = `${prediction.renderWriter} · ${prediction.renderWritesThisFrame} writes · ${prediction.renderWriterConflicts} conflicts`;
    this.predictionStateElement.textContent = `P ${formatVector(prediction.predictedPosition)} · A ${formatVector(prediction.authoritativePosition)}`;
    this.predictionVelocityElement.textContent = `P ${formatVector(prediction.predictedVelocity)} · A ${formatVector(prediction.authoritativeVelocity)}`;
    this.snapshotBufferElement.textContent = `${network.remoteSnapshotBufferSize} · ${network.interpolationDelayMs.toFixed(0)} ms`;
    this.networkJitterElement.textContent = `${network.jitterMs.toFixed(1)} ms`;
  }

  public setRenderStats(fps: number, drawCalls: number, triangles: number): void {
    this.renderStatsElement.textContent = `${fps.toFixed(0)} FPS · ${drawCalls} calls · ${triangles.toLocaleString('en-US')} tris`;
  }

  public setMessage(message: string, isError = false): void {
    this.messageElement.textContent = message;
    this.messageElement.dataset['error'] = String(isError);
  }

  private updatePredictionToggle(): void {
    this.predictionToggle.textContent = `LOCAL PREDICTION: ${this.predictionEnabled ? 'ON' : 'OFF'}`;
    this.predictionToggle.dataset['enabled'] = String(this.predictionEnabled);
  }
}

export function shouldShowDebugControls(isDevelopment: boolean): boolean {
  return isDevelopment;
}

function formatVector(vector: readonly [number, number, number]): string {
  return vector.map((value) => value.toFixed(2)).join(' ');
}

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Required element #${id} is missing.`);
  }
  return element;
}

function getInput(id: string): HTMLInputElement {
  const element = getElement(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`#${id} must be an input element.`);
  }
  return element;
}

function getButton(id: string): HTMLButtonElement {
  const element = getElement(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`#${id} must be a button element.`);
  }
  return element;
}

function getSelect(id: string): HTMLSelectElement {
  const element = getElement(id);
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`#${id} must be a select element.`);
  }
  return element;
}
