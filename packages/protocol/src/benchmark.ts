/**
 * Benchmark-only message vocabulary.
 *
 * ================== THIS IS NOT GAME CODE ==================
 *
 * CLAUDE.md — "There is no digital buzzer before Family Feud." Nothing here is
 * a game mechanic. BENCHMARK_BUZZ is a NETWORK MEASUREMENT PRIMITIVE: the
 * smallest timing-sensitive round trip we can measure, standing in for the kind
 * of interaction Family Feud and Sudden Death will later need.
 *
 * The names are deliberately prefixed BENCHMARK_ so no future reader mistakes
 * this for the Family Feud engine, and so a stray import into game code is
 * obvious on sight.
 *
 * Nothing in this file may be reused by the real buzzer. Family Feud's rules —
 * face-off, control, strikes, steal, the steal wager — are Phase 7, and several
 * of their details are still open in docs/OPEN_RULES.md.
 * ===========================================================
 */

// ---------------------------------------------------------------------------
// Intent types (client -> server)
// ---------------------------------------------------------------------------

export const BENCHMARK_INTENTS = {
  /** Identify or re-identify a synthetic/benchmark client. */
  HELLO: 'BENCHMARK_HELLO',
  /** Round-trip probe for RTT and clock-offset estimation. */
  PING: 'BENCHMARK_PING',
  /** Timing-sensitive submission. Not a game buzzer. */
  BUZZ: 'BENCHMARK_BUZZ',
  /** Host: open the benchmark buzzer. */
  OPEN_BUZZER: 'BENCHMARK_OPEN_BUZZER',
  /** Host: close and clear the benchmark buzzer. */
  RESET_BUZZER: 'BENCHMARK_RESET_BUZZER',
  /** Host: start a benchmark deadline. */
  START_TIMER: 'BENCHMARK_START_TIMER',
  /** Host: pause the benchmark session. */
  PAUSE: 'BENCHMARK_PAUSE',
  /** Host: resume. Host-only, enforced server-side. */
  RESUME: 'BENCHMARK_RESUME',
  /** Host: clear collected statistics. */
  CLEAR_STATS: 'BENCHMARK_CLEAR_STATS',
  /** Request a fresh authoritative snapshot. */
  REQUEST_SNAPSHOT: 'BENCHMARK_REQUEST_SNAPSHOT',
} as const;

export type BenchmarkIntentType =
  (typeof BENCHMARK_INTENTS)[keyof typeof BENCHMARK_INTENTS];

// ---------------------------------------------------------------------------
// Event types (server -> client)
// ---------------------------------------------------------------------------

export const BENCHMARK_EVENTS = {
  WELCOME: 'BENCHMARK_WELCOME',
  SNAPSHOT: 'BENCHMARK_SNAPSHOT',
  BUZZER_OPENED: 'BENCHMARK_BUZZER_OPENED',
  BUZZ_ACCEPTED: 'BENCHMARK_BUZZ_ACCEPTED',
  BUZZER_RESET: 'BENCHMARK_BUZZER_RESET',
  TIMER_STARTED: 'BENCHMARK_TIMER_STARTED',
  PAUSED: 'BENCHMARK_PAUSED',
  RESUMED: 'BENCHMARK_RESUMED',
  CLIENT_JOINED: 'BENCHMARK_CLIENT_JOINED',
  CLIENT_LEFT: 'BENCHMARK_CLIENT_LEFT',
  STATS_CLEARED: 'BENCHMARK_STATS_CLEARED',
} as const;

export type BenchmarkEventType =
  (typeof BENCHMARK_EVENTS)[keyof typeof BENCHMARK_EVENTS];

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/**
 * Benchmark client identity.
 *
 * NOT the production player system. Phase 4 builds real room codes, QR joining,
 * names, teams and reconnect tokens. This is the minimum needed to test that a
 * reconnecting socket can reclaim the same identity, and nothing more.
 */
export interface BenchmarkHelloPayload {
  /** Stable across reconnects. Supplied by the client; no authentication. */
  readonly benchmarkClientId: string;
  readonly isHost: boolean;
  readonly label?: string;
}

export interface BenchmarkPingPayload {
  /** Echoed back unchanged so the client can match reply to request. */
  readonly pingId: string;
  /**
   * The client's own clock reading when it sent this.
   *
   * FOR DISPLAY ONLY. ARCHITECTURE.md §6 — a client's claimed time never
   * decides anything. The server echoes it so the client can compute its own
   * offset; the server itself never compares it against anything.
   */
  readonly clientSentAt: number;
}

export interface BenchmarkPongPayload {
  readonly pingId: string;
  readonly clientSentAt: number;
  /** Authoritative server time when the ping was processed. */
  readonly serverTime: number;
}

export interface BenchmarkBuzzPayload {
  /**
   * Client-side send time, recorded FOR ANALYSIS ONLY.
   *
   * The server determines the winner purely by receive order and never reads
   * this field when deciding. It exists so the benchmark can report how a
   * known transmit schedule maps to server acceptance.
   */
  readonly clientSentAt: number;
}

export interface BenchmarkBuzzerOpenedPayload {
  /** Authoritative open time. Buzzes received before this are rejected. */
  readonly openedAt: number;
  readonly round: number;
}

export interface BenchmarkBuzzAcceptedPayload {
  readonly benchmarkClientId: string;
  readonly connectionId: string;
  readonly serverTime: number;
  /** Server receive time minus buzzer open time. */
  readonly elapsedSinceOpenMs: number;
  readonly round: number;
}

export interface BenchmarkTimerStartedPayload {
  readonly startedAt: number;
  readonly durationMs: number;
}

/** Everything a benchmark UI needs to render current state. */
export interface BenchmarkSnapshotPayload {
  readonly protocolVersion: number;
  readonly transport: string;
  readonly seq: number;
  readonly serverTime: number;
  readonly phase: string;
  readonly paused: boolean;
  readonly buzzerOpen: boolean;
  readonly buzzerRound: number;
  readonly acceptedBuzz: BenchmarkBuzzAcceptedPayload | null;
  readonly timer: {
    readonly active: boolean;
    readonly durationMs: number;
    readonly remainingMs: number;
    readonly paused: boolean;
  };
  readonly clients: readonly {
    readonly benchmarkClientId: string;
    readonly connected: boolean;
    readonly isHost: boolean;
    readonly label: string;
  }[];
}
