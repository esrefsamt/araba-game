import type { ServerErrorCode } from '@trailer-arena/shared';
import type { ConnectionState, RoomAction } from '../networking/NetworkClient.js';

const ERRORS: Record<ServerErrorCode, string> = {
  INVALID_MESSAGE: 'The request was not accepted. Please try again.',
  INVALID_PLAYER_NAME: 'NAME INVALID · Use 1–16 visible characters.',
  INVALID_ROOM: 'ROOM CODE INVALID · Enter the six-character code.',
  ROOM_NOT_FOUND: 'ROOM NOT FOUND · Check the code or create a room.',
  ROOM_FULL: 'ROOM FULL · All eight slots are occupied, including reconnecting players.',
  ALREADY_IN_ROOM: 'You are already in a room. Leave it before joining another.',
  UNAUTHORIZED_ACTION: 'Only the current host can do that.',
  INVALID_GAME_STATE:
    'That action is unavailable now. Check the phase and player readiness.',
  INTERNAL_ERROR: 'The server could not complete the request. Please try again.',
  SESSION_EXPIRED: 'SESSION EXPIRED / SERVER RESTARTED · Connect again to join a room.',
  SESSION_ACTIVE:
    'SESSION ALREADY CONNECTED · Use the original tab or wait for its connection to close.',
  RATE_LIMITED: 'Too many room requests. Wait a moment before trying again.',
};
export function friendlyServerError(code: ServerErrorCode): string {
  return ERRORS[code];
}

export interface SessionPanelActions {
  createRoom(name: string): void;
  joinRoom(name: string, code: string): void;
  leaveRoom(): void;
  connectFresh(): void;
}

export class SessionPanel {
  private readonly entry = element('session-entry');
  private readonly overlay = element('connection-overlay');
  private readonly overlayTitle = element('connection-overlay-title');
  private readonly overlayDetail = element('connection-overlay-detail');
  private readonly status = element('session-status');
  private readonly message = element('session-message');
  private readonly roomTools = element('room-tools');
  private readonly roomCode = element('room-tools-code');
  private readonly feedback = element('reconnected-feedback');
  private readonly name = element('session-name') as HTMLInputElement;
  private readonly code = element('session-room-code') as HTMLInputElement;
  private readonly create = element('session-create') as HTMLButtonElement;
  private readonly join = element('session-join') as HTMLButtonElement;
  private readonly fresh = element('session-connect') as HTMLButtonElement;
  private readonly copy = element('copy-room-code') as HTMLButtonElement;
  private readonly leave = element('leave-room') as HTMLButtonElement;
  private roomAction: RoomAction = 'NONE';
  private roomId: string | null = null;
  private state: ConnectionState = 'DISCONNECTED';
  private feedbackUntil = 0;

  public constructor(actions: SessionPanelActions) {
    this.create.addEventListener('click', () => {
      this.setMessage('');
      actions.createRoom(this.name.value);
    });
    this.join.addEventListener('click', () => {
      this.setMessage('');
      actions.joinRoom(this.name.value, this.code.value);
    });
    this.code.addEventListener('input', () => {
      this.code.value = this.code.value.toUpperCase();
    });
    this.code.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.join.click();
    });
    this.leave.addEventListener('click', () => actions.leaveRoom());
    this.fresh.addEventListener('click', () => {
      this.setMessage('');
      actions.connectFresh();
    });
    this.copy.addEventListener('click', () => {
      if (this.roomId === null) return;
      if (navigator.clipboard === undefined) {
        this.setMessage(
          'Clipboard unavailable. Select and copy the displayed room code.',
        );
        return;
      }
      void navigator.clipboard
        .writeText(this.roomId)
        .then(() => {
          this.feedback.textContent = 'ROOM CODE COPIED';
          this.feedbackUntil = performance.now() + 2_000;
          this.feedback.hidden = false;
        })
        .catch(() =>
          this.setMessage(
            'Clipboard unavailable. Select and copy the displayed room code.',
          ),
        );
    });
    this.render();
  }

  public setRoom(roomId: string | null): void {
    this.roomId = roomId;
    this.setMessage('');
    if (roomId === null) {
      this.code.value = '';
      this.feedback.hidden = true;
      this.feedbackUntil = 0;
    }
    this.render();
  }
  public setRoomAction(action: RoomAction): void {
    this.roomAction = action;
    this.render();
  }
  public setConnection(state: ConnectionState): void {
    this.state = state;
    this.render();
  }
  public setMessage(message: string): void {
    this.message.textContent = message;
    this.overlayDetail.textContent =
      message ||
      'Trying to restore your session. Reconnect attempts stop when its grace window expires.';
    if (message !== '' && this.roomId !== null && this.state === 'CONNECTED') {
      this.feedback.textContent = message;
      this.feedbackUntil = performance.now() + 4_000;
      this.feedback.hidden = false;
    }
  }
  public setError(code: ServerErrorCode): void {
    this.setMessage(friendlyServerError(code));
  }
  public showReconnected(): void {
    this.setMessage('');
    this.feedback.textContent = 'RECONNECTED';
    this.feedbackUntil = performance.now() + 2_500;
    this.feedback.hidden = false;
  }
  public update(): void {
    if (performance.now() >= this.feedbackUntil) this.feedback.hidden = true;
  }

  private render(): void {
    this.entry.hidden = this.roomId !== null;
    this.roomTools.hidden = this.roomId === null;
    this.roomCode.textContent = this.roomId ?? '—';
    this.status.textContent = this.state;
    this.status.dataset['state'] = this.state;
    this.create.disabled = this.join.disabled =
      this.state !== 'CONNECTED' || this.roomAction !== 'NONE';
    this.leave.disabled =
      this.roomId === null || this.state !== 'CONNECTED' || this.roomAction !== 'NONE';
    this.leave.textContent = this.roomAction === 'LEAVING' ? 'LEAVING…' : 'LEAVE ROOM';
    this.overlay.hidden = this.state === 'CONNECTED';
    this.overlayTitle.textContent =
      this.state === 'RECONNECTING'
        ? 'RECONNECTING…'
        : this.state === 'CONNECTING'
          ? 'CONNECTING…'
          : 'CONNECTION LOST';
    this.fresh.hidden = this.state !== 'FAILED' && this.state !== 'DISCONNECTED';
  }
}

function element(id: string): HTMLElement {
  const result = document.getElementById(id);
  if (result === null) throw new Error(`Missing session UI element #${id}.`);
  return result;
}
