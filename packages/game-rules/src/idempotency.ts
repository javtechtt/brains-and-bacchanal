import type { IntentId, SequenceNumber } from '@bb/protocol';

/**
 * Intent deduplication.
 *
 * CLAUDE.md — "State-changing client requests should use intent/idempotency IDs."
 *
 * Why this matters in practice: phones on weak Wi-Fi retry. A player who taps
 * "buy" and sees nothing happen taps again. Without deduplication the team
 * spends BB twice for one purchase. The retry must be recognised as the SAME
 * request and answered with the original outcome.
 *
 * ARCHITECTURE.md §8 defers persistence, so this is in-memory and per-room. The
 * roadmap explicitly says database-backed idempotency is not needed yet.
 */
export class IntentRegistry {
  /** intentId -> the sequence number of the event the first attempt produced. */
  readonly #seen = new Map<string, SequenceNumber>();

  /** Whether this intent has already been accepted. */
  has(intentId: IntentId): boolean {
    return this.#seen.has(intentId);
  }

  /**
   * The sequence number produced by the original attempt, or undefined if this
   * intent is new. A duplicate submission is answered with this rather than
   * being applied again.
   */
  resultOf(intentId: IntentId): SequenceNumber | undefined {
    return this.#seen.get(intentId);
  }

  /** Record an accepted intent and the event it produced. */
  record(intentId: IntentId, seq: SequenceNumber): void {
    this.#seen.set(intentId, seq);
  }

  get size(): number {
    return this.#seen.size;
  }
}
