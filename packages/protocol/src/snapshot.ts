import type { SequenceNumber, ServerTimestamp } from './ids.js';
import type { ChallengeState, PlayerState, RoomState, TeamState } from './models.js';

/**
 * Authoritative state snapshot.
 *
 * ARCHITECTURE.md §1 lists "reconnect snapshots" as a server responsibility.
 * A client that has just connected, or that detected a sequence-number gap,
 * replaces its local state with one of these.
 *
 * CONTENT SAFETY — CLAUDE.md and CONTENT_POLICY.md: a snapshot must never carry
 * unrevealed question text, accepted answers or sealed board labels. Note what
 * is absent below: ChallengeState holds a `configRef`, not content. "Player
 * browsers must never receive future/unrevealed answer payloads."
 *
 * Phase 2 defines the shape only. Delivering it over a wire is Phase 3+.
 */
export interface StateSnapshot {
  readonly protocolVersion: number;
  /**
   * The sequence number this snapshot reflects. Events with seq <= this are
   * already included; the client applies only later ones.
   */
  readonly seq: SequenceNumber;
  readonly takenAt: ServerTimestamp;
  readonly room: RoomState;
  readonly players: readonly PlayerState[];
  readonly teams: readonly TeamState[];
  /** The challenge in progress, if any. */
  readonly challenge: ChallengeState | null;
}
