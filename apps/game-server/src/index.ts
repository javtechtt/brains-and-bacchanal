import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createGameServer } from './server.js';

/**
 * Game server entry point.
 *
 * ARCHITECTURE.md §1 — the server is authoritative for room/session state, the
 * BB ledger, timers, cards, Market, Maco Mail, wagers and challenge state.
 * Phase 1 stands up the process and a health endpoint only; that authority is
 * built out from Phase 2 onward.
 */

const config = loadConfig();
const logger = createLogger(config);

if (config.contentSource !== 'test-only') {
  // CONTENT_POLICY.md — normal development uses TEST content only.
  logger.warn(
    { contentSource: config.contentSource },
    'CONTENT_SOURCE is not "test-only". Production content must never be used in development.',
  );
}

const server = createGameServer(config, logger);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  try {
    await server.close();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

server.listen().catch((err: unknown) => {
  logger.error({ err }, 'failed to start game-server');
  process.exit(1);
});
