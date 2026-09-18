import type { CardChallengeKind } from './cards.js';
import type { ChallengeId, PlayerId, ServerTimestamp, TeamId } from './ids.js';

/**
 * Round 1 — "Nah, That Too Easy!". Phase 7C.
 *
 * GAME_RULES_LOCKED.md §11, DECISION_LOG.md D-030 and D-032.
 *
 * ================== SIMULTANEOUS, NOT TURN-BASED ==============================
 * Every team answers the SAME question at the SAME time (§11). D-002 previously
 * locked the opposite — teams taking turns on different questions — and D-030
 * superseded it. That change is why Gimme Dat! and Doh Know are no longer legal
 * here (nothing is individually assigned to steal or pass) and why Maco! now is
 * (there is a submitted opponent answer to look at).
 * ==============================================================================
 *
 * ================== TWO TOTALS, ONE CORRECT ANSWER ============================
 * A correct answer awards its value TWICE over, to two different things:
 *
 *   BB               the game's score and currency, kept for the rest of the
 *                    game, spent in the Market, compared in §1
 *   Round 1 points   a separate running total that decides ONLY the Round 1
 *                    winner
 *
 * They are not two BB transactions and neither is derived from the other. The
 * Round 1 winner is decided on points; the game is won on BB. A team can win
 * Round 1 and still trail on BB, because BB moves in the Market too.
 * ==============================================================================
 *
 * ================== WHAT A PLAYER NEVER RECEIVES ==============================
 * The canonical answer before the reveal, any accepted variant, any future
 * question, and any other team's submitted text. `Round1QuestionView` has no
 * field for the first three, and the fourth is scoped per team — CONTENT_POLICY.md
 * again makes the absence the protection rather than trusting a filter.
 *
 * The ONE deliberate exception is Maco! (§11): one nominated player, for ten
 * seconds, sees one already-submitted opponent answer.
 * ==============================================================================
 */

// ---------------------------------------------------------------------------
// Difficulty and values
// ---------------------------------------------------------------------------

/**
 * The three difficulties. GAME_RULES_LOCKED.md §11.
 *
 * Order matters here only for display; the content source decides the order
 * questions are actually asked in, and §11 does NOT require Easy→Medium→Hard.
 */
export const ROUND1_DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'] as const;

export type Round1Difficulty = (typeof ROUND1_DIFFICULTIES)[number];

/** Whether a client-supplied string names a difficulty. */
export function isRound1Difficulty(value: string): value is Round1Difficulty {
  return (ROUND1_DIFFICULTIES as readonly string[]).includes(value);
}

/**
 * What each difficulty is worth. §11.
 *
 * ONE number per difficulty, awarded as BOTH BB and Round 1 points. Writing it
 * once is deliberate: two constants could drift, and a drift would silently
 * break the rule that the two totals mirror each other.
 *
 * These replaced the old 100/200/300 values with D-030.
 */
export const ROUND1_VALUES: Readonly<Record<Round1Difficulty, number>> = {
  EASY: 20,
  MEDIUM: 30,
  HARD: 50,
} as const;

/** How many questions of each difficulty. §11 — 5 Easy, 5 Medium, 5 Hard. */
export const ROUND1_QUESTIONS_PER_DIFFICULTY = 5;

/** 15 normal questions. §11. Derived so the two can never disagree. */
export const ROUND1_QUESTION_COUNT =
  ROUND1_DIFFICULTIES.length * ROUND1_QUESTIONS_PER_DIFFICULTY;

export const ROUND1_ROUND_INDEX = 1;

/** Seconds per normal question. §11 — 60 seconds. */
export const ROUND1_QUESTION_WINDOW_MS = 60_000;

/**
 * The FORGIVE MEH! retry window. §11, D-032.
 *
 * `OPEN_RULES.md` §13 left this open through Phase 7B, listing "remainder of the
 * original 60 seconds" and "a fresh, shorter window" as the candidates. The
 * owner chose a fresh 10-second window (D-032), which is what this is.
 */
