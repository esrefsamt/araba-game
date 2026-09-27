import { resolveWebSocketUrl } from '../networking/ConnectionConfig.js';

export interface ClientConfig {
  readonly webSocketUrl: string;
  readonly developmentTools: boolean;
}

export function loadClientConfig(
  environment: { readonly DEV: boolean; readonly VITE_WS_URL?: string },
  location: Pick<Location, 'href' | 'protocol'>,
): ClientConfig {
  return {
    webSocketUrl: resolveWebSocketUrl(environment.VITE_WS_URL, location, environment.DEV),
    developmentTools: environment.DEV,
  };
}
