# Trailer Arena

Trailer Arena is a browser-based, server-authoritative 3D multiplayer arcade driving game. Phase 4 adds the first complete room match loop—lobby, ready state, countdown, timed trailer scoring, results, session points, and next rounds—on top of the moving convoy and arcade RAM physics. Power-ups, damage, accounts, and matchmaking remain intentionally out of scope.

## Requirements

- Node.js 22 or newer
- pnpm 10 or newer
- A WebGL-capable modern browser

## Install

```bash
pnpm install
```

## Start

```bash
pnpm dev
```

- Client: http://localhost:5173
- WebSocket server: ws://localhost:3000

Open a second browser tab, enter the room code shown in the first tab, and join to exercise the room flow.

The first player is the room host. In multiplayer, every player must be ready before the host can start. A production round lasts 90 seconds. For local UI testing only, the server accepts `DEBUG_ROUND_DURATION_SECONDS` while `NODE_ENV` is not `production`.

## Controls

- `W` / `ArrowUp`: accelerate
- `S` / `ArrowDown`: brake, then reverse near standstill
- `A` / `ArrowLeft`: steer left
- `D` / `ArrowRight`: steer right
- `Space`: handbrake / reduced rear grip
- `RESET VEHICLE`: asks the authoritative server to reset the local vehicle
- `TELEPORT NEAR TRAILER`: development-only server request for a safe approach spawn

## Project structure

```text
apps/
  client/       Vite, Three.js, browser networking, and development UI
  server/       WebSocket transport, rooms, players, and authoritative simulation
packages/
  shared/       Shared protocol, runtime message validation, types, and constants
```

## Architecture summary

The client keeps rendering, networking, input transmission, snapshot buffering, vehicle/convoy views, camera behavior, and local visual world state in separate modules. Rendering runs with `requestAnimationFrame`; inputs are transmitted at 30 Hz. The server keeps WebSocket connection handling, rooms, players, vehicle simulation, the convoy system, and the fixed scheduler independent so each area can evolve without embedding game rules in the transport layer.

Messages use a shared discriminated-union protocol and runtime validation. JSON is currently hidden behind a codec interface, allowing a later move to binary snapshots without rewriting room or game logic. The unchanged oval is 72 m per straight, has a 32 m turn radius, and is 16 m wide; it remains open to the surrounding grass without edge barriers.

## Multiplayer architecture

The server owns the canonical simulation and match state. Each room has an isolated Rapier world advanced by a fixed-step accumulator at 60 Hz. Vehicle, convoy, and game-mode state share one world snapshot sent at 20 Hz; lightweight server tick messages remain at 10 Hz. The browser sends only validated input and match-action requests and never supplies transforms, score, rank, timer, path progress, or physics state. Vehicle, truck, and trailer meshes render roughly 100 ms behind the server on the same interpolation clock using position lerp and quaternion slerp.

Vehicles use Rapier's dynamic raycast vehicle controller: a rounded dynamic chassis, four suspension rays, real collision impulses, speed-sensitive steering, an engine curve, braking/reverse logic, rolling and aerodynamic drag, lateral grip, and reduced rear grip under handbrake. Tuning lives in the shared `VehicleTuning` constants.

The truck and trailer use position-based kinematic Rapier bodies following the existing oval centerline. This keeps the gameplay platform deterministic and avoids joint jackknife/jitter. Rapier supplies their contact velocities; controller-level surface-relative velocity, rolling resistance, grip, and a bounded neutral-input static-friction assist keep a dynamic vehicle stable on the rotating deck without making the player vehicle authoritative or kinematic.

Rooms support up to eight players, including players in the 15-second disconnect grace period. Unexpected disconnects keep identity, vehicle, ready state and scores until reconnect or expiry; explicit leave cleans up immediately. Empty rooms are removed automatically. Host authority moves immediately to the oldest connected player, and returning hosts keep the migrated authority.

