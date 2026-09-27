import type { LogLevel } from './ServerConfig.js';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

export function redactLogValue(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return text.replace(/[a-f0-9]{64}/gi, '[session capability redacted]').slice(0, 2000);
}

export function createServerLogger(level: LogLevel = 'info') {
  const write = (method: 'debug' | 'info' | 'warn' | 'error', values: unknown[]) => {
    if (LEVELS[method] >= LEVELS[level]) console[method](...values.map(redactLogValue));
  };
  return {
    debug: (...values: unknown[]) => write('debug', values),
    info: (...values: unknown[]) => write('info', values),
    warn: (...values: unknown[]) => write('warn', values),
    error: (...values: unknown[]) => write('error', values),
  };
}

// Startup validates LOG_LEVEL; the safe default also covers early configuration failures.
export let serverLogger = createServerLogger();
export function configureServerLogger(level: LogLevel): void {
  serverLogger = createServerLogger(level);
}
