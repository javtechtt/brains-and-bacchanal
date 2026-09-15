import { beforeEach, describe, expect, it } from 'vitest';
import { BENCHMARK_INTENTS, PROTOCOL_VERSION, type IntentEnvelope } from '@bb/protocol';
import { FakeClock } from '@bb/game-rules';
import { BenchmarkSession } from './session.js';

/**
 * Deterministic tests for the benchmark session.
 *
 * These use a FakeClock and no sockets at all, so they verify the RULES the
 * benchmark relies on (buzzer locking, Host-only resume, deduplication, paused
 * timers) without any network flakiness. The transport-level tests live in
 * transports.test.ts.
 */

const HOST_CONN = 'conn-host';
const P1 = 'conn-p1';
const P2 = 'conn-p2';
const P3 = 'conn-p3';

let clock: FakeClock;
let session: BenchmarkSession;
let counter = 0;

beforeEach(() => {
  clock = new FakeClock(10_000);
  session = new BenchmarkSession(clock);
  counter = 0;
});

function intent(type: string, payload: unknown = {}, intentId?: string): IntentEnvelope {
  counter += 1;
  return {
    protocolVersion: PROTOCOL_VERSION,
    intentId: (intentId ?? `i-${counter}`) as never,
    roomId: 'benchmark' as never,
    type,
    payload,
  };
}

function hello(conn: string, id: string, isHost = false) {
  return session.handle(conn, intent(BENCHMARK_INTENTS.HELLO, { benchmarkClientId: id, isHost }));
}

function setupHostAndPlayers(count = 2) {
  hello(HOST_CONN, 'host-1', true);
  const conns = [P1, P2, P3].slice(0, count);
  conns.forEach((conn, i) => hello(conn, `player-${i + 1}`));
  return conns;
}

describe('protocol enforcement', () => {
  it('rejects an incompatible protocol version', () => {
    const { ack } = session.handle(P1, {
      ...intent(BENCHMARK_INTENTS.PING),
      protocolVersion: PROTOCOL_VERSION + 1,
    });
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('UNSUPPORTED_PROTOCOL_VERSION');
  });

  it('rejects an unknown intent type', () => {
    const { ack } = session.handle(P1, intent('TOTALLY_UNKNOWN'));
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('INVALID_REQUEST');
  });

  it('rejects a hello with no client id', () => {
    const { ack } = session.handle(P1, intent(BENCHMARK_INTENTS.HELLO, {}));
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('INVALID_REQUEST');
  });
});

describe('sequence numbers', () => {
  it('increase monotonically', () => {
    setupHostAndPlayers(1);
    const a = session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.OPEN_BUZZER));
    const b = session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.RESET_BUZZER));
    if (a.ack.ok && b.ack.ok) expect(b.ack.seq).toBeGreaterThan(a.ack.seq);
  });
});

describe('duplicate intent', () => {
  it('rejects the same intentId twice', () => {
    setupHostAndPlayers(1);
    const first = session.handle(P1, intent(BENCHMARK_INTENTS.PING, {}, 'same-id'));
    const second = session.handle(P1, intent(BENCHMARK_INTENTS.PING, {}, 'same-id'));

    expect(first.ack.ok).toBe(true);
    expect(second.ack.ok).toBe(false);
    if (!second.ack.ok) expect(second.ack.error.code).toBe('DUPLICATE_INTENT');
  });

  it('tells the client which event the original produced', () => {
    // Without this a client cannot distinguish "already applied" from
    // "never happened", which is the whole point of idempotency.
    setupHostAndPlayers(1);
    const first = session.handle(P1, intent(BENCHMARK_INTENTS.PING, {}, 'dup'));
    const second = session.handle(P1, intent(BENCHMARK_INTENTS.PING, {}, 'dup'));

    if (first.ack.ok && !second.ack.ok) {
      expect(second.ack.error.details?.['originalSeq']).toBe(first.ack.seq);
    }
  });

  it('does not apply a duplicate buzz twice', () => {
    setupHostAndPlayers(2);
    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.OPEN_BUZZER));

    session.handle(P1, intent(BENCHMARK_INTENTS.BUZZ, {}, 'buzz-1'));
    const winner = session.acceptedBuzz?.benchmarkClientId;
    session.handle(P1, intent(BENCHMARK_INTENTS.BUZZ, {}, 'buzz-1'));

    expect(session.acceptedBuzz?.benchmarkClientId).toBe(winner);
  });

  it('allows a rejected intent to be retried', () => {
    // A rejected intent never applied, so retrying must not be blocked.
    setupHostAndPlayers(1);
    const a = session.handle(P1, intent(BENCHMARK_INTENTS.OPEN_BUZZER, {}, 'x'));
    const b = session.handle(P1, intent(BENCHMARK_INTENTS.OPEN_BUZZER, {}, 'x'));
    expect(a.ack.ok).toBe(false);
    if (!b.ack.ok) expect(b.ack.error.code).not.toBe('DUPLICATE_INTENT');
  });
});

