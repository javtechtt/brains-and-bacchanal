import {
  asServerTimestamp,
  err,
  ok,
  rejection,
  SUDDEN_DEATH_ANSWER_MS,
  SUDDEN_DEATH_ROUND_INDEX,
  type Result,
  type Round4BoardAnswer,
  type Round4Survey,
  type ServerTimestamp,
  type SuddenDeathFaceoffStatus,
  type SuddenDeathFaceoffView,
  type SuddenDeathStateView,
  type SuddenDeathStreak,
  type TeamId,
} from '@bb/protocol';
import type { Clock } from './clock.js';
import {
  hasExpired,
  isPaused,
  pauseDeadline,
  remainingMs,
  resumeDeadline,
  startDeadline,
  type Deadline,
} from './deadline.js';

/**
 * Sudden Death. Phase 7D-B2.
 *
 * GAME_RULES_LOCKED.md §21, replaced by DECISION_LOG.md D-034: a face-off
 * sequence between the tied leaders (or whichever teams the Host names when
 * ending a round early — the project owner wants that control at any point,
 * not only a genuine BB tie). First to two consecutive face-off wins takes
 * the game. See sudden-death.ts (protocol) for the full rule text this
 * mirrors.
 *
 * Deliberately much smaller than `Round4`: no board play, no PLAY/PASS, no
 * steal, no strikes, no cards, no wager — §21 (unchanged by D-034) bars all
 * of that, and this class has no code path that could apply any of it.
 */

interface FaceoffState {
  status: SuddenDeathFaceoffStatus;
  readonly question: Round4Survey;
  readonly participantTeamIds: readonly [TeamId, TeamId];
  buzzedTeamId: TeamId | null;
  buzzedAt: ServerTimestamp | null;
  answerDeadline: Deadline | null;
  winningTeamId: TeamId | null;
  noDecision: boolean;
}

export interface SuddenDeathOptions {
  readonly clock: Clock;
  readonly answerMs?: number;
}

export class SuddenDeath {
  readonly #clock: Clock;
  readonly #answerMs: number;

  #active = false;
  #participantTeamIds: readonly TeamId[] = [];
  readonly #streaks = new Map<string, number>();
  #current: FaceoffState | null = null;
  #complete = false;
  #winnerTeamId: TeamId | null = null;

  constructor(options: SuddenDeathOptions) {
    this.#clock = options.clock;
    this.#answerMs = options.answerMs ?? SUDDEN_DEATH_ANSWER_MS;
  }

  get active(): boolean {
    return this.#active;
  }

  get complete(): boolean {
    return this.#complete;
  }

  get winnerTeamId(): TeamId | null {
    return this.#winnerTeamId;
  }

  get participantTeamIds(): readonly TeamId[] {
    return this.#participantTeamIds;
  }

  /**
   * The current face-off's board answers — server-only, for the room to
   * grade a submitted answer against, mirroring `Round4.availableBoardAnswers`.
   * Empty when no face-off is running.
   */
  get currentQuestionAnswers(): readonly Round4BoardAnswer[] {
    return this.#current?.question.answers ?? [];
  }

  /** Begin Sudden Death between exactly these teams — the tied leaders, or the Host's own choice. */
  begin(teamIds: readonly TeamId[]): Result<true> {
    if (this.#active) {
      return err(rejection('WRONG_STATE', 'Sudden Death has already started.'));
    }
    if (teamIds.length !== 2) {
      return err(rejection('INVALID_REQUEST', 'Sudden Death needs exactly two teams.'));
    }

    this.#participantTeamIds = [...teamIds];
    for (const teamId of teamIds) {
      this.#streaks.set(teamId, 0);
    }
    this.#active = true;
    return ok(true);
  }

