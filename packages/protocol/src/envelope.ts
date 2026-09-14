import type { IntentId, PlayerId, RoomId, SequenceNumber, ServerTimestamp, SessionId } from './ids.js';

/**
 * Who performed an action.
 *
 * CLAUDE.md separates Server Authority from Host Authority. The Host rules on
 * subjective matters — whether a spoken answer was valid, who spoke first — but
 * "Host decisions still go through the server so they are recorded." Actor is
 * what makes that record auditable after the fact.
 */
export type ActorKind = 'server' | 'host' | 'player' | 'admin';

export type Actor =
  | { readonly kind: 'server' }
  | { readonly kind: 'host'; readonly sessionId: SessionId }
  | { readonly kind: 'player'; readonly sessionId: SessionId; readonly playerId: PlayerId }
  | { readonly kind: 'admin'; readonly sessionId: SessionId };

export const SERVER_ACTOR: Actor = { kind: 'server' };

/** Whether an actor holds Host authority. Admin is not Host. */
export function isHostActor(actor: Actor): boolean {
  return actor.kind === 'host';
}

/**
 * Client -> server intent.
 *
 * ARCHITECTURE.md §4 — "Clients send intents. Server validates and emits
 * resulting events." A client expresses a desire; it never reports an outcome.
 *
 * Note the absence of a client timestamp field. That is deliberate:
 * ARCHITECTURE.md §6 says a client's claimed time is never the deciding time,
 * so the protocol offers nowhere to put one.
 *
 * Concrete intent types (JOIN_ROOM, PLAY_CARD, BUZZ, HOST_RESUME_GAME, ...)
 * are NOT defined here. Phase 2 provides the envelope; the phases that
 * implement those behaviours define their own types and payloads.
 */
export interface IntentEnvelope<TType extends string = string, TPayload = unknown> {
  readonly protocolVersion: number;
  /** Deduplication key. Replaying the same intentId must not reapply the effect. */
  readonly intentId: IntentId;
  readonly roomId: RoomId;
  /** Present once the sender has a session. Absent on a first join. */
  readonly sessionId?: SessionId;
  readonly type: TType;
  readonly payload: TPayload;
}

/**
 * Server -> client event. An authoritative statement of fact.
 *
 * ARCHITECTURE.md §5 — accepted state changes record sequence number, server
 * timestamp, actor, type and payload. By the time a client sees one of these,
 * the server has already committed the change.
 */
export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  readonly protocolVersion: number;
  /** Per-room monotonic ordering. A gap means the client missed something. */
  readonly seq: SequenceNumber;
  readonly serverTime: ServerTimestamp;
  readonly roomId: RoomId;
  /** Who caused this. `server` for autonomous changes such as a deadline expiring. */
  readonly actor: Actor;
  readonly type: TType;
  readonly payload: TPayload;
  /** The intent that produced this event, when it was client-initiated. */
  readonly causedBy?: IntentId;
}

// ---------------------------------------------------------------------------
// Runtime validation
//
// Types vanish at runtime, and intents arrive from phones over a network. The
// server must not trust the shape of anything a client sends.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Structural validation of an incoming intent envelope.
 *
 * Checks shape only. It does not check protocol version compatibility, whether
 * the room exists, or whether the action is legal — those are separate concerns
 * with their own rejection codes.
 */
export function isIntentEnvelope(value: unknown): value is IntentEnvelope {
  if (!isRecord(value)) return false;
  if (typeof value['protocolVersion'] !== 'number') return false;
  if (!Number.isInteger(value['protocolVersion'])) return false;
  if (!isNonEmptyString(value['intentId'])) return false;
  if (!isNonEmptyString(value['roomId'])) return false;
  if (!isNonEmptyString(value['type'])) return false;
  if (!('payload' in value)) return false;

  const sessionId = value['sessionId'];
  if (sessionId !== undefined && !isNonEmptyString(sessionId)) return false;

  return true;
}

/** Structural validation of an actor. */
export function isActor(value: unknown): value is Actor {
  if (!isRecord(value)) return false;
  const kind = value['kind'];

  if (kind === 'server') return true;
  if (kind === 'host' || kind === 'admin') return isNonEmptyString(value['sessionId']);
  if (kind === 'player') {
    return isNonEmptyString(value['sessionId']) && isNonEmptyString(value['playerId']);
  }
  return false;
}

/** Structural validation of an event envelope. Used by clients and tests. */
export function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (!isRecord(value)) return false;
  if (typeof value['protocolVersion'] !== 'number') return false;
  if (typeof value['seq'] !== 'number' || !Number.isInteger(value['seq'])) return false;
  if (typeof value['serverTime'] !== 'number') return false;
  if (!isNonEmptyString(value['roomId'])) return false;
  if (!isNonEmptyString(value['type'])) return false;
  if (!('payload' in value)) return false;
  if (!isActor(value['actor'])) return false;

  return true;
}
