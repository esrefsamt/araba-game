import { RECONNECT_DELAYS_MS } from '@trailer-arena/shared';

export function reconnectDelay(attempt: number): number {
  const index = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return RECONNECT_DELAYS_MS[Math.min(index, RECONNECT_DELAYS_MS.length - 1)]!;
}

export function resolveWebSocketUrl(
  configured: string | undefined,
  location: Pick<Location, 'href' | 'protocol'>,
  development: boolean,
): string {
  const url = configured?.trim() ? new URL(configured.trim()) : new URL(location.href);
  if (!configured?.trim()) {
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (development) url.port = '3000';
    url.pathname = '/';
    url.search = '';
    url.hash = '';
  }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error(
      'VITE_WS_URL must be a ws:// or wss:// URL without embedded credentials.',
    );
  if (location.protocol === 'https:' && url.protocol !== 'wss:')
    throw new Error('HTTPS deployments require a wss:// websocket URL.');
  return url.href;
}
