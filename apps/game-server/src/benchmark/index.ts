import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createBenchmarkServer } from './server.js';

/**
 * Benchmark server entry point — DEVELOPMENT ONLY.
 *
 * Deliberately separate from the game server's entry point so benchmark
 * tooling can never be started by the production process.
 */

const config = loadConfig();
const logger = createLogger(config);
const port = Number(process.env['BENCHMARK_PORT'] ?? 4500);

const server = createBenchmarkServer(logger);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'benchmark server shutting down');
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

server
  .listen(port, '0.0.0.0')
  .then(() => {
    const lan = server.lanUrls(port);

    // Printed plainly so the operator can read the URL off the terminal and
    // type it into a phone without needing to know anything about the code.
    console.log('');
    console.log('  Brains & Bacchanal — BENCHMARK SERVER (development only)');
    console.log('  ------------------------------------------------------');
    console.log(`  Local:      http://localhost:${port}/health`);
    for (const url of lan) {
      console.log(`  On LAN:     ${url}/health`);
    }
    console.log('');
    console.log('  Open the benchmark pages from the web app:');
    console.log('    Host:     http://<this-machine>:3000/benchmark/host');
    console.log('    Player:   http://<this-machine>:3000/benchmark/player');
    console.log('');
    if (lan.length === 0) {
      console.log('  No LAN address detected. Phones will not be able to connect.');
      console.log('');
    }

    logger.info({ port, lan }, 'benchmark server listening');
  })
  .catch((err: unknown) => {
    logger.error({ err }, 'failed to start benchmark server');
    process.exit(1);
  });
