import {
  asSequenceNumber,
  asServerTimestamp,
  asPlayerId,
  asTeamId,
  DEFAULT_TEAM_LABELS,
  err,
  GAME_EVENTS,
  GAME_INTENTS,
  HOST_RULING_KINDS,
  isSupportedProtocolVersion,
  normaliseDisplayName,
  ok,
  PROTOCOL_VERSION,
  rejection,
  ROOM_EVENTS,
  ROOM_INTENTS,
  ROUND2_INTENTS,
  ROUND1_EVENTS,
  ROUND1_INTENTS,
  isRound1Difficulty,
  ROUND1_CARD_CHALLENGE_KIND,
  type Round1Verdict,
  ROUND3_INTENTS,
  isRound3ChallengeType,
  SHARED_INTENTS,
  teamsForMode,
  toPublicPlayer,
  type EventEnvelope,
  type GameMode,
  type GamePhase,
  type GameSnapshot,
  type GameTeamView,
  type HostGameSnapshot,
  type HostRulingKind,
  type IntentEnvelope,
  type KnownTeamId,
  type LobbyPlayer,
  type LobbyPlayerPrivate,
  type LobbyRoom,
  type LobbySnapshot,
  type LobbyTeam,
  type PlayerGameSnapshot,
  type PlayerId,
  type Result,
  type RoomId,
  type RoomStatus,
  type SequenceNumber,
  type TeamId,
  type TeamMode,
} from '@bb/protocol';
import type { Clock } from './clock.js';
import { EventLog } from './event-log.js';
import { createTestContentSource, type Round3ContentSource } from './round3-content.js';
import {
  createTestRound1ContentSource,
  validateQuestionSet,
  type Round1ContentSource,
} from './round1-content.js';
import {
  gradeDeterministic,
  UnavailableSemanticJudge,
  type AnswerSemanticJudge,
} from './round1-grading.js';
import { GameEngine, type EngineChange, type StartingTeam } from './game-engine.js';
import { IntentRegistry } from './idempotency.js';

/**
 * The authoritative production room — Phases 4 and 5.
 *
 * This owns the lobby: who is in it, which team they are on, whether that is
 * locked, and who is allowed to change any of it. The server is authoritative
 * (CLAUDE.md, ARCHITECTURE.md §4); Unity and phones send intents and render what
 * comes back.
 *
 * Phase 5 adds the GAME. The room holds a `GameEngine` and routes gameplay
 * intents to it, but keeps lobby concerns and game concerns in separate objects:
 * the room knows about sockets, credentials and rosters; the engine knows about
 * BB, phases, challenges, turns and timers, and has never heard of a connection.
 *
 * ONE EVENT LOG SERVES BOTH. Lobby and gameplay events share a single per-room
 * sequence, because a client must be able to order "Team A reached 1,500 BB"
 * against "Javal disconnected" — two independent counters could not express
 * that, and a gap in either would stop meaning "you missed something".
 *
 * STILL NO ROUND RULES. No card, no Market, no Maco Mail, no wager, no buzzer,
 * no question. Those are Phases 6-7 and several depend on rules open in
 * docs/OPEN_RULES.md.
 *
 * Transport-free by design — plain objects in, events out — so the whole thing
 * is testable deterministically with a FakeClock, and so the raw-WebSocket
 * decision (D-014) stays reversible.
 */

/** Who is acting on a connection, resolved from credentials. */
export type RoomRole =
  | { readonly kind: 'host' }
  | { readonly kind: 'player'; readonly playerId: PlayerId }
  /** Connected but not yet identified — has sent nothing or only a failed join. */
  | { readonly kind: 'anonymous' };

export interface RoomOptions {
  readonly roomId: RoomId;
  readonly roomCode: string;
  readonly mode: GameMode;
  readonly clock: Clock;
  /** Host credential, minted by the store. */
  readonly hostToken: string;
  /** Phase 4 spec §19. Generous enough for a party; see docs/LOBBY.md. */
  readonly capacity: number;
  /** Mints reconnect credentials. Injected so tests are deterministic. */
  readonly mintToken: () => string;
  /** Mints player ids. Injected for the same reason. */
  readonly mintPlayerId: () => string;
  /**
   * Whether development engine controls are accepted on this server.
   *
   * Phase 5 spec §17 wants a way to exercise the BB ledger before any round
   * exists; it also wants that tooling clearly separated from real gameplay.
   * Gating it here means a production deployment physically cannot accept
   * DEV_ADJUST_BB, whatever a client sends.
   */
  readonly devTools?: boolean;
  /**
   * Where Round 3 challenge content comes from. GAME_RULES_LOCKED.md §13.
   *
   * Defaults to the TEST source during development. A production deployment
   * supplies its own; the Host never types content either way.
   */
  readonly contentSource?: Round3ContentSource;
  /**
   * Where Round 1 trivia comes from. GAME_RULES_LOCKED.md §11, §13.
   *
   * Defaults to the TEST source during development. Separate from the Round 3
   * source because the two carry different shapes: a Round 1 item holds a
   * canonical answer (the round is machine-graded), and a Round 3 item never
   * does (the Host judges).
   */
  readonly round1ContentSource?: Round1ContentSource;
  /**
   * The AI semantic judge for genuinely ambiguous Round 1 answers.
   *
   * Defaults to one that refuses to guess, which is every environment today —
   * the project has made no AI provider decision, so Phase 7C ships no vendor
   * adapter. With no judge configured the game plays normally; the Host simply
   * rules on more answers.
   */
  readonly semanticJudge?: AnswerSemanticJudge;
}

/** Result of handling one intent: a reply, events to broadcast, private sends. */
export interface RoomOutcome {
  /** Reply to the submitting connection. */
  readonly ack: Result<{ readonly seq: SequenceNumber; readonly payload?: unknown }>;
  /** Events every connection in the room should receive. */
  readonly broadcast: readonly EventEnvelope[];
  /**
   * Events destined for exactly one connection.
   *
   * Exists so CONNECTION_SUPERSEDED can reach a displaced socket, and so a
   * credential never rides on a broadcast.
   */
  readonly direct: readonly { readonly connectionId: string; readonly event: EventEnvelope }[];
  /** Connections the caller should close after delivery (superseded sockets). */
  readonly closeConnections: readonly string[];
}

export class Room {
  readonly #clock: Clock;
  readonly #log: EventLog;
  readonly #intents = new IntentRegistry();
  readonly #players = new Map<string, LobbyPlayerPrivate>();
  readonly #options: RoomOptions;
  /** Round 3 content. One per room, so cursors never leak between games. */
  readonly #content: Round3ContentSource;
  /** Round 1 content. One per room, so cursors never leak between games. */
  readonly #round1Content: Round1ContentSource;
  readonly #judge: AnswerSemanticJudge;
  /**
   * Answers waiting on the AI judge.
   *
   * ================== WHY A QUEUE AND NOT AN AWAIT ==================
   * `Room` is entirely synchronous, deliberately: every intent handler returns
   * a decided outcome, which is what makes the event sequence and the
   * idempotency registry straightforward to reason about. Making it async to
   * accommodate one optional AI call would reshape the whole class.
   *
   * So the deterministic layers grade INLINE — which handles the overwhelming
   * majority of answers — and only a genuinely ambiguous one is queued here.
   * The judge resolves it off to the side and the result lands on a later tick,
   * exactly as timer and Clash expiry already do.
   * ==================================================================
   */
  readonly #pendingJudgements = new Map<string, Round1Verdict>();
  /**
   * The game. Exists from room creation but does nothing until START_GAME,
   * so there is no second object to create — and no window in which a game
   * intent could arrive with nothing to answer it.
   */
  readonly #game: GameEngine;

  /** connectionId -> who that connection is. The only source of authority. */
  readonly #connectionRoles = new Map<string, RoomRole>();

  #status: RoomStatus = 'OPEN';
  #teamMode: TeamMode = 2;
  #teamsLocked = false;
  #hostConnectionId: string | null = null;
  #createdAt: number;
  #updatedAt: number;

