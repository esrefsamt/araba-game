import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WebSocket = createRequire(resolve(root, 'apps/server/package.json'))('ws');

async function freePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  return port;
}

function client(url, origin) {
  const socket = new WebSocket(url, { origin });
  socket.on('error', () => {});
  const wait = (type, predicate = () => true, timeoutMs = 4000) =>
    new Promise((done, reject) => {
      const timer = setTimeout(() => {
        socket.off('message', message);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);
      function message(raw) {
        const value = JSON.parse(raw.toString());
        if (value.type !== type || !predicate(value)) return;
        clearTimeout(timer);
        socket.off('message', message);
        done(value);
      }
      socket.on('message', message);
    });
  return { socket, wait, send: (message) => socket.send(JSON.stringify(message)) };
}

async function rejectedOrigin(url, origin) {
  return new Promise((done, reject) => {
    const socket = new WebSocket(url, origin === undefined ? {} : { origin });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('Origin rejection timed out'));
    }, 4000);
    socket.on('error', () => {});
    socket.once('open', () => {
      clearTimeout(timeout);
      socket.terminate();
      reject(new Error('Disallowed origin connected'));
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      socket.terminate();
      done(response.statusCode);
    });
  });
}

export async function runProductionSmoke({
  serverUrl,
  origin = 'http://localhost:4173',
  entrypoint = resolve(root, 'apps/server/dist/main.js'),
} = {}) {
  let child;
  let logs = '';
  let exited;
  const clients = [];
  const tokens = [];
  const own = serverUrl === undefined;
  if (own) {
    const port = await freePort();
    serverUrl = `ws://127.0.0.1:${port}/`;
    child = spawn(process.execPath, [entrypoint], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: String(port),
        ALLOWED_ORIGINS: origin,
        ALLOW_NO_ORIGIN: 'false',
        LOG_LEVEL: 'info',
        SESSION_GRACE_MS: '15000',
      },
    });
    child.stdout.on('data', (data) => {
      logs += data.toString();
    });
    child.stderr.on('data', (data) => {
      logs += data.toString();
    });
    exited = once(child, 'exit');
  }
  const endpoint = new URL(serverUrl);
  assert(['ws:', 'wss:'].includes(endpoint.protocol), 'Smoke URL must use ws or wss');
  const healthUrl = new URL('/health', endpoint);
  healthUrl.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
  const health = async () => {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const value = await response.json();
    assert.deepEqual(Object.keys(value).sort(), ['players', 'rooms', 'status', 'uptime']);
    assert.equal(value.status, 'ok');
    return value;
  };
  const connect = async () => {
    const connection = client(serverUrl, origin);
    clients.push(connection);
    connection.welcome = await connection.wait('connected');
    tokens.push(connection.welcome.sessionToken);
    assert.equal(connection.socket.extensions, '');
    return connection;
  };
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await health();
        break;
      } catch {
        if (!own || attempt === 49 || child.exitCode !== null)
          throw new Error('Compiled production server did not become healthy');
        await delay(100);
      }
    }
    assert.equal(await rejectedOrigin(serverUrl, 'https://untrusted.invalid'), 403);
    if (own) assert.equal(await rejectedOrigin(serverUrl, undefined), 403);
    const first = await connect();
    const second = await connect();
    let pending = first.wait('room_joined');
    first.send({ type: 'join_room', playerName: 'Smoke A' });
    const joinedA = await pending;
    pending = second.wait('room_joined');
    second.send({ type: 'join_room', playerName: 'Smoke B', roomId: joinedA.roomId });
    const joinedB = await pending;
    assert.equal(joinedB.roomId, joinedA.roomId);
    const pair = await second.wait(
      'world_snapshot',
      (state) => state.vehicles.length === 2,
    );
    assert.equal(pair.gameState.players.length, 2);
    const stamp = Date.now();
    pending = first.wait('pong', (message) => message.timestamp === stamp);
    first.send({ type: 'ping', timestamp: stamp });
    await pending;
    pending = first.wait('error');
    first.socket.send('{broken JSON');
    assert.equal((await pending).code, 'INVALID_MESSAGE');
    first.send({ type: 'set_ready', ready: true });
    second.send({ type: 'set_ready', ready: true });
    await first.wait('world_snapshot', (state) =>
      state.gameState.players.every((player) => player.ready),
    );
    pending = first.wait(
      'world_snapshot',
      (state) => state.gameState.phase === 'PLAYING',
      6000,
    );
    first.send({ type: 'start_match' });
    await pending;
    const before = await second.wait('world_snapshot');
    first.send({
      type: 'player_input',
      sequence: 1,
      throttle: 1,
      brake: 0,
      steering: 0,
      handbrake: false,
    });
    second.send({
      type: 'player_input',
      sequence: 1,
      throttle: 1,
      brake: 0,
      steering: 0,
      handbrake: false,
    });
    await second.wait('world_snapshot', (state) =>
      state.vehicles.every((vehicle) => vehicle.lastProcessedInputSequence === 1),
    );
    await delay(600);
    const moved = await second.wait('world_snapshot');
    for (const vehicle of moved.vehicles) {
      assert.notDeepEqual(
        vehicle.position,
        before.vehicles.find((old) => old.playerId === vehicle.playerId).position,
      );
      assert(
        moved.gameState.players.find((player) => player.playerId === vehicle.playerId)
          .participant,
      );
    }
    const dropped = once(first.socket, 'close');
    first.socket.terminate();
    await dropped;
    await delay(5000);
    const resumed = await connect();
    pending = resumed.wait('session_resumed');
    resumed.send({ type: 'reconnect_session', sessionToken: first.welcome.sessionToken });
    const restored = await pending;
    assert.equal(restored.playerId, joinedA.playerId);
    assert.equal(restored.roomId, joinedA.roomId);
    assert(
      restored.sessionToken === first.welcome.sessionToken,
      'Resume capability mismatch',
    );
    assert.equal(restored.state.vehicles.length, 2);
    assert.equal(restored.state.gameState.players.length, 2);
    assert.equal(restored.state.gameState.hostPlayerId, joinedB.playerId);
    const late = await connect();
    pending = late.wait('room_joined');
    late.send({ type: 'join_room', playerName: 'Smoke C', roomId: joinedA.roomId });
    const joinedC = await pending;
    const lateState = await late.wait(
      'world_snapshot',
      (state) => state.vehicles.length === 3,
    );
    const latePlayer = lateState.gameState.players.find(
      (player) => player.playerId === joinedC.playerId,
    );
    assert(latePlayer.participant);
    assert.equal(latePlayer.trailerTicks, 0);
    assert.equal(lateState.gameState.stateEndTick, restored.state.gameState.stateEndTick);
    const leave = async (connection) => {
      const ack = connection.wait('room_left');
      connection.send({ type: 'leave_room' });
      const value = await ack;
      tokens.push(value.sessionToken);
      return value;
    };
    await leave(late);
    pending = late.wait('room_joined');
    late.send({ type: 'join_room', playerName: 'Smoke C' });
    const other = await pending;
    assert.notEqual(other.roomId, joinedA.roomId);
    await leave(late);
    pending = late.wait('room_joined');
    late.send({ type: 'join_room', playerName: 'Smoke C', roomId: joinedA.roomId });
    assert.equal((await pending).roomId, joinedA.roomId);
    await leave(late);
    await leave(second);
    await resumed.wait(
      'world_snapshot',
      (state) =>
        state.gameState.hostPlayerId === joinedA.playerId && state.vehicles.length === 1,
    );
    const emptySession = await leave(resumed);
    const closed = once(resumed.socket, 'close');
    resumed.socket.close();
    await closed;
    const menu = await connect();
    pending = menu.wait('session_resumed');
    menu.send({ type: 'reconnect_session', sessionToken: emptySession.sessionToken });
    const menuState = await pending;
    assert.equal(menuState.roomId, null);
    assert.equal(menuState.playerId, null);
    assert.equal(menuState.state, null);
    const finalHealth = await health();
    if (own) {
      assert.equal(finalHealth.rooms, 0);
      assert.equal(finalHealth.players, 0);
    }
    assert(
      tokens.every((token) => !logs.includes(token)),
      'A session capability leaked into server logs',
    );
    return {
      status: 'passed',
      compiledEntrypoint: own,
      twoPlayersMoved: true,
      reconnectDelayMs: 5000,
      sameIdentity: true,
      duplicateVehicles: false,
      roomNavigation: true,
      allowedOrigins: true,
      noCompression: true,
      tokenLogsClean: own,
      finalHealth,
    };
  } finally {
    for (const connection of clients)
      if (connection.socket.readyState !== WebSocket.CLOSED)
        connection.socket.terminate();
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      const result = await Promise.race([exited, delay(7000).then(() => null)]);
      if (result === null) {
        child.kill('SIGKILL');
        await exited;
      }
      // Windows terminates child processes directly; GameServer.stop is tested separately.
      if (process.platform !== 'win32')
        assert(
          logs.includes('shutdown complete') && result?.[0] === 0,
          'Compiled graceful shutdown failed',
        );
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(
        await runProductionSmoke({
          ...(process.argv[2] ? { serverUrl: process.argv[2] } : {}),
          ...(process.argv[3] ? { origin: process.argv[3] } : {}),
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Production smoke failed');
    process.exitCode = 1;
  }
}