  /** Host reveals the next face-off's question and opens the buzzer. */
  startFaceoff(question: Round4Survey): Result<true> {
    if (!this.#active) {
      return err(rejection('WRONG_STATE', 'Sudden Death has not started.'));
    }
    if (this.#complete) {
      return err(rejection('WRONG_STATE', 'Sudden Death is already complete.'));
    }
    if (this.#current !== null && this.#current.status !== 'decided') {
      return err(rejection('WRONG_STATE', 'A Sudden Death face-off is already in progress.'));
    }
    const [a, b] = this.#participantTeamIds;
    /* c8 ignore next 3 -- unreachable: begin() requires exactly two teams. */
    if (a === undefined || b === undefined) {
      return err(rejection('WRONG_STATE', 'Sudden Death has no participants.'));
    }

    this.#current = {
      status: 'reading',
      question,
      participantTeamIds: [a, b],
      buzzedTeamId: null,
      buzzedAt: null,
      answerDeadline: null,
      winningTeamId: null,
      noDecision: false,
    };
    return ok(true);
  }

  /** A participant buzzes in. First valid buzz locks the race, exactly like Round 4's own buzzer. */
  buzz(teamId: TeamId): Result<SuddenDeathFaceoffView> {
    const current = this.#current;
    if (current === null) {
      return err(rejection('WRONG_STATE', 'No Sudden Death face-off is running.'));
    }
    if (current.status !== 'reading') {
      return err(rejection('ILLEGAL_ACTION', 'The buzzer is not open.'));
    }
    if (!current.participantTeamIds.includes(teamId)) {
      return err(rejection('UNAUTHORIZED_ACTOR', 'Your team is not in this face-off.'));
    }

    current.status = 'buzzed';
    current.buzzedTeamId = teamId;
    current.buzzedAt = asServerTimestamp(this.#clock.now());
    current.answerDeadline = startDeadline(this.#clock, this.#answerMs);

    return ok(this.#faceoffView(current));
  }

  faceoffAnswerWindowExpired(): boolean {
    const current = this.#current;
    if (current === null || current.answerDeadline === null) return false;
    return hasExpired(this.#clock, current.answerDeadline);
  }

  faceoffAnswerRemainingMs(): number {
    const current = this.#current;
    if (current === null || current.answerDeadline === null) return 0;
    return remainingMs(this.#clock, current.answerDeadline);
  }

  /**
   * Rule the buzzed team's answer. §21 / D-034 — the #1 board answer wins the
   * face-off outright; anything else (wrong, off-board, or a timeout —
   * `correct: false`) loses it IMMEDIATELY for the team that answered. There
   * is no opponent's-chance fallback inside Sudden Death, unlike a normal
   * Round 4 face-off.
   */
  ruleFaceoffAnswer(input: { readonly teamId: TeamId; readonly correct: boolean }): Result<{
    readonly faceoff: SuddenDeathFaceoffView;
    readonly streakWinnerTeamId: TeamId | null;
  }> {
    const current = this.#current;
    if (current === null) {
      return err(rejection('WRONG_STATE', 'No Sudden Death face-off is running.'));
    }
    if (current.status !== 'buzzed') {
      return err(rejection('WRONG_STATE', 'No face-off answer is awaited.'));
    }
    if (input.teamId !== current.buzzedTeamId) {
      return err(rejection('UNAUTHORIZED_ACTOR', 'That team has not buzzed in.'));
    }

    current.answerDeadline = null;
    current.status = 'decided';

    const opponent = current.participantTeamIds.find((t) => t !== input.teamId);
    /* c8 ignore next 3 -- unreachable: participantTeamIds always has exactly two teams. */
    if (opponent === undefined) {
      return err(rejection('WRONG_STATE', 'The face-off has no opponent team.'));
    }

    if (input.correct) {
      current.winningTeamId = input.teamId;
      this.#bumpStreak(input.teamId, opponent);
    } else {
      // A wrong answer (or buzz-then-timeout, routed through this same
      // method with correct:false) loses the face-off for the ANSWERING
      // team outright — the opponent wins it.
      current.winningTeamId = opponent;
      this.#bumpStreak(opponent, input.teamId);
    }

    const streakWinnerTeamId = this.#checkForOverallWinner();
    return ok({ faceoff: this.#faceoffView(current), streakWinnerTeamId });
  }

  /**
   * Neither team buzzed before the reading window closed, or the whole
   * face-off otherwise resolves with no decision. §21 / D-034 — no penalty
   * to either streak, and a fresh face-off follows.
   */
  recordNoDecision(): Result<SuddenDeathFaceoffView> {
    const current = this.#current;
    if (current === null) {
      return err(rejection('WRONG_STATE', 'No Sudden Death face-off is running.'));
    }
    current.status = 'decided';
    current.noDecision = true;
    current.answerDeadline = null;
    return ok(this.#faceoffView(current));
  }

  #bumpStreak(winnerId: TeamId, loserId: TeamId): void {
    const winnerStreak = (this.#streaks.get(winnerId) ?? 0) + 1;
    this.#streaks.set(winnerId, winnerStreak);
    this.#streaks.set(loserId, 0);
  }

  #checkForOverallWinner(): TeamId | null {
    for (const [teamId, streak] of this.#streaks) {
      if (streak >= 2) {
        this.#complete = true;
        this.#winnerTeamId = teamId as TeamId;
        return teamId as TeamId;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Pause / reconnect (D-011) — mirrors Round4's own pauseTimers/resumeTimers.
  // -------------------------------------------------------------------------

  pauseTimers(): void {
    if (this.#current?.answerDeadline !== null && this.#current?.answerDeadline !== undefined) {
      this.#current.answerDeadline = pauseDeadline(this.#clock, this.#current.answerDeadline);
    }
  }

  resumeTimers(): void {
    if (this.#current?.answerDeadline !== null && this.#current?.answerDeadline !== undefined) {
      this.#current.answerDeadline = resumeDeadline(this.#clock, this.#current.answerDeadline);
    }
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  #faceoffView(current: FaceoffState): SuddenDeathFaceoffView {
    return {
      status: current.status,
      prompt: current.question.prompt,
      participantTeamIds: current.participantTeamIds,
      buzzedTeamId: current.buzzedTeamId,
      buzzedAt: current.buzzedAt,
      answerTimer:
        current.answerDeadline === null
          ? null
          : {
              durationMs: this.#answerMs,
              remainingMs: remainingMs(this.#clock, current.answerDeadline),
              paused: isPaused(current.answerDeadline),
              expired: hasExpired(this.#clock, current.answerDeadline),
              startedAt: asServerTimestamp(current.answerDeadline.startedAt),
            },
      winningTeamId: current.winningTeamId,
      noDecision: current.noDecision,
    };
  }

  view(): SuddenDeathStateView {
    const streaks: SuddenDeathStreak[] = this.#participantTeamIds.map((teamId) => ({
      teamId,
      consecutiveWins: this.#streaks.get(teamId) ?? 0,
    }));

    return {
      roundIndex: SUDDEN_DEATH_ROUND_INDEX,
      participantTeamIds: this.#participantTeamIds,
      streaks,
      current: this.#current === null ? null : this.#faceoffView(this.#current),
      complete: this.#complete,
      winnerTeamId: this.#winnerTeamId,
    };
  }
}
