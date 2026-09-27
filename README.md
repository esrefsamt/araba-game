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

Rooms support up to eight players. Empty rooms are removed automatically, and disconnects trigger player cleanup plus `player_left` notifications.

The room state machine is `LOBBY → COUNTDOWN → PLAYING → RESULTS`. Countdown and the 90-second round use simulation ticks. Only genuine raycast-wheel support from the trailer deck earns time; ramp, ground, air, and truck contacts do not. A 150 ms contact grace prevents suspension flicker. Round ranking uses total trailer ticks, then best streak and join order; position points persist across rounds as room-session points. Late joiners wait for the next round, and host authority migrates to the oldest remaining player.

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
