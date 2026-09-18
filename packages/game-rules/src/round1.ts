import {
  asServerTimestamp,
  err,
  ok,
  rejection,
  ROUND1_MACO_VIEW_MS,
  ROUND1_QUESTION_COUNT,
  ROUND1_QUESTION_WINDOW_MS,
  ROUND1_RETRY_WINDOW_MS,
  ROUND1_ROUND_INDEX,
  ROUND1_TIEBREAK_WINDOW_MS,
  ROUND1_VALUES,
  nomineesComplete,
  type ChallengeId,
  type PlayerId,
  type Rejection,
  type Result,
  type Round1ContentItem,
  type Round1Difficulty,
  type Round1GradeSource,
  type Round1MacoView,
  type Round1NomineeEntry,
  type Round1Phase,
  type Round1QuestionPhase,
  type Round1QuestionView,
  type Round1Ruling,
  type Round1StandingView,
  type Round1StateView,
  type Round1Submission,
  type Round1TeamAnswerView,
  type Round1TiebreakAttemptView,
  type Round1TiebreakView,
  type Round1Verdict,
  type ServerTimestamp,
  type TeamId,
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
 * Round 1 — "Nah, That Too Easy!". Phase 7C.
 *
 * GAME_RULES_LOCKED.md §11, DECISION_LOG.md D-030 and D-032.
 *
 * ================== TWO TOTALS, ONE CORRECT ANSWER ==================
 * The distinction this round turns on, and the one a refactor would collapse:
 *
 *   BB              the game's score and currency. Awarded through the ENGINE's
 *                   ledger, kept for the rest of the game, spent in the Market.
 *   Round 1 points  a separate running total held HERE, which decides only the
 *                   Round 1 winner and never moves BB.
 *
 * A correct answer awards its value to both. They are not two BB transactions,
 * and neither is derived from the other — exactly as Round 3 keeps its
 * challenge-win counter out of the ledger.
 * ====================================================================
 *
 * ================== THE REVEAL IS LAST ==================
 * §11 — the correct answer is revealed after the question AND retry flow
 * completes. So this class holds the canonical answer privately and exposes it
 * only once the question reaches `revealed`. A retrying player must never be
 * handed the answer they are about to give.
 * =======================================================
 *
 * Like `Round2` and `Round3`, this is a cursor plus the state the round genuinely
 * owns. It holds no phase, no BB and no cards — those stay with `GameEngine` and
 * `SharedSystems`.
 */

/** One team's state on one question. */
interface AnswerSlot {
  submission: Round1Submission | null;
  ruling: Round1Ruling | null;
  /** A retry answer, once one is given. Replaces the first for SCORING. */
  retrySubmission: Round1Submission | null;
  retryRuling: Round1Ruling | null;
  retryOpen: boolean;
  retryDeadline: Deadline | null;
  awardedBb: number;
  awardedPoints: number;
  doubled: boolean;
  /** ALLYUH HELP ME! — whose answer this team is leaning on. §11. */
  assistedByTeamId: TeamId | null;
  /** Whether this question's score has been applied. Idempotency. */
  scored: boolean;
}

interface QuestionSlot {
  readonly item: Round1ContentItem;
  readonly questionNumber: number;
  phase: Round1QuestionPhase;
  challengeId: ChallengeId | null;
  openedAt: ServerTimestamp | null;
  deadline: Deadline | null;
  readonly answers: Map<string, AnswerSlot>;
  revealedAt: ServerTimestamp | null;
}

/** A live Maco! entitlement. Scoped to one player, one question, ten seconds. */
interface MacoGrant {
  readonly viewingPlayerId: PlayerId;
  readonly viewingTeamId: TeamId;
  readonly targetTeamId: TeamId;
  readonly questionNumber: number;
  readonly expiresAt: ServerTimestamp;
  deadline: Deadline;
}

interface TiebreakAttempt {
  readonly attemptNumber: number;
  readonly item: Round1ContentItem;
  readonly participating: TeamId[];
  phase: Round1QuestionPhase;
  deadline: Deadline | null;
  readonly answers: Map<string, AnswerSlot>;
  eliminated: TeamId[];
  outcome: 'winner' | 'elimination' | 'replay' | null;
  explanation: string | null;
  revealed: boolean;
}

export interface Round1Options {
  readonly clock: Clock;
  /** The normal question window. Configurable; 60s by locked rule (§11). */
  readonly questionWindowMs?: number;
  /** The FORGIVE MEH! retry window. 10s by D-032. */
  readonly retryWindowMs?: number;
  /** The sudden-death tiebreak window. 30s by D-032. */
  readonly tiebreakWindowMs?: number;
}

function emptyAnswerSlot(): AnswerSlot {
  return {
    submission: null,
    ruling: null,
    retrySubmission: null,
    retryRuling: null,
    retryOpen: false,
    retryDeadline: null,
    awardedBb: 0,
    awardedPoints: 0,
    doubled: false,
    assistedByTeamId: null,
    scored: false,
  };
}

export class Round1 {
  readonly #clock: Clock;
  readonly #questionWindowMs: number;
  readonly #retryWindowMs: number;
  readonly #tiebreakWindowMs: number;

  #active = false;
  #participating: readonly TeamId[] = [];
  #phase: Round1Phase = 'nominating';

  /** teamId -> difficulty -> playerId. §11, spec §2 — IDs, never names. */
  readonly #nominees = new Map<string, Map<Round1Difficulty, PlayerId | null>>();

  /** The 15 questions, in the order the content source supplied them. */
  #questions: QuestionSlot[] = [];
  #currentIndex = -1;

  /** THE ROUND 1 POINT TOTAL. Not BB, never written to the ledger. */
  readonly #points = new Map<string, number>();
  readonly #correctCounts = new Map<string, number>();

  #maco: MacoGrant | null = null;

  // --- Tiebreak ------------------------------------------------------------
  #tiedTeams: TeamId[] = [];
  #tiebreakActive: TeamId[] = [];
  #tiebreakAttempts: TiebreakAttempt[] = [];
  #tiebreakComplete = false;
  #winner: TeamId | null = null;

  constructor(options: Round1Options) {
    this.#clock = options.clock;
    this.#questionWindowMs = options.questionWindowMs ?? ROUND1_QUESTION_WINDOW_MS;
    this.#retryWindowMs = options.retryWindowMs ?? ROUND1_RETRY_WINDOW_MS;
    this.#tiebreakWindowMs = options.tiebreakWindowMs ?? ROUND1_TIEBREAK_WINDOW_MS;
  }

  get active(): boolean {
    return this.#active;
  }

  get phase(): Round1Phase {
    return this.#phase;
  }

  get winningTeamId(): TeamId | null {
    return this.#winner;
  }

  get participatingTeamIds(): readonly TeamId[] {
    return this.#participating;
  }

  get questionsAsked(): number {
    return this.#currentIndex + 1;
  }

  /** Round 1 points for one team. NOT BB. */
  pointsOf(teamId: TeamId): number {
    return this.#points.get(teamId) ?? 0;
  }

  // -------------------------------------------------------------------------
  // Entry and nomination
  // -------------------------------------------------------------------------

  /**
   * Enter Round 1 with a validated question set.
   *
   * The CALLER validates and supplies the questions — this class never reaches
   * for content, exactly as `Round3` never does (§13). It begins in
   * `nominating`, because §11 requires nominees before questions start.
   */
  begin(input: {
    readonly teamIds: readonly TeamId[];
    readonly questions: readonly Round1ContentItem[];
  }): Result<true> {
    if (this.#active) {
      return err(rejection('WRONG_STATE', 'Round 1 has already started.'));
    }
    if (input.teamIds.length === 0) {
      return err(rejection('INVALID_REQUEST', 'Round 1 needs participating teams.'));
    }
    if (input.questions.length !== ROUND1_QUESTION_COUNT) {
      return err(
        rejection('INVALID_REQUEST', 'Round 1 needs exactly 15 questions.', {
          found: input.questions.length,
          expected: ROUND1_QUESTION_COUNT,
        }),
      );
    }

    this.#active = true;
    this.#participating = [...input.teamIds];
    this.#phase = 'nominating';

    for (const team of input.teamIds) {
      this.#points.set(team, 0);
      this.#correctCounts.set(team, 0);
      this.#nominees.set(
        team,
        new Map<Round1Difficulty, PlayerId | null>([
          ['EASY', null],
          ['MEDIUM', null],
          ['HARD', null],
        ]),
      );
    }

    this.#questions = input.questions.map((item, index) => ({
      item,
      questionNumber: index + 1,
      phase: 'pending',
      challengeId: null,
      openedAt: null,
      deadline: null,
      answers: new Map(input.teamIds.map((t) => [t, emptyAnswerSlot()])),
      revealedAt: null,
    }));

    return ok(true);
  }

  /**
   * Nominate one team's answerer for one difficulty. §11.
   *
   * NO UNIQUENESS RULE between the three (spec §2 — do not impose one the locked
   * docs do not require). One player may hold all three roles, which a team of
   * two needs.
   *
   * Re-nominating before the round starts is allowed and simply replaces the
   * previous choice; once questions begin, the roster is fixed.
   */
  nominate(input: {
    readonly teamId: TeamId;
    readonly difficulty: Round1Difficulty;
    readonly playerId: PlayerId;
  }): Result<Round1NomineeEntry> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    if (this.#phase !== 'nominating') {
      return err(
        rejection('WRONG_STATE', 'Nominations are closed; Round 1 has started.', {
          phase: this.#phase,
        }),
      );
    }

    const roles = this.#nominees.get(input.teamId);
    if (roles === undefined) {
      return err(rejection('NOT_FOUND', 'That team is not taking part.', { teamId: input.teamId }));
    }

    roles.set(input.difficulty, input.playerId);
    return ok(this.#nomineeEntry(input.teamId));
  }

  /** Whether every participating team has all three nominees. §11, spec §2. */
  nominationsComplete(): boolean {
    return this.#participating.every((team) => {
      const roles = this.#nominees.get(team);
      if (roles === undefined) return false;
      return nomineesComplete({
        EASY: roles.get('EASY') ?? null,
        MEDIUM: roles.get('MEDIUM') ?? null,
        HARD: roles.get('HARD') ?? null,
      });
    });
  }

  /**
   * Close nominations and move to the questions. §11, spec §2.
   *
   * REFUSED while any team is short a nominee. "Do not start Round 1 until every
   * participating team has the required nominees" — and a missing nominee means
   * nobody could legally answer that difficulty, so the question would be
   * unplayable rather than merely awkward.
   */
  startQuestions(): Result<true> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    if (this.#phase !== 'nominating') {
      return err(rejection('WRONG_STATE', 'Round 1 has already started.', { phase: this.#phase }));
    }
    if (!this.nominationsComplete()) {
      const missing = this.#participating.filter((team) => {
        const roles = this.#nominees.get(team);
        return (
          roles === undefined ||
          !nomineesComplete({
            EASY: roles.get('EASY') ?? null,
            MEDIUM: roles.get('MEDIUM') ?? null,
            HARD: roles.get('HARD') ?? null,
          })
        );
      });
      return err(
        rejection('ILLEGAL_ACTION', 'Every team needs an Easy, Medium and Hard nominee.', {
          teamsMissingNominees: missing.join(', '),
          count: missing.length,
        }),
      );
    }

    this.#phase = 'questions';
    return ok(true);
  }

  /** The nominated player for one team and difficulty, or null. */
  nomineeFor(teamId: TeamId, difficulty: Round1Difficulty): PlayerId | null {
    return this.#nominees.get(teamId)?.get(difficulty) ?? null;
  }

  /**
   * Whether a player is currently required to answer. D-021, spec §2.
   *
   * ================== ROUND 1 IS THE FIRST ROUND WITH ACTIVE PLAYERS ==========
   * Rounds 2 and 3 mark nobody software-active, because their challenges are
   * spoken and Host-judged — a sleeping phone changes nothing. Round 1 is
   * different: the nominated player is the ONLY person who can submit, so their
   * phone going dark genuinely stops that team from playing.
   *
   * Scoped to an OPEN question by owner decision: the nominee counts as active
   * only while an answer window is actually running, not during nomination,
   * grading, review or reveal. Pausing at a party is disruptive, and outside an
   * open window there is nothing for the player to do anyway.
   * ============================================================================
   */
  activePlayerIds(): readonly PlayerId[] {
    if (!this.#active) return [];

    const slot = this.#currentQuestion();
    if (slot !== null && slot.phase === 'open') {
      const ids: PlayerId[] = [];
      for (const team of this.#participating) {
        // A team that has already submitted no longer needs its nominee awake.
        if (slot.answers.get(team)?.submission !== null) continue;
        const nominee = this.nomineeFor(team, slot.item.difficulty);
        if (nominee !== null) ids.push(nominee);
      }
      return ids;
    }

    // A running retry window needs exactly the retrying nominees.
    if (slot !== null && slot.phase === 'retry') {
      const ids: PlayerId[] = [];
      for (const team of this.#participating) {
        const answer = slot.answers.get(team);
        if (answer?.retryOpen !== true || answer.retrySubmission !== null) continue;
        const nominee = this.nomineeFor(team, slot.item.difficulty);
        if (nominee !== null) ids.push(nominee);
      }
      return ids;
    }

    const attempt = this.#currentTiebreak();
    if (attempt !== null && attempt.phase === 'open') {
      const ids: PlayerId[] = [];
      for (const team of attempt.participating) {
        if (attempt.answers.get(team)?.submission !== null) continue;
        const nominee = this.nomineeFor(team, attempt.item.difficulty);
        if (nominee !== null) ids.push(nominee);
      }
      return ids;
    }

    return [];
  }

  // -------------------------------------------------------------------------
  // Questions
  // -------------------------------------------------------------------------

  #currentQuestion(): QuestionSlot | null {
    return this.#questions[this.#currentIndex] ?? null;
  }

  /**
   * Reveal the next question and start its 60-second window. §11.
   *
   * Refused while the current question is unfinished, so a Host cannot skip past
   * an ungraded question and strand its scores.
   */
  revealNextQuestion(challengeId: ChallengeId): Result<Round1QuestionView> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    if (this.#phase !== 'questions') {
      return err(
        rejection('WRONG_STATE', 'Round 1 is not asking questions.', { phase: this.#phase }),
      );
    }

    const current = this.#currentQuestion();
    if (current !== null && current.phase !== 'revealed') {
      return err(
        rejection('ILLEGAL_ACTION', 'Finish the current question before moving on.', {
          questionNumber: current.questionNumber,
          phase: current.phase,
        }),
      );
    }

    const next = this.#questions[this.#currentIndex + 1];
    if (next === undefined) {
      return err(
        rejection('ILLEGAL_ACTION', 'All 15 Round 1 questions have been asked.', {
          totalQuestions: ROUND1_QUESTION_COUNT,
        }),
      );
    }

    this.#currentIndex += 1;
    this.#maco = null;
    next.phase = 'open';
    next.challengeId = challengeId;
    next.openedAt = this.#now();
    next.deadline = startDeadline(this.#clock, this.#questionWindowMs);

    return ok(this.#questionView(next, null, null));
  }

  /**
   * One team's nominated player submits. §11, spec §3.
   *
   * ================== SUBMISSION IS FINAL ==================
   * §11 and spec §3 — "Submission is final for that normal attempt... do not
   * allow silent answer replacement." A second submission is REFUSED rather than
   * overwriting, which also makes the intent naturally idempotent-ish: a retried
   * network request cannot change a stored answer.
   *
   * Only the nominee for THIS question's difficulty may submit. Checked here, on
   * the server, because a client hiding the input proves nothing (spec §15).
   */
  submitAnswer(input: {
    readonly teamId: TeamId;
    readonly playerId: PlayerId;
    readonly answer: string;
  }): Result<{ readonly view: Round1QuestionView; readonly isRetry: boolean }> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    const slot = this.#currentQuestion();
    if (slot === null) {
      return err(rejection('WRONG_STATE', 'No Round 1 question is open.'));
    }
    if (!this.#participating.includes(input.teamId)) {
      return err(rejection('NOT_FOUND', 'That team is not taking part.', { teamId: input.teamId }));
    }

    const answer = slot.answers.get(input.teamId);
    /* c8 ignore next 3 -- unreachable: every participating team has a slot. */
    if (answer === undefined) {
      return err(rejection('NOT_FOUND', 'That team has no answer slot.'));
    }

    const nominee = this.nomineeFor(input.teamId, slot.item.difficulty);
    if (nominee !== input.playerId) {
      return err(
        rejection('UNAUTHORIZED_ACTOR', 'Only your team’s nominated answerer may submit this one.', {
          difficulty: slot.item.difficulty,
          nominatedPlayerId: nominee ?? 'none',
        }),
      );
    }

    // A retry window takes precedence: it is the later, narrower opportunity.
    if (slot.phase === 'retry' && answer.retryOpen) {
      if (answer.retrySubmission !== null) {
        return err(rejection('ILLEGAL_ACTION', 'Your retry answer is already in.'));
      }
      if (answer.retryDeadline !== null && hasExpired(this.#clock, answer.retryDeadline)) {
        return err(rejection('ILLEGAL_ACTION', 'The retry window has closed.'));
      }
      answer.retrySubmission = {
        teamId: input.teamId,
        playerId: input.playerId,
        answer: input.answer,
        submittedAt: this.#now(),
        isRetry: true,
      };
      return ok({ view: this.#questionView(slot, null, null), isRetry: true });
    }

    if (slot.phase !== 'open') {
      return err(
        rejection('WRONG_STATE', 'This question is not open for answers.', { phase: slot.phase }),
      );
    }
    if (answer.submission !== null) {
      return err(rejection('ILLEGAL_ACTION', 'Your team has already answered this question.'));
    }
    if (slot.deadline !== null && hasExpired(this.#clock, slot.deadline)) {
      return err(rejection('ILLEGAL_ACTION', 'The 60 seconds are up.'));
    }

    answer.submission = {
      teamId: input.teamId,
      playerId: input.playerId,
      answer: input.answer,
      submittedAt: this.#now(),
      isRetry: false,
    };
    return ok({ view: this.#questionView(slot, null, null), isRetry: false });
  }

  /** Whether the open question's 60 seconds have run out. Polled, not scheduled. */
  questionWindowExpired(): boolean {
    const slot = this.#currentQuestion();
    if (slot === null || slot.phase !== 'open' || slot.deadline === null) return false;
    return hasExpired(this.#clock, slot.deadline);
  }

  /** Whether a running retry window has run out. */
  retryWindowExpired(): boolean {
    const slot = this.#currentQuestion();
    if (slot === null || slot.phase !== 'retry') return false;
    for (const answer of slot.answers.values()) {
      if (!answer.retryOpen || answer.retrySubmission !== null) continue;
      if (answer.retryDeadline !== null && hasExpired(this.#clock, answer.retryDeadline)) {
        return true;
      }
    }
    return false;
  }

  /** Whether a live Maco! viewing has expired and should be dropped. */
  macoExpired(): boolean {
    if (this.#maco === null) return false;
    return hasExpired(this.#clock, this.#maco.deadline);
  }

  /** Drop an expired Maco! viewing. Spec §8, §16 — it must not come back. */
  clearExpiredMaco(): void {
    if (this.macoExpired()) this.#maco = null;
  }

  /**
   * Close the answer window and move to grading. §11, spec §3.
   *
   * Called by the Host early, or by the poll when 60 seconds run out. A team
   * with no submission is treated as having no correct answer — NOT as having
   * answered wrongly, which matters because only a wrong RULING makes FORGIVE
   * MEH! available (§11).
   */
  closeQuestion(): Result<Round1QuestionView> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    const slot = this.#currentQuestion();
    if (slot === null || slot.phase !== 'open') {
      return err(rejection('WRONG_STATE', 'No Round 1 question is open.'));
    }

    slot.phase = 'grading';
    slot.deadline = null;
    this.#maco = null;
    return ok(this.#questionView(slot, null, null));
  }

  /**
   * What still needs grading on the current question.
   *
   * The caller does the actual grading, because grading is async (the semantic
   * judge) and `@bb/game-rules` stays synchronous and clock-free. This reports
   * the work; `recordRuling` takes the answer back.
   */
  pendingGrading(): readonly {
    readonly teamId: TeamId;
    readonly answer: string;
    readonly isRetry: boolean;
  }[] {
    const slot = this.#currentQuestion();
    if (slot === null) return [];

    const out: { teamId: TeamId; answer: string; isRetry: boolean }[] = [];
    for (const [team, answer] of slot.answers) {
      if (slot.phase === 'retry' || answer.retrySubmission !== null) {
        if (answer.retrySubmission !== null && answer.retryRuling === null) {
          out.push({
            teamId: team as TeamId,
            answer: answer.retrySubmission.answer,
            isRetry: true,
          });
        }
        continue;
      }
      if (answer.submission !== null && answer.ruling === null) {
        out.push({ teamId: team as TeamId, answer: answer.submission.answer, isRetry: false });
      }
    }
    return out;
  }

  /** The question currently being graded, for the caller that needs its content. */
  currentItem(): Round1ContentItem | null {
    return this.#currentQuestion()?.item ?? null;
  }

  /**
   * Store a ruling on one team's answer. Spec §4E, §18.
   *
   * ================== STORED, NEVER RECOMPUTED ==================
   * Spec §16 — "re-run stored AI grading unnecessarily" is listed among the
   * things reconnect must NEVER do. So the ruling is written once and read
   * forever after. A repeated call with the same source is refused rather than
   * re-rolling the verdict; only a HOST ruling may replace an existing one, and
   * that is recorded as an override.
   * ==============================================================
   */
  recordRuling(input: {
    readonly teamId: TeamId;
    readonly verdict: Round1Verdict;
    readonly source: Round1GradeSource;
    readonly isRetry: boolean;
  }): Result<Round1TeamAnswerView> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    const slot = this.#currentQuestion();
    if (slot === null) return err(rejection('WRONG_STATE', 'No Round 1 question is running.'));

    const answer = slot.answers.get(input.teamId);
    if (answer === undefined) {
      return err(rejection('NOT_FOUND', 'That team is not taking part.', { teamId: input.teamId }));
    }
    if (slot.phase === 'revealed') {
      return err(rejection('WRONG_STATE', 'This question is already revealed and scored.'));
    }

    const existing = input.isRetry ? answer.retryRuling : answer.ruling;
    const isHost = input.source === 'host';

    if (existing !== null && !isHost) {
      // Automated grading never overwrites a stored ruling. This is the
      // reconnect protection: re-grading could return a different verdict and
      // make a score depend on when a phone woke up.
      return err(
        rejection('ILLEGAL_ACTION', 'That answer already has a final ruling.', {
          teamId: input.teamId,
          verdict: existing.verdict,
        }),
      );
    }

    const ruling: Round1Ruling = {
      verdict: input.verdict,
      source: input.source,
      hostOverrode: isHost && existing !== null && existing.source !== 'host',
      automatedVerdict: existing !== null ? (existing.automatedVerdict ?? existing.verdict) : null,
      decidedAt: this.#now(),
    };

    if (input.isRetry) answer.retryRuling = ruling;
    else answer.ruling = ruling;

    return ok(this.#answerView(slot, input.teamId as TeamId, answer, null, null));
  }

  /** Whether every submitted answer on the current question has a ruling. */
  gradingComplete(): boolean {
    return this.pendingGrading().length === 0;
  }

  /** Teams whose current ruling needs a Host decision. Spec §4E. */
  needsHostReview(): readonly TeamId[] {
    const slot = this.#currentQuestion();
    if (slot === null) return [];

    const out: TeamId[] = [];
    for (const [team, answer] of slot.answers) {
      const ruling = answer.retrySubmission !== null ? answer.retryRuling : answer.ruling;
      if (ruling?.verdict === 'NEEDS_HOST_REVIEW') out.push(team as TeamId);
    }
    return out;
  }

  /**
   * Whether a team may use FORGIVE MEH! right now. §11.
   *
   * "Available after the team's first answer is wrong" — a FINAL incorrect
   * ruling, which is why NEEDS_HOST_REVIEW does not qualify and an unanswered
   * question does not either. The shared one-retry maximum (§4) is enforced by
   * `SharedSystems`, not here; this reports only the Round 1 precondition.
   */
  retryEligible(teamId: TeamId): boolean {
    const slot = this.#currentQuestion();
    if (slot === null) return false;
    if (slot.phase === 'revealed') return false;

    const answer = slot.answers.get(teamId);
    if (answer === undefined) return false;
    if (answer.retryOpen || answer.retrySubmission !== null) return false;

    return answer.ruling?.verdict === 'INCORRECT';
  }

  /**
   * Open a 10-second retry window for one team. §11, D-032.
   *
   * The correct answer stays hidden throughout — the question does not reach
   * `revealed` until every retry has been graded (spec §5).
   */
  openRetry(teamId: TeamId): Result<Round1QuestionView> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    const slot = this.#currentQuestion();
    if (slot === null) return err(rejection('WRONG_STATE', 'No Round 1 question is running.'));

    if (!this.retryEligible(teamId)) {
      return err(
        rejection('ILLEGAL_ACTION', 'That team cannot retry this question.', {
          teamId,
          reason: 'A retry needs a final INCORRECT ruling on the first answer.',
        }),
      );
    }

    const answer = slot.answers.get(teamId);
    /* c8 ignore next -- retryEligible already proved the slot exists. */
    if (answer === undefined) return err(rejection('NOT_FOUND', 'No answer slot.'));

    answer.retryOpen = true;
    answer.retryDeadline = startDeadline(this.#clock, this.#retryWindowMs);
    slot.phase = 'retry';

    return ok(this.#questionView(slot, null, null));
  }

  /** Close every running retry window, submitted or not. */
  closeRetries(): void {
    const slot = this.#currentQuestion();
    if (slot === null) return;
    for (const answer of slot.answers.values()) {
      if (answer.retryOpen) answer.retryDeadline = null;
    }
    if (slot.phase === 'retry') slot.phase = 'grading';
  }

  // -------------------------------------------------------------------------
  // Maco!
  // -------------------------------------------------------------------------

  /**
   * Grant a Maco! viewing. §11, spec §8.
   *
   * ================== WHAT THIS REFUSES, AND WHY ==================
   *   - a target that has not submitted. §11 — "the target team must have
   *     already submitted". A half-typed answer is never exposed, and the only
   *     way to guarantee that is to require a COMPLETED submission.
   *   - the team's own answer, which would reveal nothing.
   *   - a viewer who is not their team's nominee for this difficulty. Only the
   *     nominated player sees it (spec §8).
   * ================================================================
   *
   * Viewing does NOT copy or submit the answer. This returns text for one
   * player to read; nothing else in the class consults it.
   */
  grantMaco(input: {
    readonly viewingTeamId: TeamId;
    readonly viewingPlayerId: PlayerId;
    readonly targetTeamId: TeamId;
  }): Result<Round1MacoView> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    const slot = this.#currentQuestion();
    if (slot === null || (slot.phase !== 'open' && slot.phase !== 'grading')) {
      return err(rejection('WRONG_STATE', 'No Round 1 question is taking answers.'));
    }
    if (input.targetTeamId === input.viewingTeamId) {
      return err(rejection('ILLEGAL_ACTION', 'Maco! targets another team.'));
    }
    if (!this.#participating.includes(input.targetTeamId)) {
      return err(
        rejection('NOT_FOUND', 'That team is not taking part.', { teamId: input.targetTeamId }),
      );
    }

    const nominee = this.nomineeFor(input.viewingTeamId, slot.item.difficulty);
    if (nominee !== input.viewingPlayerId) {
      return err(
        rejection('UNAUTHORIZED_ACTOR', 'Only your nominated answerer may look.', {
          difficulty: slot.item.difficulty,
        }),
      );
    }

    const target = slot.answers.get(input.targetTeamId);
    if (target?.submission === undefined || target.submission === null) {
      return err(
        rejection('ILLEGAL_ACTION', 'That team has not submitted an answer yet.', {
          teamId: input.targetTeamId,
        }),
      );
    }

    const deadline = startDeadline(this.#clock, ROUND1_MACO_VIEW_MS);
    this.#maco = {
      viewingPlayerId: input.viewingPlayerId,
      viewingTeamId: input.viewingTeamId,
      targetTeamId: input.targetTeamId,
      questionNumber: slot.questionNumber,
      expiresAt: asServerTimestamp(this.#clock.now() + ROUND1_MACO_VIEW_MS),
      deadline,
    };

    return ok({
      viewingPlayerId: input.viewingPlayerId,
      viewingTeamId: input.viewingTeamId,
      targetTeamId: input.targetTeamId,
      answer: target.submission.answer,
      expiresAt: this.#maco.expiresAt,
      remainingMs: remainingMs(this.#clock, deadline),
    });
  }

  // -------------------------------------------------------------------------
  // Allyuh Help Me!
  // -------------------------------------------------------------------------

  /**
   * Lean on another team's answer for this question. §11, spec §9.
   *
   * The requesting team's own answer stops mattering for scoring: at resolution
   * the ASSISTING team's graded outcome decides both. Recorded rather than
   * copied — §9 is explicit that the card "shares the grading outcome, not
   * hidden answer text", so the requesting team never receives the words.
   */
  recordAssist(input: {
    readonly requestingTeamId: TeamId;
    readonly assistingTeamId: TeamId;
  }): Result<true> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    const slot = this.#currentQuestion();
    if (slot === null || slot.phase === 'revealed') {
      return err(rejection('WRONG_STATE', 'No Round 1 question is running.'));
    }
    if (input.requestingTeamId === input.assistingTeamId) {
      return err(rejection('ILLEGAL_ACTION', 'ALLYUH HELP ME! targets another team.'));
    }
    if (!this.#participating.includes(input.assistingTeamId)) {
      return err(
        rejection('NOT_FOUND', 'That team is not taking part.', { teamId: input.assistingTeamId }),
      );
    }

    const answer = slot.answers.get(input.requestingTeamId);
    if (answer === undefined) {
      return err(rejection('NOT_FOUND', 'That team is not taking part.'));
    }

    answer.assistedByTeamId = input.assistingTeamId;
    return ok(true);
  }

  // -------------------------------------------------------------------------
  // Scoring and reveal
  // -------------------------------------------------------------------------

  /**
   * What this question should pay each team, WITHOUT applying it.
   *
   * Separate from applying, exactly as Round 2 and Round 3 separate them: the
   * engine needs the amounts before asking the shared systems for a Double It!
   * multiplier and moving BB.
   *
   * ================== ALLYUH HELP ME! PAYS THE BASE ==================
   * §11 and spec §9 — if the assisting team's answer is correct, the requesting
   * team receives the question's NORMAL value. Not the assisting team's doubled
   * value: "Do not double another team's Allyuh Help Me reward merely because
   * the assisting team used Double It." So the assist is computed from
   * `baseValue`, never from the assisting team's award.
   * ==================================================================
   */
  proposedAwards(): readonly {
    readonly teamId: TeamId;
    readonly correct: boolean;
    readonly baseValue: number;
    readonly viaAssist: boolean;
  }[] {
    const slot = this.#currentQuestion();
    if (slot === null) return [];

    const base = ROUND1_VALUES[slot.item.difficulty];
    const out: {
      teamId: TeamId;
      correct: boolean;
      baseValue: number;
      viaAssist: boolean;
    }[] = [];

    for (const team of this.#participating) {
      const answer = slot.answers.get(team);
      /* c8 ignore next */
      if (answer === undefined) continue;

      if (answer.assistedByTeamId !== null) {
        const assisting = slot.answers.get(answer.assistedByTeamId);
        const assistCorrect = this.#finalVerdict(assisting) === 'CORRECT';
        out.push({
          teamId: team,
          correct: assistCorrect,
          baseValue: base,
          viaAssist: true,
        });
        continue;
      }

      out.push({
        teamId: team,
        correct: this.#finalVerdict(answer) === 'CORRECT',
        baseValue: base,
        viaAssist: false,
      });
    }
    return out;
  }

  /** The verdict that counts: the retry's if there was one, else the first. */
  #finalVerdict(answer: AnswerSlot | undefined): Round1Verdict | null {
    if (answer === undefined) return null;
    if (answer.retrySubmission !== null) return answer.retryRuling?.verdict ?? null;
    return answer.ruling?.verdict ?? null;
  }

  /**
   * Apply this question's awards, reveal the answer, and finish it. §11, spec §5.
   *
   * ================== AWARDED EXACTLY ONCE ==================
   * Spec §3 and §17 — no duplicate awards on reconnect, snapshot restore,
   * repeated events, Host refresh or network retries. The `scored` flag makes
   * that structural: a second call finds the question already `revealed` and is
   * refused before touching a single total.
   * ==========================================================
   *
   * The caller has already moved BB through the ledger and passes back what was
   * actually awarded. Round 1 POINTS are applied here, because this class owns
   * them and nothing else does.
   */
  applyAwards(
    awards: readonly {
      readonly teamId: TeamId;
      readonly awardedBb: number;
      readonly awardedPoints: number;
      readonly doubled: boolean;
    }[],
  ): Result<Round1QuestionView> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    const slot = this.#currentQuestion();
    if (slot === null) return err(rejection('WRONG_STATE', 'No Round 1 question is running.'));
    if (slot.phase === 'revealed') {
      return err(
        rejection('ILLEGAL_ACTION', 'This question has already been scored and revealed.', {
          questionNumber: slot.questionNumber,
        }),
      );
    }

    for (const award of awards) {
      const answer = slot.answers.get(award.teamId);
      if (answer === undefined || answer.scored) continue;

      answer.awardedBb = award.awardedBb;
      answer.awardedPoints = award.awardedPoints;
      answer.doubled = award.doubled;
      answer.scored = true;

      // THE ROUND 1 POINT TOTAL. Separate from BB, which the engine moved.
      if (award.awardedPoints > 0) {
        this.#points.set(award.teamId, (this.#points.get(award.teamId) ?? 0) + award.awardedPoints);
        this.#correctCounts.set(
          award.teamId,
          (this.#correctCounts.get(award.teamId) ?? 0) + 1,
        );
      }
    }

    slot.phase = 'revealed';
    slot.revealedAt = this.#now();
    slot.deadline = null;
    this.#maco = null;

    return ok(this.#questionView(slot, null, null));
  }

  /** Whether all 15 questions have been asked and revealed. */
  get questionsComplete(): boolean {
    return (
      this.#questions.length > 0 && this.#questions.every((slot) => slot.phase === 'revealed')
    );
  }

  // -------------------------------------------------------------------------
  // Winner and the sudden-death tiebreak
  // -------------------------------------------------------------------------

  /** Teams tied on the highest Round 1 point total. */
  leaders(): readonly TeamId[] {
    let best = -1;
    for (const team of this.#participating) {
      const points = this.#points.get(team) ?? 0;
      if (points > best) best = points;
    }
    return this.#participating.filter((t) => (this.#points.get(t) ?? 0) === best);
  }

  /**
   * Decide the Round 1 winner after all 15 questions. §11, D-032.
   *
   * ⚠ DECIDED ON ROUND 1 POINTS, NOT BB. Spec §11 — "Do not resolve the winner
   * using overall BB balance." The two totals usually agree, but BB also moves
   * in the Market, so they can genuinely differ.
   */
  decideWinner(): Result<{
    readonly winningTeamId: TeamId | null;
    readonly needsTiebreak: boolean;
    readonly leaders: readonly TeamId[];
  }> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    if (!this.questionsComplete) {
      return err(
        rejection('WRONG_STATE', 'Round 1 is not finished.', {
          questionsAsked: this.questionsAsked,
          totalQuestions: ROUND1_QUESTION_COUNT,
        }),
      );
    }
    if (this.#winner !== null) {
      return ok({ winningTeamId: this.#winner, needsTiebreak: false, leaders: [] });
    }

    const leaders = this.leaders();
    if (leaders.length === 1) {
      this.#winner = leaders[0] ?? null;
      this.#phase = 'complete';
      return ok({ winningTeamId: this.#winner, needsTiebreak: false, leaders });
    }

    this.#tiedTeams = [...leaders];
    this.#tiebreakActive = [...leaders];
    this.#phase = 'tiebreak';
    return ok({ winningTeamId: null, needsTiebreak: true, leaders });
  }

  #currentTiebreak(): TiebreakAttempt | null {
    const last = this.#tiebreakAttempts[this.#tiebreakAttempts.length - 1];
    return last === undefined ? null : last;
  }

  /**
   * Start one sudden-death tiebreak question. D-032, spec §12.
   *
   * Each attempt is 30 seconds, asks every still-tied team the same question,
   * and moves NO BB and NO Round 1 points. The content comes from the caller,
   * through the same abstraction as the main questions.
   */
  startTiebreakAttempt(item: Round1ContentItem): Result<Round1TiebreakAttemptView> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);

    if (this.#phase !== 'tiebreak') {
      return err(
        rejection('WRONG_STATE', 'Round 1 is not in a tiebreak.', { phase: this.#phase }),
      );
    }
    if (this.#tiebreakComplete) {
      return err(rejection('WRONG_STATE', 'The tiebreak is already decided.'));
    }

    const current = this.#currentTiebreak();
    if (current !== null && !current.revealed) {
      return err(
        rejection('ILLEGAL_ACTION', 'Finish the current tiebreak question first.', {
          attemptNumber: current.attemptNumber,
        }),
      );
    }

    const attempt: TiebreakAttempt = {
      attemptNumber: this.#tiebreakAttempts.length + 1,
      item,
      participating: [...this.#tiebreakActive],
      phase: 'open',
      deadline: startDeadline(this.#clock, this.#tiebreakWindowMs),
      answers: new Map(this.#tiebreakActive.map((t) => [t, emptyAnswerSlot()])),
      eliminated: [],
      outcome: null,
      explanation: null,
      revealed: false,
    };
    this.#tiebreakAttempts.push(attempt);

    return ok(this.#tiebreakAttemptView(attempt, null));
  }

  /** A tied team's nominee submits a tiebreak answer. */
  submitTiebreakAnswer(input: {
    readonly teamId: TeamId;
    readonly playerId: PlayerId;
    readonly answer: string;
  }): Result<Round1TiebreakAttemptView> {
    const attempt = this.#currentTiebreak();
    if (attempt === null || attempt.phase !== 'open') {
      return err(rejection('WRONG_STATE', 'No tiebreak question is open.'));
    }
    if (!attempt.participating.includes(input.teamId)) {
      return err(
        rejection('ILLEGAL_ACTION', 'Your team is not in the tiebreak.', { teamId: input.teamId }),
      );
    }

    // Spec §12 — reuse the Round 1 nominee architecture for the tiebreak
    // answerer, keyed on the supplied item's difficulty. No new captain system.
    const nominee = this.nomineeFor(input.teamId, attempt.item.difficulty);
    if (nominee !== input.playerId) {
      return err(
        rejection('UNAUTHORIZED_ACTOR', 'Only your nominated answerer may submit.', {
          difficulty: attempt.item.difficulty,
          nominatedPlayerId: nominee ?? 'none',
        }),
      );
    }

    const answer = attempt.answers.get(input.teamId);
    /* c8 ignore next */
    if (answer === undefined) return err(rejection('NOT_FOUND', 'No answer slot.'));
    if (answer.submission !== null) {
      return err(rejection('ILLEGAL_ACTION', 'Your team has already answered.'));
    }
    if (attempt.deadline !== null && hasExpired(this.#clock, attempt.deadline)) {
      return err(rejection('ILLEGAL_ACTION', 'The tiebreak window has closed.'));
    }

    answer.submission = {
      teamId: input.teamId,
      playerId: input.playerId,
      answer: input.answer,
      submittedAt: this.#now(),
      isRetry: false,
    };
    return ok(this.#tiebreakAttemptView(attempt, null));
  }

  /** Whether the open tiebreak window has run out. */
  tiebreakWindowExpired(): boolean {
    const attempt = this.#currentTiebreak();
    if (attempt === null || attempt.phase !== 'open' || attempt.deadline === null) return false;
    return hasExpired(this.#clock, attempt.deadline);
  }

  /** Close the tiebreak window and move to grading. */
  closeTiebreakAttempt(): Result<Round1TiebreakAttemptView> {
    const attempt = this.#currentTiebreak();
    if (attempt === null || attempt.phase !== 'open') {
      return err(rejection('WRONG_STATE', 'No tiebreak question is open.'));
    }
    attempt.phase = 'grading';
    attempt.deadline = null;
    return ok(this.#tiebreakAttemptView(attempt, null));
  }

  /** What still needs grading in the current tiebreak attempt. */
  pendingTiebreakGrading(): readonly { readonly teamId: TeamId; readonly answer: string }[] {
    const attempt = this.#currentTiebreak();
    if (attempt === null) return [];

    const out: { teamId: TeamId; answer: string }[] = [];
    for (const [team, answer] of attempt.answers) {
      if (answer.submission !== null && answer.ruling === null) {
        out.push({ teamId: team as TeamId, answer: answer.submission.answer });
      }
    }
    return out;
  }

  /** The tiebreak item being graded. */
  currentTiebreakItem(): Round1ContentItem | null {
    return this.#currentTiebreak()?.item ?? null;
  }

  /** Store a ruling on one tiebreak answer. Same stored-ruling discipline. */
  recordTiebreakRuling(input: {
    readonly teamId: TeamId;
    readonly verdict: Round1Verdict;
    readonly source: Round1GradeSource;
  }): Result<true> {
    const attempt = this.#currentTiebreak();
    if (attempt === null || attempt.revealed) {
      return err(rejection('WRONG_STATE', 'No tiebreak question is being graded.'));
    }

    const answer = attempt.answers.get(input.teamId);
    if (answer === undefined) {
      return err(rejection('NOT_FOUND', 'That team is not in the tiebreak.'));
    }

    const isHost = input.source === 'host';
    if (answer.ruling !== null && !isHost) {
      return err(rejection('ILLEGAL_ACTION', 'That answer already has a final ruling.'));
    }

    answer.ruling = {
      verdict: input.verdict,
      source: input.source,
      hostOverrode: isHost && answer.ruling !== null && answer.ruling.source !== 'host',
      automatedVerdict:
        answer.ruling !== null ? (answer.ruling.automatedVerdict ?? answer.ruling.verdict) : null,
      decidedAt: this.#now(),
    };
    return ok(true);
  }

  /**
   * Resolve one tiebreak attempt. D-032, spec §12.
   *
   * ================== THE FOUR CASES ==================
   *   exactly one correct  -> that team WINS Round 1
   *   some correct         -> the incorrect teams are ELIMINATED; the rest continue
   *   all correct          -> nothing separates them; REPLAY with everyone
   *   none correct         -> nothing separates them; REPLAY with everyone
   *
   * The two replay cases are deliberately identical in effect and deliberately
   * kept as separate readings, because they are different situations at the
   * table and the Host's explanation should say which happened.
   * ====================================================
   *
   * ⚠ NOTHING HERE TOUCHES BB OR ROUND 1 POINTS. Spec §12 — the tiebreak exists
   * only to eliminate tied teams. Those totals are already final.
   */
  resolveTiebreakAttempt(): Result<Round1TiebreakAttemptView> {
    const attempt = this.#currentTiebreak();
    if (attempt === null || attempt.revealed) {
      return err(rejection('WRONG_STATE', 'No tiebreak question is open.'));
    }
    if (this.pendingTiebreakGrading().length > 0) {
      return err(rejection('WRONG_STATE', 'Not every tiebreak answer has been graded.'));
    }

    const correct = attempt.participating.filter(
      (t) => attempt.answers.get(t)?.ruling?.verdict === 'CORRECT',
    );
    const incorrect = attempt.participating.filter((t) => !correct.includes(t));

    attempt.revealed = true;
    attempt.phase = 'revealed';

    if (correct.length === 1) {
      attempt.outcome = 'winner';
      attempt.explanation = 'One team answered correctly. That team wins Round 1.';
      this.#tiebreakActive = [...correct];
      this.#tiebreakComplete = true;
      this.#winner = correct[0] ?? null;
      this.#phase = 'complete';
    } else if (correct.length === 0) {
      attempt.outcome = 'replay';
      attempt.explanation = 'Nobody answered correctly. Everyone plays again.';
    } else if (incorrect.length === 0) {
      attempt.outcome = 'replay';
      attempt.explanation = 'Everyone answered correctly. Everyone plays again.';
    } else {
      attempt.outcome = 'elimination';
      attempt.eliminated = [...incorrect];
      attempt.explanation =
        incorrect.length === 1
          ? 'That team is out; the rest play again.'
          : 'Those teams are out; the rest play again.';
      this.#tiebreakActive = [...correct];
    }

    return ok(this.#tiebreakAttemptView(attempt, attempt.outcome));
  }

  // -------------------------------------------------------------------------
  // Pause / resume. D-011.
  // -------------------------------------------------------------------------

  pauseWindows(): void {
    const slot = this.#currentQuestion();
    if (slot !== null) {
      if (slot.deadline !== null) slot.deadline = pauseDeadline(this.#clock, slot.deadline);
      for (const answer of slot.answers.values()) {
        if (answer.retryDeadline !== null) {
          answer.retryDeadline = pauseDeadline(this.#clock, answer.retryDeadline);
        }
      }
    }
    if (this.#maco !== null) {
      this.#maco.deadline = pauseDeadline(this.#clock, this.#maco.deadline);
    }
    const attempt = this.#currentTiebreak();
    if (attempt !== null && attempt.deadline !== null) {
      attempt.deadline = pauseDeadline(this.#clock, attempt.deadline);
    }
  }

  resumeWindows(): void {
    const slot = this.#currentQuestion();
    if (slot !== null) {
      if (slot.deadline !== null) slot.deadline = resumeDeadline(this.#clock, slot.deadline);
      for (const answer of slot.answers.values()) {
        if (answer.retryDeadline !== null) {
          answer.retryDeadline = resumeDeadline(this.#clock, answer.retryDeadline);
        }
      }
    }
    if (this.#maco !== null) {
      this.#maco.deadline = resumeDeadline(this.#clock, this.#maco.deadline);
    }
    const attempt = this.#currentTiebreak();
    if (attempt !== null && attempt.deadline !== null) {
      attempt.deadline = resumeDeadline(this.#clock, attempt.deadline);
    }
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  #requireActive(): Rejection | null {
    if (!this.#active) return rejection('WRONG_STATE', 'Round 1 has not started.');
    return null;
  }

  #now(): ServerTimestamp {
    return asServerTimestamp(this.#clock.now());
  }

  #nomineeEntry(teamId: TeamId): Round1NomineeEntry {
    const roles = this.#nominees.get(teamId);
    const easy = roles?.get('EASY') ?? null;
    const medium = roles?.get('MEDIUM') ?? null;
    const hard = roles?.get('HARD') ?? null;
    return {
      teamId,
      easyPlayerId: easy,
      mediumPlayerId: medium,
      hardPlayerId: hard,
      complete: nomineesComplete({ EASY: easy, MEDIUM: medium, HARD: hard }),
    };
  }

  /**
   * One team's answer, scoped to who is asking.
   *
   * ================== WHO MAY SEE THE TEXT ==================
   * The submitted words are visible to:
   *   - the team that wrote them, always,
   *   - everyone, once the question is REVEALED,
   *   - a Maco! viewer, for ten seconds, for one target team,
   *   - the Host (forTeam === null with hostView), who must grade them.
   *
   * Nobody else, in any phase. This is the single place that decision is made.
   * ==========================================================
   */
  #answerView(
    slot: QuestionSlot,
    teamId: TeamId,
    answer: AnswerSlot,
    forTeam: TeamId | null,
    forPlayer: PlayerId | null,
    hostView = false,
  ): Round1TeamAnswerView {
    const submission = answer.retrySubmission ?? answer.submission;
    const ruling = answer.retrySubmission !== null ? answer.retryRuling : answer.ruling;

    const isOwnTeam = forTeam !== null && forTeam === teamId;
    const revealed = slot.phase === 'revealed';
    const macoEntitled =
      this.#maco !== null &&
      this.#maco.targetTeamId === teamId &&
      this.#maco.questionNumber === slot.questionNumber &&
      forPlayer !== null &&
      this.#maco.viewingPlayerId === forPlayer &&
      !hasExpired(this.#clock, this.#maco.deadline);

    const maySeeText = isOwnTeam || revealed || hostView || macoEntitled;

    const assisting: TeamId[] = [];
    for (const [other, otherAnswer] of slot.answers) {
      if (otherAnswer.assistedByTeamId === teamId) assisting.push(other as TeamId);
    }

    return {
      teamId,
      submitted: answer.submission !== null,
      answer: maySeeText ? (submission?.answer ?? null) : null,
      // A verdict is public once revealed, and known to its own team and the
      // Host before that. It is not the answer TEXT, so it leaks nothing.
      verdict: revealed || isOwnTeam || hostView ? (ruling?.verdict ?? null) : null,
      source: revealed || hostView ? (ruling?.source ?? null) : null,
      hostOverrode: ruling?.hostOverrode ?? false,
      usedRetry: answer.retrySubmission !== null || answer.retryOpen,
      awardedBb: answer.awardedBb,
      awardedPoints: answer.awardedPoints,
      doubled: answer.doubled,
      assistedByTeamId: answer.assistedByTeamId,
      assistingTeamIds: assisting,
    };
  }

  #questionView(
    slot: QuestionSlot,
    forTeam: TeamId | null,
    forPlayer: PlayerId | null,
    hostView = false,
  ): Round1QuestionView {
    const answers: Round1TeamAnswerView[] = [];
    for (const [team, answer] of slot.answers) {
      answers.push(this.#answerView(slot, team as TeamId, answer, forTeam, forPlayer, hostView));
    }

    return {
      questionNumber: slot.questionNumber,
      totalQuestions: ROUND1_QUESTION_COUNT,
      itemId: slot.item.itemId,
      difficulty: slot.item.difficulty,
      prompt: slot.item.prompt,
      value: ROUND1_VALUES[slot.item.difficulty],
      phase: slot.phase,
      remainingMs:
        slot.deadline === null ? null : Math.max(0, remainingMs(this.#clock, slot.deadline)),
      deadlineAt: slot.openedAt,
      // ⚠ THE ONE PLACE THE CANONICAL ANSWER CROSSES THE VIEW BOUNDARY, and only
      // once the question is revealed. §11, spec §5.
      correctAnswer: slot.phase === 'revealed' ? slot.item.canonicalAnswer : null,
      answers,
      challengeId: slot.challengeId,
    };
  }

  #tiebreakAttemptView(
    attempt: TiebreakAttempt,
    outcome: 'winner' | 'elimination' | 'replay' | null,
    forTeam: TeamId | null = null,
    hostView = false,
  ): Round1TiebreakAttemptView {
    const answers: Round1TeamAnswerView[] = [];
    for (const [team, answer] of attempt.answers) {
      const isOwnTeam = forTeam !== null && forTeam === (team as TeamId);
      const maySeeText = isOwnTeam || attempt.revealed || hostView;
      answers.push({
        teamId: team as TeamId,
        submitted: answer.submission !== null,
        answer: maySeeText ? (answer.submission?.answer ?? null) : null,
        verdict:
          attempt.revealed || isOwnTeam || hostView ? (answer.ruling?.verdict ?? null) : null,
        source: attempt.revealed || hostView ? (answer.ruling?.source ?? null) : null,
        hostOverrode: answer.ruling?.hostOverrode ?? false,
        usedRetry: false,
        // ⚠ ALWAYS ZERO. Spec §12 — a tiebreak question moves no BB and no
        // Round 1 points. These fields exist because the view is shared with
        // the normal questions; they are never written here.
        awardedBb: 0,
        awardedPoints: 0,
        doubled: false,
        assistedByTeamId: null,
        assistingTeamIds: [],
      });
    }

    return {
      attemptNumber: attempt.attemptNumber,
      itemId: attempt.item.itemId,
      prompt: attempt.item.prompt,
      difficulty: attempt.item.difficulty,
      phase: attempt.phase,
      remainingMs:
        attempt.deadline === null
          ? null
          : Math.max(0, remainingMs(this.#clock, attempt.deadline)),
      participatingTeamIds: [...attempt.participating],
      answers,
      correctAnswer: attempt.revealed ? attempt.item.canonicalAnswer : null,
      eliminatedTeamIds: [...attempt.eliminated],
      outcome: outcome ?? attempt.outcome,
      explanation: attempt.explanation,
    };
  }

  #tiebreakView(forTeam: TeamId | null, hostView: boolean): Round1TiebreakView | null {
    if (this.#tiedTeams.length === 0) return null;
    const current = this.#currentTiebreak();
    return {
      tiedTeamIds: [...this.#tiedTeams],
      activeTeamIds: [...this.#tiebreakActive],
      current:
        current === null
          ? null
          : this.#tiebreakAttemptView(current, current.outcome, forTeam, hostView),
      history: this.#tiebreakAttempts
        .filter((a) => a.revealed)
        .map((a) => this.#tiebreakAttemptView(a, a.outcome, forTeam, hostView)),
      complete: this.#tiebreakComplete,
      winningTeamId: this.#winner,
    };
  }

  standings(): readonly Round1StandingView[] {
    return [...this.#participating]
      .map((teamId) => ({
        teamId,
        points: this.#points.get(teamId) ?? 0,
        correctCount: this.#correctCounts.get(teamId) ?? 0,
      }))
      .sort((a, b) => b.points - a.points);
  }

  /**
   * Round 1 as one viewer sees it.
   *
   * `forTeam` and `forPlayer` scope the answer text, the nominee role and the
   * Maco! viewing. `hostView` gives the Host the submitted answers, which they
   * need in order to grade — and only the Host.
   */
  view(
    forTeam: TeamId | null = null,
    forPlayer: PlayerId | null = null,
    hostView = false,
  ): Round1StateView {
    const slot = this.#currentQuestion();
    const points: Record<string, number> = {};
    const pointList: { teamId: TeamId; value: number }[] = [];
    for (const [team, value] of this.#points) {
      points[team] = value;
      // The same numbers twice: a Record the web reads, and a list Unity can.
      // JsonUtility has no dictionary support.
      pointList.push({ teamId: team as TeamId, value });
    }

    // The viewer's own nominee role, if any.
    let yourRole: Round1Difficulty | null = null;
    if (forTeam !== null && forPlayer !== null) {
      for (const difficulty of ['EASY', 'MEDIUM', 'HARD'] as const) {
        if (this.nomineeFor(forTeam, difficulty) === forPlayer) {
          yourRole = difficulty;
          break;
        }
      }
    }

    const youMaySubmit =
      slot !== null &&
      forTeam !== null &&
      forPlayer !== null &&
      this.nomineeFor(forTeam, slot.item.difficulty) === forPlayer &&
      ((slot.phase === 'open' && (slot.answers.get(forTeam)?.submission ?? null) === null) ||
        (slot.phase === 'retry' &&
          slot.answers.get(forTeam)?.retryOpen === true &&
          (slot.answers.get(forTeam)?.retrySubmission ?? null) === null));

    // The Maco! viewing goes to exactly one player, and only while it lives.
    let macoView: Round1MacoView | null = null;
    const maco = this.#maco;
    if (
      maco !== null &&
      forPlayer !== null &&
      maco.viewingPlayerId === forPlayer &&
      !hasExpired(this.#clock, maco.deadline) &&
      slot !== null &&
      maco.questionNumber === slot.questionNumber
    ) {
      const targetSubmission = slot.answers.get(maco.targetTeamId)?.submission ?? null;
      if (targetSubmission !== null) {
        macoView = {
          viewingPlayerId: maco.viewingPlayerId,
          viewingTeamId: maco.viewingTeamId,
          targetTeamId: maco.targetTeamId,
          answer: targetSubmission.answer,
          expiresAt: maco.expiresAt,
          remainingMs: Math.max(0, remainingMs(this.#clock, maco.deadline)),
        };
      }
    }

    return {
      roundIndex: ROUND1_ROUND_INDEX,
      phase: this.#phase,
      nominees: this.#participating.map((t) => this.#nomineeEntry(t)),
      nominationsComplete: this.nominationsComplete(),
      participatingTeamIds: [...this.#participating],
      current: slot === null ? null : this.#questionView(slot, forTeam, forPlayer, hostView),
      questionsAsked: this.questionsAsked,
      totalQuestions: ROUND1_QUESTION_COUNT,
      points,
      pointList,
      standings: this.standings(),
      tiebreak: this.#tiebreakView(forTeam, hostView),
      winningTeamId: this.#winner,
      yourNomineeRole: yourRole,
      youMaySubmit,
      macoView,
    };
  }
}
