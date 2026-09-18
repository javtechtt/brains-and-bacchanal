import {
  asServerTimestamp,
  err,
  isRound4DoubledQuestion,
  ok,
  rejection,
  ROUND4_BOARD_TURN_MS,
  ROUND4_FACEOFF_ANSWER_MS,
  ROUND4_MAX_STRIKES,
  ROUND4_ROUND_INDEX,
  ROUND4_STEAL_CONFER_MS,
  type Rejection,
  type Result,
  type Round4BoardAnswer,
  type Round4BoardPlayView,
  type Round4BoardView,
  type Round4EnteringRank,
  type Round4EnteringStanding,
  type Round4FaceoffStatus,
  type Round4FaceoffView,
  type Round4MatchupStage,
  type Round4PlayDecision,
  type Round4ScoringGate,
  type Round4StealStatus,
  type Round4StealView,
  type Round4StrikeReason,
  type Round4Survey,
  type Round4SurveyProgress,
  type Round4SurveyView,
  type Round4StateView,
  type Round4TimerView,
  type ServerTimestamp,
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
 * Round 4 — Family Feud. Phase 7D-A.
 *
 * GAME_RULES_LOCKED.md §19-§20, DECISION_LOG.md D-008 and D-033.
 *
 * ================== WHAT THIS FILE OWNS, AND WHAT IT DOES NOT ==================
 * Like `Round1` and `Round3`, this is the round's OWN state — the matchup, the
 * board, the face-off, strikes, the steal — never the phase, the BB ledger, the
 * card hands, or the wager itself. `GameEngine` and `SharedSystems` own those,
 * and this class returns what it needs applied (an award amount, a wager
 * request) rather than moving BB directly.
 *
 * THE STEAL WAGER IS NOT REINVENTED HERE. §19 — "the existing custom steal
 * wager, unchanged." This class tracks only that a steal is awaiting a wager
 * and how much is allowed (`maxWagerFor`, already in `deals.ts`); the actual
 * lock and resolution go through `SharedSystems.deals`, exactly as the phase
 * brief requires.
 * ================================================================================
 *
 * ================== THE BOARD NEVER LEAKS ==================
 * `#currentSurvey` privately holds every ranked answer and value. Every read
 * path either returns `#boardView`, which is built answer-by-answer and only
 * emits `text`/`value` for a REVEALED answer, or returns nothing about the
 * board at all. There is no path from a `Round4Survey` to a client that skips
 * this filter.
 * =============================================================================
 */

interface BoardAnswerState {
  readonly answer: Round4BoardAnswer;
  revealed: boolean;
  /** Set when Steups! removes this answer for one team this survey. §19. */
  steupsRemovedForTeamId: TeamId | null;
}

interface FaceoffState {
  status: Round4FaceoffStatus;
  readonly participantTeamIds: readonly [TeamId, TeamId];
  buzzedTeamId: TeamId | null;
  buzzedAt: ServerTimestamp | null;
  answerDeadline: Deadline | null;
  opponentTeamId: TeamId | null;
  winningTeamId: TeamId | null;
  playDecision: Round4PlayDecision | null;
}

interface BoardPlayState {
  controllingTeamId: TeamId;
  playerOrder: string[];
  currentPlayerIndex: number;
  strikes: number;
  turnDeadline: Deadline | null;
  /** Answers (normalised text) already given this survey, so a repeat is a strike. */
  readonly givenAnswerIds: Set<string>;
}

interface StealState {
  status: Round4StealStatus;
  readonly stealingTeamId: TeamId;
  readonly defendingTeamId: TeamId;
  conferDeadline: Deadline | null;
  wagerId: string | null;
  wagerAmount: number | null;
  resolved: boolean;
  won: boolean | null;
}

interface SurveySlot {
  readonly survey: Round4Survey;
  readonly answers: BoardAnswerState[];
  progress: Round4SurveyProgress;
  accumulatedPoints: number;
  faceoff: FaceoffState | null;
  boardPlay: BoardPlayState | null;
  steal: StealState | null;
  resolvedWinnerTeamId: TeamId | null;
  awardedBb: number | null;
  resolvedAt: ServerTimestamp | null;
}

export interface Round4Options {
  readonly clock: Clock;
  readonly faceoffAnswerMs?: number;
  readonly boardTurnMs?: number;
  readonly stealConferMs?: number;
  /**
   * How many strikes trigger a steal. §19 locks this at 3 by default, but the
   * project owner asked for a Host-chosen ceiling (floor of 1 — a "0 strikes"
   * game would hand every wrong answer straight to a steal, which is not a
   * strike ceiling at all) set once for the whole of Round 4, not per survey.
   */
  readonly maxStrikes?: number;
}

/** What `beginMatchup` needs to set up either matchup stage. */
export interface Round4MatchupInput {
  readonly stage: Round4MatchupStage;
  readonly teamIds: readonly [TeamId, TeamId];
  readonly inactiveTeamId: TeamId | null;
}

export class Round4 {
  readonly #clock: Clock;
  readonly #faceoffAnswerMs: number;
  readonly #boardTurnMs: number;
  readonly #stealConferMs: number;
  readonly #maxStrikes: number;

  #active = false;
  #enteringStandings: Round4EnteringStanding[] = [];
  readonly #gates = new Map<string, Round4ScoringGate>();

  #matchupStage: Round4MatchupStage | null = null;
  #matchupTeamIds: readonly TeamId[] = [];
  #inactiveTeamId: TeamId | null = null;
  #surveysPlayedInMatchup = 0;
  /** Survey point totals THIS matchup, for the tie check after two surveys. */
  readonly #matchupSurveyWins = new Map<string, number>();

  #current: SurveySlot | null = null;
  #matchupWinnerTeamId: TeamId | null = null;
  #round4WinnerTeamId: TeamId | null = null;
  #complete = false;

  constructor(options: Round4Options) {
    this.#clock = options.clock;
    this.#faceoffAnswerMs = options.faceoffAnswerMs ?? ROUND4_FACEOFF_ANSWER_MS;
    this.#boardTurnMs = options.boardTurnMs ?? ROUND4_BOARD_TURN_MS;
    this.#stealConferMs = options.stealConferMs ?? ROUND4_STEAL_CONFER_MS;
    this.#maxStrikes = Math.max(1, Math.trunc(options.maxStrikes ?? ROUND4_MAX_STRIKES));
  }

  get active(): boolean {
    return this.#active;
  }

  get complete(): boolean {
    return this.#complete;
  }

  get matchupTeamIds(): readonly TeamId[] {
    return this.#matchupTeamIds;
  }

  get inactiveTeamId(): TeamId | null {
    return this.#inactiveTeamId;
  }

  get round4WinnerTeamId(): TeamId | null {
    return this.#round4WinnerTeamId;
  }

  // -------------------------------------------------------------------------
  // Entry — D-008 / §20. The ranking is frozen HERE and never recomputed.
  // -------------------------------------------------------------------------

  /**
   * Begin Round 4: freeze the entering standings.
   *
   * `standings` must already be ordered best-first by the caller (the engine's
   * live BB at the moment Round 4 starts) — this class does not read BB and
   * never will, which is precisely what makes the freeze real: nothing later
   * can cause this class to reconsider.
   */
  begin(standings: readonly TeamId[]): Result<true> {
    if (this.#active) {
      return err(rejection('WRONG_STATE', 'Round 4 has already started.'));
    }
    if (standings.length < 2) {
      return err(rejection('INVALID_REQUEST', 'Round 4 needs at least two teams.'));
    }

    const ranks: readonly Round4EnteringRank[] = ['FIRST', 'SECOND', 'THIRD'];
    this.#enteringStandings = standings.map((teamId, index) => ({
      teamId,
      rank: ranks[index] ?? 'THIRD',
      enteringBb: 0,
    }));
    for (const teamId of standings) {
      this.#gates.set(teamId, { teamId, gated: false, gatedAtStage: null });
    }

    this.#active = true;
    return ok(true);
  }

  /**
   * Record each team's actual entering BB, for display only.
   *
   * Separate from `begin` so a caller that computes standings and balances in
   * two steps does not have to do it in one; nothing here changes rank order.
   */
  recordEnteringBb(balances: ReadonlyMap<string, number>): void {
    this.#enteringStandings = this.#enteringStandings.map((s) => ({
      ...s,
      enteringBb: balances.get(s.teamId) ?? s.enteringBb,
    }));
  }

  get enteringStandings(): readonly Round4EnteringStanding[] {
    return this.#enteringStandings;
  }

  /**
   * Start the FIRST matchup (2nd vs 3rd) or, in a two-team game, the FINAL
   * matchup contested by both teams. §20 steps 1-2.
   */
  beginFirstMatchup(): Result<true> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);
    if (this.#matchupStage !== null) {
      return err(rejection('WRONG_STATE', 'A Round 4 matchup has already started.'));
    }

    if (this.#enteringStandings.length === 2) {
      const [a, b] = this.#enteringStandings;
      /* c8 ignore next 3 -- unreachable: begin() requires at least 2 standings. */
      if (a === undefined || b === undefined) {
        return err(rejection('WRONG_STATE', 'Round 4 has no entering standings.'));
      }
      this.#matchupStage = 'FINAL';
      this.#matchupTeamIds = [a.teamId, b.teamId];
      this.#inactiveTeamId = null;
      this.#surveysPlayedInMatchup = 0;
      this.#matchupSurveyWins.clear();
      return ok(true);
    }

    const second = this.#enteringStandings.find((s) => s.rank === 'SECOND');
    const third = this.#enteringStandings.find((s) => s.rank === 'THIRD');
    const first = this.#enteringStandings.find((s) => s.rank === 'FIRST');
    if (second === undefined || third === undefined || first === undefined) {
      return err(rejection('WRONG_STATE', 'Round 4 needs three entering standings.'));
    }

    this.#matchupStage = 'FIRST';
    this.#matchupTeamIds = [second.teamId, third.teamId];
    this.#inactiveTeamId = first.teamId;
    this.#surveysPlayedInMatchup = 0;
    this.#matchupSurveyWins.clear();
    return ok(true);
  }

  /**
   * Start the FINAL matchup: the FIRST matchup's advancing team vs entering
   * 1st. §20 steps 7-8. Refused unless the FIRST matchup has just decided.
   */
  beginFinalMatchup(advancingTeamId: TeamId): Result<true> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);
    if (this.#matchupStage !== 'FIRST' || this.#matchupWinnerTeamId === null) {
      return err(rejection('WRONG_STATE', 'The FIRST Round 4 matchup has not resolved.'));
    }

    const first = this.#enteringStandings.find((s) => s.rank === 'FIRST');
    if (first === undefined) {
      return err(rejection('WRONG_STATE', 'Round 4 has no entering first place.'));
    }
    if (!this.#matchupTeamIds.includes(advancingTeamId)) {
      return err(
        rejection('ILLEGAL_ACTION', 'That team was not in the FIRST matchup.', {
          teamId: advancingTeamId,
        }),
      );
    }

    this.#matchupStage = 'FINAL';
    this.#matchupTeamIds = [advancingTeamId, first.teamId];
    this.#inactiveTeamId = null;
    this.#matchupWinnerTeamId = null;
    this.#surveysPlayedInMatchup = 0;
    this.#matchupSurveyWins.clear();
    return ok(true);
  }

  /**
   * Decide the FIRST matchup after its two surveys. §20 step 9 — a tie sends
   * entering-2nd through, not some other tiebreak.
   *
   * "Survey wins" here means surveys whose accumulated points that team ended
   * up receiving (by clearing the board or a successful/failed steal) — the
   * only measure of who "won" a survey that §19/§20 gives us, since Family
   * Feud has no separate per-survey score counter of its own.
   */
  decideFirstMatchup(): Result<{ readonly advancingTeamId: TeamId; readonly tied: boolean }> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);
    if (this.#matchupStage !== 'FIRST') {
      return err(rejection('WRONG_STATE', 'The FIRST Round 4 matchup is not running.'));
    }
    if (this.#surveysPlayedInMatchup < 2) {
      return err(
        rejection('WRONG_STATE', 'The FIRST Round 4 matchup has not played its two surveys.', {
          played: this.#surveysPlayedInMatchup,
        }),
      );
    }

    const [teamA, teamB] = this.#matchupTeamIds;
    /* c8 ignore next 3 -- unreachable: beginFirstMatchup always sets exactly two. */
    if (teamA === undefined || teamB === undefined) {
      return err(rejection('WRONG_STATE', 'The FIRST Round 4 matchup has no teams.'));
    }
    const winsA = this.#matchupSurveyWins.get(teamA) ?? 0;
    const winsB = this.#matchupSurveyWins.get(teamB) ?? 0;

    let advancing: TeamId;
    let tied = false;
    if (winsA === winsB) {
      // §20 step 9 — entering 2nd advances on a tie, not the highest BB, not a
      // replay. `teamA` is always entering-2nd: `beginFirstMatchup` puts it
      // first in `#matchupTeamIds`.
      advancing = teamA;
      tied = true;
    } else {
      advancing = winsA > winsB ? teamA : teamB;
    }

    const loser = advancing === teamA ? teamB : teamA;
    this.#gateTeam(loser, 'FIRST');
    this.#matchupWinnerTeamId = advancing;

    return ok({ advancingTeamId: advancing, tied });
  }

  #gateTeam(teamId: TeamId, stage: Round4MatchupStage): void {
    this.#gates.set(teamId, { teamId, gated: true, gatedAtStage: stage });
  }

  /** Whether a team may still earn Family Feud BB. §20 step 6. */
  isScoringGated(teamId: TeamId): boolean {
    return this.#gates.get(teamId)?.gated ?? false;
  }

  get scoringGates(): readonly Round4ScoringGate[] {
    return [...this.#gates.values()];
  }

  // -------------------------------------------------------------------------
  // Surveys
  // -------------------------------------------------------------------------

  /**
   * Reveal the next survey and open its face-off. §19 — "the Host begins
   * reading the survey question aloud... the digital buzzer opens while the
   * Host is reading."
   *
   * THE SURVEY COMES FROM THE CALLER. §13's "the game supplies challenge
   * content" applies to Round 4 too — this class never picks its own survey.
   */
  startFaceoff(survey: Round4Survey, participantTeamIds: readonly [TeamId, TeamId]): Result<true> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);
    if (this.#current !== null && this.#current.progress !== 'resolved') {
      return err(rejection('WRONG_STATE', 'A Round 4 survey is already in progress.'));
    }
    for (const teamId of participantTeamIds) {
      if (!this.#matchupTeamIds.includes(teamId)) {
        return err(
          rejection('ILLEGAL_ACTION', 'That team is not in the current Round 4 matchup.', {
            teamId,
          }),
        );
      }
    }

    this.#current = {
      survey,
      answers: [...survey.answers]
        .sort((a, b) => a.rank - b.rank)
        .map((answer) => ({ answer, revealed: false, steupsRemovedForTeamId: null })),
      progress: 'faceoff',
      accumulatedPoints: 0,
      faceoff: {
        status: 'reading',
        participantTeamIds,
        buzzedTeamId: null,
        buzzedAt: null,
        answerDeadline: null,
        opponentTeamId: null,
        winningTeamId: null,
        playDecision: null,
      },
      boardPlay: null,
      steal: null,
      resolvedWinnerTeamId: null,
      awardedBb: null,
      resolvedAt: null,
    };
    return ok(true);
  }

  // --- Face-off --------------------------------------------------------------

  /**
   * A face-off participant buzzes in. §19 — first valid buzz locks out the
   * opponent and starts the 3-second answer window.
   *
   * A buzz from anyone but a `participantTeamIds` team, or a second buzz once
   * one is already locked, is refused — this is the server-side race guard:
   * whichever buzz reaches this method first while `status === 'reading'` wins,
   * and every later one for this face-off is rejected outright.
   */
  buzz(teamId: TeamId): Result<Round4FaceoffView> {
    const slot = this.#requireFaceoff();
    if (!slot.ok) return err(slot.error);
    const { faceoff } = slot.value;

    if (faceoff.status !== 'reading') {
      return err(rejection('ILLEGAL_ACTION', 'The buzzer is not open.'));
    }
    if (!faceoff.participantTeamIds.includes(teamId)) {
      return err(rejection('UNAUTHORIZED_ACTOR', 'Your team is not in this face-off.'));
    }

    faceoff.status = 'buzzed';
    faceoff.buzzedTeamId = teamId;
    faceoff.buzzedAt = this.#now();
    faceoff.answerDeadline = startDeadline(this.#clock, this.#faceoffAnswerMs);

    return ok(this.#faceoffView(faceoff));
  }

  /** Whether the current face-off answer window has expired. */
  faceoffAnswerWindowExpired(): boolean {
    const faceoff = this.#current?.faceoff;
    if (faceoff === null || faceoff === undefined) return false;
    if (faceoff.answerDeadline === null) return false;
    return hasExpired(this.#clock, faceoff.answerDeadline);
  }

  faceoffAnswerRemainingMs(): number {
    const faceoff = this.#current?.faceoff;
    if (faceoff === null || faceoff === undefined || faceoff.answerDeadline === null) return 0;
    return remainingMs(this.#clock, faceoff.answerDeadline);
  }

  /**
   * Rule a face-off answer. §19:
   *   - the buzzed-in team's answer, if it is the #1 board answer, wins outright,
   *   - otherwise the OPPONENT gets one shot at a higher-ranked answer,
   *   - whichever valid answer ranks higher wins.
   *
   * `matchedRank` is null for "no valid board answer" (including a timeout or
   * an off-board guess) — a wrong or missing answer never wins a face-off, but
   * it still hands the other side its one opportunity, exactly as a valid
   * lower-ranked answer would.
   */
  ruleFaceoffAnswer(input: {
    readonly teamId: TeamId;
    readonly matchedRank: number | null;
  }): Result<Round4FaceoffView> {
    const slot = this.#requireFaceoff();
    if (!slot.ok) return err(slot.error);
    const { faceoff } = slot.value;

    if (faceoff.status === 'buzzed') {
      if (input.teamId !== faceoff.buzzedTeamId) {
        return err(rejection('UNAUTHORIZED_ACTOR', 'That team has not buzzed in.'));
      }
      faceoff.answerDeadline = null;

      if (input.matchedRank === 1) {
        faceoff.status = 'decided';
        faceoff.winningTeamId = input.teamId;
        this.#revealAnswerByRank(1);
        return ok(this.#faceoffView(faceoff));
      }

      // Not the #1 answer (wrong, off-board, or a timeout) — the OPPONENT gets
      // one shot at a higher-ranked answer. §19.
      const opponent = faceoff.participantTeamIds.find((t) => t !== input.teamId);
      /* c8 ignore next 3 -- unreachable: participantTeamIds always has exactly two teams. */
      if (opponent === undefined) {
        return err(rejection('WRONG_STATE', 'The face-off has no opponent team.'));
      }
      faceoff.status = 'opponent_chance';
      faceoff.opponentTeamId = opponent;
      // Live play: the #1 answer already won outright in the branch above, so
      // reaching here means the opponent's chance may not even be needed in
      // spirit — the Host often already knows the buzzer's answer was weak
      // enough that this is a formality, or wants to set the moment up
      // deliberately. Either way the clock does not start itself; the Host
      // starts it explicitly via `startOpponentChanceTimer` once ready.
      faceoff.answerDeadline = null;
      // The first rank is kept so the opponent's answer can be compared.
      this.#firstFaceoffRank = input.matchedRank;
      return ok(this.#faceoffView(faceoff));
    }

    if (faceoff.status === 'opponent_chance') {
      if (input.teamId !== faceoff.opponentTeamId) {
        return err(rejection('UNAUTHORIZED_ACTOR', 'That team does not have the opponent chance.'));
      }
      faceoff.answerDeadline = null;
      faceoff.status = 'decided';

      const firstRank = this.#firstFaceoffRank;
      const secondRank = input.matchedRank;
      // Lower rank number = higher-value/ranked answer. "Whichever valid
      // answer ranks higher wins" (§19); no valid answer from either side
      // still needs a decision, so it goes to the team that answered FIRST —
      // the original buzzer winner — since the opponent's one shot produced
      // nothing better. A missing first rank (the original buzzer never gave a
      // valid answer either) is impossible by construction: buzzing in with
      // matchedRank === 1 already resolved outright, so any other value flows
      // through this branch with `#firstFaceoffRank` set to whatever it was.
      const winner = this.#resolveFaceoffComparison({
        firstTeamId: faceoff.buzzedTeamId,
        firstRank,
        secondTeamId: input.teamId,
        secondRank,
      });
      faceoff.winningTeamId = winner;
      // The winning rank (lower number) is the one actually given, and reveals
      // onto the board exactly like any other valid answer — authentic Family
      // Feud mechanics, GAME_RULES_LOCKED.md §19 preamble. A null/null pair
      // means neither side gave a valid answer, so nothing reveals.
      const winningRank =
        firstRank === null ? secondRank : secondRank === null ? firstRank : Math.min(firstRank, secondRank);
      if (winningRank !== null) this.#revealAnswerByRank(winningRank);
      this.#firstFaceoffRank = null;
      return ok(this.#faceoffView(faceoff));
    }

    return err(rejection('WRONG_STATE', 'No face-off answer is awaited.'));
  }

  /**
   * The Host starts the opponent's one-shot 3-second answer window.
   *
   * Live play: after the buzzer winner's answer misses #1, the opponent's
   * chance does not start itself — often the buzzer's answer was clearly
   * weak enough that the Host wants a beat before putting the second team on
   * the spot, and sometimes (a genuine #1 miss with a very close second-best
   * board answer) the opponent may not need to answer at all if the Host
   * judges there is no realistic higher-ranked answer left. Refuses to
   * restart an already-running, unexpired timer.
   */
  startOpponentChanceTimer(): Result<Round4FaceoffView> {
    const slot = this.#requireFaceoff();
    if (!slot.ok) return err(slot.error);
    const { faceoff } = slot.value;

    if (faceoff.status !== 'opponent_chance') {
      return err(rejection('WRONG_STATE', 'No opponent chance is open.'));
    }
    if (faceoff.answerDeadline !== null && !hasExpired(this.#clock, faceoff.answerDeadline)) {
      return err(rejection('WRONG_STATE', 'The opponent chance timer is already running.'));
    }

    faceoff.answerDeadline = startDeadline(this.#clock, this.#faceoffAnswerMs);
    return ok(this.#faceoffView(faceoff));
  }

  #firstFaceoffRank: number | null = null;

  /**
   * Reveal the board answer at `rank` and add its value to the pot.
   *
   * A face-off answer that wins is a valid board answer like any other; in
   * authentic Family Feud it reveals on the board immediately, not just when
   * normal board play later happens to reach it. Without this, the survey's
   * board could never fully clear (`boardCleared`) since the winning rank
   * would stay hidden forever. A no-op if already revealed (never happens in
   * practice — a face-off only runs once per fresh survey slot).
   */
  #revealAnswerByRank(rank: number): void {
    const current = this.#current;
    if (current === null) return;
    const state = current.answers.find((a) => a.answer.rank === rank);
    if (state === undefined || state.revealed) return;
    state.revealed = true;
    current.accumulatedPoints += state.answer.value;
  }

  #resolveFaceoffComparison(input: {
    readonly firstTeamId: TeamId | null;
    readonly firstRank: number | null;
    readonly secondTeamId: TeamId;
    readonly secondRank: number | null;
  }): TeamId | null {
    const { firstTeamId, firstRank, secondTeamId, secondRank } = input;
    if (firstRank === null && secondRank === null) return null;
    if (firstRank === null) return secondTeamId;
    if (secondRank === null) return firstTeamId;
    // Lower rank number wins (rank 1 is the highest-value answer).
    return secondRank < firstRank ? secondTeamId : firstTeamId;
  }

  /** The face-off winner chooses PLAY or PASS. §19. */
  choosePlayOrPass(input: {
    readonly teamId: TeamId;
    readonly decision: Round4PlayDecision;
  }): Result<{
    readonly faceoff: Round4FaceoffView;
    readonly controllingTeamId: TeamId;
  }> {
    const slot = this.#requireFaceoff();
    if (!slot.ok) return err(slot.error);
    const { faceoff } = slot.value;

    if (faceoff.status !== 'decided' || faceoff.winningTeamId === null) {
      return err(rejection('WRONG_STATE', 'The face-off has not been decided.'));
    }
    if (input.teamId !== faceoff.winningTeamId) {
      return err(rejection('UNAUTHORIZED_ACTOR', 'Only the face-off winner chooses PLAY or PASS.'));
    }

    faceoff.playDecision = input.decision;
    faceoff.status = 'complete';

    const controllingTeamId =
      input.decision === 'PLAY'
        ? faceoff.winningTeamId
        : (faceoff.participantTeamIds.find((t) => t !== faceoff.winningTeamId) ??
          faceoff.winningTeamId);

    /* c8 ignore next 3 -- unreachable: the current slot exists per #requireFaceoff. */
    if (this.#current === null) {
      return err(rejection('WRONG_STATE', 'No Round 4 survey is running.'));
    }
    this.#current.progress = 'board_play';
    this.#current.boardPlay = {
      controllingTeamId,
      playerOrder: [],
      currentPlayerIndex: 0,
      strikes: 0,
      // Phase "live answers": the 5s turn timer no longer starts itself here.
      // Answers are spoken aloud and matched by the Host, not typed and
      // auto-graded, so the Host also decides the moment each turn's clock
      // starts (after posing the question) via `startBoardTurnTimer`. The
      // LOCKED duration (§19, 5s) is unchanged — only the start trigger moved
      // from "automatic" to "Host-initiated".
      turnDeadline: null,
      givenAnswerIds: new Set(),
    };

    return ok({ faceoff: this.#faceoffView(faceoff), controllingTeamId });
  }

  /**
   * The Host starts the current board turn's 5-second answer window.
   *
   * Live play: the Host poses the question aloud to the active player, THEN
   * starts this clock — never automatic, since nothing server-side can know
   * when the Host finished speaking. Refuses to restart an already-running,
   * unexpired timer so a doubled click cannot shortcut a turn.
   */
  startBoardTurnTimer(): Result<Round4BoardPlayView> {
    const slot = this.#requireBoardPlay();
    if (!slot.ok) return err(slot.error);
    const { boardPlay } = slot.value;

    if (boardPlay.turnDeadline !== null && !hasExpired(this.#clock, boardPlay.turnDeadline)) {
      return err(rejection('WRONG_STATE', 'The board turn timer is already running.'));
    }

    boardPlay.turnDeadline = startDeadline(this.#clock, this.#boardTurnMs);
    return ok(this.#boardPlayView(boardPlay));
  }

  /** Set the controlling team's player order for board play. Host/room supplies it. */
  setBoardPlayOrder(playerOrder: readonly string[]): Result<true> {
    const boardPlay = this.#current?.boardPlay;
    if (boardPlay === null || boardPlay === undefined) {
      return err(rejection('WRONG_STATE', 'Board play has not started.'));
    }
    boardPlay.playerOrder = [...playerOrder];
    return ok(true);
  }

  // --- Normal board play -------------------------------------------------

  boardTurnExpired(): boolean {
    const boardPlay = this.#current?.boardPlay;
    if (boardPlay === null || boardPlay === undefined || boardPlay.turnDeadline === null) {
      return false;
    }
    return hasExpired(this.#clock, boardPlay.turnDeadline);
  }

  boardTurnRemainingMs(): number {
    const boardPlay = this.#current?.boardPlay;
    if (boardPlay === null || boardPlay === undefined || boardPlay.turnDeadline === null) return 0;
    return remainingMs(this.#clock, boardPlay.turnDeadline);
  }

  /** Board answers the CONTROLLING team may still legally give this survey. */
  availableBoardAnswers(forTeamId: TeamId): readonly Round4BoardAnswer[] {
    const current = this.#current;
    if (current === null) return [];
    return current.answers
      .filter((a) => !a.revealed)
      .filter((a) => a.steupsRemovedForTeamId !== forTeamId)
      .map((a) => a.answer);
  }

  /**
   * Reveal a correct board-play answer. §19 — reveals and scores its value.
   *
   * `answerId` must name an unrevealed answer not Steups!-removed for the
   * controlling team; matching submitted text to an answer is
   * `round4-grading.ts`'s job, called by whatever drives this class.
   */
  revealBoardAnswer(answerId: string): Result<{
    readonly board: Round4BoardView;
    readonly value: number;
  }> {
    const slot = this.#requireBoardPlay();
    if (!slot.ok) return err(slot.error);
    const { current, boardPlay } = slot.value;

    const state = current.answers.find((a) => a.answer.answerId === answerId);
    if (state === undefined) {
      return err(rejection('NOT_FOUND', 'No such board answer.', { answerId }));
    }
    if (state.revealed) {
      return err(rejection('ILLEGAL_ACTION', 'That answer is already revealed.'));
    }
    if (state.steupsRemovedForTeamId === boardPlay.controllingTeamId) {
      return err(
        rejection('ILLEGAL_ACTION', 'That answer was removed by Steups! for your team this survey.'),
      );
    }

    state.revealed = true;
    boardPlay.givenAnswerIds.add(answerId);
    current.accumulatedPoints += state.answer.value;
    // The NEXT turn's timer does not auto-start — the Host poses the next
    // question aloud, then calls `startBoardTurnTimer` again. See that
    // method's doc comment.
    boardPlay.turnDeadline = null;
    // The next player's turn, in order. §19 — "one player answers per turn".
    if (boardPlay.playerOrder.length > 0) {
      boardPlay.currentPlayerIndex =
        (boardPlay.currentPlayerIndex + 1) % boardPlay.playerOrder.length;
    }

    const allRevealed = current.answers.every((a) => a.revealed);
    if (allRevealed) {
      return ok({
        board: this.#boardView(current, false),
        value: state.answer.value,
      });
    }

    return ok({ board: this.#boardView(current, false), value: state.answer.value });
  }

  /** Whether every board answer has been revealed (the controlling team cleared it). */
  boardCleared(): boolean {
    const current = this.#current;
    if (current === null) return false;
    return current.answers.every((a) => a.revealed);
  }

  /**
   * Record one strike. §19 — wrong, duplicate, off-board or timeout, each one
   * strike. Three strikes hands the opposing team a steal.
   */
  recordStrike(_reason: Round4StrikeReason): Result<{
    readonly boardPlay: Round4BoardPlayView;
    readonly stealTriggered: boolean;
  }> {
    const slot = this.#requireBoardPlay();
    if (!slot.ok) return err(slot.error);
    const { boardPlay } = slot.value;

    boardPlay.strikes += 1;
    // Does not auto-start the next turn's timer — see `startBoardTurnTimer`.
    boardPlay.turnDeadline = null;
    if (boardPlay.playerOrder.length > 0) {
      boardPlay.currentPlayerIndex =
        (boardPlay.currentPlayerIndex + 1) % boardPlay.playerOrder.length;
    }

    const stealTriggered = boardPlay.strikes >= this.#maxStrikes;
    return ok({ boardPlay: this.#boardPlayView(boardPlay), stealTriggered });
  }

  /**
   * Host directly sets the strike count for the current board turn.
   *
   * Live play: the Host has final jurisdiction over strikes at any time — to
   * correct a mistaken call, to walk one back after a Host ruling changes its
   * mind, or simply because the room decides live play calls for it. Floored
   * at 0 (a negative strike count is meaningless); has no ceiling of its own
   * beyond what `Number.isInteger` requires, since the Host may deliberately
   * want to set it at or above the steal threshold to trigger a steal by hand
   * — the caller (`GameEngine`/`Room`) decides whether to also open the steal
   * when the new count clears `#maxStrikes`, exactly as a normal strike does.
   */
  setStrikes(count: number): Result<{
    readonly boardPlay: Round4BoardPlayView;
    readonly stealTriggered: boolean;
  }> {
    const slot = this.#requireBoardPlay();
    if (!slot.ok) return err(slot.error);
    const { boardPlay } = slot.value;

    if (!Number.isInteger(count) || count < 0) {
      return err(rejection('INVALID_REQUEST', 'Strike count must be a non-negative integer.'));
    }

    const alreadyTriggered = boardPlay.strikes >= this.#maxStrikes;
    boardPlay.strikes = count;
    const stealTriggered = !alreadyTriggered && boardPlay.strikes >= this.#maxStrikes;

    return ok({ boardPlay: this.#boardPlayView(boardPlay), stealTriggered });
  }

  /**
   * Host cancels the running board turn timer WITHOUT recording a strike.
   *
   * Live play: someone answered live before the 5-second window ran out, so
   * the Host stops the clock to rule the answer via `revealBoardAnswer`
   * instead of letting a race with the timer's own expiry risk an
   * unintended timeout strike. A no-op (still succeeds) if no timer is
   * currently running — cancelling nothing is not an error.
   */
  cancelBoardTurnTimer(): Result<Round4BoardPlayView> {
    const slot = this.#requireBoardPlay();
    if (!slot.ok) return err(slot.error);
    const { boardPlay } = slot.value;

    boardPlay.turnDeadline = null;
    return ok(this.#boardPlayView(boardPlay));
  }

  // --- Steal ---------------------------------------------------------------

  /**
   * Open the steal. §19 — the opposing team gets 30 seconds to confer.
   *
   * Refused unless three strikes have actually been recorded, so a steal can
   * never be opened early by mistake.
   */
  startSteal(): Result<Round4StealView> {
    const current = this.#current;
    if (current === null || current.boardPlay === null) {
      return err(rejection('WRONG_STATE', 'Board play has not started.'));
    }
    if (current.boardPlay.strikes < this.#maxStrikes) {
      return err(rejection('ILLEGAL_ACTION', 'Three strikes have not been reached.'));
    }

    const defendingTeamId = current.boardPlay.controllingTeamId;
    const stealingTeamId =
      this.#matchupTeamIds.find((t) => t !== defendingTeamId) ?? defendingTeamId;

    current.progress = 'steal';
    current.steal = {
      status: 'conferring',
      stealingTeamId,
      defendingTeamId,
      // Does not auto-start — see `startStealTimer`. Live play: the Host
      // announces the steal opportunity to the stealing team first.
      conferDeadline: null,
      wagerId: null,
      wagerAmount: null,
      resolved: false,
      won: null,
    };

    return ok(this.#stealView(current.steal));
  }

  /**
   * The Host starts the steal's 30-second confer/answer window.
   *
   * Live play: the Host announces the steal opportunity to the stealing team,
   * THEN starts this clock — never automatic, matching `startBoardTurnTimer`.
   * Refuses to restart an already-running, unexpired timer.
   */
  startStealTimer(): Result<Round4StealView> {
    const current = this.#current;
    if (current === null || current.steal === null) {
      return err(rejection('WRONG_STATE', 'No steal is running.'));
    }
    const { steal } = current;
    if (steal.conferDeadline !== null && !hasExpired(this.#clock, steal.conferDeadline)) {
      return err(rejection('WRONG_STATE', 'The steal timer is already running.'));
    }

    steal.conferDeadline = startDeadline(this.#clock, this.#stealConferMs);
    return ok(this.#stealView(steal));
  }

  stealConferExpired(): boolean {
    const steal = this.#current?.steal;
    if (steal === null || steal === undefined || steal.conferDeadline === null) return false;
    return hasExpired(this.#clock, steal.conferDeadline);
  }

  stealConferRemainingMs(): number {
    const steal = this.#current?.steal;
    if (steal === null || steal === undefined || steal.conferDeadline === null) return 0;
    return remainingMs(this.#clock, steal.conferDeadline);
  }

  /**
   * Record the stealing team's locked wager. §19 — up to 50% of current BB.
   *
   * `wagerId` and `amount` come from the caller, which places the ACTUAL wager
   * through `SharedSystems.deals.proposeWager` (the existing generic wager
   * primitive, unchanged) and hands the id back here for bookkeeping only —
   * this class never computes the 50% cap itself.
   */
  lockStealWager(input: { readonly wagerId: string; readonly amount: number }): Result<Round4StealView> {
    const steal = this.#current?.steal;
    if (steal === null || steal === undefined) {
      return err(rejection('WRONG_STATE', 'No steal is open.'));
    }
    if (steal.status !== 'conferring' && steal.status !== 'awaiting_wager') {
      return err(rejection('ILLEGAL_ACTION', 'The steal wager has already been locked.'));
    }

    steal.wagerId = input.wagerId;
    steal.wagerAmount = input.amount;
    steal.status = 'awaiting_answer';
    return ok(this.#stealView(steal));
  }

  /**
   * Rule the steal's one final answer. §19:
   *   correct -> stealing team wins the accumulated points AND the wager,
   *   wrong   -> stealing team loses the wager; original team gets the points.
   *
   * BB is NOT moved here — the caller settles the wager through
   * `SharedSystems.deals.resolveWager` and awards `pointsAwardedTo`'s BB
   * through the ledger, both exactly once, using the values this returns.
   */
  ruleSteal(correct: boolean): Result<{
    readonly steal: Round4StealView;
    readonly pointsAwardedTo: TeamId;
    readonly points: number;
  }> {
    const current = this.#current;
    const steal = current?.steal;
    if (current === null || steal === null || steal === undefined) {
      return err(rejection('WRONG_STATE', 'No steal is open.'));
    }
    if (steal.resolved) {
      return err(rejection('ILLEGAL_ACTION', 'That steal has already been resolved.'));
    }

    steal.resolved = true;
    steal.won = correct;
    steal.status = 'resolved';
    steal.conferDeadline = null;

    const pointsAwardedTo = correct ? steal.stealingTeamId : steal.defendingTeamId;

    return ok({ steal: this.#stealView(steal), pointsAwardedTo, points: current.accumulatedPoints });
  }

  // -------------------------------------------------------------------------
  // Steups! and Forgive Meh!
  // -------------------------------------------------------------------------

  /**
   * Apply Steups! to a just-given valid opposing answer. §19 / OPEN_RULES.md §8.
   *
   * `answerId` must already be revealed (Steups! reacts to a valid answer that
   * was just given) and not already removed. The score IT ALREADY EARNED is
   * subtracted back out of the accumulated pot — "that answer is removed... it
   * does not score" reads as a full undo, not merely a future block, since the
   * effect is applied "after an opposing team gives a valid board answer" and
   * before the turn moves on for good.
   *
   * The DEFENDING team (whoever's answer this was) can never give this answer
   * again this survey. The Steups!-playing team faces no such bar and may use
   * it later if they gain a legal opportunity — enforced by
   * `availableBoardAnswers`/`revealBoardAnswer` checking `steupsRemovedForTeamId`
   * against the team asking, not against everyone.
   */
  applySteups(input: { readonly answerId: string; readonly defendingTeamId: TeamId }): Result<{
    readonly board: Round4BoardView;
  }> {
    const current = this.#current;
    if (current === null) {
      return err(rejection('WRONG_STATE', 'No Round 4 survey is running.'));
    }
    const state = current.answers.find((a) => a.answer.answerId === input.answerId);
    if (state === undefined) {
      return err(rejection('NOT_FOUND', 'No such board answer.'));
    }
    if (!state.revealed) {
      return err(rejection('ILLEGAL_ACTION', 'Steups! only removes an already-given valid answer.'));
    }
    if (state.steupsRemovedForTeamId !== null) {
      return err(rejection('ILLEGAL_ACTION', 'That answer has already been removed by Steups!.'));
    }

    state.revealed = false;
    state.steupsRemovedForTeamId = input.defendingTeamId;
    current.accumulatedPoints = Math.max(0, current.accumulatedPoints - state.answer.value);

    return ok({ board: this.#boardView(current, false) });
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve the survey once a winner is known — the controlling team cleared
   * the board, or a steal settled. Pays the FULL accumulated pot, doubled once
   * for Q4/Q5, EXACTLY ONCE: `progress` moves to `resolved` in this call and
   * every entry path above already refuses to act on a resolved survey.
   */
  resolveSurvey(winningTeamId: TeamId): Result<{
    readonly view: Round4SurveyView;
    readonly baseAward: number;
    readonly doubled: boolean;
  }> {
    const current = this.#current;
    if (current === null) {
      return err(rejection('WRONG_STATE', 'No Round 4 survey is running.'));
    }
    if (current.progress === 'resolved') {
      return err(rejection('ILLEGAL_ACTION', 'This survey has already been resolved.'));
    }

    const doubled = isRound4DoubledQuestion(current.survey.questionNumber);
    const baseAward = current.accumulatedPoints * (doubled ? 2 : 1);

    current.progress = 'resolved';
    current.resolvedWinnerTeamId = winningTeamId;
    current.awardedBb = baseAward;
    current.resolvedAt = this.#now();

    this.#surveysPlayedInMatchup += 1;
    this.#matchupSurveyWins.set(
      winningTeamId,
      (this.#matchupSurveyWins.get(winningTeamId) ?? 0) + 1,
    );

    return ok({ view: this.#surveyView(current, false), baseAward, doubled });
  }

  get surveysPlayedInMatchup(): number {
    return this.#surveysPlayedInMatchup;
  }

  /** Mark Round 4 itself complete — all surveys across both matchups played. */
  markComplete(winningTeamId: TeamId): void {
    this.#complete = true;
    this.#round4WinnerTeamId = winningTeamId;
  }

  // -------------------------------------------------------------------------
  // Pause / resume — D-011, reused verbatim.
  // -------------------------------------------------------------------------

  pauseTimers(): void {
    const current = this.#current;
    if (current === null) return;
    if (current.faceoff !== null && current.faceoff.answerDeadline !== null) {
      current.faceoff.answerDeadline = pauseDeadline(this.#clock, current.faceoff.answerDeadline);
    }
    if (current.boardPlay !== null && current.boardPlay.turnDeadline !== null) {
      current.boardPlay.turnDeadline = pauseDeadline(this.#clock, current.boardPlay.turnDeadline);
    }
    if (current.steal !== null && current.steal.conferDeadline !== null) {
      current.steal.conferDeadline = pauseDeadline(this.#clock, current.steal.conferDeadline);
    }
  }

  resumeTimers(): void {
    const current = this.#current;
    if (current === null) return;
    if (current.faceoff !== null && current.faceoff.answerDeadline !== null) {
      current.faceoff.answerDeadline = resumeDeadline(this.#clock, current.faceoff.answerDeadline);
    }
    if (current.boardPlay !== null && current.boardPlay.turnDeadline !== null) {
      current.boardPlay.turnDeadline = resumeDeadline(this.#clock, current.boardPlay.turnDeadline);
    }
    if (current.steal !== null && current.steal.conferDeadline !== null) {
      current.steal.conferDeadline = resumeDeadline(this.#clock, current.steal.conferDeadline);
    }
  }

  // -------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------

  #requireActive(): Rejection | null {
    if (!this.#active) return rejection('WRONG_STATE', 'Round 4 has not started.');
    return null;
  }

  #requireFaceoff(): Result<{ readonly survey: SurveySlot; readonly faceoff: FaceoffState }> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);
    const current = this.#current;
    if (current === null || current.faceoff === null || current.progress !== 'faceoff') {
      return err(rejection('WRONG_STATE', 'No Round 4 face-off is running.'));
    }
    return ok({ survey: current, faceoff: current.faceoff });
  }

  #requireBoardPlay(): Result<{ readonly current: SurveySlot; readonly boardPlay: BoardPlayState }> {
    const guard = this.#requireActive();
    if (guard !== null) return err(guard);
    const current = this.#current;
    if (current === null || current.boardPlay === null || current.progress !== 'board_play') {
      return err(rejection('WRONG_STATE', 'No Round 4 board play is running.'));
    }
    return ok({ current, boardPlay: current.boardPlay });
  }

  #now(): ServerTimestamp {
    return asServerTimestamp(this.#clock.now());
  }

  // -------------------------------------------------------------------------
  // Views — the board's secrecy boundary.
  // -------------------------------------------------------------------------

  /**
   * `forHost` is the ONLY thing that ever changes between this and a player's
   * view: the Host runs a LIVE game — reading the question aloud, matching a
   * spoken answer to a board slot, judging the face-off — and cannot do any
   * of that against a board of blanks. This is a deliberate, narrow exception
   * to "the shape is the protection" (this file's own header comment), scoped
   * exactly the way `Room` already scopes Round 1's canonical answer to the
   * Host and nobody else (`room.ts`'s `round1View(teamId, playerId, forHost)`)
   * — never reaching a player, ever, regardless of revealed state.
   */
  #boardView(current: SurveySlot, forHost: boolean): Round4BoardView {
    return {
      surveyId: current.survey.surveyId,
      prompt: current.survey.prompt,
      questionNumber: current.survey.questionNumber,
      answerCount: current.answers.length,
      answers: current.answers.map((a) => ({
        answerId: a.answer.answerId,
        rank: a.answer.rank,
        revealed: a.revealed,
        text: a.revealed || forHost ? a.answer.text : null,
        value: a.revealed || forHost ? a.answer.value : null,
        steupsRemoved: a.steupsRemovedForTeamId !== null,
        steupsRemovedForTeamId: a.steupsRemovedForTeamId,
      })),
      doubled: isRound4DoubledQuestion(current.survey.questionNumber),
      accumulatedPoints: current.accumulatedPoints,
      strikes: current.boardPlay?.strikes ?? 0,
      maxStrikes: this.#maxStrikes,
    };
  }

  /**
   * Render a `Deadline` as the client-safe `Round4TimerView`. Pure display
   * data — `remainingMs` is recomputed from the clock every call, so a plain
   * snapshot refresh reflects real elapsed time rather than restarting the
   * countdown, and a paused deadline reports its remaining time frozen at the
   * moment it paused (D-011), exactly as `hasExpired`/`remainingMs` already
   * guarantee for the deadline itself.
   */
  #timerView(deadline: Deadline): Round4TimerView {
    return {
      durationMs: deadline.durationMs,
      remainingMs: remainingMs(this.#clock, deadline),
      paused: isPaused(deadline),
      expired: hasExpired(this.#clock, deadline),
      startedAt: asServerTimestamp(deadline.startedAt),
    };
  }

  #faceoffView(faceoff: FaceoffState): Round4FaceoffView {
    return {
      status: faceoff.status,
      participantTeamIds: faceoff.participantTeamIds,
      buzzedTeamId: faceoff.buzzedTeamId,
      buzzedAt: faceoff.buzzedAt,
      opponentTeamId: faceoff.opponentTeamId,
      winningTeamId: faceoff.winningTeamId,
      playDecision: faceoff.playDecision,
      answerTimer: faceoff.answerDeadline === null ? null : this.#timerView(faceoff.answerDeadline),
    };
  }

  #boardPlayView(boardPlay: BoardPlayState): Round4BoardPlayView {
    return {
      controllingTeamId: boardPlay.controllingTeamId,
      playerOrder: [...boardPlay.playerOrder],
      currentPlayerIndex: boardPlay.currentPlayerIndex,
      strikes: boardPlay.strikes,
      turnTimer: boardPlay.turnDeadline === null ? null : this.#timerView(boardPlay.turnDeadline),
    };
  }

  #stealView(steal: StealState): Round4StealView {
    return {
      status: steal.status,
      stealingTeamId: steal.stealingTeamId,
      defendingTeamId: steal.defendingTeamId,
      wagerId: steal.wagerId,
      wagerAmount: steal.wagerAmount,
      maxWager: null,
      resolved: steal.resolved,
      won: steal.won,
      conferTimer: steal.conferDeadline === null ? null : this.#timerView(steal.conferDeadline),
    };
  }

  #surveyView(current: SurveySlot, forHost: boolean): Round4SurveyView {
    return {
      progress: current.progress,
      board: this.#boardView(current, forHost),
      faceoff: current.faceoff === null ? null : this.#faceoffView(current.faceoff),
      boardPlay: current.boardPlay === null ? null : this.#boardPlayView(current.boardPlay),
      steal: current.steal === null ? null : this.#stealView(current.steal),
      resolvedWinnerTeamId: current.resolvedWinnerTeamId,
      awardedBb: current.awardedBb,
      resolvedAt: current.resolvedAt,
    };
  }

  /**
   * `forHost` reveals unrevealed board answer text/value — see `#boardView`'s
   * doc comment. Defaults to `false` (the player-safe shape) so every
   * existing internal call that does not explicitly ask for the Host shape
   * keeps the original secrecy guarantee automatically.
   */
  view(forHost = false): Round4StateView {
    return {
      roundIndex: ROUND4_ROUND_INDEX,
      enteringStandings: this.#enteringStandings,
      matchupStage: this.#matchupStage,
      matchupTeamIds: this.#matchupTeamIds,
      inactiveTeamId: this.#inactiveTeamId,
      scoringGates: this.scoringGates,
      surveysPlayedInMatchup: this.#surveysPlayedInMatchup,
      current: this.#current === null ? null : this.#surveyView(this.#current, forHost),
      complete: this.#complete,
      matchupWinnerTeamId: this.#matchupWinnerTeamId,
      round4WinnerTeamId: this.#round4WinnerTeamId,
    };
  }
}
