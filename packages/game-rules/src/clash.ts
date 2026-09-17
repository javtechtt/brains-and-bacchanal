import {
  asServerTimestamp,
  categoryBeats,
  categoryOf,
  CLASH_RESPONSE_WINDOW_MS,
  err,
  ok,
  rejection,
  type BacchanalCardType,
  type BacchanalCategory,
  type ChallengeId,
  type ClashEntryView,
  type ClashResult,
  type ClashView,
  type Result,
  type TeamId,
} from '@bb/protocol';
import type { Clock } from './clock.js';
import { hasExpired, remainingMs, startDeadline, type Deadline } from './deadline.js';

/**
 * The Bacchanal Clash and Part Dat Fight.
 *
 * GAME_RULES_LOCKED.md §5. When a card is played, opponents get a 6-second
 * hidden window to counter with one eligible card. Then everything is revealed
 * at once and the category triangle decides.
 *
 * ================== THE TRIANGLE IS A CYCLE ==================
 * DISRUPTION beats POWER beats RECOVERY beats DISRUPTION.
 *
 * There is no strongest category, so "which card wins" is not a max over an
 * ordering — it does not have one. A tie is therefore not a rare edge case to
 * break; it is a first-class locked outcome called PART DAT FIGHT, where no
 * effect resolves at all.
 * =============================================================
 *
 * Built on the Phase 2 `Deadline` primitives, so the window pauses with the
 * game like every other timer and a FakeClock drives it in tests.
 */

/** One team's committed card inside a Clash. */
interface ClashEntry {
  readonly teamId: TeamId;
  readonly cardInstanceId: string;
  readonly cardType: BacchanalCardType;
  readonly category: BacchanalCategory;
  readonly initiator: boolean;
  /** The team this card targets, where the card needs one. */
  readonly targetTeamId: TeamId | null;
}

export interface ClashOptions {
  readonly clock: Clock;
  readonly mintId: () => string;
}

export class ClashEngine {
  readonly #clock: Clock;
  readonly #mintId: () => string;

  #clashId: string | null = null;
  #challengeId: ChallengeId | null = null;
  #deadline: Deadline | null = null;
  #entries: ClashEntry[] = [];
  #eligibleTeamIds: TeamId[] = [];
  #result: ClashResult | null = null;
  #resolved = false;

  constructor(options: ClashOptions) {
    this.#clock = options.clock;
    this.#mintId = options.mintId;
  }

  get active(): boolean {
    return this.#clashId !== null && !this.#resolved;
  }

  get clashId(): string | null {
    return this.#clashId;
  }

  get challengeId(): ChallengeId | null {
    return this.#challengeId;
  }

  // -------------------------------------------------------------------------
  // Opening
  // -------------------------------------------------------------------------

  /**
   * Open a Clash around a card that has just been played.
   *
   * GAME_RULES_LOCKED.md §5 — "opponents get a 6-second hidden response window".
   * The duration is locked, so it is a constant rather than a caller parameter;
   * almost every other duration in this game is still open (OPEN_RULES.md §2,
   * §6, §11) and stays caller-supplied.
   *
   * `eligibleTeamIds` is computed by the caller from the card system, because
   * "eligible" means "holds a card legal for this challenge" — a question only
   * the card system can answer, and Phase 6 spec §9 requires illegal counters to
   * be unselectable.
   */
  open(input: {
    readonly challengeId: ChallengeId;
    readonly initiatingTeamId: TeamId;
    readonly cardInstanceId: string;
    readonly cardType: BacchanalCardType;
    readonly targetTeamId: TeamId | null;
    readonly eligibleTeamIds: readonly TeamId[];
  }): Result<ClashView> {
    if (this.active) {
      return err(rejection('ILLEGAL_ACTION', 'A Clash is already running.'));
    }

    this.#clashId = this.#mintId();
    this.#challengeId = input.challengeId;
    this.#deadline = startDeadline(this.#clock, CLASH_RESPONSE_WINDOW_MS);
    this.#resolved = false;
    this.#result = null;
    this.#entries = [
      {
        teamId: input.initiatingTeamId,
        cardInstanceId: input.cardInstanceId,
        cardType: input.cardType,
        category: categoryOf(input.cardType),
        initiator: true,
        targetTeamId: input.targetTeamId,
      },
    ];
    // The initiator cannot counter its own card.
    this.#eligibleTeamIds = input.eligibleTeamIds.filter((id) => id !== input.initiatingTeamId);

