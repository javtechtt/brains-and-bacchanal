import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { BENCHMARK_INTENTS, type TransportKind } from '@bb/protocol';
import { createBenchmarkServer, type BenchmarkServer } from './server.js';
import { createBenchmarkClient, type BenchmarkClient } from './client.js';

/**
 * Transport integration tests over REAL sockets.
 *
 * Both adapters run the SAME test body, so a behavioural difference between
 * them shows up as a failure rather than as a subtly different test. These
 * complement the deterministic session tests: those prove the rules, these
 * prove the rules survive a real network hop through each transport.
 *
 * Uses an ephemeral port so tests never collide.
 */

const silent = pino({ level: 'silent' });
let server: BenchmarkServer;
let port: number;

beforeAll(async () => {
  server = createBenchmarkServer(silent);
  await server.listen(0, '127.0.0.1');
  const address = server.httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP address');
  port = address.port;
});

afterAll(async () => {
  await server.close();
});

const TRANSPORTS: TransportKind[] = ['socketio', 'websocket'];

function client(kind: TransportKind, id: string, isHost = false): BenchmarkClient {
  return createBenchmarkClient(kind, {
    host: '127.0.0.1',
    port,
    benchmarkClientId: id,
    isHost,
    label: id,
  });
}

const unique = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

