# Trailer Arena

Trailer Arena is a browser-based, server-authoritative 3D multiplayer arcade driving game. Phase 4 adds the first complete room match loop—lobby, ready state, countdown, timed trailer scoring, results, session points, and next rounds—on top of the moving convoy and arcade RAM physics. Power-ups, damage, accounts, and matchmaking remain intentionally out of scope.

## Requirements

- Node.js 22 or newer
- pnpm 11.19.0 (the exact version pinned in `packageManager`)
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
pnpm build:client
pnpm build:server
pnpm start:server
pnpm smoke:server
pnpm test
pnpm lint
pnpm format:check
```

## Sessions and reconnect

The server issues a cryptographically random 256-bit session capability. The browser stores it in endpoint-scoped `sessionStorage` so refresh can resume the same player. There are no accounts or persistent login. Do not log or share this token. A healthy active connection rejects duplicate claims; a dead or timed-out connection can be replaced.

On disconnect the server neutralizes controls and suspends scoring immediately, while retaining the same physics body. The client retries with 0.5 / 1 / 2 / 3 / 5-second delays within the grace window. Resume sends one complete authoritative world snapshot, clears old interpolation/prediction buffers and inputs, and continues input sequences from the server acknowledgement. Historical particles and audio events are not replayed. Expired sessions or server restart show a recoverable connection error and a return-to-lobby action.

Native WebSocket ping/pong checks transport health every five seconds with a 15-second timeout. Browser implementations answer native ping frames automatically; the existing application ping/pong still measures latency. A central server sweep handles disconnected sessions. Development retains latency/jitter controls and adds buttons for five- and sixteen-second disconnect simulations.

LEAVE ROOM is available throughout a match. It sends an ownership-checked intentional leave, removes the player/vehicle/scoring state immediately, migrates the host if needed, and disposes an empty room without a reconnect grace period. The client waits for `room_left` before clearing room views, HUD, effects, input history and snapshot buffers. A rotated session capability has no room membership; the open WebSocket can join or create another room from ROOM SELECT. Name and sound preferences survive the switch. Refresh or reconnect after leaving cannot resume the old room. Pending room actions disable duplicate submissions; an unconfirmed leave returns to a recoverable connection screen after five seconds.

## Production Deployment

The browser is a static Vite client. A dedicated Node game server owns Rapier physics at 60 Hz, RAM, score, rounds and timers. The first player in a room is its **lobby host**, with permission to start rounds; that browser is never the game server.

```text
Browser Client (static HTTPS files)
        |
        | WSS
        v
TLS reverse proxy / load balancer
        |
        | HTTP + WebSocket Upgrade, one PORT
        v
Dedicated Node Game Server
        |
        Rapier 60 Hz, in-memory rooms/sessions
```

No hosting account or provider SDK is required. Client and server can be deployed separately. This is a **single game-server instance** architecture: multiple replicas do not share room/session state. A server restart discards active rooms and session capabilities, and the client returns through its recoverable lobby flow. There is no database, Redis, matchmaking or account authentication. Choose a future server region close to your players; their distance to the dedicated server affects latency. Region matchmaking is outside this phase.

### Static client

Set the public WebSocket endpoint **before building**. Examples below are placeholders, not deployed domains.

```bash
pnpm install --frozen-lockfile
VITE_WS_URL=wss://game-server.example/ pnpm build:client
```

PowerShell equivalent:

```powershell
$env:VITE_WS_URL = 'wss://game-server.example/'
pnpm build:client
Remove-Item Env:VITE_WS_URL
```

You can also copy `apps/client/.env.example` to `apps/client/.env.production.local` and set your endpoint there. Vite embeds `VITE_*` values in the public bundle; never put secrets in them. Publish **`apps/client/dist`** to any static host. `pnpm build` builds both client and server; it reads the same client configuration. Rebuild the client when its endpoint changes.

`ClientConfig` centralizes startup configuration. Explicit `VITE_WS_URL` accepts absolute `ws://` and `wss://` URLs, including a proxy path such as `/socket`. Malformed URLs and embedded credentials are rejected at build/startup; an HTTPS page rejects insecure `ws://`. An omitted URL supports same-origin hosting by deriving WS/WSS from the page's own host and protocol, without a production localhost fallback. For separate static/client and server hosts, always supply `VITE_WS_URL`. Development alone defaults to the page host on port 3000, so `pnpm dev` needs no env file.

