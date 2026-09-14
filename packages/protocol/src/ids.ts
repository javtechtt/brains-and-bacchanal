/**
 * Branded identifier types.
 *
 * These are compile-time only and erase to plain strings/numbers at runtime, so
 * they cross the wire and the eventual C# boundary as ordinary values.
 *
 * The branding exists because the server is authoritative for room, team and
 * player state, and passing a TeamId where a PlayerId belongs is exactly the
 * kind of mistake that would corrupt that authority silently.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RoomId = Brand<string, 'RoomId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type PlayerId = Brand<string, 'PlayerId'>;
export type TeamId = Brand<string, 'TeamId'>;
export type ChallengeId = Brand<string, 'ChallengeId'>;

/**
 * Idempotency key for a state-changing client intent.
 *
 * CLAUDE.md — "State-changing client requests should use intent/idempotency IDs."
 * ARCHITECTURE.md §10 — "use idempotency IDs".
 *
 * A retried intent carrying the same IntentId must not apply its effect twice.
 * Phone connections drop; a player tapping "buy" twice because the first
 * response was slow must not spend BB twice.
 */
export type IntentId = Brand<string, 'IntentId'>;

/**
 * Monotonically increasing per-room sequence number, assigned by the server.
 *
 * ARCHITECTURE.md §5 — accepted state changes record a sequence number.
 * A gap tells a client it missed an event and should request a snapshot.
 */
export type SequenceNumber = Brand<number, 'SequenceNumber'>;

/**
 * Server-assigned epoch milliseconds.
 *
 * ARCHITECTURE.md §6 — "Never trust a client device's claimed time as the
 * deciding time." Only the server mints these.
 */
export type ServerTimestamp = Brand<number, 'ServerTimestamp'>;

export const asRoomId = (value: string): RoomId => value as RoomId;
export const asSessionId = (value: string): SessionId => value as SessionId;
export const asPlayerId = (value: string): PlayerId => value as PlayerId;
export const asTeamId = (value: string): TeamId => value as TeamId;
export const asChallengeId = (value: string): ChallengeId => value as ChallengeId;
export const asIntentId = (value: string): IntentId => value as IntentId;
export const asSequenceNumber = (value: number): SequenceNumber => value as SequenceNumber;
export const asServerTimestamp = (value: number): ServerTimestamp => value as ServerTimestamp;
