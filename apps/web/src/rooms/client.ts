'use client';

import {
  NO_ROOM_ID,
  PROTOCOL_VERSION,
  ROOM_INTENTS,
  type EventEnvelope,
  type IntentAck,
  type LobbySnapshot,
} from '@bb/protocol';

/**
 * Browser room client — PRODUCTION.
 *
 * Raw WebSocket only (D-014). No Socket.IO, and no transport selector on any
 * production page: the benchmark's two-transport comparison served Phase 3 and
 * stays in the benchmark pages.
 *
 * Reconnection is the whole point of this file. Phones lock, browsers refresh,
 * Wi-Fi drops mid-party, and a player must come back as the SAME player on the
 * SAME team, never as a duplicate.
 */

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface StoredIdentity {
  readonly roomId: string;
  readonly roomCode: string;
  readonly playerId: string;
  readonly reconnectToken: string;
  readonly displayName: string;
}

export interface RoomClientHandlers {
  onSnapshot: (snapshot: LobbySnapshot) => void;
  onEvent: (event: EventEnvelope) => void;
  onStatus: (status: ConnectionStatus) => void;
  /** Membership ended: removed by the Host, left, or the room closed. */
  onEvicted: (reason: string) => void;
}

function uuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Credential storage
//
// localStorage, keyed by room code, so one phone can hold identities for more
// than one room without them colliding. A credential is a bearer token for a
// party game lobby, not a bank session; the exposure is that someone with
// physical access to an unlocked phone could rejoin as that player, which is
// already true of the phone itself.
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = 'bb.identity.';

