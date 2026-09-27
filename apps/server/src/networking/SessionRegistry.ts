import { randomBytes } from 'node:crypto';

import { SESSION_GRACE_MS } from '@trailer-arena/shared';
import type { ServerPlayer } from '../players/ServerPlayer.js';

export interface PlayerSession {
  readonly token: string;
  activeConnectionId: string | null;
  expiresAt: number | null;
  player: ServerPlayer | null;
  roomId: string | null;
}

/** One central registry; no timers or credentials on the public player object. */
export class SessionRegistry {
  private readonly sessions = new Map<string, PlayerSession>();

  public constructor(private readonly graceMs = SESSION_GRACE_MS) {}

  public get size(): number {
    return this.sessions.size;
  }

  public create(connectionId: string): PlayerSession {
    let token: string;
    do {
      token = randomBytes(32).toString('hex');
    } while (this.sessions.has(token));
    const session: PlayerSession = {
      token,
      activeConnectionId: connectionId,
      expiresAt: null,
      player: null,
      roomId: null,
    };
    this.sessions.set(token, session);
    return session;
  }

  public get(token: string): PlayerSession | undefined {
    return this.sessions.get(token);
  }

  public disconnect(session: PlayerSession, connectionId: string, now: number): void {
    if (session.activeConnectionId !== connectionId) return;
    session.activeConnectionId = null;
    session.expiresAt = now + this.graceMs;
  }

  public claim(session: PlayerSession, connectionId: string, now: number): boolean {
    if (
      session.activeConnectionId !== null ||
      session.expiresAt === null ||
      now >= session.expiresAt ||
      !this.sessions.has(session.token)
    )
      return false;
    session.activeConnectionId = connectionId;
    session.expiresAt = null;
    return true;
  }

  public expire(now: number): PlayerSession[] {
    const expired: PlayerSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.expiresAt !== null && now >= session.expiresAt) {
        this.sessions.delete(session.token);
        expired.push(session);
      }
    }
    return expired;
  }

  public remove(session: PlayerSession): void {
    this.sessions.delete(session.token);
  }
  public clear(): void {
    this.sessions.clear();
  }
}
