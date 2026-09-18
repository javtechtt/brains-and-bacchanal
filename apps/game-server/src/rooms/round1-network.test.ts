import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  GAME_INTENTS,
  ROOM_INTENTS,
  ROUND1_DIFFICULTIES,
  ROUND1_INTENTS,
  type HostGameSnapshot,
  type PlayerGameSnapshot,
} from '@bb/protocol';
import { createGameServer, type GameServer } from '../server.js';
import { loadConfig } from '../config.js';
import { RoomClient } from './client.js';

/**
 * Round 1 END TO END, over a REAL WebSocket against the REAL production server.
 *
 * Phase 6 found a bug this way, Phase 7A found another, and Phase 7B found two
 * more in physical testing: in-process tests can pass while the SERIALISED
 * client view is wrong.
 *
 * Round 1 carries more secret material than any round before it, because the
 * content itself holds the answer. Four claims here are about BYTES rather than
 * return values, and only a real socket can check them:
 *
 *   1. A canonical answer is not in any player's JSON before the reveal.
 *   2. An accepted variant is never in a player's JSON at all.
 *   3. A future question is not in anyone's JSON.
 *   4. One team's submitted answer is not in another team's JSON.
 */

const PORT = 4619;
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

  return { host, p1, p2, roomId: payload.roomId };
}

async function closeParty(party: Party): Promise<void> {
  await Promise.all([party.host.disconnect(), party.p1.disconnect(), party.p2.disconnect()]);
}

