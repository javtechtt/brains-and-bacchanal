import type {
  ChallengeId,
  PlayerId,
  RoomId,
  SequenceNumber,
  ServerTimestamp,
  TeamId,
} from './ids.js';
import type { GamePhase } from './lifecycle.js';
import type { ChallengeStatus, PauseReason } from './models.js';
import type { LobbyPlayer, LobbyRoom, TeamMode } from './room.js';
import type { HostSharedSystemsView, PlayerSharedSystemsView } from './shared-systems.js';

/**
 * Production game protocol — Phase 5.
 *
 * This is the GENERIC authoritative engine's wire vocabulary: starting a game,
 * moving BB, running a challenge, owning a turn, running a timer, pausing, and
 * recording a Host ruling.
 *
 * NO ROUND LIVES HERE. There is no trivia question, no Think Fast turn order,
 * no logo, no Family Feud board, no card, no Market item and no Maco Mail
 * outcome. Those are Phases 6-7 and several depend on rules still open in
 * docs/OPEN_RULES.md. `challengeType` stays a plain string for exactly that
 * reason — fixing the set now would imply decisions about round composition
 * that OPEN_RULES.md §1 leaves open.
 *
 * Everything here describes SHAPE and AUTHORITY, never what an answer is worth.
 */

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/**
 * Phase 5 client intents.
 *
 * Naming follows Phase 4's convention: SCREAMING_SNAKE verbs, `HOST_` prefix
 * where the action is privileged, so authority is visible at the call site and
 * in logs without opening the handler.
 */
export const GAME_INTENTS = {
  /** Host starts the game from a locked lobby. Seeds every team's BB. */
  START_GAME: 'START_GAME',
  /**
   * Host moves the game to another generic phase.
   *
   * Legality comes from lifecycle.ts, not from this intent. A caller names a
   * destination; the transition table decides whether it is reachable.
   */
  HOST_ADVANCE_PHASE: 'HOST_ADVANCE_PHASE',

  /** Host creates a generic challenge container in CHALLENGE_INTRO. */
  HOST_PREPARE_CHALLENGE: 'HOST_PREPARE_CHALLENGE',
  /** Host begins the prepared challenge; the game enters ACTIVE_PLAY. */
  HOST_START_CHALLENGE: 'HOST_START_CHALLENGE',
  /** Host sets which team, and optionally which player, currently acts. */
  HOST_SET_TURN: 'HOST_SET_TURN',
  /** Host declares which players the challenge currently requires. */
  HOST_SET_ACTIVE_PLAYERS: 'HOST_SET_ACTIVE_PLAYERS',

  /** Host starts a server-authoritative timer for the active challenge. */
  HOST_START_TIMER: 'HOST_START_TIMER',
  /** Host clears a running timer without letting it expire. */
  HOST_CANCEL_TIMER: 'HOST_CANCEL_TIMER',

  /** Host sends the challenge to review, or records a subjective ruling. */
  HOST_REQUEST_REVIEW: 'HOST_REQUEST_REVIEW',
  HOST_RULING: 'HOST_RULING',

  /** Host resolves the challenge, optionally applying BB through the ledger. */
  HOST_RESOLVE_CHALLENGE: 'HOST_RESOLVE_CHALLENGE',

  /** Host pauses deliberately. Disconnect auto-pause is server-initiated. */
  HOST_PAUSE_GAME: 'HOST_PAUSE_GAME',
  /** Only the Host may resume. D-011. */
  HOST_RESUME_GAME: 'HOST_RESUME_GAME',

  /** Read-only. Returns the caller's permitted game snapshot in the ack. */
  REQUEST_GAME_SNAPSHOT: 'REQUEST_GAME_SNAPSHOT',

  /**
   * DEVELOPMENT ONLY — direct BB adjustment for engine testing.
   *
   * Phase 5 spec §17 asks for a way to exercise the ledger before any round
   * exists. It is Host-only, refused unless the server runs with dev tools
   * enabled, and every entry it writes is marked `dev_adjustment` in the ledger
   * so a test award can never be mistaken for earned BB.
   *
   * No production UI exposes it, and no round code may call it: rounds award BB
   * through a challenge result.
   */
  DEV_ADJUST_BB: 'DEV_ADJUST_BB',
} as const;

