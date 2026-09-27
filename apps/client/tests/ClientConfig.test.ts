import { describe, expect, it } from 'vitest';
import { loadClientConfig } from '../src/config/ClientConfig.js';

describe('deployment client config', () => {
  const http = { href: 'http://localhost:4173/', protocol: 'http:' };
  const https = { href: 'https://client.example/game', protocol: 'https:' };
  it('keeps development defaults without an env file', () => {
    expect(
      loadClientConfig(
        { DEV: true },
        { href: 'http://localhost:5173/', protocol: 'http:' },
      ),
    ).toEqual({ webSocketUrl: 'ws://localhost:3000/', developmentTools: true });
  });
  it('reads production WSS URL including a reverse proxy path and hides development tools', () => {
    expect(
      loadClientConfig({ DEV: false, VITE_WS_URL: 'wss://server.example/socket' }, https),
    ).toEqual({ webSocketUrl: 'wss://server.example/socket', developmentTools: false });
  });
  it('supports local production WS and same-origin WSS without a localhost production dependency', () => {
    expect(
      loadClientConfig({ DEV: false, VITE_WS_URL: 'ws://localhost:8080/' }, http)
        .webSocketUrl,
    ).toBe('ws://localhost:8080/');
    expect(loadClientConfig({ DEV: false }, https).webSocketUrl).toBe(
      'wss://client.example/',
    );
  });
  it.each([
    'not a URL',
    '/socket',
    'https://server.example',
    'wss://user:secret@server.example',
    'wss://server.example/#token',
  ])('reports malformed config clearly: %s', (value) => {
    expect(() => loadClientConfig({ DEV: false, VITE_WS_URL: value }, http)).toThrow(
      'VITE_WS_URL',
    );
  });
  it('rejects mixed-content WS from an HTTPS page', () => {
    expect(() =>
      loadClientConfig({ DEV: false, VITE_WS_URL: 'ws://server.example' }, https),
    ).toThrow('wss');
  });
});
