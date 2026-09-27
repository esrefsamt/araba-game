import { isSessionToken } from '@trailer-arena/shared';

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): SessionStorageLike | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Per tab and endpoint. Storage failures fall back to memory, never localStorage. */
export class SessionTokenStore {
  private token: string | null = null;
  private readonly key: string;
  public constructor(
    url: string,
    private readonly storage = browserStorage(),
  ) {
    this.key = `trailer-arena.session:${url}`;
    try {
      const stored = storage?.getItem(this.key);
      if (isSessionToken(stored)) this.token = stored;
      else if (stored != null) storage?.removeItem(this.key);
    } catch {
      /* Memory remains available when sessionStorage is blocked. */
    }
  }
  public read(): string | null {
    return this.token;
  }
  public write(token: string | null): void {
    this.token = isSessionToken(token) ? token : null;
    try {
      if (this.token === null) this.storage?.removeItem(this.key);
      else this.storage?.setItem(this.key, this.token);
    } catch {
      /* Keep the in-memory capability. */
    }
  }
}
