'use client';

import type { EventEnvelope, IntentAck } from '@bb/protocol';

/**
 * Browser benchmark client — DEVELOPMENT ONLY.
 *
 * Mirrors the Node synthetic client so the browser and the runner speak the
 * same protocol. Socket.IO is loaded from its CDN bundle at runtime rather than
 * bundled, keeping the production web app free of a transport dependency while
 * the Phase 3 decision is open.
 *
 * Note the asymmetry this file makes visible: the WebSocket path hand-rolls
 * request/response correlation that Socket.IO provides natively. That cost
 * reappears in every client, and is part of what Phase 3 is measuring.
 */

export type TransportChoice = 'socketio' | 'websocket';

export interface BenchmarkClientEvents {
  onEvent: (event: EventEnvelope) => void;
  onStatus: (status: 'connecting' | 'connected' | 'disconnected') => void;
}

export interface BrowserBenchmarkClient {
  connect(): Promise<void>;
  disconnect(): void;
  submit(type: string, payload: unknown, intentId?: string): Promise<IntentAck>;
  readonly kind: TransportChoice;
}

const PROTOCOL_VERSION = 1;

function uuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Raw WebSocket
// ---------------------------------------------------------------------------

class WsClient implements BrowserBenchmarkClient {
  readonly kind = 'websocket' as const;
  #socket: WebSocket | null = null;
  readonly #pending = new Map<string, (ack: IntentAck) => void>();

  constructor(
    private readonly url: string,
    private readonly handlers: BenchmarkClientEvents,
  ) {}

  connect(): Promise<void> {
    this.handlers.onStatus('connecting');
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${this.url.replace(/^http/, 'ws')}/benchmark/ws`);
      this.#socket = socket;

      socket.onopen = () => {
        this.handlers.onStatus('connected');
        resolve();
      };
      socket.onerror = () => reject(new Error('websocket error'));
      socket.onclose = () => this.handlers.onStatus('disconnected');

      socket.onmessage = (message) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(message.data)) as Record<string, unknown>;
        } catch {
          return;
        }

        if (frame['kind'] === 'ack' && typeof frame['requestId'] === 'string') {
          const resolver = this.#pending.get(frame['requestId']);
          if (resolver) {
            this.#pending.delete(frame['requestId']);
            resolver(frame['ack'] as IntentAck);
          }
          return;
        }
        if (frame['kind'] === 'event') {
          this.handlers.onEvent(frame['event'] as EventEnvelope);
        }
      };
    });
  }

  disconnect(): void {
    this.#socket?.close();
    this.#socket = null;
  }

  submit(type: string, payload: unknown, intentId?: string): Promise<IntentAck> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('not connected'));
    }
    const requestId = uuid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error('ack timeout'));
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
            intentId: intentId ?? uuid(),
            roomId: 'benchmark',
            type,
            payload,
          },
        }),
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Socket.IO (loaded from CDN at runtime)
// ---------------------------------------------------------------------------

interface MinimalSocket {
  on(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, payload: unknown, ack: (reply: IntentAck) => void): void;
  disconnect(): void;
}

declare global {
  interface Window {
    io?: (url: string, options: Record<string, unknown>) => MinimalSocket;
  }
}

const SOCKET_IO_CDN = 'https://cdn.socket.io/4.8.1/socket.io.min.js';

async function loadSocketIo(): Promise<NonNullable<Window['io']>> {
  if (window.io) return window.io;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SOCKET_IO_CDN;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('could not load socket.io from CDN'));
    document.head.appendChild(script);
  });
  if (!window.io) throw new Error('socket.io did not register');
  return window.io;
}

class SocketIoClient implements BrowserBenchmarkClient {
  readonly kind = 'socketio' as const;
  #socket: MinimalSocket | null = null;

  constructor(
    private readonly url: string,
    private readonly handlers: BenchmarkClientEvents,
  ) {}

  async connect(): Promise<void> {
    this.handlers.onStatus('connecting');
    const io = await loadSocketIo();

    await new Promise<void>((resolve, reject) => {
      const socket = io(this.url, {
        path: '/benchmark/socketio',
        transports: ['websocket'],
        reconnection: false,
      });
      this.#socket = socket;

      socket.on('event', (event) => this.handlers.onEvent(event as EventEnvelope));
      socket.on('disconnect', () => this.handlers.onStatus('disconnected'));
      socket.on('connect', () => {
        this.handlers.onStatus('connected');
        resolve();
      });
      socket.on('connect_error', () => reject(new Error('socket.io connect error')));
    });
  }

  disconnect(): void {
    this.#socket?.disconnect();
    this.#socket = null;
  }

  submit(type: string, payload: unknown, intentId?: string): Promise<IntentAck> {
    const socket = this.#socket;
    if (!socket) return Promise.reject(new Error('not connected'));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ack timeout')), 10_000);
      socket.emit(
        'intent',
        {
          protocolVersion: PROTOCOL_VERSION,
          intentId: intentId ?? uuid(),
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
}

export function createBrowserClient(
  kind: TransportChoice,
  url: string,
  handlers: BenchmarkClientEvents,
): BrowserBenchmarkClient {
  return kind === 'socketio'
    ? new SocketIoClient(url, handlers)
    : new WsClient(url, handlers);
}

/**
 * Benchmark identity, persisted so a reload reclaims the same client.
 *
 * NOT the production player system. Phase 4 builds real room codes, QR joining,
 * names, teams and reconnect tokens.
 */
export function benchmarkIdentity(role: 'host' | 'player'): string {
  const key = `bb-benchmark-${role}-id`;
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = `${role}-${uuid().slice(0, 8)}`;
    localStorage.setItem(key, created);
    return created;
  } catch {
    return `${role}-${uuid().slice(0, 8)}`;
  }
}