export const ROUND1_RETRY_WINDOW_MS = 10_000;

/** How long a Maco! viewer sees a submitted answer. §3, §11 — 10 seconds. */
export const ROUND1_MACO_VIEW_MS = 10_000;

/** The sudden-death tiebreak answer window. D-032 — 30 seconds. */
export const ROUND1_TIEBREAK_WINDOW_MS = 30_000;

/** Round 1's row in the locked card table (§6). */
export const ROUND1_CARD_CHALLENGE_KIND: CardChallengeKind = 'ROUND1_TRIVIA';

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/**
 * Content lifecycle. CONTENT_POLICY.md.
 *
 * EXAMPLE and TEST can never become PRODUCTION_SEALED, which a loader enforces;
 * the type exists so a server configured for production content can refuse to
 * serve a fixture rather than discovering the mix-up during a game.
 */
export const CONTENT_STATUSES = [
  'EXAMPLE',
  'TEST',
  'PRODUCTION_SEALED',
  'PRODUCTION_REVEALED',
  'RETIRED',
] as const;

export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/**
 * One trivia question, AS THE SERVER HOLDS IT.
 *
 * ⚠ THIS TYPE NEVER GOES TO A CLIENT. It carries the canonical answer and the
 * accepted variants, which is exactly what must not leave the server before the
 * reveal. `Round1QuestionView` is the client-facing shape and has no field for
 * either — see the note at the top of this file.
 */
export interface Round1ContentItem {
  readonly itemId: string;
  readonly difficulty: Round1Difficulty;
  /** The question as read aloud and shown on screen. */
  readonly prompt: string;
  /** The single canonical answer, for grading. NEVER sent before the reveal. */
  readonly canonicalAnswer: string;
  /** Approved equivalents. Also graded, also never sent before the reveal. */
  readonly acceptedVariants?: readonly string[];
  readonly category?: string;
  readonly status: ContentStatus;
  readonly source?: string;
}

