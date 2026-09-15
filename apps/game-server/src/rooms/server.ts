import { randomUUID, randomBytes } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { Logger } from 'pino';
import {
  isIntentEnvelope,
  ok,
  rejection,
  ROOM_INTENTS,
  type EventEnvelope,
  type GameMode,
  type IntentAck,
  type IntentEnvelope,
} from '@bb/protocol';
import { InMemoryRoomStore, type Clock, type Room, type RoomStore } from '@bb/game-rules';
import { ROOM_WS_PATH, WebSocketTransport } from '../transport/websocket.js';
import { buildJoinUrl } from './join-url.js';

/**
 * The production room service.
 *
 * Uses RAW WEBSOCKETS, per D-014. Socket.IO is not imported here at all — it
 * remains benchmark-only, which is what keeps the two systems genuinely
 * separate rather than merely differently named.
 *
 * This layer does routing and delivery. Every decision — whether a join is
 * allowed, who holds Host authority, whether teams may be locked — belongs to
 * the Room model in @bb/game-rules, so that authority stays testable without a
 * socket and cannot be bypassed by reaching the server a different way.
 */

export interface RoomServiceOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly mode: GameMode;
  readonly capacity: number;
  /** Public base URL for join links and QR codes. */
  readonly publicBaseUrl: string;
}

export interface RoomService {
  readonly store: RoomStore;
  readonly transport: WebSocketTransport;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Credential minting. 32 bytes of CSPRNG output, base64url. */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

export function createRoomService(
  httpServer: HttpServer,
  options: RoomServiceOptions,
): RoomService {
  const { logger, clock } = options;

  const store = new InMemoryRoomStore({
    clock,
    mintToken,
    mintId: () => randomUUID(),
    capacity: options.capacity,
  });

  /** connectionId -> the room it belongs to. A connection serves one room. */
  const connectionRooms = new Map<string, Room>();

  const transport = new WebSocketTransport(httpServer, {
    path: ROOM_WS_PATH,
    // Deliberately NO access token: a player scanning a QR code at a party has
    // no shared secret to present. Authority comes from Host and reconnect
    // credentials AFTER connecting, not from who is allowed to open a socket.
    accessToken: null,
    authorize: () => true,
  });

  function deliver(room: Room, events: readonly EventEnvelope[]): void {
    if (events.length === 0) return;
    // Fan out only to connections in this room. Rooms share one server, so
    // broadcasting to every socket would leak one party's roster into another.
    for (const [connectionId, owned] of connectionRooms) {
      if (owned !== room) continue;
      for (const event of events) transport.send(connectionId, event);
    }
  }

  function handleIntent(connectionId: string, intent: IntentEnvelope): IntentAck {
    // CREATE_ROOM is the one intent with no room to look up yet.
    if (intent.type === ROOM_INTENTS.CREATE_ROOM) {
      return createRoom(connectionId);
    }

    const room = resolveRoom(connectionId, intent);
    if (room === undefined) {
      return { ok: false, error: rejection('NOT_FOUND', 'Room not found. Check the code.') };
    }

    // Bind the connection to the room on first contact, so later events and
    // disconnects route correctly.
    connectionRooms.set(connectionId, room);

    const outcome = room.handle(connectionId, intent);

    deliver(room, outcome.broadcast);
    for (const { connectionId: target, event } of outcome.direct) {
      transport.send(target, event);
    }
    for (const stale of outcome.closeConnections) {
      connectionRooms.delete(stale);
      transport.close(stale);
    }

    if (!outcome.ack.ok) return { ok: false, error: outcome.ack.error };

    const payload = outcome.ack.value.payload;
    return {
      ok: true,
      seq: outcome.ack.value.seq,
      ...(payload === undefined ? {} : { snapshot: payload }),
    };
  }

  function resolveRoom(connectionId: string, intent: IntentEnvelope): Room | undefined {
    // A connection already bound to a room stays there. This stops a client
    // reaching into another room by putting a different roomId in an envelope.
    const bound = connectionRooms.get(connectionId);
    if (bound !== undefined) return bound;

    // JOIN_ROOM arrives with a room CODE, since a phone scanning a QR never
    // learns the internal id. Everything else carries the roomId it was given.
    const byCode = readString(intent.payload, 'roomCode');
    if (byCode !== null) {
      const found = store.byCode(byCode);
      if (found !== undefined) return found;
    }

    return store.byId(intent.roomId);
  }

  // The intent is deliberately unused: every property of a new room — its id,
  // its code, its Host credential — is minted by the server, so there is nothing
  // in the client's payload worth reading.
  function createRoom(connectionId: string): IntentAck {
    const created = store.create(options.mode);
    if (created === null) {
      return {
        ok: false,
        error: rejection('INTERNAL_ERROR', 'Could not create a room. Try again.'),
      };
    }

    const { room, hostToken } = created;
    room.attachHost(connectionId);
    connectionRooms.set(connectionId, room);

    logger.info({ roomId: room.roomId, roomCode: room.roomCode }, 'room created');

    const joinUrl = buildJoinUrl(options.publicBaseUrl, room.roomCode);

    // hostToken goes ONLY in this ack, to the creating socket. It is never
    // broadcast and never appears in an event payload.
    return {
      ok: true,
      seq: room.seq,
      snapshot: {
        roomId: room.roomId,
        roomCode: room.roomCode,
        hostToken,
        joinUrl,
        snapshot: room.snapshot(connectionId),
      },
    };
  }

  transport.onConnect((connectionId) => {
    logger.debug({ connectionId }, 'room connection opened');
  });

  transport.onDisconnect((connectionId) => {
    const room = connectionRooms.get(connectionId);
    connectionRooms.delete(connectionId);
    if (room === undefined) return;

    // Membership survives. See Room#onDisconnect — this is the accidental case,
    // and it deliberately preserves the player, their team and their credential.
    const events = room.onDisconnect(connectionId);
    deliver(room, events);
  });

  transport.onIntent((connectionId, intent) => {
    if (!isIntentEnvelope(intent)) {
      return { ok: false, error: rejection('INVALID_REQUEST', 'Malformed intent.') };
    }
    try {
      return handleIntent(connectionId, intent);
    } catch (error) {
      // A fault serving one phone must not take down the party.
      logger.error({ err: error, connectionId, type: intent.type }, 'room intent failed');
      return { ok: false, error: rejection('INTERNAL_ERROR', 'Something went wrong.') };
    }
  });

  return {
    store,
    transport,
    start: () => transport.start(),
    stop: () => transport.stop(),
  };
}

function readString(payload: unknown, field: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export { ok };