describe('benchmark buzzer', () => {
  it('rejects a buzz while closed', () => {
    setupHostAndPlayers(1);
    const { ack } = session.handle(P1, intent(BENCHMARK_INTENTS.BUZZ));
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('ILLEGAL_ACTION');
  });

  it('accepts the first buzz received and locks out the rest', () => {
    setupHostAndPlayers(3);
    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.OPEN_BUZZER));

    const first = session.handle(P2, intent(BENCHMARK_INTENTS.BUZZ));
    const second = session.handle(P1, intent(BENCHMARK_INTENTS.BUZZ));
    const third = session.handle(P3, intent(BENCHMARK_INTENTS.BUZZ));

    expect(first.ack.ok).toBe(true);
    expect(second.ack.ok).toBe(false);
    expect(third.ack.ok).toBe(false);
    expect(session.acceptedBuzz?.benchmarkClientId).toBe('player-2');
    if (!second.ack.ok) expect(second.ack.error.code).toBe('CONFLICT');
  });

  it('decides by receive order, ignoring any client timestamp', () => {
    // The later-arriving client claims an impossibly early send time. The
    // server must ignore it: ARCHITECTURE.md §6, and CLAUDE.md's rule that
    // client code never decides who buzzed first.
    setupHostAndPlayers(2);
    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.OPEN_BUZZER));

    session.handle(P1, intent(BENCHMARK_INTENTS.BUZZ, { clientSentAt: 999_999_999 }));
    session.handle(P2, intent(BENCHMARK_INTENTS.BUZZ, { clientSentAt: 0 }));

    expect(session.acceptedBuzz?.benchmarkClientId).toBe('player-1');
  });

  it('records elapsed time from the authoritative open', () => {
    setupHostAndPlayers(1);
    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.OPEN_BUZZER));
    clock.advance(140);
    session.handle(P1, intent(BENCHMARK_INTENTS.BUZZ));

    expect(session.acceptedBuzz?.elapsedSinceOpenMs).toBe(140);
  });

  it('allows a new winner after reset', () => {
    setupHostAndPlayers(2);
    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.OPEN_BUZZER));
    session.handle(P1, intent(BENCHMARK_INTENTS.BUZZ));
    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.RESET_BUZZER));
    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.OPEN_BUZZER));

    const { ack } = session.handle(P2, intent(BENCHMARK_INTENTS.BUZZ));
    expect(ack.ok).toBe(true);
    expect(session.acceptedBuzz?.benchmarkClientId).toBe('player-2');
  });

  it('refuses to let a player open the buzzer', () => {
    setupHostAndPlayers(1);
    const { ack } = session.handle(P1, intent(BENCHMARK_INTENTS.OPEN_BUZZER));
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('UNAUTHORIZED_ACTOR');
  });
});

