import { SIMULATION_TICK_RATE } from '@trailer-arena/shared';
import type { GamePlayerStateSnapshot, GameStateSnapshot } from '@trailer-arena/shared';

import type { ArcadeAudioCue } from '../audio/AudioManager.js';
import { playerColorCss } from '../visuals/PlayerPalette.js';

export interface GameHudActions {
  setReady(ready: boolean): void;
  startMatch(): void;
  nextRound(): void;
  playAudioCue(cue: ArcadeAudioCue): void;
  toggleSound(): boolean;
}

export interface HudVisibilityState {
  readonly lobby: boolean;
  readonly playing: boolean;
  readonly results: boolean;
  readonly countdown: boolean;
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
  private readonly soundButton = getButton('sound-toggle');
  private state: GameStateSnapshot | null = null;
  private localPlayerId: string | null = null;
  private roomId: string | null = null;
  private snapshotTick = 0;
  private snapshotReceivedAt = performance.now();
  private lastCueKey = '';
  private connected = true;

  public constructor(private readonly actions: GameHudActions) {
    this.readyButton.addEventListener('click', () => {
      this.actions.playAudioCue('ui_click');
      const local = this.getLocalPlayer();
      if (local !== null) this.actions.setReady(!local.ready);
    });
    this.startButton.addEventListener('click', () => {
      this.actions.playAudioCue('ui_click');
      this.actions.startMatch();
    });
    this.nextRoundButton.addEventListener('click', () => {
      this.actions.playAudioCue('ui_click');
      this.actions.nextRound();
    });
    this.soundButton.addEventListener('click', () => {
      const enabled = this.actions.toggleSound();
      this.soundButton.textContent = enabled ? 'SOUND: ON' : 'SOUND: OFF';
    });
    this.render();
  }

  public setLocalContext(playerId: string | null, roomId: string | null): void {
    this.localPlayerId = playerId;
    this.roomId = roomId;
    this.render();
  }

  public applySnapshot(state: GameStateSnapshot, serverTick: number): void {
    if (this.state?.phase !== 'RESULTS' && state.phase === 'RESULTS') {
      this.actions.playAudioCue('round_end');
    }
    this.state = state;
    this.snapshotTick = serverTick;
    this.snapshotReceivedAt = performance.now();
    this.render();
  }

  public applyFullSnapshot(state: GameStateSnapshot, serverTick: number): void {
    // A restored RESULTS screen is persistent state, not a new round-end event.
    this.state = state;
    this.lastCueKey =
      state.phase === 'PLAYING'
        ? `go-${state.roundNumber}`
        : state.phase === 'COUNTDOWN'
          ? `countdown-${Math.max(1, Math.ceil(((state.stateEndTick ?? serverTick) - serverTick) / 60))}`
          : '';
    this.applySnapshot(state, serverTick);
  }

  public setConnection(connected: boolean): void {
    this.connected = connected;
    this.render();
  }
  public clear(): void {
    this.state = null;
    this.localPlayerId = null;
    this.roomId = null;
    this.lastCueKey = '';
    this.snapshotTick = 0;
    this.snapshotReceivedAt = performance.now();
    this.timer.textContent = '—';
    this.trailerTime.textContent = '0.0s';
    this.trailerTime.dataset['active'] = 'false';
    this.leaderboard.replaceChildren();
    this.lobbyPlayers.replaceChildren();
    this.resultsRows.replaceChildren();
    this.resultsTitle.textContent = 'ROUND RESULTS';
    this.lobbyRoomCode.textContent = '—';
    this.countdown.textContent = '';
    this.render();
  }

