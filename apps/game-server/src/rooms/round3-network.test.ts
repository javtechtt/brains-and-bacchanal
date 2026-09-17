import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  GAME_INTENTS,
  ROOM_INTENTS,
  ROUND3_EVENTS,
  ROUND3_INTENTS,
  SHARED_INTENTS,
  type HostGameSnapshot,
  type PlayerGameSnapshot,
} from '@bb/protocol';
import { createGameServer, type GameServer } from '../server.js';
import { loadConfig } from '../config.js';
import { RoomClient } from './client.js';

/**
 * Round 3 END TO END, over a REAL WebSocket against the REAL production server.
 *
 * Phase 6 found a bug this way and Phase 7A found another: in-process tests can
 * pass while the SERIALISED client view is wrong. So these assert what actually
 * arrives on the wire.
 *
 * Two claims here are about BYTES rather than return values, and only a real
 * socket can check them:
 *
 *   1. An unrevealed rock-paper-scissors choice is not in an opponent's JSON.
 *   2. A future content item is not in anyone's JSON.
 */

const PORT = 4617;
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

  return {
    host,
    p1,
    p2,
    roomId: payload.roomId,
    roomCode: payload.roomCode,
    hostToken: payload.hostToken,
  };
}

async function closeParty(party: Party): Promise<void> {
  await Promise.all([party.host.disconnect(), party.p1.disconnect(), party.p2.disconnect()]);
}

async function enterRound3(party: Party): Promise<void> {
  await party.host.submit(GAME_INTENTS.START_GAME, {});
  const entered = await party.host.submit(ROUND3_INTENTS.DEV_START_ROUND3, {});
  if (!entered.ok) throw new Error(`dev entry failed: ${entered.error.code}`);
}

async function beginChallenge(party: Party): Promise<void> {
  await party.host.submit(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'CHALLENGE_INTRO' });
  await party.host.submit(ROUND3_INTENTS.HOST_PREPARE_ROUND3_CHALLENGE, {});
  await party.host.submit(GAME_INTENTS.HOST_START_CHALLENGE, {});
}