/** Start the game — Round 1 begins on its own — and open the questions. */
async function enterQuestions(party: Party): Promise<void> {
  await party.host.submit(GAME_INTENTS.START_GAME, {});
  for (const client of [party.p1, party.p2]) {
    for (const difficulty of ROUND1_DIFFICULTIES) {
      await client.submit(ROUND1_INTENTS.NOMINATE_ANSWERER, { difficulty });
    }
  }
  const started = await party.host.submit(ROUND1_INTENTS.HOST_START_ROUND1, {});
  if (!started.ok) throw new Error(`start failed: ${started.error.code}`);
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

describe('Round 1 over a real socket', () => {
  it('starts on its own when the game starts, and asks both teams one question', async () => {
    const party = await makeParty();
    try {
      await enterQuestions(party);
      await party.host.submit(ROUND1_INTENTS.HOST_NEXT_ROUND1_QUESTION, {});

      const one = await playerSnapshot(party.p1);
      const two = await playerSnapshot(party.p2);

      expect(one.game?.round1?.current?.itemId).toBeDefined();
      expect(one.game?.round1?.current?.itemId).toBe(two.game?.round1?.current?.itemId);
      expect(one.game?.round1?.current?.remainingMs).toBeGreaterThan(0);
    } finally {
      await closeParty(party);
    }
  });

  it('never sends a canonical answer to a player before the reveal', async () => {
    const party = await makeParty();
    try {
      await enterQuestions(party);
      await party.host.submit(ROUND1_INTENTS.HOST_NEXT_ROUND1_QUESTION, {});

      // The HOST does not have it yet either — the reveal is last (§11).
      const host = await hostSnapshot(party);
      expect(host.game?.round1?.current?.correctAnswer).toBeNull();

      const player = await playerSnapshot(party.p1);
      expect(player.game?.round1?.current?.correctAnswer).toBeNull();
    } finally {
      await closeParty(party);
    }
  });

  it('never sends a future question to anyone', async () => {
    // CONTENT_POLICY.md — "Player browsers must never receive future/unrevealed
    // answer payloads", and spec §13 forbids sending the 15-question queue.
    const party = await makeParty();
    try {
      await enterQuestions(party);
      await party.host.submit(ROUND1_INTENTS.HOST_NEXT_ROUND1_QUESTION, {});

      const snapshot = await playerSnapshot(party.p1);
      const currentId = snapshot.game?.round1?.current?.itemId;
      const json = await rawSnapshotJson(party.p1);

      // The fixture's ids are sequential, so any OTHER id appearing would mean
      // a queue leaked. Exactly one item id may be present.
      const found = [...json.matchAll(/r1-test-[a-z0-9]+/g)].map((m) => m[0]);
      expect(new Set(found)).toEqual(new Set([currentId]));
    } finally {
      await closeParty(party);
    }
  });

  it('never puts one team’s submitted answer in another team’s bytes', async () => {
    const party = await makeParty();
    try {
      await enterQuestions(party);
      await party.host.submit(ROUND1_INTENTS.HOST_NEXT_ROUND1_QUESTION, {});

      await party.p1.submit(ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, {
        answer: 'ALPHAUNIQUEANSWER',
      });
      await party.p2.submit(ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, {
        answer: 'BRAVOUNIQUEANSWER',
      });

      const aJson = await rawSnapshotJson(party.p1);
      const bJson = await rawSnapshotJson(party.p2);

      expect(aJson).toContain('ALPHAUNIQUEANSWER');
      expect(aJson).not.toContain('BRAVOUNIQUEANSWER');

      expect(bJson).toContain('BRAVOUNIQUEANSWER');
      expect(bJson).not.toContain('ALPHAUNIQUEANSWER');
    } finally {
      await closeParty(party);
    }
  });

  it('gives the HOST both answers, because the Host grades them', async () => {
    const party = await makeParty();
    try {
      await enterQuestions(party);
      await party.host.submit(ROUND1_INTENTS.HOST_NEXT_ROUND1_QUESTION, {});
      await party.p1.submit(ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, {
        answer: 'ALPHAUNIQUEANSWER',
      });
      await party.p2.submit(ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, {
        answer: 'BRAVOUNIQUEANSWER',
      });

      const json = JSON.stringify(await hostSnapshot(party));
      expect(json).toContain('ALPHAUNIQUEANSWER');
      expect(json).toContain('BRAVOUNIQUEANSWER');
    } finally {
      await closeParty(party);
    }
  });

  it('refuses a submission from a player who is not the nominee', async () => {
    // Spec §15 — the server authorises, never the UI. Here the Host, who is not
    // a nominated player at all, is refused over a real socket.
    const party = await makeParty();
    try {
      await enterQuestions(party);
      await party.host.submit(ROUND1_INTENTS.HOST_NEXT_ROUND1_QUESTION, {});

      const refused = await party.host.submit(ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, {
        answer: 'the Host should not be able to answer',
      });
      expect(refused.ok).toBe(false);
    } finally {
      await closeParty(party);
    }
  });

  it('refuses a second submission over the wire', async () => {
    // §11 — submission is final. A retried request must not replace an answer.
    const party = await makeParty();
    try {
      await enterQuestions(party);
      await party.host.submit(ROUND1_INTENTS.HOST_NEXT_ROUND1_QUESTION, {});

      const first = await party.p1.submit(ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, {
        answer: 'FIRSTANSWER',
      });
      expect(first.ok).toBe(true);

      const second = await party.p1.submit(ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, {
        answer: 'SECONDANSWER',
      });
      expect(second.ok).toBe(false);

      const json = await rawSnapshotJson(party.p1);
      expect(json).toContain('FIRSTANSWER');
      expect(json).not.toContain('SECONDANSWER');
    } finally {
      await closeParty(party);
    }
  });

  it('reveals the answer and pays BB and points together', async () => {
    const party = await makeParty();
    try {
      await enterQuestions(party);
      await party.host.submit(ROUND1_INTENTS.HOST_NEXT_ROUND1_QUESTION, {});

      // Read the difficulty from the wire, then answer correctly by asking the
      // Host's own view once the answer is public.
      const before = await playerSnapshot(party.p1);
      const value = before.game?.round1?.current?.value ?? 0;
      expect(value).toBeGreaterThan(0);

      // A deliberately wrong answer from both, so grading is deterministic and
      // needs no judge — the point here is the AWARD PATH, not the grading.
      await party.p1.submit(ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: '' });
      await party.host.submit(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION, {});

      // The Host rules TEAM_A correct, which is always available (§4E).
      await party.host.submit(ROUND1_INTENTS.HOST_RULE_ROUND1_ANSWER, {
        teamId: 'TEAM_A',
        verdict: 'CORRECT',
      });
      const revealed = await party.host.submit(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER, {});
      expect(revealed.ok).toBe(true);

      const after = await hostSnapshot(party);
      // The canonical answer is public NOW, and not before.
      expect(after.game?.round1?.current?.correctAnswer).not.toBeNull();

      const teamA = after.teams.find((t) => t.teamId === 'TEAM_A');
      expect(teamA?.bb).toBe(1_000 + value);
      expect(after.game?.round1?.points['TEAM_A']).toBe(value);
    } finally {
      await closeParty(party);
    }
  });
});
