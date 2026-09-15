import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { FakeClock } from '@bb/game-rules';
import { PROTOCOL_VERSION, type HealthResponse } from '@bb/protocol';
import { createGameServer, rankAddresses, type GameServer } from './server.js';
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

describe('LAN address ranking', () => {
  // This machine really does present eight IPv4 addresses. Taking the first one
  // the OS listed put a Tailscale address into the QR code — generated, shown,
  // and unreachable from any phone on the house Wi-Fi.
  const realWorld = [
    '172.20.16.20', // Hyper-V / WSL virtual switch
    '169.254.219.162', // APIPA: DHCP failed
    '169.254.178.73',
    '192.168.50.62', // the actual house LAN
    '169.254.239.66',
    '100.81.14.102', // Tailscale (CGNAT)
  ];

  it('prefers the real LAN address over virtual, overlay and link-local ones', () => {
    expect(rankAddresses(realWorld)[0]).toBe('192.168.50.62');
  });

  it('ranks 10.x as a plausible LAN when no 192.168.x exists', () => {
    expect(rankAddresses(['169.254.1.1', '100.81.14.102', '10.0.0.42'])[0]).toBe('10.0.0.42');
  });

  it('demotes Tailscale CGNAT below an ordinary LAN', () => {
    expect(rankAddresses(['100.81.14.102', '192.168.1.5'])[0]).toBe('192.168.1.5');
  });

  it('does not treat 100.200.x as CGNAT — only 100.64-127 is', () => {
    expect(rankAddresses(['100.200.0.1', '169.254.1.1'])[0]).toBe('100.200.0.1');
  });

  it('demotes Docker/WSL 172.16-31 but not other 172.x', () => {
    expect(rankAddresses(['172.20.16.20', '172.32.0.1'])[0]).toBe('172.32.0.1');
  });

  it('ranks link-local last', () => {
    const ranked = rankAddresses(['169.254.1.1', '172.20.0.1', '100.81.0.1']);
    expect(ranked[ranked.length - 1]).toBe('169.254.1.1');
  });

  it('leaves a single address alone and does not mutate its input', () => {
    const input = ['192.168.1.5'];
    expect(rankAddresses(input)).toEqual(['192.168.1.5']);

    const original = [...realWorld];
    rankAddresses(realWorld);
    expect(realWorld).toEqual(original);
  });
});
