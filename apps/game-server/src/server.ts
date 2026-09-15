import { createServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { PROTOCOL_VERSION, type HealthResponse } from '@bb/protocol';
import { SystemClock, type Clock } from '@bb/game-rules';
import type { Logger } from 'pino';
import type { ServerConfig } from './config.js';
import { createRoomService, type RoomService } from './rooms/server.js';
import { ROOM_WS_PATH } from './transport/websocket.js';

/**
 * The production game server.
 *
 * PHASE 4 SCOPE: /health, room resolution over HTTP, and the authoritative
 * room service on a raw WebSocket (D-014). No gameplay — the server hosts a
 * lobby and stops at a locked set of teams.
 *
 * Socket.IO is deliberately absent from this path. It stays installed for the
 * benchmark tooling, which is separate infrastructure.
 */

export interface GameServer {
  readonly httpServer: Server;
  readonly rooms: RoomService;
  listen(): Promise<void>;
  close(): Promise<void>;
  lanUrls(): string[];
}

export function createGameServer(
  config: ServerConfig,
  logger: Logger,
  clock: Clock = new SystemClock(),
): GameServer {
  const startedAt = clock.now();

  // Where phones should reach the WEB APP. Explicit configuration wins; failing
  // that, the first LAN address, so a local party needs no setup at all.
  const webPort = 3000;
  const detected = lanAddresses()[0];
  const publicBaseUrl =
    config.publicBaseUrl !== ''
      ? config.publicBaseUrl
      : detected === undefined
        ? `http://localhost:${webPort}`
        : `http://${detected}:${webPort}`;

  const httpServer = createServer((req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';

    if (req.method === 'GET' && (path === '/health' || url.startsWith('/health?'))) {
      const body: HealthResponse = {
        status: 'ok',
        protocolVersion: PROTOCOL_VERSION,
        uptimeMs: clock.now() - startedAt,
        serverTime: clock.now(),
      };

      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify(body));
      return;
    }

    // Lets the web app check a room code before opening a socket, so a mistyped
    // code produces a clear message instead of a connection that goes nowhere.
    //
    // It reveals only whether a room exists and whether it is accepting joins.
    // No roster, no player names, no credential — an unauthenticated caller
    // learns nothing about who is in the room.
    if (req.method === 'GET' && path.startsWith('/rooms/')) {
      const code = decodeURIComponent(path.slice('/rooms/'.length));
      const room = rooms.store.byCode(code);

      res.writeHead(room === undefined ? 404 : 200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(
        JSON.stringify(
          room === undefined
            ? { error: 'NOT_FOUND' }
            : {
                roomCode: room.roomCode,
                status: room.status,
                teamsLocked: room.teamsLocked,
                acceptingJoins: room.status === 'OPEN' && !room.teamsLocked,
              },
        ),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });

  const rooms = createRoomService(httpServer, {
    clock,
    logger,
    mode: 'local_party',
    capacity: config.roomCapacity,
    publicBaseUrl,
  });

  return {
    httpServer,
    rooms,

    async listen(): Promise<void> {
      await rooms.start();
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.port, config.host, () => {
          httpServer.removeListener('error', reject);
          logger.info(
            {
              port: config.port,
              host: config.host,
              protocolVersion: PROTOCOL_VERSION,
              roomSocket: ROOM_WS_PATH,
              publicBaseUrl,
              capacity: config.roomCapacity,
            },
            'game-server listening',
          );
          resolve();
        });
      });
    },

    async close(): Promise<void> {
      await rooms.stop();
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

    lanUrls(): string[] {
      return lanAddresses().map((ip) => `http://${ip}:${config.port}`);
    },
  };
}

/**
 * Non-internal IPv4 addresses, best candidate for phones FIRST.
 *
 * Ranking matters more than it looks. A development machine routinely has many
 * IPv4 addresses — this one has eight: Wi-Fi, several Ethernet adapters, a
 * Hyper-V/WSL virtual switch, APIPA leftovers and a Tailscale interface. Taking
 * whichever the OS lists first put a Tailscale address (100.x) into the QR code,
 * which no phone on the house Wi-Fi can reach. The QR would have been generated,
 * displayed, and useless.
 *
 * Order, worst offenders demoted:
 *  - 169.254.x.x: APIPA. Means DHCP failed; never routable.
 *  - 100.64-127.x: CGNAT range, which Tailscale uses. Reachable only by devices
 *    on that same overlay network, not by a guest's phone.
 *  - 172.17-31.x: commonly Docker/WSL/Hyper-V virtual switches.
 *  - 192.168.x.x and 10.x.x.x: ordinary home LANs — what we actually want.
 *
 * This is a heuristic for convenience, not a guarantee. PUBLIC_BASE_URL always
 * wins when set, and the Host can read the URL on screen to check it.
 */
export function lanAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }
  }
  return rankAddresses(found);
}

/**
 * Sort candidate addresses, best first. Pure, so it is testable without
 * depending on whatever interfaces the test machine happens to have.
 */
export function rankAddresses(addresses: readonly string[]): string[] {
  return [...addresses].sort((a, b) => addressRank(a) - addressRank(b));
}

/** Lower is better. See lanAddresses. */
function addressRank(address: string): number {
  if (address.startsWith('169.254.')) return 90; // link-local: DHCP failed
  if (isCarrierGradeNat(address)) return 80; // Tailscale and similar overlays
  if (isLikelyVirtualSwitch(address)) return 70; // Docker / WSL / Hyper-V
  if (address.startsWith('192.168.')) return 10; // ordinary home LAN
  if (address.startsWith('10.')) return 20; // also common on home/office LANs
  return 50;
}

function isCarrierGradeNat(address: string): boolean {
  // 100.64.0.0/10
  const parts = address.split('.');
  if (parts[0] !== '100') return false;
  const second = Number(parts[1]);
  return Number.isInteger(second) && second >= 64 && second <= 127;
}

function isLikelyVirtualSwitch(address: string): boolean {
  // 172.16.0.0/12
  const parts = address.split('.');
  if (parts[0] !== '172') return false;
  const second = Number(parts[1]);
  return Number.isInteger(second) && second >= 16 && second <= 31;
}
