import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  SESSION_GRACE_MS,
} from '@trailer-arena/shared';

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly graceMs: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}

export function loadServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = environment[name];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max)
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
    host: environment['HOST']?.trim() || '0.0.0.0',
    graceMs: integer('SESSION_GRACE_MS', SESSION_GRACE_MS, 1_000, 120_000),
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    shutdownTimeoutMs: integer('SHUTDOWN_TIMEOUT_MS', 5_000, 100, 30_000),
  };
}
