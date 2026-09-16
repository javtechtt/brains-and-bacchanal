import {
  asChallengeId,
  asServerTimestamp,
  asTeamId,
  err,
  GAME_EVENTS,
  ok,
  rejection,
  type BbChangeReason,
  type BbLedgerEntry,
  type ChallengeId,
  type ChallengeStatus,
  type GameChallengeResult,
  type GameChallengeView,
  type GamePauseView,
  type GamePhase,
  type GameSessionView,
  type GameTeamView,
  type HostRuling,
  type HostRulingKind,
  type PauseReason,
  type PlayerId,
  type Rejection,
  type Result,
  type RoomId,
  type SequenceNumber,
  type TeamId,
  type TimerView,
  type TurnOwnership,
  NO_TURN,
} from '@bb/protocol';
import { BbLedger } from './bb-ledger.js';
import type { Clock } from './clock.js';
import type { EventLog } from './event-log.js';
import { TimerService } from './timer-service.js';
import { applyTransition, type PhaseState } from './transitions.js';

/**
 * The generic authoritative game engine — Phase 5.
 *
 * ================== GENERIC BY CONSTRUCTION ==================
 * There is no round here. No trivia question, no Think Fast order, no logo, no
 * Family Feud board, no card, no Market item, no Maco Mail outcome, no wager
 * and no buzzer. `challengeType` is a plain string the Host supplies.
 *
 * That is not incompleteness — it is the point. OPEN_RULES.md leaves Round 1
 * allocation, Think Fast's timer and three-team order, Guess the Logo scoring,
 * the All Answers Begin With format, Sing a Song's timings and the Round 4 /
 * Sudden Death timers unresolved. An engine that knew about rounds would have to
 * assume answers to those. This one runs a challenge without knowing what the
 * challenge is, so Phases 6-7 can add each round's rules without reshaping it.
 * ============================================================
 *
 * What it IS authoritative for (CLAUDE.md, ARCHITECTURE.md §4):
 *   - the BB ledger and the floor at zero,
 *   - the phase, and which transitions are legal,
 *   - challenge lifecycle,
 *   - turn ownership and which players are active,
 *   - timers and their expiry,
 *   - pause and resume,
 *   - the record of every Host ruling.
 *
 * What the HOST is authoritative for: whether a spoken answer counts, who spoke
 * first, who won a physical or creative challenge. Those arrive as rulings and
 * are recorded; the engine never second-guesses one, and never invents one.
 *
 * Transport-free: intents in, events out, driven entirely by a FakeClock in
 * tests. It holds a reference to the room's EventLog so that gameplay and lobby
 * events share ONE sequence — a client must be able to order "Team A reached
 * 1,500 BB" against "Javal disconnected", and two independent counters could
 * not express that.
 */

export interface GameEngineOptions {
  readonly roomId: RoomId;
  readonly clock: Clock;
  readonly log: EventLog;
  readonly mintId: () => string;
  /**
   * Whether development engine controls are accepted.
   *
   * Phase 5 spec §17 asks for test tooling; §17 also says it must be clearly
   * development-only. Gating it on a server flag means a production deployment
   * physically cannot accept DEV_ADJUST_BB, however a client is built.
   */
  readonly devTools: boolean;
}

/** A team as the engine needs it at game start. Supplied by the room. */
export interface StartingTeam {
  readonly teamId: TeamId;
  readonly displayName: string;
  readonly memberIds: readonly PlayerId[];
}

/** An accepted engine action: the event to publish, plus optional extras. */
export interface EngineChange {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export class GameEngine {
  readonly #options: GameEngineOptions;
  readonly #clock: Clock;
  readonly #log: EventLog;
  readonly #ledger: BbLedger;
  readonly #timer: TimerService;

  #started = false;
  #gameId: string | null = null;
  #startedAt = 0;
  #roundIndex = 0;

  #phase: PhaseState = { phase: 'TEAM_LOCK', resumePhase: null, pauseReason: null };
  #pausedAt = 0;
  #pausedByPlayerId: PlayerId | null = null;

  readonly #teams = new Map<string, GameTeamView>();