  public update(): void {
    if (this.state === null) return;
    const estimatedTick =
      this.snapshotTick +
      ((performance.now() - this.snapshotReceivedAt) / 1_000) * SIMULATION_TICK_RATE;
    if (this.state.phase === 'COUNTDOWN' && this.state.stateEndTick !== null) {
      const remaining = Math.max(0, this.state.stateEndTick - estimatedTick);
      const count = Math.max(1, Math.ceil(remaining / 60));
      this.countdown.textContent = String(count);
      this.playCueOnce(`countdown-${count}`, 'countdown');
    } else if (
      this.state.phase === 'PLAYING' &&
      estimatedTick - this.state.stateStartTick < SIMULATION_TICK_RATE * 0.75
    ) {
      this.countdown.textContent = 'GO!';
      this.countdown.hidden = false;
      this.playCueOnce(`go-${this.state.roundNumber}`, 'go');
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

    const visibility = deriveHudVisibility(state.phase);
    const inLobby = visibility.lobby;
    const playing = visibility.playing;
    const showingResults = visibility.results;
    this.lobby.hidden = !inLobby;
    this.results.hidden = !showingResults;
    this.timer.parentElement!.hidden = !playing;
    this.trailerTime.parentElement!.hidden = !playing;
    this.leaderboard.parentElement!.hidden = !playing;
    this.countdown.hidden = !visibility.countdown;
    this.waiting.hidden = local?.participant !== false || state.phase !== 'COUNTDOWN';

    this.lobbyRoomCode.textContent = this.roomId ?? '—';
    this.lobbyPlayers.replaceChildren(
      ...state.players.map((player) => createLobbyPlayerRow(player, state.hostPlayerId)),
    );
    this.readyButton.textContent = local?.ready ? 'NOT READY' : 'READY';
    this.readyButton.disabled = local === null || !this.connected;
    const isHost = this.localPlayerId === state.hostPlayerId;
    this.startButton.hidden = !isHost;
    this.startButton.disabled = !this.connected || !canStart(state.players);

    if (playing) {
      this.trailerTime.textContent = `${ticksToSeconds(local?.trailerTicks ?? 0)}s`;
      this.trailerTime.dataset['active'] = String(local?.isScoringOnTrailer ?? false);
      this.leaderboard.replaceChildren(
        ...state.players
          .filter((player) => player.participant)
          .slice(0, 8)
          .map((player, index) =>
            createLeaderboardRow(
              player,
              index + 1,
              player.playerId === this.localPlayerId,
            ),
          ),
      );
    }

    if (showingResults) {
      this.resultsTitle.textContent = `ROUND ${state.roundNumber} RESULTS`;
      this.resultsRows.replaceChildren(
        ...state.results.map((result) => {
          const row = document.createElement('div');
          row.className = 'results-row';
          if (result.rank === 1) row.classList.add('results-row--winner');
          if (result.playerId === this.localPlayerId)
            row.classList.add('results-row--local');
          row.innerHTML = `<span>${result.rank}</span><strong><i></i><b></b></strong><span>${ticksToSeconds(result.trailerTicks)}s</span><span>+${result.roundPoints}</span><span>${result.sessionPoints}</span>`;
          const indicator = row.querySelector('i')!;
          indicator.setAttribute(
            'style',
            `--player-color: ${playerColorCss(result.playerId)}`,
          );
          row.querySelector('b')!.textContent = result.playerName;
          return row;
        }),
      );
      this.nextRoundButton.hidden = !isHost;
      this.nextRoundButton.disabled = !this.connected;
    }
  }

  private getLocalPlayer(): GamePlayerStateSnapshot | null {
    return (
      this.state?.players.find((player) => player.playerId === this.localPlayerId) ?? null
    );
  }

  private playCueOnce(key: string, cue: ArcadeAudioCue): void {
    if (key === this.lastCueKey) return;
    this.lastCueKey = key;
    this.actions.playAudioCue(cue);
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
  ready.textContent =
    player.connectionState === 'DISCONNECTED_GRACE'
      ? 'RECONNECTING'
      : player.ready
        ? 'READY'
        : 'NOT READY';
  ready.dataset['ready'] = String(player.ready);
  row.append(name, ready);
  return row;
}

function createLeaderboardRow(
  player: GamePlayerStateSnapshot,
  rank: number,
  isLocal: boolean,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'leaderboard-row';
  if (isLocal) row.classList.add('leaderboard-row--local');
  row.innerHTML = `<span>${rank}.</span><i></i><strong></strong><span>${ticksToSeconds(player.trailerTicks)}s</span>`;
  row
    .querySelector('i')!
    .setAttribute('style', `--player-color: ${playerColorCss(player.playerId)}`);
  row.querySelector('strong')!.textContent =
    `${player.playerName}${player.connectionState === 'DISCONNECTED_GRACE' ? ' · RECONNECTING' : ''}`;
  return row;
}

export function deriveHudVisibility(
  phase: GameStateSnapshot['phase'],
): HudVisibilityState {
  return {
    lobby: phase === 'LOBBY',
    playing: phase === 'PLAYING',
    results: phase === 'RESULTS',
    countdown: phase === 'COUNTDOWN',
  };
}

export function leaderboardPlayerIds(
  players: readonly GamePlayerStateSnapshot[],
): string[] {
  return players
    .filter((player) => player.participant)
    .slice(0, 8)
    .map((player) => player.playerId);
}

function canStart(players: readonly GamePlayerStateSnapshot[]): boolean {
  players = players.filter((player) => player.connectionState !== 'DISCONNECTED_GRACE');
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
