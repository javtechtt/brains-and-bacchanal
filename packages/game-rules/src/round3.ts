import {
  asServerTimestamp,
  err,
  ok,
  rejection,
  ROUND3_CHALLENGES,
  ROUND3_CHALLENGE_COUNT,
  ROUND3_ROUND_INDEX,
  rpsBeats,
  type ChallengeId,
  type Rejection,
  type Result,
  type Round3ChallengeDefinition,
  type Round3ChallengeProgress,
  type Round3ChallengeView,
  type Round3ContentItem,
  type Round3ItemView,
  type Round3StateView,
  type RpsAttemptView,
  type RpsChoice,
  type RpsOutcome,
  type RpsTiebreakerView,
  type ServerTimestamp,
  type TeamId,
  type ThinkFastView,
} from '@bb/protocol';
import type { Clock } from './clock.js';
import {
  hasExpired,
  pauseDeadline,
  remainingMs,
  resumeDeadline,
  startDeadline,
  type Deadline,
} from './deadline.js';

/**
 * Round 3 progression. Phase 7B.
 *
 * GAME_RULES_LOCKED.md §13-§18, DECISION_LOG.md D-031.
 *
 * ================== THREE COUNTERS, NEVER COLLAPSED ==================
 * §13 states this with a worked example because it is the thing most likely to
 * be merged by mistake:
 *
 *   challenge points  -> decide who wins ONE challenge. Reset every challenge.
 *   challenge wins    -> +1 per challenge won. Decide the ROUND.
 *   BB                -> the game's score. Only Think Fast and Sing a Song pay.
 *
 * Five logos is ONE Round 3 win, not five, and not BB. They are three separate
 * fields here and none is derived from another.
 * =====================================================================
 *
 * Like `Round2`, this is a cursor plus the state the round genuinely owns. It
 * holds no phase, no challenge container, no BB and no cards — those stay with
 * `GameEngine` and `SharedSystems`. The award itself goes through the engine's
 * ledger; this class reports the base and records what came back.
 */

interface Round3Slot {
  readonly definition: Round3ChallengeDefinition;
  progress: Round3ChallengeProgress;
  challengeId: ChallengeId | null;
  /** Challenge points this challenge only. Cleared when it resolves. */
  readonly scores: Map<string, number>;
  /** Items revealed so far, for the index shown on screen. */
  itemsRevealed: number;
  currentItem: Round3ContentItem | null;
  currentItemAt: ServerTimestamp | null;
  itemDeadline: Deadline | null;
  /** Think Fast only. */
  turnOrder: TeamId[];
  currentTeamIndex: number;
  eliminated: TeamId[];
  validAnswerCount: number;
  winningTeamId: TeamId | null;
  awardedBb: number | null;
  doubled: boolean;
  resolvedAt: ServerTimestamp | null;
}

/** One rock-paper-scissors attempt. §18. */
interface RpsAttempt {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly participating: TeamId[];
  readonly choices: Map<string, RpsChoice>;
  resolved: boolean;
  outcome: RpsOutcome | null;
  winningTeamId: TeamId | null;
  eliminated: TeamId[];
  explanation: string | null;
  resolvedAt: ServerTimestamp | null;
}

export interface Round3Options {
  readonly clock: Clock;
  readonly mintId: () => string;
}

export class Round3 {
  readonly #clock: Clock;
  readonly #mintId: () => string;

  #active = false;
  #participating: readonly TeamId[] = [];
  /**
   * Standings carried in from the previous round, best first.
   *
   * D-031 — winning a round means the most total BB when it ended. Snapped once
   * on entry so BB movement during Round 3 cannot reorder a Think Fast already
   * under way.
   */
  #previousRoundOrder: readonly TeamId[] = [];

  /** The Round 3 challenge-win counter. NOT BB, never in the ledger. */
  readonly #challengeWins = new Map<string, number>();