Production hides the entire debug panel, network simulation, forced disconnect, prediction internals, telemetry and force-resync controls. Normal lobby, room code, Leave Room, timer, standings, results and sound controls remain. Client source maps are explicitly disabled. Hashed assets can use long immutable caching; serve `index.html` with revalidation or a short cache lifetime. These headers belong to the static host, not the game server.

### Node server

```bash
pnpm install --frozen-lockfile
pnpm build:server
NODE_ENV=production HOST=0.0.0.0 PORT=8080 ALLOWED_ORIGINS=https://client.example pnpm start:server
```

`pnpm start:server` runs compiled `node dist/main.js`, never `tsx watch`. Set environment variables through your process manager or cloud runtime. Alternatively copy `apps/server/.env.example` to `apps/server/.env.production`, replace its client origin, and use Node's built-in env-file support:

```bash
node --env-file=apps/server/.env.production apps/server/dist/main.js
```

The server does not automatically load dotenv files. Production startup **requires an explicit `PORT` and `ALLOWED_ORIGINS`**. Invalid mode, host, port, origins, log level or timing values fail clearly without echoing their values. Defaults and options:

- `NODE_ENV`: `development` by default; use `production` to disable all server DEV commands and the round-duration override.
- `PORT`: development default 3000; production must provide 1–65535, including a cloud-assigned port.
- `HOST`: default `0.0.0.0`; loopback/IPv6 or a plain hostname can be supplied.
- `ALLOWED_ORIGINS`: comma-separated exact HTTP(S) browser origins, e.g. `https://client.example,https://other.example:8443`. No paths, wildcards, credentials or suffix matching. This is the client page origin, not the server's WSS address.
- `ALLOW_NO_ORIGIN`: production default `false`, development default `true`. Opt in explicitly for future origin-less native clients. Origin checking protects browser connections; it is not account authentication, and non-browser clients can supply an Origin header.
- `LOG_LEVEL`: `debug`, `info` (default), `warn`, `error`, `silent`. Event logs are bounded and redact full 256-bit session capabilities; there are no per-physics-tick logs.
- `SESSION_GRACE_MS`: existing default **15000**; `HEARTBEAT_INTERVAL_MS=5000`, `HEARTBEAT_TIMEOUT_MS=15000`, `SHUTDOWN_TIMEOUT_MS=5000` remain unchanged.

Development permits loopback browser origins on any port. For testing from another machine on the LAN, explicitly add its page origin to `ALLOWED_ORIGINS`; the listener still binds publicly. Dependency installation is explicit: workspace scripts warn about a stale install instead of automatically pruning a developer's dependencies when `NODE_ENV` changes. CI/builds use `pnpm install --frozen-lockfile`.

### Docker server

Build from the repository root:

```bash
docker build --tag trailer-arena-server .
docker run --rm --init --name trailer-arena-server -p 8080:8080 \
  -e PORT=8080 -e ALLOWED_ORIGINS=https://client.example trailer-arena-server
```

Or supply a locally configured server env file with `--env-file apps/server/.env.production`, matching the published container port to its `PORT`. `NODE_ENV=production` and `HOST=0.0.0.0` are image defaults. `EXPOSE 3000` is metadata; it does not fix the listener or healthcheck port.

The multi-stage Dockerfile pins Node 24.21.0 bookworm-slim by digest and installs exactly the pnpm version from `packageManager`. The builder installs with the frozen lockfile, compiles shared/server, and prunes with `pnpm deploy --legacy --prod`. `materialize-shared.mjs` replaces the generated external workspace link with compiled shared files so the runtime is self-contained with pnpm 11.19. Runtime contains compiled server and production dependencies, runs as the non-root `node` user and starts plain Node. The Node-based HEALTHCHECK needs neither curl nor an extra dependency. `.dockerignore` excludes installed modules, generated output, Git, local env files, logs and system artifacts.

### Transport, health and shutdown

