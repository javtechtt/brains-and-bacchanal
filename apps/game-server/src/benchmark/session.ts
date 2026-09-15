import {
  asIntentId,
  asSequenceNumber,
  asServerTimestamp,
  BENCHMARK_EVENTS,
  BENCHMARK_INTENTS,
  PROTOCOL_VERSION,
  isSupportedProtocolVersion,
  rejection,
  type Actor,
  type BenchmarkBuzzAcceptedPayload,
  type BenchmarkSnapshotPayload,
  type ConnectionId,
  type EventEnvelope,
  type IntentAck,
  type IntentEnvelope,
  type SequenceNumber,
} from '@bb/protocol';
import {
  FakeClock,
  SystemClock,
  hasExpired,
  pauseDeadline,
  remainingMs,
  resumeDeadline,
  startDeadline,
  type Clock,
  type Deadline,
} from '@bb/game-rules';

/**
 * Benchmark session.
 *
 * ================== DEVELOPMENT INSTRUMENT, NOT THE GAME ==================
 *
 * This exists to measure a transport. It is not the game engine and must never
 * become it.
 *
 * The "buzzer" here is a network measurement primitive. CLAUDE.md is explicit
 * that there is no digital buzzer before Family Feud, and the real Family Feud
 * rules (face-off, control, strikes, steal, wager) are Phase 7 with several
 * details still open in docs/OPEN_RULES.md. Nothing here anticipates them.
 *
 * There is no BB, no card, no Market, no Maco Mail and no round logic in this
 * file, by design.
 * =========================================================================
 *
 * What it does reuse from Phase 2, deliberately, so the benchmark exercises the
 * real primitives rather than a parallel implementation:
 *   - intent deduplication,
 *   - monotonic sequence numbers and server timestamps,
 *   - pausable deadlines,
 *   - Host-only resume.
 */

interface BenchmarkClient {
  readonly benchmarkClientId: string;
  connectionId: ConnectionId | null;
  isHost: boolean;
  label: string;
  connected: boolean;
}

export interface AcceptedBuzz extends BenchmarkBuzzAcceptedPayload {
  readonly seq: SequenceNumber;
}

export class BenchmarkSession {
  readonly #clock: Clock;

  /** benchmarkClientId -> client. Survives reconnects. */
  readonly #clients = new Map<string, BenchmarkClient>();
  /** connectionId -> benchmarkClientId, for the current sockets only. */
  readonly #byConnection = new Map<ConnectionId, string>();

  /** Intent deduplication, mirroring the Phase 2 IntentRegistry contract. */
  readonly #seenIntents = new Map<string, SequenceNumber>();

  #seq = 0;
  #paused = false;
  #buzzerOpen = false;
  #buzzerOpenedAt = 0;
  #buzzerRound = 0;
  #acceptedBuzz: AcceptedBuzz | null = null;
  #timer: Deadline | null = null;

  /** Buzzes rejected because the buzzer was already locked or closed. */
  #rejectedBuzzes = 0;

  constructor(clock: Clock = new SystemClock()) {
    this.#clock = clock;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  onDisconnect(connectionId: ConnectionId): string | null {
    const clientId = this.#byConnection.get(connectionId);
    if (clientId === undefined) return null;

    this.#byConnection.delete(connectionId);
    const client = this.#clients.get(clientId);
    if (client !== undefined) {
      // The identity survives; only the socket is gone. That is what makes a
      // reconnect test meaningful.
      client.connected = false;
      client.connectionId = null;
    }
    return clientId;
  }

  // -------------------------------------------------------------------------
  // Intent handling
  // -------------------------------------------------------------------------

  /**
   * Handle one intent.
   *
   * Returns the acknowledgement plus any events to publish. The caller owns
   * delivery, so this stays transport-free and directly unit-testable.
   */
  handle(
    connectionId: ConnectionId,
    intent: IntentEnvelope,
  ): { ack: IntentAck; events: EventEnvelope[] } {
    if (!isSupportedProtocolVersion(intent.protocolVersion)) {
      return this.#reject(
        rejection('UNSUPPORTED_PROTOCOL_VERSION', 'Incompatible client.', {
          clientVersion: intent.protocolVersion,
          serverVersion: PROTOCOL_VERSION,
        }),
      );
    }

