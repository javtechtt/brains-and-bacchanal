import {
  asChallengeId,
  asServerTimestamp,
  asTeamId,
  CARD_CHALLENGE_KINDS,
  err,
  GAME_EVENTS,
  HOST_DEAL_TEMPLATES,
  MARKET_ITEMS,
  ok,
  PLUS_15_SECONDS_MS,
  rejection,
  ROUND1_EVENTS,
  ROUND1_ROUND_INDEX,
  ROUND1_VALUES,
  ROUND2_CHALLENGES,
  ROUND2_EVENTS,
  ROUND2_ROUND_INDEX,
  ROUND3_CHALLENGES,
  ROUND3_EVENTS,
  ROUND3_ROUND_INDEX,
  isRpsChoice,
  type CardChallengeKind,
  type HostDealTemplate,
  type MarketItem,
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
  type Round1ContentItem,
  type Round1Difficulty,
  type Round1GradeSource,
  type Round1StateView,
  type Round1Verdict,
  type Round2StateView,
  type Round3ContentItem,
  type Round3StateView,
  type SequenceNumber,
  type TeamId,
  type TimerView,
  type TurnOwnership,
  NO_TURN,
} from '@bb/protocol';
import { Round1 } from './round1.js';
import { Round2 } from './round2.js';
import { Round3 } from './round3.js';
import { BbLedger } from './bb-ledger.js';
import type { Clock } from './clock.js';
import type { EventLog } from './event-log.js';
import type { Rng } from './rng.js';
import { SystemRng } from './rng.js';
import { SharedSystems } from './shared-systems.js';
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
  /**
   * Source of randomness for the Phase 6 shared systems.
   *
   * Injected for the same reason the Clock is: a card deal, a Maco Mail shuffle
   * and a Card Confiscation all decide something players will argue about, and a
   * test that cannot fix them cannot assert anything about them. Defaults to
   * real randomness so production callers need not think about it.
   */
  readonly rng?: Rng;
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
  /**
   * The Phase 6 shared systems: cards, Clash, Market, advantages, Maco Mail,
   * Host Deals and wagers.
   *
   * Held by the engine rather than beside it because every one of them moves BB
   * through the SAME ledger, and several key on the challenge and pause state
   * the engine owns. Keeping them here is what makes "a purchase cannot happen
   * while the game is paused" a single guard rather than a rule each subsystem
   * must remember.
   */
  readonly #shared: SharedSystems;

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
   * Round 2 progression, once the round is entered. Phase 7A.
   *
   * Null for every other round, which is what keeps the engine generic: a
   * round's state exists only while that round is being played, and the engine
   * knows nothing about Round 2 beyond holding this and routing three intents
   * to it.
   */
  #round2: Round2 | null = null;
  /** Round 3 progression, once the round is entered. Null otherwise. */
  #round3: Round3 | null = null;
  /** Round 1 progression, once the round is entered. Null otherwise. */
  #round1: Round1 | null = null;
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
    this.#shared = new SharedSystems({
      clock: options.clock,
      rng: options.rng ?? new SystemRng(),
      mintId: options.mintId,
      ledger: this.#ledger,
    });
  }

  /**
   * The Phase 6 shared systems.
   *
   * Exposed for the room to route intents to, and for tests. Every mutating
   * path through it is still gated by the engine's own guards — see the
   * `shared*` methods below, which is where pause, phase and challenge
   * preconditions are applied before a subsystem is touched.
   */
  get shared(): SharedSystems {
    return this.#shared;
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
      // Phase 7A. Null outside Round 2, and identical for Host and players —
      // which game is running and who won are exactly what a party game puts on
      // a TV. Nothing secret travels here; §21's secrets stay in the Phase 6
      // views.
      round2: this.round2View(),
      // Phase 7B. Null outside Round 3. The team-scoped variant is built by the
      // room, which knows who is asking; this default hides every RPS choice.
      round3: this.round3View(),
      // Phase 7C. Null outside Round 1. The viewer-scoped variant is built by
      // the room, which knows who is asking; this default hides every submitted
      // answer and every Maco! viewing.
      round1: this.round1View(),
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
    let expired: ReturnType<SharedSystems['endRound']> | null = null;
    if (to === 'ROUND_INTRO' && previous !== 'ROUND_INTRO') {
      // GAME_RULES_LOCKED.md §10 — Market items "expire after the immediately
      // following round". The round that just finished is the one now ending,
      // so anything bought before it (or earlier) is spent.
      //
      // Maco Mail held advantages are NOT touched: §7 keeps them until used or
      // the game ends, and Advantages.expireAfterRound skips them by source.
      expired = this.#shared.endRound(this.#roundIndex);
      this.#roundIndex += 1;
    }

    return ok({
      type: GAME_EVENTS.PHASE_CHANGED,
      payload: {
        phase: to,
        previousPhase: previous,
        roundIndex: this.#roundIndex,
        ...(expired === null
          ? {}
          : {
              expiredPurchaseIds: expired.purchases.map((p) => p.purchaseId),
              expiredAdvantageIds: expired.advantages.map((a) => a.advantageId),
            }),
      },
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
    // The same reasoning extends to Phase 6: the per-challenge card bar
    // (GAME_RULES_LOCKED.md §2) and the advantage budgets (§4, §10) are scoped
    // to a question. Carrying them into the next challenge would silently deny
    // a team its card or its one retry.
    this.#shared.endChallenge();

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
    // Per-challenge card and advantage budgets end with the challenge. Hands,
    // held advantages and Market purchases survive — they are game-long.
    this.#shared.endChallenge();

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
   * GAME_RULES_LOCKED.md §22 / D-011. The running timer freezes with its
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
    // Phase 7B — a Round 3 item window freezes with the game too, for the same
    // reason and by the same mechanism.
    this.#round3?.pauseItemWindow();
    this.#round1?.pauseWindows();
    // The Clash's 6-second window is a deadline like any other: a team must not
    // lose its chance to counter because someone's phone died. D-011.
    this.#shared.clash.pause();

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
    this.#round3?.resumeItemWindow();
    this.#round1?.resumeWindows();
    this.#shared.clash.resume();

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
  // Phase 6 — shared systems
  //
  // Each method here applies the ENGINE's preconditions (started, not paused,
  // a challenge where one is required) and then delegates the RULE to the
  // subsystem. The split matters: pause is an engine concern and a card's
  // eligibility is not, so neither has to know about the other.
  // -------------------------------------------------------------------------

  /**
   * Deal every team its starting Bacchanal hand. GAME_RULES_LOCKED.md §2.
   *
   * Separate from START_GAME deliberately. A Host may want to explain the cards
   * before dealing them, and a deal that happened automatically at game start
   * would be invisible in the event log's causal order.
   */
  dealBacchanalCards(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const teamIds = [...this.#teams.keys()].map((id) => asTeamId(id));
    const dealt = this.#shared.cards.deal(teamIds);
    if (!dealt.ok) return err(dealt.error);

    return ok({
      type: 'BACCHANAL_CARDS_DEALT',
      payload: {
        // COUNTS ONLY on the broadcast. The hands themselves reach each team
        // through its own snapshot, never through an event every client sees.
        teamCardCounts: Object.fromEntries(
          Object.entries(dealt.value).map(([teamId, cards]) => [teamId, cards.length]),
        ),
      },
    });
  }

  /**
   * DEVELOPMENT ONLY — discard every hand and deal again.
   *
   * Gated by the caller (room.ts) behind the same `devTools` flag as
   * DEV_ADJUST_BB, and refused outright when it is off — a production
   * deployment cannot accept this whatever a client sends. Exists beside
   * `dealBacchanalCards`, not inside it: the real deal still refuses a second
   * call, because a game deals starting hands exactly once. This is a distinct
   * escape hatch for exercising the Clash without recreating the whole room
   * until a random deal happens to give both teams a playable card.
   */
  devRedealBacchanalCards(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);
    if (!this.#options.devTools) {
      return err(rejection('ILLEGAL_ACTION', 'Development controls are disabled on this server.'));
    }

    const teamIds = [...this.#teams.keys()].map((id) => asTeamId(id));
    const dealt = this.#shared.cards.devRedeal(teamIds);
    if (!dealt.ok) return err(dealt.error);

    return ok({
      type: 'BACCHANAL_CARDS_DEALT',
      payload: {
        teamCardCounts: Object.fromEntries(
          Object.entries(dealt.value).map(([teamId, cards]) => [teamId, cards.length]),
        ),
      },
    });
  }

  /**
   * Open the card-play window for the current challenge.
   *
   * `challengeKind` maps the challenge onto a row of the locked compatibility
   * table. A challenge must be running: cards are played INTO something.
   */
  openCardWindow(challengeKind: string): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const challenge = this.#challenge;
    if (challenge === null || challenge.status === 'resolved') {
      return err(rejection('WRONG_STATE', 'There is no live challenge to play cards into.'));
    }

    if (!isCardChallengeKind(challengeKind)) {
      return err(
        rejection('INVALID_REQUEST', 'Unknown challenge kind for card eligibility.', {
          challengeKind,
        }),
      );
    }

    const opened = this.#shared.openCardWindow(challenge.challengeId, challengeKind);
    if (!opened.ok) return err(opened.error);

    return ok({
      type: 'CARD_WINDOW_OPENED',
      payload: {
        challengeId: challenge.challengeId,
        challengeKind,
        window: this.#shared.cards.windowView(),
      },
    });
  }

  closeCardWindow(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    return ok({
      type: 'CARD_WINDOW_CLOSED',
      payload: { window: this.#shared.cards.closeWindow() },
    });
  }

  /**
   * A team plays a Bacchanal card, opening a Clash.
   *
   * THE ONE PLAYER-DRIVEN GAMEPLAY INTENT SO FAR. Authority is checked by the
   * room (the connection must belong to this team); legality is checked by the
   * card system; the pause guard is here.
   */
  playBacchanalCard(input: {
    readonly teamId: TeamId;
    readonly cardInstanceId: string;
    readonly targetTeamId?: TeamId | null;
  }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const challenge = this.#challenge;
    if (challenge === null || challenge.status === 'resolved') {
      return err(rejection('WRONG_STATE', 'There is no live challenge.'));
    }
    if (!this.#teams.has(input.teamId)) {
      return err(rejection('NOT_FOUND', 'Unknown team.', { teamId: input.teamId }));
    }

    const played = this.#shared.playCard({
      teamId: input.teamId,
      cardInstanceId: input.cardInstanceId,
      targetTeamId: input.targetTeamId ?? null,
      challengeId: challenge.challengeId,
      paused: this.paused,
      allTeamIds: [...this.#teams.keys()].map((id) => asTeamId(id)),
    });
    if (!played.ok) return err(played.error);

    return ok({
      type: 'BACCHANAL_CARD_PLAYED',
      payload: {
        teamId: input.teamId,
        // The played card IS public — §5 has opponents choosing a counter to it,
        // which requires knowing what it is.
        cardType: played.value.cardType,
        challengeId: challenge.challengeId,
        clash: this.#shared.clash.view(),
      },
    });
  }

  /** A team secretly counters during the 6-second window. */
  respondToClash(input: {
    readonly teamId: TeamId;
    readonly cardInstanceId: string;
    readonly targetTeamId?: TeamId | null;
  }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const responded = this.#shared.respondToClash({
      teamId: input.teamId,
      cardInstanceId: input.cardInstanceId,
      targetTeamId: input.targetTeamId ?? null,
      paused: this.paused,
    });
    if (!responded.ok) return err(responded.error);

    return ok({
      type: 'CLASH_RESPONSE_RECEIVED',
      payload: {
        // WHO responded, never WITH WHAT. Phase 6 spec §42.
        teamId: input.teamId,
        respondedTeamIds: responded.value.respondedTeamIds,
        clash: this.#shared.clash.view(),
      },
    });
  }

  /**
   * Close the Clash window and reveal.
   *
   * Polled like timer expiry rather than scheduled, for the same reason: this
   * package owns no wall clock. Returns null when no Clash is due to resolve.
   */
  pollClashResolution(): EngineChange | null {
    if (!this.#started || this.paused) return null;
    if (!this.#shared.clash.active) return null;
    if (!this.#shared.clash.windowExpired() && !this.#shared.clash.allResponded()) return null;

    const resolved = this.#shared.resolveClash();
    if (!resolved.ok) return null;

    const value = resolved.value;
    return {
      type: value.immunityTriggered
        ? 'BACCHANAL_IMMUNITY_TRIGGERED'
        : value.result.outcome === 'part_dat_fight'
          ? 'PART_DAT_FIGHT'
          : 'CLASH_RESOLVED',
      payload: {
        result: value.result,
        effect: value.effect,
        immunityTriggered: value.immunityTriggered,
        immunityTeamId: value.immunityTeamId,
      },
    };
  }

  /** Open the Market before Round 2, 3 or 4. GAME_RULES_LOCKED.md §10. */
  openMarket(round: number): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const teamIds = [...this.#teams.keys()].map((id) => asTeamId(id));
    const opened = this.#shared.market.open_(round, teamIds);
    if (!opened.ok) return err(opened.error);

    return ok({ type: 'MARKET_OPENED', payload: { market: opened.value } });
  }

  /** Close the Market. Purchases reveal. §10. */
  closeMarket(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const closed = this.#shared.market.close();
    if (!closed.ok) return err(closed.error);

    return ok({
      type: 'MARKET_CLOSED',
      payload: { market: closed.value.market, purchases: closed.value.purchases },
    });
  }

  /** A team buys one Market item. Spending goes through the ledger. */
  purchaseMarketItem(input: {
    readonly teamId: TeamId;
    readonly item: string;
  }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    if (!this.#teams.has(input.teamId)) {
      return err(rejection('NOT_FOUND', 'Unknown team.', { teamId: input.teamId }));
    }
    if (!isMarketItem(input.item)) {
      return err(rejection('NOT_FOUND', 'No such Market item.', { item: input.item }));
    }

    const bought = this.#shared.purchase({ teamId: input.teamId, item: input.item });
    if (!bought.ok) return err(bought.error);

    return ok({
      type: 'MARKET_PURCHASE_RECORDED',
      payload: {
        // WHO bought, never WHAT, while shopping is hidden. §10 / spec §42. The
        // item reaches the buyer in their own acknowledgement and everyone else
        // at MARKET_CLOSED.
        teamId: input.teamId,
        teams: this.teams(),
      },
    });
  }

  /**
   * A team removes its OWN unrevealed item from its cart.
   *
   * GAME_RULES_LOCKED.md §10's "purchases are final" describes checkout — the
   * Market closing — not every tap before it. Refused once the Market closes
   * (`SharedSystems.withdrawPurchase`), and refused here if the purchase does
   * not belong to the calling team: OWNERSHIP IS CHECKED BEFORE ANYTHING ELSE,
   * the same discipline every other Phase 6 player intent uses, so a team
   * cannot even learn whether a purchaseId exists by probing this.
   */
  withdrawMarketPurchase(input: {
    readonly teamId: TeamId;
    readonly purchaseId: string;
  }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    if (!this.#teams.has(input.teamId)) {
      return err(rejection('NOT_FOUND', 'Unknown team.', { teamId: input.teamId }));
    }

    const owns = this.#shared.market
      .purchasesFor(input.teamId)
      .some((p) => p.purchaseId === input.purchaseId);
    if (!owns) {
      return err(rejection('NOT_FOUND', 'No such purchase.', { purchaseId: input.purchaseId }));
    }

    const withdrawn = this.#shared.withdrawPurchase(input.purchaseId);
    if (!withdrawn.ok) return err(withdrawn.error);

    return ok({
      type: 'MARKET_PURCHASE_WITHDRAWN',
      payload: {
        // WHO withdrew, never WHAT — the same secrecy MARKET_PURCHASE_RECORDED
        // keeps. A team's own withdrawal reaches THEM in their own
        // acknowledgement; opponents learn nothing beyond "the balance moved
        // back", which the frozen-BB view already hides until the Market
        // closes (see #teamsForPlayer in room.ts).
        teamId: input.teamId,
        teams: this.teams(),
      },
    });
  }

  /** Draw one Maco Mail card for a team. */
  drawMacoMail(input: {
    readonly teamId: TeamId;
    readonly eligibleAnswererChallengeRemains?: boolean;
    readonly futureMarketRemains?: boolean;
  }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    if (!this.#teams.has(input.teamId)) {
      return err(rejection('NOT_FOUND', 'Unknown team.', { teamId: input.teamId }));
    }

    if (!this.#shared.macoMail.built) {
      const built = this.#shared.macoMail.build();
      if (!built.ok) return err(built.error);
    }

    const context = this.#shared.macoContext({
      teamIds: [...this.#teams.keys()].map((id) => asTeamId(id)),
      ...(input.eligibleAnswererChallengeRemains === undefined
        ? {}
        : { eligibleAnswererChallengeRemains: input.eligibleAnswererChallengeRemains }),
      ...(input.futureMarketRemains === undefined
        ? {}
        : { futureMarketRemains: input.futureMarketRemains }),
    });

    const drawn = this.#shared.macoMail.draw(input.teamId, context);
    if (!drawn.ok) return err(drawn.error);

    return ok({
      type: 'MACO_MAIL_DRAWN',
      payload: {
        // A draw is revealed once it happens — it has already taken effect.
        draw: drawn.value,
        deck: this.#shared.macoMail.deckView(),
        teams: this.teams(),
      },
    });
  }

  /** A team uses a held advantage. Stacking rules apply centrally. */
  useAdvantage(input: {
    readonly teamId: TeamId;
    readonly advantageId: string;
  }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const used = this.#shared.advantages.use(input);
    if (!used.ok) return err(used.error);

    // +15 Seconds and Extra Time act on the SERVER's timer, never on a client
    // countdown. Phase 6 spec §27.
    if (used.value.type === 'EXTRA_TIME') {
      this.#timer.extend(PLUS_15_SECONDS_MS);
    }

    return ok({
      type: 'ADVANTAGE_USED',
      payload: {
        advantage: used.value,
        usage: this.#shared.advantages.usageFor(input.teamId),
        timer: this.#timer.view(),
      },
    });
  }

  /** Host offers one of the four locked deal templates. D-009. */
  offerHostDeal(input: {
    readonly template: string;
    readonly teamId: TeamId;
    readonly opponentTeamId?: TeamId | null;
  }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    if (!isHostDealTemplate(input.template)) {
      return err(rejection('NOT_FOUND', 'No such Host Deal template.', { template: input.template }));
    }

    const offered = this.#shared.deals.offer({
      template: input.template,
      teamId: input.teamId,
      opponentTeamId: input.opponentTeamId ?? null,
      roundIndex: this.#roundIndex,
      knownTeamIds: [...this.#teams.keys()].map((id) => asTeamId(id)),
    });
    if (!offered.ok) return err(offered.error);

    return ok({ type: 'HOST_DEAL_OFFERED', payload: { deal: offered.value } });
  }

  /** The team accepts or declines. Every amount comes from the template. */
  respondToHostDeal(input: {
    readonly dealId: string;
    readonly teamId: TeamId;
    readonly choice: string;
  }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    if (input.choice !== 'accept' && input.choice !== 'decline') {
      return err(rejection('INVALID_REQUEST', 'A deal is accepted or declined.'));
    }

    const answered = this.#shared.deals.respond({
      dealId: input.dealId,
      teamId: input.teamId,
      choice: input.choice,
    });
    if (!answered.ok) return err(answered.error);

    return ok({
      type: 'HOST_DEAL_RESOLVED',
      payload: {
        deal: answered.value.deal,
        grantsMacoDraw: answered.value.grantsMacoDraw,
        teams: this.teams(),
      },
    });
  }

  /** A team locks a wager, up to 50% of current BB. §17. */
  proposeWager(input: {
    readonly teamId: TeamId;
    readonly amount: number;
    readonly contextRef?: string | null;
  }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    if (!this.#teams.has(input.teamId)) {
      return err(rejection('NOT_FOUND', 'Unknown team.', { teamId: input.teamId }));
    }

    const locked = this.#shared.deals.proposeWager({
      teamId: input.teamId,
      amount: input.amount,
      contextRef: input.contextRef ?? null,
    });
    if (!locked.ok) return err(locked.error);

    return ok({ type: 'WAGER_LOCKED', payload: { wager: locked.value } });
  }

  /** Host resolves a locked wager. Exactly once. */
  resolveWager(input: { readonly wagerId: string; readonly won: boolean }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const resolved = this.#shared.deals.resolveWager(input);
    if (!resolved.ok) return err(resolved.error);

    return ok({
      type: 'WAGER_RESOLVED',
      payload: { wager: resolved.value, teams: this.teams() },
    });
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
   * GAME_RULES_LOCKED.md §22 — when the game pauses, gameplay stops. The
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

  // -------------------------------------------------------------------------
  // Round 2 — "Shake Up Yuhself!". Phase 7A.
  //
  // THE FIRST REAL ROUND, and it is deliberately thin. GAME_RULES_LOCKED.md §12
  // and D-003 put the physical games outside the app entirely, so the engine's
  // whole job is: walk the four locked challenges in order, take the Host's
  // winner, and pay the configured BB through the ledger.
  //
  // Everything else is BORROWED, not rebuilt. The challenge container, the
  // phases, the pause guard and the ledger are Phase 5's; card eligibility, the
  // Clash and the multiplier are Phase 6's. Phase 7A spec §2 forbids a second
  // round-state system and §6 and §7 forbid Round 2 copies of the card and
  // multiplier rules, so `Round2` holds progress and nothing else.
  // -------------------------------------------------------------------------

  /** Round 2 progression, or null until the round is entered. */
  get round2(): Round2 | null {
    return this.#round2;
  }

  round2View(): Round2StateView | null {
    return this.#round2 === null ? null : this.#round2.view();
  }

  /**
   * Enter Round 2.
   *
   * ALL TEAMS TAKE PART — Phase 7A §16 and §17. The engine hands `Round2` the
   * teams exactly as the game has them; nothing is seeded, ranked or eliminated,
   * because no locked rule for Round 2 says any of those things happen.
   *
   * Requires the engine to actually be on Round 2. `roundIndex` is the generic
   * counter Phase 5 already keeps, so entering Round 2 means the game arrived
   * here through the real phases rather than jumping.
   */
  beginRound2(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    if (this.#roundIndex !== ROUND2_ROUND_INDEX) {
      return err(
        rejection('WRONG_STATE', 'The game is not on Round 2.', {
          roundIndex: this.#roundIndex,
          expected: ROUND2_ROUND_INDEX,
        }),
      );
    }
    if (this.#round2 !== null) {
      return err(rejection('WRONG_STATE', 'Round 2 has already started.'));
    }

    const round = new Round2({ clock: this.#clock });
    const began = round.begin([...this.#teams.keys()].map((id) => asTeamId(id)));
    if (!began.ok) return err(began.error);

    this.#round2 = round;

    return ok({
      type: ROUND2_EVENTS.ROUND2_STARTED,
      payload: {
        roundIndex: ROUND2_ROUND_INDEX,
        // The four challenges and their order travel to clients, so neither
        // Unity nor a phone holds its own list. Phase 7A spec §3.
        challenges: ROUND2_CHALLENGES,
        round2: round.view(),
      },
    });
  }

  /**
   * Prepare the next Round 2 physical challenge, in the locked order.
   *
   * Composes the round's cursor with the GENERIC `prepareChallenge` rather than
   * making its own container: the challenge that results is an ordinary engine
   * challenge whose `challengeType` happens to be `BOTTLE_BATTLE`. Everything
   * Phase 5 already guarantees — one challenge at a time, a clean slate, no
   * inherited turn or active player — therefore applies unchanged.
   *
   * THE HOST CANNOT CHOOSE WHICH. There is no parameter: `Round2` hands out the
   * first unresolved challenge, so the order cannot be skipped or repeated.
   */
  prepareRound2Challenge(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round2;
    if (round === null) {
      return err(rejection('WRONG_STATE', 'Round 2 has not started.'));
    }

    // Asked BEFORE the generic prepare, so a round that is complete (or already
    // running a challenge) is refused without creating an engine challenge that
    // would then have to be unwound.
    const next = round.nextToPrepare();
    if (!next.ok) return err(next.error);

    const prepared = this.prepareChallenge({ challengeType: next.value.challengeType });
    if (!prepared.ok) return err(prepared.error);

    const challenge = this.#challenge;
    /* c8 ignore next 3 -- unreachable: prepareChallenge has just succeeded, so
       it has assigned #challenge. */
    if (challenge === null) {
      return err(rejection('WRONG_STATE', 'The challenge was not created.'));
    }

    const marked = round.markPrepared(challenge.challengeId);
    if (!marked.ok) return err(marked.error);

    return ok({
      type: ROUND2_EVENTS.ROUND2_CHALLENGE_PREPARED,
      payload: {
        challengeId: challenge.challengeId,
        challengeType: marked.value.challengeType,
        displayName: marked.value.displayName,
        order: marked.value.order,
        baseRewardBb: marked.value.baseRewardBb,
        cardChallengeKind: marked.value.cardChallengeKind,
        challenge: this.challengeView(),
        round2: round.view(),
      },
    });
  }

  /**
   * The Host selects a winning team — step one of two. MOVES NO BB.
   *
   * Phase 7A §19 asks for a confirmation step clear enough to stop an accidental
   * award, and §14 makes a confirmed result final. Splitting selection from
   * payment is what gives the Host somewhere safe to be wrong: the selection is
   * shown on the TV, and only the second intent pays.
   */
  selectRound2Winner(teamId: TeamId): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round2;
    if (round === null) {
      return err(rejection('WRONG_STATE', 'Round 2 has not started.'));
    }
    // The team must exist in THIS GAME before the round is asked whether it is
    // participating — §13, "do not trust a raw team ID without validation".
    if (!this.#teams.has(teamId)) {
      return err(rejection('NOT_FOUND', 'Unknown team.', { teamId }));
    }

    const selected = round.selectWinner(teamId);
    if (!selected.ok) return err(selected.error);

    return ok({
      type: ROUND2_EVENTS.ROUND2_WINNER_SELECTED,
      payload: {
        // NO AMOUNT. This event pays nothing, and carries nothing that looks
        // like it might.
        teamId,
        challengeType: selected.value.challengeType,
        challengeId: selected.value.challengeId,
        round2: round.view(),
      },
    });
  }

  /**
   * The Host confirms the result — step two. THIS PAYS.
   *
   * Where the three authorities meet, and the order matters:
   *
   *   1. the HOST decided who won (subjective — CLAUDE.md, D-003),
   *   2. ROUND 2 supplies the base reward from configuration (§12: 500 BB),
   *   3. the SHARED SYSTEMS decide whether it doubles (§3, §6 — Double It only,
   *      played legally, before the result),
   *   4. the LEDGER moves the BB and applies the floor.
   *
   * No client supplies a number at any point. A Host client naming an amount
   * would be precisely the "client decides how much BB to add" CLAUDE.md
   * forbids, so no handler reads one.
   */
  confirmRound2Result(input: {
    readonly winningTeamId?: TeamId | null;
  } = {}): Result<{ readonly change: EngineChange; readonly ledgerEntries: readonly BbLedgerEntry[] }> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round2;
    if (round === null) {
      return err(rejection('WRONG_STATE', 'Round 2 has not started.'));
    }

    if (input.winningTeamId !== undefined && input.winningTeamId !== null) {
      if (!this.#teams.has(input.winningTeamId)) {
        return err(rejection('NOT_FOUND', 'Unknown team.', { teamId: input.winningTeamId }));
      }
    }

    // Full validation before anything moves — a refused confirmation must not
    // leave a paid team and an unresolved round.
    const pending = round.prepareConfirmation({ winningTeamId: input.winningTeamId ?? null });
    if (!pending.ok) return err(pending.error);

    const { definition, winningTeamId, baseRewardBb } = pending.value;

    // §7 / §8 — the multiplier is READ FROM THE SHARED SYSTEM, never computed
    // here. `applyMultiplier` returns base×2 only when that team has a DOUBLE
    // in force, which a Double It played into this challenge's card window put
    // there. Asking now, at confirmation, is what makes the locked timing rule
    // ("activate before result") true: a card played after this point has
    // nothing left to double.
    const doubled = this.#shared.isDoubledFor(winningTeamId);
    const award = this.#shared.applyMultiplier(winningTeamId, baseRewardBb);

    // The generic resolution does the rest: it moves BB through the ledger with
    // reason `challenge_result`, records the winner, clears the per-challenge
    // state and advances to RESULT. Phase 7A spec §15 and §2 — Round 2 does not
    // get its own award path or its own phase handling.
    const resolved = this.resolveChallenge({
      winningTeamIds: [winningTeamId],
      bbDeltas: { [winningTeamId]: award },
      decidedByHost: true,
      completion: 'completed',
      note: `${definition.displayName}${doubled ? ' (Double It)' : ''}`,
    });
    if (!resolved.ok) return err(resolved.error);

    // What the LEDGER applied, not what was intended. The two can differ at the
    // floor, and the round's record must not disagree with the ledger.
    const applied = resolved.value.change.payload['result'] as GameChallengeResult;
    const awarded = applied.bbApplied[winningTeamId] ?? 0;

    const view = round.recordResult({ winningTeamId, awardedBb: awarded, doubled });
    const complete = round.complete;

    return ok({
      change: {
        type: ROUND2_EVENTS.ROUND2_CHALLENGE_RESOLVED,
        payload: {
          challengeId: pending.value.challengeId,
          challengeType: definition.challengeType,
          displayName: definition.displayName,
          winningTeamId,
          baseRewardBb,
          /** What actually moved, after the multiplier and the floor. */
          awardedBb: awarded,
          doubled,
          challengeResult: applied,
          teams: this.teams(),
          round2: round.view(),
          // §18 — the round is complete after the fourth. The engine says so
          // and STOPS; moving on to Round 3 is not Phase 7A's.
          roundComplete: complete,
          resolvedChallenge: view,
        },
      },
      ledgerEntries: resolved.value.ledgerEntries,
    });
  }


  // -------------------------------------------------------------------------
  // Round 1. Phase 7C.
  //
  // GAME_RULES_LOCKED.md §11, D-030 and D-032.
  //
  // TWO TOTALS, ONE CORRECT ANSWER. BB moves through the ledger exactly like
  // every other award; Round 1 POINTS live in the `Round1` object and never
  // touch the ledger. Round 1 is won on points, the game is won on BB, and the
  // two can genuinely differ because BB also moves in the Market.
  //
  // Round 1 is also the FIRST round that marks players software-active (D-021):
  // the nominated answerer is the only person who can submit, so their phone
  // dropping really does stop that team.
  // -------------------------------------------------------------------------

  get round1(): Round1 | null {
    return this.#round1;
  }

  round1View(
    forTeam: TeamId | null = null,
    forPlayer: PlayerId | null = null,
    hostView = false,
  ): Round1StateView | null {
    return this.#round1 === null ? null : this.#round1.view(forTeam, forPlayer, hostView);
  }

  /**
   * Enter Round 1 with a question set the CALLER has already validated.
   *
   * The engine never reaches for content — the room owns the content source,
   * exactly as it does for Round 3 (§13).
   */
  beginRound1(questions: readonly Round1ContentItem[]): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    if (this.#roundIndex !== ROUND1_ROUND_INDEX) {
      return err(
        rejection('WRONG_STATE', 'The game is not on Round 1.', {
          roundIndex: this.#roundIndex,
          expected: ROUND1_ROUND_INDEX,
        }),
      );
    }
    if (this.#round1 !== null) {
      return err(rejection('WRONG_STATE', 'Round 1 has already started.'));
    }

    const round = new Round1({ clock: this.#clock });
    const began = round.begin({
      teamIds: [...this.#teams.keys()].map((id) => asTeamId(id)),
      questions,
    });
    if (!began.ok) return err(began.error);

    this.#round1 = round;

    return ok({
      type: ROUND1_EVENTS.ROUND1_STARTED,
      payload: {
        roundIndex: ROUND1_ROUND_INDEX,
        // ⚠ The VIEW, never the question set. The items carry canonical answers
        // and the view has no field for one.
        round1: round.view(),
      },
    });
  }

  /** Nominate one team's answerer for one difficulty. §11. */
  nominateRound1Answerer(input: {
    readonly teamId: TeamId;
    readonly difficulty: Round1Difficulty;
    readonly playerId: PlayerId;
  }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round1;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 1 has not started.'));

    if (!this.#teamHasMember(input.teamId, input.playerId)) {
      return err(
        rejection('ILLEGAL_ACTION', 'A nominee must be on that team.', {
          teamId: input.teamId,
          playerId: input.playerId,
        }),
      );
    }

    const nominated = round.nominate(input);
    if (!nominated.ok) return err(nominated.error);

    return ok({
      type: ROUND1_EVENTS.ROUND1_NOMINEE_SET,
      payload: {
        teamId: input.teamId,
        difficulty: input.difficulty,
        playerId: input.playerId,
        nominee: nominated.value,
        nominationsComplete: round.nominationsComplete(),
        round1: round.view(),
      },
    });
  }

  /** Close nominations. Refused while any team is short a nominee (§11). */
  startRound1Questions(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round1;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 1 has not started.'));

    const started = round.startQuestions();
    if (!started.ok) return err(started.error);

    return ok({
      type: ROUND1_EVENTS.ROUND1_STARTED,
      payload: { phase: round.phase, round1: round.view() },
    });
  }

  /**
   * Reveal the next question, start its 60-second window, and mark the
   * nominated answerers active.
   *
   * The active-player set is refreshed HERE because it changes with the
   * question: a Medium question needs each team's Medium nominee awake, and
   * nobody else. D-021.
   */
  revealRound1Question(challengeId: ChallengeId): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round1;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 1 has not started.'));

    const revealed = round.revealNextQuestion(challengeId);
    if (!revealed.ok) return err(revealed.error);

    this.#syncRound1ActivePlayers();

    return ok({
      type: ROUND1_EVENTS.ROUND1_QUESTION_REVEALED,
      payload: {
        challengeId,
        question: revealed.value,
        activePlayerIds: this.activePlayerIds(),
        round1: round.view(),
      },
    });
  }

  /**
   * Keep the active-player set matching what the round currently requires.
   *
   * Called whenever the answering state changes. A team that has submitted no
   * longer needs its nominee awake, so the set SHRINKS as answers arrive —
   * which is the behaviour that keeps a party from pausing constantly.
   */
  #syncRound1ActivePlayers(): void {
    const round = this.#round1;
    if (round === null) return;
    // Only players still on a participating team can be marked active.
    const wanted = round.activePlayerIds().filter((id) => this.#anyTeamHasMember(id));
    this.#activePlayers.clear();
    for (const playerId of wanted) this.#activePlayers.add(playerId);
  }

  /** The nominated player submits their team's answer. Final (§11). */
  submitRound1Answer(input: {
    readonly teamId: TeamId;
    readonly playerId: PlayerId;
    readonly answer: string;
  }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round1;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 1 has not started.'));

    const submitted = round.submitAnswer(input);
    if (!submitted.ok) return err(submitted.error);

    this.#syncRound1ActivePlayers();

    return ok({
      type: ROUND1_EVENTS.ROUND1_ANSWER_SUBMITTED,
      payload: {
        teamId: input.teamId,
        playerId: input.playerId,
        isRetry: submitted.value.isRetry,
        // ⚠ THE ANSWER TEXT IS NOT IN THIS PAYLOAD. An event reaches every
        // client, and a submitted answer belongs to its own team until the
        // reveal. Only the fact of submitting travels.
        activePlayerIds: this.activePlayerIds(),
        round1: round.view(),
      },
    });
  }

  /** Close the answer window and move to grading. */
  closeRound1Question(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round1;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 1 has not started.'));

    const closed = round.closeQuestion();
    if (!closed.ok) return err(closed.error);

    this.#syncRound1ActivePlayers();

    return ok({
      type: ROUND1_EVENTS.ROUND1_QUESTION_CLOSED,
      payload: {
        question: closed.value,
        activePlayerIds: this.activePlayerIds(),
        round1: round.view(),
      },
    });
  }

  /** Store one graded ruling. §4E — stored once, reused forever after. */
  recordRound1Ruling(input: {
    readonly teamId: TeamId;
    readonly verdict: Round1Verdict;
    readonly source: Round1GradeSource;
    readonly isRetry: boolean;
  }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round1;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 1 has not started.'));

    const recorded = round.recordRuling(input);
    if (!recorded.ok) return err(recorded.error);

    return ok({
      type: ROUND1_EVENTS.ROUND1_ANSWER_GRADED,
      payload: {
        teamId: input.teamId,
        verdict: input.verdict,
        source: input.source,
        isRetry: input.isRetry,
        needsHostReview: round.needsHostReview(),
        gradingComplete: round.gradingComplete(),
        round1: round.view(),
      },
    });
  }

  /** Open a 10-second FORGIVE MEH! retry for one team. §11, D-032. */
  openRound1Retry(teamId: TeamId): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round1;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 1 has not started.'));

    const opened = round.openRetry(teamId);
    if (!opened.ok) return err(opened.error);

    this.#syncRound1ActivePlayers();

    return ok({
      type: ROUND1_EVENTS.ROUND1_RETRY_OPENED,
      payload: {
        teamId,
        question: opened.value,
        activePlayerIds: this.activePlayerIds(),
        round1: round.view(),
      },
    });
  }

  /** Grant a Maco! viewing to one nominated player, for ten seconds. §11. */
  grantRound1Maco(input: {
    readonly viewingTeamId: TeamId;
    readonly viewingPlayerId: PlayerId;
    readonly targetTeamId: TeamId;
  }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round1;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 1 has not started.'));

    // ============ THE CARD MUST ACTUALLY HAVE RESOLVED ============
    // `Round1.grantMaco` checks the ROUND's rules — the right nominee, a target
    // that has already submitted. It knows nothing about cards, and must not:
    // card ownership, legality and the Clash all belong to SharedSystems (§5).
    //
    // Without this gate any nominee could read an opponent's answer for free,
    // because nothing else connects the played card to its effect. An effect
    // appears here only once it has SURVIVED its Clash, which is what lets an
    // opponent's counter stop a Maco before it reveals anything.
    const resolved = this.#shared
      .activeEffects()
      .some(
        (effect) =>
          effect.cardType === 'MACO' &&
          effect.owningTeamId === input.viewingTeamId &&
          effect.active,
      );
    if (!resolved) {
      return err(
        rejection('ILLEGAL_ACTION', 'Your team has no Maco! in play.', {
          teamId: input.viewingTeamId,
        }),
      );
    }

    const granted = round.grantMaco(input);
    if (!granted.ok) return err(granted.error);

    return ok({
      type: ROUND1_EVENTS.ROUND1_MACO_VIEWED,
      payload: {
        viewingTeamId: input.viewingTeamId,
        targetTeamId: input.targetTeamId,
        // ⚠ NOT THE ANSWER. The viewing player receives the text in their own
        // scoped snapshot; this event says only that a Maco! happened, because
        // it reaches every client including the target.
        expiresAt: granted.value.expiresAt,
        round1: round.view(),
      },
    });
  }

  /** Record an ALLYUH HELP ME! assist for this question. §11. */
  recordRound1Assist(input: {
    readonly requestingTeamId: TeamId;
    readonly assistingTeamId: TeamId;
  }): Result<true> {
    const round = this.#round1;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 1 has not started.'));
    return round.recordAssist(input);
  }

  /**
   * Score and reveal the current question. §11, spec §5.
   *
   * ================== WHERE DOUBLE IT! APPLIES ==================
   * §11 — a correct answer with Double It! doubles BOTH the BB and the Round 1
   * question score (20→40, 30→60, 50→100). So the multiplier is read once from
   * the shared systems and applied to both totals, which is the only way they
   * can be guaranteed to agree.
   *
   * An ALLYUH HELP ME! beneficiary gets the NORMAL BASE value even when the
   * assisting team doubled — spec §9 is explicit. That is enforced by computing
   * the assist from `baseValue` and never consulting the assisting team's
   * multiplier.
   * ==============================================================
   */
  revealRound1Answer(): Result<{
    readonly change: EngineChange;
    readonly ledgerEntries: readonly BbLedgerEntry[];
  }> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round1;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 1 has not started.'));

    if (!round.gradingComplete()) {
      return err(
        rejection('WRONG_STATE', 'Every submitted answer needs a ruling first.', {
          pending: round.pendingGrading().length,
        }),
      );
    }
    const unresolved = round.needsHostReview();
    if (unresolved.length > 0) {
      return err(
        rejection('WRONG_STATE', 'The Host must rule on every uncertain answer first.', {
          teams: unresolved.join(', '),
        }),
      );
    }

    const proposed = round.proposedAwards();
    const bbDeltas: Record<string, number> = {};
    const awards: {
      teamId: TeamId;
      awardedBb: number;
      awardedPoints: number;
      doubled: boolean;
    }[] = [];

    for (const item of proposed) {
      if (!item.correct) {
        // §11 — a wrong answer scores 0, with NO BB deduction.
        awards.push({ teamId: item.teamId, awardedBb: 0, awardedPoints: 0, doubled: false });
        continue;
      }

      // An assist pays the base value, never the assisting team's doubled one.
      const doubled = item.viaAssist ? false : this.#shared.isDoubledFor(item.teamId);
      const value = doubled
        ? this.#shared.applyMultiplier(item.teamId, item.baseValue)
        : item.baseValue;

      bbDeltas[item.teamId] = value;
      awards.push({
        teamId: item.teamId,
        awardedBb: value,
        // THE SAME NUMBER, to a different total. Not a second BB transaction.
        awardedPoints: value,
        doubled: doubled && value > item.baseValue,
      });
    }

    const resolved = this.resolveChallenge({
      winningTeamIds: awards.filter((a) => a.awardedBb > 0).map((a) => a.teamId),
      bbDeltas,
      decidedByHost: true,
      completion: 'completed',
      note: 'Round 1 question',
    });
    if (!resolved.ok) return err(resolved.error);

    const applied = resolved.value.change.payload['result'] as GameChallengeResult;

    // Points follow what the LEDGER actually applied, so a floored or clamped
    // award can never leave the two totals disagreeing.
    const finalAwards = awards.map((award) => ({
      ...award,
      awardedBb: applied.bbApplied[award.teamId] ?? award.awardedBb,
    }));

    const view = round.applyAwards(finalAwards);
    if (!view.ok) return err(view.error);

    this.#syncRound1ActivePlayers();

    return ok({
      change: {
        type: ROUND1_EVENTS.ROUND1_ANSWER_REVEALED,
        payload: {
          question: view.value,
          awards: finalAwards,
          challengeResult: applied,
          teams: this.teams(),
          standings: round.standings(),
          questionsComplete: round.questionsComplete,
          round1: round.view(),
        },
      },
      ledgerEntries: resolved.value.ledgerEntries,
    });
  }

  /**
   * Decide the Round 1 winner after all 15 questions. §11, D-032.
   *
   * ⚠ ON ROUND 1 POINTS, NOT BB (spec §11). Tied leaders enter the sudden-death
   * trivia tiebreak, which this starts rather than deciding for them.
   */
  decideRound1Winner(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round1;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 1 has not started.'));

    const decided = round.decideWinner();
    if (!decided.ok) return err(decided.error);

    if (decided.value.needsTiebreak) {
      return ok({
        type: ROUND1_EVENTS.ROUND1_TIEBREAK_STARTED,
        payload: {
          tiedTeamIds: decided.value.leaders,
          // ⚠ NOT §21's end-of-game Sudden Death. A separate mechanism with a
          // separate event, deliberately (spec §12).
          round1: round.view(),
        },
      });
    }

    return ok({
      type: ROUND1_EVENTS.ROUND1_WINNER_CONFIRMED,
      payload: {
        winningTeamId: decided.value.winningTeamId,
        standings: round.standings(),
        // NO BB is awarded for winning Round 1. No locked rule grants any.
        round1: round.view(),
      },
    });
  }

  /** Start one sudden-death tiebreak question. D-032. */
  startRound1TiebreakAttempt(item: Round1ContentItem): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round1;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 1 has not started.'));

    const started = round.startTiebreakAttempt(item);
    if (!started.ok) return err(started.error);

    this.#syncRound1ActivePlayers();

    return ok({
      type: ROUND1_EVENTS.ROUND1_TIEBREAK_STARTED,
      payload: {
        attempt: started.value,
        activePlayerIds: this.activePlayerIds(),
        round1: round.view(),
      },
    });
  }

  /** A tied team's nominee submits a tiebreak answer. */
  submitRound1TiebreakAnswer(input: {
    readonly teamId: TeamId;
    readonly playerId: PlayerId;
    readonly answer: string;
  }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round1;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 1 has not started.'));

    const submitted = round.submitTiebreakAnswer(input);
    if (!submitted.ok) return err(submitted.error);

    this.#syncRound1ActivePlayers();

    return ok({
      type: ROUND1_EVENTS.ROUND1_ANSWER_SUBMITTED,
      payload: {
        teamId: input.teamId,
        tiebreak: true,
        activePlayerIds: this.activePlayerIds(),
        round1: round.view(),
      },
    });
  }

  /**
   * Resolve one tiebreak attempt. D-032, spec §12.
   *
   * ⚠ MOVES NO BB AND NO ROUND 1 POINTS. It only eliminates teams. That is
   * enforced by this method never calling the ledger and never calling
   * `applyAwards` — there is simply no path from here to either total.
   */
  resolveRound1Tiebreak(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round1;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 1 has not started.'));

    const resolved = round.resolveTiebreakAttempt();
    if (!resolved.ok) return err(resolved.error);

    this.#syncRound1ActivePlayers();

    return ok({
      type:
        resolved.value.outcome === 'winner'
          ? ROUND1_EVENTS.ROUND1_WINNER_CONFIRMED
          : ROUND1_EVENTS.ROUND1_TIEBREAK_RESOLVED,
      payload: {
        attempt: resolved.value,
        winningTeamId: round.winningTeamId,
        standings: round.standings(),
        round1: round.view(),
      },
    });
  }

  /**
   * Whether the open Round 1 question's 60 seconds have run out.
   *
   * Polled, never scheduled — `@bb/game-rules` owns no wall clock, exactly as
   * the challenge timer, the Clash window and Round 3's item windows are polled.
   */
  round1QuestionWindowExpired(): boolean {
    return this.#round1?.questionWindowExpired() ?? false;
  }

  /** Whether a running FORGIVE MEH! retry window has run out. */
  round1RetryWindowExpired(): boolean {
    return this.#round1?.retryWindowExpired() ?? false;
  }

  /** The value of a difficulty. §11 — one number, two totals. */
  round1ValueOf(difficulty: Round1Difficulty): number {
    return ROUND1_VALUES[difficulty];
  }

  // -------------------------------------------------------------------------
  // Round 3. Phase 7B.
  //
  // GAME_RULES_LOCKED.md §13-§18, D-031.
  //
  // Structurally the same bet as Round 2 — the round is a cursor, the engine
  // keeps the phase, the ledger and the shared systems — but Round 3 genuinely
  // owns more: challenge points, a challenge-win counter, content items, Think
  // Fast's turn order and the rock-paper-scissors tiebreaker.
  //
  // THREE COUNTERS, NEVER COLLAPSED (§13): challenge points decide ONE
  // challenge; the challenge-win counter decides the ROUND; BB is the game's
  // score, and only Think Fast and Sing a Song pay any.
  // -------------------------------------------------------------------------

  get round3(): Round3 | null {
    return this.#round3;
  }

  round3View(forTeam: TeamId | null = null): Round3StateView | null {
    return this.#round3 === null ? null : this.#round3.view(forTeam);
  }

  /**
   * The previous round's standings, best first.
   *
   * GAME_RULES_LOCKED.md §1 / D-031 — winning a round means holding the most
   * total BB when it ends. Round 2 records per-challenge winners but no
   * placement, so rather than invent one the owner chose the measure the game
   * already has.
   *
   * Ties break by the order the game was started with, so the result is
   * deterministic rather than dependent on Map iteration order.
   */
  standingsByBb(): readonly TeamId[] {
    const order = [...this.#teams.keys()];
    return order
      .map((id) => asTeamId(id))
      .sort((a, b) => {
        const diff = this.balanceOf(b) - this.balanceOf(a);
        if (diff !== 0) return diff;
        return order.indexOf(a) - order.indexOf(b);
      });
  }

  /** Enter Round 3, carrying the previous round's standings in. */
  beginRound3(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    if (this.#roundIndex !== ROUND3_ROUND_INDEX) {
      return err(
        rejection('WRONG_STATE', 'The game is not on Round 3.', {
          roundIndex: this.#roundIndex,
          expected: ROUND3_ROUND_INDEX,
        }),
      );
    }
    if (this.#round3 !== null) {
      return err(rejection('WRONG_STATE', 'Round 3 has already started.'));
    }

    const round = new Round3({ clock: this.#clock, mintId: this.#options.mintId });
    const previousRoundOrder = this.standingsByBb();
    const began = round.begin({
      teamIds: [...this.#teams.keys()].map((id) => asTeamId(id)),
      previousRoundOrder,
    });
    if (!began.ok) return err(began.error);

    this.#round3 = round;

    return ok({
      type: ROUND3_EVENTS.ROUND3_STARTED,
      payload: {
        roundIndex: ROUND3_ROUND_INDEX,
        challenges: ROUND3_CHALLENGES,
        previousRoundOrder,
        round3: round.view(),
      },
    });
  }

  /** Prepare the next Round 3 challenge, in the locked order. */
  prepareRound3Challenge(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round3;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 3 has not started.'));

    const next = round.nextToPrepare();
    if (!next.ok) return err(next.error);

    const prepared = this.prepareChallenge({ challengeType: next.value.challengeType });
    if (!prepared.ok) return err(prepared.error);

    const challenge = this.#challenge;
    /* c8 ignore next 3 -- unreachable: prepareChallenge just succeeded. */
    if (challenge === null) {
      return err(rejection('WRONG_STATE', 'The challenge was not created.'));
    }

    const marked = round.markPrepared(challenge.challengeId);
    if (!marked.ok) return err(marked.error);

    return ok({
      type: ROUND3_EVENTS.ROUND3_CHALLENGE_PREPARED,
      payload: {
        challengeId: challenge.challengeId,
        challengeType: marked.value.challengeType,
        displayName: marked.value.displayName,
        order: marked.value.order,
        format: marked.value.format,
        targetScore: marked.value.targetScore,
        cardChallengeKind: marked.value.cardChallengeKind,
        challenge: this.challengeView(),
        round3: round.view(),
      },
    });
  }

  /**
   * Whether the current Round 3 item's window has run out.
   *
   * §15-§17 — "if nobody answers correctly, move to the next item." The room
   * polls this and reveals the replacement, because only the room holds the
   * content source.
   */
  round3ItemWindowExpired(): boolean {
    if (!this.#started || this.paused) return false;
    return this.#round3?.itemWindowExpired() ?? false;
  }

  /** Stop an expired window that has no replacement item. */
  clearRound3ExpiredItem(): void {
    this.#round3?.clearExpiredItem();
  }

  /**
   * Whether the running Round 3 challenge still needs its opening item.
   *
   * True for a `single` challenge (Think Fast) that has not revealed its topic
   * yet. The room uses this to reveal it automatically when the challenge
   * starts, because §14 has no "next item" for the Host to press.
   */
  round3NeedsOpeningItem(): boolean {
    const current = this.#round3?.view().current;
    if (current === undefined || current === null) return false;
    return current.itemMode === 'single' && current.currentItem === null;
  }

  /**
   * Reveal the next content item.
   *
   * THE ITEM COMES FROM THE CALLER — §13, the game supplies challenge content.
   * The engine neither stores a pack nor chooses an item; it records which one
   * is on screen and starts its window.
   */
  revealRound3Item(item: Round3ContentItem): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round3;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 3 has not started.'));

    const revealed = round.revealItem(item);
    if (!revealed.ok) return err(revealed.error);

    return ok({
      type: ROUND3_EVENTS.ROUND3_ITEM_REVEALED,
      payload: {
        // ONLY the current item. No queue, no total, no accepted answer.
        item: revealed.value,
        round3: round.view(),
      },
    });
  }

  /** Award one challenge point. Points, never BB. */
  awardRound3Point(teamId: TeamId): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round3;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 3 has not started.'));
    if (!this.#teams.has(teamId)) {
      return err(rejection('NOT_FOUND', 'Unknown team.', { teamId }));
    }

    const awarded = round.awardPoint(teamId);
    if (!awarded.ok) return err(awarded.error);

    return ok({
      type: ROUND3_EVENTS.ROUND3_POINT_AWARDED,
      payload: {
        teamId,
        challenge: awarded.value,
        // No BB moved, and the event carries nothing that looks like it did.
        round3: round.view(),
      },
    });
  }

  /** Think Fast: the current team answered validly. §14. */
  thinkFastValid(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round3;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 3 has not started.'));

    const advanced = round.thinkFastValid();
    if (!advanced.ok) return err(advanced.error);

    return ok({
      type: ROUND3_EVENTS.THINK_FAST_TURN_CHANGED,
      payload: { thinkFast: advanced.value, round3: round.view() },
    });
  }

  /** Think Fast: the current team is out of this challenge. §14. */
  thinkFastEliminate(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round3;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 3 has not started.'));

    const before = round.view().current?.thinkFast?.currentTeamId ?? null;
    const eliminated = round.thinkFastEliminate();
    if (!eliminated.ok) return err(eliminated.error);

    return ok({
      type: ROUND3_EVENTS.THINK_FAST_TEAM_ELIMINATED,
      payload: {
        teamId: before,
        thinkFast: eliminated.value,
        round3: round.view(),
      },
    });
  }

  /**
   * Confirm the challenge winner: resolve it, pay any BB, and increment the
   * challenge-win counter exactly once.
   *
   * A SCORE NEVER RESOLVES A CHALLENGE — §15-§17 give the Host discretion to
   * confirm before or after the target, so this is always required.
   */
  confirmRound3Challenge(winningTeamId: TeamId): Result<{
    readonly change: EngineChange;
    readonly ledgerEntries: readonly BbLedgerEntry[];
  }> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round3;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 3 has not started.'));
    if (!this.#teams.has(winningTeamId)) {
      return err(rejection('NOT_FOUND', 'Unknown team.', { teamId: winningTeamId }));
    }

    const pending = round.prepareConfirmation(winningTeamId);
    if (!pending.ok) return err(pending.error);

    const { definition, baseRewardBb } = pending.value;

    // The multiplier is READ from the shared system, never computed here — and
    // for Guess the Logo and All Answers Begin With the base is 0, so doubling
    // nothing is still nothing. Double It is NOT given a counter meaning,
    // because no locked rule defines one (D-031).
    const doubled = this.#shared.isDoubledFor(winningTeamId);
    const award = this.#shared.applyMultiplier(winningTeamId, baseRewardBb);
    const reallyDoubled = doubled && award > 0;

    const resolved = this.resolveChallenge({
      winningTeamIds: [winningTeamId],
      // A zero award still goes through the ledger path, which writes a
      // zero-delta entry. One path means a BB-paying and a non-paying challenge
      // cannot drift apart.
      bbDeltas: { [winningTeamId]: award },
      decidedByHost: true,
      completion: 'completed',
      note: `${definition.displayName}${reallyDoubled ? ' (Double It)' : ''}`,
    });
    if (!resolved.ok) return err(resolved.error);

    const applied = resolved.value.change.payload['result'] as GameChallengeResult;
    const awarded = applied.bbApplied[winningTeamId] ?? 0;

    const view = round.recordChallengeResult({
      winningTeamId,
      awardedBb: awarded,
      doubled: reallyDoubled,
    });

    return ok({
      change: {
        type: ROUND3_EVENTS.ROUND3_CHALLENGE_RESOLVED,
        payload: {
          challengeId: pending.value.challengeId,
          challengeType: definition.challengeType,
          displayName: definition.displayName,
          winningTeamId,
          baseRewardBb,
          awardedBb: awarded,
          doubled: reallyDoubled,
          challengeResult: applied,
          teams: this.teams(),
          round3: round.view(),
          roundComplete: round.complete,
          resolvedChallenge: view,
        },
      },
      ledgerEntries: resolved.value.ledgerEntries,
    });
  }

  /**
   * Decide the Round 3 winner after the fourth challenge.
   *
   * One leader wins outright; tied leaders go to rock-paper-scissors (§18),
   * which this starts rather than resolving on their behalf.
   *
   * NO BB IS AWARDED for winning Round 3 — no locked rule grants any (D-031).
   */
  decideRound3Winner(): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round3;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 3 has not started.'));

    const decided = round.decideWinner();
    if (!decided.ok) return err(decided.error);

    if (decided.value.needsTiebreaker) {
      return ok({
        type: ROUND3_EVENTS.RPS_STARTED,
        payload: {
          tiedTeamIds: decided.value.leaders,
          tiebreaker: round.tiebreakerView(null),
          round3: round.view(),
        },
      });
    }

    return ok({
      type: ROUND3_EVENTS.ROUND3_WINNER_CONFIRMED,
      payload: {
        winningTeamId: decided.value.winningTeamId,
        challengeWins: round.view().challengeWins,
        round3: round.view(),
      },
    });
  }

  /** A tied team locks its rock-paper-scissors choice. §18. */
  submitRpsChoice(input: {
    readonly teamId: TeamId;
    readonly choice: string;
  }): Result<EngineChange> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    const round = this.#round3;
    if (round === null) return err(rejection('WRONG_STATE', 'Round 3 has not started.'));
    if (!isRpsChoice(input.choice)) {
      return err(
        rejection('INVALID_REQUEST', 'Choice must be ROCK, PAPER or SCISSORS.', {
          choice: input.choice,
        }),
      );
    }

    const submitted = round.submitRpsChoice(input.teamId, input.choice);
    if (!submitted.ok) return err(submitted.error);

    return ok({
      type: ROUND3_EVENTS.RPS_CHOICE_SUBMITTED,
      payload: {
        // WHO chose, never WHAT. §18.
        teamId: input.teamId,
        submittedTeamIds: submitted.value.submittedTeamIds,
        tiebreaker: round.tiebreakerView(null),
      },
    });
  }

  /**
   * Reveal a rock-paper-scissors attempt once every tied team has chosen.
   *
   * Polled like the Clash, for the same reason: this package owns no wall
   * clock. Returns null when nothing is due.
   */
  pollRpsResolution(): EngineChange | null {
    if (!this.#started || this.paused) return null;
    const round = this.#round3;
    if (round === null || !round.allRpsChoicesIn()) return null;

    const resolved = round.resolveRps();
    if (!resolved.ok) return null;

    return {
      type: ROUND3_EVENTS.RPS_REVEALED,
      payload: {
        attempt: resolved.value,
        tiebreaker: round.tiebreakerView(null),
        round3: round.view(),
        winningTeamId: round.winningTeamId,
      },
    };
  }

  /**
   * DEVELOPMENT ONLY — walk the engine from game start to the Round 2 intro.
   *
   * Round 1 does not exist (Phase 7A §4), so nothing can legitimately finish it
   * and hand over. Rather than invent a production rule that skips it — which
   * the spec forbids outright — this drives the REAL phase transitions and then
   * calls the SAME `beginRound2` that Round 1's completion will eventually call.
   *
   * What it does NOT do: invent a transition, assign a phase directly, seed BB,
   * or change what any round contains. Every step below is a legal transition
   * from `transitions.ts`, and the round counter advances the ordinary way. If
   * the state machine would refuse a step in a real game, it refuses here.
   *
   * Gated by the room on `devTools`, like `DEV_ADJUST_BB` (D-024). The engine
   * checks it too, so no future caller can reach it around that gate.
   */
  devEnterRound2(): Result<readonly EngineChange[]> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    if (!this.#options.devTools) {
      return err(
        rejection('ILLEGAL_ACTION', 'Development controls are disabled on this server.'),
      );
    }
    if (this.#round2 !== null) {
      return err(rejection('WRONG_STATE', 'Round 2 has already started.'));
    }

    if (this.#roundIndex > ROUND2_ROUND_INDEX) {
      return err(
        rejection('WRONG_STATE', 'The game is already past Round 2.', {
          roundIndex: this.#roundIndex,
        }),
      );
    }

    const changes: EngineChange[] = [];

    // THE ROUTE IS THE STATE MACHINE'S, NOT THIS METHOD'S.
    //
    // `START_GAME` leaves the engine in ROUND_INTRO on round 1, and the only
    // legal way out of a round is through a challenge and its result:
    //
    //   ROUND_INTRO -> CHALLENGE_INTRO -> ACTIVE_PLAY -> RESULT
    //               -> ROUND_COMPLETE -> ROUND_INTRO (round 2)
    //
    // There is no shortcut, deliberately — ROUND_INTRO -> ROUND_INTRO and
    // ROUND_INTRO -> ROUND_COMPLETE are both absent from the transition table
    // (lifecycle.ts), because a round ends by being played.
    //
    // So this walks that route with an EMPTY PLACEHOLDER challenge that awards
    // nothing. It is not Round 1 and does not pretend to be: Round 1's rules,
    // questions and allocation are open (OPEN_RULES.md §1) and nothing here
    // decides any of them. It exists only to satisfy the state machine honestly
    // rather than by assigning a phase behind its back.
    //
    // Re-entering ROUND_INTRO is what advances the round counter and expires
    // Market items from the round that just ended (§10), so Round 2 starts with
    // the state a real Round 1 completion would have left.
    while (this.#roundIndex < ROUND2_ROUND_INDEX) {
      if (this.#phase.phase === 'ROUND_INTRO') {
        const intro = this.advancePhase('CHALLENGE_INTRO');
        if (!intro.ok) return err(intro.error);
        changes.push(intro.value);

        const prepared = this.prepareChallenge({
          challengeType: DEV_ROUND_SKIP_CHALLENGE_TYPE,
        });
        if (!prepared.ok) return err(prepared.error);
        changes.push(prepared.value);

        const started = this.startChallenge();
        if (!started.ok) return err(started.error);
        changes.push(started.value);

        // Resolved with NO winner and NO BB. `abandoned` is the honest
        // completion status: this challenge was never played.
        const resolved = this.resolveChallenge({
          completion: 'abandoned',
          decidedByHost: true,
          note: 'Development: skipped to Round 2. Round 1 is not implemented.',
        });
        if (!resolved.ok) return err(resolved.error);
        changes.push(resolved.value.change);
      }

      if (this.#phase.phase !== 'ROUND_COMPLETE') {
        const complete = this.advancePhase('ROUND_COMPLETE');
        if (!complete.ok) return err(complete.error);
        changes.push(complete.value);
      }

      const next = this.advancePhase('ROUND_INTRO');
      if (!next.ok) return err(next.error);
      changes.push(next.value);
    }

    const began = this.beginRound2();
    if (!began.ok) return err(began.error);
    changes.push(began.value);

    return ok(changes);
  }

  /**
   * DEVELOPMENT ONLY — walk the engine from game start to the Round 3 intro.
   *
   * Same discipline as `devEnterRound2`: real transitions, a clearly-named
   * placeholder challenge per skipped round, and the SAME `beginRound3` that a
   * real Round 2 completion will eventually call. Nothing assigns a phase.
   *
   * Round 2 is implemented, so a game may already have played it — this starts
   * from wherever the round counter actually is and walks forward.
   */
  devEnterRound3(): Result<readonly EngineChange[]> {
    const guard = this.#requireRunning();
    if (guard !== null) return err(guard);

    if (!this.#options.devTools) {
      return err(
        rejection('ILLEGAL_ACTION', 'Development controls are disabled on this server.'),
      );
    }
    if (this.#round3 !== null) {
      return err(rejection('WRONG_STATE', 'Round 3 has already started.'));
    }
    if (this.#roundIndex > ROUND3_ROUND_INDEX) {
      return err(
        rejection('WRONG_STATE', 'The game is already past Round 3.', {
          roundIndex: this.#roundIndex,
        }),
      );
    }

    const changes: EngineChange[] = [];

    while (this.#roundIndex < ROUND3_ROUND_INDEX) {
      if (this.#phase.phase === 'ROUND_INTRO') {
        const intro = this.advancePhase('CHALLENGE_INTRO');
        if (!intro.ok) return err(intro.error);
        changes.push(intro.value);

        const prepared = this.prepareChallenge({
          challengeType: DEV_ROUND_SKIP_CHALLENGE_TYPE,
        });
        if (!prepared.ok) return err(prepared.error);
        changes.push(prepared.value);

        const started = this.startChallenge();
        if (!started.ok) return err(started.error);
        changes.push(started.value);

        const resolved = this.resolveChallenge({
          completion: 'abandoned',
          decidedByHost: true,
          note: 'Development: skipped to Round 3.',
        });
        if (!resolved.ok) return err(resolved.error);
        changes.push(resolved.value.change);
      }

      if (this.#phase.phase !== 'ROUND_COMPLETE') {
        const complete = this.advancePhase('ROUND_COMPLETE');
        if (!complete.ok) return err(complete.error);
        changes.push(complete.value);
      }

      const next = this.advancePhase('ROUND_INTRO');
      if (!next.ok) return err(next.error);
      changes.push(next.value);
    }

    const began = this.beginRound3();
    if (!began.ok) return err(began.error);
    changes.push(began.value);

    return ok(changes);
  }

  /** Exposed for the owning room to append engine events to the shared log. */
  get log(): EventLog {
    return this.#log;
  }
}

// ---------------------------------------------------------------------------
// Runtime validators.
//
// These narrow strings that arrived over a network. Types vanish at runtime and
// intents come from phones, so a `challengeKind` field is a string until one of
// these says otherwise — the same discipline room.ts applies to phase names.
// ---------------------------------------------------------------------------

/**
 * The placeholder challenge type the development Round 2 entry uses to leave
 * round 1 legally.
 *
 * NOT ROUND 1. It awards nothing, has no configuration, no questions and no
 * card window, and its name says what it is so it can never be mistaken for a
 * real round in a log or a ledger note. Round 1's actual rules stay open
 * (OPEN_RULES.md §1).
 */
const DEV_ROUND_SKIP_CHALLENGE_TYPE = 'DEV_ROUND_SKIP';

function isCardChallengeKind(value: string): value is CardChallengeKind {
  return (CARD_CHALLENGE_KINDS as readonly string[]).includes(value);
}

function isMarketItem(value: string): value is MarketItem {
  return (MARKET_ITEMS as readonly string[]).includes(value);
}

function isHostDealTemplate(value: string): value is HostDealTemplate {
  return (HOST_DEAL_TEMPLATES as readonly string[]).includes(value);
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
