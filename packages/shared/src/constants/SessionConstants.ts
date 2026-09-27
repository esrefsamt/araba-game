export const SESSION_GRACE_MS = 15_000;
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TIMEOUT_MS = 15_000;
export const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 3_000, 5_000] as const;

/** 32 cryptographically random bytes, encoded without whitespace or delimiters. */
export function isSessionToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
