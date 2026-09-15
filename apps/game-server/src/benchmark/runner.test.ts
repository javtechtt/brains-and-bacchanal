import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createBenchmarkServer, type BenchmarkServer } from './server.js';
import { createBenchmarkClient, type BenchmarkClient } from './client.js';
import { runBenchmark, MixedTransportError } from './runner.js';

/**
 * Tests for the runner's transport-purity gate (requirements 6-8).
 *
 * Real two-phone LAN testing showed a Host browser and phones can each
 * independently pick Socket.IO or raw WebSocket while the shared session
 * keeps working — a genuine, intentional property of the architecture. An
 * OFFICIAL benchmark run must not silently treat that as a valid comparison
 * point, so runBenchmark checks the live session's transport mix before
 * measuring anything and refuses by default when it finds the session already
 * mixed with another transport.
 *
 * The full RTT/buzzer/reconnect scenario is exercised manually via the CLI
 * against the real server (see docs/NETWORK_BENCHMARK.md); these tests focus
 * on the purity gate itself, which is the new logic this change adds.
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

const stray: BenchmarkClient[] = [];
afterEach(async () => {
  for (const client of stray.splice(0)) await client.disconnect();
});

function runnerOptions(
  overrides: Partial<Parameters<typeof runBenchmark>[0]> = {},
): Parameters<typeof runBenchmark>[0] {
  return {
    transport: 'socketio',
    host: '127.0.0.1',
    port,
    clients: 1,
    pings: 2,
    buzzTrials: 1,
    allowMixed: false,
    ...overrides,
  };
}

describe('runBenchmark transport purity', () => {
  it('runs normally when the session is transport-pure', async () => {
    const report = await runBenchmark(runnerOptions({ transport: 'websocket' }));
    expect(report.official.pure).toBe(true);
    expect(report.official.overridden).toBe(false);
  });

  it('refuses an official run when another transport is already connected', async () => {
    // Simulates the exact scenario found on LAN: a lingering client on the
    // other transport before an "official" run starts measuring.
    const lingering = createBenchmarkClient('websocket', {
      host: '127.0.0.1',
      port,
      benchmarkClientId: 'lingering-phone',
      isHost: false,
      label: 'lingering-phone',
    });
    await lingering.connect();
    stray.push(lingering);

    await expect(runBenchmark(runnerOptions({ transport: 'socketio' }))).rejects.toBeInstanceOf(
      MixedTransportError,
    );
  });

  it('names the requested transport and the conflicting count in the error', async () => {
    const lingering = createBenchmarkClient('websocket', {
      host: '127.0.0.1',
      port,
      benchmarkClientId: 'lingering-phone-2',
      isHost: false,
      label: 'lingering-phone-2',
    });
    await lingering.connect();
    stray.push(lingering);

    try {
      await runBenchmark(runnerOptions({ transport: 'socketio' }));
      expect.unreachable('expected MixedTransportError');
    } catch (err) {
      expect(err).toBeInstanceOf(MixedTransportError);
      if (err instanceof MixedTransportError) {
        expect(err.requestedTransport).toBe('socketio');
        expect(err.summary.websocket).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('does not leave synthetic clients connected after refusing a mixed run', async () => {
    const lingering = createBenchmarkClient('websocket', {
      host: '127.0.0.1',
      port,
      benchmarkClientId: 'lingering-phone-3',
      isHost: false,
      label: 'lingering-phone-3',
    });
    await lingering.connect();
    stray.push(lingering);

    await expect(runBenchmark(runnerOptions({ transport: 'socketio' }))).rejects.toThrow();

    // Give the server a moment to process the disconnects the runner
    // triggered as part of refusing the run — client-side disconnect and
    // server-observed disconnect are not the same instant.
    await new Promise((r) => setTimeout(r, 150));

    const state = (await (
      await fetch(`http://127.0.0.1:${port}/benchmark/state`)
    ).json()) as { clients: { benchmarkClientId: string; connected: boolean }[] };
    // Disconnected identities are kept (for reconnect testing), never
    // removed, so the correct assertion is "not connected", not "absent".
    const runnersOwnClients = state.clients.filter((c) => c.benchmarkClientId.startsWith('host-'));
    expect(runnersOwnClients.every((c) => !c.connected)).toBe(true);
  });

  it('proceeds and marks the report overridden when allowMixed is set', async () => {
    const lingering = createBenchmarkClient('websocket', {
      host: '127.0.0.1',
      port,
      benchmarkClientId: 'lingering-phone-4',
      isHost: false,
      label: 'lingering-phone-4',
    });
    await lingering.connect();
    stray.push(lingering);

    const report = await runBenchmark(
      runnerOptions({ transport: 'socketio', allowMixed: true }),
    );
    expect(report.official.pure).toBe(false);
    expect(report.official.overridden).toBe(true);
    expect(report.official.summary.websocket).toBeGreaterThanOrEqual(1);
  });

  it('is unaffected by a lingering client on the SAME transport', async () => {
    const other = createBenchmarkClient('socketio', {
      host: '127.0.0.1',
      port,
      benchmarkClientId: 'same-transport-phone',
      isHost: false,
      label: 'same-transport-phone',
    });
    await other.connect();
    stray.push(other);

    const report = await runBenchmark(runnerOptions({ transport: 'socketio' }));
    expect(report.official.pure).toBe(true);
  });
});
