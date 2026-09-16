import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  GAME_EVENTS,
  GAME_INTENTS,
  ROOM_INTENTS,
  type HostGameSnapshot,
  type PlayerGameSnapshot,
} from '@bb/protocol';
import { createGameServer, type GameServer } from '../server.js';
import { loadConfig } from '../config.js';
import { RoomClient } from './client.js';

/**
 * The Phase 5 engine END TO END, over a REAL WebSocket against the REAL
 * production server.
 *
 * The engine is already covered deterministically in @bb/game-rules. What this
 * file covers is everything BETWEEN the engine and a phone: framing, ack
 * correlation, per-room fan-out of gameplay events, the socket lifecycle that
 * triggers auto-pause, and the timer tick that only exists in the server
 * process.
 *
 * Phase 3 is why this exists: its worst bugs all passed unit tests and failed
 * the moment something real connected.
 *
 * Real sockets and a real clock, so durations are kept short deliberately.
 */

const PORT = 4611;
const logger = pino({ level: 'silent' });

let server: GameServer;

function url(): string {
  return `ws://127.0.0.1:${PORT}/room/ws`;
}

interface Party {
  readonly host: RoomClient;
  readonly p1: RoomClient;
  readonly p2: RoomClient;
  readonly roomId: string;
  readonly roomCode: string;
  readonly hostToken: string;
}

async function connectClient(): Promise<RoomClient> {
  const client = new RoomClient({ url: url() });
  await client.connect();
  return client;
}

