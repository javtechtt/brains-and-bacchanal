import {
  asServerTimestamp,
  err,
  ok,
  rejection,
  ROUND2_CARD_CHALLENGE_KIND,
  ROUND2_CHALLENGES,
  ROUND2_CHALLENGE_COUNT,
  ROUND2_ROUND_INDEX,
  type ChallengeId,
  type Rejection,
  type Result,
  type Round2ChallengeDefinition,
  type Round2ChallengeProgress,
  type Round2ChallengeView,
  type Round2StateView,
  type ServerTimestamp,
  type TeamId,
} from '@bb/protocol';
import type { Clock } from './clock.js';

/**
 * Round 2 — "Shake Up Yuhself!" progression. Phase 7A.
 *
 * GAME_RULES_LOCKED.md §12, DECISION_LOG.md D-003.
 *
 * ================== WHAT THIS CLASS IS, AND IS NOT ==================
 * It is a CURSOR over the four locked challenges plus the Host's winner
 * selection. It knows which game is current, which have resolved, who the Host
 * has selected and whether the round is finished.
 *
 * It is NOT a second round-state system (Phase 7A spec §2 forbids one). It owns
 * no phase, no challenge container, no timer, no BB and no card state — those
 * stay with `GameEngine` and the Phase 6 `SharedSystems`, which this class never
 * touches. The engine drives it; it answers questions and records progress.
 *
 * It contains NO PHYSICAL RULE. There is nothing here about bottles, matches,
 * grabbing or bombs, no duration and no scoring — D-003 puts all of that
 * outside the app. The software's entire job in a Round 2 game is: name it,
 * take the Host's winner, pay the configured BB.
 * ====================================================================
 *
 * THE AWARD IS NOT COMPUTED HERE EITHER. This class reports the base reward
 * from configuration; the engine asks `SharedSystems.applyMultiplier` for the
 * final number and moves it through the `BbLedger`. Keeping the multiplier out
 * of here is what stops Round 2 growing its own copy of "multipliers never
 * stack" (§3), which Phase 7A spec §7 explicitly forbids.
 */

/** Mutable per-challenge progress. Never serialised directly. */
interface Round2Slot {
  readonly definition: Round2ChallengeDefinition;
  progress: Round2ChallengeProgress;
  challengeId: ChallengeId | null;
  winningTeamId: TeamId | null;
  awardedBb: number | null;
  doubled: boolean;
  resolvedAt: ServerTimestamp | null;
}

export interface Round2Options {
  readonly clock: Clock;
}

export class Round2 {
  readonly #clock: Clock;

  /** Whether the round has been entered. Nothing works before it has. */
  #active = false;

