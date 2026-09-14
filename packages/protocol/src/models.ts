import type { GamePhase } from './lifecycle.js';
import type {
  ChallengeId,
  PlayerId,
  RoomId,
  SequenceNumber,
  ServerTimestamp,
  SessionId,
  TeamId,
} from './ids.js';

/**
 * Generic domain models shared by the server, the web clients and Unity.
 *
 * These describe SHAPE, not rules. There is no card inventory, no Market
 * basket, no Maco Mail hand and no round-specific field here — those belong to
 * Phase 6 and later, and several depend on rules still open.
 */

// ---------------------------------------------------------------------------
// Room / session
// ---------------------------------------------------------------------------

/**
 * ARCHITECTURE.md §9 — the same game core serves a local LAN party and an
 * online game. The mode changes deployment, not rules.
 */
export type GameMode = 'local_party' | 'online';

export interface RoomState {
  readonly roomId: RoomId;
  /**
   * Short human-readable code players type to join.
   *
   * ARCHITECTURE.md §10 — "room codes are convenience IDs, not authentication."
   * Generation and the join flow are Phase 4; this is the field they will fill.
   */
  readonly roomCode: string;
  readonly mode: GameMode;
  readonly phase: GamePhase;
  /**
   * Set when the game is paused, recording where to return to.
   *
   * GAME_RULES_LOCKED.md §20 / DECISION_LOG.md D-011 — only the Host resumes,
   * and the game returns to what it was doing.
   */
  readonly pause: PauseState | null;
  /** Highest sequence number assigned so far. Monotonic per room. */
  readonly seq: SequenceNumber;
  readonly createdAt: ServerTimestamp;
  readonly updatedAt: ServerTimestamp;
}

/**
 * Why the game is paused and where it returns to.
 *
 * `resumePhase` is captured at pause time rather than recomputed, so a resume
 * cannot drift to a different phase than the one play was suspended from.
 */
export interface PauseState {
  readonly pausedAt: ServerTimestamp;
  /** The phase to restore on resume. */
  readonly resumePhase: GamePhase;
  /**
   * Why the game paused. Kept generic: Phase 2 does not implement disconnect
   * detection, so `player_disconnect` is a value the later phase will supply.
   */
  readonly reason: PauseReason;
}

export type PauseReason = 'host_requested' | 'player_disconnect';

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

/**
 * A player's role.
 *
 * The Host is not a player and does not belong to a team; the role is recorded
 * here because Host authority is checked on actions.
 */
export type PlayerRole = 'player' | 'host' | 'admin';

export type ConnectionState = 'connected' | 'disconnected';

export interface PlayerState {
  readonly playerId: PlayerId;
  readonly displayName: string;
  /** Null until assigned, and for Host/admin who never join a team. */
  readonly teamId: TeamId | null;
  readonly role: PlayerRole;
  readonly connection: ConnectionState;
  /**
   * Current session. Replaced on reconnect.
   *
   * GAME_RULES_LOCKED.md §20 — a reconnecting player "should return to same
   * team/game/session where possible", so playerId is stable while sessionId
   * may change. Real tokens and authentication are not Phase 2.
   */
  readonly sessionId: SessionId | null;
  readonly joinedAt: ServerTimestamp;
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export type TeamStatus =
  | 'active'
  /**
   * Still in the game but barred from earning further BB in the current
   * section. GAME_RULES_LOCKED.md §18 creates exactly this situation in
   * three-team Round 4, where the losing team "stays in overall game", "keeps
   * BB already earned" and "cannot earn further Family Feud BB".
   *
   * Phase 2 only provides the status. Which rounds apply it is Phase 7.
   */
  | 'sitting_out'
  | 'eliminated';

export interface TeamState {
  readonly teamId: TeamId;
  readonly displayName: string;
  readonly memberIds: readonly PlayerId[];
  /**
   * BB balance — both spendable currency and final score.
   * GAME_RULES_LOCKED.md §1: teams begin with 1,000 BB and BB cannot go below 0.
   */
  readonly bb: number;
  readonly status: TeamStatus;
}

// ---------------------------------------------------------------------------
// Challenge
// ---------------------------------------------------------------------------

export type ChallengeStatus = 'pending' | 'active' | 'awaiting_host' | 'resolved';

/**
 * A generic challenge container.
 *
 * DELIBERATELY EMPTY OF GAME RULES. There is no board, no strike count, no
 * answer pool, no logo list and no scoring here. Think Fast, Guess the Logo,
 * All Answers Begin With, Sing a Song and Family Feud each carry rules that are
 * either later-phase work or still open in docs/OPEN_RULES.md.
 *
 * `challengeType` is a plain string rather than a union for the same reason:
 * committing to the set now would imply decisions about round composition that
 * OPEN_RULES.md §1 leaves open.
 */
export interface ChallengeState {
  readonly challengeId: ChallengeId;
  readonly challengeType: string;
  readonly status: ChallengeStatus;
  /** The team whose turn it is, where the challenge is turn-based. */
  readonly activeTeamId: TeamId | null;
  /**
   * The nominated player, where a challenge nominates one.
   * GAME_RULES_LOCKED.md §11 nominates players per difficulty in Round 1.
   */
  readonly activePlayerId: PlayerId | null;
  readonly startedAt: ServerTimestamp | null;
  /** Active deadline, if this challenge is timed. See deadline.ts. */
  readonly deadline: DeadlineRef | null;
  /** Populated once resolved. Shape is intentionally open. */
  readonly result: ChallengeResult | null;
  /**
   * Opaque reference to configuration for this challenge type.
   *
   * OPEN_RULES.md requires timers and scoring to stay configuration-driven
   * (§5 "Keep it configurable", §11 "Keep timers configuration-driven"). This
   * is where that configuration will be referenced, not inlined.
   */
  readonly configRef: string | null;
}

/** Reference to a deadline owned by the server's timer service. */
export interface DeadlineRef {
  readonly startedAt: ServerTimestamp;
  readonly durationMs: number;
  /** Time already spent paused, excluded from elapsed time. */
  readonly accumulatedPauseMs: number;
  /** Set while paused. */
  readonly pausedAt: ServerTimestamp | null;
}

/**
 * Generic challenge outcome.
 *
 * Records who won and what BB moved, without saying how that was decided.
 * Award amounts come from locked rules or Host rulings in later phases.
 */
export interface ChallengeResult {
  readonly winningTeamIds: readonly TeamId[];
  /** BB deltas applied by this challenge, keyed by team. */
  readonly bbDeltas: Readonly<Record<string, number>>;
  readonly resolvedAt: ServerTimestamp;
  /** Set when a Host ruling decided this. CLAUDE.md — Host decisions are recorded. */
  readonly decidedByHost: boolean;
}