export type GameIntentType = (typeof GAME_INTENTS)[keyof typeof GAME_INTENTS];

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Phase 5 server events. Past tense: each states a committed fact. */
export const GAME_EVENTS = {
  GAME_STARTED: 'GAME_STARTED',
  PHASE_CHANGED: 'PHASE_CHANGED',

  BB_CHANGED: 'BB_CHANGED',

  CHALLENGE_PREPARED: 'CHALLENGE_PREPARED',
  CHALLENGE_STARTED: 'CHALLENGE_STARTED',
  CHALLENGE_RESOLVED: 'CHALLENGE_RESOLVED',

  TURN_CHANGED: 'TURN_CHANGED',
  ACTIVE_PLAYERS_CHANGED: 'ACTIVE_PLAYERS_CHANGED',

  TIMER_STARTED: 'TIMER_STARTED',
  TIMER_CANCELLED: 'TIMER_CANCELLED',
  /**
   * A server-authoritative deadline ran out.
   *
   * IT DECIDES NOTHING. Phase 5 spec §13 is explicit that "time expired" must
   * not be given a meaning — a timeout is not a wrong answer unless a locked
   * rule later says so for a specific challenge. This event reports the fact and
   * hands the challenge to the Host.
   */
  TIMER_EXPIRED: 'TIMER_EXPIRED',

  HOST_RULING_RECORDED: 'HOST_RULING_RECORDED',
  REVIEW_REQUESTED: 'REVIEW_REQUESTED',

  GAME_PAUSED: 'GAME_PAUSED',
  GAME_RESUMED: 'GAME_RESUMED',
} as const;

export type GameEventType = (typeof GAME_EVENTS)[keyof typeof GAME_EVENTS];

// ---------------------------------------------------------------------------
// BB ledger
// ---------------------------------------------------------------------------

/**
 * Why BB moved.
 *
 * Generic on purpose. `challenge_result` covers every future round award
 * because a round awards BB by resolving a challenge; Market spending, Maco
 * Mail outcomes and wagers will add their own reasons in Phase 6 when those
 * systems exist. Nothing here encodes an amount, a multiplier or a price.
 */
export const BB_CHANGE_REASONS = [
  /** Seeding the locked 1,000 BB at game start. GAME_RULES_LOCKED.md §1. */
  'game_start',
  /** Applied by a resolved challenge result. */
  'challenge_result',
  /** A Host ruling that moved BB directly. */
  'host_adjustment',

  // --- Phase 6 shared systems ---------------------------------------------
  // Each names a system rather than an amount. A Host reading a team's history
  // must be able to tell a Market purchase from a Maco Mail penalty without
  // matching numbers against a price list.
  /** Spent in the Market. GAME_RULES_LOCKED.md §10. */
  'market_purchase',
  /** Refunded by Cancel Market Purchase — the ACTUAL price paid. §8. */
  'market_refund',
  /** A Maco Mail money outcome. §8. */
  'maco_mail',
  /** A Host Deal payout or payment. §9. */
  'host_deal',
  /** A resolved wager. §17. */
  'wager',

  /** DEVELOPMENT ONLY. Never present in a real game. */
  'dev_adjustment',
] as const;

export type BbChangeReason = (typeof BB_CHANGE_REASONS)[number];

/**
 * One immutable entry in a team's BB history.
 *
 * Phase 5 spec §3 — a balance must not be "merely a mutable number with no
 * history". Every entry explains itself: what moved, what it produced, why, and
 * which event it belongs to.
 *
 * `delta` is the amount REQUESTED; `applied` is what actually moved after the
 * floor-at-zero rule. They differ exactly when a deduction hit the floor, which
 * is the one case a Host most needs to see explained.
 */
export interface BbLedgerEntry {
  readonly entryId: string;
  readonly teamId: TeamId;
  /** Requested change. Negative for a deduction. */
  readonly delta: number;
  /** Change actually applied after clamping. |applied| <= |delta|. */
  readonly applied: number;
  readonly balanceBefore: number;
  readonly balanceAfter: number;
  readonly reason: BbChangeReason;
  readonly at: ServerTimestamp;
  /** The event that carried this change, once one was emitted. */
  readonly seq: SequenceNumber | null;
  /** The challenge this came from, when it came from one. */
  readonly challengeId: ChallengeId | null;
  /** Free-text context for the Host and logs. Never game content. */
  readonly note: string | null;
}

// ---------------------------------------------------------------------------
// Turn ownership
// ---------------------------------------------------------------------------

/**
 * Whose turn it is.
 *
 * Three cases, deliberately distinct: nobody's, a team's, and a specific
 * player's within a team. GAME_RULES_LOCKED.md §11 nominates individual players
 * per difficulty in Round 1, so player-level ownership must be expressible
 * without every challenge being forced to use it.
 *
 * Only the server assigns this. A client may ask; it can never take a turn.
 */
export interface TurnOwnership {
  readonly teamId: TeamId | null;
  readonly playerId: PlayerId | null;
}

export const NO_TURN: TurnOwnership = { teamId: null, playerId: null };

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

