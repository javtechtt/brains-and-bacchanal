import {
  asSequenceNumber,
  asServerTimestamp,
  type Actor,
  type EventEnvelope,
  type IntentId,
  type RoomId,
  type SequenceNumber,
  PROTOCOL_VERSION,
} from '@bb/protocol';
import type { Clock } from './clock.js';

/**
 * In-memory event history.
 *
 * ARCHITECTURE.md §5 — accepted state changes record a sequence number, server
 * timestamp, actor, type and payload; "Full event sourcing is not required
 * initially." So this is a readable audit trail, not a rebuild-the-world log.
 *
 * CONTENT SAFETY — CLAUDE.md forbids production questions, accepted answers and
 * unrevealed secrets in logs. Callers must not pass such content as a payload;
 * this log stores whatever it is given.
 *
 * Persistence is out of scope. ARCHITECTURE.md §8 recommends PostgreSQL later.
 */
export class EventLog {
  readonly #roomId: RoomId;
  readonly #clock: Clock;
  readonly #events: EventEnvelope[] = [];
  #nextSeq = 1;

  constructor(roomId: RoomId, clock: Clock) {
    this.#roomId = roomId;
    this.#clock = clock;
  }

  /**
   * Append an accepted event, assigning the next sequence number and the
   * server's timestamp.
   *
   * Sequence numbers are monotonic within a room and assigned only here, so
   * they cannot be duplicated or reordered by callers.
   */
  append<TType extends string, TPayload>(
    type: TType,
    actor: Actor,
    payload: TPayload,
    causedBy?: IntentId,
  ): EventEnvelope<TType, TPayload> {
    const event: EventEnvelope<TType, TPayload> = {
      protocolVersion: PROTOCOL_VERSION,
      seq: asSequenceNumber(this.#nextSeq++),
      serverTime: asServerTimestamp(this.#clock.now()),
      roomId: this.#roomId,
      actor,
      type,
      payload,
      ...(causedBy === undefined ? {} : { causedBy }),
    };

    this.#events.push(event);
    return event;
  }

  /**
   * Build a one-off notice addressed to a single connection.
   *
   * It does NOT consume a sequence number and does NOT enter history.
   *
   * That matters for the meaning of the sequence: a number is issued only for an
   * accepted change to shared room state, so a gap continues to mean "you missed
   * a state change". A notice like CONNECTION_SUPERSEDED is neither — it is a
   * courtesy to one displaced socket about to be closed, invisible to and
   * irrelevant for every other client. Numbering it would create a gap in every
   * other client's stream describing something that never changed the room.
   *
   * It reuses the current sequence number so the recipient can still place the
   * notice against the state it already has.
   */
  buildTransient<TType extends string, TPayload>(
    type: TType,
    actor: Actor,
    payload: TPayload,
  ): EventEnvelope<TType, TPayload> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      seq: this.latestSeq(),
      serverTime: asServerTimestamp(this.#clock.now()),
      roomId: this.#roomId,
      actor,
      type,
      payload,
    };
  }

  /** All events in sequence order. */
  all(): readonly EventEnvelope[] {
    return [...this.#events];
  }

  /**
   * Events after `seq`, in order.
   *
   * A reconnecting client that knows its last sequence number catches up with
   * these instead of a full snapshot.
   */
  since(seq: SequenceNumber): readonly EventEnvelope[] {
    return this.#events.filter((event) => event.seq > seq);
  }

  /** The highest sequence number assigned, or 0 if none. */
  latestSeq(): SequenceNumber {
    return asSequenceNumber(this.#nextSeq - 1);
  }

  get size(): number {
    return this.#events.length;
  }
}