  #challenge: InternalChallenge | null = null;
  #turn: TurnOwnership = NO_TURN;
  /**
   * Players whose participation the CURRENT challenge requires.
   *
   * THE OPERATIONAL DEFINITION OF "ACTIVE PLAYER" (Phase 5 spec §9). D-011
   * pauses the game when an active player disconnects, so this set decides
   * whether a dropped phone stops the party. It is set deliberately by the
   * engine — never inferred from who is connected, and never "everyone in the
   * room", because most of the room is watching at any moment.
   */
  readonly #activePlayers = new Set<string>();

  constructor(options: GameEngineOptions) {
    this.#options = options;
    this.#clock = options.clock;
    this.#log = options.log;
    this.#ledger = new BbLedger(options.clock, options.mintId);
    this.#timer = new TimerService(options.clock, options.mintId);
  }

  // -------------------------------------------------------------------------
  // Read access
  // -------------------------------------------------------------------------

  get started(): boolean {
    return this.#started;
  }

  get phase(): GamePhase {
    return this.#phase.phase;
  }

  get paused(): boolean {
    return this.#phase.phase === 'PAUSED';
  }

  get turn(): TurnOwnership {
    return this.#turn;
  }

  get ledgerEntries(): readonly BbLedgerEntry[] {
    return this.#ledger.entries();
  }

  get devTools(): boolean {
    return this.#options.devTools;
  }

  balanceOf(teamId: TeamId): number {
    return this.#ledger.balanceOf(teamId);
  }

