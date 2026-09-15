import { BENCHMARK_INTENTS, type TransportKind } from '@bb/protocol';
import { createBenchmarkClient } from './client.js';
import { summarizeRtt } from './metrics.js';

/**
 * LAN observation helper — DEVELOPMENT ONLY.
 *
 * Two jobs during a real-device benchmark session:
 *
 *   `rtt`    collect a large RTT sample automatically, so the operator is not
 *           tapping a phone fifty times per transport;
 *   `watch`  poll the server's authoritative state and print a running log of
 *           timer, buzzer and client changes, so physical actions performed on
 *           phones (disconnect, sleep, buzz) are recorded with server
 *           timestamps rather than from memory.
 *
 * `watch` observes only; it never sends an intent, so it cannot influence a
 * buzzer trial it is recording.
 */

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const mode = arg('mode', 'watch');
const host = arg('host', '127.0.0.1');
const port = Number(arg('port', '4500'));
const transport = arg('transport', 'socketio') as TransportKind;
const samples = Number(arg('samples', '50'));

interface StateResponse {
  paused: boolean;
  buzzerOpen: boolean;
  buzzerRound: number;
  seq: number;
  acceptedBuzz: { benchmarkClientId: string; elapsedSinceOpenMs: number } | null;
  timer: { active: boolean; remainingMs: number; paused: boolean };
  clients: { benchmarkClientId: string; connected: boolean; isHost: boolean; label: string }[];
}

async function fetchState(): Promise<StateResponse | null> {
  try {
    const res = await fetch(`http://${host}:${port}/benchmark/state`);
    return (await res.json()) as StateResponse;
  } catch {
    return null;
  }
}

const stamp = (): string => new Date().toISOString().slice(11, 23);

/** Collect RTT samples from a synthetic client over the chosen transport. */
async function collectRtt(): Promise<void> {
  const client = createBenchmarkClient(transport, {
    host,
    port,
    benchmarkClientId: `rtt-probe-${transport}-${Date.now()}`,
    isHost: false,
    label: `rtt-probe-${transport}`,
  });

  await client.connect();
  console.log(`Collecting ${samples} RTT samples over ${transport} against ${host}:${port} ...`);

  const rtts: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const sentAt = Date.now();
    const ack = await client.submit(BENCHMARK_INTENTS.PING, {
      pingId: String(i),
      clientSentAt: sentAt,
    });
    if (ack.ok) rtts.push(Date.now() - sentAt);
    // Spaced so samples reflect steady-state behaviour rather than a burst.
    await new Promise((r) => setTimeout(r, 100));
  }

  await client.disconnect();

  const summary = summarizeRtt(rtts);
  console.log('');
  console.log(`  transport   ${transport}`);
  console.log(`  samples     ${summary.count}`);
  console.log(`  median      ${summary.medianMs} ms`);
  console.log(`  p95         ${summary.p95Ms} ms`);
  console.log(`  p99         ${summary.p99Ms} ms`);
  console.log(`  min / max   ${summary.minMs} / ${summary.maxMs} ms`);
  console.log(`  jitter      ${summary.jitterMs} ms`);
  console.log('');
}

/** Print a timestamped log of server-side state changes. */
async function watch(): Promise<void> {
  console.log(`Watching ${host}:${port} — Ctrl+C to stop.`);
  console.log('');

  let previous: StateResponse | null = null;

  setInterval(() => {
    void (async () => {
      const state = await fetchState();
      if (state === null) {
        if (previous !== null) console.log(`${stamp()}  SERVER UNREACHABLE`);
        previous = null;
        return;
      }

      if (previous === null) {
        console.log(`${stamp()}  connected. clients=${state.clients.length}`);
        previous = state;
        return;
      }

      for (const client of state.clients) {
        const before = previous.clients.find(
          (c) => c.benchmarkClientId === client.benchmarkClientId,
        );
        if (before === undefined) {
          console.log(`${stamp()}  CLIENT JOINED   ${client.label} (${client.benchmarkClientId})`);
        } else if (before.connected !== client.connected) {
          console.log(
            `${stamp()}  ${client.connected ? 'RECONNECTED    ' : 'DISCONNECTED   '} ${client.label}`,
          );
        }
      }

      if (previous.buzzerOpen !== state.buzzerOpen) {
        console.log(
          `${stamp()}  BUZZER ${state.buzzerOpen ? `OPENED (round ${state.buzzerRound})` : 'CLOSED'}`,
        );
      }

      const beforeWinner = previous.acceptedBuzz?.benchmarkClientId ?? null;
      const nowWinner = state.acceptedBuzz?.benchmarkClientId ?? null;
      if (nowWinner !== null && nowWinner !== beforeWinner) {
        console.log(
          `${stamp()}  BUZZ ACCEPTED   ${nowWinner} (+${state.acceptedBuzz?.elapsedSinceOpenMs}ms after open)`,
        );
      }

      if (previous.paused !== state.paused) {
        console.log(`${stamp()}  ${state.paused ? 'PAUSED' : 'RESUMED'}`);
      }

      if (previous.timer.active !== state.timer.active && state.timer.active) {
        console.log(`${stamp()}  TIMER STARTED   ${state.timer.remainingMs} ms`);
      }
      if (previous.timer.paused !== state.timer.paused) {
        console.log(
          `${stamp()}  TIMER ${state.timer.paused ? 'FROZEN' : 'RUNNING'}  remaining=${state.timer.remainingMs} ms`,
        );
      }

      previous = state;
    })();
  }, 250);
}

if (mode === 'rtt') {
  collectRtt().catch((err: unknown) => {
    console.error('rtt collection failed:', err);
    process.exit(1);
  });
} else {
  watch().catch((err: unknown) => {
    console.error('watch failed:', err);
    process.exit(1);
  });
}