    const view = this.view();
    if (view === null) {
      return err(rejection('INTERNAL_ERROR', 'The Clash could not be opened.'));
    }
    return ok(view);
  }

  // -------------------------------------------------------------------------
  // Responding
  // -------------------------------------------------------------------------

  /**
   * Record one team's secret counter.
   *
   * TARGETS LOCK BEFORE REVEAL (GAME_RULES_LOCKED.md §5, Phase 6 spec §9). The
   * response including its target is committed here and never edited, so a team
   * cannot watch the reveal and retarget. There is no "change response" path,
   * deliberately.
   *
   * Caller checks the card is legal for this challenge and owned by this team;
   * this checks the Clash-specific rules: window still open, team eligible, and
   * one response each.
   */
  respond(input: {
    readonly teamId: TeamId;
    readonly cardInstanceId: string;
    readonly cardType: BacchanalCardType;
    readonly targetTeamId: TeamId | null;
  }): Result<ClashView> {
    if (!this.active || this.#deadline === null) {
      return err(rejection('WRONG_STATE', 'No Clash is open.'));
    }

    // The window is authoritative and server-timed. A phone that sends late
    // because of its own lag is refused — ARCHITECTURE.md §6.
    if (hasExpired(this.#clock, this.#deadline)) {
      return err(rejection('WRONG_STATE', 'The Clash response window has closed.'));
    }

    if (!this.#eligibleTeamIds.includes(input.teamId)) {
      return err(rejection('ILLEGAL_ACTION', 'Your team cannot respond to this Clash.'));
    }

    // One response per team. A duplicate is refused rather than replacing the
    // first, because replacing would let a team probe and revise inside the
    // window — which is exactly what "hidden" and "locked before reveal" forbid.
    if (this.#entries.some((entry) => entry.teamId === input.teamId)) {
      return err(rejection('ILLEGAL_ACTION', 'Your team has already responded.'));
    }

    this.#entries.push({
      teamId: input.teamId,
      cardInstanceId: input.cardInstanceId,
      cardType: input.cardType,
      category: categoryOf(input.cardType),
      initiator: false,
      targetTeamId: input.targetTeamId,
    });

    const view = this.view();
    if (view === null) {
      return err(rejection('INTERNAL_ERROR', 'The Clash state was lost.'));
    }
    return ok(view);
  }

  /** Whether the response window has run out. */
  windowExpired(): boolean {
    if (this.#deadline === null) return false;
    return hasExpired(this.#clock, this.#deadline);
  }

  /** Whether every eligible team has already responded. */
  allResponded(): boolean {
    const responders = this.#entries.filter((entry) => !entry.initiator).length;
    return responders >= this.#eligibleTeamIds.length;
  }

  /** Pause and resume the window with the game. D-011. */
  pause(): void {
    if (this.#deadline === null || this.#deadline.pausedAt !== null) return;
    this.#deadline = { ...this.#deadline, pausedAt: this.#clock.now() };
  }

  resume(): void {
    const deadline = this.#deadline;
    if (deadline === null || deadline.pausedAt === null) return;
    this.#deadline = {
      ...deadline,
      accumulatedPauseMs: deadline.accumulatedPauseMs + (this.#clock.now() - deadline.pausedAt),
      pausedAt: null,
    };
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Close the window and reveal.
   *
   * Refuses while the window is still running unless every eligible team has
   * already responded — there is nothing left to wait for in that case, and
   * making the room sit through the remaining seconds serves nobody.
   */
  resolve(): Result<ClashResult> {
    if (this.#clashId === null) {
      return err(rejection('WRONG_STATE', 'No Clash is open.'));
    }
    if (this.#resolved && this.#result !== null) {
      // Idempotent: the window can be closed by a tick and by an intent in the
      // same instant, and both must see the same outcome.
      return ok(this.#result);
    }
    if (!this.windowExpired() && !this.allResponded()) {
      return err(rejection('WRONG_STATE', 'The Clash response window is still open.'));
    }

    const result = resolveClashEntries(this.#entries, asServerTimestamp(this.#clock.now()));
    this.#result = result;
    this.#resolved = true;
    return ok(result);
  }

  /** Clear the Clash. Called once its outcome has been applied. */
  clear(): void {
    this.#clashId = null;
    this.#challengeId = null;
    this.#deadline = null;
    this.#entries = [];
    this.#eligibleTeamIds = [];
    this.#result = null;
    this.#resolved = false;
  }

  /**
   * The Clash as clients see it.
   *
   * RESPONSES ARE NOT HERE WHILE THE WINDOW IS OPEN. `respondedTeamIds` says WHO
   * has acted; the card types appear only in `result`, which is null until the
   * reveal. Phase 6 spec §42 — "hidden Clash responses before reveal".
   */
  view(): ClashView | null {
    const clashId = this.#clashId;
    const challengeId = this.#challengeId;
    const initiator = this.#entries.find((entry) => entry.initiator);
    if (clashId === null || challengeId === null || initiator === undefined) return null;

    return {
      clashId,
      challengeId,
      initiatingTeamId: initiator.teamId,
      // Public: it is the card everyone is responding TO, and §5 has opponents
      // choosing a counter, which requires knowing what they are countering.
      initiatingCardType: initiator.cardType,
      openedAt: asServerTimestamp(this.#deadline?.startedAt ?? this.#clock.now()),
      remainingMs: this.#deadline === null ? 0 : remainingMs(this.#clock, this.#deadline),
      respondedTeamIds: this.#entries.filter((e) => !e.initiator).map((e) => e.teamId),
      eligibleTeamIds: [...this.#eligibleTeamIds],
      resolved: this.#resolved,
      result: this.#result,
    };
  }

  /** One team's own locked response. Only ever sent to that team. */
  responseOf(teamId: TeamId): string | null {
    const entry = this.#entries.find((e) => e.teamId === teamId && !e.initiator);
    return entry?.cardInstanceId ?? null;
  }

  /** Every entry, for applying the outcome. Server-internal. */
  entries(): readonly ClashEntry[] {
    return [...this.#entries];
  }
}

/**
 * Decide a Clash from its entries.
 *
 * A PURE FUNCTION over the locked rules, separated from the stateful engine so
 * every branch of GAME_RULES_LOCKED.md §5 can be tested directly without a
 * clock, a window or a card system.
 *
 * The locked cases, in order:
 *
 *   NO COUNTER              → the original card resolves. §5.
 *   ONE CATEGORY SURVIVES   → that card wins, is consumed; losers return. §5.
 *   CATEGORIES TIE          → PART DAT FIGHT. No effect. Tied cards return. §5.
 *
 * Three-team cases (§5 "Three-team Clash", Phase 6 spec §10):
 *
 *   all three categories    → Part Dat Fight
 *   all the same category   → Part Dat Fight
 *   two same + one different → compare the two categories:
 *       single beats pair   → the single card wins
 *       pair beats single   → single eliminated, pair survives and ties
 *                             → Part Dat Fight between the pair, no effect
 */
export function resolveClashEntries(
  entries: readonly ClashEntry[],
  resolvedAt: ReturnType<typeof asServerTimestamp>,
): ClashResult {
  const initiator = entries.find((entry) => entry.initiator);
  const responders = entries.filter((entry) => !entry.initiator);

  // --- No counter. §5: "No response → original card resolves." --------------
  if (initiator === undefined || responders.length === 0) {
    return {
      outcome: 'uncontested',
      winningTeamId: initiator?.teamId ?? null,
      winningCardType: initiator?.cardType ?? null,
      entries: entries.map((entry) => toEntryView(entry, true)),
      returnedTeamIds: [],
      resolvedAt,
      explanation:
        initiator === undefined
          ? 'No card was played.'
          : 'No team countered. The card resolves normally.',
    };
  }

  const categories = [...new Set(entries.map((entry) => entry.category))];

  // --- All one category. Nothing in the triangle separates them. ------------
  // Covers the two-team "same category" tie AND the three-team "all three same"
  // case; both are Part Dat Fight, and both for the same reason.
  if (categories.length === 1) {
    return partDatFight(
      entries,
      resolvedAt,
      entries.length === 2
        ? 'Both cards are the same category. PART DAT FIGHT — no effect.'
        : 'Every card is the same category. PART DAT FIGHT — no effect.',
    );
  }

  // --- All three categories present. A closed cycle: nothing survives. ------
  // §5 — "all three categories → Part Dat Fight". Each card beats one of the
  // others and loses to the third, so no card is unbeaten.
  if (categories.length === 3) {
    return partDatFight(
      entries,
      resolvedAt,
      'All three categories clashed. PART DAT FIGHT — no effect.',
    );
  }

  // --- Exactly two categories in play. -------------------------------------
  // The triangle is a total rule between any TWO distinct categories: one
  // always beats the other. So the winning category is determined, and every
  // card of the losing category is eliminated.
  const [first, second] = categories as [BacchanalCategory, BacchanalCategory];
  const winningCategory = categoryBeats(first, second) ? first : second;
  const survivors = entries.filter((entry) => entry.category === winningCategory);

  // One survivor: it wins outright. This is both the ordinary two-team result
  // and the three-team "single category beats the pair" case (§5).
  if (survivors.length === 1) {
    const winner = survivors[0] as ClashEntry;
    const losers = entries.filter((entry) => entry.category !== winningCategory);
    return {
      outcome: 'winner',
      winningTeamId: winner.teamId,
      winningCardType: winner.cardType,
      entries: entries.map((entry) => toEntryView(entry, entry.category === winningCategory)),
      returnedTeamIds: losers.map((entry) => entry.teamId),
      resolvedAt,
      explanation: `${winner.category} beats ${losers[0]?.category ?? 'the other card'}. ${
        winner.cardType
      } resolves.`,
    };
  }

  // Several survivors of the SAME category: they beat the loser, then tie with
  // each other. §5 — "if paired category wins, single card is eliminated and
  // surviving pair causes Part Dat Fight." The eliminated card's team is listed
  // as returned alongside the tied pair, because §5 returns every losing card.
  return partDatFight(
    entries,
    resolvedAt,
    'The surviving cards are the same category. PART DAT FIGHT — no effect.',
  );
}

/**
 * Build a Part Dat Fight result.
 *
 * NO EFFECT RESOLVES and EVERY card returns. GAME_RULES_LOCKED.md §5: "No
 * effect resolves. Tied cards return. Those teams cannot play another Bacchanal
 * Card in that challenge."
 *
 * The third clause is enforced by the card system, not here — the team-level bar
 * was set when each card was played and is never lifted. This function returns
 * the cards; it does not restore anyone's right to play.
 */
function partDatFight(
  entries: readonly ClashEntry[],
  resolvedAt: ReturnType<typeof asServerTimestamp>,
  explanation: string,
): ClashResult {
  return {
    outcome: 'part_dat_fight',
    winningTeamId: null,
    winningCardType: null,
    entries: entries.map((entry) => toEntryView(entry, false)),
    returnedTeamIds: entries.map((entry) => entry.teamId),
    resolvedAt,
    explanation,
  };
}

function toEntryView(entry: ClashEntry, survived: boolean): ClashEntryView {
  return {
    teamId: entry.teamId,
    cardInstanceId: entry.cardInstanceId,
    cardType: entry.cardType,
    category: entry.category,
    initiator: entry.initiator,
    survived,
  };
}

export type { ClashEntry };
