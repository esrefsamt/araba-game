import { GameServer } from './server/GameServer.js';

const server = new GameServer();

async function shutdown(signal: string): Promise<void> {
  console.info(`[server] received ${signal}; shutting down`);
  try {
    await server.stop();
    process.exitCode = 0;
  } catch (error: unknown) {
    console.error('[server] shutdown failed:', error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

server.start().catch((error: unknown) => {
  console.error('[server] failed to start:', error);
  process.exitCode = 1;
});
