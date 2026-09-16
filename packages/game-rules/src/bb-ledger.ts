import {
  asServerTimestamp,
  type BbChangeReason,
  type BbLedgerEntry,
  type ChallengeId,
  type SequenceNumber,
  type TeamId,
} from '@bb/protocol';
import { BB_FLOOR, clampBb, STARTING_BB } from './bb.js';
import type { Clock } from './clock.js';

/**
 * The authoritative BB ledger.
 *
 * GAME_RULES_LOCKED.md §1 — BB is "both spendable currency and final score",
 * every team begins with 1,000, and "BB cannot go below 0."
 *
 * WHY A LEDGER AND NOT A NUMBER: a balance alone cannot answer the question a
 * Host will actually be asked at a party — "how did we get 300?" Every change
 * records what was requested, what was applied, what it produced and why, so a
 * disputed score can be explained from the record rather than from memory.
 *
 * THE FLOOR LIVES HERE, ONCE. Phase 5 spec §3 is explicit that floor-at-zero
 * must not be scattered through future round code. Deducting 500 from 300
 * leaves 0 and records that only 300 actually moved — the difference between
 * `delta` and `applied` is what makes a clamped deduction visible instead of
 * silent.
 *
 * Every later system — Market purchases, Maco Mail money cards, Family Feud
 * wagers, Host Deals, round awards — must move BB through this class rather
 * than assigning a balance. None of those exist yet, and this file does not
 * anticipate their amounts, prices or multipliers.
 *
 * Pure except for the injected Clock: no I/O, no transport, no Date.now().
 */

export interface BbChangeRequest {
  readonly teamId: TeamId;
  /** Requested amount. Negative deducts. */
  readonly delta: number;
  readonly reason: BbChangeReason;
  readonly challengeId?: ChallengeId | null;
  readonly note?: string | null;
}

/** What a change actually did. */
export interface BbChangeOutcome {
  readonly entry: BbLedgerEntry;
  /** True when the floor reduced the deduction. */
  readonly clamped: boolean;
}

export class BbLedger {
  readonly #clock: Clock;
  readonly #balances = new Map<string, number>();
  readonly #entries: BbLedgerEntry[] = [];
  readonly #mintId: () => string;

  constructor(clock: Clock, mintId: () => string) {
    this.#clock = clock;
    this.#mintId = mintId;
  }

  /** Teams that have a balance, in insertion order. */
  teamIds(): readonly TeamId[] {
    return [...this.#balances.keys()] as TeamId[];
  }

  /** Current balance. Zero for a team that was never seeded. */
  balanceOf(teamId: TeamId): number {
    return this.#balances.get(teamId) ?? BB_FLOOR;
  }

  /** Whether this team has been given a starting balance. */
  has(teamId: TeamId): boolean {
    return this.#balances.has(teamId);
  }

  /** Every entry, oldest first. */
  entries(): readonly BbLedgerEntry[] {
    return [...this.#entries];
  }

  /** Entries for one team, oldest first. */
  entriesFor(teamId: TeamId): readonly BbLedgerEntry[] {
    return this.#entries.filter((entry) => entry.teamId === teamId);
  }

  /**
   * Seed a team's starting balance.
   *
   * GAME_RULES_LOCKED.md §1 — "Each team begins with 1,000 BB." Recorded as a
   * ledger entry like any other change, so a team's history starts with the
   * reason its first BB appeared rather than with an unexplained number.
   *
   * Seeding an already-seeded team is refused: it would silently double a
   * balance, and a duplicate START_GAME must never be able to do that.
   */
  seed(teamId: TeamId, amount: number = STARTING_BB): BbChangeOutcome | null {
    if (this.#balances.has(teamId)) return null;
    this.#balances.set(teamId, BB_FLOOR);
    return this.apply({ teamId, delta: amount, reason: 'game_start' });
  }

  /**
   * Apply a change, clamped at the floor.
   *
   * The single mutation point for every balance in the game.
   */
  apply(request: BbChangeRequest): BbChangeOutcome {
    if (!Number.isFinite(request.delta)) {
      throw new RangeError('BB delta must be a finite number');
    }

    const balanceBefore = this.balanceOf(request.teamId);
    // clampBb is the locked rule; `applied` derives from it rather than being
    // computed separately, so the recorded history can never disagree with the
    // balance it produced.
    const balanceAfter = clampBb(balanceBefore + request.delta);
    const applied = balanceAfter - balanceBefore;

    this.#balances.set(request.teamId, balanceAfter);

    const entry: BbLedgerEntry = {
      entryId: this.#mintId(),
      teamId: request.teamId,
      delta: request.delta,
      applied,
      balanceBefore,
      balanceAfter,
      reason: request.reason,
      at: asServerTimestamp(this.#clock.now()),
      // Filled in by attachSeq once the event carrying this change is numbered.
      seq: null,
      challengeId: request.challengeId ?? null,
      note: request.note ?? null,
    };

    this.#entries.push(entry);
    return { entry, clamped: applied !== request.delta };
  }

  /**
   * Attach the sequence number of the event that carried an entry.
   *
   * Done after the fact because the event cannot be built until the change is
   * known, and the sequence number is assigned only when the event is appended.
   * Linking them closes the loop: every ledger entry can be traced to the event
   * clients saw, and every BB_CHANGED event to the entry that explains it.
   */
  attachSeq(entryId: string, seq: SequenceNumber): void {
    const index = this.#entries.findIndex((entry) => entry.entryId === entryId);
    if (index === -1) return;
    const existing = this.#entries[index];
    if (existing === undefined) return;
    this.#entries[index] = { ...existing, seq };
  }

  get size(): number {
    return this.#entries.length;
  }
}