/** A pack of questions for one difficulty, or a mixed tiebreak pack. */
export interface Round1ContentPack {
  readonly packId: string;
  readonly status: ContentStatus;
  readonly source: string;
  readonly items: readonly Round1ContentItem[];
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/**
 * How an answer was judged. Phase 7C spec §4.
 *
 *   exact       normalised text matched the canonical answer or a variant
 *   fuzzy       a conservative edit-distance match caught an obvious typo
 *   semantic    the AI judge recognised an equivalent phrasing
 *   host        a Host ruling — the final authority either way
 *   timeout     no answer was submitted before the deadline
 *
 * The source is recorded alongside the verdict because §4E requires knowing
 * whether the Host overrode an automated ruling, which needs both.
 */
export const ROUND1_GRADE_SOURCES = [
  'exact',
  'fuzzy',
  'semantic',
  'host',
  'timeout',
] as const;

export type Round1GradeSource = (typeof ROUND1_GRADE_SOURCES)[number];

/**
 * The verdict. Phase 7C spec §4D requires exactly these three.
 *
 * NEEDS_HOST_REVIEW is a real outcome, not an error path: the AI judge returns
 * it when unavailable, slow, malformed or unsure, and D-022's discipline applies
 * — the machine does not guess, it hands the decision to the Host.
 */
export const ROUND1_VERDICTS = ['CORRECT', 'INCORRECT', 'NEEDS_HOST_REVIEW'] as const;

export type Round1Verdict = (typeof ROUND1_VERDICTS)[number];

/**
 * A stored, FINAL ruling on one answer.
 *
 * Stored rather than recomputed, which is the whole point: §4E and §16 require
 * that a reconnect, a snapshot or a Host refresh reuse this and never re-grade.
 * Re-grading would re-invoke the AI judge, could return a different verdict, and
 * would make a score depend on when someone's phone woke up.
 */
export interface Round1Ruling {
  readonly verdict: Round1Verdict;
  readonly source: Round1GradeSource;
  /** True when a Host ruling replaced an automated one. §4E. */
  readonly hostOverrode: boolean;
  /** The automated verdict before any Host override, for the record. */
  readonly automatedVerdict: Round1Verdict | null;
  readonly decidedAt: ServerTimestamp;
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

/**
 * One team's answer to one question, as the SERVER holds it.
 *
 * ⚠ Contains the submitted text, which belongs to that team alone until the
 * reveal. `Round1TeamAnswerView` is the scoped client shape.
 */
export interface Round1Submission {
  readonly teamId: TeamId;
  readonly playerId: PlayerId;
  readonly answer: string;
  readonly submittedAt: ServerTimestamp;
  /** True for a FORGIVE MEH!/Second Chance retry answer. §11, §4. */
  readonly isRetry: boolean;
}

/**
 * One team's outcome on one question, as a client may see it.
 *
 * The `answer` field is populated only where the viewer is entitled to it: the
 * team's own answer at any time, everyone's after the reveal, and a Maco!
 * target's answer to exactly one nominated player for ten seconds.
 */
export interface Round1TeamAnswerView {
  readonly teamId: TeamId;
  readonly submitted: boolean;
  /** Null unless the viewer is entitled to the text. */
  readonly answer: string | null;
  readonly verdict: Round1Verdict | null;
  readonly source: Round1GradeSource | null;
  readonly hostOverrode: boolean;
  readonly usedRetry: boolean;
  /**
   * A FORGIVE MEH! retry window is OPEN for this team right now.
   *
   * Distinct from `usedRetry`, which stays true afterwards. This one is true
   * only while the team may still type, and is what drives the retry countdown.
   */
  readonly retryOpen: boolean;
  /**
   * Milliseconds left in THIS TEAM'S retry window, or null when none is open.
   *
   * Per-team rather than on the question, because §11 gives the retry to one
   * team at a time and each window starts when the Host opens it. The
   * question's own `remainingMs` is the 60-second window and is null by now.
   */
  readonly retryRemainingMs: number | null;
  /**
   * Whether the NEXT ruling for this team should land on the retry answer.
   *
   * ================== WHY THE SERVER DECIDES THIS ==================
   * A Host pressing CORRECT/WRONG means "rule on the answer I am looking at",
   * and which storage slot that is depends on state the Host cannot see. When
   * a retry answer is in and ungraded, the ruling belongs to the RETRY slot;
   * otherwise it belongs to the first answer.
   *
   * Phase 7C originally read this from the client payload, and the Unity panel
   * never sent it — so every ruling during a retry silently landed on the first
   * answer and the retry stayed un-ruled forever, blocking the reveal. The
   * server computes it now, and the client does not get a say.
   * =================================================================
   */
  readonly rulingTargetsRetry: boolean;
  /** BB awarded for this question. Doubled where Double It! applied. */
  readonly awardedBb: number;
  /** Round 1 points awarded. Mirrors `awardedBb`, and is NOT the same total. */
  readonly awardedPoints: number;
  readonly doubled: boolean;
  /** The team this one is leaning on, if ALLYUH HELP ME! was played. §11. */
  readonly assistedByTeamId: TeamId | null;
  /** True when this team's answer is being used by another team. */
  readonly assistingTeamIds: readonly TeamId[];
}

// ---------------------------------------------------------------------------
// Nominees
// ---------------------------------------------------------------------------

/**
 * A team's three nominated answerers. §11.
 *
 * PLAYER IDS, NEVER DISPLAY NAMES. Phase 7C spec §2 is explicit, and the reason
 * is reconnect: a display name is not an identity, two players can share one,
 * and a rename mid-game must not silently move the right to answer.
 *
 * Null means not yet nominated. Round 1 cannot start until all three are set for
 * every participating team (§2).
 */
export interface Round1Nominees {
  readonly teamId: TeamId;
  readonly EASY: PlayerId | null;
  readonly MEDIUM: PlayerId | null;
  readonly HARD: PlayerId | null;
  readonly complete: boolean;
}

/**
 * Whether one team's nominations are finished.
 *
 * NO UNIQUENESS RULE. Spec §2 — "Do not impose a new uniqueness rule between
 * Easy/Medium/Hard nominees unless the locked docs already require one", and
 * §11 does not. One player may hold all three roles, which matters for a small
 * team of two.
 */
export function nomineesComplete(n: {
  readonly EASY: PlayerId | null;
  readonly MEDIUM: PlayerId | null;
  readonly HARD: PlayerId | null;
}): boolean {
  return n.EASY !== null && n.MEDIUM !== null && n.HARD !== null;
}

// ---------------------------------------------------------------------------
// Question phases
// ---------------------------------------------------------------------------

/**
 * Where one question is in its life. §11, spec §5.
 *
 * The reveal is LAST, and deliberately so: the correct answer must stay hidden
 * until grading, Host review and any retry have all finished, or a retrying
 * player would be handed the answer they are about to give.
 *
 *   pending     not yet asked
 *   open        60-second window running; nominees may submit
 *   grading     window closed; answers being graded
 *   host_review at least one answer needs a Host ruling
 *   retry       a FORGIVE MEH!/Second Chance retry window is running
 *   revealed    the canonical answer is public and scores are final
 */
export const ROUND1_QUESTION_PHASES = [
  'pending',
  'open',
  'grading',
  'host_review',
  'retry',
  'revealed',
] as const;

export type Round1QuestionPhase = (typeof ROUND1_QUESTION_PHASES)[number];

/**
 * The current question, as a client may see it.
 *
 * ⚠ NO CANONICAL ANSWER FIELD BEFORE THE REVEAL. `correctAnswer` is null in
 * every phase but `revealed`, and the server populates it only at that point.
 * There is no accepted-variants field at all, and no field for any other
 * question — the queue never leaves the server.
 */
export interface Round1QuestionView {
  /** 1-based, for "Question 4 / 15". */
  readonly questionNumber: number;
  readonly totalQuestions: number;
  readonly itemId: string;
  readonly difficulty: Round1Difficulty;
  readonly prompt: string;
  /** BB for a correct answer, before any Double It!. */
  readonly value: number;
  readonly phase: Round1QuestionPhase;
  readonly remainingMs: number | null;
  readonly deadlineAt: ServerTimestamp | null;
  /** Populated ONLY in the `revealed` phase. Null everywhere else. */
  readonly correctAnswer: string | null;
  readonly answers: readonly Round1TeamAnswerView[];
  readonly challengeId: ChallengeId | null;
}

// ---------------------------------------------------------------------------
// Maco!
// ---------------------------------------------------------------------------

/**
 * A live Maco! viewing entitlement. §11, spec §8.
 *
 * Scoped to ONE player and ONE question, and it expires. A reconnect after
 * expiry must not recreate it (spec §8, §16), which is why the deadline is
 * stored rather than the viewing being a fire-and-forget event.
 */
export interface Round1MacoView {
  readonly viewingPlayerId: PlayerId;
  readonly viewingTeamId: TeamId;
  readonly targetTeamId: TeamId;
  /** The target's submitted answer. Only ever sent to `viewingPlayerId`. */
  readonly answer: string;
  readonly expiresAt: ServerTimestamp;
  readonly remainingMs: number;
}

// ---------------------------------------------------------------------------
// Tiebreak
// ---------------------------------------------------------------------------

/**
 * The Round 1 sudden-death trivia tiebreak. D-032.
 *
 * ⚠ THIS IS NOT §21's END-OF-GAME SUDDEN DEATH. Spec §12 requires them kept
 * architecturally and semantically distinct, and they genuinely are different
 * games: §21 needs two consecutive correct answers, uses the phone buzzer, and
 * wins the whole game. This eliminates teams tied on Round 1 points, uses
 * free-text answers, and only decides who won Round 1.
 *
 * Nothing here moves BB, and nothing here changes a team's Round 1 points —
 * those totals are already final when the tiebreak starts.
 */
export interface Round1TiebreakAttemptView {
  readonly attemptNumber: number;
  readonly itemId: string;
  readonly prompt: string;
  readonly difficulty: Round1Difficulty;
  readonly phase: Round1QuestionPhase;
  readonly remainingMs: number | null;
  readonly participatingTeamIds: readonly TeamId[];
  readonly answers: readonly Round1TeamAnswerView[];
  /** Populated only once this attempt has been revealed. */
  readonly correctAnswer: string | null;
  readonly eliminatedTeamIds: readonly TeamId[];
  readonly outcome: 'winner' | 'elimination' | 'replay' | null;
  readonly explanation: string | null;
}

export interface Round1TiebreakView {
  readonly tiedTeamIds: readonly TeamId[];
  readonly activeTeamIds: readonly TeamId[];
  readonly current: Round1TiebreakAttemptView | null;
  readonly history: readonly Round1TiebreakAttemptView[];
  readonly complete: boolean;
  readonly winningTeamId: TeamId | null;
}

// ---------------------------------------------------------------------------
// Round state
// ---------------------------------------------------------------------------

/** One team's Round 1 standing. */
export interface Round1StandingView {
  readonly teamId: TeamId;
  /** The Round 1 points total. NOT BB. Decides the Round 1 winner. */
  readonly points: number;
  readonly correctCount: number;
}

/** A serialisable pair, for Unity. JsonUtility cannot read a dictionary. */
export interface Round1TeamCount {
  readonly teamId: TeamId;
  readonly value: number;
}

/** A team's nominees, flattened for Unity's serialiser. */
export interface Round1NomineeEntry {
  readonly teamId: TeamId;
  readonly easyPlayerId: PlayerId | null;
  readonly mediumPlayerId: PlayerId | null;
  readonly hardPlayerId: PlayerId | null;
  readonly complete: boolean;
}

/** Where the round as a whole is. */
export const ROUND1_PHASES = ['nominating', 'questions', 'tiebreak', 'complete'] as const;

export type Round1Phase = (typeof ROUND1_PHASES)[number];

/**
 * Round 1 as clients see it.
 *
 * Scoped per viewer: `yourNomineeRole`, `yourTeamAnswer` and `macoView` depend
 * on who is asking. Everything else — the current question, the standings, whose
 * turn it is to be waited on — is public, which is what a party game puts on a
 * TV.
 */
export interface Round1StateView {
  readonly roundIndex: typeof ROUND1_ROUND_INDEX;
  readonly phase: Round1Phase;
  readonly nominees: readonly Round1NomineeEntry[];
  readonly nominationsComplete: boolean;
  readonly participatingTeamIds: readonly TeamId[];

