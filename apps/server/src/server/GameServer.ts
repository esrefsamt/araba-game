import { TICKS_PER_NETWORK_UPDATE, TICKS_PER_SNAPSHOT } from '@trailer-arena/shared';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

import { ConnectionManager } from '../networking/ConnectionManager.js';
import { RoomManager } from '../rooms/RoomManager.js';
import { Simulation } from '../simulation/Simulation.js';
import {
  loadServerConfig,
  MAX_WEBSOCKET_PAYLOAD_BYTES,
  type ServerConfig,
} from './ServerConfig.js';
import { isOriginAllowed } from './OriginPolicy.js';
import { configureServerLogger, serverLogger } from './ServerLogger.js';

export class GameServer {
  private readonly roomManager = new RoomManager();
  private readonly connectionManager: ConnectionManager;
  private readonly simulation = new Simulation((deltaSeconds, tick) => {
    this.connectionManager.maintainConnections();
    this.roomManager.update(deltaSeconds, tick);
    this.roomManager.forEachRoom((room) => {
      for (const event of room.drainGameplayEvents()) {
        this.connectionManager.broadcastToRoom(room, event);
      }
    });
    if (tick % TICKS_PER_NETWORK_UPDATE === 0) {
      this.connectionManager.broadcast({ type: 'server_tick', tick });
    }
    if (tick % TICKS_PER_SNAPSHOT === 0) {
      this.roomManager.forEachRoom((room) => {
        this.connectionManager.broadcastToRoom(room, room.createWorldSnapshot());
      });
    }
  });
  private webSocketServer: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private acceptingConnections = false;
  private stopping: Promise<void> | null = null;
  private readonly config: ServerConfig;

  public constructor(options: Partial<ServerConfig> | number = {}) {
    this.config = {
      ...loadServerConfig(),
      ...(typeof options === 'number' ? { port: options } : options),
    };
    this.connectionManager = new ConnectionManager(this.roomManager, this.config);
    configureServerLogger(this.config.logLevel);
  }

  public get address(): AddressInfo | null {
    const address = this.httpServer?.address();
    return typeof address === 'object' ? (address ?? null) : null;
  }

  public async start(): Promise<void> {
    if (this.webSocketServer !== null || this.stopping !== null) {
      return;
    }

    await this.simulation.initialize();
    if (this.stopping !== null) return;
    this.httpServer = createServer((request, response) => {
      if (
        request.method === 'GET' &&
        (request.url === '/health' || request.url === '/ready')
      ) {
        response.writeHead(this.acceptingConnections ? 200 : 503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        response.end(
          JSON.stringify({
            status: this.acceptingConnections ? 'ok' : 'stopping',
            rooms: this.roomManager.roomCount,
            players: this.roomManager.playerCount,
            uptime: Math.floor(process.uptime()),
          }),
        );
      } else {
        response.writeHead(404);
        response.end('Not found');
      }
    });
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
    this.httpServer.on('upgrade', (request, socket, head) => {
      const websocketServer = this.webSocketServer;
      if (!this.acceptingConnections || websocketServer === null) {
        socket.destroy();
        return;
      }
      if (!isOriginAllowed(request.headers.origin, this.config)) {
        socket.end(
          'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (client) =>
        websocketServer.emit('connection', client, request),
      );
    });
    this.webSocketServer.on('connection', (socket) => {
      this.connectionManager.handleConnection(socket);
    });
    this.webSocketServer.on('error', (error) => {
      serverLogger.error('[server] WebSocket server error:', error);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const httpServer = this.httpServer!;
        httpServer.once('error', reject);
        httpServer.listen(this.config.port, this.config.host, () => {
          if (this.stopping !== null) httpServer.close();
          httpServer.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
    if (this.stopping !== null) return;
    this.acceptingConnections = true;
    this.simulation.start();
    serverLogger.info(
      `[server] HTTP/WebSocket listening on ${this.config.host}:${this.address?.port}`,
    );
    serverLogger.info('[server] authoritative simulation running at 60 Hz');
  }

  public stop(): Promise<void> {
    this.stopping ??= this.stopOnce();
    return this.stopping;
  }

  private async stopOnce(): Promise<void> {
    this.acceptingConnections = false;
    this.simulation.stop();
    this.connectionManager.shutdown();
    const server = this.webSocketServer;
    this.webSocketServer = null;
    const httpServer = this.httpServer;
    this.httpServer = null;
    if (server === null) {
      this.roomManager.dispose();
      return;
    }

    for (const client of server.clients) {
      client.close(1001, 'Server shutting down');
    }
    const timeout = setTimeout(() => {
      for (const client of server.clients) client.terminate();
      httpServer?.closeAllConnections();
    }, this.config.shutdownTimeoutMs);
    try {
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => {
          if (httpServer === null) resolve();
          else httpServer.close(() => resolve());
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      this.roomManager.dispose();
    }
  }
}
