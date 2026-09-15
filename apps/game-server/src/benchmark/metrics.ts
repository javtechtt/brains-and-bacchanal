/**
 * Metric definitions — DEVELOPMENT ONLY.
 *
 * The formulas live here, in one place, and are documented identically in
 * docs/NETWORK_BENCHMARK.md. Both transports are measured by this same code so
 * the numbers are comparable. Nothing here favours either transport.
 */

/**
 * Percentile by nearest-rank on the sorted sample.
 *
 * Nearest-rank rather than interpolation: with the small samples a party game
 * benchmark produces, interpolation invents values that were never observed.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] ?? 0;
}

export function median(samples: readonly number[]): number {
  return percentile(samples, 50);
}

export function mean(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

/**
 * Jitter — mean absolute difference between CONSECUTIVE RTT samples.
 *
 *   jitter = mean( |rtt[i] - rtt[i-1]| )   for i = 1..n-1
 *
 * This is the IETF RFC 3550-style interarrival notion rather than standard
 * deviation. For a buzzer, what hurts is one round trip differing sharply from
 * the one before it, which is exactly what this measures; standard deviation
 * would hide that inside an overall spread.
 */
export function jitter(rtts: readonly number[]): number {
  if (rtts.length < 2) return 0;
  const deltas: number[] = [];
  for (let i = 1; i < rtts.length; i += 1) {
    const current = rtts[i];
    const previous = rtts[i - 1];
    if (current === undefined || previous === undefined) continue;
    deltas.push(Math.abs(current - previous));
  }
  return mean(deltas);
}

/**
 * Round-trip time, measured entirely on the client's own clock.
 *
 *   rtt = clientReceivedAt - clientSentAt
 *
 * Both readings come from ONE clock, so no clock synchronisation is involved
 * and no client/server clock skew can contaminate it.
 */
export function rtt(clientSentAt: number, clientReceivedAt: number): number {
  return clientReceivedAt - clientSentAt;
}

/**
 * Estimated client-to-server clock offset (NTP-style).
 *
 *   offset = serverTime - (clientSentAt + rtt / 2)
 *
 * Assumes a symmetric path, which is why it is FOR DISPLAY ONLY. A client uses
 * it to render a countdown that roughly agrees with other devices. It never
 * decides a buzzer winner, deadline acceptance or event ordering — those are
 * server-side facts (ARCHITECTURE.md §6).
 */
export function clockOffset(
  clientSentAt: number,
  serverTime: number,
  clientReceivedAt: number,
): number {
  return serverTime - (clientSentAt + (clientReceivedAt - clientSentAt) / 2);
}

/**
 * Timer display drift — how far a client's rendered remaining time sits from
 * the server's authoritative remaining time.
 *
 *   drift = |clientDisplayedRemainingMs - serverRemainingMs|
 *
 * A display concern only. The server's value is always the real one.
 */
export function timerDrift(clientRemainingMs: number, serverRemainingMs: number): number {
  return Math.abs(clientRemainingMs - serverRemainingMs);
}

export interface RttSummary {
  readonly count: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly jitterMs: number;
}

export function summarizeRtt(samples: readonly number[]): RttSummary {
  return {
    count: samples.length,
    medianMs: round2(median(samples)),
    p95Ms: round2(percentile(samples, 95)),
    p99Ms: round2(percentile(samples, 99)),
    minMs: samples.length === 0 ? 0 : round2(Math.min(...samples)),
    maxMs: samples.length === 0 ? 0 : round2(Math.max(...samples)),
    jitterMs: round2(jitter(samples)),
  };
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
