import type { GamePlayerStateSnapshot, GameStateSnapshot } from '@trailer-arena/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GameHud } from '../src/ui/GameHud.js';
import { SessionPanel } from '../src/ui/SessionPanel.js';

// Small DOM adapter: exercise the actual HUD transitions without a WebGL browser.
class Element extends EventTarget {
  public textContent = '';
  public hidden = false;
  public disabled = false;
  public value = '';
  public className = '';
  public innerHTML = '';
  public dataset: Record<string, string> = {};
  public children: Element[] = [];
  public parentElement = { hidden: false };
  public classList = { add: vi.fn() };
  private selectors = new Map<string, Element>();
  public click(): void {
    if (!this.disabled) this.dispatchEvent(new Event('click'));
  }
  public append(...children: Element[]): void {
    this.children.push(...children);
  }
  public replaceChildren(...children: Element[]): void {
    this.children = children;
  }
  public setAttribute(): void {}
  public querySelector(selector: string): Element {
    let result = this.selectors.get(selector);
    if (result === undefined) {
      result = new Element();
      this.selectors.set(selector, result);
    }
    return result;
  }
}
const elements = new Map<string, Element>();
function element(id: string): Element {
  let result = elements.get(id);
  if (result === undefined) {
    result = new Element();
    elements.set(id, result);
  }
  return result;
}
beforeEach(() => {
  elements.clear();
  vi.stubGlobal('HTMLButtonElement', Element);
  vi.stubGlobal('document', {
    getElementById: element,
    createElement: () => new Element(),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function player(id = 'local'): GamePlayerStateSnapshot {
  return {
    playerId: id,
    playerName: id,
    ready: true,
    participant: true,
    trailerTicks: 120,
    currentStreakTicks: 0,
    bestStreakTicks: 120,
    isScoringOnTrailer: false,
    roundPoints: 10,
    sessionPoints: 10,
    connectionState: 'CONNECTED',
  };
}
function state(phase: GameStateSnapshot['phase']): GameStateSnapshot {
  return {
    phase,
    roundNumber: 2,
    hostPlayerId: 'local',
    stateStartTick: 100,
    stateEndTick: phase === 'COUNTDOWN' ? 280 : 5500,
    players: [player()],
    results:
      phase === 'RESULTS'
        ? [
            {
              playerId: 'local',
              playerName: 'local',
              rank: 1,
              trailerTicks: 120,
              bestStreakTicks: 120,
              roundPoints: 10,
              sessionPoints: 20,
            },
          ]
        : [],
  };
}
function hud() {
  const audio = vi.fn();
  const instance = new GameHud({
    setReady: vi.fn(),
    startMatch: vi.fn(),
    nextRound: vi.fn(),
    playAudioCue: audio,
    toggleSound: () => true,
  });
  instance.setLocalContext('local', 'ABC123');
  return { instance, audio };
}

describe('authoritative HUD restore', () => {
  it('restores results and points without replaying the round-end audio cue', () => {
    const { instance, audio } = hud();
    instance.applyFullSnapshot(state('RESULTS'), 5500);
    expect(element('results-panel').hidden).toBe(false);
    expect(element('results-title').textContent).toBe('ROUND 2 RESULTS');
    expect(element('results-rows').children).toHaveLength(1);
    expect(element('results-rows').children[0]!.innerHTML).toContain('<span>20</span>');
    expect(audio).not.toHaveBeenCalled();
    instance.applySnapshot(state('LOBBY'), 5501);
    instance.applySnapshot(state('RESULTS'), 5502);
    expect(audio).toHaveBeenCalledExactlyOnceWith('round_end');
  });

  it.each(['COUNTDOWN', 'PLAYING'] as const)(
    'restores %s without replaying its current cue',
    (phase) => {
      const { instance, audio } = hud();
      instance.applyFullSnapshot(state(phase), 100);
      instance.update();
      expect(audio).not.toHaveBeenCalled();
    },
  );

  it('keeps restored readiness and disables match controls while disconnected', () => {
    const { instance } = hud();
    instance.applyFullSnapshot(state('LOBBY'), 100);
    expect(element('ready-toggle').textContent).toBe('NOT READY');
    expect(element('lobby-room-code').textContent).toBe('ABC123');
    instance.setConnection(false);
    expect(element('ready-toggle').disabled).toBe(true);
    expect(element('start-match').disabled).toBe(true);
    instance.setConnection(true);
    expect(element('start-match').disabled).toBe(false);
    instance.clear();
    expect(element('game-hud').hidden).toBe(true);
  });

  it('shows a grace player and lets the connected host start without an offline readiness lock', () => {
    const { instance } = hud();
    const snapshot = state('LOBBY');
    snapshot.players.push({
      ...player('offline'),
      ready: false,
      connectionState: 'DISCONNECTED_GRACE',
    });
    instance.applyFullSnapshot(snapshot, 100);
    expect(element('lobby-players').children).toHaveLength(2);
    expect(element('lobby-players').children[1]!.children[1]!.textContent).toBe(
      'RECONNECTING',
    );
    expect(element('start-match').disabled).toBe(false);
  });
});

describe('connection card', () => {
  it('keeps room UI until acknowledged leave, preserves the name and enables same-tab room navigation afterwards', () => {
    const leave = vi.fn();
    const join = vi.fn();
    const create = vi.fn();
    const panel = new SessionPanel({
      leaveRoom: leave,
      joinRoom: join,
      createRoom: create,
      connectFresh: vi.fn(),
    });
    panel.setConnection('CONNECTED');
    panel.setRoom('ABC123');
    element('session-name').value = 'Retained name';
    element('session-room-code').value = 'OLD123';
    panel.setMessage('Old error');
    element('leave-room').click();
    expect(leave).toHaveBeenCalledOnce();
    panel.setRoomAction('LEAVING');
    expect(element('room-tools').hidden).toBe(false);
    expect(element('session-entry').hidden).toBe(true);
    expect(element('leave-room').disabled).toBe(true);
    expect(element('leave-room').textContent).toBe('LEAVING…');
    panel.setRoomAction('NONE');
    panel.setRoom(null);
    expect(element('session-entry').hidden).toBe(false);
    expect(element('room-tools').hidden).toBe(true);
    expect(element('session-name').value).toBe('Retained name');
    expect(element('session-room-code').value).toBe('');
    expect(element('session-message').textContent).toBe('');
    element('session-room-code').value = 'DEF456';
    element('session-join').click();
    expect(join).toHaveBeenCalledWith('Retained name', 'DEF456');
    element('session-create').click();
    expect(create).toHaveBeenCalledWith('Retained name');
  });

  it('clears all prior room HUD rows and timers while retaining sound preference', () => {
    const { instance } = hud();
    instance.applyFullSnapshot(state('PLAYING'), 100);
    expect(element('game-leaderboard').children).toHaveLength(1);
    instance.applyFullSnapshot(state('RESULTS'), 5500);
    expect(element('results-rows').children).toHaveLength(1);
    element('sound-toggle').textContent = 'SOUND: OFF';
    instance.clear();
    expect(element('game-leaderboard').children).toHaveLength(0);
    expect(element('results-rows').children).toHaveLength(0);
    expect(element('lobby-players').children).toHaveLength(0);
    expect(element('game-timer').textContent).toBe('—');
    expect(element('lobby-room-code').textContent).toBe('—');
    expect(element('sound-toggle').textContent).toBe('SOUND: OFF');
  });

  it('offers lobby recovery on failure and uses friendly clipboard fallback on insecure contexts', () => {
    vi.stubGlobal('navigator', {});
    const fresh = vi.fn();
    const panel = new SessionPanel({
      createRoom: vi.fn(),
      joinRoom: vi.fn(),
      leaveRoom: vi.fn(),
      connectFresh: fresh,
    });
    panel.setRoom('ABC123');
    panel.setConnection('RECONNECTING');
    expect(element('connection-overlay').hidden).toBe(false);
    expect(element('connection-overlay-title').textContent).toBe('RECONNECTING…');
    expect(element('session-connect').hidden).toBe(true);
    panel.setConnection('CONNECTED');
    expect(element('connection-overlay').hidden).toBe(true);
    expect(() => element('copy-room-code').click()).not.toThrow();
    expect(element('session-message').textContent).toContain('Clipboard unavailable');
    panel.setConnection('FAILED');
    element('session-connect').click();
    expect(fresh).toHaveBeenCalledOnce();
  });
});