/**
 * A running server-owned timer as clients see it.
 *
 * `remainingMs` is computed by the server at send time. A client may count down
 * locally between updates for a smooth display, but it never decides expiry —
 * ARCHITECTURE.md §6, and the reason no client timestamp exists anywhere in
 * this protocol.
 */
export interface TimerView {
  readonly timerId: string;
  readonly durationMs: number;
  readonly remainingMs: number;
  readonly paused: boolean;
  readonly expired: boolean;
  /** Server time this timer started. For display only. */
  readonly startedAt: ServerTimestamp;
  /** What the timer is attached to, when it belongs to a challenge. */
  readonly challengeId: ChallengeId | null;
}

// ---------------------------------------------------------------------------
// Host rulings
// ---------------------------------------------------------------------------

/**
 * The subjective calls the Host is authoritative for.
 *
 * CLAUDE.md — the Host decides "whether a spoken answer is valid", "who spoke
 * first in spoken/no-buzzer challenges" and "winners of physical/creative
 * games". These are those, kept generic.
 *
 * DELIBERATELY NOT HERE: anything that implies a round's scoring. A ruling says
 * what the Host judged; what it is worth is decided when the challenge resolves,
 * against rules that in most cases are not written yet.
 */
export const HOST_RULING_KINDS = [
  /** The response just given counts. */
  'valid',
  /** The response just given does not count. */
  'invalid',
  /** This team/player is the winner of a subjective challenge. */
  'select_winner',
  /** Free-form note recorded against the challenge for the audit trail. */
  'note',
] as const;

export type HostRulingKind = (typeof HOST_RULING_KINDS)[number];

/**
 * A recorded Host ruling.
 *
 * CLAUDE.md — "Host decisions still go through the server so they are
 * recorded." This is that record.
 */
export interface HostRuling {
  readonly rulingId: string;
  readonly kind: HostRulingKind;
  readonly challengeId: ChallengeId;
  /** Who the ruling is about, where it is about someone. */
  readonly teamId: TeamId | null;
  readonly playerId: PlayerId | null;
  readonly at: ServerTimestamp;
  readonly seq: SequenceNumber;
  /** Host-supplied context. Never unrevealed game content. */
  readonly note: string | null;
}

// ---------------------------------------------------------------------------
// Challenge
// ---------------------------------------------------------------------------

/**
 * A challenge as clients see it during a game.
 *
 * CONTENT SAFETY: `configRef` is an opaque reference, never question text,
 * accepted answers or board labels. CONTENT_POLICY.md — "player browsers must
 * never receive future/unrevealed answer payloads." There is nowhere here to
 * put one, which is the protection.
 */
export interface GameChallengeView {
  readonly challengeId: ChallengeId;
  readonly challengeType: string;
  readonly status: ChallengeStatus;
  readonly configRef: string | null;
  readonly turn: TurnOwnership;
  /**
   * Players whose participation the challenge currently requires.
   *
   * This is the operational definition of "active player" the disconnect rule
   * keys on — see docs/GAME_ENGINE.md. It is set by the engine, never inferred
   * from who happens to be connected.
   */
  readonly activePlayerIds: readonly PlayerId[];
  readonly startedAt: ServerTimestamp | null;
  readonly timer: TimerView | null;
  /** Rulings recorded against this challenge, oldest first. */
  readonly rulings: readonly HostRuling[];
  readonly result: GameChallengeResult | null;
}

/**
 * A generic challenge outcome.
 *
 * Records WHO won and WHAT BB moved, never how that was decided. Award amounts
 * come from locked rules or Host rulings in later phases; this shape must be
 * able to carry them without knowing any of them yet.
 */
export interface GameChallengeResult {
  readonly winningTeamIds: readonly TeamId[];
  readonly winningPlayerIds: readonly PlayerId[];
  /** BB actually applied per team, after the floor. Keyed by teamId. */
  readonly bbApplied: Readonly<Record<string, number>>;
  readonly decidedByHost: boolean;
  readonly resolvedAt: ServerTimestamp;
  /** Generic completion status. `abandoned` covers a challenge cut short. */
  readonly completion: 'completed' | 'abandoned';
  readonly note: string | null;
}

// ---------------------------------------------------------------------------
// Team game state
// ---------------------------------------------------------------------------