export function storeIdentity(identity: StoredIdentity): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${identity.roomCode}`, JSON.stringify(identity));
  } catch {
    // Private browsing, or storage disabled. The player can still play; they
    // just will not survive a refresh. Failing loudly here would be worse.
  }
}

export function loadIdentity(roomCode: string): StoredIdentity | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${roomCode}`);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as StoredIdentity;
    if (typeof parsed.playerId !== 'string' || typeof parsed.reconnectToken !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearIdentity(roomCode: string): void {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${roomCode}`);
  } catch {
    // Nothing to do.
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class BrowserRoomClient {
  readonly #url: string;
  readonly #handlers: RoomClientHandlers;
  readonly #pending = new Map<string, (ack: IntentAck) => void>();

  #socket: WebSocket | null = null;
  #identity: StoredIdentity | null = null;
  #closedByUs = false;
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(serverUrl: string, handlers: RoomClientHandlers) {
    this.#url = `${serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}/room/ws`;
    this.#handlers = handlers;
  }

  get identity(): StoredIdentity | null {
    return this.#identity;
  }

  connect(): Promise<void> {
    this.#closedByUs = false;
    this.#handlers.onStatus(this.#reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.#url);
      this.#socket = socket;

      socket.onopen = () => {
        this.#reconnectAttempts = 0;
        this.#handlers.onStatus('connected');
        resolve();
      };

      socket.onerror = () => {
        reject(new Error('Could not reach the game server.'));
      };

      socket.onmessage = (message: MessageEvent<string>) => {
        this.#receive(message.data);
      };

      socket.onclose = () => {
        this.#handlers.onStatus('disconnected');
        this.#socket = null;
        for (const [, resolvePending] of this.#pending) {
          resolvePending({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Connection lost.' },
          });
        }
        this.#pending.clear();

        if (!this.#closedByUs) this.#scheduleReconnect();
      };
    });
  }

  #receive(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
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
      this.#handlers.onEvent(event);

      // A superseded connection means this tab lost the player to a newer one.
      // Stop reconnecting: racing the other tab would bounce the player between
      // them indefinitely.
      if (event.type === 'CONNECTION_SUPERSEDED') {
        this.#closedByUs = true;
        this.#handlers.onEvicted('This player was opened in another window.');
        return;
      }

      const payload = event.payload as Record<string, unknown> | null;
      if (event.type === 'PLAYER_REMOVED' && payload?.['self'] === true) {
        this.#closedByUs = true;
        if (this.#identity !== null) clearIdentity(this.#identity.roomCode);
        this.#handlers.onEvicted('The Host removed you from this room.');
        return;
      }

      if (event.type === 'ROOM_CLOSED') {
        this.#closedByUs = true;
        this.#handlers.onEvicted('The Host closed this room.');
      }
    }
  }

  /**
   * Reconnect with backoff, re-proving identity each time.
   *
   * Backoff matters on a phone that has genuinely lost signal: hammering the
   * socket drains the battery and achieves nothing. It is capped so that a
   * player who walks back into Wi-Fi is not left waiting minutes.
   */
  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== null) return;
    const delay = Math.min(500 * 2 ** this.#reconnectAttempts, 5_000);
    this.#reconnectAttempts += 1;

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.connect()
        .then(async () => {
          if (this.#identity !== null) await this.resumeIdentity();
        })
        .catch(() => {
          // connect() failing triggers onclose, which schedules the next try.
        });
    }, delay);
  }

  submit(type: string, payload: unknown = {}, intentId?: string): Promise<IntentAck> {
    return new Promise((resolve) => {
      const socket = this.#socket;
      if (socket === null || socket.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Not connected.' } });
        return;
      }

      const requestId = uuid();
      this.#pending.set(requestId, resolve);

      socket.send(
        JSON.stringify({
          kind: 'intent',
          requestId,
          intent: {
            protocolVersion: PROTOCOL_VERSION,
            intentId: intentId ?? uuid(),
            roomId: this.#identity?.roomId ?? NO_ROOM_ID,
            type,
            payload,
          },
        }),
      );

      setTimeout(() => {
        if (this.#pending.delete(requestId)) {
          resolve({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'The server did not reply.' } });
        }
      }, 8_000);
    });
  }

  /** Join as a new player. */
  async join(roomCode: string, displayName: string): Promise<IntentAck> {
    const ack = await this.submit(ROOM_INTENTS.JOIN_ROOM, { roomCode, displayName });
    if (!ack.ok) return ack;

    const payload = ack.snapshot as {
      playerId: string;
      displayName: string;
      reconnectToken: string;
      snapshot: LobbySnapshot;
    };

    this.#identity = {
      roomId: payload.snapshot.room.roomId,
      roomCode: payload.snapshot.room.roomCode,
      playerId: payload.playerId,
      reconnectToken: payload.reconnectToken,
      displayName: payload.displayName,
    };
    storeIdentity(this.#identity);
    this.#handlers.onSnapshot(payload.snapshot);
    return ack;
  }

  /** Re-prove a stored identity. Used on refresh, reopen and auto-reconnect. */
  async resumeIdentity(identity: StoredIdentity | null = this.#identity): Promise<IntentAck> {
    if (identity === null) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'No saved player.' } };
    }
    this.#identity = identity;

    const ack = await this.submit(ROOM_INTENTS.RECONNECT_PLAYER, {
      playerId: identity.playerId,
      reconnectToken: identity.reconnectToken,
    });

    if (!ack.ok) {
      // The credential is dead — left, removed, or the server restarted and
      // lost every room. Clearing it stops an endless retry loop and lets the
      // page offer a fresh join instead.
      clearIdentity(identity.roomCode);
      this.#identity = null;
      return ack;
    }

    const payload = ack.snapshot as { snapshot: LobbySnapshot };
    this.#handlers.onSnapshot(payload.snapshot);
    return ack;
  }

  async refreshSnapshot(): Promise<void> {
    const ack = await this.submit(ROOM_INTENTS.REQUEST_LOBBY_SNAPSHOT);
    if (ack.ok && ack.snapshot !== undefined) {
      this.#handlers.onSnapshot(ack.snapshot as LobbySnapshot);
    }
  }

  async leave(): Promise<IntentAck> {
    const ack = await this.submit(ROOM_INTENTS.LEAVE_ROOM);
    if (ack.ok && this.#identity !== null) {
      clearIdentity(this.#identity.roomCode);
      this.#identity = null;
    }
    return ack;
  }

  disconnect(): void {
    this.#closedByUs = true;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.close();
    this.#socket = null;
  }
}