The room state machine is `LOBBY → COUNTDOWN → PLAYING → RESULTS`. Countdown and the 90-second round use simulation ticks. Only genuine raycast-wheel support from the trailer deck earns time; ramp, ground, air, and truck contacts do not. A 150 ms contact grace prevents suspension flicker. Round ranking uses total trailer ticks, then best streak and join order; position points persist across rounds as room-session points. Players joining during PLAYING immediately participate with zero trailer time and the existing remaining timer; COUNTDOWN joiners participate when controls unlock at PLAYING. RESULTS joiners enter the next round without changing completed results. Spawns skip occupied vehicle/convoy positions, and host authority migrates to the oldest remaining player.

## Commands

```bash
pnpm dev
pnpm dev:client
pnpm dev:server
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
```

## Sessions and reconnect

The server issues a cryptographically random 256-bit session capability. The browser stores it in endpoint-scoped `sessionStorage` so refresh can resume the same player. There are no accounts or persistent login. Do not log or share this token. A healthy active connection rejects duplicate claims; a dead or timed-out connection can be replaced.

On disconnect the server neutralizes controls and suspends scoring immediately, while retaining the same physics body. The client retries with 0.5 / 1 / 2 / 3 / 5-second delays within the grace window. Resume sends one complete authoritative world snapshot, clears old interpolation/prediction buffers and inputs, and continues input sequences from the server acknowledgement. Historical particles and audio events are not replayed. Expired sessions or server restart show a recoverable connection error and a return-to-lobby action.

Native WebSocket ping/pong checks transport health every five seconds with a 15-second timeout. Browser implementations answer native ping frames automatically; the existing application ping/pong still measures latency. A central server sweep handles disconnected sessions. Development retains latency/jitter controls and adds buttons for five- and sixteen-second disconnect simulations.

LEAVE ROOM is available throughout a match. It sends an ownership-checked intentional leave, removes the player/vehicle/scoring state immediately, migrates the host if needed, and disposes an empty room without a reconnect grace period. The client waits for `room_left` before clearing room views, HUD, effects, input history and snapshot buffers. A rotated session capability has no room membership; the open WebSocket can join or create another room from ROOM SELECT. Name and sound preferences survive the switch. Refresh or reconnect after leaving cannot resume the old room. Pending room actions disable duplicate submissions; an unconfirmed leave returns to a recoverable connection screen after five seconds.

## Production configuration

Set `VITE_WS_URL` before building the client (for example `wss://game.example.com/`). See `apps/client/.env.example`; Vite supports `.env.local`. Without an override, production selects `ws://` or `wss://` from the page protocol and uses its host. Development uses the page host on port 3000. An HTTPS page rejects an insecure `ws://` override.

Run `pnpm build`, serve `apps/client/dist` as static files, and run `pnpm --filter @trailer-arena/server start` with the server process environment configured. `apps/server/.env.example` documents the settings; it is an example, not an automatically loaded file. Defaults are `PORT=3000`, `HOST=0.0.0.0`, `SESSION_GRACE_MS=15000`, `HEARTBEAT_INTERVAL_MS=5000`, `HEARTBEAT_TIMEOUT_MS=15000` and `SHUTDOWN_TIMEOUT_MS=5000`. Set `NODE_ENV=production` to disable server development commands and duration overrides. No gameplay constants change.

Terminate TLS at your hosting platform or reverse proxy and forward WebSocket Upgrade requests to the server's HTTP port. Serve the client over HTTPS and use a matching `wss://` endpoint. The game server itself serves plain HTTP/WebSocket. `GET /health` returns only status, room count, player count (including grace slots), and process uptime in seconds. SIGINT/SIGTERM stops new upgrades, stops simulation, closes sockets with code 1001, and disposes rooms; unresponsive connections are terminated after the shutdown deadline.

Room creation/join, reconnect and leave share a per-connection guard of six requests per ten seconds; the existing input guard remains intact. WebSocket payloads are limited to 16 KiB and session tokens are strictly validated. Rooms and sessions are in memory: restart discards them, and deployments must route a room's players to the same process. This phase adds no database or multi-process room routing.