  constructor(options: RoomOptions) {
    this.#options = options;
    this.#content = options.contentSource ?? createTestContentSource();
    this.#round1Content = options.round1ContentSource ?? createTestRound1ContentSource();
    this.#judge = options.semanticJudge ?? new UnavailableSemanticJudge();
    this.#clock = options.clock;
    this.#log = new EventLog(options.roomId, options.clock);
    this.#createdAt = options.clock.now();
    this.#updatedAt = this.#createdAt;

    // Shares this room's event log, so gameplay and lobby events carry one
    // monotonic sequence.
    this.#game = new GameEngine({
      roomId: options.roomId,
      clock: options.clock,
      log: this.#log,
      mintId: options.mintPlayerId,
      devTools: options.devTools ?? false,
    });
  }

  // -------------------------------------------------------------------------
  // Read access
  // -------------------------------------------------------------------------

  get roomId(): RoomId {
    return this.#options.roomId;
  }

  get roomCode(): string {
    return this.#options.roomCode;
  }

  get status(): RoomStatus {
    return this.#status;
  }

  get teamMode(): TeamMode {
    return this.#teamMode;
  }

  get teamsLocked(): boolean {
    return this.#teamsLocked;
  }

  get seq(): SequenceNumber {
    return this.#log.latestSeq();
  }

  get playerCount(): number {
    return this.#players.size;
  }

  get hostConnectionId(): string | null {
    return this.#hostConnectionId;
  }

  /** The game engine. Read-only access for the server and tests. */
  get game(): GameEngine {
    return this.#game;
  }

  get gameStarted(): boolean {
    return this.#game.started;
  }

  player(playerId: PlayerId): LobbyPlayer | undefined {
    const found = this.#players.get(playerId);
    return found === undefined ? undefined : toPublicPlayer(found);
  }

  /** Server-internal. Never serialise the result to a client. */
  playerPrivate(playerId: PlayerId): LobbyPlayerPrivate | undefined {
    return this.#players.get(playerId);
  }

  roleOf(connectionId: string): RoomRole {
    return this.#connectionRoles.get(connectionId) ?? { kind: 'anonymous' };
  }

  /** The connection currently authoritative for a player, if any. */
  connectionOf(playerId: PlayerId): string | null {
    return this.#players.get(playerId)?.connectionId ?? null;
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  snapshot(forConnection: string | null = null): LobbySnapshot {
    const role = forConnection === null ? { kind: 'anonymous' as const } : this.roleOf(forConnection);

    return {
      protocolVersion: PROTOCOL_VERSION,
      seq: this.#log.latestSeq(),
      takenAt: asServerTimestamp(this.#clock.now()),
      room: this.#roomState(),
      // toPublicPlayer strips the reconnect credential. Building snapshots any
      // other way would risk leaking one, so there is no other way.
      players: [...this.#players.values()].map(toPublicPlayer),
      teams: this.#teamStates(),
      you: role.kind === 'player' ? role.playerId : null,
      isHost: role.kind === 'host',
    };
  }

  #roomState(): LobbyRoom {
    return {
      roomId: this.#options.roomId,
      roomCode: this.#options.roomCode,
      mode: this.#options.mode,
      status: this.#status,
      teamMode: this.#teamMode,
      teamsLocked: this.#teamsLocked,
      createdAt: asServerTimestamp(this.#createdAt),
      updatedAt: asServerTimestamp(this.#updatedAt),
      seq: this.#log.latestSeq(),
      hostConnected: this.#hostConnectionId !== null,
    };
  }

  #teamStates(): readonly LobbyTeam[] {
    return teamsForMode(this.#teamMode).map((teamId) => ({
      teamId: asTeamId(teamId),
      displayName: DEFAULT_TEAM_LABELS[teamId],
      memberIds: [...this.#players.values()]
        .filter((p) => p.teamId === teamId)
        .map((p) => p.playerId),
    }));
  }

  /**
   * Game snapshot, shaped for who is asking.
   *
   * THE CONTENT BOUNDARY (Phase 5 spec §20). Host and player snapshots are
   * separate types, not one shape with fields blanked out, so a future field
   * has to be placed deliberately on one side or the other. The Host gets the
   * BB ledger; a player gets their own identity, their team and the generic
   * state of play.
   *
   * Neither carries a reconnect credential or the Host token — those exist only
   * in the acknowledgement to the connection that earned them — and neither has
   * anywhere to put an unrevealed answer, a hidden Market selection or another
   * team's card hand. Those systems arrive in Phase 6 and will find the boundary
   * already drawn.
   */
  gameSnapshot(forConnection: string | null = null): GameSnapshot {
    const role = forConnection === null ? { kind: 'anonymous' as const } : this.roleOf(forConnection);

    const base = {
      protocolVersion: PROTOCOL_VERSION,
      seq: this.#log.latestSeq(),
      takenAt: asServerTimestamp(this.#clock.now()),
      room: this.#roomState(),
      players: [...this.#players.values()].map(toPublicPlayer),
      teams: this.#gameTeams(),
      teamMode: this.#teamMode,
      game: this.#game.sessionView(),
    };

    if (role.kind === 'host') {
      const hostSnapshot: HostGameSnapshot = {
        ...base,
        isHost: true,
        ledger: this.#game.ledgerEntries,
        devToolsEnabled: this.#game.devTools,
        // Phase 6. Built by the shared systems rather than assembled here, so
        // the secrecy boundary lives in one place (shared-systems.ts) and a new
        // field cannot be added to a snapshot without passing through it.
        shared: this.#game.started ? this.#game.shared.hostView() : null,
        // Phase 7C — the Host sees every submitted answer, because the Host
        // grades them (spec §14). The canonical answer still appears only once
        // the question is revealed.
        game:
          base.game === null
            ? null
            : { ...base.game, round1: this.#game.round1View(null, null, true) },
      };
      return hostSnapshot;
    }

    // Anyone who is not the verified Host gets the player-safe shape, including
    // a connection that has not identified itself. Defaulting to the narrower
    // view means a new caller cannot accidentally receive the Host's.
    const playerId = role.kind === 'player' ? role.playerId : ('' as PlayerId);
    const player = role.kind === 'player' ? this.#players.get(playerId) : undefined;
    const teamId = player?.teamId ?? null;

    const playerSnapshot: PlayerGameSnapshot = {
      ...base,
      isHost: false,
      you: playerId,
      yourTeamId: teamId,
      youAreActive: role.kind === 'player' && this.#game.isActivePlayer(playerId),
      yourTurn: this.#isYourTurn(playerId, teamId),
      // Phase 6 — an opponent's BB freezes at its Market-open value while the
      // Market is open. See #teamsForPlayer.
      teams: this.#teamsForPlayer(teamId),
      // Phase 7B — the base view hides every RPS choice. Rebuilt here scoped to
      // the asking team so `tiebreaker.yourChoice` carries THIS team's own
      // locked throw and nobody else's. §18, and the same deliberate exception
      // the Clash makes for `yourClashResponse`.
      game:
        base.game === null
          ? null
          : {
              ...base.game,
              round3: this.#game.round3View(teamId),
              // Phase 7C — scoped to THIS player. Their own team's submitted
              // answer, their nominee role, and a Maco! viewing if they are the
              // one entitled to it. Nobody else's answer text travels here.
              round1: this.#game.round1View(teamId, playerId),
            },
      // Phase 6. Scoped to the caller's OWN team — a player with no team gets
      // null rather than a view of someone else's, and an unidentified
      // connection lands here too (teamId is null), so the narrow path is also
      // the default.
      shared:
        this.#game.started && teamId !== null
          ? this.#game.shared.playerView(teamId, this.#game.paused)
          : null,
    };
    return playerSnapshot;
  }

  /**
   * Team balances as ONE PLAYER'S TEAM may see them.
   *
   * GAME_RULES_LOCKED.md §10 — "shopping is hidden" — and Phase 5's balances
   * being a visible scoreboard otherwise defeat each other: watching an
   * opponent's live BB tick down during an open Market reveals "they bought
   * something" (and roughly how much) even though WHAT stays hidden until
   * reveal. So while the Market is open, every OTHER team's balance is frozen
   * at what it was the moment the Market opened; the asking team's OWN balance
   * stays real-time, and once the Market closes everyone snaps back to live
   * figures together with the purchase reveal.
   *
   * THE HOST IS UNAFFECTED — this is only ever called for a player snapshot.
   * The Host adjudicates and already sees every purchase as it happens, so
   * freezing anything from the Host would hide nothing that matters and would
   * only make the Host's own job harder.
   */
  #teamsForPlayer(askingTeamId: TeamId | null): readonly GameTeamView[] {
    const teams = this.#gameTeams();
    if (!this.#game.started || !this.#game.shared.market.open) return teams;

    return teams.map((team) => {
      if (team.teamId === askingTeamId) return team;
      const frozen = this.#game.shared.market.frozenBalanceFor(team.teamId);
      return frozen === null ? team : { ...team, bb: frozen };
    });
  }

  /**
   * Whether it is this player's turn.
   *
   * True when the turn names the player, and also when it names their team
   * without naming a player — a team turn is every member's turn, which is what
   * a phone needs to know to stop saying "waiting for the Host".
   */
  #isYourTurn(playerId: PlayerId, teamId: TeamId | null): boolean {
    const turn = this.#game.turn;
    if (turn.teamId === null) return false;
    if (turn.playerId !== null) return turn.playerId === playerId;
    return teamId !== null && turn.teamId === teamId;
  }

  /** Teams with their authoritative balances. Empty before the game starts. */
  #gameTeams(): readonly GameTeamView[] {
    if (this.#game.started) return this.#game.teams();

    // Before START_GAME there are no balances to report, and inventing a
    // provisional 1,000 would show a score for a game that has not begun.
    return this.#teamStates().map((team) => ({
      teamId: team.teamId,
      displayName: team.displayName,
      memberIds: team.memberIds,
      bb: 0,
    }));
  }

  // -------------------------------------------------------------------------
  // Intent handling
  // -------------------------------------------------------------------------

  /**
   * Handle one intent from one connection.
   *
   * Check order is deliberate and mirrors GameSession.submit: protocol version,
   * then room identity, then deduplication, then the action. Deduplicating
   * BEFORE evaluating means a retried intent is never re-judged against rules
   * whose answer may have changed since — a phone retrying JOIN_ROOM after a
   * lost acknowledgement must not be told the room is now full.
   */
  handle(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    if (!isSupportedProtocolVersion(intent.protocolVersion)) {
      return this.#reject(
        rejection('UNSUPPORTED_PROTOCOL_VERSION', 'This app version is not compatible with the server.', {
          clientVersion: intent.protocolVersion,
          serverVersion: PROTOCOL_VERSION,
        }),
      );
    }

    // A timer is checked whenever the room is touched, rather than scheduled.
    // @bb/game-rules has no wall clock by design — ESLint bans setTimeout there
    // — so expiry is observed on activity. The events it produces are attached
    // to whatever outcome follows, so a client learns about the expiry in the
    // same delivery as the action that revealed it.
    const expiryEvents = this.#pollTimer();

    // Reads bypass deduplication entirely: they change nothing, so replaying one
    // is harmless, and recording them would grow the registry without purpose.
    if (intent.type === ROOM_INTENTS.REQUEST_LOBBY_SNAPSHOT) {
      return {
        ack: ok({ seq: this.#log.latestSeq(), payload: this.snapshot(connectionId) }),
        broadcast: expiryEvents,
        direct: [],
        closeConnections: [],
      };
    }

    if (intent.type === GAME_INTENTS.REQUEST_GAME_SNAPSHOT) {
      return {
        ack: ok({ seq: this.#log.latestSeq(), payload: this.gameSnapshot(connectionId) }),
        broadcast: expiryEvents,
        direct: [],
        closeConnections: [],
      };
    }

    if (this.#intents.has(intent.intentId)) {
      const originalSeq = this.#intents.resultOf(intent.intentId);
      return {
        ...this.#reject(
          rejection('DUPLICATE_INTENT', 'This action was already processed.', {
            intentId: intent.intentId,
            ...(originalSeq === undefined ? {} : { originalSeq }),
          }),
        ),
        broadcast: expiryEvents,
      };
    }

    const outcome = this.#evaluate(connectionId, intent);

    if (outcome.ack.ok) {
      this.#intents.record(intent.intentId, outcome.ack.value.seq);
    }

    if (expiryEvents.length === 0) return outcome;
    // Expiry happened BEFORE this intent was evaluated, so its events go first.
    return { ...outcome, broadcast: [...expiryEvents, ...outcome.broadcast] };
  }

  /**
   * Emit a TIMER_EXPIRED event if a deadline has passed.
   *
   * Returns events rather than delivering them, so the caller decides when they
   * reach clients. Reports at most once per timer — see TimerService.
   */
  #pollTimer(): EventEnvelope[] {
    const events: EventEnvelope[] = [];

    const expiry = this.#game.pollTimerExpiry();
    if (expiry !== null) {
      events.push(this.#log.append(expiry.type, { kind: 'server' }, expiry.payload));
    }

    // Phase 6: the Clash's 6-second window is observed the same way, and for
    // the same reason — @bb/game-rules schedules nothing. A window that closes
    // with nobody acting is the normal case, since every phone is silent while
    // teams decide whether to counter.
    const clash = this.#game.pollClashResolution();
    if (clash !== null) {
      events.push(this.#log.append(clash.type, { kind: 'server' }, clash.payload));
    }

    // Phase 7B: an expired Round 3 item window. §15-§17 — "if nobody answers
    // correctly, move to the next item", so an expired window is an
    // instruction rather than just a fact, and the item advances on its own.
    //
    // The room does this rather than the engine because only the room holds the
    // content source; the engine reports the expiry and this supplies the
    // replacement.
    if (this.#game.round3ItemWindowExpired()) {
      const challengeType = this.#game.round3?.currentChallengeType() ?? null;
      const next =
        challengeType === null || !isRound3ChallengeType(challengeType)
          ? null
          : this.#content.nextItem(challengeType);

      if (next === null) {
        // Nothing left in the pack. Stop the window rather than re-reporting
        // the same expiry on every tick; the Host confirms a winner from here.
        this.#game.clearRound3ExpiredItem();
      } else {
        const revealed = this.#game.revealRound3Item(next);
        if (revealed.ok) {
          events.push(
            this.#log.append(revealed.value.type, { kind: 'server' }, revealed.value.payload),
          );
        }
      }
    }

    // Phase 7C: Round 1's own deadlines, polled the same way.
    //
    // A 60-second question that runs out CLOSES and grades (§11: "when 60
    // seconds expires, lock remaining normal submissions, grade the submitted
    // answers"). A team that never submitted is simply ungraded — D-022 still
    // holds, because expiry decides no VERDICT; it only ends the window.
    if (this.#game.round1QuestionWindowExpired()) {
      const closed = this.#game.closeRound1Question();
      if (closed.ok) {
        events.push(this.#log.append(closed.value.type, { kind: 'server' }, closed.value.payload));
        events.push(...this.#gradeRound1Pending());
      }
    }

    // A retry window that runs out closes without an answer. §11 — the retry is
    // one final opportunity, so letting it lapse simply ends it.
    if (this.#game.round1RetryWindowExpired()) {
      this.#game.round1?.closeRetries();
    }

    // Grade any ungraded answer on the current question, however its window
    // closed — expiry, or the Host closing it early. Grading must not depend on
    // WHICH path ended the window, or an early close strands the question
    // ungraded and it can never be revealed.
    if ((this.#game.round1?.pendingGrading().length ?? 0) > 0) {
      events.push(...this.#gradeRound1Pending());
    }

    // A tiebreak window that runs out closes and grades. D-032.
    if (this.#game.round1?.tiebreakWindowExpired() === true) {
      this.#game.round1.closeTiebreakAttempt();
    }

    // Grade any ungraded tiebreak answer, however the attempt was closed —
    // by the window running out, or by the Host closing it early once every
    // tied team has answered. Grading has to happen on BOTH paths or the
    // attempt can never resolve.
    if ((this.#game.round1?.pendingTiebreakGrading().length ?? 0) > 0) {
      events.push(...this.#gradeRound1Pending());
    }

    // An expired Maco! viewing is dropped so a reconnect cannot revive it
    // (spec §8, §16).
    this.#game.round1?.clearExpiredMaco();

    // Verdicts the AI judge returned since the last tick.
    events.push(...this.#applyRound1Judgements());

    // Phase 7B: the rock-paper-scissors reveal, observed for the same reason.
    // It fires as soon as the last tied team locks a choice, so the reveal is
    // simultaneous rather than triggered by whoever happened to act last.
    const rps = this.#game.pollRpsResolution();
    if (rps !== null) {
      events.push(this.#log.append(rps.type, { kind: 'server' }, rps.payload));

      // A resolved tiebreaker decides the round. Appended as its own event so a
      // client can order "the throw was revealed" against "Round 3 was won".
      if (this.#game.round3?.winningTeamId !== null && this.#game.round3?.winningTeamId !== undefined) {
        const decided = this.#game.decideRound3Winner();
        if (decided.ok) {
          events.push(
            this.#log.append(decided.value.type, { kind: 'server' }, decided.value.payload),
          );
        }
      }
    }

    return events;
  }

  /**
   * Check for timer expiry outside intent handling.
   *
   * The server calls this on a slow tick so an expiry is announced even when
   * nobody sends anything — which is the normal case, since a timer running out
   * is precisely the moment when every phone is silent.
   */
  tick(): readonly EventEnvelope[] {
    return this.#pollTimer();
  }

  #evaluate(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    switch (intent.type) {
      case ROOM_INTENTS.JOIN_ROOM:
        return this.#join(connectionId, intent);
      case ROOM_INTENTS.RECONNECT_PLAYER:
        return this.#reconnectPlayer(connectionId, intent);
      case ROOM_INTENTS.RECONNECT_HOST:
        return this.#reconnectHost(connectionId, intent);
      case ROOM_INTENTS.LEAVE_ROOM:
        return this.#leave(connectionId, intent);
      case ROOM_INTENTS.HOST_SET_TEAM_MODE:
        return this.#setTeamMode(connectionId, intent);
      case ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM:
        return this.#assignTeam(connectionId, intent);
      case ROOM_INTENTS.HOST_UNASSIGN_PLAYER:
        return this.#unassign(connectionId, intent);
      case ROOM_INTENTS.HOST_REMOVE_PLAYER:
        return this.#removePlayer(connectionId, intent);
      case ROOM_INTENTS.HOST_LOCK_TEAMS:
        return this.#lockTeams(connectionId, intent);
      case ROOM_INTENTS.HOST_UNLOCK_TEAMS:
        return this.#unlockTeams(connectionId, intent);
      case ROOM_INTENTS.HOST_CLOSE_ROOM:
        return this.#closeRoom(connectionId, intent);

      // --- Phase 5: gameplay -------------------------------------------------
      case GAME_INTENTS.START_GAME:
        return this.#startGame(connectionId, intent);
      case GAME_INTENTS.HOST_ADVANCE_PHASE:
        return this.#advancePhase(connectionId, intent);
      case GAME_INTENTS.HOST_PREPARE_CHALLENGE:
        return this.#prepareChallenge(connectionId, intent);
      case GAME_INTENTS.HOST_START_CHALLENGE:
        return this.#startChallenge(connectionId, intent);
      case GAME_INTENTS.HOST_SET_TURN:
        return this.#setTurn(connectionId, intent);
      case GAME_INTENTS.HOST_SET_ACTIVE_PLAYERS:
        return this.#setActivePlayers(connectionId, intent);
      case GAME_INTENTS.HOST_START_TIMER:
        return this.#startTimer(connectionId, intent);
      case GAME_INTENTS.HOST_CANCEL_TIMER:
        return this.#engineAction(connectionId, intent, () => this.#game.cancelTimer());
      case GAME_INTENTS.HOST_REQUEST_REVIEW:
        return this.#engineAction(connectionId, intent, () => this.#game.requestReview());
      case GAME_INTENTS.HOST_RULING:
        return this.#hostRuling(connectionId, intent);
      case GAME_INTENTS.HOST_RESOLVE_CHALLENGE:
        return this.#resolveChallenge(connectionId, intent);
      case GAME_INTENTS.HOST_PAUSE_GAME:
        return this.#engineAction(connectionId, intent, () => this.#game.pause('host_requested'));
      case GAME_INTENTS.HOST_RESUME_GAME:
        return this.#resumeGame(connectionId, intent);
      case GAME_INTENTS.DEV_ADJUST_BB:
        return this.#devAdjustBb(connectionId, intent);

      // --- Phase 6: shared systems -------------------------------------------
      // Host-gated: dealing, windows, the Market's opening and closing, draws,
      // deals and wager resolution.
      case SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS:
        return this.#engineAction(connectionId, intent, () => this.#game.dealBacchanalCards());
      case SHARED_INTENTS.DEV_REDEAL_BACCHANAL_CARDS:
        return this.#engineAction(connectionId, intent, () => this.#game.devRedealBacchanalCards());
      case SHARED_INTENTS.HOST_OPEN_CARD_WINDOW:
        return this.#openCardWindow(connectionId, intent);
      case SHARED_INTENTS.HOST_CLOSE_CARD_WINDOW:
        return this.#engineAction(connectionId, intent, () => this.#game.closeCardWindow());
      case SHARED_INTENTS.HOST_OPEN_MARKET:
        return this.#openMarket(connectionId, intent);
      case SHARED_INTENTS.HOST_CLOSE_MARKET:
        return this.#engineAction(connectionId, intent, () => this.#game.closeMarket());
      case SHARED_INTENTS.HOST_DRAW_MACO_MAIL:
        return this.#drawMacoMail(connectionId, intent);
      case SHARED_INTENTS.HOST_OFFER_DEAL:
        return this.#offerHostDeal(connectionId, intent);
      case SHARED_INTENTS.HOST_RESOLVE_WAGER:
        return this.#resolveWager(connectionId, intent);

      // Player-gated: a TEAM decides its own card, counter, purchase, deal
      // answer and stake. The server still validates every one of them.
      case SHARED_INTENTS.PLAY_BACCHANAL_CARD:
        return this.#playBacchanalCard(connectionId, intent);
      case SHARED_INTENTS.RESPOND_TO_CLASH:
        return this.#respondToClash(connectionId, intent);
      case SHARED_INTENTS.PURCHASE_MARKET_ITEM:
        return this.#purchaseMarketItem(connectionId, intent);
      case SHARED_INTENTS.WITHDRAW_MARKET_PURCHASE:
        return this.#withdrawMarketPurchase(connectionId, intent);
      case SHARED_INTENTS.USE_ADVANTAGE:
        return this.#useAdvantage(connectionId, intent);
      case SHARED_INTENTS.RESPOND_TO_HOST_DEAL:
        return this.#respondToHostDeal(connectionId, intent);
      case SHARED_INTENTS.PROPOSE_WAGER:
        return this.#proposeWager(connectionId, intent);

      // --- Phase 7A: Round 2 --------------------------------------------------
      // ALL HOST-GATED. GAME_RULES_LOCKED.md §12 and D-003 make the Host the
      // judge of a physical game, so there is deliberately no player intent
      // here: a phone has no route to nominate a winner, because no handler
      // below accepts one from a player connection (Phase 7A spec §13).
      case ROUND2_INTENTS.HOST_PREPARE_ROUND2_CHALLENGE:
        return this.#engineAction(connectionId, intent, () =>
          this.#game.prepareRound2Challenge(),
        );
      case ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER:
        return this.#selectRound2Winner(connectionId, intent);
      case ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT:
        return this.#confirmRound2Result(connectionId, intent);
      case ROUND2_INTENTS.DEV_START_ROUND2:
        return this.#devStartRound2(connectionId, intent);

      // --- Phase 7B: Round 3 --------------------------------------------------
      case ROUND3_INTENTS.HOST_PREPARE_ROUND3_CHALLENGE:
        return this.#engineAction(connectionId, intent, () =>
          this.#game.prepareRound3Challenge(),
        );
      case ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM:
        return this.#nextRound3Item(connectionId, intent);
      case ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT:
        return this.#awardRound3Point(connectionId, intent);
      case ROUND3_INTENTS.HOST_THINK_FAST_VALID:
        return this.#engineAction(connectionId, intent, () => this.#game.thinkFastValid());
      case ROUND3_INTENTS.HOST_THINK_FAST_ELIMINATE:
        return this.#engineAction(connectionId, intent, () => this.#game.thinkFastEliminate());
      case ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE:
        return this.#confirmRound3Challenge(connectionId, intent);
      // The one PLAYER intent in Round 3: a team chooses its own RPS throw.
      case ROUND3_INTENTS.SUBMIT_RPS_CHOICE:
        return this.#submitRpsChoice(connectionId, intent);
      case ROUND3_INTENTS.DEV_START_ROUND3:
        return this.#devStartRound3(connectionId, intent);

      // --- Round 1. Phase 7C. -------------------------------------------
      case ROUND1_INTENTS.NOMINATE_ANSWERER:
        return this.#nominateAnswerer(connectionId, intent);
      case ROUND1_INTENTS.HOST_START_ROUND1:
        return this.#startRound1Questions(connectionId, intent);
      case ROUND1_INTENTS.HOST_NEXT_ROUND1_QUESTION:
        return this.#nextRound1Question(connectionId, intent);
      case ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER:
        return this.#submitRound1Answer(connectionId, intent);
      case ROUND1_INTENTS.VIEW_ROUND1_MACO:
        return this.#viewRound1Maco(connectionId, intent);
      case ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION:
        return this.#closeRound1Question(connectionId, intent);
      case ROUND1_INTENTS.HOST_RULE_ROUND1_ANSWER:
        return this.#ruleRound1Answer(connectionId, intent);
      case ROUND1_INTENTS.HOST_OPEN_ROUND1_RETRY:
        return this.#openRound1Retry(connectionId, intent);
      case ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER:
        return this.#revealRound1Answer(connectionId, intent);
      case ROUND1_INTENTS.HOST_START_ROUND1_TIEBREAK:
        return this.#startRound1Tiebreak(connectionId, intent);
      case ROUND1_INTENTS.DEV_START_ROUND1:
        return this.#devStartRound1(connectionId, intent);

      default:
        return this.#reject(rejection('INVALID_REQUEST', 'Unknown intent type.', { type: intent.type }));
    }
  }

  // -------------------------------------------------------------------------
  // Join
  // -------------------------------------------------------------------------

  #join(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    if (this.#status === 'CLOSED') {
      return this.#reject(rejection('WRONG_STATE', 'This room has closed.'));
    }
    if (this.#teamsLocked || this.#status === 'LOCKED') {
      // Once teams are locked the roster is final. A newcomer cannot be placed
      // on a team, and inventing a rule for late arrivals is not Phase 4's to
      // make. The Host can unlock deliberately if someone should be added.
      return this.#reject(rejection('WRONG_STATE', 'Teams are locked. The Host must unlock to add players.'));
    }

    const displayName = normaliseDisplayName(readField(intent.payload, 'displayName'));
    if (displayName === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Please enter a name.', { field: 'displayName' }));
    }

    if (this.#players.size >= this.#options.capacity) {
      return this.#reject(
        rejection('ILLEGAL_ACTION', 'This room is full.', { capacity: this.#options.capacity }),
      );
    }

    const playerId = this.#options.mintPlayerId() as PlayerId;
    const reconnectToken = this.#options.mintToken();
    const now = asServerTimestamp(this.#clock.now());

    const player: LobbyPlayerPrivate = {
      playerId,
      displayName,
      teamId: null,
      connection: 'connected',
      joinedAt: now,
      disconnectedAt: null,
      reconnectToken,
      connectionId,
      sessionId: null,
    };
    this.#players.set(playerId, player);
    this.#connectionRoles.set(connectionId, { kind: 'player', playerId });
    this.#touch();

    // Broadcast carries NO credential — only the public player record.
    const event = this.#log.append(
      ROOM_EVENTS.PLAYER_JOINED,
      { kind: 'player', sessionId: '' as never, playerId },
      { player: toPublicPlayer(player), room: this.#roomState() },
      intent.intentId,
    );

    return {
      // The credential travels in the ack, to the joining socket only.
      ack: ok({
        seq: event.seq,
        payload: {
          playerId,
          displayName,
          reconnectToken,
          snapshot: this.snapshot(connectionId),
        },
      }),
      broadcast: [event],
      direct: [],
      closeConnections: [],
    };
  }

  // -------------------------------------------------------------------------
  // Reconnect
  // -------------------------------------------------------------------------

  #reconnectPlayer(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    if (this.#status === 'CLOSED') {
      return this.#reject(rejection('WRONG_STATE', 'This room has closed.'));
    }

    const playerId = readString(intent.payload, 'playerId');
    const token = readString(intent.payload, 'reconnectToken');
    if (playerId === null || token === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing reconnect details.'));
    }

    const player = this.#players.get(playerId);

    // One rejection for "no such player" and "wrong credential" alike. Telling
    // the difference would let anyone probe which playerIds are valid, and
    // playerIds are broadcast to the whole room.
    if (player === undefined || !constantTimeEquals(player.reconnectToken, token)) {
      return this.#reject(rejection('UNAUTHORIZED_ACTOR', 'Could not restore this player.'));
    }

    // Stale-connection policy: NEWEST AUTHENTICATED CONNECTION WINS.
    // The player is holding the phone that just proved identity; the old socket
    // is a locked screen or a forgotten tab. Displacing it here — rather than
    // waiting for a timeout — is what makes "lock the phone, unlock it, keep
    // playing" work without duplicating the player.
    const displaced = player.connectionId;
    const closeConnections: string[] = [];
    const direct: { connectionId: string; event: EventEnvelope }[] = [];

    if (displaced !== null && displaced !== connectionId) {
      this.#connectionRoles.delete(displaced);
      closeConnections.push(displaced);
    }

    this.#players.set(playerId, {
      ...player,
      connection: 'connected',
      connectionId,
      disconnectedAt: null,
    });
    this.#connectionRoles.set(connectionId, { kind: 'player', playerId: playerId as PlayerId });
    this.#touch();

    const event = this.#log.append(
      ROOM_EVENTS.PLAYER_RECONNECTED,
      { kind: 'player', sessionId: '' as never, playerId: playerId as PlayerId },
      { playerId, room: this.#roomState() },
      intent.intentId,
    );

    if (displaced !== null && displaced !== connectionId) {
      // Tell the displaced socket why it is about to close. Built after the
      // event above so it carries the same sequence context.
      direct.push({
        connectionId: displaced,
        event: this.#log.buildTransient(ROOM_EVENTS.CONNECTION_SUPERSEDED, { kind: 'server' }, {
          playerId,
          reason: 'A newer connection took over this player.',
        }),
      });
    }

    return {
      ack: ok({
        seq: event.seq,
        payload: {
          playerId,
          displayName: player.displayName,
          // The credential is NOT reissued. Reissuing would break the common
          // case of two tabs racing to reconnect, and the existing one has not
          // been compromised by a successful reconnect.
          snapshot: this.snapshot(connectionId),
        },
      }),
      broadcast: [event],
      direct,
      closeConnections,
    };
  }

  #reconnectHost(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    if (this.#status === 'CLOSED') {
      return this.#reject(rejection('WRONG_STATE', 'This room has closed.'));
    }

    const token = readString(intent.payload, 'hostToken');
    if (token === null || !constantTimeEquals(this.#options.hostToken, token)) {
      return this.#reject(rejection('UNAUTHORIZED_ACTOR', 'Invalid Host credential.'));
    }

    const displaced = this.#hostConnectionId;
    const closeConnections: string[] = [];
    const direct: { connectionId: string; event: EventEnvelope }[] = [];

    if (displaced !== null && displaced !== connectionId) {
      this.#connectionRoles.delete(displaced);
      closeConnections.push(displaced);
      direct.push({
        connectionId: displaced,
        event: this.#log.buildTransient(ROOM_EVENTS.CONNECTION_SUPERSEDED, { kind: 'server' }, {
          reason: 'The Host reconnected from another window.',
        }),
      });
    }

    this.#hostConnectionId = connectionId;
    this.#connectionRoles.set(connectionId, { kind: 'host' });
    this.#touch();

    const event = this.#log.append(
      ROOM_EVENTS.HOST_CONNECTION_CHANGED,
      { kind: 'server' },
      { hostConnected: true, room: this.#roomState() },
      intent.intentId,
    );

    return {
      ack: ok({
        seq: event.seq,
        payload: {
          roomId: this.#options.roomId,
          roomCode: this.#options.roomCode,
          snapshot: this.snapshot(connectionId),
        },
      }),
      broadcast: [event],
      direct,
      closeConnections,
    };
  }

  /** Attach the creating Host connection. Called by the store on CREATE_ROOM. */
  attachHost(connectionId: string): void {
    this.#hostConnectionId = connectionId;
    this.#connectionRoles.set(connectionId, { kind: 'host' });
    this.#touch();
  }

  // -------------------------------------------------------------------------
  // Leave — deliberate, and NOT the same as a dropped socket
  // -------------------------------------------------------------------------

  #leave(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const role = this.roleOf(connectionId);
    if (role.kind !== 'player') {
      return this.#reject(rejection('UNAUTHORIZED_ACTOR', 'Only a joined player can leave.'));
    }

    const player = this.#players.get(role.playerId);
    if (player === undefined) {
      return this.#reject(rejection('NOT_FOUND', 'Player not found.'));
    }

    // Membership is destroyed, which invalidates the credential by construction:
    // the record holding it is gone, so a later RECONNECT_PLAYER finds nothing
    // and is refused. That is the difference from a disconnect, where the whole
    // point is that the record survives.
    this.#players.delete(role.playerId);
    this.#connectionRoles.delete(connectionId);
    this.#touch();

    const event = this.#log.append(
      ROOM_EVENTS.PLAYER_LEFT,
      { kind: 'server' },
      { playerId: role.playerId, displayName: player.displayName, room: this.#roomState() },
      intent.intentId,
    );

    return { ack: ok({ seq: event.seq }), broadcast: [event], direct: [], closeConnections: [] };
  }

  // -------------------------------------------------------------------------
  // Host actions
  // -------------------------------------------------------------------------

  /**
   * Gate every Host-only action.
   *
   * Authority comes from the connection's resolved role, which is set only by a
   * verified credential. Nothing here reads the intent payload — that is the
   * point. Phase 4 spec §15: a client must not gain Host powers by sending
   * `isHost: true`, and it cannot, because no code path consults such a field.
   */
  #requireHost(connectionId: string): Result<true> {
    if (this.roleOf(connectionId).kind !== 'host') {
      return err(rejection('UNAUTHORIZED_ACTOR', 'Only the Host can do that.'));
    }
    return ok(true);
  }

  #setTeamMode(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    if (this.#teamsLocked) {
      return this.#reject(rejection('WRONG_STATE', 'Teams are locked.'));
    }

    const raw = readField(intent.payload, 'teamMode');
    if (raw !== 2 && raw !== 3) {
      return this.#reject(rejection('INVALID_REQUEST', 'Team mode must be 2 or 3.'));
    }
    const mode: TeamMode = raw;

    // Phase 4 spec §11 — going 3 -> 2 must not silently move Team C players.
    // Silent reassignment is the kind of thing nobody notices until the game has
    // started and someone is on the wrong team, so it is refused outright and
    // the Host is told exactly who is in the way.
    if (mode === 2 && this.#teamMode === 3) {
      const stranded = [...this.#players.values()].filter((p) => p.teamId === 'TEAM_C');
      if (stranded.length > 0) {
        return this.#reject(
          rejection('ILLEGAL_ACTION', 'Move the players out of Team C first.', {
            teamId: 'TEAM_C',
            playerCount: stranded.length,
          }),
        );
      }
    }

    if (mode === this.#teamMode) {
      // Not an error — the Host asked for the state it already has. Report
      // success without minting an event, so the log stays a record of change.
      return { ack: ok({ seq: this.#log.latestSeq() }), broadcast: [], direct: [], closeConnections: [] };
    }

    this.#teamMode = mode;
    this.#touch();

    const event = this.#log.append(
      ROOM_EVENTS.TEAM_MODE_CHANGED,
      { kind: 'host', sessionId: '' as never },
      { teamMode: mode, room: this.#roomState(), teams: this.#teamStates() },
      intent.intentId,
    );

    return { ack: ok({ seq: event.seq }), broadcast: [event], direct: [], closeConnections: [] };
  }

  #assignTeam(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    if (this.#teamsLocked) {
      return this.#reject(rejection('WRONG_STATE', 'Teams are locked.'));
    }

    const playerId = readString(intent.payload, 'playerId');
    const teamId = readString(intent.payload, 'teamId');
    if (playerId === null || teamId === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing playerId or teamId.'));
    }

    const player = this.#players.get(playerId);
    if (player === undefined) {
      return this.#reject(rejection('NOT_FOUND', 'Player not found.', { playerId }));
    }

    const legal = teamsForMode(this.#teamMode) as readonly string[];
    if (!legal.includes(teamId)) {
      return this.#reject(
        rejection('ILLEGAL_ACTION', 'That team is not in play.', { teamId, teamMode: this.#teamMode }),
      );
    }

    if (player.teamId === teamId) {
      return { ack: ok({ seq: this.#log.latestSeq() }), broadcast: [], direct: [], closeConnections: [] };
    }

    // A player belongs to at most one team (spec §10). Assignment REPLACES;
    // there is no add-to-team operation that could leave someone on two.
    this.#players.set(playerId, { ...player, teamId: asTeamId(teamId) });
    this.#touch();

    const event = this.#log.append(
      ROOM_EVENTS.TEAM_ASSIGNMENT_CHANGED,
      { kind: 'host', sessionId: '' as never },
      {
        playerId,
        teamId,
        previousTeamId: player.teamId,
        teams: this.#teamStates(),
        room: this.#roomState(),
      },
      intent.intentId,
    );

    return { ack: ok({ seq: event.seq }), broadcast: [event], direct: [], closeConnections: [] };
  }

  #unassign(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    if (this.#teamsLocked) {
      return this.#reject(rejection('WRONG_STATE', 'Teams are locked.'));
    }

    const playerId = readString(intent.payload, 'playerId');
    if (playerId === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing playerId.'));
    }

    const player = this.#players.get(playerId);
    if (player === undefined) {
      return this.#reject(rejection('NOT_FOUND', 'Player not found.', { playerId }));
    }
    if (player.teamId === null) {
      return { ack: ok({ seq: this.#log.latestSeq() }), broadcast: [], direct: [], closeConnections: [] };
    }

    const previousTeamId = player.teamId;
    this.#players.set(playerId, { ...player, teamId: null });
    this.#touch();

    const event = this.#log.append(
      ROOM_EVENTS.TEAM_ASSIGNMENT_CHANGED,
      { kind: 'host', sessionId: '' as never },
      { playerId, teamId: null, previousTeamId, teams: this.#teamStates(), room: this.#roomState() },
      intent.intentId,
    );

    return { ack: ok({ seq: event.seq }), broadcast: [event], direct: [], closeConnections: [] };
  }

  #removePlayer(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const playerId = readString(intent.payload, 'playerId');
    if (playerId === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing playerId.'));
    }

    const player = this.#players.get(playerId);
    if (player === undefined) {
      return this.#reject(rejection('NOT_FOUND', 'Player not found.', { playerId }));
    }

    // Same mechanism as LEAVE_ROOM: deleting the record destroys the credential,
    // so a removed player cannot reconnect their way back in.
    const removedConnection = player.connectionId;
    this.#players.delete(playerId);
    if (removedConnection !== null) this.#connectionRoles.delete(removedConnection);
    // Keep the game's rosters in step. A removed player must not stay named as
    // active or as the turn holder, or the game would wait on someone who is
    // gone — and a disconnect from their dead socket must not pause anything.
    this.#game.removeMember(playerId as PlayerId);
    this.#touch();

    const event = this.#log.append(
      ROOM_EVENTS.PLAYER_REMOVED,
      { kind: 'host', sessionId: '' as never },
      {
        playerId,
        displayName: player.displayName,
        teams: this.#teamStates(),
        room: this.#roomState(),
      },
      intent.intentId,
    );

    const direct =
      removedConnection === null
        ? []
        : [
            {
              connectionId: removedConnection,
              event: this.#log.buildTransient(ROOM_EVENTS.PLAYER_REMOVED, { kind: 'server' }, {
                playerId,
                reason: 'The Host removed you from this room.',
                self: true,
              }),
            },
          ];

    return {
      ack: ok({ seq: event.seq }),
      broadcast: [event],
      direct,
      closeConnections: removedConnection === null ? [] : [removedConnection],
    };
  }

  #lockTeams(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    if (this.#teamsLocked) {
      return this.#reject(rejection('WRONG_STATE', 'Teams are already locked.'));
    }

    // Phase 4 spec §14 — reject if a participating team has no players.
    // Note what is NOT checked: team SIZES. The spec is explicit that uneven
    // teams are acceptable, and no locked rule requires balance, so requiring it
    // would be inventing a rule.
    const empty = this.#teamStates().filter((team) => team.memberIds.length === 0);
    if (empty.length > 0) {
      return this.#reject(
        rejection('ILLEGAL_ACTION', 'Every team needs at least one player.', {
          emptyTeams: empty.map((t) => t.teamId).join(','),
        }),
      );
    }

    this.#teamsLocked = true;
    this.#status = 'LOCKED';
    this.#touch();

    const event = this.#log.append(
      ROOM_EVENTS.TEAMS_LOCKED,
      { kind: 'host', sessionId: '' as never },
      { teams: this.#teamStates(), room: this.#roomState() },
      intent.intentId,
    );

    return { ack: ok({ seq: event.seq }), broadcast: [event], direct: [], closeConnections: [] };
  }

  /**
   * Unlock teams.
   *
   * Not in the spec's intent list, but TEAM_LOCK -> LOBBY is already a legal
   * phase transition (lifecycle.ts) for exactly this reason: the Host notices a
   * wrong team before starting. Without it, one misclick would strand a room
   * with no recovery short of restarting the server.
   */
  #unlockTeams(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    if (!this.#teamsLocked) {
      return this.#reject(rejection('WRONG_STATE', 'Teams are not locked.'));
    }

    this.#teamsLocked = false;
    this.#status = 'OPEN';
    this.#touch();

    const event = this.#log.append(
      ROOM_EVENTS.TEAMS_UNLOCKED,
      { kind: 'host', sessionId: '' as never },
      { teams: this.#teamStates(), room: this.#roomState() },
      intent.intentId,
    );

    return { ack: ok({ seq: event.seq }), broadcast: [event], direct: [], closeConnections: [] };
  }

  #closeRoom(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    if (this.#status === 'CLOSED') {
      return this.#reject(rejection('WRONG_STATE', 'This room is already closed.'));
    }

    this.#status = 'CLOSED';
    this.#touch();

    const event = this.#log.append(
      ROOM_EVENTS.ROOM_CLOSED,
      { kind: 'host', sessionId: '' as never },
      { roomCode: this.#options.roomCode, room: this.#roomState() },
      intent.intentId,
    );

    return { ack: ok({ seq: event.seq }), broadcast: [event], direct: [], closeConnections: [] };
  }

  // -------------------------------------------------------------------------
  // Phase 5 — gameplay
  //
  // Every handler here is Host-only and goes through the same #requireHost gate
  // as the lobby's. A player client has no route to any of them, which is what
  // Phase 5 spec §15 requires: a phone must not be able to send "correct=true"
  // and have the server believe it.
  // -------------------------------------------------------------------------

  /**
   * Start the game.
   *
   * PRECONDITIONS (Phase 5 spec §1): the room exists, is not closed, teams are
   * locked, every participating team has players, and no game has started.
   *
   * Teams must be LOCKED. Starting with an open roster would mean a player
   * joining mid-game with no rule for what they receive — and no locked rule
   * says. The Host locks deliberately first.
   */
  #startGame(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    if (this.#status === 'CLOSED') {
      return this.#reject(rejection('WRONG_STATE', 'This room has closed.'));
    }
    if (!this.#teamsLocked) {
      return this.#reject(
        rejection('WRONG_STATE', 'Lock the teams before starting the game.', {
          teamsLocked: false,
        }),
      );
    }
    if (this.#game.started) {
      return this.#reject(rejection('WRONG_STATE', 'The game has already started.'));
    }

    // Re-checked even though locking already required it: unlocking and
    // relocking is possible, and a game must never start with an empty team.
    const teams = this.#teamStates();
    const empty = teams.filter((team) => team.memberIds.length === 0);
    if (empty.length > 0) {
      return this.#reject(
        rejection('ILLEGAL_ACTION', 'Every team needs at least one player.', {
          emptyTeams: empty.map((t) => t.teamId).join(','),
        }),
      );
    }

    const starting: StartingTeam[] = teams.map((team) => ({
      teamId: team.teamId,
      displayName: team.displayName,
      memberIds: team.memberIds,
    }));

    const outcome = this.#game.startGame(starting);
    if (!outcome.ok) return this.#reject(outcome.error);

    this.#touch();
    const event = this.#log.append(
      outcome.value.type,
      { kind: 'host', sessionId: '' as never },
      outcome.value.payload,
      intent.intentId,
    );

    // The starting balances were seeded through the ledger; link those entries
    // to the event that announced them.
    for (const entry of this.#game.ledgerEntries) {
      if (entry.seq === null) this.#game.attachLedgerSeq(entry.entryId, event.seq);
    }

    const events = [event];

    // ============ ROUND 1 IS PART OF THE REAL PROGRESSION ============
    // Phase 7C spec §18 — "Integrate Round 1 into the actual production game
    // progression. Do not leave it only as a DEV entry point."
    //
    // START_GAME already enters ROUND_INTRO at roundIndex 1, so Round 1 begins
    // HERE rather than waiting for a Host button. The round opens in its
    // `nominating` phase, which is exactly what §11 requires before any question
    // is asked. DEV_START_ROUND1 remains for isolated testing.
    //
    // A content problem refuses the ROUND, not the game: the Host is told, and
    // the lobby is still standing.
    const began = this.#beginRound1();
    if (began.ok) {
      events.push(
        this.#log.append(
          began.value.type,
          { kind: 'server' },
          began.value.payload,
        ),
      );
    }

    const last = events[events.length - 1];
    return {
      ack: ok({ seq: last === undefined ? event.seq : last.seq }),
      broadcast: events,
      direct: [],
      closeConnections: [],
    };
  }

  /**
   * Run a Host-authorised engine action that needs no payload.
   *
   * The engine owns the decision and returns either an event to publish or a
   * structured rejection; this only supplies authority and delivery.
   */
  #engineAction(
    connectionId: string,
    intent: IntentEnvelope,
    action: () => Result<EngineChange>,
  ): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const outcome = action();
    if (!outcome.ok) return this.#reject(outcome.error);

    return this.#publish(outcome.value, intent);
  }

  #publish(change: EngineChange, intent: IntentEnvelope): RoomOutcome {
    this.#touch();
    const event = this.#log.append(
      change.type,
      { kind: 'host', sessionId: '' as never },
      change.payload,
      intent.intentId,
    );
    return { ack: ok({ seq: event.seq }), broadcast: [event], direct: [], closeConnections: [] };
  }

  #advancePhase(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const to = readString(intent.payload, 'to');
    if (to === null || !isGamePhase(to)) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing or unknown target phase.'));
    }

    const outcome = this.#game.advancePhase(to);
    if (!outcome.ok) return this.#reject(outcome.error);

    return this.#publish(outcome.value, intent);
  }

  #prepareChallenge(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const challengeType = readString(intent.payload, 'challengeType');
    if (challengeType === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing challengeType.'));
    }

    // configRef is an opaque pointer to configuration, never content.
    // CONTENT_POLICY.md — question text and accepted answers must never travel
    // to a client, and a snapshot carrying this reference carries no content.
    const outcome = this.#game.prepareChallenge({
      challengeType,
      configRef: readString(intent.payload, 'configRef'),
    });
    if (!outcome.ok) return this.#reject(outcome.error);

    return this.#publish(outcome.value, intent);
  }

  #setTurn(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const teamIdRaw = readString(intent.payload, 'teamId');
    const playerIdRaw = readString(intent.payload, 'playerId');

    const outcome = this.#game.setTurn({
      teamId: teamIdRaw === null ? null : asTeamId(teamIdRaw),
      playerId: playerIdRaw === null ? null : (playerIdRaw as PlayerId),
    });
    if (!outcome.ok) return this.#reject(outcome.error);

    return this.#publish(outcome.value, intent);
  }

  #setActivePlayers(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const raw = readField(intent.payload, 'playerIds');
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || id === '')) {
      return this.#reject(rejection('INVALID_REQUEST', 'playerIds must be an array of ids.'));
    }

    const outcome = this.#game.setActivePlayers(raw as PlayerId[]);
    if (!outcome.ok) return this.#reject(outcome.error);

    return this.#publish(outcome.value, intent);
  }

  #startTimer(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const durationMs = readField(intent.payload, 'durationMs');
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
      return this.#reject(rejection('INVALID_REQUEST', 'durationMs must be a positive number.'));
    }

    const outcome = this.#game.startTimer(durationMs);
    if (!outcome.ok) return this.#reject(outcome.error);

    return this.#publish(outcome.value, intent);
  }

  /**
   * Record a Host ruling.
   *
   * The ruling's sequence number is needed to build it, but the number is only
   * assigned when the event is appended — so the event is appended first with
   * the ruling's own details, and the ruling is recorded against that number.
   * The engine validates before anything is written, so an invalid ruling never
   * reaches the log.
   */
  #hostRuling(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const kindRaw = readString(intent.payload, 'kind');
    if (kindRaw === null || !isHostRulingKind(kindRaw)) {
      return this.#reject(
        rejection('INVALID_REQUEST', 'Unknown ruling kind.', { kind: kindRaw ?? '' }),
      );
    }

    const teamIdRaw = readString(intent.payload, 'teamId');
    const playerIdRaw = readString(intent.payload, 'playerId');
    const note = readString(intent.payload, 'note');

    const nextSeq = asSequenceNumber(this.#log.latestSeq() + 1);
    const outcome = this.#game.recordRuling({
      kind: kindRaw,
      teamId: teamIdRaw === null ? null : asTeamId(teamIdRaw),
      playerId: playerIdRaw === null ? null : (playerIdRaw as PlayerId),
      note,
      seq: nextSeq,
    });
    if (!outcome.ok) return this.#reject(outcome.error);

    this.#touch();
    const event = this.#log.append(
      GAME_EVENTS.HOST_RULING_RECORDED,
      { kind: 'host', sessionId: '' as never },
      { ruling: outcome.value, challenge: this.#game.challengeView() },
      intent.intentId,
    );

    return { ack: ok({ seq: event.seq }), broadcast: [event], direct: [], closeConnections: [] };
  }

  #resolveChallenge(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const winningTeamIds = readStringArray(intent.payload, 'winningTeamIds');
    if (winningTeamIds === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'winningTeamIds must be an array of ids.'));
    }
    const winningPlayerIds = readStringArray(intent.payload, 'winningPlayerIds');
    if (winningPlayerIds === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'winningPlayerIds must be an array of ids.'));
    }

    const bbDeltas = readNumberMap(intent.payload, 'bbDeltas');
    if (bbDeltas === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'bbDeltas must map team ids to numbers.'));
    }

    const outcome = this.#game.resolveChallenge({
      winningTeamIds: winningTeamIds as TeamId[],
      winningPlayerIds: winningPlayerIds as PlayerId[],
      bbDeltas,
      decidedByHost: true,
      note: readString(intent.payload, 'note'),
    });
    if (!outcome.ok) return this.#reject(outcome.error);

    this.#touch();
    const event = this.#log.append(
      outcome.value.change.type,
      { kind: 'host', sessionId: '' as never },
      outcome.value.change.payload,
      intent.intentId,
    );

    for (const entry of outcome.value.ledgerEntries) {
      this.#game.attachLedgerSeq(entry.entryId, event.seq);
    }

    return { ack: ok({ seq: event.seq }), broadcast: [event], direct: [], closeConnections: [] };
  }

  /**
   * Resume.
   *
   * Host-only twice over: once at this gate, and again inside the engine's
   * transition, which refuses any actor that is not the Host. The redundancy is
   * deliberate — D-011 is the rule most likely to be bypassed by accident from a
   * future call site.
   */
  #resumeGame(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const outcome = this.#game.resume(true);
    if (!outcome.ok) return this.#reject(outcome.error);

    return this.#publish(outcome.value, intent);
  }

  /**
   * DEVELOPMENT ONLY — adjust a team's BB directly.
   *
   * Phase 5 spec §17 asks for a harness that can prove the ledger and the floor
   * before any round exists. Refused outright unless the server was started
   * with development tools enabled, and every entry it writes is stamped
   * `dev_adjustment`, so a test award can never be mistaken for earned BB.
   */
  #devAdjustBb(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    if (!this.#game.devTools) {
      return this.#reject(
        rejection('ILLEGAL_ACTION', 'Development controls are disabled on this server.'),
      );
    }

    const teamId = readString(intent.payload, 'teamId');
    const delta = readField(intent.payload, 'delta');
    if (teamId === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing teamId.'));
    }
    if (typeof delta !== 'number' || !Number.isFinite(delta)) {
      return this.#reject(rejection('INVALID_REQUEST', 'delta must be a finite number.'));
    }

    const outcome = this.#game.adjustBb({
      teamId: asTeamId(teamId),
      delta,
      reason: 'dev_adjustment',
      note: readString(intent.payload, 'note'),
    });
    if (!outcome.ok) return this.#reject(outcome.error);

    this.#touch();
    const event = this.#log.append(
      outcome.value.change.type,
      { kind: 'host', sessionId: '' as never },
      outcome.value.change.payload,
      intent.intentId,
    );
    this.#game.attachLedgerSeq(outcome.value.entry.entryId, event.seq);

    return { ack: ok({ seq: event.seq }), broadcast: [event], direct: [], closeConnections: [] };
  }

  // -------------------------------------------------------------------------
  // Phase 6 — shared systems
  //
  // Two authority models here, and the difference is deliberate. Host intents
  // use the same #requireHost gate as everything in Phase 5. PLAYER intents use
  // #requireTeam, which resolves the acting team FROM THE CONNECTION rather
  // than from the payload — so a phone cannot spend another team's BB or play
  // another team's card by naming them, because no handler reads a teamId a
  // client supplied.
  // -------------------------------------------------------------------------

  /**
   * Resolve the team a player connection acts for.
   *
   * THE TEAM IS NEVER TAKEN FROM THE PAYLOAD. That is the whole protection:
   * authority comes from the verified identity on the socket, exactly as
   * #requireHost takes nothing from the intent either.
   */
  #requireTeam(connectionId: string): Result<TeamId> {
    const role = this.roleOf(connectionId);
    if (role.kind !== 'player') {
      return err(rejection('UNAUTHORIZED_ACTOR', 'Only a joined player can do that.'));
    }
    const player = this.#players.get(role.playerId);
    if (player === undefined) {
      return err(rejection('NOT_FOUND', 'Player not found.'));
    }
    if (player.teamId === null) {
      return err(rejection('ILLEGAL_ACTION', 'You are not on a team.'));
    }
    return ok(player.teamId);
  }

  #openCardWindow(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const challengeKind = readString(intent.payload, 'challengeKind');
    if (challengeKind === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing challengeKind.'));
    }

    const outcome = this.#game.openCardWindow(challengeKind);
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publish(outcome.value, intent);
  }

  #openMarket(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const round = readField(intent.payload, 'round');
    if (typeof round !== 'number') {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing round.'));
    }

    const outcome = this.#game.openMarket(round);
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publish(outcome.value, intent);
  }

  #drawMacoMail(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const teamId = readString(intent.payload, 'teamId');
    if (teamId === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing teamId.'));
    }

    // Whether a future challenge or Market remains is the CALLER's to state —
    // Phase 6 spec §34 forbids the engine deciding which challenges count.
    const answerer = readField(intent.payload, 'eligibleAnswererChallengeRemains');
    const market = readField(intent.payload, 'futureMarketRemains');

    const outcome = this.#game.drawMacoMail({
      teamId: asTeamId(teamId),
      ...(typeof answerer === 'boolean' ? { eligibleAnswererChallengeRemains: answerer } : {}),
      ...(typeof market === 'boolean' ? { futureMarketRemains: market } : {}),
    });
    if (!outcome.ok) return this.#reject(outcome.error);

    return this.#publishWithLedger(outcome.value, intent);
  }

  #offerHostDeal(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const template = readString(intent.payload, 'template');
    const teamId = readString(intent.payload, 'teamId');
    if (template === null || teamId === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing template or teamId.'));
    }
    const opponent = readString(intent.payload, 'opponentTeamId');

    // NO AMOUNT IS READ. GAME_RULES_LOCKED.md §9 — deal mathematics come from
    // server-side templates, never from the Host client.
    const outcome = this.#game.offerHostDeal({
      template,
      teamId: asTeamId(teamId),
      opponentTeamId: opponent === null ? null : asTeamId(opponent),
    });
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publish(outcome.value, intent);
  }

  #resolveWager(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const wagerId = readString(intent.payload, 'wagerId');
    const won = readField(intent.payload, 'won');
    if (wagerId === null || typeof won !== 'boolean') {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing wagerId or won.'));
    }

    const outcome = this.#game.resolveWager({ wagerId, won });
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publishWithLedger(outcome.value, intent);
  }

  #playBacchanalCard(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const team = this.#requireTeam(connectionId);
    if (!team.ok) return this.#reject(team.error);

    const cardInstanceId = readString(intent.payload, 'cardInstanceId');
    if (cardInstanceId === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing cardInstanceId.'));
    }
    const target = readString(intent.payload, 'targetTeamId');

    const outcome = this.#game.playBacchanalCard({
      teamId: team.value,
      cardInstanceId,
      targetTeamId: target === null ? null : asTeamId(target),
    });
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publish(outcome.value, intent);
  }

  /**
   * A team's secret Clash counter.
   *
   * The acknowledgement carries the team's own view back so the phone can show
   * its locked choice; the BROADCAST carries only that a response arrived.
   * Phase 6 spec §42.
   */
  #respondToClash(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const team = this.#requireTeam(connectionId);
    if (!team.ok) return this.#reject(team.error);

    const cardInstanceId = readString(intent.payload, 'cardInstanceId');
    if (cardInstanceId === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing cardInstanceId.'));
    }
    const target = readString(intent.payload, 'targetTeamId');

    const outcome = this.#game.respondToClash({
      teamId: team.value,
      cardInstanceId,
      targetTeamId: target === null ? null : asTeamId(target),
    });
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publish(outcome.value, intent);
  }

  /**
   * A Market purchase.
   *
   * The item reaches the BUYER in the acknowledgement and everyone else only at
   * MARKET_CLOSED — §10's hidden shopping, enforced by what each channel
   * carries rather than by a client choosing not to look.
   */
  #purchaseMarketItem(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const team = this.#requireTeam(connectionId);
    if (!team.ok) return this.#reject(team.error);

    const item = readString(intent.payload, 'item');
    if (item === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing item.'));
    }

    const outcome = this.#game.purchaseMarketItem({ teamId: team.value, item });
    if (!outcome.ok) return this.#reject(outcome.error);

    this.#touch();
    const event = this.#log.append(
      outcome.value.type,
      { kind: 'player', sessionId: '' as never, playerId: '' as never },
      outcome.value.payload,
      intent.intentId,
    );

    return {
      // Only the buyer learns what was bought, and only in their own reply.
      ack: ok({ seq: event.seq, payload: this.#game.shared.market.teamView(team.value) }),
      broadcast: [event],
      direct: [],
      closeConnections: [],
    };
  }

  /**
   * A team removes its OWN unrevealed item from its cart.
   *
   * The grocery-cart reading of §10 — "purchases are final" describes
   * checkout (the Market closing), not every tap before it. `#requireTeam`
   * resolves who is asking from the CONNECTION exactly as `#purchaseMarketItem`
   * does; the engine then checks that team actually owns the purchaseId given,
   * so a phone cannot withdraw an opponent's item by guessing its id.
   */
  #withdrawMarketPurchase(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const team = this.#requireTeam(connectionId);
    if (!team.ok) return this.#reject(team.error);

    const purchaseId = readString(intent.payload, 'purchaseId');
    if (purchaseId === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing purchaseId.'));
    }

    const outcome = this.#game.withdrawMarketPurchase({ teamId: team.value, purchaseId });
    if (!outcome.ok) return this.#reject(outcome.error);

    this.#touch();
    const event = this.#log.append(
      outcome.value.type,
      { kind: 'player', sessionId: '' as never, playerId: '' as never },
      outcome.value.payload,
      intent.intentId,
    );

    return {
      // Same secrecy shape as a purchase: the withdrawing team learns its own
      // updated cart, and the broadcast names WHO acted, never WHAT.
      ack: ok({ seq: event.seq, payload: this.#game.shared.market.teamView(team.value) }),
      broadcast: [event],
      direct: [],
      closeConnections: [],
    };
  }

  #useAdvantage(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const team = this.#requireTeam(connectionId);
    if (!team.ok) return this.#reject(team.error);

    const advantageId = readString(intent.payload, 'advantageId');
    if (advantageId === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing advantageId.'));
    }

    const outcome = this.#game.useAdvantage({ teamId: team.value, advantageId });
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publish(outcome.value, intent);
  }

  #respondToHostDeal(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const team = this.#requireTeam(connectionId);
    if (!team.ok) return this.#reject(team.error);

    const dealId = readString(intent.payload, 'dealId');
    const choice = readString(intent.payload, 'choice');
    if (dealId === null || choice === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing dealId or choice.'));
    }

    const outcome = this.#game.respondToHostDeal({ dealId, teamId: team.value, choice });
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publishWithLedger(outcome.value, intent);
  }

  #proposeWager(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const team = this.#requireTeam(connectionId);
    if (!team.ok) return this.#reject(team.error);

    const amount = readField(intent.payload, 'amount');
    if (typeof amount !== 'number') {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing amount.'));
    }

    const outcome = this.#game.proposeWager({
      teamId: team.value,
      amount,
      contextRef: readString(intent.payload, 'contextRef'),
    });
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publish(outcome.value, intent);
  }

  // -------------------------------------------------------------------------
  // Phase 7A — Round 2
  //
  // Three Host intents and one development entry. Everything else Round 2 needs
  // — starting the challenge, opening the card window, the Market, playing a
  // card, pausing, the snapshot read — is a Phase 5 or Phase 6 intent that
  // already exists and is not restated (Phase 7A spec §26).
  // -------------------------------------------------------------------------

  /**
   * Host selects a winning team. Step one of two; moves no BB.
   *
   * The teamId IS read from the payload here, and that is correct: the Host is
   * nominating someone else, not acting as themselves. The protection is the
   * #requireHost gate plus full server-side validation of the team — it must
   * exist and be taking part (Phase 7A spec §13). This is the opposite case to
   * a player intent, where reading a teamId from the payload would let a phone
   * act as another team.
   */
  #selectRound2Winner(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const teamId = readString(intent.payload, 'teamId');
    if (teamId === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing teamId.'));
    }

    const outcome = this.#game.selectRound2Winner(asTeamId(teamId));
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publish(outcome.value, intent);
  }

  /**
   * Host confirms the result. Step two; THIS PAYS.
   *
   * NO AMOUNT IS READ FROM THE PAYLOAD, and that is the whole point. The server
   * takes the base reward from Round 2's configuration and the multiplier from
   * the shared systems, so a Host client sending `awardedBb: 99999` changes
   * nothing — there is no handler that would look at it. Same discipline as the
   * Host Deal, where GAME_RULES_LOCKED.md §9 forbids improvised maths.
   *
   * `teamId` is optional: normally the Host confirms what was selected. Naming
   * one confirms that team instead, and it goes through the same validation.
   */
  #confirmRound2Result(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const teamId = readString(intent.payload, 'teamId');

    const outcome = this.#game.confirmRound2Result(
      teamId === null ? {} : { winningTeamId: asTeamId(teamId) },
    );
    if (!outcome.ok) return this.#reject(outcome.error);

    this.#touch();
    const event = this.#log.append(
      outcome.value.change.type,
      { kind: 'host', sessionId: '' as never },
      outcome.value.change.payload,
      intent.intentId,
    );

    for (const entry of outcome.value.ledgerEntries) {
      this.#game.attachLedgerSeq(entry.entryId, event.seq);
    }

    return { ack: ok({ seq: event.seq }), broadcast: [event], direct: [], closeConnections: [] };
  }

  /**
   * DEVELOPMENT ONLY — enter Round 2 without playing Round 1.
   *
   * WHY THIS EXISTS AT ALL: Round 1 is not implemented (Phase 7A §4), so there
   * is no legitimate way for a real game to arrive at Round 2. The spec is
   * explicit that inventing one would be worse — "DO NOT invent a production
   * rule that allows normal games to skip Round 1" — so this is gated on the
   * same server flag as DEV_ADJUST_BB (D-024) and cannot run in production.
   *
   * IT DOES NOT SHORTCUT THE ENGINE. It walks the REAL phase transitions
   * (ROUND_INTRO for round 1, then ROUND_INTRO again, which is what increments
   * the round counter and expires last round's Market items) and then enters
   * Round 2 through the same `beginRound2` the eventual Round 1 completion will
   * call. So what it exercises is the real flow, minus Round 1's content.
   */
  #devStartRound2(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    if (!this.#game.devTools) {
      return this.#reject(
        rejection('ILLEGAL_ACTION', 'Development controls are disabled on this server.'),
      );
    }

    const outcome = this.#game.devEnterRound2();
    if (!outcome.ok) return this.#reject(outcome.error);

    this.#touch();
    // Several phase changes happen on the way to Round 2, and each is a real
    // state change clients must be able to order. They are appended as separate
    // events rather than summarised, so a reconnecting client replaying from a
    // sequence number sees the same history as one that was present.
    const events = outcome.value.map((change) =>
      this.#log.append(
        change.type,
        { kind: 'host', sessionId: '' as never },
        change.payload,
        // Only the first carries the intent id: deduplication keys on it, and
        // two events claiming the same intent would make a retry ambiguous.
        change === outcome.value[0] ? intent.intentId : undefined,
      ),
    );

    const last = events[events.length - 1];
    return {
      ack: ok({ seq: last === undefined ? this.#log.latestSeq() : last.seq }),
      broadcast: events,
      direct: [],
      closeConnections: [],
    };
  }


  // -------------------------------------------------------------------------
  // Phase 7B — Round 3
  //
  // Host-gated except SUBMIT_RPS_CHOICE, which is a player intent because a
  // team chooses its own rock, paper or scissors. Everything else — awarding a
  // point, judging an answer, revealing an item, confirming a winner — is
  // subjective Host authority (§14-§17), so a phone has no route to it.
  // -------------------------------------------------------------------------

  /**
   * Start the prepared challenge.
   *
   * Wraps the generic engine action so a Round 3 challenge with ONE topic
   * (Think Fast, §14) gets that topic revealed automatically. There is no
   * "next item" in Think Fast for the Host to press, so leaving it to a Host
   * intent left the challenge unplayable — the bug this method exists to fix.
   *
   * Every other challenge is unaffected: a stream challenge reveals nothing
   * here and the Host advances with NEXT ITEM as before.
   */
  #startChallenge(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const started = this.#engineAction(connectionId, intent, () =>
      this.#game.startChallenge(),
    );
    if (!started.ack.ok) return started;

    if (!this.#game.round3NeedsOpeningItem()) return started;

    const current = this.#game.round3?.view().current;
    if (current === undefined || current === null) return started;

    const item = this.#content.nextItem(current.challengeType);
    if (item === null) return started;

    const revealed = this.#game.revealRound3Item(item);
    if (!revealed.ok) return started;

    // Appended as its own event, so a client can order "the challenge started"
    // against "the topic appeared" rather than inferring one from the other.
    const event = this.#log.append(
      revealed.value.type,
      { kind: 'host', sessionId: '' as never },
      revealed.value.payload,
    );

    return {
      ack: ok({ seq: event.seq }),
      broadcast: [...started.broadcast, event],
      direct: started.direct,
      closeConnections: started.closeConnections,
    };
  }

  /**
   * Reveal the next Round 3 content item.
   *
   * THE ITEM COMES FROM THE CONTENT SOURCE, not from the Host's payload. §13 —
   * the game supplies challenge content and the Host does not invent it. So
   * this handler reads no prompt, letter or image from the intent; it asks the
   * room's content source for the next item of the running challenge.
   */
  #nextRound3Item(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const round = this.#game.round3;
    if (round === null) {
      return this.#reject(rejection('WRONG_STATE', 'Round 3 has not started.'));
    }
    const current = round.view().current;
    if (current === null) {
      return this.#reject(rejection('WRONG_STATE', 'No Round 3 challenge is running.'));
    }

    const item = this.#content.nextItem(current.challengeType);
    if (item === null) {
      return this.#reject(
        rejection('NOT_FOUND', 'The content source has no more items for this challenge.', {
          challengeType: current.challengeType,
        }),
      );
    }

    const outcome = this.#game.revealRound3Item(item);
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publish(outcome.value, intent);
  }

  /** Host awards one challenge point. Points, never BB. */
  #awardRound3Point(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const teamId = readString(intent.payload, 'teamId');
    if (teamId === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing teamId.'));
    }

    const outcome = this.#game.awardRound3Point(asTeamId(teamId));
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publish(outcome.value, intent);
  }

  /**
   * Host confirms the Round 3 challenge winner.
   *
   * NO AMOUNT IS READ FROM THE PAYLOAD. The server takes the reward from
   * configuration — 500 for Think Fast and Sing a Song, 0 for the other two —
   * and the multiplier from the shared systems.
   */
  #confirmRound3Challenge(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const teamId = readString(intent.payload, 'teamId');
    if (teamId === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing teamId.'));
    }

    const outcome = this.#game.confirmRound3Challenge(asTeamId(teamId));
    if (!outcome.ok) return this.#reject(outcome.error);

    this.#touch();
    const event = this.#log.append(
      outcome.value.change.type,
      { kind: 'host', sessionId: '' as never },
      outcome.value.change.payload,
      intent.intentId,
    );
    for (const entry of outcome.value.ledgerEntries) {
      this.#game.attachLedgerSeq(entry.entryId, event.seq);
    }

    const events = [event];

    // The fourth challenge decides the round. Appended as its own event rather
    // than folded into the resolution, so a client can order "the challenge
    // ended" against "the round was won" — and so a tiebreaker starting is its
    // own fact.
    if (this.#game.round3?.complete === true) {
      const decided = this.#game.decideRound3Winner();
      if (decided.ok) {
        events.push(
          this.#log.append(
            decided.value.type,
            { kind: 'host', sessionId: '' as never },
            decided.value.payload,
          ),
        );
      }
    }

    const last = events[events.length - 1];
    return {
      ack: ok({ seq: last === undefined ? event.seq : last.seq }),
      broadcast: events,
      direct: [],
      closeConnections: [],
    };
  }

  /**
   * A tied team locks its rock-paper-scissors choice. PLAYER intent.
   *
   * THE TEAM COMES FROM THE CONNECTION, never the payload — the same protection
   * every Phase 6 player intent uses. A phone cannot choose for another team by
   * naming it, because no handler here reads a client-supplied teamId.
   *
   * The choice is echoed back only in this team's OWN acknowledgement; the
   * broadcast says who chose, never what. §18.
   */
  #submitRpsChoice(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const team = this.#requireTeam(connectionId);
    if (!team.ok) return this.#reject(team.error);

    const choice = readString(intent.payload, 'choice');
    if (choice === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing choice.'));
    }

    const outcome = this.#game.submitRpsChoice({ teamId: team.value, choice });
    if (!outcome.ok) return this.#reject(outcome.error);

    return this.#publish(outcome.value, intent);
  }

  /**
   * DEVELOPMENT ONLY — enter Round 3 without playing Rounds 1 and 2.
   *
   * Same gate and the same discipline as `DEV_START_ROUND2` (D-024): it walks
   * the real transitions and calls the same `beginRound3` a real Round 2
   * completion will.
   */
  #devStartRound3(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    if (!this.#game.devTools) {
      return this.#reject(
        rejection('ILLEGAL_ACTION', 'Development controls are disabled on this server.'),
      );
    }

    const outcome = this.#game.devEnterRound3();
    if (!outcome.ok) return this.#reject(outcome.error);

    this.#touch();
    const events = outcome.value.map((change) =>
      this.#log.append(
        change.type,
        { kind: 'host', sessionId: '' as never },
        change.payload,
        change === outcome.value[0] ? intent.intentId : undefined,
      ),
    );

    const last = events[events.length - 1];
    return {
      ack: ok({ seq: last === undefined ? this.#log.latestSeq() : last.seq }),
      broadcast: events,
      direct: [],
      closeConnections: [],
    };
  }

  // -------------------------------------------------------------------------
  // Round 1. Phase 7C. GAME_RULES_LOCKED.md §11, D-030, D-032.
  // -------------------------------------------------------------------------

  /**
   * Nominate a team's answerer for one difficulty. §11.
   *
   * A PLAYER intent, and the team comes from the CONNECTION — a phone cannot
   * nominate for another team by naming it. The Host may also nominate on a
   * team's behalf, which is how a table with one shared phone gets set up.
   */
  #nominateAnswerer(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const difficulty = readString(intent.payload, 'difficulty');
    if (difficulty === null || !isRound1Difficulty(difficulty)) {
      return this.#reject(
        rejection('INVALID_REQUEST', 'Missing or unknown difficulty.', {
          difficulty: difficulty ?? 'none',
        }),
      );
    }

    const role = this.roleOf(connectionId);

    // The Host nominates by naming both the team and the player.
    if (role.kind === 'host') {
      const teamId = readString(intent.payload, 'teamId');
      const playerId = readString(intent.payload, 'playerId');
      if (teamId === null || playerId === null) {
        return this.#reject(
          rejection('INVALID_REQUEST', 'The Host must name a team and a player.'),
        );
      }
      const outcome = this.#game.nominateRound1Answerer({
        teamId: asTeamId(teamId),
        difficulty,
        playerId: asPlayerId(playerId),
      });
      if (!outcome.ok) return this.#reject(outcome.error);
      return this.#publish(outcome.value, intent);
    }

    const team = this.#requireTeam(connectionId);
    if (!team.ok) return this.#reject(team.error);
    if (role.kind !== 'player') {
      return this.#reject(rejection('UNAUTHORIZED_ACTOR', 'Only a joined player can do that.'));
    }

    // A player may nominate any TEAMMATE, including themselves — teams sort
    // this out at the table. The engine checks membership.
    const named = readString(intent.payload, 'playerId');
    const playerId = named === null ? role.playerId : asPlayerId(named);

    const outcome = this.#game.nominateRound1Answerer({
      teamId: team.value,
      difficulty,
      playerId,
    });
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publish(outcome.value, intent);
  }

  /** Host closes nominations and starts the questions. §11. */
  #startRound1Questions(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const outcome = this.#game.startRound1Questions();
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publish(outcome.value, intent);
  }

  /**
   * Host reveals the next question.
   *
   * The room prepares the engine challenge and the ROOM supplies the content,
   * because only the room holds the content source — the same split Round 3
   * uses.
   */
  #nextRound1Question(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    // ============ THE ROUND DRIVES THE PHASES, NOT THE HOST ============
    // Round 1 asks fifteen questions, and making the Host walk
    // CHALLENGE_INTRO -> ACTIVE_PLAY -> RESULT by hand fifteen times would be
    // fifteen chances to strand the game in the wrong phase mid-party.
    //
    // So ONE Host action advances the phases through the same transition table
    // everything else uses — nothing here assigns a phase directly, and an
    // illegal move is still refused by the state machine.
    // ===================================================================
    const phase = this.#game.sessionView()?.phase ?? null;
    if (phase === 'ROUND_INTRO' || phase === 'RESULT' || phase === 'MARKET') {
      const moved = this.#game.advancePhase('CHALLENGE_INTRO');
      if (!moved.ok) return this.#reject(moved.error);
    }

    const prepared = this.#game.prepareChallenge({
      challengeType: ROUND1_CHALLENGE_TYPE,
    });
    if (!prepared.ok) return this.#reject(prepared.error);

    const events: EventEnvelope[] = [
      this.#log.append(
        prepared.value.type,
        { kind: 'host', sessionId: '' as never },
        prepared.value.payload,
      ),
    ];

    const started = this.#game.startChallenge();
    if (started.ok) {
      events.push(
        this.#log.append(
          started.value.type,
          { kind: 'host', sessionId: '' as never },
          started.value.payload,
        ),
      );
    }

    const challengeId = this.#game.challengeView()?.challengeId ?? null;
    if (challengeId === null) {
      return this.#reject(rejection('WRONG_STATE', 'No challenge to attach the question to.'));
    }

    const revealed = this.#game.revealRound1Question(challengeId);
    if (!revealed.ok) return this.#reject(revealed.error);

    // The card window opens with the question, so Maco!, Double It!, Allyuh
    // Help Me! and Forgive Meh! are legal for exactly this question (§6).
    this.#game.shared.openCardWindow(challengeId, ROUND1_CARD_CHALLENGE_KIND);

    events.push(
      this.#log.append(
        revealed.value.type,
        { kind: 'host', sessionId: '' as never },
        revealed.value.payload,
        intent.intentId,
      ),
    );

    this.#touch();
    const last = events[events.length - 1];
    return {
      ack: ok({ seq: last === undefined ? this.#log.latestSeq() : last.seq }),
      broadcast: events,
      direct: [],
      closeConnections: [],
    };
  }

  /**
   * The nominated player submits their team's answer. PLAYER intent.
   *
   * THE TEAM AND PLAYER BOTH COME FROM THE CONNECTION. Spec §15 — "a
   * non-nominated player must not be able to bypass UI restrictions through the
   * protocol", and the only way to guarantee that is to never read an identity
   * from the payload. The engine then checks that this player is the nominee.
   */
  #submitRound1Answer(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const role = this.roleOf(connectionId);
    if (role.kind !== 'player') {
      return this.#reject(rejection('UNAUTHORIZED_ACTOR', 'Only a joined player can answer.'));
    }
    const team = this.#requireTeam(connectionId);
    if (!team.ok) return this.#reject(team.error);

    const answer = readString(intent.payload, 'answer');
    if (answer === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing answer.'));
    }

    const round = this.#game.round1;
    const inTiebreak = round !== null && round.phase === 'tiebreak';

    const outcome = inTiebreak
      ? this.#game.submitRound1TiebreakAnswer({
          teamId: team.value,
          playerId: role.playerId,
          answer,
        })
      : this.#game.submitRound1Answer({
          teamId: team.value,
          playerId: role.playerId,
          answer,
        });
    if (!outcome.ok) return this.#reject(outcome.error);

    return this.#publish(outcome.value, intent);
  }

  /**
   * MACO! — look at one opponent's already-submitted answer. §11, D-030.
   *
   * ================== WHY THIS IS ITS OWN INTENT ==================
   * PLAY_BACCHANAL_CARD commits the CARD and opens a Clash window on it. This
   * performs the card's EFFECT, once that has resolved. Keeping them separate
   * is what lets a Clash cancel a Maco before it has revealed anything —
   * collapsing them would leak the answer at the moment the card was played,
   * before anyone could counter it.
   *
   * THE VIEWER COMES FROM THE CONNECTION. Only `targetTeamId` is read from the
   * payload, so a phone cannot look on another player's behalf. The engine then
   * checks that this player is their team's nominee for the current difficulty
   * and that the target has actually submitted — §11's guarantee that a
   * half-typed answer is never exposed.
   *
   * The answer text goes back in THIS CONNECTION'S acknowledgement only, and
   * lives in that one player's snapshot until it expires. The broadcast event
   * says a Maco happened and names the target; it never carries the words.
   */
  #viewRound1Maco(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const role = this.roleOf(connectionId);
    if (role.kind !== 'player') {
      return this.#reject(rejection('UNAUTHORIZED_ACTOR', 'Only a joined player can play Maco!.'));
    }
    const team = this.#requireTeam(connectionId);
    if (!team.ok) return this.#reject(team.error);

    const targetTeamId = readString(intent.payload, 'targetTeamId');
    if (targetTeamId === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Name the team to look at.'));
    }

    const granted = this.#game.grantRound1Maco({
      viewingTeamId: team.value,
      viewingPlayerId: role.playerId,
      targetTeamId: asTeamId(targetTeamId),
    });
    if (!granted.ok) return this.#reject(granted.error);

    const published = this.#publish(granted.value, intent);
    if (!published.ack.ok) return published;

    // The acknowledgement carries the answer to the one player entitled to it.
    return {
      ...published,
      ack: ok({
        seq: published.ack.value.seq,
        payload: { maco: this.#game.round1?.view(team.value, role.playerId)?.macoView ?? null },
      }),
    };
  }

  /**
   * Host closes the answer window and grades what came in.
   *
   * Deterministic grading runs INLINE here and decides the overwhelming
   * majority of answers. Anything genuinely ambiguous is queued for the AI
   * judge and resolved on a later tick — see `#pendingJudgements`.
   */
  #closeRound1Question(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const closed = this.#game.closeRound1Question();
    if (!closed.ok) return this.#reject(closed.error);

    const events: EventEnvelope[] = [
      this.#log.append(
        closed.value.type,
        { kind: 'host', sessionId: '' as never },
        closed.value.payload,
        intent.intentId,
      ),
    ];

    events.push(...this.#gradeRound1Pending());

    this.#touch();
    const last = events[events.length - 1];
    return {
      ack: ok({ seq: last === undefined ? this.#log.latestSeq() : last.seq }),
      broadcast: events,
      direct: [],
      closeConnections: [],
    };
  }

  /**
   * Grade every ungraded answer on the current question.
   *
   * Runs the deterministic layers synchronously. An answer they cannot decide
   * is handed to the judge asynchronously and stored in `#pendingJudgements`;
   * until it resolves the answer simply has no ruling, and the Host can rule on
   * it at any time — a Host ruling always wins.
   */
  #gradeRound1Pending(): EventEnvelope[] {
    const events: EventEnvelope[] = [];
    const round = this.#game.round1;
    if (round === null) return events;

    const inTiebreak = round.phase === 'tiebreak';
    const item = inTiebreak ? round.currentTiebreakItem() : round.currentItem();
    if (item === null) return events;

    const pending = inTiebreak
      ? round.pendingTiebreakGrading().map((x) => ({ ...x, isRetry: false }))
      : round.pendingGrading();

    for (const entry of pending) {
      const input = {
        prompt: item.prompt,
        canonicalAnswer: item.canonicalAnswer,
        ...(item.acceptedVariants === undefined
          ? {}
          : { acceptedVariants: item.acceptedVariants }),
        submittedAnswer: entry.answer,
      };

      const deterministic = gradeDeterministic(input);
      if (deterministic !== null) {
        if (inTiebreak) {
          // A tiebreak ruling returns no event of its own; the attempt's
          // resolution is what clients see (spec §12).
          this.#game.round1?.recordTiebreakRuling({
            teamId: entry.teamId,
            verdict: deterministic.verdict,
            source: deterministic.source,
          });
        } else {
          const recorded = this.#game.recordRound1Ruling({
            teamId: entry.teamId,
            verdict: deterministic.verdict,
            source: deterministic.source,
            isRetry: entry.isRetry,
          });
          if (recorded.ok) {
            events.push(
              this.#log.append(recorded.value.type, { kind: 'server' }, recorded.value.payload),
            );
          }
        }
        continue;
      }

      // Genuinely ambiguous. Ask the judge off to the side; the answer lands on
      // a later tick. Nothing blocks, and the Host may rule in the meantime.
      this.#queueJudgement({
        key: `${item.itemId}:${entry.teamId}:${entry.isRetry ? 'retry' : 'first'}`,
        input,
      });
    }

    return events;
  }

  /** Ask the judge for one ambiguous answer, off the synchronous path. */
  #queueJudgement(request: {
    readonly key: string;
    readonly input: {
      readonly prompt: string;
      readonly canonicalAnswer: string;
      readonly acceptedVariants?: readonly string[];
      readonly submittedAnswer: string;
    };
  }): void {
    if (this.#pendingJudgements.has(request.key)) return;

    void this.#judge
      .judge({
        prompt: request.input.prompt,
        canonicalAnswer: request.input.canonicalAnswer,
        acceptedVariants: request.input.acceptedVariants ?? [],
        submittedAnswer: request.input.submittedAnswer,
      })
      .then((result) => {
        this.#pendingJudgements.set(request.key, result.verdict);
      })
      .catch(() => {
        // A judge that fails means NEEDS_HOST_REVIEW, never a guess. Spec §4D.
        this.#pendingJudgements.set(request.key, 'NEEDS_HOST_REVIEW');
      });
  }

  /**
   * Apply any judge verdicts that have come back. Called on the tick.
   *
   * A stored ruling is never overwritten here, so a Host who already ruled
   * while the judge was thinking keeps the last word.
   */
  #applyRound1Judgements(): EventEnvelope[] {
    const events: EventEnvelope[] = [];
    if (this.#pendingJudgements.size === 0) return events;

    const round = this.#game.round1;
    if (round === null) {
      this.#pendingJudgements.clear();
      return events;
    }

    const inTiebreak = round.phase === 'tiebreak';
    const item = inTiebreak ? round.currentTiebreakItem() : round.currentItem();
    if (item === null) return events;

    for (const [key, verdict] of [...this.#pendingJudgements]) {
      const [itemId, teamId, kind] = key.split(':');
      if (itemId !== item.itemId) {
        // The question moved on. The verdict is stale; drop it rather than
        // applying it to a different question.
        this.#pendingJudgements.delete(key);
        continue;
      }

      if (inTiebreak) {
        this.#game.round1?.recordTiebreakRuling({
          teamId: asTeamId(teamId ?? ''),
          verdict,
          source: 'semantic',
        });
        this.#pendingJudgements.delete(key);
        continue;
      }

      const recorded = this.#game.recordRound1Ruling({
        teamId: asTeamId(teamId ?? ''),
        verdict,
        source: 'semantic',
        isRetry: kind === 'retry',
      });
      this.#pendingJudgements.delete(key);

      if (recorded.ok) {
        events.push(
          this.#log.append(recorded.value.type, { kind: 'server' }, recorded.value.payload),
        );
      }
    }

    return events;
  }

  /**
   * Host rules on one answer. §4E — the Host is the final authority.
   *
   * A Host ruling REPLACES an automated one and is recorded as an override, so
   * the history shows both what the machine said and what the Host decided.
   */
  #ruleRound1Answer(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const teamId = readString(intent.payload, 'teamId');
    const verdict = readString(intent.payload, 'verdict');
    if (teamId === null || (verdict !== 'CORRECT' && verdict !== 'INCORRECT')) {
      return this.#reject(
        rejection('INVALID_REQUEST', 'Name a team and rule CORRECT or INCORRECT.'),
      );
    }

    const round = this.#game.round1;
    if (round !== null && round.phase === 'tiebreak') {
      const ruled = round.recordTiebreakRuling({
        teamId: asTeamId(teamId),
        verdict: verdict as Round1Verdict,
        source: 'host',
      });
      if (!ruled.ok) return this.#reject(ruled.error);

      const event = this.#log.append(
        ROUND1_EVENTS.ROUND1_ANSWER_GRADED,
        { kind: 'host', sessionId: '' as never },
        { teamId, verdict, source: 'host', tiebreak: true, round1: round.view() },
        intent.intentId,
      );
      this.#touch();
      return { ack: ok({ seq: event.seq }), broadcast: [event], direct: [], closeConnections: [] };
    }

    // WHICH SLOT IS THE SERVER'S DECISION, NOT THE CLIENT'S.
    //
    // The Host means "rule on the answer I am looking at". When a retry answer
    // is in and ungraded that is the RETRY slot, otherwise the first answer.
    // Reading it from the payload (as this originally did) meant the Unity
    // panel — which never sent the flag — silently ruled the first answer every
    // time, leaving the retry un-ruled and the reveal permanently blocked.
    //
    // `isRetry` is still accepted from the payload as an explicit override, for
    // a client that genuinely needs to correct the earlier answer after a retry
    // has been graded. Absent, the server decides.
    const explicit = readBoolean(intent.payload, 'isRetry');
    const isRetry = explicit ?? (round?.rulingTargetsRetry(asTeamId(teamId)) ?? false);

    const outcome = this.#game.recordRound1Ruling({
      teamId: asTeamId(teamId),
      verdict: verdict as Round1Verdict,
      source: 'host',
      isRetry,
    });
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publish(outcome.value, intent);
  }

  /** Host opens a 10-second FORGIVE MEH! retry for one team. §11, D-032. */
  #openRound1Retry(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const teamId = readString(intent.payload, 'teamId');
    if (teamId === null) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing teamId.'));
    }

    const outcome = this.#game.openRound1Retry(asTeamId(teamId));
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publish(outcome.value, intent);
  }

  /**
   * Host reveals the correct answer and finalises the scores. §11, spec §5.
   *
   * The reveal is LAST, and the engine refuses it while anything is ungraded or
   * awaiting a Host ruling — so a retrying player can never be handed the
   * answer they are about to give.
   */
  #revealRound1Answer(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const round = this.#game.round1;

    // A tiebreak attempt resolves rather than scoring — it moves no BB and no
    // Round 1 points (spec §12).
    if (round !== null && round.phase === 'tiebreak') {
      const resolved = this.#game.resolveRound1Tiebreak();
      if (!resolved.ok) return this.#reject(resolved.error);
      return this.#publish(resolved.value, intent);
    }

    // Resolving a challenge requires leaving ACTIVE_PLAY, the same way every
    // other round does. HOST_REVIEW is the legal intermediate when an answer
    // needed a ruling; RESULT is where a resolved challenge belongs.
    const phase = this.#game.sessionView()?.phase ?? null;
    if (phase === 'ACTIVE_PLAY') {
      const moved = this.#game.advancePhase('HOST_REVIEW');
      if (!moved.ok) return this.#reject(moved.error);
    }

    const outcome = this.#game.revealRound1Answer();
    if (!outcome.ok) return this.#reject(outcome.error);

    const published = this.#publishWithLedger(outcome.value.change, intent);
    if (!published.ack.ok) return published;

    const events = [...published.broadcast];

    // The last question decides the round — outright, or into the tiebreak.
    if (this.#game.round1?.questionsComplete === true) {
      const decided = this.#game.decideRound1Winner();
      if (decided.ok) {
        events.push(
          this.#log.append(
            decided.value.type,
            { kind: 'host', sessionId: '' as never },
            decided.value.payload,
          ),
        );
      }
    }

    const last = events[events.length - 1];
    return {
      ack: ok({ seq: last === undefined ? published.ack.value.seq : last.seq }),
      broadcast: events,
      direct: [],
      closeConnections: [],
    };
  }

  /** Host starts the next sudden-death tiebreak question. D-032. */
  #startRound1Tiebreak(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    const item = this.#round1Content.nextTiebreakItem();
    if (item === null) {
      return this.#reject(
        rejection('ILLEGAL_ACTION', 'The content source has no more tiebreak questions.'),
      );
    }

    const outcome = this.#game.startRound1TiebreakAttempt(item);
    if (!outcome.ok) return this.#reject(outcome.error);
    return this.#publish(outcome.value, intent);
  }

  /**
   * DEVELOPMENT ONLY — enter Round 1 directly.
   *
   * Round 1 is the FIRST round, so unlike Round 2 and Round 3 this skips
   * nothing: it is a shortcut past the lobby ceremony, not past other rounds.
   * Production reaches Round 1 through `START_GAME` and the normal phase flow,
   * and `#autoBeginRound1` is what does it.
   */
  #devStartRound1(connectionId: string, intent: IntentEnvelope): RoomOutcome {
    const auth = this.#requireHost(connectionId);
    if (!auth.ok) return this.#reject(auth.error);

    if (!this.#game.devTools) {
      return this.#reject(
        rejection('ILLEGAL_ACTION', 'Development controls are disabled on this server.'),
      );
    }

    const began = this.#beginRound1();
    if (!began.ok) return this.#reject(began.error);

    this.#touch();
    const event = this.#log.append(
      began.value.type,
      { kind: 'host', sessionId: '' as never },
      began.value.payload,
      intent.intentId,
    );
    return { ack: ok({ seq: event.seq }), broadcast: [event], direct: [], closeConnections: [] };
  }

  /**
   * Validate the content and enter Round 1.
   *
   * The counts are checked HERE rather than inside `Round1`, because a
   * malformed pack is a content problem and the room owns the content source.
   * A bad pack refuses the round rather than surfacing mid-game as a missing
   * question.
   */
  #beginRound1(): Result<EngineChange> {
    const questions = this.#round1Content.questionSet();
    const problem = validateQuestionSet(questions);
    if (problem !== null) {
      return err(
        rejection('INTERNAL_ERROR', 'The Round 1 content set is not valid.', {
          reason: problem.reason,
          ...(problem.difficulty === undefined ? {} : { difficulty: problem.difficulty }),
          ...(problem.found === undefined ? {} : { found: problem.found }),
          ...(problem.expected === undefined ? {} : { expected: problem.expected }),
        }),
      );
    }
    return this.#game.beginRound1(questions);
  }

  /**
   * Publish an engine change and link any ledger entries it produced.
   *
   * Used by the paths that move BB — Maco Mail, Host Deals, wagers — so every
   * entry can be traced to the event clients saw, exactly as Phase 5 does for a
   * challenge result.
   */
  #publishWithLedger(change: EngineChange, intent: IntentEnvelope): RoomOutcome {
    const outcome = this.#publish(change, intent);
    if (outcome.ack.ok) {
      for (const entry of this.#game.ledgerEntries) {
        if (entry.seq === null) this.#game.attachLedgerSeq(entry.entryId, outcome.ack.value.seq);
      }
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * A socket dropped.
   *
   * This is the accidental case, and it deliberately does the OPPOSITE of
   * LEAVE_ROOM: membership, team and credential all survive so the player can
   * come back to exactly where they were.
   *
   * PHASE 5 WIRES D-011 HERE. If a game is running and the dropped player is
   * ACTIVE — required by the current challenge — the game pauses automatically
   * and the timer freezes with its remaining time intact. Three cases that do
   * NOT pause, each for a reason:
   *
   *   - a disconnect in the LOBBY. There is no gameplay to protect, and the
   *     rule is about gameplay.
   *   - a NON-ACTIVE player. Most of the room is watching at any moment;
   *     pausing every time a spectator's phone sleeps would stop the party
   *     constantly (Phase 5 spec §10).
   *   - the HOST. No locked rule says what a Host disconnect should do, so
   *     nothing is invented: the loss of connection is recorded and play is
   *     left exactly as it was. See docs/OPEN_RULES.md.
   */
  onDisconnect(connectionId: string): readonly EventEnvelope[] {
    const role = this.roleOf(connectionId);
    this.#connectionRoles.delete(connectionId);

    if (role.kind === 'host') {
      // Only clear if this connection is still the current Host. A stale socket
      // closing after being displaced must not unseat the live Host.
      if (this.#hostConnectionId !== connectionId) return [];
      this.#hostConnectionId = null;
      this.#touch();
      return [
        this.#log.append(ROOM_EVENTS.HOST_CONNECTION_CHANGED, { kind: 'server' }, {
          hostConnected: false,
          room: this.#roomState(),
        }),
      ];
    }

    if (role.kind !== 'player') return [];

    const player = this.#players.get(role.playerId);
    if (player === undefined) return [];

    // Same guard: a superseded socket closing must not mark a player away when
    // they are already back on a newer connection.
    if (player.connectionId !== connectionId) return [];

    this.#players.set(role.playerId, {
      ...player,
      connection: 'disconnected',
      connectionId: null,
      disconnectedAt: asServerTimestamp(this.#clock.now()),
    });
    this.#touch();

    const events: EventEnvelope[] = [
      this.#log.append(ROOM_EVENTS.PLAYER_DISCONNECTED, { kind: 'server' }, {
        playerId: role.playerId,
        room: this.#roomState(),
        // Stated on the wire so a Host display can explain WHY the game paused
        // without correlating two events itself.
        wasActivePlayer: this.#game.isActivePlayer(role.playerId),
      }),
    ];

    // D-011. Returns null unless this disconnect actually caused a pause: a
    // lobby, a non-active player, or an already-paused game all decline, and an
    // already-paused game declines specifically so the captured return phase is
    // not overwritten by a second pause.
    const pause = this.#game.onActivePlayerDisconnect(role.playerId);
    if (pause !== null) {
      events.push(this.#log.append(pause.type, { kind: 'server' }, pause.payload));
    }

    return events;
  }

  /** Register a connection with no identity yet. */
  onConnect(connectionId: string): void {
    this.#connectionRoles.set(connectionId, { kind: 'anonymous' });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #reject(error: ReturnType<typeof rejection>): RoomOutcome {
    return { ack: err(error), broadcast: [], direct: [], closeConnections: [] };
  }

  #touch(): void {
    this.#updatedAt = this.#clock.now();
  }

  events(): readonly EventEnvelope[] {
    return this.#log.all();
  }

  eventsSince(seq: SequenceNumber): readonly EventEnvelope[] {
    return this.#log.since(seq);
  }
}

