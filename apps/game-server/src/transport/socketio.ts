import { Server as SocketIOServer } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import {
  isIntentEnvelope,
  rejection,
  type ConnectionHandler,
  type ConnectionId,
  type EventEnvelope,
  type IntentAck,
  type IntentHandler,
  type RealtimeTransport,
} from '@bb/protocol';
import { isAuthorized } from '../benchmark/access.js';

/**
 * Socket.IO transport adapter.
 *
 * Implements RealtimeTransport and nothing else. It contains no game rules, no
 * BB, no cards and no buzzer logic — it moves envelopes and reports connection
 * facts. The identical benchmark server drives this and the raw WebSocket
 * adapter, so any measured difference is a property of the transport.
 *
 * Socket.IO's acknowledgement callback maps directly onto IntentAck, which is
 * the one place where it is meaningfully more convenient than raw WebSockets.
 */
export class SocketIOTransport implements RealtimeTransport {
  readonly kind = 'socketio' as const;

  readonly #io: SocketIOServer;
  #intentHandler: IntentHandler | null = null;
  #connectHandler: ConnectionHandler | null = null;
  #disconnectHandler: ConnectionHandler | null = null;

  constructor(httpServer: HttpServer, accessToken: string | null = null) {
    this.#io = new SocketIOServer(httpServer, {
      // Reject unauthorised handshakes before a socket exists. Development-only
      // door lock for public cloud testing — see benchmark/access.ts. Null token
      // means open, which is how LAN testing has always run.
      allowRequest: (req, callback) => {
        callback(null, isAuthorized(req.url, accessToken));
      },
      path: '/benchmark/socketio',
      // Benchmark tooling is development-only and may be opened from a phone
      // on the LAN. See docs/NETWORK_BENCHMARK.md for the safety note.
      cors: { origin: '*' },
      // Measure the transport itself, not Socket.IO's HTTP long-polling
      // fallback. A comparison against raw WebSockets is only meaningful if
      // both are actually running over WebSockets.
      transports: ['websocket'],
    });

    this.#io.on('connection', (socket) => {
      this.#connectHandler?.(socket.id);

      socket.on('intent', (raw: unknown, ack?: (reply: IntentAck) => void) => {
        void this.#handleIntent(socket.id, raw, ack);
      });

      socket.on('disconnect', () => {
        this.#disconnectHandler?.(socket.id);
      });
    });
  }

  async #handleIntent(
    connectionId: ConnectionId,
    raw: unknown,
    ack?: (reply: IntentAck) => void,
  ): Promise<void> {
    // Never trust the shape of anything arriving from a client.
    if (!isIntentEnvelope(raw)) {
      ack?.({
        ok: false,
        error: rejection('INVALID_REQUEST', 'Malformed intent envelope.'),
      });
      return;
    }

    if (this.#intentHandler === null) {
      ack?.({
        ok: false,
        error: rejection('INTERNAL_ERROR', 'Server is not ready.'),
      });
      return;
    }

    const reply = await this.#intentHandler(connectionId, raw);
    ack?.(reply);
  }

  start(): Promise<void> {
    // The Socket.IO server attaches to an already-listening HTTP server, so
    // there is nothing further to open here.
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    await this.#io.close();
  }

  send(connectionId: ConnectionId, event: EventEnvelope): void {
    this.#io.to(connectionId).emit('event', event);
  }

  broadcast(event: EventEnvelope): void {
    this.#io.emit('event', event);
  }

  close(connectionId: ConnectionId): void {
    // Implemented for interface parity. The production room service is raw
    // WebSocket only (D-014), so nothing currently calls this on Socket.IO.
    this.#io.sockets.sockets.get(connectionId)?.disconnect(true);
  }

  onIntent(handler: IntentHandler): void {
    this.#intentHandler = handler;
  }

  onConnect(handler: ConnectionHandler): void {
    this.#connectHandler = handler;
  }

  onDisconnect(handler: ConnectionHandler): void {
    this.#disconnectHandler = handler;
  }

  connections(): readonly ConnectionId[] {
    return [...this.#io.sockets.sockets.keys()];
  }
}
