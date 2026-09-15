import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
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

/**
 * Raw WebSocket transport adapter.
 *
 * Implements the SAME RealtimeTransport interface as the Socket.IO adapter and
 * speaks the SAME application protocol, so the two are genuinely comparable.
 * No game rules live here.
 *
 * IMPLEMENTATION COST WORTH NOTING FOR THE COMPARISON: raw WebSockets have no
 * built-in request/response, so this adapter defines a small framing layer —
 * every message carries a `kind` and an intent carries a `requestId` the server
 * echoes on the reply. Socket.IO provides that for free via ack callbacks.
 * Roughly 40 lines here exist purely to replace that one feature, and the same
 * work reappears in every client (browser, synthetic runner, and eventually
 * Unity). That is a real maintenance input to the Phase 3 decision, not a
 * detail.
 */

/** Upgrade path this adapter claims. Socket.IO uses /benchmark/socketio. */
const WS_PATH = '/benchmark/ws';

/** Frame kinds on the wire. */
const FRAME = {
  INTENT: 'intent',
  ACK: 'ack',
  EVENT: 'event',
} as const;

interface IntentFrame {
  readonly kind: typeof FRAME.INTENT;
  readonly requestId: string;
  readonly intent: unknown;
}

export class WebSocketTransport implements RealtimeTransport {
  readonly kind = 'websocket' as const;

  readonly #wss: WebSocketServer;
  readonly #sockets = new Map<ConnectionId, WebSocket>();
  #intentHandler: IntentHandler | null = null;
  #connectHandler: ConnectionHandler | null = null;
  #disconnectHandler: ConnectionHandler | null = null;

  constructor(httpServer: HttpServer) {
    // `noServer` rather than `{ server }`: the benchmark process attaches BOTH
    // this adapter and the Socket.IO adapter to one HTTP server, and Socket.IO
    // installs its own `upgrade` listener. Letting `ws` also claim every
    // upgrade makes the two fight over the same handshake — which shows up as
    // "Invalid WebSocket frame: RSV1 must be clear" when `ws` answers a
    // Socket.IO handshake. Routing by path here keeps them cleanly separated.
    this.#wss = new WebSocketServer({ noServer: true });

    // `prependListener`, not `on`. Socket.IO attaches its own `upgrade` handler
    // and destroys the socket for any path it does not recognise, so whichever
    // handler runs first wins outright. Going first lets this adapter claim
    // exactly its own path and leave every other upgrade untouched for
    // Socket.IO, which is what allows both transports to share one HTTP server
    // and therefore be measured under identical conditions.
    httpServer.prependListener('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0];
      if (path !== WS_PATH) return; // Not ours — leave it for Socket.IO.

      this.#wss.handleUpgrade(req, socket, head, (ws) => {
        this.#wss.emit('connection', ws, req);
      });
    });

    this.#wss.on('connection', (socket) => {
      // Socket.IO assigns connection ids; with raw ws we mint our own.
      const connectionId = randomUUID();
      this.#sockets.set(connectionId, socket);
      this.#connectHandler?.(connectionId);

      socket.on('message', (data) => {
        void this.#handleMessage(connectionId, socket, data.toString());
      });

      socket.on('close', () => {
        this.#sockets.delete(connectionId);
        this.#disconnectHandler?.(connectionId);
      });

      // A transport-level error must not take the process down.
      socket.on('error', () => {
        this.#sockets.delete(connectionId);
        this.#disconnectHandler?.(connectionId);
      });
    });
  }

  async #handleMessage(
    connectionId: ConnectionId,
    socket: WebSocket,
    raw: string,
  ): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      // Malformed JSON has no requestId to reply to, so it is dropped.
      return;
    }

    if (!isIntentFrame(frame)) return;

    if (!isIntentEnvelope(frame.intent)) {
      this.#reply(socket, frame.requestId, {
        ok: false,
        error: rejection('INVALID_REQUEST', 'Malformed intent envelope.'),
      });
      return;
    }

    if (this.#intentHandler === null) {
      this.#reply(socket, frame.requestId, {
        ok: false,
        error: rejection('INTERNAL_ERROR', 'Server is not ready.'),
      });
      return;
    }

    const ack = await this.#intentHandler(connectionId, frame.intent);
    this.#reply(socket, frame.requestId, ack);
  }

  #reply(socket: WebSocket, requestId: string, ack: IntentAck): void {
    this.#sendRaw(socket, { kind: FRAME.ACK, requestId, ack });
  }

  #sendRaw(socket: WebSocket, payload: unknown): void {
    // READY_STATE_OPEN === 1. Writing to a closing socket throws.
    if (socket.readyState !== 1) return;
    socket.send(JSON.stringify(payload));
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const socket of this.#sockets.values()) socket.close();
      this.#sockets.clear();
      this.#wss.close(() => resolve());
    });
  }

  send(connectionId: ConnectionId, event: EventEnvelope): void {
    const socket = this.#sockets.get(connectionId);
    if (socket === undefined) return;
    this.#sendRaw(socket, { kind: FRAME.EVENT, event });
  }

  broadcast(event: EventEnvelope): void {
    const payload = JSON.stringify({ kind: FRAME.EVENT, event });
    for (const socket of this.#sockets.values()) {
      if (socket.readyState === 1) socket.send(payload);
    }
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
    return [...this.#sockets.keys()];
  }
}

function isIntentFrame(value: unknown): value is IntentFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame['kind'] === FRAME.INTENT &&
    typeof frame['requestId'] === 'string' &&
    'intent' in frame
  );
}
