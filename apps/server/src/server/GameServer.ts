import { TICKS_PER_NETWORK_UPDATE, TICKS_PER_SNAPSHOT } from '@trailer-arena/shared';
import { WebSocketServer } from 'ws';

import { ConnectionManager } from '../networking/ConnectionManager.js';
import { RoomManager } from '../rooms/RoomManager.js';
import { Simulation } from '../simulation/Simulation.js';

const DEFAULT_PORT = 3_000;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 16 * 1_024;

export class GameServer {
  private readonly roomManager = new RoomManager();
  private readonly connectionManager = new ConnectionManager(this.roomManager);
  private readonly simulation = new Simulation((deltaSeconds, tick) => {
    this.roomManager.update(deltaSeconds, tick);
    if (tick % TICKS_PER_NETWORK_UPDATE === 0) {
      this.connectionManager.broadcast({ type: 'server_tick', tick });
    }
    if (tick % TICKS_PER_SNAPSHOT === 0) {
      this.roomManager.forEachRoom((room) => {
        this.connectionManager.broadcastToRoom(room, {
          type: 'world_snapshot',
          serverTick: tick,
          vehicles: room.createVehicleSnapshot(),
          convoy: room.createConvoySnapshot(),
          gameState: room.createGameStateSnapshot(),
        });
      });
    }
  });
  private webSocketServer: WebSocketServer | null = null;

  public constructor(private readonly port = DEFAULT_PORT) {}

  public async start(): Promise<void> {
    if (this.webSocketServer !== null) {
      return;
    }

    await this.simulation.initialize();
    this.webSocketServer = new WebSocketServer({
      port: this.port,
      maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
    });
    this.webSocketServer.on('connection', (socket) => {
      this.connectionManager.handleConnection(socket);
    });
    this.webSocketServer.on('error', (error) => {
      console.error('[server] WebSocket server error:', error);
    });

    this.simulation.start();
    console.info(`[server] WebSocket listening on ws://localhost:${this.port}`);
    console.info('[server] authoritative simulation running at 60 Hz');
  }

  public async stop(): Promise<void> {
    this.simulation.stop();
    const server = this.webSocketServer;
    this.webSocketServer = null;
    if (server === null) {
      return;
    }

    for (const client of server.clients) {
      client.close(1001, 'Server shutting down');
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.roomManager.dispose();
  }
}
