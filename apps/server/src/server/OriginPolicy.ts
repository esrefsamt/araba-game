import type { ServerConfig } from './ServerConfig.js';
import { parseOrigin } from './ServerConfig.js';

export function isOriginAllowed(
  origin: string | undefined,
  config: Pick<ServerConfig, 'production' | 'allowedOrigins' | 'allowMissingOrigin'>,
): boolean {
  if (origin === undefined) return config.allowMissingOrigin;
  let normalized: string;
  try {
    normalized = parseOrigin(origin);
  } catch {
    return false;
  }
  if (config.allowedOrigins.includes(normalized)) return true;
  if (config.production) return false;
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(normalized).hostname);
}
