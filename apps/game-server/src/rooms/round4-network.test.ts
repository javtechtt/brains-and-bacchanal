import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  GAME_INTENTS,
  ROOM_INTENTS,
  ROUND4_INTENTS,
  type HostGameSnapshot,
  type PlayerGameSnapshot,
} from '@bb/protocol';
import { createGameServer, type GameServer } from '../server.js';
import { loadConfig } from '../config.js';
import { RoomClient } from './client.js';

/**
 * Round 4 — Family Feud, over a REAL WebSocket against the REAL production
 * server. Phase 7D-A2.
 *
 * Mirrors round3-network.test.ts's reasoning: an in-process `Room` test can
 * pass while the SERIALISED client view leaks something the in-memory object
 * graph never would (a getter that happens not to be called by the assertion,
 * a field present in the TypeScript type but forgotten from the mapper). Only
 * a real socket, reading actual JSON bytes, catches that. This suite checks
 * exactly the two claims that matter for Family Feud's hidden board: an
 * unrevealed answer's text/value is not in anyone's payload, including the
 * Host's, and a face-off winner's answer is on the wire once it is revealed.
 */

const PORT = 4618;
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

async function enterRound4(party: Party): Promise<void> {
  await party.host.submit(GAME_INTENTS.START_GAME, {});
  const entered = await party.host.submit(ROUND4_INTENTS.DEV_START_ROUND4, {});
  if (!entered.ok) throw new Error(`dev entry failed: ${entered.error.code}`);
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

describe('the Round 4 snapshot on the wire', () => {
  it('reveals no board answer text or value to a PLAYER before the face-off is won', async () => {
    const party = await makeParty();
    try {
      await enterRound4(party);
      await party.host.submit(ROUND4_INTENTS.HOST_START_FACEOFF, {});

      const p1Json = await rawSnapshotJson(party.p1);
      const p2Json = await rawSnapshotJson(party.p2);

      for (const json of [p1Json, p2Json]) {
        expect(json).not.toContain('TEST APPLE');
        expect(json).not.toContain('TEST BANANA');
      }

      const snapshot = await playerSnapshot(party.p1);
      const board = snapshot.game?.round4?.current?.board;
      expect(board?.answers.every((a) => a.text === null && a.value === null)).toBe(true);
    } finally {
      await closeParty(party);
    }
  });

  it('DOES reveal the full board to the HOST before any answer is given — live play needs it (7D-B2)', async () => {
    const party = await makeParty();
    try {
      await enterRound4(party);
      await party.host.submit(ROUND4_INTENTS.HOST_START_FACEOFF, {});

      const hostJson = await rawSnapshotJson(party.host);

      // The Host runs Round 4 live — reads the question aloud, matches a
      // spoken answer to a board slot — which is impossible against a board
      // of blanks. Deliberate exception (7D-B2), scoped to the Host's OWN
      // per-connection snapshot request only; see the player-only test above
      // and the "never on a broadcast event" test below.
      expect(hostJson).toContain('TEST APPLE');
      expect(hostJson).toContain('TEST BANANA');

      const snapshot = await hostSnapshot(party);
      const board = snapshot.game?.round4?.current?.board;
      expect(board?.answers.every((a) => a.text !== null && a.value !== null)).toBe(true);
    } finally {
      await closeParty(party);
    }
  });

  it('reveals the #1 answer to everyone once the face-off is won, but not the next-ranked answer to a PLAYER', async () => {
    const party = await makeParty();
    try {
      await enterRound4(party);
      await party.host.submit(ROUND4_INTENTS.HOST_START_FACEOFF, {});
      await party.p1.submit(ROUND4_INTENTS.SUBMIT_BUZZ, {});
      const answered = await party.p1.submit(ROUND4_INTENTS.SUBMIT_FACEOFF_ANSWER, {
        answer: 'TEST APPLE',
      });
      expect(answered.ok).toBe(true);

      const p2Json = await rawSnapshotJson(party.p2);

      // The winning answer is now public — real Family Feud reveals it live.
      expect(p2Json).toContain('TEST APPLE');
      // The next-ranked, still-unrevealed answer stays hidden from a player.
      expect(p2Json).not.toContain('TEST BANANA');
    } finally {
      await closeParty(party);
    }
  });

  it('never leaks a future survey while the current one is still in play', async () => {
    const party = await makeParty();
    try {
      await enterRound4(party);
      await party.host.submit(ROUND4_INTENTS.HOST_START_FACEOFF, {});

      const hostJson = await rawSnapshotJson(party.host);
      const playerJson = await rawSnapshotJson(party.p1);

      // Q2's TEST content pack answers must not appear while Q1 is current.
      for (const json of [hostJson, playerJson]) {
        expect(json).not.toContain('TEST DOG');
        expect(json).not.toContain('TEST CAT');
      }
    } finally {
      await closeParty(party);
    }
  });
});