describe('pause and resume', () => {
  it('lets only the Host resume', () => {
    setupHostAndPlayers(1);
    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.PAUSE));

    const byPlayer = session.handle(P1, intent(BENCHMARK_INTENTS.RESUME));
    expect(byPlayer.ack.ok).toBe(false);
    if (!byPlayer.ack.ok) expect(byPlayer.ack.error.code).toBe('UNAUTHORIZED_ACTOR');
    expect(session.paused).toBe(true);

    const byHost = session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.RESUME));
    expect(byHost.ack.ok).toBe(true);
    expect(session.paused).toBe(false);
  });

  it('rejects pausing twice without corrupting state', () => {
    setupHostAndPlayers(1);
    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.PAUSE));
    const again = session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.PAUSE));

    expect(again.ack.ok).toBe(false);
    expect(session.paused).toBe(true);
  });

  it('rejects resuming when not paused', () => {
    setupHostAndPlayers(1);
    const { ack } = session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.RESUME));
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('WRONG_STATE');
  });

  it('rejects a buzz while paused', () => {
    setupHostAndPlayers(1);
    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.OPEN_BUZZER));
    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.PAUSE));

    const { ack } = session.handle(P1, intent(BENCHMARK_INTENTS.BUZZ));
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('WRONG_STATE');
  });
});

describe('timer', () => {
  it('does not consume remaining time while paused', () => {
    setupHostAndPlayers(1);
    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.START_TIMER, { durationMs: 30_000 }));

    clock.advance(5_000);
    expect(session.snapshot().timer.remainingMs).toBe(25_000);

    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.PAUSE));
    clock.advance(60_000); // A long pause must not eat the timer.
    expect(session.snapshot().timer.remainingMs).toBe(25_000);

    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.RESUME));
    expect(session.snapshot().timer.remainingMs).toBe(25_000);

    clock.advance(5_000);
    expect(session.snapshot().timer.remainingMs).toBe(20_000);
  });

  it('survives repeated pause/resume cycles', () => {
    setupHostAndPlayers(1);
    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.START_TIMER, { durationMs: 20_000 }));

    for (let i = 0; i < 4; i += 1) {
      clock.advance(1_000);
      session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.PAUSE));
      clock.advance(10_000);
      session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.RESUME));
    }
    // Only the four 1s running periods should have counted.
    expect(session.snapshot().timer.remainingMs).toBe(16_000);
  });

  it('rejects an invalid duration', () => {
    setupHostAndPlayers(1);
    const { ack } = session.handle(
      HOST_CONN,
      intent(BENCHMARK_INTENTS.START_TIMER, { durationMs: -5 }),
    );
    expect(ack.ok).toBe(false);
  });
});

describe('reconnect identity', () => {
  it('restores identity without creating a duplicate client', () => {
    setupHostAndPlayers(1);
    expect(session.clientCount()).toBe(2);

    session.onDisconnect(P1);
    expect(session.connectedClientCount()).toBe(1);

    hello('conn-p1-new', 'player-1');
    expect(session.clientCount()).toBe(2); // still two identities
    expect(session.connectedClientCount()).toBe(2);
  });

  it('does not resume a paused session on reconnect', () => {
    // The rule under test: GAME_RULES_LOCKED.md §20 — reconnecting does not
    // automatically resume gameplay. Only the Host can.
    setupHostAndPlayers(1);
    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.PAUSE));
    expect(session.paused).toBe(true);

    session.onDisconnect(P1);
    hello('conn-p1-new', 'player-1');

    expect(session.paused).toBe(true);
  });

  it('provides a fresh snapshot after reconnect', () => {
    setupHostAndPlayers(1);
    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.START_TIMER, { durationMs: 10_000 }));
    session.onDisconnect(P1);

    const { events } = hello('conn-p1-new', 'player-1');
    const payload = events[0]?.payload as { snapshot?: { timer: { active: boolean } } };
    expect(payload.snapshot?.timer.active).toBe(true);
  });
});

describe('three clients', () => {
  it('tracks all of them and locks the buzzer once', () => {
    setupHostAndPlayers(3);
    expect(session.clientCount()).toBe(4); // host + 3

    session.handle(HOST_CONN, intent(BENCHMARK_INTENTS.OPEN_BUZZER));
    const results = [P1, P2, P3].map((conn) =>
      session.handle(conn, intent(BENCHMARK_INTENTS.BUZZ)),
    );

    expect(results.filter((r) => r.ack.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ack.ok)).toHaveLength(2);
  });
});
