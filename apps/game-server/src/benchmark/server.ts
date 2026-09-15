import { createServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { Logger } from 'pino';
import { PROTOCOL_VERSION, type RealtimeTransport } from '@bb/protocol';
import { SystemClock, type Clock } from '@bb/game-rules';
import { SocketIOTransport } from '../transport/socketio.js';
import { WebSocketTransport } from '../transport/websocket.js';
import { BenchmarkSession } from './session.js';

/**
 * Benchmark server.
 *
 * DEVELOPMENT ONLY. This is a measuring instrument for Phase 3, not part of the
 * shipped game. It is started by its own entry point (`pnpm benchmark:server`)
 * and is never mounted by the production game server.
 *
 * BOTH transports are attached to ONE BenchmarkSession. That is the whole point
 * of the design: identical state, identical rules, identical metrics, so any
 * difference the benchmark reports belongs to the transport and not to two
 * divergent implementations.
 */
export interface BenchmarkServer {
  readonly httpServer: Server;
  readonly session: BenchmarkSession;
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
  lanUrls(port: number): string[];
}

export function createBenchmarkServer(logger: Logger, clock: Clock = new SystemClock()): BenchmarkServer {
  const session = new BenchmarkSession(clock);

  const httpServer = createServer((req, res) => {
    const url = req.url ?? '/';

    if (req.method === 'GET' && url.startsWith('/health')) {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      });
      res.end(
        JSON.stringify({
          status: 'ok',
          mode: 'benchmark',
          protocolVersion: PROTOCOL_VERSION,
          serverTime: clock.now(),
          clients: session.clientCount(),
          connected: session.connectedClientCount(),
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.startsWith('/benchmark/state')) {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify(session.snapshot()));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });

  const transports: RealtimeTransport[] = [
    new SocketIOTransport(httpServer),
    new WebSocketTransport(httpServer),
  ];

  for (const transport of transports) {
    transport.onConnect((connectionId) => {
      logger.debug({ transport: transport.kind, connectionId }, 'benchmark client connected');
    });

    transport.onDisconnect((connectionId) => {
      const { clientId, events } = session.onDisconnect(connectionId);
      logger.debug(
        { transport: transport.kind, connectionId, clientId },
        'benchmark client disconnected',
      );
      // The disconnect may have produced CLIENT_LEFT and, for an active
      // player, an auto-pause — both must reach every connected client
      // exactly like any Host-initiated action does.
      for (const event of events) transport.broadcast(event);
    });

    transport.onIntent((connectionId, intent) => {
      const { ack, events } = session.handle(connectionId, intent);
      // Events broadcast on the transport that produced them. A real game would
      // fan out across both; for measurement, keeping them separate avoids one
      // transport's load skewing the other's numbers.
      for (const event of events) transport.broadcast(event);
      return ack;
    });
  }

  return {
    httpServer,
    session,

    async listen(port: number, host: string): Promise<void> {
      for (const transport of transports) await transport.start();
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.removeListener('error', reject);
          resolve();
        });
      });
    },

    async close(): Promise<void> {
      for (const transport of transports) await transport.stop();

      // Socket.IO's own close() also closes the HTTP server it was attached to,
      // so by this point the listener may already be gone. Closing an
      // already-closed server yields ERR_SERVER_NOT_RUNNING, which is not a
      // failure here — the goal (nothing listening) is already met.
      await new Promise<void>((resolve, reject) => {
        if (!httpServer.listening) {
          resolve();
          return;
        }
        httpServer.close((err) => {
          if (err !== undefined && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },

    lanUrls(port: number): string[] {
      return lanAddresses().map((ip) => `http://${ip}:${port}`);
    },
  };
}

/**
 * Non-internal IPv4 addresses, so the operator can be shown the URL to open on
 * a phone. See docs/NETWORK_BENCHMARK.md for the firewall note.
 */
export function lanAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}
