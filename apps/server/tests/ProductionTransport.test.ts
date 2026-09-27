import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { GameServer } from '../src/server/GameServer.js';
import {
  loadServerConfig,
  MAX_WEBSOCKET_PAYLOAD_BYTES,
} from '../src/server/ServerConfig.js';

const servers: GameServer[] = [];
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const client of clients) client.terminate();
  await Promise.all(servers.map((server) => server.stop()));
  servers.length = clients.length = 0;
});
async function start() {
  const server = new GameServer({
    ...loadServerConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      ALLOWED_ORIGINS: 'https://client.example',
    }),
    port: 0,
  });
  servers.push(server);
  await server.start();
  return {
    server,
    url: `ws://127.0.0.1:${server.address!.port}`,
    http: `http://127.0.0.1:${server.address!.port}`,
  };
}
function connect(url: string, origin = 'https://client.example') {
  const socket = new WebSocket(url, { origin });
  clients.push(socket);
  socket.on('error', () => {});
  return socket;
}

describe('production HTTP and WebSocket transport', () => {
  it('does not start listening if shutdown wins the initialization race', async () => {
    const server = new GameServer({ port: 0 });
    servers.push(server);
    const starting = server.start();
    await server.stop();
    await starting;
    expect(server.address).toBeNull();
  });
  it('binds 0.0.0.0 and exposes initialized health/readiness with only aggregate data and no wildcard CORS', async () => {
    const { server, http } = await start();
    expect(server.address!.address).toBe('0.0.0.0');
    for (const path of ['/health', '/ready']) {
      const response = await fetch(http + path);
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(Object.keys(await response.json()).sort()).toEqual([
        'players',
        'rooms',
        'status',
        'uptime',
      ]);
    }
  });
  it('rejects a disallowed browser origin during HTTP upgrade before creating a session', async () => {
    const { url, http } = await start();
    const socket = connect(url, 'https://client.example.evil');
    const [, response] = await once(socket, 'unexpected-response');
    expect(response.statusCode).toBe(403);
    response.resume();
    socket.terminate();
    expect(await (await fetch(http + '/health')).json()).toMatchObject({
      rooms: 0,
      players: 0,
    });
  });
  it('closes an oversized frame with 1009 while keeping the server healthy and compression disabled', async () => {
    const { url, http } = await start();
    const socket = connect(url);
    await once(socket, 'open');
    expect(socket.extensions).toBe('');
    const closed = new Promise<number>((resolve) =>
      socket.once('close', (code) => resolve(code)),
    );
    socket.send('x'.repeat(MAX_WEBSOCKET_PAYLOAD_BYTES + 1));
    expect(await closed).toBe(1009);
    expect((await fetch(http + '/health')).status).toBe(200);
  });
  it('marks readiness unavailable once shutdown begins and closes real WebSockets with 1001', async () => {
    const { server, url } = await start();
    const socket = connect(url);
    await once(socket, 'open');
    const httpServer = Reflect.get(server, 'httpServer');
    const closed = once(socket, 'close');
    const stopping = server.stop();
    let status = 0;
    let body = '';
    httpServer.emit(
      'request',
      { method: 'GET', url: '/ready' },
      {
        writeHead: (code: number) => {
          status = code;
        },
        end: (value: string) => {
          body = value;
        },
      },
    );
    expect(status).toBe(503);
    expect(JSON.parse(body).status).toBe('stopping');
    await stopping;
    expect((await closed)[0]).toBe(1001);
    expect(server.address).toBeNull();
  });
});