/** A team during an active game. */
export interface GameTeamView {
  readonly teamId: TeamId;
  readonly displayName: string;
  readonly memberIds: readonly PlayerId[];
  /** Current authoritative balance. Never below 0. */
  readonly bb: number;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * The game state every client in the room may see.
 *
 * Phase 4 had ONE lobby snapshot because Host and players were entitled to the
 * same facts. Phase 5 splits it, as docs/LOBBY.md anticipated — not because the
 * split is needed for the fields that exist today, but because the boundary
 * must exist before there is anything secret to put on the wrong side of it.
 *
 * What is common: the room, the roster, team balances, the phase, whose turn it
 * is, the timer and the pause state. A party game shows the scores on a TV; none
 * of that is secret.
 */
export interface GameSnapshotBase {
  readonly protocolVersion: number;
  readonly seq: SequenceNumber;
  readonly takenAt: ServerTimestamp;
  readonly room: LobbyRoom;
  readonly players: readonly LobbyPlayer[];
  readonly teams: readonly GameTeamView[];
  readonly teamMode: TeamMode;
  /** Null until the Host starts the game. */
  readonly game: GameSessionView | null;
}

/** The active game session, as any client may see it. */
export interface GameSessionView {
  readonly gameId: string;
  readonly roomId: RoomId;
  readonly phase: GamePhase;
  readonly startedAt: ServerTimestamp;
  /** Which round the engine is on. Generic index; no round content implied. */
  readonly roundIndex: number;
  readonly paused: boolean;
  readonly pause: GamePauseView | null;
  readonly challenge: GameChallengeView | null;
  readonly turn: TurnOwnership;
}

/** Why the game is paused and where it returns to. */
export interface GamePauseView {
  readonly reason: PauseReason;
  readonly pausedAt: ServerTimestamp;
  /** The phase a Host resume returns to. Captured at pause time. */
  readonly resumePhase: GamePhase;
  /** The player whose disconnect caused the pause, if any. */
  readonly pausedByPlayerId: PlayerId | null;
}

/**
 * The Host's view. Everything the base view carries, plus the audit trail.
 *
 * The Host runs the game from a TV and must be able to explain a balance to a
 * room full of people, so the ledger belongs here. It is not secret — it is
 * simply of no use on a phone, and keeping it off the player snapshot keeps the
 * player payload small on a weak party Wi-Fi.
 */
export interface HostGameSnapshot extends GameSnapshotBase {
  readonly isHost: true;
  /** Full BB history, oldest first. */
  readonly ledger: readonly BbLedgerEntry[];
  /** Whether development engine controls are enabled on this server. */
  readonly devToolsEnabled: boolean;
  /**
   * Phase 6 shared systems, as the Host may see them.
   *
   * Broad — every hand, every purchase, every advantage — because the Host
   * adjudicates. Still NOT the Maco Mail deck order, and still not a Clash
   * response before the reveal; see shared-systems.ts.
   *
   * Null before the game starts.
   */
  readonly shared: HostSharedSystemsView | null;
}

/**
 * A player's view.
 *
 * CONTENT SAFETY — the boundary that matters. A player receives their own
 * identity, their team, every team's balance and the generic state of play.
 *
 * WHAT A PLAYER NEVER RECEIVES, by construction: the BB ledger, the Host
 * token, any other player's reconnect credential, and — when those systems
 * exist in Phase 6+ — unrevealed answers, hidden Market selections, another
 * team's card hand or undrawn Maco Mail. There is no field here to carry them.
 */
export interface PlayerGameSnapshot extends GameSnapshotBase {
  readonly isHost: false;
  /** The recipient's own playerId. */
  readonly you: PlayerId;
  /** The recipient's team, when assigned. */
  readonly yourTeamId: TeamId | null;
  /** Whether this player is currently required by the challenge. */
  readonly youAreActive: boolean;
  /** Whether it is this player's turn, or their team's. */
  readonly yourTurn: boolean;
  /**
   * Phase 6 shared systems, as THIS PLAYER'S TEAM may see them.
   *
   * The secrecy-critical field. It carries the team's own hand, its own
   * purchases, its own advantages and its own draws; opponents appear only as
   * counts, and a Clash response appears only after the reveal.
   * `PlayerSharedSystemsView` has no field capable of carrying an opponent's
   * card, so this cannot leak one by mistake.
   *
   * Null before the game starts, and for a player with no team.
   */
  readonly shared: PlayerSharedSystemsView | null;
}

export type GameSnapshot = HostGameSnapshot | PlayerGameSnapshot;

/** Whether a snapshot is the Host's. Narrows the union for callers. */
export function isHostGameSnapshot(snapshot: GameSnapshot): snapshot is HostGameSnapshot {
  return snapshot.isHost;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Fallback duration for a development test timer, in milliseconds.
 *
 * NOT A GAME RULE, and deliberately not used by any challenge. Every real
 * duration is still open: Think Fast (OPEN_RULES.md §2), Sing a Song (§6) and
 * the Round 4 / Sudden Death timers (§11). Challenges supply their own from
 * configuration; this exists so the Host's engine-test button has something to
 * press.
 */
export const DEV_TEST_TIMER_MS = 30_000;
