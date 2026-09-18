import type { ServerTimestamp, TeamId } from './ids.js';

/**
 * Round 4 — Family Feud. Phase 7D-A.
 *
 * GAME_RULES_LOCKED.md §19 (Family Feud) and §20 (Three-Team Round 4).
 * DECISION_LOG.md D-008 and D-033.
 *
 * ================== FAMILY FEUD IS THE FIRST BUZZER SECTION ====================
 * CLAUDE.md's Buzzer Rule: "Family Feud is the first main game section using
 * the phone buzzer." Nothing before it may use a digital buzzer, and this file
 * is where that changes — deliberately, and only here.
 * ================================================================================
 *
 * ================== THE BOARD IS SERVER-ONLY UNTIL REVEALED ====================
 * A survey holds ranked answers with values. `Round4BoardAnswerView` never
 * carries an unrevealed answer's text or value — the shape is the protection,
 * the same discipline `Round3ItemView` and `Round1QuestionView` already use.
 * Player and Unity snapshots see only what has been revealed, the running
 * accumulated pot, strikes, and whose turn it is.
 * ================================================================================
 *
 * ================== THREE COUNTERS, KEPT SEPARATE ==============================
 *   accumulated survey points  -> ONE survey's running pot. Reset every survey.
 *   the steal wager            -> a separate stake, resolved through the
 *                                 existing generic wager (deals.ts) — no new
 *                                 wager type is invented here.
 *   BB                         -> the game's score. Paid only when a survey
 *                                 resolves (steal, or the controlling team
 *                                 clears the board).
 * ================================================================================
 */

// ---------------------------------------------------------------------------
// Round index and matchups
// ---------------------------------------------------------------------------

export const ROUND4_ROUND_INDEX = 4;

/**
 * The three-team matchup slots. D-008 / §20.
 *
 *   FIRST   entering-2nd vs entering-3rd. Plays the first two surveys.
 *   FINAL   the FIRST matchup's advancing team vs entering-1st. Plays the
 *           remaining surveys.
 *
 * Two-team games have exactly one matchup, `FINAL`, contested by both teams —
 * modelled the same way so a two-team game is not a special case of this file.
 */
export const ROUND4_MATCHUP_STAGES = ['FIRST', 'FINAL'] as const;

export type Round4MatchupStage = (typeof ROUND4_MATCHUP_STAGES)[number];

/**
 * One seat in a matchup, tied to the FROZEN entering rank rather than a live
 * standing. §20 step 1 — "Rank teams by BB entering Round 4" — and that
 * ranking must never re-seed itself when BB later changes (a locked
 * consequence of steps 4-6: the loser of the first matchup keeps playing the
 * rest of the game on a frozen placement, not a live one).
 */
export const ROUND4_ENTERING_RANKS = ['FIRST', 'SECOND', 'THIRD'] as const;

export type Round4EnteringRank = (typeof ROUND4_ENTERING_RANKS)[number];

/**
 * A team's frozen entering standing. Captured ONCE when Round 4 begins.
 *
 * `rank` is never recomputed from a live balance — that is the whole point of
 * "freeze the entering ranking so later BB changes never retroactively
 * re-seed" from the phase brief, and a literal reading of §20's ordered steps.
 */
export interface Round4EnteringStanding {
  readonly teamId: TeamId;
  readonly rank: Round4EnteringRank;
  readonly enteringBb: number;
}

/**
 * Whether a team may still earn Family Feud BB.
 *
 * §20 step 6 — the loser of the FIRST matchup "cannot earn further Family Feud
 * BB for remainder of Round 4". It is NOT removed from the game (step 4 — "loser
 * remains in game"): it keeps its team, its cards, and every BB already earned.
 * This is a scoring gate, not an elimination.
 */