  /**
   * The four challenges, in the locked order, with their progress.
   *
   * Built from `ROUND2_CHALLENGES` so the order and the rewards come from
   * configuration rather than from this file. Phase 7A spec §3.
   */
  readonly #slots: Round2Slot[] = ROUND2_CHALLENGES.map((definition) => ({
    definition,
    progress: 'not_started',
    challengeId: null,
    winningTeamId: null,
    awardedBb: null,
    doubled: false,
    resolvedAt: null,
  }));

  /**
   * The winner the Host has selected but not yet confirmed.
   *
   * Two-step on purpose — Phase 7A spec §19 asks for a confirmation clear
   * enough to prevent an accidental award, and §14 requires the confirmed
   * result to be final. Selection is cheap and revisable; confirmation pays and
   * locks. Cleared whenever a challenge is prepared or resolved, so a selection
   * can never leak from one game into the next.
   */
  #pendingWinnerTeamId: TeamId | null = null;

  /** Teams taking part. Every team in the game — §16, §17. */
  #participatingTeamIds: readonly TeamId[] = [];

  constructor(options: Round2Options) {
    this.#clock = options.clock;
  }

  get active(): boolean {
    return this.#active;
  }

  /** True once all four challenges have resolved. §18. */
  get complete(): boolean {
    return this.#slots.every((slot) => slot.progress === 'resolved');
  }

  get pendingWinnerTeamId(): TeamId | null {
    return this.#pendingWinnerTeamId;
  }

  get participatingTeamIds(): readonly TeamId[] {
    return this.#participatingTeamIds;
  }

  /**
   * Enter Round 2 with the teams that will take part.
   *
   * ALL TEAMS PARTICIPATE. Phase 7A §16 and §17: two-team and three-team games
   * use the same format, and §17 is explicit that no elimination behaviour may
   * be invented. So this takes the game's teams as they are and records them;
   * there is no seeding, no bracket and no sitting out.
   */
  begin(teamIds: readonly TeamId[]): Result<true> {
    if (this.#active) {
      return err(rejection('WRONG_STATE', 'Round 2 has already started.'));
    }
    if (teamIds.length === 0) {
      return err(rejection('INVALID_REQUEST', 'Round 2 needs participating teams.'));
    }
    this.#active = true;
    this.#participatingTeamIds = [...teamIds];
    return ok(true);
  }

  /** The slot the round is on: the first that has not resolved. */
  #currentSlot(): Round2Slot | null {
    return this.#slots.find((slot) => slot.progress !== 'resolved') ?? null;
  }

  /** 0-based index of the current challenge, or null once complete. */
  get currentIndex(): number | null {
    const slot = this.#currentSlot();
    return slot === null ? null : slot.definition.order;
  }

  /**
   * The next challenge to prepare, with a rejection when there is none.
   *
   * THE ORDER IS ENFORCED BY CONSTRUCTION. There is no way to ask for a
   * specific challenge: the round hands out the first unresolved slot, so a
   * challenge cannot be skipped and an unresolved one cannot be passed over.
   * Phase 7A spec §29 asks for exactly those two guarantees.
   */
  nextToPrepare(): Result<Round2ChallengeDefinition> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    const slot = this.#currentSlot();
    if (slot === null) {
      // §18 and §29 — no fifth physical challenge. The round is over, and what
      // follows it is Round 3, which is not Phase 7A's to start.
      return err(
        rejection('ILLEGAL_ACTION', 'Round 2 is complete. All four challenges have resolved.', {
          resolvedCount: ROUND2_CHALLENGE_COUNT,
        }),
      );
    }
    if (slot.progress === 'in_progress') {
      return err(
        rejection('ILLEGAL_ACTION', 'This Round 2 challenge is already in progress.', {
          challengeType: slot.definition.challengeType,
        }),
      );
    }
    return ok(slot.definition);
  }

  /**
   * Record that the current challenge has been prepared as an engine challenge.
   *
   * Binds the round's slot to the engine's `challengeId`, which is what lets a
   * later winner confirmation prove it is resolving the challenge the round
   * thinks is running rather than a stale one.
   */
  markPrepared(challengeId: ChallengeId): Result<Round2ChallengeDefinition> {
    const next = this.nextToPrepare();
    if (!next.ok) return next;

    const slot = this.#slotFor(next.value.challengeType);
    slot.progress = 'in_progress';
    slot.challengeId = challengeId;
    // A new game starts with no winner selected, whatever happened in the last.
    this.#pendingWinnerTeamId = null;
    return ok(next.value);
  }

  /**
   * The Host selects a winning team — step one. Moves no BB.
   *
   * VALIDATION IS THE POINT (Phase 7A spec §13): the team must exist, must be
   * taking part, and there must actually be a challenge awaiting a result. A
   * raw team id off the wire is never trusted. Whether the CALLER is the Host is
   * checked by the room before this is reached, the same split every Phase 5/6
   * intent uses.
   */
  selectWinner(teamId: TeamId): Result<Round2ChallengeView> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    const slot = this.#currentSlot();
    if (slot === null || slot.progress !== 'in_progress') {
      return err(
        rejection('WRONG_STATE', 'No Round 2 challenge is waiting for a winner.', {
          complete: this.complete,
        }),
      );
    }
    if (!this.#participatingTeamIds.includes(teamId)) {
      return err(
        rejection('NOT_FOUND', 'That team is not taking part in this challenge.', { teamId }),
      );
    }

    // Selecting again REPLACES the selection rather than being refused: the
    // whole reason selection is separate from confirmation is that a Host can
    // correct a misclick before it pays.
    this.#pendingWinnerTeamId = teamId;
    return ok(this.#viewOf(slot));
  }

  /** Clear a selection without resolving. Lets a Host back out entirely. */
  clearSelection(): void {
    this.#pendingWinnerTeamId = null;
  }

  /**
   * Check that a confirmation may proceed, and report what it would pay.
   *
   * SEPARATE FROM APPLYING IT, deliberately. The engine needs the base reward
   * and the winning team BEFORE it asks the shared systems for a multiplier and
   * moves BB through the ledger, and validation must be complete before
   * anything is applied — the same discipline `resolveChallenge` already uses,
   * so a refused confirmation cannot leave a half-paid result.
   */
  prepareConfirmation(input: {
    readonly winningTeamId?: TeamId | null;
  }): Result<{
    readonly definition: Round2ChallengeDefinition;
    readonly challengeId: ChallengeId;
    readonly winningTeamId: TeamId;
    readonly baseRewardBb: number;
  }> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    const slot = this.#currentSlot();
    if (slot === null) {
      return err(
        rejection('WRONG_STATE', 'Round 2 is complete. There is nothing left to resolve.'),
      );
    }
    // §14 — a confirmed result is final; a duplicate must not award again. The
    // idempotency registry catches a RETRIED intent; this catches a second,
    // genuinely distinct attempt, including one from a stale Host socket.
    if (slot.progress !== 'in_progress') {
      return err(
        rejection('WRONG_STATE', 'That Round 2 challenge has not been prepared.', {
          challengeType: slot.definition.challengeType,
          progress: slot.progress,
        }),
      );
    }
    if (slot.challengeId === null) {
      return err(rejection('WRONG_STATE', 'This Round 2 challenge has no engine challenge.'));
    }

    // A confirmation may name the winner explicitly, but it does not have to —
    // confirming what is already selected is the normal flow. What it may NOT
    // do is disagree with the selection silently.
    const winner = input.winningTeamId ?? this.#pendingWinnerTeamId;
    if (winner === null) {
      // §13 — "the production result flow should require one winner before
      // resolution. Do not silently resolve a tie." A confirmation with no
      // winner is refused rather than resolved as a draw, because no locked rule
      // says what a Round 2 tie does.
      return err(
        rejection('ILLEGAL_ACTION', 'Select a winning team before confirming the result.', {
          challengeType: slot.definition.challengeType,
        }),
      );
    }
    if (!this.#participatingTeamIds.includes(winner)) {
      return err(
        rejection('NOT_FOUND', 'That team is not taking part in this challenge.', {
          teamId: winner,
        }),
      );
    }

    return ok({
      definition: slot.definition,
      challengeId: slot.challengeId,
      winningTeamId: winner,
      // THE BASE ONLY — from configuration, never a client's number. §15.
      baseRewardBb: slot.definition.baseRewardBb,
    });
  }

  /**
   * Record a confirmed result. Called by the engine AFTER BB has moved.
   *
   * `awardedBb` is what the ledger actually applied, not what was intended, so
   * the round's record and the ledger can never disagree.
   */
  recordResult(input: {
    readonly winningTeamId: TeamId;
    readonly awardedBb: number;
    readonly doubled: boolean;
  }): Round2ChallengeView {
    const slot = this.#currentSlot();
    /* c8 ignore next 3 -- unreachable: prepareConfirmation has already refused
       every state in which there is no current slot, and the engine calls these
       two in sequence without an intervening await. */
    if (slot === null) {
      throw new Error('recordResult called with no current Round 2 challenge.');
    }

    slot.progress = 'resolved';
    slot.winningTeamId = input.winningTeamId;
    slot.awardedBb = input.awardedBb;
    slot.doubled = input.doubled;
    slot.resolvedAt = asServerTimestamp(this.#clock.now());
    this.#pendingWinnerTeamId = null;

    return this.#viewOf(slot);
  }

  #slotFor(challengeType: string): Round2Slot {
    const slot = this.#slots.find((s) => s.definition.challengeType === challengeType);
    /* c8 ignore next 3 -- unreachable: every caller passes a challengeType that
       came out of this class's own configuration. */
    if (slot === undefined) {
      throw new Error(`Unknown Round 2 challenge: ${challengeType}`);
    }
    return slot;
  }

  #requireActive(): Rejection | null {
    if (!this.#active) {
      return rejection('WRONG_STATE', 'Round 2 has not started.');
    }
    return null;
  }

  #viewOf(slot: Round2Slot): Round2ChallengeView {
    return {
      challengeType: slot.definition.challengeType,
      displayName: slot.definition.displayName,
      order: slot.definition.order,
      baseRewardBb: slot.definition.baseRewardBb,
      progress: slot.progress,
      challengeId: slot.challengeId,
      winningTeamId: slot.winningTeamId,
      awardedBb: slot.awardedBb,
      doubled: slot.doubled,
      resolvedAt: slot.resolvedAt,
    };
  }

  /**
   * The round as clients see it.
   *
   * ONE VIEW FOR BOTH HOST AND PLAYER. Everything here is public — which game
   * is running, who won, what was paid — and a party game puts exactly that on
   * a TV. The secrets Phase 7A §21 protects (hands, hidden purchases,
   * unrevealed Clash responses) live in the Phase 6 views and are not
   * duplicated here, so there is no field on this type capable of leaking one.
   */
  view(): Round2StateView {
    const current = this.#currentSlot();
    return {
      roundIndex: ROUND2_ROUND_INDEX,
      challenges: this.#slots.map((slot) => this.#viewOf(slot)),
      currentIndex: current === null ? null : current.definition.order,
      current: current === null ? null : this.#viewOf(current),
      resolvedCount: this.#slots.filter((slot) => slot.progress === 'resolved').length,
      complete: this.complete,
      participatingTeamIds: [...this.#participatingTeamIds],
      pendingWinnerTeamId: this.#pendingWinnerTeamId,
      cardChallengeKind: ROUND2_CARD_CHALLENGE_KIND,
    };
  }
}
