import type {
  PlayerId,
  RoomId,
  SequenceNumber,
  ServerTimestamp,
  SessionId,
  TeamId,
} from './ids.js';
import type { ConnectionState, GameMode } from './models.js';

/**
 * Production room, player and team model — Phase 4.
 *
 * This is the REAL lobby, not the benchmark session. The benchmark's client
 * list (`packages/protocol/src/benchmark.ts`) is a measuring instrument with no
 * concept of a team, a reconnect credential or Host authority, and deliberately
 * stays separate: a benchmark identity must never be usable as a production
 * player identity.
 *
 * NO GAMEPLAY LIVES HERE. There is no BB award, no card, no round, no buzzer and
 * no score. Phase 4 ends at a locked set of teams; everything after that is
 * Phase 5+, and several of those rules are still open in docs/OPEN_RULES.md.
 */

// ---------------------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a production room.
 *
 * Deliberately distinct from `GamePhase` (lifecycle.ts). GamePhase says what the
 * game is doing; this says whether the room exists and accepts joins. A room in
 * `OPEN` may be in the LOBBY phase, but "can a phone still join?" is a different
 * question from "is a challenge running?", and conflating them would make room
 * closure depend on gameplay state.
 */
export const ROOM_STATUSES = [
  /** Accepting joins. Teams may still be edited. */
  'OPEN',
  /** Teams locked. Joins rejected; existing players may still reconnect. */
  'LOCKED',
  /** Host closed the room. Terminal: no joins, no reconnects. */
  'CLOSED',
] as const;

export type RoomStatus = (typeof ROOM_STATUSES)[number];

/**
 * How many teams are playing.
 *
 * GAME_RULES_LOCKED.md supports two-team and three-team games throughout, and
 * D-008 defines a distinct three-team Round 4 progression. Only 2 and 3 are
 * legal — there is no locked rule for any other count, so none is offered.
 */
export type TeamMode = 2 | 3;

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/**
 * Stable team identifiers.
 *
 * The user's Phase 4 spec §10: "Use stable team IDs… Do not unnecessarily bake
 * those labels into gameplay logic." So `TEAM_A` is an ID and "Team A" is a
 * presentation label that can change without touching rules. Team C exists as
 * an ID in both modes but only participates in three-team mode.
 */
export const TEAM_IDS = ['TEAM_A', 'TEAM_B', 'TEAM_C'] as const;

export type KnownTeamId = (typeof TEAM_IDS)[number];

/** Default presentation labels. Phase 8 may rename these freely. */
export const DEFAULT_TEAM_LABELS: Readonly<Record<KnownTeamId, string>> = {
  TEAM_A: 'Team A',
  TEAM_B: 'Team B',
  TEAM_C: 'Team C',
};

/** The team IDs participating under a given team mode. */
export function teamsForMode(mode: TeamMode): readonly KnownTeamId[] {
  return mode === 3 ? TEAM_IDS : ['TEAM_A', 'TEAM_B'];
}

/** Whether a team participates under a given mode. */
export function isTeamInMode(teamId: string, mode: TeamMode): boolean {
  return (teamsForMode(mode) as readonly string[]).includes(teamId);
}

// ---------------------------------------------------------------------------
// Lobby player
// ---------------------------------------------------------------------------

/**
 * A player in the production lobby.
 *
 * Identity discipline (Phase 4 spec §6) is the whole point of this shape:
 * `playerId` is server-minted and permanent for the room's life; `connectionId`
 * is a socket that dies and is replaced; `displayName` is a label with no
 * authority at all. Two players may share a display name without ambiguity
 * because nothing is ever keyed on it.
 *
 * The reconnect credential is NOT here — see `LobbyPlayerPrivate`. This type is
 * what every client in the room may see.
 */
export interface LobbyPlayer {
  readonly playerId: PlayerId;
  readonly displayName: string;
  /** Null until the Host assigns one. */
  readonly teamId: TeamId | null;
  readonly connection: ConnectionState;
  readonly joinedAt: ServerTimestamp;
  /**
   * When the player's socket last dropped. Null while connected.
   *
   * Recorded so the Host can see how long someone has been gone. It carries no
   * automatic consequence: nothing times a player out, because "how long before
   * a disconnected player is dropped" is not a locked rule and Phase 4 must not
   * invent one.
   */
  readonly disconnectedAt: ServerTimestamp | null;
}

/**
 * Server-side player record, including the secret.
 *
 * NEVER serialise this to a client. `toPublicPlayer` is the only sanctioned way
 * to cross that boundary, and snapshots are built exclusively from its output.
 */
