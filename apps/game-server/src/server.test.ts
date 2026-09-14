import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { FakeClock } from '@bb/game-rules';
import { PROTOCOL_VERSION, type HealthResponse } from '@bb/protocol';
import { createGameServer, type GameServer } from './server.js';
import { loadConfig } from './config.js';

const silentLogger = pino({ level: 'silent' });

let server: GameServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function startOnEphemeralPort(clock: FakeClock): Promise<string> {
  // Port 0 lets the OS pick a free port, so tests never collide.
  const config = { ...loadConfig({}), port: 0, host: '127.0.0.1' };
  server = createGameServer(config, silentLogger, clock);
  await server.listen();

  const address = server.httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

describe('GET /health', () => {
  it('reports ok with the current protocol version', async () => {
    const baseUrl = await startOnEphemeralPort(new FakeClock(1_000));

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('reports uptime from the injected clock, not wall time', async () => {
    const clock = new FakeClock(1_000);
    const baseUrl = await startOnEphemeralPort(clock);

    // Advancing the fake clock is the only way time passes here.
    clock.advance(7_500);

    const body = (await (await fetch(`${baseUrl}/health`)).json()) as HealthResponse;
    expect(body.uptimeMs).toBe(7_500);
    expect(body.serverTime).toBe(8_500);
  });

  it('404s on unknown routes', async () => {
    const baseUrl = await startOnEphemeralPort(new FakeClock());
    const res = await fetch(`${baseUrl}/not-a-route`);
    expect(res.status).toBe(404);
  });
});
