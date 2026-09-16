import {
  asSequenceNumber,
  asServerTimestamp,
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
    };
    return playerSnapshot;
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
    const expiry = this.#game.pollTimerExpiry();
    if (expiry === null) return [];
    return [this.#log.append(expiry.type, { kind: 'server' }, expiry.payload)];
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
        return this.#engineAction(connectionId, intent, () => this.#game.startChallenge());
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

    return { ack: ok({ seq: event.seq }), broadcast: [event], direct: [], closeConnections: [] };
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
