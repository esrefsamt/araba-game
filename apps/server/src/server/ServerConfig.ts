import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  SESSION_GRACE_MS,
} from '@trailer-arena/shared';
import { isIP } from 'node:net';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export const MAX_WEBSOCKET_PAYLOAD_BYTES = 16 * 1_024;

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly graceMs: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly production: boolean;
  readonly allowedOrigins: readonly string[];
  readonly allowMissingOrigin: boolean;
  readonly logLevel: LogLevel;
}

export function loadServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const mode = environment['NODE_ENV'] ?? 'development';
  if (!['development', 'production', 'test'].includes(mode))
    throw new Error('Invalid NODE_ENV configuration.');
  const production = mode === 'production';
  if (production && !environment['PORT']?.trim())
    throw new Error('Production requires PORT configuration.');
  const origins = environment['ALLOWED_ORIGINS'];
  if (production && !origins?.trim())
    throw new Error('Production requires ALLOWED_ORIGINS configuration.');
  const allowedOrigins = origins === undefined ? [] : origins.split(',').map(parseOrigin);
  const host = environment['HOST'] === undefined ? '0.0.0.0' : environment['HOST'].trim();
  if (
    !host ||
    (!isIP(host) &&
      !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))
  )
    throw new Error('Invalid HOST configuration.');
  const rawLevel = environment['LOG_LEVEL'] ?? 'info';
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(rawLevel))
    throw new Error('Invalid LOG_LEVEL configuration.');
  const rawMissing = environment['ALLOW_NO_ORIGIN'];
  if (rawMissing !== undefined && rawMissing !== 'true' && rawMissing !== 'false')
    throw new Error('ALLOW_NO_ORIGIN must be true or false.');
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = environment[name];
    const value = raw === undefined ? fallback : Number(raw);
    if (
      (raw !== undefined && !/^\d+$/.test(raw)) ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    )
      throw new Error(`Invalid ${name} configuration.`);
    return value;
  };
  const heartbeatIntervalMs = integer(
    'HEARTBEAT_INTERVAL_MS',
    HEARTBEAT_INTERVAL_MS,
    1_000,
    60_000,
  );
  const heartbeatTimeoutMs = integer(
    'HEARTBEAT_TIMEOUT_MS',
    HEARTBEAT_TIMEOUT_MS,
    2_000,
    120_000,
  );
  if (heartbeatTimeoutMs <= heartbeatIntervalMs)
    throw new Error('Heartbeat timeout must exceed its interval.');
  return {
    port: integer('PORT', 3_000, 1, 65_535),
    host,
    graceMs: integer('SESSION_GRACE_MS', SESSION_GRACE_MS, 1_000, 120_000),
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    shutdownTimeoutMs: integer('SHUTDOWN_TIMEOUT_MS', 5_000, 100, 30_000),
    production,
    allowedOrigins: [...new Set(allowedOrigins)],
    allowMissingOrigin: rawMissing === undefined ? !production : rawMissing === 'true',
    logLevel: rawLevel as LogLevel,
  };
}

export function parseOrigin(raw: string): string {
  try {
    const url = new URL(raw.trim());
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.hostname.includes('*') ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid origin');
    return url.origin;
  } catch {
    throw new Error(
      'Invalid ALLOWED_ORIGINS configuration. Use comma-separated HTTP(S) origins without paths or wildcards.',
    );
  }
}
