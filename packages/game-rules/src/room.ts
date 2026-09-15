import {
  asSequenceNumber,
  asServerTimestamp,
  asTeamId,
  DEFAULT_TEAM_LABELS,
  err,
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
  type IntentEnvelope,
  type KnownTeamId,
  type LobbyPlayer,
  type LobbyPlayerPrivate,
  type LobbyRoom,
  type LobbySnapshot,
  type LobbyTeam,
  type PlayerId,
  type Result,
  type RoomId,
  type RoomStatus,
  type SequenceNumber,
  type TeamMode,
} from '@bb/protocol';
import type { Clock } from './clock.js';
import { EventLog } from './event-log.js';
import { IntentRegistry } from './idempotency.js';

/**
 * The authoritative production room — Phase 4.
 *
 * This owns the lobby: who is in it, which team they are on, whether that is
 * locked, and who is allowed to change any of it. The server is authoritative
 * (CLAUDE.md, ARCHITECTURE.md §4); Unity and phones send intents and render what
 * comes back.
 *
 * NO GAMEPLAY. No BB award, no card, no round, no buzzer, no scoring. The room
 * stops at a locked set of teams. Starting a game is Phase 5.
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

    // Reads bypass deduplication entirely: they change nothing, so replaying one
    // is harmless, and recording them would grow the registry without purpose.
    if (intent.type === ROOM_INTENTS.REQUEST_LOBBY_SNAPSHOT) {
      return {
        ack: ok({ seq: this.#log.latestSeq(), payload: this.snapshot(connectionId) }),
        broadcast: [],
        direct: [],
        closeConnections: [],
      };
    }

    if (this.#intents.has(intent.intentId)) {
      const originalSeq = this.#intents.resultOf(intent.intentId);
      return this.#reject(
        rejection('DUPLICATE_INTENT', 'This action was already processed.', {
          intentId: intent.intentId,
          ...(originalSeq === undefined ? {} : { originalSeq }),
        }),
      );
    }

    const outcome = this.#evaluate(connectionId, intent);

    if (outcome.ack.ok) {
      this.#intents.record(intent.intentId, outcome.ack.value.seq);
    }
    return outcome;
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
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * A socket dropped.
   *
   * This is the accidental case, and it deliberately does the OPPOSITE of
   * LEAVE_ROOM: membership, team and credential all survive so the player can
   * come back to exactly where they were.
   *
   * It also does NOT pause anything. D-011 auto-pauses on an active player's
   * disconnect, but that rule protects gameplay in progress; there is no
   * gameplay in a lobby, and pausing a lobby would mean nothing. Phase 5 wires
   * the pause when there is something to pause — the spec says so explicitly
   * (§9), and the benchmark session already proves the mechanism works.
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

    return [
      this.#log.append(ROOM_EVENTS.PLAYER_DISCONNECTED, { kind: 'server' }, {
        playerId: role.playerId,
        room: this.#roomState(),
      }),
    ];
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
