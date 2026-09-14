import { createServer, type Server } from 'node:http';
import { PROTOCOL_VERSION, type HealthResponse } from '@bb/protocol';
import { SystemClock, type Clock } from '@bb/game-rules';
import type { Logger } from 'pino';
import type { ServerConfig } from './config.js';

/**
 * Minimal HTTP server.
 *
 * PHASE 1 SCOPE: a /health endpoint and nothing more.
 *
 * NO REALTIME TRANSPORT IS CHOSEN OR INSTALLED HERE. CLAUDE.md requires a
 * measured comparison between Socket.IO and raw WebSockets before binding, and
 * ARCHITECTURE.md §7 lists what Phase 3 must measure. Neither `socket.io` nor
 * `ws` appears in this app's dependencies, so the choice stays genuinely open.
 */

export interface GameServer {
  readonly httpServer: Server;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createGameServer(
  config: ServerConfig,
  logger: Logger,
  clock: Clock = new SystemClock(),
): GameServer {
  const startedAt = clock.now();

  const httpServer = createServer((req, res) => {
    const url = req.url ?? '/';

    if (req.method === 'GET' && (url === '/health' || url.startsWith('/health?'))) {
      const body: HealthResponse = {
        status: 'ok',
        protocolVersion: PROTOCOL_VERSION,
        uptimeMs: clock.now() - startedAt,
        serverTime: clock.now(),
      };

      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        // Phase 1 convenience so the local web app can read /health during
        // development. Revisit alongside the Phase 3 transport decision.
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify(body));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });

  return {
    httpServer,

    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.port, config.host, () => {
          httpServer.removeListener('error', reject);
          logger.info(
            { port: config.port, host: config.host, protocolVersion: PROTOCOL_VERSION },
            'game-server listening',
          );
          resolve();
        });
      });
    },

    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