// ---------------------------------------------------------------------------
// Payload readers — intents arrive from phones and are never trusted.
// ---------------------------------------------------------------------------

function readField(payload: unknown, field: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  return (payload as Record<string, unknown>)[field];
}

function readString(payload: unknown, field: string): string | null {
  const value = readField(payload, field);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Read an array of non-empty ids.
 *
 * Returns `[]` for an absent field and `null` for a malformed one, so a caller
 * can tell "not supplied" from "supplied wrongly" and reject only the latter.
 */
/**
 * The `challengeType` a Round 1 question uses on its engine challenge.
 *
 * A plain string, exactly as game.ts intends — the engine has no opinion about
 * what a round contains, and this is the round declaring its own identity.
 */
const ROUND1_CHALLENGE_TYPE = 'ROUND1_TRIVIA';

function readBoolean(payload: unknown, field: string): boolean | null {
  const value = readField(payload, field);
  return typeof value === 'boolean' ? value : null;
}
function readStringArray(payload: unknown, field: string): string[] | null {
  const value = readField(payload, field);
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  if (value.some((item) => typeof item !== 'string' || item === '')) return null;
  return value as string[];
}

/** Read a teamId -> amount map. Same absent/malformed distinction. */
function readNumberMap(payload: unknown, field: string): Record<string, number> | null {
  const value = readField(payload, field);
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return null;

  const result: Record<string, number> = {};
  for (const [key, amount] of Object.entries(value as Record<string, unknown>)) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
    result[key] = amount;
  }
  return result;
}

/** Phase names, validated at runtime because intents arrive over a network. */
const GAME_PHASE_NAMES = new Set<string>([
  'BOOT',
  'LOBBY',
  'TEAM_LOCK',
  'ROUND_INTRO',
  'MARKET',
  'CHALLENGE_INTRO',
  'ACTIVE_PLAY',
  'HOST_REVIEW',
  'RESULT',
  'ROUND_COMPLETE',
  'PAUSED',
  'SUDDEN_DEATH',
  'GAME_OVER',
]);

function isGamePhase(value: string): value is GamePhase {
  return GAME_PHASE_NAMES.has(value);
}

function isHostRulingKind(value: string): value is HostRulingKind {
  return (HOST_RULING_KINDS as readonly string[]).includes(value);
}


/**
 * Compare two secrets without leaking their contents through timing.
 *
 * A naive `===` returns as soon as it finds a differing character, so the time
 * it takes reveals how many leading characters were right — enough, over many
 * attempts, to recover a token one character at a time. The length check is
 * deliberately left early-exit: token length is not secret.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export { asSequenceNumber };
export type { KnownTeamId };
