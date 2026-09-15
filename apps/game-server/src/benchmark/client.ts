import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import WebSocket from 'ws';
import {
  BENCHMARK_INTENTS,
  PROTOCOL_VERSION,
  type EventEnvelope,
  type IntentAck,
  type TransportKind,
} from '@bb/protocol';

/**
 * Benchmark client — DEVELOPMENT ONLY.
 *
 * One interface, two implementations, so the synthetic runner drives Socket.IO
 * and raw WebSockets through IDENTICAL scenario code. If the runner had two
 * code paths, any difference it reported could be an artefact of the runner
 * rather than the transport.
 */
export interface BenchmarkClient {
  readonly kind: TransportKind;
  readonly benchmarkClientId: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  submit(type: string, payload: unknown, intentId?: string): Promise<IntentAck>;
  onEvent(handler: (event: EventEnvelope) => void): void;
  /** Events received, in arrival order. Used to detect ordering faults. */
  receivedEvents(): readonly EventEnvelope[];
}

export interface ClientOptions {
  readonly host: string;
  readonly port: number;
  readonly benchmarkClientId: string;
  readonly isHost: boolean;
  readonly label?: string;
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------

export class SocketIOBenchmarkClient implements BenchmarkClient {
  readonly kind = 'socketio' as const;
  readonly benchmarkClientId: string;

  readonly #options: ClientOptions;
  readonly #events: EventEnvelope[] = [];
  #socket: Socket | null = null;
  #eventHandler: ((event: EventEnvelope) => void) | null = null;

  constructor(options: ClientOptions) {
    this.#options = options;
    this.benchmarkClientId = options.benchmarkClientId;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = io(`http://${this.#options.host}:${this.#options.port}`, {
        path: '/benchmark/socketio',
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
      });
      this.#socket = socket;

      socket.on('event', (event: EventEnvelope) => {
        this.#events.push(event);
        this.#eventHandler?.(event);
      });

      socket.on('connect', () => {
        void this.#hello().then(() => resolve(), reject);
      });
      socket.on('connect_error', reject);
    });
  }

  async #hello(): Promise<void> {
    await this.submit(BENCHMARK_INTENTS.HELLO, {
      benchmarkClientId: this.benchmarkClientId,
      isHost: this.#options.isHost,
      label: this.#options.label ?? this.benchmarkClientId,
    });
  }

  disconnect(): Promise<void> {
    this.#socket?.disconnect();
    this.#socket = null;
    return Promise.resolve();
  }

  submit(type: string, payload: unknown, intentId?: string): Promise<IntentAck> {
    const socket = this.#socket;
    if (socket === null) return Promise.reject(new Error('not connected'));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ack timeout for ${type}`)), 10_000);
      socket.emit(
        'intent',
        {
          protocolVersion: PROTOCOL_VERSION,
          intentId: intentId ?? randomUUID(),
          roomId: 'benchmark',
          type,
          payload,
        },
        (ack: IntentAck) => {
          clearTimeout(timer);
          resolve(ack);
        },
      );
    });
  }

  onEvent(handler: (event: EventEnvelope) => void): void {
    this.#eventHandler = handler;
  }

  receivedEvents(): readonly EventEnvelope[] {
    return [...this.#events];
  }
}

// ---------------------------------------------------------------------------
// Raw WebSocket
// ---------------------------------------------------------------------------

export class WebSocketBenchmarkClient implements BenchmarkClient {
  readonly kind = 'websocket' as const;
  readonly benchmarkClientId: string;

  readonly #options: ClientOptions;
  readonly #events: EventEnvelope[] = [];
  /** Hand-rolled request/response correlation; Socket.IO gives this for free. */
  readonly #pending = new Map<string, (ack: IntentAck) => void>();
  #socket: WebSocket | null = null;
  #eventHandler: ((event: EventEnvelope) => void) | null = null;

  constructor(options: ClientOptions) {
    this.#options = options;
    this.benchmarkClientId = options.benchmarkClientId;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `ws://${this.#options.host}:${this.#options.port}/benchmark/ws`,
      );
      this.#socket = socket;

      socket.on('message', (data) => this.#onMessage(data.toString()));
      socket.on('error', reject);
      socket.on('open', () => {
        void this.#hello().then(() => resolve(), reject);
      });
    });
  }

  #onMessage(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof frame !== 'object' || frame === null) return;

    const message = frame as Record<string, unknown>;

    if (message['kind'] === 'ack' && typeof message['requestId'] === 'string') {
      const resolver = this.#pending.get(message['requestId']);
      if (resolver !== undefined) {
        this.#pending.delete(message['requestId']);
        resolver(message['ack'] as IntentAck);
      }
      return;
    }

    if (message['kind'] === 'event') {
      const event = message['event'] as EventEnvelope;
      this.#events.push(event);
      this.#eventHandler?.(event);
    }
  }

  async #hello(): Promise<void> {
    await this.submit(BENCHMARK_INTENTS.HELLO, {
      benchmarkClientId: this.benchmarkClientId,
      isHost: this.#options.isHost,
      label: this.#options.label ?? this.benchmarkClientId,
    });
  }

  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      const socket = this.#socket;
      if (socket === null) {
        resolve();
        return;
      }
      socket.once('close', () => resolve());
      socket.close();
      this.#socket = null;
    });
  }

  submit(type: string, payload: unknown, intentId?: string): Promise<IntentAck> {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('not connected'));
    }

    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`ack timeout for ${type}`));
      }, 10_000);

      this.#pending.set(requestId, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });

      socket.send(
        JSON.stringify({
          kind: 'intent',
          requestId,
          intent: {
            protocolVersion: PROTOCOL_VERSION,
            intentId: intentId ?? randomUUID(),
            roomId: 'benchmark',
            type,
            payload,
          },
        }),
      );
    });
  }

  onEvent(handler: (event: EventEnvelope) => void): void {
    this.#eventHandler = handler;
  }

  receivedEvents(): readonly EventEnvelope[] {
    return [...this.#events];
  }
}

export function createBenchmarkClient(
  kind: TransportKind,
  options: ClientOptions,
): BenchmarkClient {
  return kind === 'socketio'
    ? new SocketIOBenchmarkClient(options)
    : new WebSocketBenchmarkClient(options);
}
