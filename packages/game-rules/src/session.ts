import {
  asSequenceNumber,
  asServerTimestamp,
  err,
  isSupportedProtocolVersion,
  ok,
  rejection,
  SERVER_ACTOR,
  type Actor,
  type ChallengeState,
  type EventEnvelope,
  type GameMode,
  type GamePhase,
  type IntentEnvelope,
  type PauseReason,
  type PlayerId,
  type PlayerRole,
  type Result,
  type RoomId,
  type RoomState,
  type SequenceNumber,
  type StateSnapshot,
  type TeamId,
  type PlayerState,
  type TeamState,
  PROTOCOL_VERSION,
} from '@bb/protocol';
import type { Clock } from './clock.js';
import { EventLog } from './event-log.js';
import { IntentRegistry } from './idempotency.js';
import { applyTransition, initialPhaseState, type PhaseState } from './transitions.js';
import { STARTING_BB } from './bb.js';

/**
 * Minimal in-memory game session.
 *
 * PURPOSE: prove that the Phase 2 pieces — envelopes, sequence numbers,
 * idempotency, transitions, pause/resume, the event log and snapshots — work
 * together. It is NOT the real game engine.
 *
 * It contains no rounds, no cards, no Market, no Maco Mail, no buzzer and no
 * scoring beyond seeding the locked starting balance. Those are Phases 5-7, and
 * several depend on rules still open in docs/OPEN_RULES.md.
 *
 * Transport-free by design. It takes intents as plain objects and returns
 * events, so it can be driven entirely from deterministic tests.
 */
export class GameSession {
  readonly #clock: Clock;
  readonly #log: EventLog;
  readonly #intents = new IntentRegistry();
  readonly #players = new Map<string, PlayerState>();
  readonly #teams = new Map<string, TeamState>();

  #phaseState: PhaseState = initialPhaseState();
  #challenge: ChallengeState | null = null;
  #room: RoomState;

