import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadServerConfig } from '../src/server/ServerConfig.js';
import { isOriginAllowed } from '../src/server/OriginPolicy.js';
import { createServerLogger } from '../src/server/ServerLogger.js';

const production = {
  NODE_ENV: 'production',
  PORT: '8080',
  ALLOWED_ORIGINS: 'https://client.example,https://other.example:8443',
};
afterEach(() => vi.restoreAllMocks());

describe('deployment configuration', () => {
  it('keeps environment-free development defaults and existing grace/heartbeat constants', () => {
    expect(loadServerConfig({})).toMatchObject({
      port: 3000,
      host: '0.0.0.0',
      production: false,
      graceMs: 15000,
      heartbeatIntervalMs: 5000,
      heartbeatTimeoutMs: 15000,
    });
  });
  it('loads provider PORT and explicit public HOST in production', () => {
    expect(
      loadServerConfig({ ...production, PORT: '12345', HOST: '0.0.0.0' }),
    ).toMatchObject({
      port: 12345,
      host: '0.0.0.0',
      production: true,
      allowMissingOrigin: false,
    });
  });
  it.each([
    ['PORT', ''],
    ['PORT', '1e3'],
    ['PORT', '-1'],
    ['PORT', '65536'],
    ['HOST', 'https://server.example'],
    ['HOST', ''],
    ['NODE_ENV', 'prod'],
    ['ALLOWED_ORIGINS', '*'],
    ['ALLOWED_ORIGINS', 'https://client.example/path'],
    ['ALLOWED_ORIGINS', 'https://user:password@client.example'],
    ['ALLOWED_ORIGINS', ''],
    ['ALLOW_NO_ORIGIN', 'yes'],
    ['LOG_LEVEL', 'verbose'],
  ])('rejects invalid %s configuration without echoing its value', (name, value) => {
    expect(() => loadServerConfig({ ...production, [name]: value })).toThrow(name);
  });
  it('requires production PORT and an origin allowlist rather than accepting an implicit deployment', () => {
    expect(() => loadServerConfig({ NODE_ENV: 'production' })).toThrow('PORT');
    expect(() => loadServerConfig({ NODE_ENV: 'production', PORT: '3000' })).toThrow(
      'ALLOWED_ORIGINS',
    );
  });
  it('normalizes exact origins and rejects suffix, null, wildcard and malformed browser origins', () => {
    expect(() =>
      loadServerConfig({ ...production, ALLOWED_ORIGINS: 'https://*.example' }),
    ).toThrow('ALLOWED_ORIGINS');
    const config = loadServerConfig(production);
    expect(isOriginAllowed('https://client.example', config)).toBe(true);
    expect(isOriginAllowed('https://other.example:8443', config)).toBe(true);
    for (const origin of [
      'https://client.example.evil',
      'http://client.example',
      'https://other.example',
      'null',
      '*',
      'https://client.example/path',
      undefined,
    ])
      expect(isOriginAllowed(origin, config)).toBe(false);
  });
  it('allows loopback development and explicitly configurable origin-less native clients', () => {
    const dev = loadServerConfig({});
    for (const origin of [
      'http://localhost:5173',
      'http://127.0.0.1:4173',
      'http://[::1]:5173',
      undefined,
    ])
      expect(isOriginAllowed(origin, dev)).toBe(true);
    expect(isOriginAllowed('https://untrusted.example', dev)).toBe(false);
    expect(
      isOriginAllowed(
        undefined,
        loadServerConfig({ ...production, ALLOW_NO_ORIGIN: 'true' }),
      ),
    ).toBe(true);
  });
  it('redacts session capabilities from error messages and follows the configured log level', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createServerLogger('error');
    const token = 'a'.repeat(64);
    logger.info('not shown');
    logger.error(new Error(`Session ${token} failed`));
    expect(info).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(' ')).not.toContain(token);
    expect(error.mock.calls.flat().join(' ')).toContain('redacted');
    createServerLogger('silent').error('not shown');
    expect(error).toHaveBeenCalledOnce();
  });
});