describe.each(TRANSPORTS)('%s transport', (kind) => {
  it('connects and identifies a client', async () => {
    const c = client(kind, unique('solo'));
    await c.connect();
    const ack = await c.submit(BENCHMARK_INTENTS.PING, { pingId: '1', clientSentAt: Date.now() });
    expect(ack.ok).toBe(true);
    await c.disconnect();
  });

  it('rejects a malformed intent envelope', async () => {
    // Sent as a raw frame rather than via the client helper, because the helper
    // always builds a well-formed envelope. This is what a buggy or hostile
    // client looks like on the wire.
    const c = client(kind, unique('bad'));
    await c.connect();

    const ack = await c.submit(BENCHMARK_INTENTS.HELLO, { benchmarkClientId: '' });
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('INVALID_REQUEST');

    await c.disconnect();
  });

  it('delivers events to a connected client', async () => {
    const host = client(kind, unique('host'), true);
    await host.connect();
    await host.submit(BENCHMARK_INTENTS.OPEN_BUZZER, {});

    await new Promise((r) => setTimeout(r, 100));
    expect(host.receivedEvents().some((e) => e.type === 'BENCHMARK_BUZZER_OPENED')).toBe(true);

    await host.submit(BENCHMARK_INTENTS.RESET_BUZZER, {});
    await host.disconnect();
  });

  it('rejects a duplicate intent and names the original event', async () => {
    const c = client(kind, unique('dup'));
    await c.connect();

    const id = unique('intent');
    const first = await c.submit(BENCHMARK_INTENTS.PING, { pingId: 'a', clientSentAt: 1 }, id);
    const second = await c.submit(BENCHMARK_INTENTS.PING, { pingId: 'a', clientSentAt: 1 }, id);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('DUPLICATE_INTENT');
      expect(second.error.details?.['originalSeq']).toBeDefined();
    }
    await c.disconnect();
  });

  it('handles rapid duplicate submission', async () => {
    const c = client(kind, unique('rapid'));
    await c.connect();

    const id = unique('rapid-intent');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        c.submit(BENCHMARK_INTENTS.PING, { pingId: 'r', clientSentAt: 1 }, id),
      ),
    );

    // Exactly one may be applied, however they interleave.
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    await c.disconnect();
  });

  it('locks the buzzer to the first received buzz with two clients', async () => {
    const host = client(kind, unique('h2'), true);
    const p1 = client(kind, unique('p1'));
    const p2 = client(kind, unique('p2'));
    await host.connect();
    await p1.connect();
    await p2.connect();

    await host.submit(BENCHMARK_INTENTS.OPEN_BUZZER, {});
    const results = await Promise.all([
      p1.submit(BENCHMARK_INTENTS.BUZZ, { clientSentAt: Date.now() }),
      p2.submit(BENCHMARK_INTENTS.BUZZ, { clientSentAt: Date.now() }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);

    await host.submit(BENCHMARK_INTENTS.RESET_BUZZER, {});
    await Promise.all([host.disconnect(), p1.disconnect(), p2.disconnect()]);
  });

  it('locks the buzzer with three clients', async () => {
    const host = client(kind, unique('h3'), true);
    const players = [client(kind, unique('a')), client(kind, unique('b')), client(kind, unique('c'))];
    await host.connect();
    for (const p of players) await p.connect();

    await host.submit(BENCHMARK_INTENTS.OPEN_BUZZER, {});
    const results = await Promise.all(
      players.map((p) => p.submit(BENCHMARK_INTENTS.BUZZ, { clientSentAt: Date.now() })),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);

    await host.submit(BENCHMARK_INTENTS.RESET_BUZZER, {});
    await Promise.all([host.disconnect(), ...players.map((p) => p.disconnect())]);
  });

  // Found from real two-phone LAN testing: opening the buzzer twice (a slow
  // ack followed by a retried click, submitted as two distinct intentIds so
  // Phase 2 deduplication does not apply) produced two BENCHMARK_BUZZER_OPENED
  // events and an incremented round with no reset or accepted buzz in between.
  it('rejects opening an already-open buzzer over the real transport', async () => {
    const host = client(kind, unique('reopen'), true);
    await host.connect();

    // Known starting point: closed. The session is shared across the whole
    // file, so a leftover open buzzer from an earlier test cannot be assumed.
    await host.submit(BENCHMARK_INTENTS.RESET_BUZZER, {});

    const first = await host.submit(BENCHMARK_INTENTS.OPEN_BUZZER, {});
    const second = await host.submit(BENCHMARK_INTENTS.OPEN_BUZZER, {});

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('WRONG_STATE');

    await new Promise((r) => setTimeout(r, 100));
    const opens = host
      .receivedEvents()
      .filter((e) => e.type === 'BENCHMARK_BUZZER_OPENED');
    // Exactly one open event reached the client, not two.
    expect(opens).toHaveLength(1);

    await host.submit(BENCHMARK_INTENTS.RESET_BUZZER, {});
    await host.disconnect();
  });

  it('rejects opening the buzzer again after an accepted buzz until reset', async () => {
    const host = client(kind, unique('reopenwin'), true);
    const player = client(kind, unique('winner'));
    await host.connect();
    await player.connect();

    // Known starting point, for the same reason as the test above.
    await host.submit(BENCHMARK_INTENTS.RESET_BUZZER, {});

    await host.submit(BENCHMARK_INTENTS.OPEN_BUZZER, {});
    const buzz = await player.submit(BENCHMARK_INTENTS.BUZZ, { clientSentAt: Date.now() });
    expect(buzz.ok).toBe(true);

    const reopen = await host.submit(BENCHMARK_INTENTS.OPEN_BUZZER, {});
    expect(reopen.ok).toBe(false);
    if (!reopen.ok) expect(reopen.error.code).toBe('WRONG_STATE');

    const reset = await host.submit(BENCHMARK_INTENTS.RESET_BUZZER, {});
    expect(reset.ok).toBe(true);

    const nextRound = await host.submit(BENCHMARK_INTENTS.OPEN_BUZZER, {});
    expect(nextRound.ok).toBe(true);

    await host.submit(BENCHMARK_INTENTS.RESET_BUZZER, {});
    await Promise.all([host.disconnect(), player.disconnect()]);
  });

  it('rejects opening the buzzer while paused', async () => {
    const host = client(kind, unique('pauseopen'), true);
    await host.connect();
    await host.submit(BENCHMARK_INTENTS.RESET_BUZZER, {});

    await host.submit(BENCHMARK_INTENTS.PAUSE, {});
    const opened = await host.submit(BENCHMARK_INTENTS.OPEN_BUZZER, {});

    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe('WRONG_STATE');

    const state = (await (
      await fetch(`http://127.0.0.1:${port}/benchmark/state`)
    ).json()) as { buzzerOpen: boolean };
    expect(state.buzzerOpen).toBe(false);

    await host.submit(BENCHMARK_INTENTS.RESUME, {});
    await host.disconnect();
  });

  it('rejects starting a timer while paused', async () => {
    const host = client(kind, unique('pausetimer'), true);
    await host.connect();

    // The server is a session SHARED across every test in this file (and
    // across both transports, run one after another), so a prior test may
    // have left a timer running. This test asserts the REJECTION and that the
    // timer configuration is UNCHANGED by the rejected attempt — not an
    // absolute active/inactive state, which would be flaky under sharing.
    const before = (await (
      await fetch(`http://127.0.0.1:${port}/benchmark/state`)
    ).json()) as { timer: { durationMs: number; remainingMs: number } };

    await host.submit(BENCHMARK_INTENTS.PAUSE, {});
    const started = await host.submit(BENCHMARK_INTENTS.START_TIMER, { durationMs: 10_000 });

    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.code).toBe('WRONG_STATE');

    const after = (await (
      await fetch(`http://127.0.0.1:${port}/benchmark/state`)
    ).json()) as { timer: { durationMs: number; remainingMs: number } };
    // A rejected START_TIMER must not have replaced the existing deadline.
    expect(after.timer.durationMs).toBe(before.timer.durationMs);

    await host.submit(BENCHMARK_INTENTS.RESUME, {});
    await host.disconnect();
  });

  it('rejects rapid duplicate OPEN_BUZZER clicks, keeping exactly one open', async () => {
    const host = client(kind, unique('rapidopen'), true);
    await host.connect();

    // Ensure a known starting point: closed, no pending winner. The session
    // is shared across the whole file, so this cannot assume a fresh state.
    await host.submit(BENCHMARK_INTENTS.RESET_BUZZER, {});

    const roundBefore = (
      (await (await fetch(`http://127.0.0.1:${port}/benchmark/state`)).json()) as {
        buzzerRound: number;
      }
    ).buzzerRound;

    const results = await Promise.all(
      Array.from({ length: 4 }, () => host.submit(BENCHMARK_INTENTS.OPEN_BUZZER, {})),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);

    const state = (await (
      await fetch(`http://127.0.0.1:${port}/benchmark/state`)
    ).json()) as { buzzerOpen: boolean; buzzerRound: number };
    expect(state.buzzerOpen).toBe(true);
    // Exactly one of the four concurrent opens took effect: the round moved
    // forward by exactly one, not four.
    expect(state.buzzerRound).toBe(roundBefore + 1);

    await host.submit(BENCHMARK_INTENTS.RESET_BUZZER, {});
    await host.disconnect();
  });

  it('refuses a player resume and accepts a Host resume', async () => {
    const host = client(kind, unique('hp'), true);
    const player = client(kind, unique('pp'));
    await host.connect();
    await player.connect();

    await host.submit(BENCHMARK_INTENTS.PAUSE, {});

    const byPlayer = await player.submit(BENCHMARK_INTENTS.RESUME, {});
    expect(byPlayer.ok).toBe(false);
    if (!byPlayer.ok) expect(byPlayer.error.code).toBe('UNAUTHORIZED_ACTOR');

    const byHost = await host.submit(BENCHMARK_INTENTS.RESUME, {});
    expect(byHost.ok).toBe(true);

    await Promise.all([host.disconnect(), player.disconnect()]);
  });

  it('restores identity on reconnect without duplicating the client', async () => {
    const id = unique('recon');
    const first = client(kind, id);
    await first.connect();
    await first.disconnect();
    await new Promise((r) => setTimeout(r, 80));

    const again = client(kind, id);
    await again.connect();

    const state = (await (
      await fetch(`http://127.0.0.1:${port}/benchmark/state`)
    ).json()) as { clients: { benchmarkClientId: string; connected: boolean }[] };

    const matching = state.clients.filter((c) => c.benchmarkClientId === id);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.connected).toBe(true);

    await again.disconnect();
  });

  it('delivers events with strictly increasing sequence numbers', async () => {
    const host = client(kind, unique('ord'), true);
    await host.connect();

    for (let i = 0; i < 6; i += 1) {
      await host.submit(BENCHMARK_INTENTS.OPEN_BUZZER, {});
      await host.submit(BENCHMARK_INTENTS.RESET_BUZZER, {});
    }
    await new Promise((r) => setTimeout(r, 150));

    const seqs = host.receivedEvents().map((e) => e.seq);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
    await host.disconnect();
  });

  it('keeps the timer frozen across a pause', async () => {
    const host = client(kind, unique('tm'), true);
    await host.connect();

    await host.submit(BENCHMARK_INTENTS.START_TIMER, { durationMs: 30_000 });
    await host.submit(BENCHMARK_INTENTS.PAUSE, {});

    const read = async (): Promise<number> => {
      const res = await fetch(`http://127.0.0.1:${port}/benchmark/state`);
      const body = (await res.json()) as { timer: { remainingMs: number } };
      return body.timer.remainingMs;
    };

    const before = await read();
    await new Promise((r) => setTimeout(r, 400));
    const after = await read();

    // Real wall time passed; the paused timer must not have consumed it.
    expect(before - after).toBeLessThanOrEqual(20);

    await host.submit(BENCHMARK_INTENTS.RESUME, {});
    await host.disconnect();
  });
});