async function playChallenge(party: Party, teamId: string): Promise<void> {
  await beginChallenge(party);
  const confirmed = await party.host.submit(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, {
    teamId,
  });
  if (!confirmed.ok) throw new Error(`confirm failed: ${confirmed.error.code}`);
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

/** The raw JSON a client received, for substring assertions about secrecy. */
async function rawSnapshotJson(client: RoomClient): Promise<string> {
  const ack = await client.submit(GAME_INTENTS.REQUEST_GAME_SNAPSHOT, {});
  return JSON.stringify(ack.ok ? ack.snapshot : {});
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

describe('the Round 3 snapshot on the wire', () => {
  it('reaches the Host with the four challenges and zeroed counters', async () => {
    const party = await makeParty();
    try {
      await enterRound3(party);
      const snapshot = await hostSnapshot(party);
      const round3 = snapshot.game?.round3;

      expect(round3?.roundIndex).toBe(3);
      expect(round3?.challenges.map((c) => c.challengeType)).toEqual([
        'THINK_FAST',
        'GUESS_THE_LOGO',
        'ALL_ANSWERS_BEGIN_WITH',
        'SING_A_SONG',
      ]);
      expect(round3?.challengeWins).toEqual({ TEAM_A: 0, TEAM_B: 0 });
      expect(round3?.previousRoundOrder).toHaveLength(2);
      expect(round3?.complete).toBe(false);
    } finally {
      await closeParty(party);
    }
  });

  it('reaches a PHONE with the same public Round 3 state', async () => {
    const party = await makeParty();
    try {
      await enterRound3(party);
      await beginChallenge(party);

      const snapshot = await playerSnapshot(party.p1);
      const round3 = snapshot.game?.round3;

      expect(snapshot.isHost).toBe(false);
      expect(round3?.current?.challengeType).toBe('THINK_FAST');
      expect(round3?.current?.displayName).toBe('Think Fast');
      expect(round3?.current?.thinkFast?.currentTeamId).toBeDefined();
      expect(round3?.challengeWins).toBeDefined();
    } finally {
      await closeParty(party);
    }
  });

  it('carries the challenge score, the counter and the BB separately', async () => {
    // The §13 distinction, asserted on real serialised JSON.
    const party = await makeParty();
    try {
      await enterRound3(party);
      await playChallenge(party, 'TEAM_A'); // Think Fast: 500 BB + 1 win

      await beginChallenge(party); // Guess the Logo: points only
      for (let i = 0; i < 5; i += 1) {
        await party.host.submit(ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT, { teamId: 'TEAM_A' });
      }

      const mid = await hostSnapshot(party);
      expect(mid.game?.round3?.current?.scores['TEAM_A']).toBe(5);
      expect(mid.game?.round3?.current?.targetReached).toBe(true);
      // Reaching the target did NOT resolve it — §15.
      expect(mid.game?.round3?.current?.progress).toBe('in_progress');
      expect(mid.game?.round3?.challengeWins['TEAM_A']).toBe(1);
      expect(mid.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_500);

      await party.host.submit(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, {
        teamId: 'TEAM_A',
      });

      const after = await hostSnapshot(party);
      // One more WIN, and no BB — Guess the Logo pays none.
      expect(after.game?.round3?.challengeWins['TEAM_A']).toBe(2);
      expect(after.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_500);
    } finally {
      await closeParty(party);
    }
  });

  it('reveals only the current item, never a future one', async () => {
    // CONTENT_POLICY.md — a claim about bytes, so asserted against raw JSON.
    const party = await makeParty();
    try {
      await enterRound3(party);
      await playChallenge(party, 'TEAM_A');
      await beginChallenge(party); // Guess the Logo

      await party.host.submit(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM, {});
      const first = (await hostSnapshot(party)).game?.round3?.current?.currentItem;
      expect(first?.index).toBe(1);

      const hostJson = await rawSnapshotJson(party.host);
      const playerJson = await rawSnapshotJson(party.p1);

      // The NEXT test logo is not in anyone's payload.
      expect(hostJson).not.toContain('gtl-test-002');
      expect(playerJson).not.toContain('gtl-test-002');
      // Nor a count that would reveal how many remain.
      expect(hostJson).not.toContain('gtl-test-008');
    } finally {
      await closeParty(party);
    }
  });
});

describe('Round 3 authority over a real socket', () => {
  it('refuses a phone that tries to award its own team a point', async () => {
    const party = await makeParty();
    try {
      await enterRound3(party);
      await playChallenge(party, 'TEAM_A');
      await beginChallenge(party);

      const ack = await party.p1.submit(ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT, {
        teamId: 'TEAM_A',
      });
      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.code).toBe('UNAUTHORIZED_ACTOR');

      const snapshot = await hostSnapshot(party);
      expect(snapshot.game?.round3?.current?.scores['TEAM_A']).toBe(0);
    } finally {
      await closeParty(party);
    }
  });

  it('refuses a phone that tries to confirm a challenge winner', async () => {
    const party = await makeParty();
    try {
      await enterRound3(party);
      await beginChallenge(party);

      const ack = await party.p1.submit(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, {
        teamId: 'TEAM_A',
      });
      expect(ack.ok).toBe(false);

      const snapshot = await hostSnapshot(party);
      expect(snapshot.game?.round3?.challengeWins['TEAM_A']).toBe(0);
    } finally {
      await closeParty(party);
    }
  });

  it('ignores content a Host client tries to supply', async () => {
    // §13 — the game supplies challenge content, not the Host.
    const party = await makeParty();
    try {
      await enterRound3(party);
      await playChallenge(party, 'TEAM_A');
      await beginChallenge(party);

      await party.host.submit(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM, {
        body: 'HOST INVENTED THIS PROMPT',
        itemId: 'forged-item',
      });

      const json = await rawSnapshotJson(party.host);
      expect(json).not.toContain('HOST INVENTED THIS PROMPT');
      expect(json).not.toContain('forged-item');
      expect(json).toContain('TEST');
    } finally {
      await closeParty(party);
    }
  });
});

describe('the rock-paper-scissors tiebreaker on the wire', () => {
  /** Four challenges split 2-2 so the counter ties. */
  async function tie(party: Party): Promise<void> {
    await enterRound3(party);
    await playChallenge(party, 'TEAM_A');
    await playChallenge(party, 'TEAM_B');
    await playChallenge(party, 'TEAM_A');
    await playChallenge(party, 'TEAM_B');
  }

  it('starts a tiebreaker rather than picking a winner', async () => {
    const party = await makeParty();
    try {
      await tie(party);
      const snapshot = await hostSnapshot(party);
      const round3 = snapshot.game?.round3;

      expect(round3?.challengeWins).toEqual({ TEAM_A: 2, TEAM_B: 2 });
      expect(round3?.winningTeamId).toBeNull();
      expect(round3?.tiebreaker?.tiedTeamIds).toEqual(['TEAM_A', 'TEAM_B']);
    } finally {
      await closeParty(party);
    }
  });

  it('NEVER puts an unrevealed choice in an opponent JSON', async () => {
    // The secrecy claim that matters, asserted on real wire bytes. §18.
    const party = await makeParty();
    try {
      await tie(party);
      await party.p1.submit(ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'SCISSORS' });

      const opponentJson = await rawSnapshotJson(party.p2);
      const hostJson = await rawSnapshotJson(party.host);
      expect(opponentJson).not.toContain('SCISSORS');
      // Not even the Host sees a choice before the reveal.
      expect(hostJson).not.toContain('SCISSORS');

      // But the owner does see its own.
      const own = await playerSnapshot(party.p1);
      expect(own.game?.round3?.tiebreaker?.yourChoice).toBe('SCISSORS');

      // And the broadcast says WHO chose, never what.
      const publicView = (await hostSnapshot(party)).game?.round3?.tiebreaker;
      expect(publicView?.current?.submittedTeamIds).toEqual(['TEAM_A']);
      expect(publicView?.current?.choices).toEqual({});
    } finally {
      await closeParty(party);
    }
  });

  it('reveals and resolves once both teams have chosen', async () => {
    const party = await makeParty();
    try {
      await tie(party);

      const revealed = party.host.waitForEvent(ROUND3_EVENTS.RPS_REVEALED, 10_000);
      await party.p1.submit(ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'ROCK' });
      await party.p2.submit(ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'SCISSORS' });
      await revealed;

      const snapshot = await hostSnapshot(party);
      expect(snapshot.game?.round3?.winningTeamId).toBe('TEAM_A');
      expect(snapshot.game?.round3?.tiebreaker?.complete).toBe(true);
      // Revealed now, and only now.
      expect(snapshot.game?.round3?.tiebreaker?.history[0]?.choices).toEqual({
        TEAM_A: 'ROCK',
        TEAM_B: 'SCISSORS',
      });
    } finally {
      await closeParty(party);
    }
  }, 20_000);

  it('replays an identical throw and opens a fresh attempt', async () => {
    const party = await makeParty();
    try {
      await tie(party);

      const revealed = party.host.waitForEvent(ROUND3_EVENTS.RPS_REVEALED, 10_000);
      await party.p1.submit(ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'PAPER' });
      await party.p2.submit(ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'PAPER' });
      await revealed;

      const snapshot = await hostSnapshot(party);
      expect(snapshot.game?.round3?.winningTeamId).toBeNull();
      expect(snapshot.game?.round3?.tiebreaker?.current?.attemptNumber).toBe(2);
      expect(snapshot.game?.round3?.tiebreaker?.current?.submittedTeamIds).toEqual([]);
    } finally {
      await closeParty(party);
    }
  }, 20_000);
});