  readonly current: Round1QuestionView | null;
  readonly questionsAsked: number;
  readonly totalQuestions: number;

  /** Round 1 points. A Record for the web. */
  readonly points: Record<string, number>;
  /** The same numbers as a list, because Unity cannot deserialise the Record. */
  readonly pointList: readonly Round1TeamCount[];
  readonly standings: readonly Round1StandingView[];

  readonly tiebreak: Round1TiebreakView | null;
  readonly winningTeamId: TeamId | null;

  // --- Scoped to the asking viewer ----------------------------------------
  /** Which difficulty this player answers for their team, if any. */
  readonly yourNomineeRole: Round1Difficulty | null;
  /** True when this player may submit for the CURRENT question right now. */
  readonly youMaySubmit: boolean;
  /** A live Maco! viewing, for this player only. Null for everyone else. */
  readonly macoView: Round1MacoView | null;
}

// ---------------------------------------------------------------------------
// Wire vocabulary
// ---------------------------------------------------------------------------

export const ROUND1_INTENTS = {
  /** Host or player nominates an answerer for one difficulty. */
  NOMINATE_ANSWERER: 'NOMINATE_ANSWERER',
  HOST_START_ROUND1: 'HOST_START_ROUND1',
  /** Host reveals the next question and starts its 60-second window. */
  HOST_NEXT_ROUND1_QUESTION: 'HOST_NEXT_ROUND1_QUESTION',
  /** The nominated player submits the team's answer. Final. */
  SUBMIT_ROUND1_ANSWER: 'SUBMIT_ROUND1_ANSWER',
  /**
   * Look at one opponent's already-submitted answer. §11, D-030.
   *
   * PLAYER intent, and only the nominated answerer for the current difficulty.
   * Carries `targetTeamId`; the viewing team and player come from the
   * connection, never the payload.
   *
   * Separate from PLAY_BACCHANAL_CARD deliberately: that intent commits the
   * CARD (and opens a Clash window on it), while this one performs the card's
   * EFFECT once it has resolved. Collapsing them would mean a Clash could not
   * cancel a Maco before it revealed anything.
   */
  VIEW_ROUND1_MACO: 'VIEW_ROUND1_MACO',
  /** Host closes the window early and starts grading. */
  HOST_CLOSE_ROUND1_QUESTION: 'HOST_CLOSE_ROUND1_QUESTION',
  /** Host rules on one team's answer. §4E. */
  HOST_RULE_ROUND1_ANSWER: 'HOST_RULE_ROUND1_ANSWER',
  /** Host opens the FORGIVE MEH! retry window for an eligible team. */
  HOST_OPEN_ROUND1_RETRY: 'HOST_OPEN_ROUND1_RETRY',
  /** Host reveals the correct answer and finalises scoring. */
  HOST_REVEAL_ROUND1_ANSWER: 'HOST_REVEAL_ROUND1_ANSWER',
  /** Host starts the sudden-death tiebreak. */
  HOST_START_ROUND1_TIEBREAK: 'HOST_START_ROUND1_TIEBREAK',
  /** DEVELOPMENT ONLY. Refused unless dev tools are enabled. */
  DEV_START_ROUND1: 'DEV_START_ROUND1',
} as const;

export const ROUND1_EVENTS = {
  ROUND1_STARTED: 'ROUND1_STARTED',
  ROUND1_NOMINEE_SET: 'ROUND1_NOMINEE_SET',
  ROUND1_QUESTION_REVEALED: 'ROUND1_QUESTION_REVEALED',
  ROUND1_ANSWER_SUBMITTED: 'ROUND1_ANSWER_SUBMITTED',
  ROUND1_QUESTION_CLOSED: 'ROUND1_QUESTION_CLOSED',
  ROUND1_ANSWER_GRADED: 'ROUND1_ANSWER_GRADED',
  ROUND1_HOST_REVIEW_REQUIRED: 'ROUND1_HOST_REVIEW_REQUIRED',
  ROUND1_RETRY_OPENED: 'ROUND1_RETRY_OPENED',
  ROUND1_ANSWER_REVEALED: 'ROUND1_ANSWER_REVEALED',
  ROUND1_SCORES_AWARDED: 'ROUND1_SCORES_AWARDED',
  ROUND1_MACO_VIEWED: 'ROUND1_MACO_VIEWED',
  ROUND1_TIEBREAK_STARTED: 'ROUND1_TIEBREAK_STARTED',
  ROUND1_TIEBREAK_RESOLVED: 'ROUND1_TIEBREAK_RESOLVED',
  ROUND1_WINNER_CONFIRMED: 'ROUND1_WINNER_CONFIRMED',
  ROUND1_COMPLETED: 'ROUND1_COMPLETED',
} as const;