  constructor(roomId: RoomId, roomCode: string, mode: GameMode, clock: Clock) {
    this.#clock = clock;
    this.#log = new EventLog(roomId, clock);

    const now = asServerTimestamp(clock.now());
    this.#room = {
      roomId,
      roomCode,
      mode,
      phase: this.#phaseState.phase,
      pause: null,
      seq: asSequenceNumber(0),
      createdAt: now,
      updatedAt: now,
    };
  }

  // -------------------------------------------------------------------------
  // Read access
  // -------------------------------------------------------------------------

  get phase(): GamePhase {
    return this.#phaseState.phase;
  }

  get seq(): SequenceNumber {
    return this.#log.latestSeq();
  }

  events(): readonly EventEnvelope[] {
    return this.#log.all();
  }

  eventsSince(seq: SequenceNumber): readonly EventEnvelope[] {
    return this.#log.since(seq);
  }

  team(teamId: TeamId): TeamState | undefined {
    return this.#teams.get(teamId);
  }

  player(playerId: PlayerId): PlayerState | undefined {
    return this.#players.get(playerId);
  }

  // -------------------------------------------------------------------------
  // Setup
  //
  // Direct methods rather than intents: the real join and team-assignment flow
  // is Phase 4, and inventing intent types for it now would prejudge that work.
  // -------------------------------------------------------------------------

  /**
   * Add a team, seeded with the locked starting balance.
   * GAME_RULES_LOCKED.md §1 — "Each team begins with 1,000 BB."
   */
  addTeam(teamId: TeamId, displayName: string): TeamState {
    const team: TeamState = {
      teamId,
      displayName,
      memberIds: [],
      bb: STARTING_BB,
      status: 'active',
    };
    this.#teams.set(teamId, team);
    this.#touch();
    return team;
  }

  addPlayer(
    playerId: PlayerId,
    displayName: string,
    role: PlayerRole,
    teamId: TeamId | null,
  ): PlayerState {
    const player: PlayerState = {
      playerId,
      displayName,
      teamId,
      role,
      connection: 'connected',
      sessionId: null,
      joinedAt: asServerTimestamp(this.#clock.now()),
    };
    this.#players.set(playerId, player);

    if (teamId !== null) {
      const team = this.#teams.get(teamId);
      if (team !== undefined) {
        this.#teams.set(teamId, { ...team, memberIds: [...team.memberIds, playerId] });
      }
    }

    this.#touch();
    return player;
  }

  /** Attach a generic challenge container. Challenge rules are later phases. */
  setChallenge(challenge: ChallengeState | null): void {
    this.#challenge = challenge;
    this.#touch();
  }

  // -------------------------------------------------------------------------
  // Intent handling
  // -------------------------------------------------------------------------

  /**
   * Submit a state-changing intent.
   *
   * Order of checks matters. Protocol version first (an incompatible client
   * cannot be reasoned with), then shape, then deduplication, then the rule
   * itself — so a retry of an accepted intent is never re-evaluated against
   * rules whose answer may since have changed.
   */
  submit(intent: IntentEnvelope, actor: Actor): Result<EventEnvelope> {
    if (!isSupportedProtocolVersion(intent.protocolVersion)) {
      return err(
        rejection('UNSUPPORTED_PROTOCOL_VERSION', 'This client is not compatible with the server.', {
          clientVersion: intent.protocolVersion,
          serverVersion: PROTOCOL_VERSION,
        }),
      );
    }

    if (intent.roomId !== this.#room.roomId) {
      return err(rejection('NOT_FOUND', 'Unknown room.', { roomId: intent.roomId }));
    }

    // Deduplication before evaluation: a retried intent must not apply twice.
    if (this.#intents.has(intent.intentId)) {
      const originalSeq = this.#intents.resultOf(intent.intentId);
      return err(
        rejection('DUPLICATE_INTENT', 'This action was already processed.', {
          intentId: intent.intentId,
          ...(originalSeq === undefined ? {} : { originalSeq }),
        }),
      );
    }

    const outcome = this.#evaluate(intent, actor);
    if (!outcome.ok) return outcome;

    this.#intents.record(intent.intentId, outcome.value.seq);
    return outcome;
  }

  /**
   * Evaluate an intent against the current state.
   *
   * Phase 2 understands only lifecycle intents. Gameplay intents — PLAY_CARD,
   * PURCHASE_ITEM, BUZZ and the rest — are deliberately not implemented; the
   * envelope exists so those phases can add them without reshaping this.
   */
  #evaluate(intent: IntentEnvelope, actor: Actor): Result<EventEnvelope> {
    switch (intent.type) {
      case 'ADVANCE_PHASE': {
        const to = readPhase(intent.payload);
        if (to === null) {
          return err(rejection('INVALID_REQUEST', 'Missing or invalid target phase.'));
        }
        return this.#transition({ kind: 'advance', to }, actor, intent, 'PHASE_ADVANCED');
      }

      case 'PAUSE_GAME': {
        const reason = readPauseReason(intent.payload);
        return this.#transition({ kind: 'pause', reason }, actor, intent, 'GAME_PAUSED');
      }

      case 'HOST_RESUME_GAME':
        // Authority is enforced inside applyTransition, so there is no path
        // that resumes without Host authority.
        return this.#transition({ kind: 'resume' }, actor, intent, 'GAME_RESUMED');

      default:
        return err(
          rejection('INVALID_REQUEST', 'Unknown intent type.', { type: intent.type }),
        );
    }
  }

  #transition(
    action: Parameters<typeof applyTransition>[1],
    actor: Actor,
    intent: IntentEnvelope,
    eventType: string,
  ): Result<EventEnvelope> {
    const outcome = applyTransition(this.#phaseState, action, actor);
    if (!outcome.ok) return err(outcome.error);

    this.#phaseState = outcome.state;

    const event = this.#log.append(
      eventType,
      actor,
      { phase: outcome.state.phase },
      intent.intentId,
    );

    this.#room = {
      ...this.#room,
      phase: outcome.state.phase,
      pause:
        outcome.state.phase === 'PAUSED' && outcome.state.resumePhase !== null
          ? {
              pausedAt: event.serverTime,
              resumePhase: outcome.state.resumePhase,
              reason: outcome.state.pauseReason ?? 'host_requested',
            }
          : null,
      seq: event.seq,
      updatedAt: event.serverTime,
    };

    return ok(event);
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  /**
   * Current authoritative state.
   *
   * CONTENT_POLICY.md — carries no question text, accepted answers or board
   * labels. ChallengeState references configuration, never content.
   */
  snapshot(): StateSnapshot {
    return {
      protocolVersion: PROTOCOL_VERSION,
      seq: this.#log.latestSeq(),
      takenAt: asServerTimestamp(this.#clock.now()),
      room: this.#room,
      players: [...this.#players.values()],
      teams: [...this.#teams.values()],
      challenge: this.#challenge,
    };
  }

  #touch(): void {
    this.#room = { ...this.#room, updatedAt: asServerTimestamp(this.#clock.now()) };
  }
}

// ---------------------------------------------------------------------------
// Payload readers — intents arrive from the network and are not trusted.
// ---------------------------------------------------------------------------

const PHASES = new Set<string>([
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

function readPhase(payload: unknown): GamePhase | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const to = (payload as Record<string, unknown>)['to'];
  if (typeof to !== 'string' || !PHASES.has(to)) return null;
  return to as GamePhase;
}

function readPauseReason(payload: unknown): PauseReason {
  if (typeof payload === 'object' && payload !== null) {
    const reason = (payload as Record<string, unknown>)['reason'];
    if (reason === 'player_disconnect') return 'player_disconnect';
  }
  return 'host_requested';
}

/** Re-exported so callers can build server-authored events. */
export { SERVER_ACTOR };