describe('a whole Round 3 over a real socket', () => {
  it('runs Market, four challenges and declares a winner', async () => {
    const party = await makeParty();
    try {
      await enterRound3(party);

      await party.host.submit(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'MARKET' });
      await party.host.submit(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 3 });
      const bought = await party.p1.submit(SHARED_INTENTS.PURCHASE_MARKET_ITEM, { item: 'CLUE' });
      expect(bought.ok).toBe(true);
      await party.host.submit(SHARED_INTENTS.HOST_CLOSE_MARKET, {});

      await playChallenge(party, 'TEAM_A');
      await playChallenge(party, 'TEAM_A');
      await playChallenge(party, 'TEAM_A');
      await playChallenge(party, 'TEAM_B');

      const snapshot = await hostSnapshot(party);
      const round3 = snapshot.game?.round3;
      expect(round3?.complete).toBe(true);
      expect(round3?.challengeWins).toEqual({ TEAM_A: 3, TEAM_B: 1 });
      expect(round3?.winningTeamId).toBe('TEAM_A');
      expect(round3?.tiebreaker).toBeNull();

      // 1,000 - 250 (R3 Clue) + 500 (Think Fast)
      expect(snapshot.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_250);
      // Sing a Song's 500 went to B.
      expect(snapshot.teams.find((t) => t.teamId === 'TEAM_B')?.bb).toBe(1_500);
    } finally {
      await closeParty(party);
    }
  }, 30_000);

  it('restores a reconnecting phone mid-challenge without duplicating', async () => {
    const party = await makeParty();
    try {
      await enterRound3(party);
      await playChallenge(party, 'TEAM_A');
      await beginChallenge(party);
      await party.host.submit(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM, {});
      await party.host.submit(ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT, { teamId: 'TEAM_B' });

      await party.p1.disconnect();
      const back = await connectClient();
      back.roomId = party.roomId;
      const ack = await back.submit(ROOM_INTENTS.RECONNECT_PLAYER, {
        playerId: party.p1.playerId,
        reconnectToken: party.p1.reconnectToken,
      });
      expect(ack.ok).toBe(true);

      const snapshot = await playerSnapshot(back);
      const round3 = snapshot.game?.round3;
      expect(round3?.resolvedCount).toBe(1);
      expect(round3?.challengeWins['TEAM_A']).toBe(1);
      expect(round3?.current?.scores['TEAM_B']).toBe(1);
      expect(round3?.current?.currentItem?.index).toBe(1);
      expect(snapshot.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_500);

      await back.disconnect();
    } finally {
      await closeParty(party);
    }
  });

  it('restores the Unity Host to the same round', async () => {
    const party = await makeParty();
    try {
      await enterRound3(party);
      await playChallenge(party, 'TEAM_A');
      await beginChallenge(party);

      await party.host.disconnect();
      const back = await connectClient();
      back.roomId = party.roomId;
      const ack = await back.submit(ROOM_INTENTS.RECONNECT_HOST, { hostToken: party.hostToken });
      expect(ack.ok).toBe(true);

      const snapshotAck = await back.submit(GAME_INTENTS.REQUEST_GAME_SNAPSHOT, {});
      const snapshot = snapshotAck.ok ? (snapshotAck.snapshot as HostGameSnapshot) : null;
      expect(snapshot?.game?.round3?.resolvedCount).toBe(1);
      expect(snapshot?.game?.round3?.current?.challengeType).toBe('GUESS_THE_LOGO');

      await back.disconnect();
    } finally {
      await Promise.all([party.p1.disconnect(), party.p2.disconnect()]);
    }
  });
});