HTTP `/health` and `/ready` share the configured public port with WebSocket upgrades. Both return only `status`, `rooms`, `players` (including grace membership) and process `uptime` in seconds, with `Cache-Control: no-store`. No token, player identity or room details are exposed. They cannot report OK before simulation initialization and become unavailable during shutdown. No wildcard HTTP CORS is added.

Terminate TLS at a reverse proxy/load balancer, forward WebSocket Upgrade/Connection headers and the configured proxy path to the Node port, and allow persistent connections with an idle timeout longer than the heartbeat interval. HTTPS browser clients use WSS externally; the proxy may use plain WS to the Node service. Forwarded headers/IP addresses do not provide player identity or gameplay authority. The existing session capability still owns membership. Any future multi-instance routing must keep a room and its sessions on the same instance; a generic load balancer alone does not create shared state.

WebSocket `maxPayload` remains **16 KiB**: existing game requests are smaller, so the stricter existing limit is retained. Oversized frames close with 1009. `perMessageDeflate` is explicitly disabled to avoid compression latency/CPU overhead for small frequent messages. The existing eight-player room cap, runtime message validation, 90-inputs/second guard, six room/session actions per ten seconds, token validation, heartbeat and empty-room cleanup remain.

SIGINT/SIGTERM stops new connections, simulation and health readiness, closes sockets with 1001, disposes rooms and closes HTTP. Unresponsive sockets are terminated after the shutdown timeout. Fatal uncaught errors/rejections log a redacted error and shut down with failure status rather than leaving a corrupted process alive. Configure your process manager to restart a failed process; no provider integration is included. Windows directly terminating a child cannot validate Unix SIGTERM delivery; transport cleanup is covered by tests and the compiled console SIGINT path can be checked locally.

### Deployment checks

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm smoke:server
```

`pnpm test` first builds shared/server so the compiled-production tests work from a clean install. Run these before starting a long-lived `pnpm dev` session: rebuilding shared output causes development watchers to reload/restart the in-memory server.

`pnpm smoke:server` starts an isolated compiled production server on an available local port, verifies health, origins, create/join/ping/snapshots, two moving clients, an actual five-second disconnect/resume, late join, same-socket room navigation, host migration and menu resume after leave. It also checks server logs for token leaks, cleans test rooms and stops its own process. It uses real WebSockets, without DEV helpers. On Windows, Unix child-signal verification is unavailable; `GameServer.stop` tests still verify readiness 503 and socket close 1001.

For a **local** production client preview, build with a matching local endpoint and run the compiled server with the preview page's origin in `ALLOWED_ORIGINS`. Local HTTP permits WS; actual HTTPS deployment requires WSS. Rebuild with your public WSS URL before publishing; the local-test bundle is not a public deployment artifact.

Implementation references: [official Node Docker images](https://github.com/nodejs/docker-node) and [pnpm deploy](https://pnpm.io/cli/deploy). Docker execution availability and verified checks for this phase are recorded in `docs/Phase8-Rapor.md`.

### Public deployment verification

Phase 9 public deployment requires choosing and connecting a hosting provider first. The repository does not currently record a deployed public client/server URL. Deployment preparation and the remaining checks are in `docs/Phase9-Yayin-Kontrolu.md`.

After configuring the server's exact client origin, use the real endpoints:

```bash
pnpm smoke:deployment --server wss://PUBLIC_GAME_SERVER --origin https://PUBLIC_CLIENT
```

This performs the transport/reconnect smoke, two automated RTT probes, a full 90-second round, six mid-round joins, eight-player capacity/ninth-player rejection, identical authoritative snapshot comparison, observed snapshot/simulation rates, 17-second grace expiry, host migration, matching results, next round and room cleanup. It takes about two minutes, creates its own test rooms and never prints session capabilities. It requires HTTPS/WSS by default; `--local-test` explicitly labels a local rehearsal. RTT values from this command belong to two automated connections on the command's machine; they are **not** measurements from two remote human players.

Run two-computer driving, prediction, RAM, trailer, scoring and browser tests separately. Provider logs, CPU/RAM, container startup/SIGTERM, cache headers and public browser errors also require deployment access and are not certified by this script.
