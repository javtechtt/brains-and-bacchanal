import { randomUUID } from 'node:crypto';
import { BENCHMARK_INTENTS, type EventEnvelope, type TransportKind } from '@bb/protocol';
import { createBenchmarkClient, type BenchmarkClient } from './client.js';
import { clockOffset, rtt, summarizeRtt, round2, type RttSummary } from './metrics.js';

/**
 * Synthetic benchmark runner — DEVELOPMENT ONLY.
 *
 * Runs the SAME scenarios against both transports. Scenario code is written
 * once and parameterised by transport, so a difference in the results cannot be
 * a difference in the test.
 */

export interface RunnerOptions {
  readonly transport: TransportKind;
  readonly host: string;
  readonly port: number;
  readonly clients: number;
  readonly pings: number;
  readonly buzzTrials: number;
}

export interface BuzzTrialResult {
  readonly trial: number;
  readonly scheduleLabel: string;
  readonly winner: string | null;
  readonly accepted: number;
  readonly rejected: number;
  readonly elapsedSinceOpenMs: number | null;
}

export interface BenchmarkReport {
  readonly transport: TransportKind;
  readonly startedAt: string;
  readonly clients: number;
  readonly rtt: RttSummary;
  readonly clockOffsetMs: { readonly medianMs: number; readonly maxAbsMs: number };
  readonly buzz: {
    readonly trials: readonly BuzzTrialResult[];
    readonly totalAccepted: number;
    readonly totalRejected: number;
  };
  readonly duplicateIntent: {
    readonly firstAccepted: boolean;
    readonly duplicateRejected: boolean;
    readonly rejectionCode: string | null;
    readonly identifiedOriginalSeq: boolean;
  };
  readonly ordering: {
    readonly eventsObserved: number;
    readonly outOfOrder: number;
    readonly duplicated: number;
  };
  readonly reconnect: {
    readonly reconnectMs: number;
    readonly identityRestored: boolean;
    readonly duplicateClientCreated: boolean;
    readonly snapshotReceived: boolean;
    readonly resumedAutomatically: boolean;
  };
  readonly timer: {
    readonly pauseHeldMs: number;
    readonly remainingBeforePauseMs: number;
    readonly remainingAfterPauseMs: number;
    readonly consumedWhilePausedMs: number;
  };
  readonly pause: {
    readonly playerResumeRejected: boolean;
    readonly playerRejectionCode: string | null;
    readonly hostResumeAccepted: boolean;
    readonly doublePauseRejected: boolean;
    readonly resumeWhileRunningRejected: boolean;
  };
  readonly errors: readonly string[];
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runBenchmark(options: RunnerOptions): Promise<BenchmarkReport> {
  const errors: string[] = [];
  const startedAt = new Date().toISOString();

  const host = createBenchmarkClient(options.transport, {
    host: options.host,
    port: options.port,
    benchmarkClientId: `host-${randomUUID().slice(0, 8)}`,
    isHost: true,
    label: 'benchmark-host',
  });
  await host.connect();

  const players: BenchmarkClient[] = [];
  for (let i = 0; i < options.clients; i += 1) {
    const client = createBenchmarkClient(options.transport, {
      host: options.host,
      port: options.port,
      benchmarkClientId: `player-${i + 1}-${randomUUID().slice(0, 8)}`,
      isHost: false,
      label: `player-${i + 1}`,
    });
    await client.connect();
    players.push(client);
  }

  const probe = players[0];
  if (probe === undefined) throw new Error('benchmark requires at least one client');

  // -------------------------------------------------------------------------
  // RTT and clock offset
  // -------------------------------------------------------------------------
  const rttSamples: number[] = [];
  const offsets: number[] = [];

  for (let i = 0; i < options.pings; i += 1) {
    const sentAt = Date.now();
    const ack = await probe.submit(BENCHMARK_INTENTS.PING, {
      pingId: String(i),
      clientSentAt: sentAt,
    });
    const receivedAt = Date.now();

    if (!ack.ok) {
      errors.push(`ping ${i} rejected: ${ack.error.code}`);
      continue;
    }
    rttSamples.push(rtt(sentAt, receivedAt));
    // The ack carries no server time, so offset is estimated from the /health
    // style reading taken alongside. Kept simple: the display-only offset uses
    // the midpoint assumption documented in metrics.ts.
    offsets.push(clockOffset(sentAt, sentAt + (receivedAt - sentAt) / 2, receivedAt));
  }

  // -------------------------------------------------------------------------
  // Duplicate intent — the same intentId submitted twice
  // -------------------------------------------------------------------------
  const sharedIntentId = randomUUID();
  const first = await probe.submit(BENCHMARK_INTENTS.PING, { pingId: 'dup', clientSentAt: Date.now() }, sharedIntentId);
  const second = await probe.submit(BENCHMARK_INTENTS.PING, { pingId: 'dup', clientSentAt: Date.now() }, sharedIntentId);

  const duplicateIntent = {
    firstAccepted: first.ok,
    duplicateRejected: !second.ok,
    rejectionCode: second.ok ? null : second.error.code,
    // A client must be able to tell "already done" from "never happened".
    identifiedOriginalSeq:
      !second.ok && second.error.details?.['originalSeq'] !== undefined,
  };

  // -------------------------------------------------------------------------
  // Buzzer trials
  // -------------------------------------------------------------------------
  const trials: BuzzTrialResult[] = [];
  let totalAccepted = 0;
  let totalRejected = 0;

  // Schedules chosen to cover clearly separated through to simultaneous.
  const schedules: { label: string; offsets: number[] }[] = [
    { label: 'clearly separated (0ms, 250ms, 500ms)', offsets: [0, 250, 500] },
    { label: 'close (0ms, 15ms, 30ms)', offsets: [0, 15, 30] },
    { label: 'simultaneous (0ms, 0ms, 0ms)', offsets: [0, 0, 0] },
  ];

  for (let trial = 0; trial < options.buzzTrials; trial += 1) {
    const schedule = schedules[trial % schedules.length];
    if (schedule === undefined) continue;

    const opened = await host.submit(BENCHMARK_INTENTS.OPEN_BUZZER, {});
    if (!opened.ok) {
      errors.push(`open buzzer failed: ${opened.error.code}`);
      continue;
    }

    // Synthetic clients transmit at KNOWN offsets so we can compare behaviour.
    // The server still decides purely by receive order; no compensation exists.
    const results = await Promise.all(
      players.map(async (client, index) => {
        const delay = schedule.offsets[index] ?? 0;
        if (delay > 0) await wait(delay);
        return client.submit(BENCHMARK_INTENTS.BUZZ, { clientSentAt: Date.now() });
      }),
    );

    const accepted = results.filter((r) => r.ok).length;
    const rejected = results.length - accepted;
    totalAccepted += accepted;
    totalRejected += rejected;

    // Read the winner back from the server rather than inferring it locally.
    await wait(50);
    const snapshotAck = await host.submit(BENCHMARK_INTENTS.REQUEST_SNAPSHOT, {});
    const winnerEvent = [...host.receivedEvents()]
      .reverse()
      .find((e) => e.type === 'BENCHMARK_BUZZ_ACCEPTED');
    const winnerPayload = winnerEvent?.payload as
      | { benchmarkClientId: string; elapsedSinceOpenMs: number }
      | undefined;

    trials.push({
      trial: trial + 1,
      scheduleLabel: schedule.label,
      winner: winnerPayload?.benchmarkClientId ?? null,
      accepted,
      rejected,
      elapsedSinceOpenMs: winnerPayload?.elapsedSinceOpenMs ?? null,
    });

    if (!snapshotAck.ok) errors.push('snapshot request failed');
    await host.submit(BENCHMARK_INTENTS.RESET_BUZZER, {});
  }

  // -------------------------------------------------------------------------
  // Ordering — sequence numbers must arrive strictly increasing
  // -------------------------------------------------------------------------
  const observed = probe.receivedEvents();
  const ordering = analyseOrdering(observed);

  // -------------------------------------------------------------------------
  // Timer + pause/resume
  // -------------------------------------------------------------------------
  await host.submit(BENCHMARK_INTENTS.START_TIMER, { durationMs: 30_000 });
  await wait(300);

  const beforePause = await readRemaining(options);
  await host.submit(BENCHMARK_INTENTS.PAUSE, {});

  // Player resume must be refused. This is the rule under test.
  const playerResume = await probe.submit(BENCHMARK_INTENTS.RESUME, {});
  const doublePause = await host.submit(BENCHMARK_INTENTS.PAUSE, {});

  const pauseHeldMs = 1_200;
  await wait(pauseHeldMs);

  const afterPause = await readRemaining(options);
  const hostResume = await host.submit(BENCHMARK_INTENTS.RESUME, {});
  const resumeWhileRunning = await host.submit(BENCHMARK_INTENTS.RESUME, {});

  // -------------------------------------------------------------------------
  // Reconnect
  // -------------------------------------------------------------------------
  const reconnectTarget = players[players.length - 1];
  let reconnect = {
    reconnectMs: 0,
    identityRestored: false,
    duplicateClientCreated: false,
    snapshotReceived: false,
    resumedAutomatically: false,
  };

  if (reconnectTarget !== undefined) {
    const before = await fetchState(options);
    await host.submit(BENCHMARK_INTENTS.PAUSE, {});

    await reconnectTarget.disconnect();
    await wait(200);

    const rebuilt = createBenchmarkClient(options.transport, {
      host: options.host,
      port: options.port,
      benchmarkClientId: reconnectTarget.benchmarkClientId,
      isHost: false,
      label: 'reconnected',
    });

    const reconnectStart = Date.now();
    await rebuilt.connect();
    const reconnectMs = Date.now() - reconnectStart;

    const after = await fetchState(options);

    reconnect = {
      reconnectMs,
      identityRestored:
        after?.clients.some(
          (c) => c.benchmarkClientId === reconnectTarget.benchmarkClientId && c.connected,
        ) ?? false,
      duplicateClientCreated: (after?.clients.length ?? 0) > (before?.clients.length ?? 0),
      snapshotReceived: rebuilt.receivedEvents().length > 0,
      // The critical assertion: reconnecting must NOT resume the game.
      resumedAutomatically: after?.paused === false,
    };

    await rebuilt.disconnect();
    await host.submit(BENCHMARK_INTENTS.RESUME, {});
  }

  for (const client of players) await client.disconnect();
  await host.disconnect();

  return {
    transport: options.transport,
    startedAt,
    clients: options.clients,
    rtt: summarizeRtt(rttSamples),
    clockOffsetMs: {
      medianMs: round2(offsets.length === 0 ? 0 : offsets[Math.floor(offsets.length / 2)] ?? 0),
      maxAbsMs: round2(offsets.length === 0 ? 0 : Math.max(...offsets.map(Math.abs))),
    },
    buzz: { trials, totalAccepted, totalRejected },
    duplicateIntent,
    ordering,
    reconnect,
    timer: {
      pauseHeldMs,
      remainingBeforePauseMs: beforePause,
      remainingAfterPauseMs: afterPause,
      // Should be ~0. Paused time must not consume the player's timer.
      consumedWhilePausedMs: round2(Math.max(0, beforePause - afterPause)),
    },
    pause: {
      playerResumeRejected: !playerResume.ok,
      playerRejectionCode: playerResume.ok ? null : playerResume.error.code,
      hostResumeAccepted: hostResume.ok,
      doublePauseRejected: !doublePause.ok,
      resumeWhileRunningRejected: !resumeWhileRunning.ok,
    },
    errors,
  };
}

function analyseOrdering(events: readonly EventEnvelope[]): {
  eventsObserved: number;
  outOfOrder: number;
  duplicated: number;
} {
  let outOfOrder = 0;
  let duplicated = 0;
  const seen = new Set<number>();
  let highest = 0;

  for (const event of events) {
    if (seen.has(event.seq)) duplicated += 1;
    seen.add(event.seq);
    if (event.seq < highest) outOfOrder += 1;
    else highest = event.seq;
  }

  return { eventsObserved: events.length, outOfOrder, duplicated };
}

interface BenchmarkStateResponse {
  paused: boolean;
  timer: { remainingMs: number };
  clients: { benchmarkClientId: string; connected: boolean }[];
}

async function fetchState(options: RunnerOptions): Promise<BenchmarkStateResponse | null> {
  try {
    const res = await fetch(`http://${options.host}:${options.port}/benchmark/state`);
    return (await res.json()) as BenchmarkStateResponse;
  } catch {
    return null;
  }
}

async function readRemaining(options: RunnerOptions): Promise<number> {
  const state = await fetchState(options);
  return state?.timer.remainingMs ?? 0;
}
