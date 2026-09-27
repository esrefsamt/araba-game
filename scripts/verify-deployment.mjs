import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { runProductionSmoke } from './smoke-server.mjs';

const WebSocket = createRequire(new URL('../apps/server/package.json', import.meta.url))(
  'ws',
);
const { values } = parseArgs({
  options: {
    server: { type: 'string' },
    origin: { type: 'string' },
    'local-test': { type: 'boolean', default: false },
  },
});

async function verify() {
  assert(
    values.server && values.origin,
    'Supply --server <wss URL> and --origin <HTTPS client origin>.',
  );
  const endpoint = new URL(values.server);
  const origin = new URL(values.origin);
  const local = values['local-test'];
  assert(
    !endpoint.username && !endpoint.password && !endpoint.hash,
    'Server URL must not contain credentials or a fragment.',
  );
  assert(
    origin.href === `${origin.origin}/`,
    'Supply an exact client origin without a path, credentials, query or fragment.',
  );
  assert(
    local ? ['ws:', 'wss:'].includes(endpoint.protocol) : endpoint.protocol === 'wss:',
    'Public verification requires WSS; local rehearsal requires --local-test.',
  );
  assert(
    local ? ['http:', 'https:'].includes(origin.protocol) : origin.protocol === 'https:',
    'Public verification requires an HTTPS client origin.',
  );
  const mode = local ? 'local-rehearsal' : 'public-endpoint-automated-probes';
  const clients = [];
  const healthUrl = new URL('/health', endpoint);
  healthUrl.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
  const health = async () => {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.status, 'ok');
    assert.deepEqual(Object.keys(value).sort(), ['players', 'rooms', 'status', 'uptime']);
    return value;
  };
  const connect = async () => {
    const socket = new WebSocket(endpoint.href, { origin: origin.origin });
    const pending = new Set();
    const messages = [];
    const listeners = new Set();
    socket.on('error', () => {});
    socket.on('message', (raw) => {
      const value = JSON.parse(raw.toString());
      for (const listener of listeners) listener(value);
      for (const waiter of pending) {
        if (waiter.matches(value)) {
          pending.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(value);
          return;
        }
      }
      messages.push(value);
      if (messages.length > 128) messages.shift();
    });
    const next = (type, predicate = () => true, timeout = 10000) => {
      const matches = (value) => value.type === type && predicate(value);
      const index = messages.findIndex(matches);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { matches, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          pending.delete(waiter);
          reject(new Error(`Timed out waiting for ${type}`));
        }, timeout);
        pending.add(waiter);
      });
    };
    const connection = {
      socket,
      next,
      listeners,
      send: (value) => socket.send(JSON.stringify(value)),
    };
    clients.push(connection);
    connection.welcome = await next('connected');
    assert.equal(connection.welcome.reconnectWindowMs, 15000);
    assert.equal(socket.extensions, '');
    return connection;
  };
  const join = async (connection, roomId, number) => {
    const joined = connection.next('room_joined');
    connection.send({
      type: 'join_room',
      playerName: `Verify ${number}`,
      ...(roomId ? { roomId } : {}),
    });
    connection.joined = await joined;
  };
  const ping = async (connection) => {
    const samples = [];
    for (let n = 0; n < 7; n++) {
      const timestamp = Date.now();
      const response = connection.next('pong', (value) => value.timestamp === timestamp);
      const started = performance.now();
      connection.send({ type: 'ping', timestamp });
      await response;
      samples.push(performance.now() - started);
      await delay(100);
    }
    samples.sort((a, b) => a - b);
    return {
      samples: samples.length,
      minMs: Number(samples[0].toFixed(2)),
      medianMs: Number(samples[3].toFixed(2)),
      maxMs: Number(samples[6].toFixed(2)),
    };
  };
  try {
    console.error(`[verification] ${mode}: baseline transport/reconnect smoke`);
    const baseline = await runProductionSmoke({
      serverUrl: endpoint.href,
      origin: origin.origin,
    });
    const first = await connect();
    const second = await connect();
    await join(first, undefined, 1);
    const roomId = first.joined.roomId;
    await join(second, roomId, 2);
    first.send({ type: 'set_ready', ready: true });
    second.send({ type: 'set_ready', ready: true });
    await first.next(
      'world_snapshot',
      (state) =>
        state.gameState.players.length === 2 &&
        state.gameState.players.every((player) => player.ready),
    );
    const playing = first.next(
      'world_snapshot',
      (state) => state.gameState.phase === 'PLAYING',
    );
    first.send({ type: 'start_match' });
    const initial = await playing;
    assert.equal(
      initial.gameState.stateEndTick - initial.gameState.stateStartTick,
      90 * 60,
    );
    console.error('[verification] full 90-second round: adding six mid-round clients');
    for (let number = 3; number <= 8; number++) {
      const extra = await connect();
      await join(extra, roomId, number);
      const state = await extra.next(
        'world_snapshot',
        (snapshot) => snapshot.vehicles.length === number,
      );
      const player = state.gameState.players.find(
        (value) => value.playerId === extra.joined.playerId,
      );
      assert(player.participant);
      assert.equal(player.trailerTicks, 0);
      assert.equal(state.gameState.stateEndTick, initial.gameState.stateEndTick);
    }
    const ninth = await connect();
    const rejection = ninth.next('error');
    ninth.send({ type: 'join_room', playerName: 'Verify 9', roomId });
    assert.equal((await rejection).code, 'ROOM_FULL');
    const activeHealth = await health();
    assert(activeHealth.players >= 8 && activeHealth.rooms >= 1);
    const rtt = await Promise.all([ping(first), ping(second)]);
    const observations = [[], []];
    const monitors = [first, second].map((connection, index) => {
      const listener = (value) => {
        if (value.type === 'world_snapshot')
          observations[index].push({ at: performance.now(), state: value });
      };
      connection.listeners.add(listener);
      return listener;
    });
    for (const connection of [first, second])
      connection.send({
        type: 'player_input',
        sequence: 1,
        throttle: 1,
        brake: 0,
        steering: 0,
        handbrake: false,
      });
    await delay(4000);
    for (const [index, connection] of [first, second].entries()) {
      connection.listeners.delete(monitors[index]);
      connection.send({
        type: 'player_input',
        sequence: 2,
        throttle: 0,
        brake: 0,
        steering: 0,
        handbrake: false,
      });
    }
    const peerFrames = new Map(
      observations[1].map((frame) => [frame.state.serverTick, frame.state]),
    );
    let identicalFrames = 0;
    for (const frame of observations[0]) {
      const other = peerFrames.get(frame.state.serverTick);
      if (other) {
        assert.deepEqual(frame.state, other);
        identicalFrames++;
      }
    }
    assert(
      identicalFrames >= 10,
      'Too few shared snapshots to compare authoritative worlds.',
    );
    const rates = observations.map((frames) => {
      assert(frames.length >= 2, 'No sustained world snapshots.');
      const firstFrame = frames[0];
      const lastFrame = frames.at(-1);
      const seconds = (lastFrame.at - firstFrame.at) / 1000;
      return {
        snapshotHz: Number(((frames.length - 1) / seconds).toFixed(2)),
        simulationTicksPerSecond: Number(
          ((lastFrame.state.serverTick - firstFrame.state.serverTick) / seconds).toFixed(
            2,
          ),
        ),
      };
    });
    for (const connection of [first, second]) {
      const start = observations[0][0].state.vehicles.find(
        (vehicle) => vehicle.playerId === connection.joined.playerId,
      );
      const end = observations[0]
        .at(-1)
        .state.vehicles.find(
          (vehicle) => vehicle.playerId === connection.joined.playerId,
        );
      assert.notDeepEqual(start.position, end.position);
      assert.equal(end.lastProcessedInputSequence, 1);
    }
    const closed = once(first.socket, 'close');
    first.socket.terminate();
    await closed;
    console.error(
      '[verification] capacity/RTT/shared snapshots passed; waiting 17 seconds for real grace expiry',
    );
    await delay(17000);
    const expired = await connect();
    const expiry = expired.next('error');
    expired.send({ type: 'reconnect_session', sessionToken: first.welcome.sessionToken });
    assert.equal((await expiry).code, 'SESSION_EXPIRED');
    const migrated = await second.next(
      'world_snapshot',
      (state) =>
        state.vehicles.length === 7 &&
        state.gameState.hostPlayerId === second.joined.playerId,
    );
    assert(
      !migrated.vehicles.some((vehicle) => vehicle.playerId === first.joined.playerId),
    );
    console.error(
      '[verification] grace expiry and host migration passed; waiting for normal RESULTS',
    );
    const results = await second.next(
      'world_snapshot',
      (state) => state.gameState.phase === 'RESULTS',
      100000,
    );
    const third = clients[2];
    const sameResults = await third.next(
      'world_snapshot',
      (state) => state.gameState.phase === 'RESULTS',
    );
    assert.deepEqual(results.gameState, sameResults.gameState);
    assert.equal(results.gameState.results.length, 7);
    const nextRound = second.next(
      'world_snapshot',
      (state) =>
        state.gameState.phase === 'COUNTDOWN' && state.gameState.roundNumber === 2,
    );
    second.send({ type: 'next_round' });
    await nextRound;
    for (const connection of clients.filter((value) => value.joined && value !== first)) {
      const left = connection.next('room_left');
      connection.send({ type: 'leave_room' });
      await left;
    }
    const removed = ninth.next('error');
    ninth.send({ type: 'join_room', playerName: 'Verify 9', roomId });
    assert.equal((await removed).code, 'ROOM_NOT_FOUND');
    const finalHealth = await health();
    return {
      mode,
      status: 'passed',
      server: endpoint.origin,
      clientOrigin: origin.origin,
      baselineSmoke: baseline.status,
      eightPlayers: true,
      ninthRejected: true,
      midRoundJoin: true,
      automatedProbeRtt: rtt,
      rates,
      identicalAuthoritativeFrames: identicalFrames,
      fullRoundSeconds: 90,
      matchingResults: true,
      nextRound: true,
      graceExpiryWaitMs: 17000,
      graceExpired: true,
      hostMigration: true,
      roomRemoved: true,
      activeHealth,
      finalHealth,
      twoComputerTest: 'not performed by this script',
      ramAndTrailerDrivingFeel: 'requires two remote human players',
      providerLogsAndCpuRam: 'requires provider access',
    };
  } finally {
    for (const connection of clients)
      if (connection.socket.readyState !== WebSocket.CLOSED)
        connection.socket.terminate();
  }
}

try {
  console.log(JSON.stringify(await verify(), null, 2));
} catch (error) {
  // Never print protocol responses or capabilities, including assertion actual/expected values.
  console.error(
    error instanceof Error
      ? error.message.replace(/[a-f0-9]{64}/gi, '[redacted]')
      : 'Deployment verification failed',
  );
  process.exitCode = 1;
}
