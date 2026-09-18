import type { ServerTimestamp, TeamId } from './ids.js';
import type { Round4BoardAnswer, Round4Survey, Round4TimerView } from './round4.js';

/**
 * Sudden Death. Phase 7D-B2.
 *
 * GAME_RULES_LOCKED.md §21, replaced by DECISION_LOG.md D-034 during live
 * playtesting — the original locked format (individual questions, first to
 * two consecutive correct answers) is GONE, not layered under. The new
 * format is a face-off sequence: same mechanic as Round 4's own face-off
 * (§19) — buzzer opens while the Host reads, first valid buzz locks out the
 * other side, that team has a timed answer window and must give the #1
 * board answer to win the face-off outright. Unlike a normal Round 4
 * face-off, there is no opponent's-chance fallback: a wrong answer or a
 * buzz-then-timeout loses THAT face-off immediately, and if neither team
 * answers validly nothing is decided — a fresh face-off follows.
 *
 * The first team to win two face-offs IN A ROW (a loss resets the streak)
 * wins Sudden Death, and the game.
 *
 * REUSES `Round4Survey`/`Round4BoardAnswer` rather than inventing a parallel
 * content shape — a Sudden Death "question" is structurally identical to a
 * Family Feud survey (a ranked board of answers), the locked rule text
 * itself says "the #1 board answer."
 *
 * NO CARDS, NO MARKET, NO MACO MAIL, NO WAGERS, NO MULTIPLIERS (§21,
 * unchanged by D-034) — `packages/protocol/src/cards.ts`'s
 * `CARD_ELIGIBILITY.SUDDEN_DEATH: []` already enforces the card side of this.
 *
 * ================== THE BOARD IS SERVER-ONLY UNTIL REVEALED ====================
 * Same discipline as Round 4's own board — `SuddenDeathFaceoffView` never
 * carries the board's answers at all except the one that decided the
 * face-off, and only once decided.
 * ================================================================================
 */

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export const SUDDEN_DEATH_ROUND_INDEX = 5;

/** Locked at 3s by default (D-034 / OPEN_RULES.md §11) — reuses Round 4's own face-off window since the exact duration remains configuration-driven, not independently locked. */
export const SUDDEN_DEATH_ANSWER_MS = 3_000;

// ---------------------------------------------------------------------------
// Face-off
// ---------------------------------------------------------------------------

export const SUDDEN_DEATH_FACEOFF_STATUSES = [
  /** The Host is reading; the buzzer is live. */
  'reading',
  /** A team has buzzed and has its timed answer window. */
  'buzzed',
  /** Decided — someone won, or neither side answered validly. */
  'decided',
] as const;

export type SuddenDeathFaceoffStatus = (typeof SUDDEN_DEATH_FACEOFF_STATUSES)[number];

/**
 * One face-off, as a client sees it. Never carries the board's answers
 * except the one that decided it (and only once decided) — same secrecy
 * discipline as Round 4's own board.
 */
export interface SuddenDeathFaceoffView {
  readonly status: SuddenDeathFaceoffStatus;
  readonly prompt: string;
  readonly participantTeamIds: readonly [TeamId, TeamId];
  readonly buzzedTeamId: TeamId | null;
  readonly buzzedAt: ServerTimestamp | null;
  readonly answerTimer: Round4TimerView | null;
  /** Set once decided. Null if neither side answered validly this face-off. */
  readonly winningTeamId: TeamId | null;
  /** True when neither side answered validly — nothing decided, a fresh face-off follows. */
  readonly noDecision: boolean;
}

// ---------------------------------------------------------------------------
// Overall state
// ---------------------------------------------------------------------------

/** One team's current consecutive-win streak. Resets to 0 on any loss. */
export interface SuddenDeathStreak {
  readonly teamId: TeamId;
  readonly consecutiveWins: number;
}

/** The whole Sudden Death state a client needs. */
export interface SuddenDeathStateView {
  readonly roundIndex: typeof SUDDEN_DEATH_ROUND_INDEX;
  readonly participantTeamIds: readonly TeamId[];
  readonly streaks: readonly SuddenDeathStreak[];
  readonly current: SuddenDeathFaceoffView | null;
  readonly complete: boolean;
  readonly winnerTeamId: TeamId | null;
}

export type { Round4BoardAnswer, Round4Survey };

// ---------------------------------------------------------------------------
// Intents / events
// ---------------------------------------------------------------------------

export const SUDDEN_DEATH_INTENTS = {
  /**
   * Host begins Sudden Death between exactly two named teams. Callable at
   * ANY point the Host chooses to end a round early — NOT only from
   * ROUND_COMPLETE with a genuine BB tie (D-034). `teamIds` is Host-supplied
   * in the payload, never derived from a tie check.
   */
  HOST_BEGIN_SUDDEN_DEATH: 'HOST_BEGIN_SUDDEN_DEATH',
  /**
   * Host reveals the next face-off's question and opens the buzzer.
   *
   * Deliberately NOT named `HOST_START_FACEOFF` — that string is already
   * `ROUND4_INTENTS.HOST_START_FACEOFF`, and the room's intent dispatch
   * switches on the literal wire string, not which module's constant built
   * it, so two intents sharing a string would collide (whichever `case`
   * appears first in the switch wins, silently, for BOTH).
   */
  HOST_START_SUDDEN_DEATH_FACEOFF: 'HOST_START_SUDDEN_DEATH_FACEOFF',
  /** PLAYER: a face-off participant buzzes in. Own string — see HOST_START_SUDDEN_DEATH_FACEOFF's note. */
  SUBMIT_SUDDEN_DEATH_BUZZ: 'SUBMIT_SUDDEN_DEATH_BUZZ',
  /** PLAYER: the buzzed-in team's answer. */
  SUBMIT_SUDDEN_DEATH_ANSWER: 'SUBMIT_SUDDEN_DEATH_ANSWER',
  /** Host rules the submitted (or timed-out) answer: correct, wrong, or names which board answer was spoken. */
  HOST_RULE_SUDDEN_DEATH_ANSWER: 'HOST_RULE_SUDDEN_DEATH_ANSWER',
  /**
   * Host records that neither side answered validly in the current
   * face-off. §21 / D-034 — no penalty to either streak; a fresh face-off
   * follows. Refused unless a face-off is genuinely still open (status
   * `reading` or `buzzed`).
   */
  HOST_RECORD_SUDDEN_DEATH_NO_DECISION: 'HOST_RECORD_SUDDEN_DEATH_NO_DECISION',
} as const;

export type SuddenDeathIntentType = (typeof SUDDEN_DEATH_INTENTS)[keyof typeof SUDDEN_DEATH_INTENTS];

export const SUDDEN_DEATH_EVENTS = {
  SUDDEN_DEATH_STARTED: 'SUDDEN_DEATH_STARTED',
  SUDDEN_DEATH_FACEOFF_REVEALED: 'SUDDEN_DEATH_FACEOFF_REVEALED',
  SUDDEN_DEATH_BUZZED: 'SUDDEN_DEATH_BUZZED',
  SUDDEN_DEATH_FACEOFF_RESOLVED: 'SUDDEN_DEATH_FACEOFF_RESOLVED',
  SUDDEN_DEATH_COMPLETED: 'SUDDEN_DEATH_COMPLETED',
} as const;

export type SuddenDeathEventType = (typeof SUDDEN_DEATH_EVENTS)[keyof typeof SUDDEN_DEATH_EVENTS];