export interface Round4ScoringGate {
  readonly teamId: TeamId;
  readonly gated: boolean;
  /** Which matchup produced the gate, for the Host's own record. */
  readonly gatedAtStage: Round4MatchupStage | null;
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/**
 * One ranked board answer, as the CONTENT SOURCE / server holds it.
 *
 * Never sent whole to a client. `rank` is 1-based, 1 being the highest-value
 * answer — the one that wins a face-off outright (§19).
 */
export interface Round4BoardAnswer {
  readonly answerId: string;
  readonly rank: number;
  readonly text: string;
  readonly value: number;
  /** Approved alternate phrasings that also match this answer. */
  readonly variants?: readonly string[];
}

/**
 * One survey, as the CONTENT SOURCE holds it.
 *
 * `questionNumber` is 1-5 (this matchup's position in the whole Round 4
 * running order, not per-survey-within-matchup) purely so Q4/Q5 doubling
 * (§19) can be applied from data rather than a hardcoded index compare.
 */
export interface Round4Survey {
  readonly surveyId: string;
  readonly prompt: string;
  readonly questionNumber: number;
  readonly answers: readonly Round4BoardAnswer[];
  /** `TEST` during development. CONTENT_POLICY.md statuses. */
  readonly status: string;
  /** Where it came from, for audit. Never shown to players. */
  readonly source: string;
}

/** One board answer as a client may see it — before or after reveal. */
export interface Round4BoardAnswerView {
  readonly answerId: string;
  readonly rank: number;
  readonly revealed: boolean;
  /** Null until revealed. CONTENT SAFETY — the shape is the protection. */
  readonly text: string | null;
  readonly value: number | null;
  /**
   * True once Steups! has removed this answer from the DEFENDING team's pool
   * for the rest of this survey. §19 / OPEN_RULES.md §8.
   */
  readonly steupsRemoved: boolean;
  /** The team barred from reusing this answer this survey, if any. */
  readonly steupsRemovedForTeamId: TeamId | null;
}

/** The board as a client sees it: current reveal state, never the hidden rest. */
export interface Round4BoardView {
  readonly surveyId: string;
  readonly prompt: string;
  readonly questionNumber: number;
  readonly answerCount: number;
  readonly answers: readonly Round4BoardAnswerView[];
  /** Whether Q4/Q5 doubling applies to this survey. §19. */
  readonly doubled: boolean;
  /** Running pot for the survey still in play. Paid out once, on resolution. */
  readonly accumulatedPoints: number;
  readonly strikes: number;
  /**
   * Defaults to 3 (§19), but the Host may choose a different ceiling once,
   * for the whole of Round 4, at entry — not a per-locked-rule constant
   * anymore. See `Round4Options.maxStrikes`.
   */
  readonly maxStrikes: number;
}

// ---------------------------------------------------------------------------
// Face-off
// ---------------------------------------------------------------------------

export const ROUND4_FACEOFF_STATUSES = [
  /** The Host is reading; the buzzer is live. */
  'reading',
  /** A team has buzzed and has its 3-second answer window. */
  'buzzed',
  /** The first answer did not win outright; the opponent gets one shot. */
  'opponent_chance',
  /** The face-off is decided; awaiting PLAY or PASS. */
  'decided',
  /** PLAY or PASS has been chosen; normal board play begins. */
  'complete',
] as const;

export type Round4FaceoffStatus = (typeof ROUND4_FACEOFF_STATUSES)[number];

export const ROUND4_PLAY_DECISIONS = ['PLAY', 'PASS'] as const;

export type Round4PlayDecision = (typeof ROUND4_PLAY_DECISIONS)[number];

/**
 * An authoritative Round 4 deadline, as a client sees it.
 *
 * Mirrors `TimerView` (game.ts) deliberately — same fields, same "server
 * computes `remainingMs` at send time, a client may count down locally between
 * updates for smoothness but never decides expiry" contract
 * (ARCHITECTURE.md §6). A separate type rather than reusing `TimerView`
 * itself only because `game.ts` already imports FROM `round4.ts`
 * (`GameSessionView.round4: Round4StateView`), and importing back would be
 * circular; the shape is intentionally identical.
 *
 * `remainingMs` reflects `pauseDeadline`/`resumeDeadline` (D-011): pausing
 * freezes it, resuming restores the exact remaining time, and a plain
 * snapshot refresh recomputes the same countdown rather than restarting it —
 * the underlying `Deadline` only carries `startedAt` plus accumulated pause
 * time, never a value that changes on read.
 */
export interface Round4TimerView {
  readonly durationMs: number;
  readonly remainingMs: number;
  readonly paused: boolean;
  readonly expired: boolean;
  /** Server time this deadline started. For display only. */
  readonly startedAt: ServerTimestamp;
}

/**
 * The face-off, as a client sees it.
 *
 * Never carries which rank a submitted answer matched, until the face-off is
 * decided — matching the "no hidden board leaks" discipline even during an
 * in-progress face-off answer.
 */
export interface Round4FaceoffView {
  readonly status: Round4FaceoffStatus;
  readonly participantTeamIds: readonly [TeamId, TeamId];
  readonly buzzedTeamId: TeamId | null;
  readonly buzzedAt: ServerTimestamp | null;
  /** Set once the first answer is judged and did not win outright. */
  readonly opponentTeamId: TeamId | null;
  readonly winningTeamId: TeamId | null;
  readonly playDecision: Round4PlayDecision | null;
  /** The live 3-second answer window. Null when nobody currently holds it. */
  readonly answerTimer: Round4TimerView | null;
}

// ---------------------------------------------------------------------------
// Normal board play
// ---------------------------------------------------------------------------

export const ROUND4_STRIKE_REASONS = ['wrong', 'duplicate', 'off_board', 'timeout'] as const;

export type Round4StrikeReason = (typeof ROUND4_STRIKE_REASONS)[number];

/** Board play, as a client sees it. Null outside normal board play. */
export interface Round4BoardPlayView {
  readonly controllingTeamId: TeamId;
  /** Player order for the controlling team, as supplied by the Host/room. */
  readonly playerOrder: readonly string[];
  readonly currentPlayerIndex: number;
  readonly strikes: number;
  /**
   * The live 5-second turn window. Null only in the impossible-in-practice
   * case the engine's own `turnDeadline` is unset — board play always starts
   * one and re-starts it every turn, but the underlying field is nullable so
   * this mirrors that rather than asserting a narrower guarantee than the
   * engine actually makes.
   */
  readonly turnTimer: Round4TimerView | null;
}

// ---------------------------------------------------------------------------
// Steal
// ---------------------------------------------------------------------------

export const ROUND4_STEAL_STATUSES = [
  'conferring',
  'awaiting_wager',
  'awaiting_answer',
  'resolved',
] as const;

export type Round4StealStatus = (typeof ROUND4_STEAL_STATUSES)[number];

/** The steal, as a client sees it. Null outside a steal. */
export interface Round4StealView {
  readonly status: Round4StealStatus;
  readonly stealingTeamId: TeamId;
  readonly defendingTeamId: TeamId;
  readonly wagerId: string | null;
  readonly wagerAmount: number | null;
  readonly maxWager: number | null;
  readonly resolved: boolean;
  readonly won: boolean | null;
  /** The live 30-second confer/answer window. Null once resolved. */
  readonly conferTimer: Round4TimerView | null;
}

// ---------------------------------------------------------------------------
// Survey lifecycle
// ---------------------------------------------------------------------------

export const ROUND4_SURVEY_PROGRESS = [
  'not_started',
  'faceoff',
  'board_play',
  'steal',
  'resolved',
] as const;

export type Round4SurveyProgress = (typeof ROUND4_SURVEY_PROGRESS)[number];

/** One survey as a client sees it, folding in the board, face-off and steal. */
export interface Round4SurveyView {
  readonly progress: Round4SurveyProgress;
  readonly board: Round4BoardView;
  readonly faceoff: Round4FaceoffView | null;
  readonly boardPlay: Round4BoardPlayView | null;
  readonly steal: Round4StealView | null;
  readonly resolvedWinnerTeamId: TeamId | null;
  readonly awardedBb: number | null;
  readonly resolvedAt: ServerTimestamp | null;
}

/** The whole Round 4 state a client needs. */
export interface Round4StateView {
  readonly roundIndex: typeof ROUND4_ROUND_INDEX;
  /** Frozen once, at Round 4 entry. §20 step 1. */
  readonly enteringStandings: readonly Round4EnteringStanding[];
  readonly matchupStage: Round4MatchupStage | null;
  /** The two teams contesting the CURRENT matchup. */
  readonly matchupTeamIds: readonly TeamId[];
  /** The team sitting out the current matchup, in a 3-team game. Never null's opposite of a 2-team game — it is simply null there. */
  readonly inactiveTeamId: TeamId | null;
  readonly scoringGates: readonly Round4ScoringGate[];
  readonly surveysPlayedInMatchup: number;
  readonly current: Round4SurveyView | null;
  readonly complete: boolean;
  readonly matchupWinnerTeamId: TeamId | null;
  readonly round4WinnerTeamId: TeamId | null;
}

// ---------------------------------------------------------------------------
// Content source
// ---------------------------------------------------------------------------

/** A pack of surveys. Mirrors `Round3ContentPack`'s shape and intent. */
export interface Round4ContentPack {
  readonly status: string;
  readonly source: string;
  readonly surveys: readonly Round4Survey[];
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/**
 * Round 4 intents.
 *
 * `SUBMIT_BUZZ` is the first PLAYER-originated digital buzzer intent in the
 * whole game (CLAUDE.md Buzzer Rule). Board answers and steal answers are also
 * player intents — the team that is on the board or stealing answers for
 * itself, not the Host typing on its behalf — but every scoring judgement
 * (valid/duplicate/off-board, face-off winner, steal result) is Host-confirmed,
 * exactly like Round 1 and Round 3's Host-authority answers.
 */
export const ROUND4_INTENTS = {
  /**
   * Host begins Round 4: freezes the entering ranking and sets up the FIRST
   * matchup. Optional `maxStrikes` (payload) sets the strike ceiling for the
   * WHOLE of Round 4, once, at entry — defaults to 3 (§19) if omitted.
   */
  HOST_BEGIN_ROUND4: 'HOST_BEGIN_ROUND4',
  /** Host reveals the next survey and opens the face-off buzzer. */
  HOST_START_FACEOFF: 'HOST_START_FACEOFF',
  /** PLAYER: a face-off participant buzzes in. */
  SUBMIT_BUZZ: 'SUBMIT_BUZZ',
  /** PLAYER: the buzzed-in team's (or the opponent's one-shot) face-off answer. */
  SUBMIT_FACEOFF_ANSWER: 'SUBMIT_FACEOFF_ANSWER',
  /** Host rules a submitted face-off answer against the board. */
  HOST_RULE_FACEOFF_ANSWER: 'HOST_RULE_FACEOFF_ANSWER',
  /**
   * Host starts the opponent's one-shot 3-second answer window.
   *
   * Live play: after the buzzer winner's answer misses #1, the clock does not
   * start itself — often the opponent's chance is a formality the Host wants
   * to control the pace of, or may judge is not even needed. Refused if the
   * timer is already running and unexpired, or if no opponent chance is open.
   */
  HOST_START_OPPONENT_CHANCE_TIMER: 'HOST_START_OPPONENT_CHANCE_TIMER',
  /** PLAYER: the face-off winner chooses PLAY or PASS. */
  CHOOSE_PLAY_OR_PASS: 'CHOOSE_PLAY_OR_PASS',
  /**
   * Host starts the current board turn's 5-second answer window.
   *
   * Live play: answers are spoken aloud, not typed, so the Host poses the
   * question and only THEN starts the clock — never automatic. Refused if a
   * turn's timer is already running and unexpired.
   */
  HOST_START_BOARD_TURN_TIMER: 'HOST_START_BOARD_TURN_TIMER',
  /**
   * Host cancels the running board turn timer WITHOUT recording a strike.
   *
   * Live play: someone answered live before the 5-second window ran out, so
   * the Host stops the clock to rule the answer instead of racing it. A
   * no-op if no timer is currently running.
   */
  HOST_CANCEL_BOARD_TURN_TIMER: 'HOST_CANCEL_BOARD_TURN_TIMER',
  /** PLAYER: the active board player's answer. Optional — see HOST_RULE_BOARD_ANSWER for live/spoken play. */
  SUBMIT_BOARD_ANSWER: 'SUBMIT_BOARD_ANSWER',
  /** Host rules a submitted board answer against the board, OR directly names which answer was spoken. */
  HOST_RULE_BOARD_ANSWER: 'HOST_RULE_BOARD_ANSWER',
  /** Host records a strike directly (timeout, or an off-board Host call with no matcher run). */
  HOST_RECORD_STRIKE: 'HOST_RECORD_STRIKE',
  /**
   * Host directly sets the strike count for the current board turn — live
   * jurisdiction to correct a mistaken call at any time, not only via
   * HOST_RECORD_STRIKE's one-at-a-time increment. Floored at 0.
   */
  HOST_SET_STRIKES: 'HOST_SET_STRIKES',
  /**
   * Host starts the steal's 30-second confer/answer window.
   *
   * Live play: the Host announces the steal to the stealing team, THEN
   * starts the clock. Refused if the timer is already running and unexpired.
   */
  HOST_START_STEAL_TIMER: 'HOST_START_STEAL_TIMER',
  /** PLAYER: the stealing team locks its wager (may be 0). */
  SUBMIT_STEAL_WAGER: 'SUBMIT_STEAL_WAGER',
  /** PLAYER: the stealing team's one final answer. */
  SUBMIT_STEAL_ANSWER: 'SUBMIT_STEAL_ANSWER',
  /** Host rules the steal answer and settles the wager and board points. */
  HOST_RULE_STEAL_ANSWER: 'HOST_RULE_STEAL_ANSWER',
  /** DEVELOPMENT ONLY — enter Round 4 without playing Rounds 1-3. */
  DEV_START_ROUND4: 'DEV_START_ROUND4',
} as const;

export type Round4IntentType = (typeof ROUND4_INTENTS)[keyof typeof ROUND4_INTENTS];

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const ROUND4_EVENTS = {
  ROUND4_STARTED: 'ROUND4_STARTED',
  ROUND4_SURVEY_REVEALED: 'ROUND4_SURVEY_REVEALED',
  ROUND4_FACEOFF_BUZZED: 'ROUND4_FACEOFF_BUZZED',
  ROUND4_FACEOFF_ANSWER_SUBMITTED: 'ROUND4_FACEOFF_ANSWER_SUBMITTED',
  /** Host starts the opponent's one-shot 3s clock. Live play, Host-paced. */
  ROUND4_OPPONENT_CHANCE_TIMER_STARTED: 'ROUND4_OPPONENT_CHANCE_TIMER_STARTED',
  ROUND4_FACEOFF_RESOLVED: 'ROUND4_FACEOFF_RESOLVED',
  ROUND4_PLAY_OR_PASS_CHOSEN: 'ROUND4_PLAY_OR_PASS_CHOSEN',
  /** Host starts the current board turn's 5s clock. Live play: spoken answers, Host-paced. */
  ROUND4_BOARD_TURN_TIMER_STARTED: 'ROUND4_BOARD_TURN_TIMER_STARTED',
  /** Host cancels the running board turn timer without recording a strike. */
  ROUND4_BOARD_TURN_TIMER_CANCELLED: 'ROUND4_BOARD_TURN_TIMER_CANCELLED',
  ROUND4_BOARD_ANSWER_REVEALED: 'ROUND4_BOARD_ANSWER_REVEALED',
  ROUND4_STRIKE_RECORDED: 'ROUND4_STRIKE_RECORDED',
  /** Host directly sets the strike count — live jurisdiction, any time. */
  ROUND4_STRIKES_SET: 'ROUND4_STRIKES_SET',
  ROUND4_STEAL_STARTED: 'ROUND4_STEAL_STARTED',
  /** Host starts the steal's 30s confer/answer clock. */
  ROUND4_STEAL_TIMER_STARTED: 'ROUND4_STEAL_TIMER_STARTED',
  ROUND4_STEAL_WAGER_LOCKED: 'ROUND4_STEAL_WAGER_LOCKED',
  ROUND4_STEAL_RESOLVED: 'ROUND4_STEAL_RESOLVED',
  ROUND4_SURVEY_RESOLVED: 'ROUND4_SURVEY_RESOLVED',
  ROUND4_MATCHUP_RESOLVED: 'ROUND4_MATCHUP_RESOLVED',
  ROUND4_COMPLETED: 'ROUND4_COMPLETED',
} as const;

export type Round4EventType = (typeof ROUND4_EVENTS)[keyof typeof ROUND4_EVENTS];

// ---------------------------------------------------------------------------
// Locked constants
// ---------------------------------------------------------------------------

/** §19 — no separate countdown before the buzzer; only these three durations are locked. */
export const ROUND4_FACEOFF_ANSWER_MS = 3_000;
export const ROUND4_BOARD_TURN_MS = 5_000;
export const ROUND4_STEAL_CONFER_MS = 30_000;

/** §19 — three strikes hands the opposing team a steal. */
export const ROUND4_MAX_STRIKES = 3;

/** §19 — Q4 and Q5 are already doubled, applied once. */
export const ROUND4_DOUBLED_QUESTION_NUMBERS: readonly number[] = [4, 5];

export function isRound4DoubledQuestion(questionNumber: number): boolean {
  return ROUND4_DOUBLED_QUESTION_NUMBERS.includes(questionNumber);
}
