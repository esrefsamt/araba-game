import { SIMULATION_TICK_RATE } from '@trailer-arena/shared';
import type { GamePlayerStateSnapshot, GameStateSnapshot } from '@trailer-arena/shared';

export interface GameHudActions {
  setReady(ready: boolean): void;
  startMatch(): void;
  nextRound(): void;
}

export class GameHud {
  private readonly root = getElement('game-hud');
  private readonly timer = getElement('game-timer');
  private readonly trailerTime = getElement('game-trailer-time');
  private readonly leaderboard = getElement('game-leaderboard');
  private readonly lobby = getElement('lobby-panel');
  private readonly lobbyRoomCode = getElement('lobby-room-code');
  private readonly lobbyPlayers = getElement('lobby-players');
  private readonly readyButton = getButton('ready-toggle');
  private readonly startButton = getButton('start-match');
  private readonly countdown = getElement('countdown-overlay');
  private readonly waiting = getElement('waiting-message');
  private readonly results = getElement('results-panel');
  private readonly resultsTitle = getElement('results-title');
  private readonly resultsRows = getElement('results-rows');
  private readonly nextRoundButton = getButton('next-round');
  private state: GameStateSnapshot | null = null;
  private localPlayerId: string | null = null;
  private roomId: string | null = null;
  private snapshotTick = 0;
  private snapshotReceivedAt = performance.now();

  public constructor(private readonly actions: GameHudActions) {
    this.readyButton.addEventListener('click', () => {
      const local = this.getLocalPlayer();
      if (local !== null) this.actions.setReady(!local.ready);
    });
    this.startButton.addEventListener('click', () => this.actions.startMatch());
    this.nextRoundButton.addEventListener('click', () => this.actions.nextRound());
    this.render();
  }

  public setLocalContext(playerId: string | null, roomId: string | null): void {
    this.localPlayerId = playerId;
    this.roomId = roomId;
    this.render();
  }

  public applySnapshot(state: GameStateSnapshot, serverTick: number): void {
    this.state = state;
    this.snapshotTick = serverTick;
    this.snapshotReceivedAt = performance.now();
    this.render();
  }

  public update(): void {
    if (this.state === null) return;
    const estimatedTick =
      this.snapshotTick +
      ((performance.now() - this.snapshotReceivedAt) / 1_000) * SIMULATION_TICK_RATE;
    if (this.state.phase === 'COUNTDOWN' && this.state.stateEndTick !== null) {
      const remaining = Math.max(0, this.state.stateEndTick - estimatedTick);
      this.countdown.textContent = String(Math.max(1, Math.ceil(remaining / 60)));
    } else if (
      this.state.phase === 'PLAYING' &&
      estimatedTick - this.state.stateStartTick < SIMULATION_TICK_RATE * 0.75
    ) {
      this.countdown.textContent = 'GO!';
      this.countdown.hidden = false;
    } else {
      this.countdown.hidden = true;
    }
    if (this.state.phase === 'PLAYING' && this.state.stateEndTick !== null) {
      this.timer.textContent = formatClock(
        Math.max(0, this.state.stateEndTick - estimatedTick),
      );
    }
  }

  private render(): void {
    const state = this.state;
    const local = this.getLocalPlayer();
    this.root.hidden = state === null;
    if (state === null) return;

    const inLobby = state.phase === 'LOBBY';
    const playing = state.phase === 'PLAYING';
    const showingResults = state.phase === 'RESULTS';
    this.lobby.hidden = !inLobby;
    this.results.hidden = !showingResults;
    this.timer.parentElement!.hidden = !playing;
    this.trailerTime.parentElement!.hidden = !playing;
    this.leaderboard.parentElement!.hidden = !playing;
    this.countdown.hidden = state.phase !== 'COUNTDOWN';
    this.waiting.hidden = local?.participant !== false || inLobby;

    this.lobbyRoomCode.textContent = this.roomId ?? '—';
    this.lobbyPlayers.replaceChildren(
      ...state.players.map((player) => createLobbyPlayerRow(player, state.hostPlayerId)),
    );
    this.readyButton.textContent = local?.ready ? 'NOT READY' : 'READY';
    this.readyButton.disabled = local === null;
    const isHost = this.localPlayerId === state.hostPlayerId;
    this.startButton.hidden = !isHost;
    this.startButton.disabled = !canStart(state.players);

    if (playing) {
      this.trailerTime.textContent = `${ticksToSeconds(local?.trailerTicks ?? 0)}s`;
      this.trailerTime.dataset['active'] = String(local?.isScoringOnTrailer ?? false);
      this.leaderboard.replaceChildren(
        ...state.players
          .filter((player) => player.participant)
          .map((player, index) => createLeaderboardRow(player, index + 1)),
      );
    }

    if (showingResults) {
      this.resultsTitle.textContent = `ROUND ${state.roundNumber} RESULTS`;
      this.resultsRows.replaceChildren(
        ...state.results.map((result) => {
          const row = document.createElement('div');
          row.className = 'results-row';
          row.innerHTML = `<span>${result.rank}</span><strong></strong><span>${ticksToSeconds(result.trailerTicks)}s</span><span>+${result.roundPoints}</span><span>${result.sessionPoints}</span>`;
          row.querySelector('strong')!.textContent = result.playerName;
          return row;
        }),
      );
      this.nextRoundButton.hidden = !isHost;
    }
  }

  private getLocalPlayer(): GamePlayerStateSnapshot | null {
    return (
      this.state?.players.find((player) => player.playerId === this.localPlayerId) ?? null
    );
  }
}

function createLobbyPlayerRow(
  player: GamePlayerStateSnapshot,
  hostPlayerId: string | null,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'lobby-player-row';
  const name = document.createElement('span');
  name.textContent = `${player.playerName}${player.playerId === hostPlayerId ? ' · HOST' : ''}`;
  const ready = document.createElement('strong');
  ready.textContent = player.ready ? 'READY' : 'NOT READY';
  ready.dataset['ready'] = String(player.ready);
  row.append(name, ready);
  return row;
}

function createLeaderboardRow(
  player: GamePlayerStateSnapshot,
  rank: number,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'leaderboard-row';
  row.innerHTML = `<span>${rank}.</span><strong></strong><span>${ticksToSeconds(player.trailerTicks)}s</span>`;
  row.querySelector('strong')!.textContent = player.playerName;
  return row;
}

function canStart(players: readonly GamePlayerStateSnapshot[]): boolean {
  return (
    players.length === 1 ||
    (players.length > 1 && players.every((player) => player.ready))
  );
}

function ticksToSeconds(ticks: number): string {
  return (ticks / SIMULATION_TICK_RATE).toFixed(1);
}

function formatClock(ticks: number): string {
  const seconds = Math.ceil(ticks / SIMULATION_TICK_RATE);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Required element #${id} is missing.`);
  return element;
}

function getButton(id: string): HTMLButtonElement {
  const element = getElement(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`#${id} must be a button element.`);
  }
  return element;
}