  teams(): readonly GameTeamView[] {
    return [...this.#teams.values()].map((team) => ({
      ...team,
      bb: this.#ledger.balanceOf(team.teamId),
    }));
  }

  /** Whether a player is currently required by the active challenge. */
  isActivePlayer(playerId: PlayerId): boolean {
    return this.#activePlayers.has(playerId);
  }

  activePlayerIds(): readonly PlayerId[] {
    return [...this.#activePlayers] as PlayerId[];
  }

  timerView(): TimerView | null {
    return this.#timer.view();
  }

  /** The session as clients see it. Null before the game starts. */
  sessionView(): GameSessionView | null {
    if (!this.#started || this.#gameId === null) return null;

    return {
      gameId: this.#gameId,
      roomId: this.#options.roomId,
      phase: this.#phase.phase,
      startedAt: asServerTimestamp(this.#startedAt),
      roundIndex: this.#roundIndex,
      paused: this.paused,
      pause: this.#pauseView(),
      challenge: this.challengeView(),
      turn: this.#turn,
    };
  }

  #pauseView(): GamePauseView | null {
    if (this.#phase.phase !== 'PAUSED' || this.#phase.resumePhase === null) return null;
    return {
      reason: this.#phase.pauseReason ?? 'host_requested',
      pausedAt: asServerTimestamp(this.#pausedAt),
      resumePhase: this.#phase.resumePhase,
      pausedByPlayerId: this.#pausedByPlayerId,
    };
  }

  /**
   * The current challenge as clients see it.
   *
   * CONTENT SAFETY: carries `configRef`, never question text, accepted answers
   * or board labels. CONTENT_POLICY.md — there is nowhere here to put content,
   * which is the protection rather than a rule someone must remember.
   */
  challengeView(): GameChallengeView | null {
    const challenge = this.#challenge;
    if (challenge === null) return null;

    return {
      challengeId: challenge.challengeId,
      challengeType: challenge.challengeType,
      status: challenge.status,
      configRef: challenge.configRef,
      turn: this.#turn,
      activePlayerIds: this.activePlayerIds(),
      startedAt: challenge.startedAt,
      timer: this.#timer.view(),
      rulings: [...challenge.rulings],
      result: challenge.result,
    };
  }

  // -------------------------------------------------------------------------
  // Game start
  // -------------------------------------------------------------------------

  /**
   * Start the game from a locked lobby.
   *
   * Preconditions are the caller's to check for room status; what the engine
   * enforces is that a game starts exactly once. Phase 5 spec §1 — "Starting a
   * game twice must be rejected" — and the idempotency layer above catches a
   * retried intent, but a SECOND distinct START_GAME intent would slip past it,
   * so the guard lives here too.
   *
   * GAME_RULES_LOCKED.md §1 — each participating team is seeded with 1,000 BB,
   * server-side. No client calculates a starting balance.
   */
  startGame(teams: readonly StartingTeam[]): Result<EngineChange> {
    if (this.#started) {
      return err(rejection('WRONG_STATE', 'The game has already started.'));
    }
    if (teams.length === 0) {
      return err(rejection('ILLEGAL_ACTION', 'No teams to start with.'));
    }

    this.#started = true;
    this.#gameId = this.#options.mintId();
    this.#startedAt = this.#clock.now();
    // Starting the game enters the first round intro below, and that IS round
    // one. Counted here rather than left to advancePhase, which never sees this
    // transition.
    this.#roundIndex = 1;

    for (const team of teams) {
      this.#teams.set(team.teamId, {
        teamId: team.teamId,
        displayName: team.displayName,
        memberIds: [...team.memberIds],
        bb: 0,
      });
      // Seeded through the ledger, so a team's history begins with the reason
      // its first BB exists rather than an unexplained number.
      this.#ledger.seed(team.teamId);
    }

    // TEAM_LOCK -> ROUND_INTRO is the transition the state machine already
    // defines for this. Using it rather than assigning a phase keeps every
    // phase change in one place (docs/STATE_MACHINE.md).
    const moved = applyTransition(this.#phase, { kind: 'advance', to: 'ROUND_INTRO' }, {
      kind: 'server',
    });
    if (moved.ok) this.#phase = moved.state;

    return ok({
      type: GAME_EVENTS.GAME_STARTED,
      payload: {
        gameId: this.#gameId,
        phase: this.#phase.phase,
        roundIndex: this.#roundIndex,
        teams: this.teams(),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Phase
  // -------------------------------------------------------------------------

  /**
   * Move to another generic phase.
   *
   * Legality is decided by the transition table, not by this method. A caller
   * names a destination and is refused if the state machine does not allow it,
   * which is what stops round code inventing a flow.
   */
  advancePhase(to: GamePhase): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const outcome = applyTransition(this.#phase, { kind: 'advance', to }, { kind: 'host', sessionId: '' as never });
    if (!outcome.ok) return err(outcome.error);

    const previous = this.#phase.phase;
    this.#phase = outcome.state;

    // Entering a round intro means a new round. The index is a generic counter
    // for presentation and logs; it decides nothing about what the round
    // contains, which is Phase 7's and still partly open.
    if (to === 'ROUND_INTRO' && previous !== 'ROUND_INTRO') {
      this.#roundIndex += 1;
    }

    return ok({
      type: GAME_EVENTS.PHASE_CHANGED,
      payload: { phase: to, previousPhase: previous, roundIndex: this.#roundIndex },
    });
  }

  // -------------------------------------------------------------------------
  // Challenge lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create a challenge container.
   *
   * Generic: a type string and an optional configuration reference. The engine
   * does not know, and must not learn, what the type means.
   */
  prepareChallenge(input: {
    readonly challengeType: string;
    readonly configRef?: string | null;
  }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    if (this.#phase.phase !== 'CHALLENGE_INTRO') {
      return err(
        rejection('WRONG_STATE', 'A challenge can only be prepared during CHALLENGE_INTRO.', {
          phase: this.#phase.phase,
        }),
      );
    }

    if (this.#challenge !== null && this.#challenge.status !== 'resolved') {
      return err(
        rejection('ILLEGAL_ACTION', 'Finish the current challenge first.', {
          challengeId: this.#challenge.challengeId,
          status: this.#challenge.status,
        }),
      );
    }

    if (input.challengeType.trim() === '') {
      return err(rejection('INVALID_REQUEST', 'A challenge needs a type.'));
    }

    const challengeId = asChallengeId(this.#options.mintId());
    this.#challenge = {
      challengeId,
      challengeType: input.challengeType,
      configRef: input.configRef ?? null,
      status: 'pending',
      startedAt: null,
      rulings: [],
      result: null,
    };

    // A new challenge inherits nothing: stale turn ownership or a stale active
    // player from the previous challenge would silently decide who a disconnect
    // pauses the game for.
    this.#turn = NO_TURN;
    this.#activePlayers.clear();
    this.#timer.cancel();

    return ok({
      type: GAME_EVENTS.CHALLENGE_PREPARED,
      payload: {
        challengeId,
        challengeType: input.challengeType,
        configRef: input.configRef ?? null,
      },
    });
  }

  /** Begin the prepared challenge and enter ACTIVE_PLAY. */
  startChallenge(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const challenge = this.#challenge;
    if (challenge === null) {
      return err(rejection('NOT_FOUND', 'There is no challenge to start.'));
    }
    if (challenge.status !== 'pending') {
      return err(
        rejection('ILLEGAL_ACTION', 'This challenge has already started.', {
          status: challenge.status,
        }),
      );
    }

    const outcome = applyTransition(this.#phase, { kind: 'advance', to: 'ACTIVE_PLAY' }, {
      kind: 'host',
      sessionId: '' as never,
    });
    if (!outcome.ok) return err(outcome.error);

    this.#phase = outcome.state;
    challenge.status = 'active';
    challenge.startedAt = asServerTimestamp(this.#clock.now());

    return ok({
      type: GAME_EVENTS.CHALLENGE_STARTED,
      payload: {
        challengeId: challenge.challengeId,
        challengeType: challenge.challengeType,
        phase: this.#phase.phase,
        startedAt: challenge.startedAt,
      },
    });
  }

  /** Hand the challenge to the Host for a subjective decision. */
  requestReview(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const challenge = this.#challenge;
    if (challenge === null) {
      return err(rejection('NOT_FOUND', 'There is no challenge under way.'));
    }

    const outcome = applyTransition(this.#phase, { kind: 'advance', to: 'HOST_REVIEW' }, {
      kind: 'host',
      sessionId: '' as never,
    });
    if (!outcome.ok) return err(outcome.error);

    this.#phase = outcome.state;
    challenge.status = 'awaiting_host';
    // A challenge waiting on a human is not running against a clock.
    this.#timer.pause();

    return ok({
      type: GAME_EVENTS.REVIEW_REQUESTED,
      payload: { challengeId: challenge.challengeId, phase: this.#phase.phase },
    });
  }

  /**
   * Record a Host ruling.
   *
   * CLAUDE.md — the Host is authoritative for subjective matters, and "Host
   * decisions still go through the server so they are recorded." The engine
   * records; it never re-judges, and it attaches no BB. What a ruling is worth
   * is decided when the challenge resolves, against rules that in most cases
   * are not written yet.
   *
   * Authority is the CALLER's to check — the room verifies the connection holds
   * Host role before reaching here, exactly as every other Host action does.
   */
  recordRuling(input: {
    readonly kind: HostRulingKind;
    readonly teamId?: TeamId | null;
    readonly playerId?: PlayerId | null;
    readonly note?: string | null;
    readonly seq: SequenceNumber;
  }): Result<HostRuling> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const challenge = this.#challenge;
    if (challenge === null) {
      return err(rejection('NOT_FOUND', 'There is no challenge to rule on.'));
    }
    if (challenge.status === 'resolved') {
      return err(rejection('WRONG_STATE', 'This challenge is already resolved.'));
    }

    if (input.teamId !== undefined && input.teamId !== null && !this.#teams.has(input.teamId)) {
      return err(rejection('NOT_FOUND', 'Unknown team.', { teamId: input.teamId }));
    }

    const ruling: HostRuling = {
      rulingId: this.#options.mintId(),
      kind: input.kind,
      challengeId: challenge.challengeId,
      teamId: input.teamId ?? null,
      playerId: input.playerId ?? null,
      at: asServerTimestamp(this.#clock.now()),
      seq: input.seq,
      note: input.note ?? null,
    };

    challenge.rulings.push(ruling);
    return ok(ruling);
  }

  /**
   * Resolve the challenge, applying any BB through the ledger.
   *
   * Phase 5 spec §16 — the result model must carry later outcomes without
   * knowing every round. It records who won and what moved; the amounts come
   * from the caller, which in Phase 7 will be a round's locked rules and today
   * is a Host's test input.
   *
   * BB NEVER MOVES ANY OTHER WAY. Every award here goes through the ledger, so
   * the floor at zero and the audit trail apply to a challenge award exactly as
   * they do to everything else.
   */
  resolveChallenge(input: {
    readonly winningTeamIds?: readonly TeamId[];
    readonly winningPlayerIds?: readonly PlayerId[];
    readonly bbDeltas?: Readonly<Record<string, number>>;
    readonly decidedByHost?: boolean;
    readonly completion?: 'completed' | 'abandoned';
    readonly note?: string | null;
  }): Result<{ readonly change: EngineChange; readonly ledgerEntries: readonly BbLedgerEntry[] }> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const challenge = this.#challenge;
    if (challenge === null) {
      return err(rejection('NOT_FOUND', 'There is no challenge to resolve.'));
    }
    // Phase 5 spec §19 — a duplicate resolution must not award twice. The
    // idempotency registry catches a retried intent; this catches a second,
    // genuinely distinct attempt to resolve the same challenge.
    if (challenge.status === 'resolved') {
      return err(
        rejection('WRONG_STATE', 'This challenge is already resolved.', {
          challengeId: challenge.challengeId,
        }),
      );
    }

    const deltas = input.bbDeltas ?? {};
    for (const teamId of Object.keys(deltas)) {
      if (!this.#teams.has(teamId)) {
        return err(rejection('NOT_FOUND', 'Unknown team in result.', { teamId }));
      }
      const delta = deltas[teamId];
      if (typeof delta !== 'number' || !Number.isFinite(delta)) {
        return err(rejection('INVALID_REQUEST', 'BB delta must be a finite number.', { teamId }));
      }
    }

    for (const teamId of input.winningTeamIds ?? []) {
      if (!this.#teams.has(teamId)) {
        return err(rejection('NOT_FOUND', 'Unknown winning team.', { teamId }));
      }
    }

    // Validation is complete before anything is applied, so a rejected result
    // cannot leave one team paid and another not.
    const applied: Record<string, number> = {};
    const entries: BbLedgerEntry[] = [];

    for (const [teamId, delta] of Object.entries(deltas)) {
      const outcome = this.#ledger.apply({
        teamId: asTeamId(teamId),
        delta,
        reason: 'challenge_result',
        challengeId: challenge.challengeId,
        ...(input.note === undefined || input.note === null ? {} : { note: input.note }),
      });
      applied[teamId] = outcome.entry.applied;
      entries.push(outcome.entry);
    }

    const result: GameChallengeResult = {
      winningTeamIds: [...(input.winningTeamIds ?? [])],
      winningPlayerIds: [...(input.winningPlayerIds ?? [])],
      bbApplied: applied,
      decidedByHost: input.decidedByHost ?? true,
      resolvedAt: asServerTimestamp(this.#clock.now()),
      completion: input.completion ?? 'completed',
      note: input.note ?? null,
    };

    challenge.status = 'resolved';
    challenge.result = result;

    // A resolved challenge requires nobody, so nobody's disconnect should pause
    // the game on its account.
    this.#activePlayers.clear();
    this.#turn = NO_TURN;
    this.#timer.cancel();

    const moved = applyTransition(this.#phase, { kind: 'advance', to: 'RESULT' }, {
      kind: 'host',
      sessionId: '' as never,
    });
    if (moved.ok) this.#phase = moved.state;

    return ok({
      change: {
        type: GAME_EVENTS.CHALLENGE_RESOLVED,
        payload: {
          challengeId: challenge.challengeId,
          result,
          phase: this.#phase.phase,
          teams: this.teams(),
        },
      },
      ledgerEntries: entries,
    });
  }

  // -------------------------------------------------------------------------
  // Turn ownership and active players
  // -------------------------------------------------------------------------

  /**
   * Set whose turn it is.
   *
   * ONLY THE SERVER ASSIGNS A TURN. This is reached through a Host intent that
   * the room has already authorised; a player client has no route to it at all,
   * which is what Phase 5 spec §8 requires.
   *
   * It decides no round's order: Round 1 allocation (OPEN_RULES.md §1) and the
   * Think Fast three-team order (§3) are open, and nothing here chooses either.
   */
  setTurn(turn: TurnOwnership): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    if (turn.teamId !== null && !this.#teams.has(turn.teamId)) {
      return err(rejection('NOT_FOUND', 'Unknown team.', { teamId: turn.teamId }));
    }
    // A player turn without a team would leave "whose turn is it" ambiguous at
    // the team level, which every later round needs to answer.
    if (turn.playerId !== null && turn.teamId === null) {
      return err(rejection('INVALID_REQUEST', 'A player turn needs a team.'));
    }
    if (turn.playerId !== null && !this.#teamHasMember(turn.teamId, turn.playerId)) {
      return err(
        rejection('ILLEGAL_ACTION', 'That player is not on that team.', {
          playerId: turn.playerId,
          teamId: turn.teamId ?? '',
        }),
      );
    }

    const previous = this.#turn;
    this.#turn = { teamId: turn.teamId, playerId: turn.playerId };

    return ok({
      type: GAME_EVENTS.TURN_CHANGED,
      payload: { turn: this.#turn, previousTurn: previous },
    });
  }

  /**
   * Declare which players the challenge currently requires.
   *
   * This is what D-011 keys on. Marking a player active means their phone
   * dropping will stop the game; leaving them out means it will not. Later
   * rounds call this when they nominate an answerer, pass control, or open a
   * challenge to a whole team.
   */
  setActivePlayers(playerIds: readonly PlayerId[]): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    for (const playerId of playerIds) {
      if (!this.#anyTeamHasMember(playerId)) {
        return err(
          rejection('NOT_FOUND', 'Unknown player, or not on a participating team.', { playerId }),
        );
      }
    }

    const previous = this.activePlayerIds();
    this.#activePlayers.clear();
    for (const playerId of playerIds) this.#activePlayers.add(playerId);

    return ok({
      type: GAME_EVENTS.ACTIVE_PLAYERS_CHANGED,
      payload: { activePlayerIds: this.activePlayerIds(), previousActivePlayerIds: previous },
    });
  }

  #teamHasMember(teamId: TeamId | null, playerId: PlayerId): boolean {
    if (teamId === null) return false;
    return this.#teams.get(teamId)?.memberIds.includes(playerId) ?? false;
  }

  #anyTeamHasMember(playerId: PlayerId): boolean {
    for (const team of this.#teams.values()) {
      if (team.memberIds.includes(playerId)) return true;
    }
    return false;
  }

  /**
   * Update a team's roster.
   *
   * Teams are locked before a game starts, so this exists for one case: the
   * Host removing a player mid-game. The roster must not keep naming someone
   * who is gone, or a turn could be assigned to a player who cannot answer.
   */
  removeMember(playerId: PlayerId): void {
    for (const [teamId, team] of this.#teams) {
      if (!team.memberIds.includes(playerId)) continue;
      this.#teams.set(teamId, {
        ...team,
        memberIds: team.memberIds.filter((id) => id !== playerId),
      });
    }
    this.#activePlayers.delete(playerId);
    if (this.#turn.playerId === playerId) {
      this.#turn = { teamId: this.#turn.teamId, playerId: null };
    }
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  /**
   * Start a server-authoritative timer.
   *
   * The duration comes from the caller. No challenge duration is decided here —
   * OPEN_RULES.md §2, §6 and §11 leave the real ones open.
   */
  startTimer(durationMs: number): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return err(rejection('INVALID_REQUEST', 'Timer duration must be a positive number.'));
    }

    const challengeId = this.#challenge?.challengeId ?? null;
    const view = this.#timer.start({ durationMs, challengeId });

    return ok({ type: GAME_EVENTS.TIMER_STARTED, payload: { timer: view } });
  }

  cancelTimer(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const cancelled = this.#timer.cancel();
    if (cancelled === null) {
      return err(rejection('NOT_FOUND', 'No timer is running.'));
    }
    return ok({ type: GAME_EVENTS.TIMER_CANCELLED, payload: { timer: cancelled } });
  }

  /**
   * Report a timer that has run out, exactly once.
   *
   * WHAT EXPIRY MEANS IS NOT DECIDED HERE. Phase 5 spec §13 forbids assuming
   * that a timeout is a wrong answer; no locked rule says so, and different
   * challenges will differ. The engine states the fact, hands the challenge to
   * the Host by moving to HOST_REVIEW, and stops. What happens next is a Host
   * ruling, or a round's rules once those exist.
   *
   * Called by the owning room whenever it touches the session, so expiry is
   * observed without this package scheduling anything — it has no wall clock.
   */
  pollTimerExpiry(): EngineChange | null {
    if (!this.#started || this.paused) return null;

    const expired = this.#timer.expireIfDue();
    if (expired === null) return null;

    let phase = this.#phase.phase;
    const challenge = this.#challenge;

    // Only a challenge that is actually running gets handed to the Host. An
    // expired timer with no live challenge is reported and nothing more.
    if (challenge !== null && challenge.status === 'active') {
      const moved = applyTransition(this.#phase, { kind: 'advance', to: 'HOST_REVIEW' }, {
        kind: 'server',
      });
      if (moved.ok) {
        this.#phase = moved.state;
        challenge.status = 'awaiting_host';
        phase = moved.state.phase;
      }
    }

    return {
      type: GAME_EVENTS.TIMER_EXPIRED,
      payload: {
        timer: expired,
        phase,
        challengeId: challenge?.challengeId ?? null,
        // Said plainly on the wire so no client invents a consequence either.
        requiresHostDecision: true,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Pause and resume
  // -------------------------------------------------------------------------

  /**
   * Pause the game.
   *
   * GAME_RULES_LOCKED.md §20 / D-011. The running timer freezes with its
   * remaining time intact, the interrupted phase is captured so a resume
   * returns exactly there, and nothing else about the challenge is disturbed.
   *
   * PAUSE IS AN OVERLAY, NOT A PHASE TRANSITION (Phase 5 spec §11, and the
   * design docs/STATE_MACHINE.md commits to). The challenge, the turn, the
   * active players and the timer all survive untouched — resuming restores the
   * situation rather than approximating it.
   */
  pause(reason: PauseReason, pausedByPlayerId: PlayerId | null = null): Result<EngineChange> {
    const guard = this.#requireStarted();
    if (guard !== null) return err(guard);

    const outcome = applyTransition(this.#phase, { kind: 'pause', reason }, { kind: 'server' });
    if (!outcome.ok) return err(outcome.error);

    this.#phase = outcome.state;
    this.#pausedAt = this.#clock.now();
    this.#pausedByPlayerId = pausedByPlayerId;
    this.#timer.pause();

    return ok({
      type: GAME_EVENTS.GAME_PAUSED,
      payload: {
        reason,
        pausedByPlayerId,
        resumePhase: outcome.state.resumePhase,
        timer: this.#timer.view(),
      },
    });
  }

  /**
   * Resume.
   *
   * ONLY THE HOST. Authority is enforced inside `applyTransition`, not here, so
   * there is exactly one implementation of the rule and no call site can bypass
   * it. A reconnect is a server-side event and the server is not the Host,
   * which is precisely why reconnection alone can never resume a game.
   */
  resume(actorIsHost: boolean): Result<EngineChange> {
    const guard = this.#requireStarted();
    if (guard !== null) return err(guard);

    const actor = actorIsHost
      ? ({ kind: 'host', sessionId: '' as never } as const)
      : ({ kind: 'server' } as const);

    const outcome = applyTransition(this.#phase, { kind: 'resume' }, actor);
    if (!outcome.ok) return err(outcome.error);

    this.#phase = outcome.state;
    this.#pausedByPlayerId = null;
    // The timer picks up with exactly the time it had — the paused stretch is
    // banked and excluded from elapsed time.
    this.#timer.resume();

    return ok({
      type: GAME_EVENTS.GAME_RESUMED,
      payload: { phase: this.#phase.phase, timer: this.#timer.view() },
    });
  }

  /**
   * An active player's connection dropped.
   *
   * D-011: "active player disconnect → automatic pause". Returns the pause
   * event when this disconnect caused one, and null when it did not.
   *
   * NOT EVERY DISCONNECT PAUSES. A player the challenge does not currently
   * require is simply marked away — Phase 5 spec §10 — because pausing for a
   * spectator would stop the party every time someone's phone slept. And an
   * already-paused game is left alone: nesting a second pause would overwrite
   * the captured return phase, so the game would resume somewhere other than
   * where it stopped.
   */
  onActivePlayerDisconnect(playerId: PlayerId): EngineChange | null {
    if (!this.#started) return null;
    if (!this.#activePlayers.has(playerId)) return null;
    if (this.paused) return null;

    const outcome = this.pause('player_disconnect', playerId);
    return outcome.ok ? outcome.value : null;
  }

  // -------------------------------------------------------------------------
  // BB
  // -------------------------------------------------------------------------

  /**
   * Move BB directly.
   *
   * Used by the Host's development controls and by Host adjustments. Round
   * awards do NOT come through here — they come from resolving a challenge, so
   * that an award is always attached to the thing that earned it.
   */
  adjustBb(input: {
    readonly teamId: TeamId;
    readonly delta: number;
    readonly reason: BbChangeReason;
    readonly note?: string | null;
  }): Result<{ readonly change: EngineChange; readonly entry: BbLedgerEntry }> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    if (!this.#teams.has(input.teamId)) {
      return err(rejection('NOT_FOUND', 'Unknown team.', { teamId: input.teamId }));
    }
    if (!Number.isFinite(input.delta)) {
      return err(rejection('INVALID_REQUEST', 'BB amount must be a finite number.'));
    }

    const outcome = this.#ledger.apply({
      teamId: input.teamId,
      delta: input.delta,
      reason: input.reason,
      ...(input.note === undefined || input.note === null ? {} : { note: input.note }),
    });

    return ok({
      change: {
        type: GAME_EVENTS.BB_CHANGED,
        payload: {
          teamId: input.teamId,
          delta: outcome.entry.delta,
          applied: outcome.entry.applied,
          balance: outcome.entry.balanceAfter,
          reason: outcome.entry.reason,
          // Said explicitly rather than left for a client to infer by comparing
          // delta and applied: a Host looking at "-5000 → 0" needs to see that
          // the floor did that, not a bug.
          clampedAtFloor: outcome.clamped,
          teams: this.teams(),
        },
      },
      entry: outcome.entry,
    });
  }

  /** Link a ledger entry to the event that carried it. */
  attachLedgerSeq(entryId: string, seq: SequenceNumber): void {
    this.#ledger.attachSeq(entryId, seq);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #requireStarted(): Rejection | null {
    if (!this.#started) {
      return rejection('WRONG_STATE', 'The game has not started.');
    }
    return null;
  }

  /**
   * Guard a gameplay action that must not proceed while paused.
   *
   * GAME_RULES_LOCKED.md §20 — when the game pauses, gameplay stops. The
   * transition table already refuses an ordinary `advance` out of PAUSED, but
   * several engine actions change state WITHOUT a phase transition: resolving a
   * challenge moves BB, a ruling is recorded, a turn is reassigned. Those would
   * otherwise slip past a pause, which is exactly the hole D-011 exists to
   * close — a player's phone dies and the game keeps awarding BB without them.
   *
   * Pause, resume and read access are deliberately NOT guarded: pausing while
   * paused has its own rejection, and resuming is the one action that must work.
   */
  #requireRunning(): Rejection | null {
    const started = this.#requireStarted();
    if (started !== null) return started;

    if (this.paused) {
      return rejection('WRONG_STATE', 'The game is paused. Only the Host can resume it.', {
        phase: this.#phase.phase,
      });
    }
    return null;
  }

  /** Exposed for the owning room to append engine events to the shared log. */
  get log(): EventLog {
    return this.#log;
  }
}

/** Mutable server-side challenge record. Never serialised directly. */
interface InternalChallenge {
  readonly challengeId: ChallengeId;
  readonly challengeType: string;
  readonly configRef: string | null;
  status: ChallengeStatus;
  startedAt: ReturnType<typeof asServerTimestamp> | null;
  readonly rulings: HostRuling[];
  result: GameChallengeResult | null;
}
