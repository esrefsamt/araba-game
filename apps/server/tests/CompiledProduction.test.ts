import { describe, expect, it } from 'vitest';
import { runProductionSmoke } from '../../../scripts/smoke-server.mjs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('compiled production entrypoint', () => {
  it('fails invalid production startup clearly without echoing secret-valued config', () => {
    const token = 'a'.repeat(64);
    const result = spawnSync(process.execPath, [resolve('dist/main.js')], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: '8080',
        ALLOWED_ORIGINS: `https://${token}.example/path`,
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ALLOWED_ORIGINS');
    expect(result.stdout + result.stderr).not.toContain(token);
  });
  it('binds publicly and supports two moving clients, five-second resume, late joins, leave and clean logs', async () => {
    const result = await runProductionSmoke();
    expect(result).toMatchObject({
      status: 'passed',
      compiledEntrypoint: true,
      twoPlayersMoved: true,
      sameIdentity: true,
      duplicateVehicles: false,
      roomNavigation: true,
      tokenLogsClean: true,
    });
  }, 30000);
});