    // Deduplicate BEFORE evaluating, so a retry is never re-judged against
    // state that may have changed since the original attempt.
    const priorSeq = this.#seenIntents.get(intent.intentId);
    if (priorSeq !== undefined) {
      return this.#reject(
        rejection('DUPLICATE_INTENT', 'This action was already processed.', {
          intentId: intent.intentId,
          // Telling the client WHICH event the original produced is what lets
          // it distinguish "already done" from "never happened".
          originalSeq: priorSeq,
        }),
      );
    }

    const outcome = this.#evaluate(connectionId, intent);

    if (outcome.ack.ok) {
      this.#seenIntents.set(intent.intentId, outcome.ack.seq);
    }
    return outcome;
  }

  #evaluate(
    connectionId: ConnectionId,
    intent: IntentEnvelope,
  ): { ack: IntentAck; events: EventEnvelope[] } {
    switch (intent.type) {
      case BENCHMARK_INTENTS.HELLO:
        return this.#hello(connectionId, intent);
      case BENCHMARK_INTENTS.PING:
        return this.#ping();
      case BENCHMARK_INTENTS.BUZZ:
        return this.#buzz(connectionId, intent);
      case BENCHMARK_INTENTS.OPEN_BUZZER:
        return this.#openBuzzer(connectionId, intent);
      case BENCHMARK_INTENTS.RESET_BUZZER:
        return this.#resetBuzzer(connectionId, intent);
      case BENCHMARK_INTENTS.START_TIMER:
        return this.#startTimer(connectionId, intent);
      case BENCHMARK_INTENTS.PAUSE:
        return this.#pause(connectionId, intent);
      case BENCHMARK_INTENTS.RESUME:
        return this.#resume(connectionId, intent);
      case BENCHMARK_INTENTS.CLEAR_STATS:
        return this.#clearStats(connectionId, intent);
      case BENCHMARK_INTENTS.REQUEST_SNAPSHOT:
        return this.#snapshotAck(intent);
      default:
        return this.#reject(
          rejection('INVALID_REQUEST', 'Unknown intent type.', { type: intent.type }),
        );
    }
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  #hello(
    connectionId: ConnectionId,
    intent: IntentEnvelope,
  ): { ack: IntentAck; events: EventEnvelope[] } {
    const payload = intent.payload as Record<string, unknown>;
    const benchmarkClientId = payload['benchmarkClientId'];
    if (typeof benchmarkClientId !== 'string' || benchmarkClientId.length === 0) {
      return this.#reject(rejection('INVALID_REQUEST', 'Missing benchmarkClientId.'));
    }

    const isHost = payload['isHost'] === true;
    const label = typeof payload['label'] === 'string' ? payload['label'] : benchmarkClientId;

    // Reclaiming an existing identity is the reconnect path: same client id,
    // new connection, no duplicate client created.
    const existing = this.#clients.get(benchmarkClientId);
    if (existing !== undefined) {
      existing.connectionId = connectionId;
      existing.connected = true;
      existing.isHost = isHost;
      existing.label = label;
    } else {
      this.#clients.set(benchmarkClientId, {
        benchmarkClientId,
        connectionId,
        isHost,
        label,
        connected: true,
      });
    }

    this.#byConnection.set(connectionId, benchmarkClientId);

    const event = this.#emit(BENCHMARK_EVENTS.CLIENT_JOINED, this.#actorFor(connectionId), {
      benchmarkClientId,
      reconnected: existing !== undefined,
      snapshot: this.snapshot(),
    });

    return { ack: { ok: true, seq: event.seq }, events: [event] };
  }

  #ping(): { ack: IntentAck; events: EventEnvelope[] } {
    // A ping changes no state, so it takes a sequence number but publishes no
    // event. The ack itself is the reply the client times.
    const seq = this.#nextSeq();
    return { ack: { ok: true, seq }, events: [] };
  }

  // -------------------------------------------------------------------------
  // Buzzer — SERVER-AUTHORITATIVE, receive-order only
  // -------------------------------------------------------------------------

  #openBuzzer(
    connectionId: ConnectionId,
    intent: IntentEnvelope,
  ): { ack: IntentAck; events: EventEnvelope[] } {
    const denial = this.#requireHost(connectionId);
    if (denial !== null) return denial;

    // Rule 1: paused sessions must not advance benchmark gameplay. Opening the
    // buzzer while paused is gameplay progress, not a safe non-gameplay action.
    if (this.#paused) {
      return this.#reject(rejection('WRONG_STATE', 'The session is paused.'));
    }

    // Rule 2: an already-open buzzer must reject a second open outright — no
    // new BENCHMARK_BUZZER_OPENED event and no round increment. Without this,
    // two Host clicks (or one slow ack followed by a retry with a fresh
    // intentId, which Phase 2 deduplication cannot catch since it is a
    // different intent) silently re-arm the buzzer and corrupt the round
    // count, which is exactly what real-device testing surfaced.
    if (this.#buzzerOpen) {
      return this.#reject(
        rejection('WRONG_STATE', 'The buzzer is already open.', {
          round: this.#buzzerRound,
        }),
      );
    }

    // Rule 3: an accepted buzz locks the round. Opening again requires an
    // explicit Host reset first, so a trial's winner is never silently
    // overwritten by re-opening on top of it.
    if (this.#acceptedBuzz !== null) {
      return this.#reject(
        rejection('WRONG_STATE', 'Reset the buzzer before opening the next round.', {
          winner: this.#acceptedBuzz.benchmarkClientId,
        }),
      );
    }

    this.#buzzerOpen = true;
    this.#buzzerOpenedAt = this.#clock.now();
    this.#buzzerRound += 1;
    this.#acceptedBuzz = null;

    const event = this.#emit(
      BENCHMARK_EVENTS.BUZZER_OPENED,
      this.#actorFor(connectionId),
      { openedAt: this.#buzzerOpenedAt, round: this.#buzzerRound },
      intent.intentId,
    );
    return { ack: { ok: true, seq: event.seq }, events: [event] };
  }

  /**
   * Accept the first valid buzz RECEIVED after opening.
   *
   * The winner is decided purely by the order this method is reached. The
   * client's own `clientSentAt` is recorded for analysis and never compared —
   * ARCHITECTURE.md §6, and CLAUDE.md's rule that browser code never decides
   * who buzzed first.
   *
   * No latency compensation is applied. Phase 3 measures; it does not correct.
   */
  #buzz(
    connectionId: ConnectionId,
    intent: IntentEnvelope,
  ): { ack: IntentAck; events: EventEnvelope[] } {
    if (this.#paused) {
      this.#rejectedBuzzes += 1;
      return this.#reject(rejection('WRONG_STATE', 'The session is paused.'));
    }

    if (!this.#buzzerOpen) {
      this.#rejectedBuzzes += 1;
      return this.#reject(rejection('ILLEGAL_ACTION', 'The buzzer is not open.'));
    }

    if (this.#acceptedBuzz !== null) {
      this.#rejectedBuzzes += 1;
      return this.#reject(
        rejection('CONFLICT', 'Another client buzzed first.', {
          winner: this.#acceptedBuzz.benchmarkClientId,
        }),
      );
    }

    const clientId = this.#byConnection.get(connectionId);
    if (clientId === undefined) {
      this.#rejectedBuzzes += 1;
      return this.#reject(rejection('NOT_FOUND', 'Unknown benchmark client.'));
    }

    const serverTime = this.#clock.now();
    const payload: BenchmarkBuzzAcceptedPayload = {
      benchmarkClientId: clientId,
      connectionId,
      serverTime,
      elapsedSinceOpenMs: serverTime - this.#buzzerOpenedAt,
      round: this.#buzzerRound,
    };

    const event = this.#emit(
      BENCHMARK_EVENTS.BUZZ_ACCEPTED,
      this.#actorFor(connectionId),
      payload,
      intent.intentId,
    );

    // Lock immediately so every later buzz in this round is rejected.
    this.#acceptedBuzz = { ...payload, seq: event.seq };

    return { ack: { ok: true, seq: event.seq }, events: [event] };
  }

  #resetBuzzer(
    connectionId: ConnectionId,
    intent: IntentEnvelope,
  ): { ack: IntentAck; events: EventEnvelope[] } {
    const denial = this.#requireHost(connectionId);
    if (denial !== null) return denial;

    this.#buzzerOpen = false;
    this.#acceptedBuzz = null;

    const event = this.#emit(
      BENCHMARK_EVENTS.BUZZER_RESET,
      this.#actorFor(connectionId),
      {},
      intent.intentId,
    );
    return { ack: { ok: true, seq: event.seq }, events: [event] };
  }

  // -------------------------------------------------------------------------
  // Timer
  // -------------------------------------------------------------------------

  #startTimer(
    connectionId: ConnectionId,
    intent: IntentEnvelope,
  ): { ack: IntentAck; events: EventEnvelope[] } {
    const denial = this.#requireHost(connectionId);
    if (denial !== null) return denial;

    // Rule 1: starting a timer is gameplay progress and must not be allowed
    // while paused.
    if (this.#paused) {
      return this.#reject(rejection('WRONG_STATE', 'The session is paused.'));
    }

    const payload = intent.payload as Record<string, unknown>;
    const durationMs = typeof payload['durationMs'] === 'number' ? payload['durationMs'] : 30_000;
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return this.#reject(rejection('INVALID_REQUEST', 'Invalid timer duration.'));
    }

    this.#timer = startDeadline(this.#clock, durationMs);

    const event = this.#emit(
      BENCHMARK_EVENTS.TIMER_STARTED,
      this.#actorFor(connectionId),
      { startedAt: this.#timer.startedAt, durationMs },
      intent.intentId,
    );
    return { ack: { ok: true, seq: event.seq }, events: [event] };
  }

  // -------------------------------------------------------------------------
  // Pause / resume — Phase 2 design preserved exactly
  // -------------------------------------------------------------------------

  #pause(
    connectionId: ConnectionId,
    intent: IntentEnvelope,
  ): { ack: IntentAck; events: EventEnvelope[] } {
    const denial = this.#requireHost(connectionId);
    if (denial !== null) return denial;

    // Pausing twice must not corrupt state or double-bank paused time.
    if (this.#paused) {
      return this.#reject(rejection('WRONG_STATE', 'Already paused.'));
    }

    this.#paused = true;
    if (this.#timer !== null) this.#timer = pauseDeadline(this.#clock, this.#timer);

    const event = this.#emit(
      BENCHMARK_EVENTS.PAUSED,
      this.#actorFor(connectionId),
      {},
      intent.intentId,
    );
    return { ack: { ok: true, seq: event.seq }, events: [event] };
  }

  /**
   * Resume. HOST ONLY.
   *
   * GAME_RULES_LOCKED.md §20 / DECISION_LOG.md D-011 — reconnecting does not
   * resume, only the Host resumes. #requireHost is the single gate; there is
   * no reconnect path and no transport path around it.
   */
  #resume(
    connectionId: ConnectionId,
    intent: IntentEnvelope,
  ): { ack: IntentAck; events: EventEnvelope[] } {
    const denial = this.#requireHost(connectionId);
    if (denial !== null) return denial;

    if (!this.#paused) {
      return this.#reject(rejection('WRONG_STATE', 'Not paused.'));
    }

    this.#paused = false;
    if (this.#timer !== null) this.#timer = resumeDeadline(this.#clock, this.#timer);

    const event = this.#emit(
      BENCHMARK_EVENTS.RESUMED,
      this.#actorFor(connectionId),
      {},
      intent.intentId,
    );
    return { ack: { ok: true, seq: event.seq }, events: [event] };
  }

  #clearStats(
    connectionId: ConnectionId,
    intent: IntentEnvelope,
  ): { ack: IntentAck; events: EventEnvelope[] } {
    const denial = this.#requireHost(connectionId);
    if (denial !== null) return denial;

    this.#rejectedBuzzes = 0;
    const event = this.#emit(
      BENCHMARK_EVENTS.STATS_CLEARED,
      this.#actorFor(connectionId),
      {},
      intent.intentId,
    );
    return { ack: { ok: true, seq: event.seq }, events: [event] };
  }

  #snapshotAck(intent: IntentEnvelope): { ack: IntentAck; events: EventEnvelope[] } {
    const event = this.#emit(
      BENCHMARK_EVENTS.SNAPSHOT,
      { kind: 'server' },
      this.snapshot(),
      intent.intentId,
    );
    return { ack: { ok: true, seq: event.seq }, events: [event] };
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  snapshot(): BenchmarkSnapshotPayload {
    const timerState =
      this.#timer === null
        ? { active: false, durationMs: 0, remainingMs: 0, paused: false }
        : {
            active: !hasExpired(this.#clock, this.#timer),
            durationMs: this.#timer.durationMs,
            remainingMs: remainingMs(this.#clock, this.#timer),
            paused: this.#timer.pausedAt !== null,
          };

    return {
      protocolVersion: PROTOCOL_VERSION,
      transport: 'n/a',
      seq: this.#seq,
      serverTime: this.#clock.now(),
      phase: this.#paused ? 'PAUSED' : 'ACTIVE_PLAY',
      paused: this.#paused,
      buzzerOpen: this.#buzzerOpen,
      buzzerRound: this.#buzzerRound,
      acceptedBuzz: this.#acceptedBuzz,
      timer: timerState,
      clients: [...this.#clients.values()].map((c) => ({
        benchmarkClientId: c.benchmarkClientId,
        connected: c.connected,
        isHost: c.isHost,
        label: c.label,
      })),
    };
  }

  get rejectedBuzzes(): number {
    return this.#rejectedBuzzes;
  }

  get seq(): number {
    return this.#seq;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get acceptedBuzz(): AcceptedBuzz | null {
    return this.#acceptedBuzz;
  }

  clientCount(): number {
    return this.#clients.size;
  }

  connectedClientCount(): number {
    return [...this.#clients.values()].filter((c) => c.connected).length;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Host authority check. Returns a denial, or null when permitted. */
  #requireHost(
    connectionId: ConnectionId,
  ): { ack: IntentAck; events: EventEnvelope[] } | null {
    const clientId = this.#byConnection.get(connectionId);
    const client = clientId === undefined ? undefined : this.#clients.get(clientId);

    if (client === undefined || !client.isHost) {
      return this.#reject(
        rejection('UNAUTHORIZED_ACTOR', 'Only the benchmark Host may do this.'),
      );
    }
    return null;
  }

  #actorFor(connectionId: ConnectionId): Actor {
    const clientId = this.#byConnection.get(connectionId);
    const client = clientId === undefined ? undefined : this.#clients.get(clientId);
    if (client === undefined) return { kind: 'server' };
    // Benchmark clients are not real sessions; the connection id stands in.
    return client.isHost
      ? { kind: 'host', sessionId: connectionId as never }
      : { kind: 'player', sessionId: connectionId as never, playerId: clientId as never };
  }

  #nextSeq(): SequenceNumber {
    this.#seq += 1;
    return asSequenceNumber(this.#seq);
  }

  #emit(type: string, actor: Actor, payload: unknown, causedBy?: string): EventEnvelope {
    return {
      protocolVersion: PROTOCOL_VERSION,
      seq: this.#nextSeq(),
      serverTime: asServerTimestamp(this.#clock.now()),
      roomId: 'benchmark' as never,
      actor,
      type,
      payload,
      ...(causedBy === undefined ? {} : { causedBy: asIntentId(causedBy) }),
    };
  }

  #reject(error: ReturnType<typeof rejection>): { ack: IntentAck; events: EventEnvelope[] } {
    return { ack: { ok: false, error }, events: [] };
  }
}

/** Exported for deterministic tests. */
export { FakeClock };