  readonly #slots: Round3Slot[] = ROUND3_CHALLENGES.map((definition) => ({
    definition,
    progress: 'not_started',
    challengeId: null,
    scores: new Map<string, number>(),
    itemsRevealed: 0,
    currentItem: null,
    currentItemAt: null,
    itemDeadline: null,
    turnOrder: [],
    currentTeamIndex: 0,
    eliminated: [],
    validAnswerCount: 0,
    winningTeamId: null,
    awardedBb: null,
    doubled: false,
    resolvedAt: null,
  }));

  // --- Tiebreaker ----------------------------------------------------------
  #tiedTeams: TeamId[] = [];
  #rpsActive: TeamId[] = [];
  #attempts: RpsAttempt[] = [];
  #tiebreakerComplete = false;
  #round3Winner: TeamId | null = null;

  constructor(options: Round3Options) {
    this.#clock = options.clock;
    this.#mintId = options.mintId;
  }

  get active(): boolean {
    return this.#active;
  }

  get complete(): boolean {
    return this.#slots.every((s) => s.progress === 'resolved');
  }

  get winningTeamId(): TeamId | null {
    return this.#round3Winner;
  }

  get participatingTeamIds(): readonly TeamId[] {
    return this.#participating;
  }

  /**
   * Enter Round 3.
   *
   * `previousRoundOrder` is the previous round's standings, best first, and the
   * caller computes it — the engine knows the balances, this class does not.
   * Think Fast's turn order comes straight from it (§14).
   */
  begin(input: {
    readonly teamIds: readonly TeamId[];
    readonly previousRoundOrder: readonly TeamId[];
  }): Result<true> {
    if (this.#active) {
      return err(rejection('WRONG_STATE', 'Round 3 has already started.'));
    }
    if (input.teamIds.length === 0) {
      return err(rejection('INVALID_REQUEST', 'Round 3 needs participating teams.'));
    }

    this.#active = true;
    this.#participating = [...input.teamIds];
    // Any team missing from the supplied order is appended, so a caller that
    // computes standings from an incomplete source still yields a total order.
    const ordered = [...input.previousRoundOrder].filter((t) => input.teamIds.includes(t));
    for (const team of input.teamIds) if (!ordered.includes(team)) ordered.push(team);
    this.#previousRoundOrder = ordered;

    for (const team of input.teamIds) this.#challengeWins.set(team, 0);
    return ok(true);
  }

  #currentSlot(): Round3Slot | null {
    return this.#slots.find((s) => s.progress !== 'resolved') ?? null;
  }

  get currentIndex(): number | null {
    const slot = this.#currentSlot();
    return slot === null ? null : slot.definition.order;
  }

  /** The next challenge to prepare. Order is enforced by construction. */
  nextToPrepare(): Result<Round3ChallengeDefinition> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    const slot = this.#currentSlot();
    if (slot === null) {
      return err(
        rejection('ILLEGAL_ACTION', 'Round 3 is complete. All four challenges have resolved.', {
          resolvedCount: ROUND3_CHALLENGE_COUNT,
        }),
      );
    }
    if (slot.progress === 'in_progress') {
      return err(
        rejection('ILLEGAL_ACTION', 'This Round 3 challenge is already in progress.', {
          challengeType: slot.definition.challengeType,
        }),
      );
    }
    return ok(slot.definition);
  }

  /**
   * Bind the round's slot to an engine challenge, and set up its format.
   *
   * Think Fast's turn order is fixed HERE rather than read live, so a BB change
   * mid-challenge cannot reorder play already under way (§14, D-031).
   */
  markPrepared(challengeId: ChallengeId): Result<Round3ChallengeDefinition> {
    const next = this.nextToPrepare();
    if (!next.ok) return next;

    const slot = this.#slotFor(next.value.challengeType);
    slot.progress = 'in_progress';
    slot.challengeId = challengeId;
    for (const team of this.#participating) slot.scores.set(team, 0);

    if (slot.definition.format === 'elimination') {
      slot.turnOrder = [...this.#previousRoundOrder];
      slot.currentTeamIndex = 0;
      slot.eliminated = [];
      slot.validAnswerCount = 0;
    }

    return ok(next.value);
  }

  // -------------------------------------------------------------------------
  // Content items
  // -------------------------------------------------------------------------

  /**
   * Reveal the next content item and start its window.
   *
   * THE ITEM COMES FROM THE CALLER, never from here. §13 — the game supplies
   * challenge content; this class only tracks which one is on screen and how
   * long it has left. That also keeps every accepted answer out of this file,
   * because none is ever passed in.
   */
  revealItem(item: Round3ContentItem): Result<Round3ItemView> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    const slot = this.#currentSlot();
    if (slot === null || slot.progress !== 'in_progress') {
      return err(rejection('WRONG_STATE', 'No Round 3 challenge is running.'));
    }

    slot.itemsRevealed += 1;
    slot.currentItem = item;
    slot.currentItemAt = this.#now();
    slot.itemDeadline =
      slot.definition.itemWindowMs === null
        ? null
        : startDeadline(this.#clock, slot.definition.itemWindowMs);

    const view = this.#itemView(slot);
    /* c8 ignore next 3 -- unreachable: currentItem and currentItemAt were both
       just assigned, which is the only thing #itemView returns null for. */
    if (view === null) {
      return err(rejection('WRONG_STATE', 'The item could not be revealed.'));
    }
    return ok(view);
  }

  /** Whether the current item's window has run out. Polled, never scheduled. */
  itemWindowExpired(): boolean {
    const slot = this.#currentSlot();
    if (slot === null || slot.itemDeadline === null) return false;
    return hasExpired(this.#clock, slot.itemDeadline);
  }

  /** Pause and resume the running item window, with the game. D-011. */
  pauseItemWindow(): void {
    const slot = this.#currentSlot();
    if (slot === null || slot.itemDeadline === null) return;
    slot.itemDeadline = pauseDeadline(this.#clock, slot.itemDeadline);
  }

  resumeItemWindow(): void {
    const slot = this.#currentSlot();
    if (slot === null || slot.itemDeadline === null) return;
    slot.itemDeadline = resumeDeadline(this.#clock, slot.itemDeadline);
  }

  // -------------------------------------------------------------------------
  // Points
  // -------------------------------------------------------------------------

  /**
   * Award one challenge point. §15, §16, §17.
   *
   * POINTS, NOT BB. Nothing here touches the ledger, and reaching the target
   * does not resolve anything — the Host confirms (§15-§17).
   */
  awardPoint(teamId: TeamId): Result<Round3ChallengeView> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    const slot = this.#currentSlot();
    if (slot === null || slot.progress !== 'in_progress') {
      return err(rejection('WRONG_STATE', 'No Round 3 challenge is running.'));
    }
    if (slot.definition.format !== 'points') {
      return err(
        rejection('ILLEGAL_ACTION', 'This challenge is not scored by points.', {
          challengeType: slot.definition.challengeType,
          format: slot.definition.format,
        }),
      );
    }
    if (!this.#participating.includes(teamId)) {
      return err(rejection('NOT_FOUND', 'That team is not taking part.', { teamId }));
    }

    slot.scores.set(teamId, (slot.scores.get(teamId) ?? 0) + 1);
    return ok(this.#challengeView(slot));
  }

  // -------------------------------------------------------------------------
  // Think Fast
  // -------------------------------------------------------------------------

  /** The team whose turn it is, or null. */
  #currentThinkFastTeam(slot: Round3Slot): TeamId | null {
    const remaining = slot.turnOrder.filter((t) => !slot.eliminated.includes(t));
    if (remaining.length === 0) return null;
    return remaining[slot.currentTeamIndex % remaining.length] ?? null;
  }

  /** The current team answered validly; the turn passes on. §14. */
  thinkFastValid(): Result<ThinkFastView> {
    const slot = this.#requireThinkFast();
    if (!slot.ok) return err(slot.error);

    const s = slot.value;
    const current = this.#currentThinkFastTeam(s);
    if (current === null) {
      return err(rejection('WRONG_STATE', 'No team is currently answering.'));
    }

    s.validAnswerCount += 1;
    s.currentTeamIndex += 1;
    return ok(this.#thinkFastView(s));
  }

  /**
   * The current team is out of this challenge. §14.
   *
   * "A team that cannot give another valid answer is out." Play continues among
   * the rest until one remains — and the LAST team is the winner, but the Host
   * still confirms it, exactly like the other three challenges.
   */
  thinkFastEliminate(): Result<ThinkFastView> {
    const slot = this.#requireThinkFast();
    if (!slot.ok) return err(slot.error);

    const s = slot.value;
    const current = this.#currentThinkFastTeam(s);
    if (current === null) {
      return err(rejection('WRONG_STATE', 'No team is currently answering.'));
    }

    const remainingBefore = s.turnOrder.filter((t) => !s.eliminated.includes(t));
    if (remainingBefore.length <= 1) {
      return err(
        rejection('ILLEGAL_ACTION', 'Only one team remains; it cannot be eliminated.', {
          teamId: current,
        }),
      );
    }

    s.eliminated.push(current);

    // The index pointed at the team just removed, so the same index now names
    // the next team along. Only wrap when it has run off the end.
    const remainingAfter = s.turnOrder.filter((t) => !s.eliminated.includes(t));
    if (remainingAfter.length > 0) {
      s.currentTeamIndex %= remainingAfter.length;
    }

    return ok(this.#thinkFastView(s));
  }

  #requireThinkFast(): Result<Round3Slot> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    const slot = this.#currentSlot();
    if (slot === null || slot.progress !== 'in_progress') {
      return err(rejection('WRONG_STATE', 'No Round 3 challenge is running.'));
    }
    if (slot.definition.format !== 'elimination') {
      return err(
        rejection('ILLEGAL_ACTION', 'This challenge is not Think Fast.', {
          challengeType: slot.definition.challengeType,
        }),
      );
    }
    return ok(slot);
  }

  // -------------------------------------------------------------------------
  // Confirming a challenge winner
  // -------------------------------------------------------------------------

  /**
   * Validate a challenge confirmation and report what it would pay.
   *
   * Separate from applying it, exactly as Round 2 does: the engine needs the
   * base reward and the winner BEFORE asking the shared systems for a multiplier
   * and moving BB, and validation must complete before anything is applied.
   *
   * **A score never resolves a challenge.** §15-§17 give the Host discretion to
   * confirm before or after the target, so this accepts any participating team
   * regardless of the score — including a team that has not reached it.
   */
  prepareConfirmation(winningTeamId: TeamId): Result<{
    readonly definition: Round3ChallengeDefinition;
    readonly challengeId: ChallengeId;
    readonly winningTeamId: TeamId;
    readonly baseRewardBb: number;
  }> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    const slot = this.#currentSlot();
    if (slot === null) {
      return err(rejection('WRONG_STATE', 'Round 3 is complete.'));
    }
    if (slot.progress !== 'in_progress') {
      return err(
        rejection('WRONG_STATE', 'That Round 3 challenge has not been prepared.', {
          challengeType: slot.definition.challengeType,
          progress: slot.progress,
        }),
      );
    }
    if (slot.challengeId === null) {
      return err(rejection('WRONG_STATE', 'This challenge has no engine challenge.'));
    }
    if (!this.#participating.includes(winningTeamId)) {
      return err(rejection('NOT_FOUND', 'That team is not taking part.', { teamId: winningTeamId }));
    }
    if (slot.definition.format === 'elimination' && slot.eliminated.includes(winningTeamId)) {
      return err(
        rejection('ILLEGAL_ACTION', 'That team was eliminated from this challenge.', {
          teamId: winningTeamId,
        }),
      );
    }

    return ok({
      definition: slot.definition,
      challengeId: slot.challengeId,
      winningTeamId,
      // 0 for Guess the Logo and All Answers Begin With — a locked rule, not an
      // omission. The engine still runs its award path; it just moves nothing.
      baseRewardBb: slot.definition.baseRewardBb,
    });
  }

  /**
   * Record a confirmed challenge result. Called AFTER any BB has moved.
   *
   * This is the ONE place the challenge-win counter increments, and it happens
   * exactly once per challenge because the slot moves to `resolved` in the same
   * step — a second confirmation is refused by `prepareConfirmation`.
   */
  recordChallengeResult(input: {
    readonly winningTeamId: TeamId;
    readonly awardedBb: number;
    readonly doubled: boolean;
  }): Round3ChallengeView {
    const slot = this.#currentSlot();
    /* c8 ignore next 3 -- unreachable: prepareConfirmation has already refused
       every state in which there is no current slot. */
    if (slot === null) {
      throw new Error('recordChallengeResult called with no current challenge.');
    }

    slot.progress = 'resolved';
    slot.winningTeamId = input.winningTeamId;
    slot.awardedBb = input.awardedBb;
    slot.doubled = input.doubled;
    slot.resolvedAt = this.#now();
    slot.itemDeadline = null;

    // +1 challenge win. NOT BB.
    this.#challengeWins.set(
      input.winningTeamId,
      (this.#challengeWins.get(input.winningTeamId) ?? 0) + 1,
    );

    return this.#challengeView(slot);
  }

  // -------------------------------------------------------------------------
  // Round winner and the tiebreaker
  // -------------------------------------------------------------------------

  /** Teams tied on the highest challenge-win counter. */
  leaders(): readonly TeamId[] {
    let best = -1;
    for (const team of this.#participating) {
      const wins = this.#challengeWins.get(team) ?? 0;
      if (wins > best) best = wins;
    }
    return this.#participating.filter((t) => (this.#challengeWins.get(t) ?? 0) === best);
  }

  /**
   * Decide the Round 3 winner once all four challenges have resolved.
   *
   * One leader wins outright. Tied leaders go to rock-paper-scissors (§18) —
   * and this returns `needsTiebreaker`, having started it, rather than picking
   * for them.
   */
  decideWinner(): Result<{
    readonly winningTeamId: TeamId | null;
    readonly needsTiebreaker: boolean;
    readonly leaders: readonly TeamId[];
  }> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    if (!this.complete) {
      return err(
        rejection('WRONG_STATE', 'Round 3 is not finished.', {
          resolvedCount: this.#slots.filter((s) => s.progress === 'resolved').length,
        }),
      );
    }
    if (this.#round3Winner !== null) {
      return ok({ winningTeamId: this.#round3Winner, needsTiebreaker: false, leaders: [] });
    }

    const leaders = this.leaders();
    if (leaders.length === 1) {
      this.#round3Winner = leaders[0] ?? null;
      return ok({ winningTeamId: this.#round3Winner, needsTiebreaker: false, leaders });
    }

    // §18 — actual rock-paper-scissors. Not a Bacchanal Clash.
    this.#tiedTeams = [...leaders];
    this.#rpsActive = [...leaders];
    this.#tiebreakerComplete = false;
    this.#startAttempt();

    return ok({ winningTeamId: null, needsTiebreaker: true, leaders });
  }

  #startAttempt(): RpsAttempt {
    const attempt: RpsAttempt = {
      attemptId: this.#mintId(),
      attemptNumber: this.#attempts.length + 1,
      participating: [...this.#rpsActive],
      choices: new Map<string, RpsChoice>(),
      resolved: false,
      outcome: null,
      winningTeamId: null,
      eliminated: [],
      explanation: null,
      resolvedAt: null,
    };
    this.#attempts.push(attempt);
    return attempt;
  }

  #currentAttempt(): RpsAttempt | null {
    const last = this.#attempts[this.#attempts.length - 1];
    return last === undefined ? null : last;
  }

  /**
   * A tied team locks its choice. §18 — hidden until everyone has chosen.
   *
   * A duplicate submission is REFUSED rather than replacing the first: the
   * window is hidden precisely so a team cannot probe and revise, the same
   * reasoning the Bacchanal Clash uses.
   */
  submitRpsChoice(teamId: TeamId, choice: RpsChoice): Result<RpsAttemptView> {
    const attempt = this.#currentAttempt();
    if (attempt === null || attempt.resolved) {
      return err(rejection('WRONG_STATE', 'No rock-paper-scissors round is open.'));
    }
    if (!attempt.participating.includes(teamId)) {
      return err(
        rejection('ILLEGAL_ACTION', 'Your team is not in this tiebreaker.', { teamId }),
      );
    }
    if (attempt.choices.has(teamId)) {
      return err(rejection('ILLEGAL_ACTION', 'Your team has already chosen.', { teamId }));
    }

    attempt.choices.set(teamId, choice);
    return ok(this.#attemptView(attempt, null));
  }

  /** Whether every participating team has locked a choice. */
  allRpsChoicesIn(): boolean {
    const attempt = this.#currentAttempt();
    if (attempt === null || attempt.resolved) return false;
    return attempt.participating.every((t) => attempt.choices.has(t));
  }

  /**
   * Reveal and resolve one rock-paper-scissors attempt. §18.
   *
   * Two teams: different choices decide it; the same choice replays.
   *
   * Three teams: all-same and all-different both replay — in the first nothing
   * separates them, and in the second the cycle closes so no choice is unbeaten.
   * Two-same-plus-one compares the two distinct choices: if the single beats the
   * pair it wins outright; if the pair beats the single, the single is
   * eliminated and the remaining two continue.
   */
  resolveRps(): Result<RpsAttemptView> {
    const attempt = this.#currentAttempt();
    if (attempt === null || attempt.resolved) {
      return err(rejection('WRONG_STATE', 'No rock-paper-scissors round is open.'));
    }
    if (!this.allRpsChoicesIn()) {
      return err(rejection('WRONG_STATE', 'Not every team has chosen yet.'));
    }

    const distinct = [...new Set(attempt.choices.values())];
    attempt.resolved = true;
    attempt.resolvedAt = this.#now();

    if (distinct.length === 1) {
      attempt.outcome = 'replay';
      attempt.explanation = 'Everyone chose the same. Play again.';
    } else if (distinct.length === 3) {
      attempt.outcome = 'replay';
      attempt.explanation = 'All three choices are out — nothing wins. Play again.';
    } else {
      // Exactly two distinct choices, whether from two teams or three.
      const [a, b] = distinct as [RpsChoice, RpsChoice];
      const winningChoice = rpsBeats(a, b) ? a : b;
      const losingChoice = winningChoice === a ? b : a;

      const winners = attempt.participating.filter(
        (t) => attempt.choices.get(t) === winningChoice,
      );
      const losers = attempt.participating.filter((t) => attempt.choices.get(t) === losingChoice);

      if (winners.length === 1) {
        attempt.outcome = 'winner';
        attempt.winningTeamId = winners[0] ?? null;
        attempt.explanation = `${winningChoice} beats ${losingChoice}.`;
        this.#rpsActive = [...winners];
        this.#tiebreakerComplete = true;
        this.#round3Winner = attempt.winningTeamId;
      } else {
        // The winning choice is shared, so nothing separates those teams yet.
        // The losers are out and the rest play again — §18 exactly.
        attempt.outcome = 'elimination';
        attempt.eliminated = [...losers];
        attempt.explanation = `${winningChoice} beats ${losingChoice}. ${losers.length === 1 ? 'That team is' : 'Those teams are'} out; the rest play again.`;
        this.#rpsActive = [...winners];
      }
    }

    const view = this.#attemptView(attempt, attempt.outcome);

    // A replay or an elimination starts the next attempt immediately, so a
    // client always has an open attempt to render.
    if (!this.#tiebreakerComplete) this.#startAttempt();

    return ok(view);
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  #slotFor(challengeType: string): Round3Slot {
    const slot = this.#slots.find((s) => s.definition.challengeType === challengeType);
    /* c8 ignore next 3 -- unreachable: callers pass a type from this class's
       own configuration. */
    if (slot === undefined) throw new Error(`Unknown Round 3 challenge: ${challengeType}`);
    return slot;
  }

  #requireActive(): Rejection | null {
    if (!this.#active) return rejection('WRONG_STATE', 'Round 3 has not started.');
    return null;
  }

  #now(): ServerTimestamp {
    return asServerTimestamp(this.#clock.now());
  }

  #itemView(slot: Round3Slot): Round3ItemView | null {
    const item = slot.currentItem;
    if (item === null || slot.currentItemAt === null) return null;
    return {
      itemId: item.itemId,
      index: slot.itemsRevealed,
      body: item.body,
      letter: item.letter ?? null,
      imageRef: item.imageRef ?? null,
      revealedAt: slot.currentItemAt,
      remainingMs:
        slot.itemDeadline === null ? null : Math.max(0, remainingMs(this.#clock, slot.itemDeadline)),
    };
  }

  #thinkFastView(slot: Round3Slot): ThinkFastView {
    const remaining = slot.turnOrder.filter((t) => !slot.eliminated.includes(t));
    return {
      turnOrder: [...slot.turnOrder],
      currentTeamId: this.#currentThinkFastTeam(slot),
      eliminatedTeamIds: [...slot.eliminated],
      remainingTeamIds: remaining,
      validAnswerCount: slot.validAnswerCount,
    };
  }

  #challengeView(slot: Round3Slot): Round3ChallengeView {
    const scores: Record<string, number> = {};
    const scoreList: { teamId: TeamId; value: number }[] = [];
    for (const [team, score] of slot.scores) {
      scores[team] = score;
      // The same numbers twice: a Record the web reads, and a list Unity can.
      // JsonUtility has no dictionary support, so a keyed object would arrive
      // empty and silently show every score as zero.
      scoreList.push({ teamId: team as TeamId, value: score });
    }

    const target = slot.definition.targetScore;
    const targetReached =
      target !== null && [...slot.scores.values()].some((score) => score >= target);

    return {
      challengeType: slot.definition.challengeType,
      displayName: slot.definition.displayName,
      order: slot.definition.order,
      format: slot.definition.format,
      progress: slot.progress,
      challengeId: slot.challengeId,
      scores,
      scoreList,
      targetScore: target,
      targetReached,
      currentItem: this.#itemView(slot),
      thinkFast: slot.definition.format === 'elimination' ? this.#thinkFastView(slot) : null,
      winningTeamId: slot.winningTeamId,
      awardedBb: slot.awardedBb,
      doubled: slot.doubled,
      resolvedAt: slot.resolvedAt,
    };
  }

  /**
   * One attempt, as a client may see it.
   *
   * `choices` IS EMPTY UNTIL THE REVEAL. §18 hides them until every tied team
   * has locked one, and this is the only place that decision is made — the view
   * simply cannot carry an unrevealed choice.
   */
  #attemptView(attempt: RpsAttempt, outcome: RpsOutcome | null): RpsAttemptView {
    const choices: Record<string, RpsChoice> = {};
    const revealedChoices: { teamId: TeamId; choice: RpsChoice }[] = [];
    if (attempt.resolved) {
      for (const [team, choice] of attempt.choices) {
        choices[team] = choice;
        revealedChoices.push({ teamId: team as TeamId, choice });
      }
    }
    return {
      attemptId: attempt.attemptId,
      attemptNumber: attempt.attemptNumber,
      participatingTeamIds: [...attempt.participating],
      submittedTeamIds: [...attempt.choices.keys()].map((t) => t as TeamId),
      resolved: attempt.resolved,
      choices,
      revealedChoices,
      outcome: outcome ?? attempt.outcome,
      winningTeamId: attempt.winningTeamId,
      eliminatedTeamIds: [...attempt.eliminated],
      explanation: attempt.explanation,
      resolvedAt: attempt.resolvedAt,
    };
  }

  /**
   * The tiebreaker as ONE TEAM may see it.
   *
   * `forTeam` gets that team's own locked choice back — the one deliberate
   * exception to hiding, and scoped to its owner exactly like the Clash's
   * `yourClashResponse`.
   */
  tiebreakerView(forTeam: TeamId | null): RpsTiebreakerView | null {
    if (this.#tiedTeams.length === 0) return null;

    const current = this.#currentAttempt();
    const own =
      forTeam !== null && current !== null && !current.resolved
        ? (current.choices.get(forTeam) ?? null)
        : null;

    return {
      tiedTeamIds: [...this.#tiedTeams],
      activeTeamIds: [...this.#rpsActive],
      current: current === null ? null : this.#attemptView(current, current.outcome),
      history: this.#attempts
        .filter((a) => a.resolved)
        .map((a) => this.#attemptView(a, a.outcome)),
      complete: this.#tiebreakerComplete,
      winningTeamId: this.#round3Winner,
      yourChoice: own,
    };
  }

  /**
   * Round 3 as clients see it.
   *
   * `forTeam` scopes only the tiebreaker's own-choice field; everything else
   * here is public — which challenge is running, the scores, the counters and
   * who won. A party game puts exactly that on a TV.
   */
  view(forTeam: TeamId | null = null): Round3StateView {
    const current = this.#currentSlot();
    const wins: Record<string, number> = {};
    const challengeWinList: { teamId: TeamId; value: number }[] = [];
    for (const [team, count] of this.#challengeWins) {
      wins[team] = count;
      challengeWinList.push({ teamId: team as TeamId, value: count });
    }

    return {
      roundIndex: ROUND3_ROUND_INDEX,
      challenges: this.#slots.map((s) => this.#challengeView(s)),
      currentIndex: current === null ? null : current.definition.order,
      current: current === null ? null : this.#challengeView(current),
      resolvedCount: this.#slots.filter((s) => s.progress === 'resolved').length,
      complete: this.complete,
      participatingTeamIds: [...this.#participating],
      challengeWins: wins,
      challengeWinList,
      previousRoundOrder: [...this.#previousRoundOrder],
      tiebreaker: this.tiebreakerView(forTeam),
      winningTeamId: this.#round3Winner,
    };
  }
}
