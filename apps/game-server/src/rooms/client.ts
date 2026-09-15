import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  NO_ROOM_ID,
  PROTOCOL_VERSION,
  type EventEnvelope,
  type IntentAck,
} from '@bb/protocol';

/**
 * Node-side production room client.
 *
 * Exists so the room protocol can be exercised over a REAL socket in automated
 * tests, rather than only against the in-process model. Phase 3 taught this the
 * hard way: the composite/tsbuildinfo bug, the RSV1 upgrade collision and the
 * MALFORMED_ACK parser fault were all invisible to unit tests and appeared only
 * when something actually connected.
 *
 * Raw WebSocket only, per D-014. It hand-rolls request/response correlation,
 * which is the acknowledged ongoing cost of that decision.
 */
export interface RoomClientOptions {
  readonly url: string;
}

export class RoomClient {
  readonly #url: string;
  readonly #events: EventEnvelope[] = [];
  readonly #pending = new Map<string, (ack: IntentAck) => void>();

  #socket: WebSocket | null = null;
  #eventHandler: ((event: EventEnvelope) => void) | null = null;

  /** Set once this client holds an identity. */
  roomId = '';
  playerId = '';
  reconnectToken = '';
  hostToken = '';

  constructor(options: RoomClientOptions) {
    this.#url = options.url;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.#url);
      this.#socket = socket;

      socket.on('open', () => resolve());
      socket.on('error', reject);

      socket.on('message', (data) => {
        let frame: unknown;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (typeof frame !== 'object' || frame === null) return;
        const record = frame as Record<string, unknown>;

        if (record['kind'] === 'ack') {
          const requestId = record['requestId'];
          if (typeof requestId !== 'string') return;
          const resolver = this.#pending.get(requestId);
          if (resolver === undefined) return;
          this.#pending.delete(requestId);
          resolver(record['ack'] as IntentAck);
          return;
        }

        if (record['kind'] === 'event') {
          const event = record['event'] as EventEnvelope;
          this.#events.push(event);
          this.#eventHandler?.(event);
        }
      });
    });
  }

  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      const socket = this.#socket;
      if (socket === null || socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      // Wait for the close to complete, so a test that disconnects and then
      // asserts server state is not racing the server's own close handler.
      socket.once('close', () => resolve());
      socket.close();
    });
  }

  submit(type: string, payload: unknown = {}, intentId?: string): Promise<IntentAck> {
    return new Promise((resolve, reject) => {
      const socket = this.#socket;
      if (socket === null || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('not connected'));
        return;
      }

      const requestId = randomUUID();
      this.#pending.set(requestId, resolve);

      socket.send(
        JSON.stringify({
          kind: 'intent',
          requestId,
          intent: {
            protocolVersion: PROTOCOL_VERSION,
            intentId: intentId ?? randomUUID(),
            // Before the room is known (CREATE_ROOM, and JOIN_ROOM by code).
            roomId: this.roomId === '' ? NO_ROOM_ID : this.roomId,
            type,
            payload,
          },
        }),
      );

      setTimeout(() => {
        if (this.#pending.delete(requestId)) reject(new Error(`timed out: ${type}`));
      }, 5_000);
    });
  }

  onEvent(handler: (event: EventEnvelope) => void): void {
    this.#eventHandler = handler;
  }

  receivedEvents(): readonly EventEnvelope[] {
    return [...this.#events];
  }

  clearEvents(): void {
    this.#events.length = 0;
  }

  get isOpen(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  /** Wait until a matching event arrives, or reject. Avoids arbitrary sleeps. */
  waitForEvent(type: string, timeoutMs = 3_000): Promise<EventEnvelope> {
    return new Promise((resolve, reject) => {
      const existing = this.#events.find((e) => e.type === type);
      if (existing !== undefined) {
        resolve(existing);
        return;
      }

      const timer = setTimeout(() => reject(new Error(`no ${type} within ${timeoutMs}ms`)), timeoutMs);
      const previous = this.#eventHandler;
      this.#eventHandler = (event) => {
        previous?.(event);
        if (event.type === type) {
          clearTimeout(timer);
          this.#eventHandler = previous;
          resolve(event);
        }
      };
    });
  }
}
