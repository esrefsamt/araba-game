import { GameServer } from './server/GameServer.js';
import { serverLogger } from './server/ServerLogger.js';

let server: GameServer | null = null;
let shutdownTask: Promise<void> | null = null;

function shutdown(reason: string, fatal = false): Promise<void> {
  if (fatal) process.exitCode = 1;
  shutdownTask ??= (async () => {
    serverLogger.info(`[server] received ${reason}; shutting down`);
    const deadline = setTimeout(() => {
      serverLogger.error('[server] shutdown deadline exceeded');
      process.exit(1);
    }, 31000);
    deadline.unref();
    try {
      await server?.stop();
      if (!fatal && process.exitCode !== 1) process.exitCode = 0;
      serverLogger.info('[server] shutdown complete');
    } catch (error: unknown) {
      serverLogger.error('[server] shutdown failed:', error);
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
      if (fatal) process.exit(1);
    }
  })();
  return shutdownTask;
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.once('uncaughtException', (error: Error) => {
  serverLogger.error('[server] fatal uncaught exception:', error);
  void shutdown('uncaughtException', true);
});
process.once('unhandledRejection', (error: unknown) => {
  serverLogger.error('[server] fatal unhandled rejection:', error);
  void shutdown('unhandledRejection', true);
});

try {
  server = new GameServer();
  await server.start();
} catch (error: unknown) {
  serverLogger.error('[server] failed to start:', error);
  await shutdown('startup failure', true);
}
