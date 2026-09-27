import { once } from 'node:events';
import type { ServerMessage } from '@trailer-arena/shared';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { GameServer } from '../src/server/GameServer.js';
import { loadServerConfig } from '../src/server/ServerConfig.js';

const servers: GameServer[] = [];
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const client of clients) client.terminate();
  await Promise.all(servers.map((server) => server.stop()));
  clients.length = 0;
  servers.length = 0;
});

async function start(port = 0) {
  const server = new GameServer({ host: '127.0.0.1', port });
  servers.push(server);
  await server.start();
  return {
    server,
    base: `http://127.0.0.1:${server.address!.port}`,
    url: `ws://127.0.0.1:${server.address!.port}`,
  };
}
function receive<T extends ServerMessage['type']>(
  socket: WebSocket,
  type: T,
): Promise<Extract<ServerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', handler);
      reject(new Error(`Timed out waiting for ${type}.`));
    }, 2_000);
    const handler = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off('message', handler);
      resolve(message as Extract<ServerMessage, { type: T }>);
    };
    socket.on('message', handler);
  });
}
async function connect(url: string) {
  const socket = new WebSocket(url);
  clients.push(socket);
  const welcome = await receive(socket, 'connected');
  return { socket, welcome };
}

describe('production server lifecycle', () => {
  it('loads PORT/HOST and configurable grace/heartbeat settings and rejects invalid numbers', () => {
    const config = loadServerConfig({
      PORT: '8080',
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
    });
    expect(config).toMatchObject({
      port: 8080,
      host: '127.0.0.1',
      graceMs: 15_000,
      heartbeatIntervalMs: 5_000,
      heartbeatTimeoutMs: 15_000,
    });
    expect(() => loadServerConfig({ PORT: 'NaN' })).toThrow('PORT');
    expect(() => loadServerConfig({ PORT: '70000' })).toThrow('PORT');
    expect(() =>
      loadServerConfig({ HEARTBEAT_INTERVAL_MS: '5000', HEARTBEAT_TIMEOUT_MS: '5000' }),
    ).toThrow('Heartbeat');
    expect(() => loadServerConfig({ SESSION_GRACE_MS: '-1' })).toThrow(
      'SESSION_GRACE_MS',
    );
  });

  it('serves a public health response and counts grace memberships without leaking session credentials', async () => {
    const { base, url } = await start();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', rooms: 0, players: 0 });
    const { socket, welcome } = await connect(url);
    const joined = receive(socket, 'room_joined');
    socket.send(JSON.stringify({ type: 'join_room', playerName: 'Health' }));
    await joined;
    const health = await (await fetch(`${base}/health`)).text();
    expect(JSON.parse(health)).toMatchObject({ rooms: 1, players: 1 });
    expect(health).not.toContain(welcome.sessionToken);
    const closed = once(socket, 'close');
    socket.close();
    await closed;
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({
      rooms: 1,
      players: 1,
    });
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it('resumes a real dropped WebSocket using the same player and a full snapshot', async () => {
    const { url } = await start();
    const first = await connect(url);
    const joined = receive(first.socket, 'room_joined');
    first.socket.send(JSON.stringify({ type: 'join_room', playerName: 'Resume' }));
    const identity = await joined;
    const close = once(first.socket, 'close');
    first.socket.terminate();
    await close;
    const second = await connect(url);
    const resume = receive(second.socket, 'session_resumed');
    second.socket.send(
      JSON.stringify({
        type: 'reconnect_session',
        sessionToken: first.welcome.sessionToken,
      }),
    );
    const restored = await resume;
    expect(restored).toMatchObject({
      roomId: identity.roomId,
      playerId: identity.playerId,
    });
    expect(restored.state?.vehicles).toHaveLength(1);
    expect(restored.state?.gameState.players).toHaveLength(1);
  });

  it('keeps an idle browser-style WebSocket alive through native automatic pong', async () => {
    const server = new GameServer({
      host: '127.0.0.1',
      port: 0,
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 3000,
    });
    servers.push(server);
    await server.start();
    const { socket } = await connect(`ws://127.0.0.1:${server.address!.port}`);
    // Central maintenance sweeps once per second; a native pong must protect the next sweep.
    await new Promise((resolve) => setTimeout(resolve, 4200));
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('closes sockets, stops HTTP/upgrade acceptance and makes repeated shutdown safe', async () => {
    const { server, base, url } = await start();
    const { socket } = await connect(url);
    const close = once(socket, 'close');
    await Promise.all([server.stop(), server.stop()]);
    const [code] = await close;
    expect(code).toBe(1001);
    await expect(fetch(`${base}/health`)).rejects.toThrow();
    expect(server.address).toBeNull();
  });

  it('rejects old in-memory sessions after a process-like server restart', async () => {
    const firstServer = await start();
    const first = await connect(firstServer.url);
    const port = firstServer.server.address!.port;
    await firstServer.server.stop();
    const restarted = await start(port);
    const next = await connect(restarted.url);
    const rejection = receive(next.socket, 'error');
    next.socket.send(
      JSON.stringify({
        type: 'reconnect_session',
        sessionToken: first.welcome.sessionToken,
      }),
    );
    expect((await rejection).code).toBe('SESSION_EXPIRED');
    expect(await (await fetch(`${restarted.base}/health`)).json()).toMatchObject({
      rooms: 0,
      players: 0,
    });
  });
});