/** A room with two players on two teams, teams locked. */
async function makeParty(): Promise<Party> {
  const host = await connectClient();
  const created = await host.submit(ROOM_INTENTS.CREATE_ROOM, {});
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`);

  const payload = created.snapshot as { roomId: string; roomCode: string; hostToken: string };
  host.roomId = payload.roomId;
  host.hostToken = payload.hostToken;

  const join = async (name: string): Promise<RoomClient> => {
    const client = await connectClient();
    client.roomId = payload.roomId;
    const ack = await client.submit(ROOM_INTENTS.JOIN_ROOM, {
      roomCode: payload.roomCode,
      displayName: name,
    });
    if (!ack.ok) throw new Error(`join failed: ${ack.error.code}`);
    const joined = ack.snapshot as { playerId: string; reconnectToken: string };
    client.playerId = joined.playerId;
    client.reconnectToken = joined.reconnectToken;
    return client;
  };

  const p1 = await join('Javal');
  const p2 = await join('Ama');

  await host.submit(ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM, {
    playerId: p1.playerId,
    teamId: 'TEAM_A',
  });
  await host.submit(ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM, {
    playerId: p2.playerId,
    teamId: 'TEAM_B',
  });
  await host.submit(ROOM_INTENTS.HOST_LOCK_TEAMS, {});

  return { host, p1, p2, roomId: payload.roomId, roomCode: payload.roomCode, hostToken: payload.hostToken };
}

async function closeParty(party: Party): Promise<void> {
  await Promise.all([party.host.disconnect(), party.p1.disconnect(), party.p2.disconnect()]);
}

/** Start a game and open a running challenge with p1 active. */
async function startChallenge(party: Party, durationMs = 30_000): Promise<void> {
  await party.host.submit(GAME_INTENTS.START_GAME, {});
  await party.host.submit(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'CHALLENGE_INTRO' });
  await party.host.submit(GAME_INTENTS.HOST_PREPARE_CHALLENGE, { challengeType: 'TEST_CHALLENGE' });
  await party.host.submit(GAME_INTENTS.HOST_START_CHALLENGE, {});
  await party.host.submit(GAME_INTENTS.HOST_SET_TURN, {
    teamId: 'TEAM_A',
    playerId: party.p1.playerId,
  });
  await party.host.submit(GAME_INTENTS.HOST_SET_ACTIVE_PLAYERS, { playerIds: [party.p1.playerId] });
  await party.host.submit(GAME_INTENTS.HOST_START_TIMER, { durationMs });
}

async function hostSnapshot(party: Party): Promise<HostGameSnapshot> {
  const ack = await party.host.submit(GAME_INTENTS.REQUEST_GAME_SNAPSHOT, {});
  if (!ack.ok) throw new Error('snapshot failed');
  return ack.snapshot as HostGameSnapshot;
}

async function playerSnapshot(client: RoomClient): Promise<PlayerGameSnapshot> {
  const ack = await client.submit(GAME_INTENTS.REQUEST_GAME_SNAPSHOT, {});
  if (!ack.ok) throw new Error('snapshot failed');
  return ack.snapshot as PlayerGameSnapshot;
}

beforeAll(async () => {
  server = createGameServer(
    {
      ...loadConfig({}),
      port: PORT,
      host: '127.0.0.1',
      publicBaseUrl: 'http://127.0.0.1:3000',
      devTools: true,
    },
    logger,
  );
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

describe('starting a game over a real socket', () => {
  it('starts from locked teams and gives every team 1,000 BB', async () => {
    const party = await makeParty();
    try {
      const ack = await party.host.submit(GAME_INTENTS.START_GAME, {});
      expect(ack.ok).toBe(true);

      const snapshot = await hostSnapshot(party);
      expect(snapshot.teams.map((team) => team.bb)).toEqual([1_000, 1_000]);
      expect(snapshot.game?.phase).toBe('ROUND_INTRO');
    } finally {
      await closeParty(party);
    }
  });

  it('both phones see the same balances the Host sees', async () => {
    const party = await makeParty();
    try {
      await party.host.submit(GAME_INTENTS.START_GAME, {});

      const fromHost = await hostSnapshot(party);
      const fromP1 = await playerSnapshot(party.p1);
      const fromP2 = await playerSnapshot(party.p2);

      const balances = (s: { teams: readonly { teamId: string; bb: number }[] }) =>
        Object.fromEntries(s.teams.map((t) => [t.teamId, t.bb]));

      // One authoritative number, not three independently computed ones.
      expect(balances(fromP1)).toEqual(balances(fromHost));
      expect(balances(fromP2)).toEqual(balances(fromHost));
      expect(fromP1.yourTeamId).toBe('TEAM_A');
      expect(fromP2.yourTeamId).toBe('TEAM_B');
    } finally {
      await closeParty(party);
    }
  });

  it('rejects START_GAME while teams are unlocked', async () => {
    const party = await makeParty();
    try {
      await party.host.submit(ROOM_INTENTS.HOST_UNLOCK_TEAMS, {});
      const ack = await party.host.submit(GAME_INTENTS.START_GAME, {});

      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.code).toBe('WRONG_STATE');
    } finally {
      await closeParty(party);
    }
  });

  it('rejects START_GAME from a phone', async () => {
    const party = await makeParty();
    try {
      const ack = await party.p1.submit(GAME_INTENTS.START_GAME, {});
      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.code).toBe('UNAUTHORIZED_ACTOR');
    } finally {
      await closeParty(party);
    }
  });

  it('broadcasts GAME_STARTED to every client in the room', async () => {
    const party = await makeParty();
    try {
      await party.host.submit(GAME_INTENTS.START_GAME, {});

      const seen = await Promise.all([
        party.p1.waitForEvent(GAME_EVENTS.GAME_STARTED),
        party.p2.waitForEvent(GAME_EVENTS.GAME_STARTED),
      ]);
      expect(seen.every((event) => event.type === GAME_EVENTS.GAME_STARTED)).toBe(true);
    } finally {
      await closeParty(party);
    }
  });

  it('does not leak one party\'s game into another room', async () => {
    const a = await makeParty();
    const b = await makeParty();
    try {
      await a.host.submit(GAME_INTENTS.START_GAME, {});
      await a.host.submit(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: 500 });

      const other = await playerSnapshot(b.p1);
      expect(other.game).toBeNull();
      expect(b.p1.receivedEvents().some((e) => e.type === GAME_EVENTS.GAME_STARTED)).toBe(false);
    } finally {
      await closeParty(a);
      await closeParty(b);
    }
  });
});

describe('BB over a real socket', () => {
  it('awards, deducts and floors at 0, and every client agrees', async () => {
    const party = await makeParty();
    try {
      await party.host.submit(GAME_INTENTS.START_GAME, {});

      await party.host.submit(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: 500 });
      expect((await playerSnapshot(party.p1)).teams[0]?.bb).toBe(1_500);

      await party.host.submit(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: -300 });
      expect((await playerSnapshot(party.p1)).teams[0]?.bb).toBe(1_200);

      await party.host.submit(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: -5_000 });

      const host = await hostSnapshot(party);
      const phone = await playerSnapshot(party.p1);
      expect(host.teams[0]?.bb).toBe(0);
      expect(phone.teams[0]?.bb).toBe(0);
      // Independent balances.
      expect(host.teams[1]?.bb).toBe(1_000);

      // The ledger shows the separate steps, not just the result.
      const teamA = host.ledger.filter((entry) => entry.teamId === 'TEAM_A');
      expect(teamA.map((entry) => entry.balanceAfter)).toEqual([1_000, 1_500, 1_200, 0]);
    } finally {
      await closeParty(party);
    }
  });

  it('keeps the floored balance across a reconnect', async () => {
    const party = await makeParty();
    try {
      await party.host.submit(GAME_INTENTS.START_GAME, {});
      await party.host.submit(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: -9_000 });

      await party.p1.disconnect();
      const returning = await connectClient();
      returning.roomId = party.roomId;
      const ack = await returning.submit(ROOM_INTENTS.RECONNECT_PLAYER, {
        playerId: party.p1.playerId,
        reconnectToken: party.p1.reconnectToken,
      });
      expect(ack.ok).toBe(true);

      // Balance comes from the server, not recomputed on the client.
      expect((await playerSnapshot(returning)).teams[0]?.bb).toBe(0);
      await returning.disconnect();
    } finally {
      await party.host.disconnect();
      await party.p2.disconnect();
    }
  });

  it('does not double-apply a retried award', async () => {
    const party = await makeParty();
    try {
      await party.host.submit(GAME_INTENTS.START_GAME, {});

      const intentId = 'retry-award-1';
      await party.host.submit(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: 500 }, intentId);
      const replay = await party.host.submit(
        GAME_INTENTS.DEV_ADJUST_BB,
        { teamId: 'TEAM_A', delta: 500 },
        intentId,
      );

      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.error.code).toBe('DUPLICATE_INTENT');
      expect((await hostSnapshot(party)).teams[0]?.bb).toBe(1_500);
    } finally {
      await closeParty(party);
    }
  });

  it('refuses a phone that tries to award itself BB', async () => {
    const party = await makeParty();
    try {
      await party.host.submit(GAME_INTENTS.START_GAME, {});
      const ack = await party.p1.submit(GAME_INTENTS.DEV_ADJUST_BB, {
        teamId: 'TEAM_A',
        delta: 100_000,
      });

      expect(ack.ok).toBe(false);
      expect((await hostSnapshot(party)).teams[0]?.bb).toBe(1_000);
    } finally {
      await closeParty(party);
    }
  });
});

describe('auto-pause over a real socket', () => {
  it('pauses when the ACTIVE player\'s socket drops, and freezes the timer', async () => {
    const party = await makeParty();
    try {
      await startChallenge(party, 30_000);

      // The real disconnect path: the socket actually closes.
      await party.p1.disconnect();
      await party.host.waitForEvent(GAME_EVENTS.GAME_PAUSED);

      const snapshot = await hostSnapshot(party);
      expect(snapshot.game?.paused).toBe(true);
      expect(snapshot.game?.pause?.reason).toBe('player_disconnect');
      expect(snapshot.game?.pause?.pausedByPlayerId).toBe(party.p1.playerId);

      const frozen = snapshot.game?.challenge?.timer?.remainingMs ?? 0;
      expect(frozen).toBeGreaterThan(0);

      await new Promise((resolve) => setTimeout(resolve, 300));
      const later = await hostSnapshot(party);
      // Wall-clock time passed; the deadline did not move.
      expect(later.game?.challenge?.timer?.remainingMs).toBe(frozen);
    } finally {
      await party.host.disconnect();
      await party.p2.disconnect();
    }
  });

  it('does NOT pause when a non-active player drops', async () => {
    const party = await makeParty();
    try {
      await startChallenge(party);

      await party.p2.disconnect();
      await party.host.waitForEvent('PLAYER_DISCONNECTED');

      const snapshot = await hostSnapshot(party);
      expect(snapshot.game?.paused).toBe(false);
      // Their connection state still updates.
      expect(snapshot.players.find((p) => p.playerId === party.p2.playerId)?.connection).toBe(
        'disconnected',
      );
    } finally {
      await party.host.disconnect();
      await party.p1.disconnect();
    }
  });

  it('stays paused when the player reconnects, and only the Host resumes', async () => {
    const party = await makeParty();
    try {
      await startChallenge(party, 30_000);
      await party.p1.disconnect();
      await party.host.waitForEvent(GAME_EVENTS.GAME_PAUSED);

      const returning = await connectClient();
      returning.roomId = party.roomId;
      const ack = await returning.submit(ROOM_INTENTS.RECONNECT_PLAYER, {
        playerId: party.p1.playerId,
        reconnectToken: party.p1.reconnectToken,
      });
      expect(ack.ok).toBe(true);

      // D-011 — reconnecting does not resume.
      const afterReconnect = await playerSnapshot(returning);
      expect(afterReconnect.game?.paused).toBe(true);
      expect(afterReconnect.you).toBe(party.p1.playerId);
      expect(afterReconnect.yourTeamId).toBe('TEAM_A');

      // A phone cannot resume.
      const byPhone = await returning.submit(GAME_INTENTS.HOST_RESUME_GAME, {});
      expect(byPhone.ok).toBe(false);
      expect((await hostSnapshot(party)).game?.paused).toBe(true);

      const byHost = await party.host.submit(GAME_INTENTS.HOST_RESUME_GAME, {});
      expect(byHost.ok).toBe(true);

      const resumed = await hostSnapshot(party);
      expect(resumed.game?.paused).toBe(false);
      // Back to the interrupted phase, with the same challenge and turn.
      expect(resumed.game?.phase).toBe('ACTIVE_PLAY');
      expect(resumed.game?.turn.playerId).toBe(party.p1.playerId);
      expect(resumed.game?.challenge?.timer?.remainingMs).toBeGreaterThan(0);

      await returning.disconnect();
    } finally {
      await party.host.disconnect();
      await party.p2.disconnect();
    }
  });

  it('lets the Host resume without the player coming back', async () => {
    const party = await makeParty();
    try {
      await startChallenge(party);
      await party.p1.disconnect();
      await party.host.waitForEvent(GAME_EVENTS.GAME_PAUSED);

      expect((await party.host.submit(GAME_INTENTS.HOST_RESUME_GAME, {})).ok).toBe(true);
      expect((await hostSnapshot(party)).game?.paused).toBe(false);
    } finally {
      await party.host.disconnect();
      await party.p2.disconnect();
    }
  });
});

describe('timers over a real socket', () => {
  it('announces expiry on the server tick with nobody acting', async () => {
    const party = await makeParty();
    try {
      // Short, because this one waits on a real clock.
      await startChallenge(party, 400);

      const expired = await party.host.waitForEvent(GAME_EVENTS.TIMER_EXPIRED, 4_000);
      const payload = expired.payload as { requiresHostDecision: boolean };
      // The tick reported it; no client asked for anything.
      expect(payload.requiresHostDecision).toBe(true);

      const snapshot = await hostSnapshot(party);
      expect(snapshot.game?.phase).toBe('HOST_REVIEW');
      // No consequence was invented: nobody lost BB for running out of time.
      expect(snapshot.teams.map((t) => t.bb)).toEqual([1_000, 1_000]);
    } finally {
      await closeParty(party);
    }
  });

  it('announces an expiry exactly once', async () => {
    const party = await makeParty();
    try {
      await startChallenge(party, 300);
      await party.host.waitForEvent(GAME_EVENTS.TIMER_EXPIRED, 4_000);
      await new Promise((resolve) => setTimeout(resolve, 900));

      const expiries = party.host
        .receivedEvents()
        .filter((event) => event.type === GAME_EVENTS.TIMER_EXPIRED);
      expect(expiries).toHaveLength(1);
    } finally {
      await closeParty(party);
    }
  });
});

describe('Host judgment over a real socket', () => {
  it('records a ruling and resolves the challenge through the ledger', async () => {
    const party = await makeParty();
    try {
      await startChallenge(party);

      expect(
        (await party.host.submit(GAME_INTENTS.HOST_RULING, { kind: 'valid', teamId: 'TEAM_A' })).ok,
      ).toBe(true);

      const ruled = await hostSnapshot(party);
      expect(ruled.game?.challenge?.rulings).toHaveLength(1);
      // A ruling alone moves no BB.
      expect(ruled.teams[0]?.bb).toBe(1_000);

      await party.host.submit(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, {
        winningTeamIds: ['TEAM_A'],
        bbDeltas: { TEAM_A: 500 },
      });

      const resolved = await hostSnapshot(party);
      expect(resolved.teams[0]?.bb).toBe(1_500);
      expect(resolved.game?.challenge?.status).toBe('resolved');
      expect(resolved.ledger.at(-1)?.reason).toBe('challenge_result');
    } finally {
      await closeParty(party);
    }
  });

  it('refuses a ruling from a phone', async () => {
    const party = await makeParty();
    try {
      await startChallenge(party);
      const ack = await party.p1.submit(GAME_INTENTS.HOST_RULING, {
        kind: 'valid',
        teamId: 'TEAM_A',
      });

      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.code).toBe('UNAUTHORIZED_ACTOR');
      expect((await hostSnapshot(party)).game?.challenge?.rulings).toHaveLength(0);
    } finally {
      await closeParty(party);
    }
  });

  it('does not award twice for a retried resolution', async () => {
    const party = await makeParty();
    try {
      await startChallenge(party);

      const intentId = 'retry-resolve-1';
      const payload = { winningTeamIds: ['TEAM_A'], bbDeltas: { TEAM_A: 500 } };
      await party.host.submit(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, payload, intentId);
      const replay = await party.host.submit(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, payload, intentId);

      expect(replay.ok).toBe(false);
      expect((await hostSnapshot(party)).teams[0]?.bb).toBe(1_500);
    } finally {
      await closeParty(party);
    }
  });

  it('refuses a second, distinct resolution of the same challenge', async () => {
    const party = await makeParty();
    try {
      await startChallenge(party);
      await party.host.submit(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, { bbDeltas: { TEAM_A: 500 } });
      const second = await party.host.submit(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, {
        bbDeltas: { TEAM_A: 500 },
      });

      expect(second.ok).toBe(false);
      expect((await hostSnapshot(party)).teams[0]?.bb).toBe(1_500);
    } finally {
      await closeParty(party);
    }
  });
});

describe('snapshots over a real socket', () => {
  it('gives the Host the ledger and a phone none of it', async () => {
    const party = await makeParty();
    try {
      await startChallenge(party);
      await party.host.submit(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: 250 });

      const host = await hostSnapshot(party);
      expect(host.isHost).toBe(true);
      expect(host.ledger.length).toBeGreaterThan(0);

      const phone = await playerSnapshot(party.p1);
      expect(phone.isHost).toBe(false);
      expect('ledger' in phone).toBe(false);
    } finally {
      await closeParty(party);
    }
  });

  it('never sends a credential or the Host token to any client', async () => {
    const party = await makeParty();
    try {
      await startChallenge(party);

      for (const client of [party.host, party.p1, party.p2]) {
        const ack = await client.submit(GAME_INTENTS.REQUEST_GAME_SNAPSHOT, {});
        const json = JSON.stringify(ack.ok ? ack.snapshot : {});
        expect(json).not.toContain('reconnectToken');
        expect(json).not.toContain('hostToken');
        expect(json).not.toContain(party.hostToken);
        expect(json).not.toContain(party.p2.reconnectToken);
      }
    } finally {
      await closeParty(party);
    }
  });

  it('tells each phone whether it is active and whose turn it is', async () => {
    const party = await makeParty();
    try {
      await startChallenge(party);

      const active = await playerSnapshot(party.p1);
      expect(active.youAreActive).toBe(true);
      expect(active.yourTurn).toBe(true);

      const watching = await playerSnapshot(party.p2);
      expect(watching.youAreActive).toBe(false);
      expect(watching.yourTurn).toBe(false);
    } finally {
      await closeParty(party);
    }
  });

  it('a snapshot read consumes no sequence number', async () => {
    const party = await makeParty();
    try {
      await party.host.submit(GAME_INTENTS.START_GAME, {});
      const before = (await hostSnapshot(party)).seq;

      await playerSnapshot(party.p1);
      await playerSnapshot(party.p2);

      expect((await hostSnapshot(party)).seq).toBe(before);
    } finally {
      await closeParty(party);
    }
  });

  it('restores the Unity Host to the same game after a reconnect', async () => {
    const party = await makeParty();
    try {
      await startChallenge(party, 30_000);
      await party.host.submit(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_B', delta: 400 });
      const before = await hostSnapshot(party);

      await party.host.disconnect();

      const returning = await connectClient();
      returning.roomId = party.roomId;
      const ack = await returning.submit(ROOM_INTENTS.RECONNECT_HOST, {
        hostToken: party.hostToken,
      });
      expect(ack.ok).toBe(true);

      const snapshotAck = await returning.submit(GAME_INTENTS.REQUEST_GAME_SNAPSHOT, {});
      if (!snapshotAck.ok) throw new Error('snapshot failed after Host reconnect');
      const after = snapshotAck.snapshot as HostGameSnapshot;

      // The SAME game, not a new one.
      expect(after.game?.gameId).toBe(before.game?.gameId);
      expect(after.game?.challenge?.challengeId).toBe(before.game?.challenge?.challengeId);
      expect(after.teams.map((t) => t.bb)).toEqual(before.teams.map((t) => t.bb));
      expect(after.game?.turn.playerId).toBe(party.p1.playerId);
      expect(after.isHost).toBe(true);
      // Sequence continues rather than restarting.
      expect(after.seq).toBeGreaterThanOrEqual(before.seq);

      await returning.disconnect();
    } finally {
      await party.p1.disconnect();
      await party.p2.disconnect();
    }
  });

  it('keeps gameplay and lobby events in one ordered sequence', async () => {
    const party = await makeParty();
    try {
      await startChallenge(party);
      await party.p2.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 200));

      const seqs = party.host.receivedEvents().map((event) => event.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

      const types = party.host.receivedEvents().map((event) => event.type);
      expect(types).toContain(GAME_EVENTS.GAME_STARTED);
      expect(types).toContain('PLAYER_DISCONNECTED');
    } finally {
      await party.host.disconnect();
      await party.p1.disconnect();
    }
  });
});