export interface LobbyPlayerPrivate extends LobbyPlayer {
  /**
   * Bearer credential proving "I am this player" on reconnect.
   *
   * Phase 4 spec §7 — "never trust playerId alone". playerId is broadcast to
   * every client in the room, so accepting it as proof would let any player
   * impersonate any other simply by reading the lobby list.
   */
  readonly reconnectToken: string;
  /** The socket currently authoritative for this player. Null when away. */
  readonly connectionId: string | null;
  /** Session for this connection. Replaced on every reconnect. */
  readonly sessionId: SessionId | null;
}

/** Strip the secret. The ONLY route from private to public player state. */
export function toPublicPlayer(player: LobbyPlayerPrivate): LobbyPlayer {
  return {
    playerId: player.playerId,
    displayName: player.displayName,
    teamId: player.teamId,
    connection: player.connection,
    joinedAt: player.joinedAt,
    disconnectedAt: player.disconnectedAt,
  };
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

/** Public room state, safe for any client in the room. */
export interface LobbyRoom {
  readonly roomId: RoomId;
  readonly roomCode: string;
  readonly mode: GameMode;
  readonly status: RoomStatus;
  readonly teamMode: TeamMode;
  /**
   * Whether team assignments are frozen.
   *
   * Separate from `status === 'LOCKED'` in meaning even though they move
   * together today: this is the rule ("assignments are final"), status is the
   * room's lifecycle. Phase 5 will start the game without unlocking teams.
   */
  readonly teamsLocked: boolean;
  readonly createdAt: ServerTimestamp;
  readonly updatedAt: ServerTimestamp;
  readonly seq: SequenceNumber;
  /** Whether a Host connection is currently attached. */
  readonly hostConnected: boolean;
}

/** A team as clients see it in the lobby. */
export interface LobbyTeam {
  readonly teamId: TeamId;
  readonly displayName: string;
  readonly memberIds: readonly PlayerId[];
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * Lobby state as seen by a client.
 *
 * Phase 4 spec §24 — "Snapshots should contain only what that client is allowed
 * to know." There is exactly one lobby snapshot shape because, at this stage,
 * Host and player are entitled to the same facts: who is here, which team they
 * are on, whether teams are locked. The difference is in what each may DO, which
 * is enforced on intents, not by hiding state.
 *
 * `you` is the one per-recipient field: a client needs to know which of the
 * listed players it is. It carries no secret — just the id the client already
 * received when it joined.
 *
 * Once gameplay begins (Phase 5+), this WILL need to diverge: a player must not
 * receive unrevealed answers or another team's private card hand
 * (CONTENT_POLICY.md). The split is deliberately deferred until there is
 * something secret to split.
 */
export interface LobbySnapshot {
  readonly protocolVersion: number;
  readonly seq: SequenceNumber;
  readonly takenAt: ServerTimestamp;
  readonly room: LobbyRoom;
  readonly players: readonly LobbyPlayer[];
  readonly teams: readonly LobbyTeam[];
  /** The recipient's own playerId, when the recipient is a player. */
  readonly you: PlayerId | null;
  /** Whether the recipient holds Host authority. */
  readonly isHost: boolean;
}

// ---------------------------------------------------------------------------
// Intents and events
// ---------------------------------------------------------------------------

/**
 * Phase 4 client intents.
 *
 * Naming follows the existing convention (SCREAMING_SNAKE verbs, as in
 * BENCHMARK_BUZZ / HOST_RESUME_GAME). Host-only intents are prefixed `HOST_` so
 * that authority is visible at the call site and in logs — a reviewer should not
 * have to open the handler to see that `HOST_LOCK_TEAMS` is privileged.
 */
export const ROOM_INTENTS = {
  /** Unity Host creates a room. The only intent that needs no existing room. */
  CREATE_ROOM: 'CREATE_ROOM',
  /** A phone joins with a display name. */
  JOIN_ROOM: 'JOIN_ROOM',
  /** A returning player proves identity with its reconnect credential. */
  RECONNECT_PLAYER: 'RECONNECT_PLAYER',
  /** The Unity Host reattaches to its existing room. */
  RECONNECT_HOST: 'RECONNECT_HOST',
  /** Deliberate exit. Distinct from a dropped socket — see LEAVE vs disconnect. */
  LEAVE_ROOM: 'LEAVE_ROOM',
  /** Read-only. Returns the snapshot in the ack; emits no event. */
  REQUEST_LOBBY_SNAPSHOT: 'REQUEST_LOBBY_SNAPSHOT',

  HOST_SET_TEAM_MODE: 'HOST_SET_TEAM_MODE',
  HOST_ASSIGN_PLAYER_TEAM: 'HOST_ASSIGN_PLAYER_TEAM',
  HOST_UNASSIGN_PLAYER: 'HOST_UNASSIGN_PLAYER',
  HOST_REMOVE_PLAYER: 'HOST_REMOVE_PLAYER',
  HOST_LOCK_TEAMS: 'HOST_LOCK_TEAMS',
  HOST_UNLOCK_TEAMS: 'HOST_UNLOCK_TEAMS',
  HOST_CLOSE_ROOM: 'HOST_CLOSE_ROOM',
} as const;

export type RoomIntentType = (typeof ROOM_INTENTS)[keyof typeof ROOM_INTENTS];

/**
 * Placeholder roomId for intents sent before a room is known.
 *
 * `IntentEnvelope.roomId` is required and must be non-empty, because every other
 * intent in the system is addressed to a room. CREATE_ROOM is the one intent
 * that cannot be: the Host is asking the server to mint the room it will then
 * belong to.
 *
 * Naming that case explicitly beats the alternatives — relaxing the envelope
 * (which would let a genuinely missing roomId through everywhere else) or
 * letting each client invent its own placeholder (which the server would then
 * have to guess at).
 *
 * JOIN_ROOM also uses it: a phone scanning a QR code knows only the room CODE,
 * never the internal id.
 */
export const NO_ROOM_ID = 'pending';

/** Phase 4 server events. Past tense: each is a statement of committed fact. */
export const ROOM_EVENTS = {
  ROOM_CREATED: 'ROOM_CREATED',
  PLAYER_JOINED: 'PLAYER_JOINED',
  PLAYER_RECONNECTED: 'PLAYER_RECONNECTED',
  PLAYER_DISCONNECTED: 'PLAYER_DISCONNECTED',
  PLAYER_LEFT: 'PLAYER_LEFT',
  PLAYER_REMOVED: 'PLAYER_REMOVED',
  TEAM_MODE_CHANGED: 'TEAM_MODE_CHANGED',
  TEAM_ASSIGNMENT_CHANGED: 'TEAM_ASSIGNMENT_CHANGED',
  TEAMS_LOCKED: 'TEAMS_LOCKED',
  TEAMS_UNLOCKED: 'TEAMS_UNLOCKED',
  ROOM_CLOSED: 'ROOM_CLOSED',
  HOST_CONNECTION_CHANGED: 'HOST_CONNECTION_CHANGED',
  /**
   * An older connection for a player was superseded by a newer one.
   *
   * Sent to the DISPLACED socket so a stale tab can say "you were opened
   * elsewhere" rather than appearing frozen. See the stale-connection policy in
   * docs/LOBBY.md.
   */
  CONNECTION_SUPERSEDED: 'CONNECTION_SUPERSEDED',
} as const;

export type RoomEventType = (typeof ROOM_EVENTS)[keyof typeof ROOM_EVENTS];

// ---------------------------------------------------------------------------
// Credential payloads
//
// These carry secrets to exactly ONE recipient and are never broadcast.
// ---------------------------------------------------------------------------

/** Returned to the Unity Host when it creates a room. Host-only. */
export interface RoomCreatedPayload {
  readonly roomId: RoomId;
  readonly roomCode: string;
  /** Host credential. Proves Host authority on reconnect. Never broadcast. */
  readonly hostToken: string;
  /** Ready-made join URL for the QR code. */
  readonly joinUrl: string;
  readonly snapshot: LobbySnapshot;
}

/** Returned to a joining player. Player-only. */
export interface JoinAcceptedPayload {
  readonly playerId: PlayerId;
  readonly displayName: string;
  /** This player's reconnect credential. Never broadcast. */
  readonly reconnectToken: string;
  readonly snapshot: LobbySnapshot;
}

// ---------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------

/** Phase 4 spec §18 — "sensible configurable length limit". */
export const DISPLAY_NAME_MIN_LENGTH = 1;
export const DISPLAY_NAME_MAX_LENGTH = 20;

/**
 * Normalise a submitted display name.
 *
 * Trims, collapses internal whitespace runs, and strips control characters —
 * which are invisible and could be used to spoof another player's name or break
 * a layout. It does NOT filter profanity: the spec says not to spend scope
 * there, and this is a party game among friends.
 *
 * Returns null when nothing usable remains. Rendering safety is the client's
 * job; React escapes by default and Unity's IMGUI draws strings literally.
 */
export function normaliseDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const cleaned = raw.replace(/[ -]/g, '').replace(/\s+/g, ' ').trim();

  if (cleaned.length < DISPLAY_NAME_MIN_LENGTH) return null;
  return cleaned.slice(0, DISPLAY_NAME_MAX_LENGTH);
}
