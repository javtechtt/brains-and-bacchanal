import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  GAME_INTENTS,
  ROOM_INTENTS,
  ROUND2_EVENTS,
  ROUND2_INTENTS,
  SHARED_INTENTS,
  type HostGameSnapshot,
  type PlayerGameSnapshot,
} from '@bb/protocol';
import { createGameServer, type GameServer } from '../server.js';
import { loadConfig } from '../config.js';
import { RoomClient } from './client.js';

/**
 * Round 2 END TO END, over a REAL WebSocket against the REAL production server.
 *
 * ================== WHY THIS FILE EXISTS ==================
 * Phase 6 found a real bug this way: in-process tests passed while the
 * SERIALISED client view was wrong. A resolved Clash vanished from the snapshot
 * the instant it resolved, and every existing test missed it because they all
 * asserted a function's return value rather than the JSON a client receives.
 *
 * Phase 7A spec §37 asks for the same discipline here, so these tests assert
 * what actually arrives on the wire: the current challenge, the Host-selectable
 * teams, the result, the BB update, the Double It result and round completion.
 * `Round2StateView` reaching a phone correctly is a claim about BYTES, and only
 * a real socket can check it.
 * ==========================================================
 */

const PORT = 4615;
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

async function enterRound2(party: Party): Promise<void> {
  await party.host.submit(GAME_INTENTS.START_GAME, {});
  const entered = await party.host.submit(ROUND2_INTENTS.DEV_START_ROUND2, {});
  if (!entered.ok) throw new Error(`dev entry failed: ${entered.error.code}`);
}

async function beginChallenge(party: Party): Promise<void> {
  await party.host.submit(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'CHALLENGE_INTRO' });
  await party.host.submit(ROUND2_INTENTS.HOST_PREPARE_ROUND2_CHALLENGE, {});
  await party.host.submit(GAME_INTENTS.HOST_START_CHALLENGE, {});
}

async function playChallenge(party: Party, teamId: string): Promise<void> {
  await beginChallenge(party);
  await party.host.submit(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId });
  const confirmed = await party.host.submit(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT, {});
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

// ---------------------------------------------------------------------------
// The shape a client actually receives
// ---------------------------------------------------------------------------

describe('the Round 2 snapshot on the wire', () => {
  it('reaches the Host with the current challenge and all four in order', async () => {
    const party = await makeParty();
    try {
      await enterRound2(party);
      await beginChallenge(party);

      const snapshot = await hostSnapshot(party);
      const round2 = snapshot.game?.round2;

      expect(round2).toBeDefined();
      expect(round2?.roundIndex).toBe(2);
      expect(round2?.challenges.map((c) => c.challengeType)).toEqual([
        'BOTTLE_BATTLE',
        'MATCH_MAKERS',
        'GRABBERS',
        'BOMBERS',
      ]);
      expect(round2?.current?.challengeType).toBe('BOTTLE_BATTLE');
      expect(round2?.current?.displayName).toBe('Bottle Battle');
      expect(round2?.current?.baseRewardBb).toBe(500);
      expect(round2?.complete).toBe(false);
      // The teams the Host may select between — §19, §27.
      expect(round2?.participatingTeamIds).toEqual(['TEAM_A', 'TEAM_B']);
      expect(round2?.cardChallengeKind).toBe('ROUND2_PHYSICAL');
    } finally {
      await closeParty(party);
    }
  });

  it('reaches a PHONE with the same public Round 2 state', async () => {
    // A phone needs the round to render its own screen (§20), and everything in
    // this view is public. This asserts it actually serialises to the player
    // shape too — the exact class of bug Phase 6 hit.
    const party = await makeParty();
    try {
      await enterRound2(party);
      await beginChallenge(party);

      const snapshot = await playerSnapshot(party.p1);
      const round2 = snapshot.game?.round2;

      expect(snapshot.isHost).toBe(false);
      expect(round2?.current?.challengeType).toBe('BOTTLE_BATTLE');
      expect(round2?.current?.displayName).toBe('Bottle Battle');
      expect(round2?.challenges).toHaveLength(4);
      expect(round2?.resolvedCount).toBe(0);
      expect(round2?.roundIndex).toBe(2);
    } finally {
      await closeParty(party);
    }
  });

  it('carries a pending selection, then the confirmed result, to both', async () => {
    const party = await makeParty();
    try {
      await enterRound2(party);
      await beginChallenge(party);

      await party.host.submit(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: 'TEAM_B' });

      // Selected, not yet paid — on BOTH views.
      const midHost = await hostSnapshot(party);
      const midPlayer = await playerSnapshot(party.p1);
      expect(midHost.game?.round2?.pendingWinnerTeamId).toBe('TEAM_B');
      expect(midPlayer.game?.round2?.pendingWinnerTeamId).toBe('TEAM_B');
      expect(midHost.teams.find((t) => t.teamId === 'TEAM_B')?.bb).toBe(1_000);

      await party.host.submit(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT, {});

      const afterHost = await hostSnapshot(party);
      const afterPlayer = await playerSnapshot(party.p2);
      const resolved = afterHost.game?.round2?.challenges[0];
      expect(resolved?.progress).toBe('resolved');
      expect(resolved?.winningTeamId).toBe('TEAM_B');
      expect(resolved?.awardedBb).toBe(500);
      expect(resolved?.doubled).toBe(false);
      expect(afterHost.game?.round2?.pendingWinnerTeamId).toBeNull();
      // The BB update reached the wire (§37).
      expect(afterHost.teams.find((t) => t.teamId === 'TEAM_B')?.bb).toBe(1_500);
      expect(afterPlayer.teams.find((t) => t.teamId === 'TEAM_B')?.bb).toBe(1_500);
    } finally {
      await closeParty(party);
    }
  });

  it('carries the UPDATED balances in the resolution event itself', async () => {
    // REGRESSION — reported after the first physical test: the awarded BB only
    // appeared once the NEXT challenge started, which left the fourth and final
    // award invisible until Round 3 would have begun.
    //
    // The root cause was client-side (neither the Unity Host nor the phone
    // refreshed on a ROUND2_* event), but the reason the fix works at all is
    // that this event already carries the new balances. Asserting that here
    // pins the contract the clients depend on: a client that reads this payload
    // needs no follow-up snapshot to show the award.
    const party = await makeParty();
    try {
      await enterRound2(party);
      await beginChallenge(party);
      await party.host.submit(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: 'TEAM_A' });

      const resolved = party.p1.waitForEvent(ROUND2_EVENTS.ROUND2_CHALLENGE_RESOLVED);
      await party.host.submit(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT, {});

      const payload = (await resolved).payload as {
        teams: readonly { teamId: string; bb: number }[];
        round2: { resolvedCount: number; challenges: readonly { awardedBb: number | null }[] };
      };

      // The balances in the event are the POST-award ones, not the ones from
      // before the confirmation.
      expect(payload.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_500);
      expect(payload.teams.find((t) => t.teamId === 'TEAM_B')?.bb).toBe(1_000);
      // And the round state travels with it, so a client has everything it
      // needs from this one event.
      expect(payload.round2.resolvedCount).toBe(1);
      expect(payload.round2.challenges[0]?.awardedBb).toBe(500);
    } finally {
      await closeParty(party);
    }
  });

  it('carries the FOURTH award too, with no later event to rely on', async () => {
    // The case that made the bug undeniable. After the last challenge there is
    // no subsequent CHALLENGE_PREPARED to drag a stale view along, so if the
    // resolution did not carry the balances itself, the final award would never
    // appear on screen.
    //
    // Asserted through a PHONE's own snapshot taken immediately after the
    // confirmation and with no further gameplay: that is exactly what a client
    // refreshing on the ROUND2_CHALLENGE_RESOLVED event receives.
    const party = await makeParty();
    try {
      await enterRound2(party);
      await playChallenge(party, 'TEAM_A');
      await playChallenge(party, 'TEAM_A');
      await playChallenge(party, 'TEAM_A');
      await playChallenge(party, 'TEAM_B');

      const phone = await playerSnapshot(party.p2);
      const round2 = phone.game?.round2;

      expect(round2?.complete).toBe(true);
      expect(round2?.challenges[3]?.displayName).toBe('Bombers');
      expect(round2?.challenges[3]?.awardedBb).toBe(500);
      // The fourth award is present without any further gameplay: 1,000 + 500
      // for B, and A's three wins.
      expect(phone.teams.find((t) => t.teamId === 'TEAM_B')?.bb).toBe(1_500);
      expect(phone.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(2_500);

      // And the Host sees the same, likewise with nothing happening after.
      const host = await hostSnapshot(party);
      expect(host.teams.find((t) => t.teamId === 'TEAM_B')?.bb).toBe(1_500);
      expect(host.game?.round2?.complete).toBe(true);
    } finally {
      await closeParty(party);
    }
  }, 20_000);

  it('broadcasts the resolution event to every client in the room', async () => {
    const party = await makeParty();
    try {
      await enterRound2(party);
      await beginChallenge(party);
      await party.host.submit(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: 'TEAM_A' });

      const onPhone = party.p1.waitForEvent(ROUND2_EVENTS.ROUND2_CHALLENGE_RESOLVED);
      const onHost = party.host.waitForEvent(ROUND2_EVENTS.ROUND2_CHALLENGE_RESOLVED);
      await party.host.submit(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT, {});

      const [phoneEvent, hostEvent] = await Promise.all([onPhone, onHost]);
      for (const event of [phoneEvent, hostEvent]) {
        const payload = event.payload as {
          winningTeamId: string;
          awardedBb: number;
          doubled: boolean;
          roundComplete: boolean;
          displayName: string;
        };
        expect(payload.winningTeamId).toBe('TEAM_A');
        expect(payload.awardedBb).toBe(500);
        expect(payload.doubled).toBe(false);
        expect(payload.roundComplete).toBe(false);
        expect(payload.displayName).toBe('Bottle Battle');
      }
    } finally {
      await closeParty(party);
    }
  });
});

// ---------------------------------------------------------------------------
// Authority, over a real socket
// ---------------------------------------------------------------------------

describe('Round 2 authority over a real socket', () => {
  it('refuses a PHONE that tries to select the winner', async () => {
    // The intent travels over an open socket, so hiding a button proves
    // nothing. Phase 7A §13, §30.
    const party = await makeParty();
    try {
      await enterRound2(party);
      await beginChallenge(party);

      const ack = await party.p1.submit(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, {
        teamId: 'TEAM_A',
      });
      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.code).toBe('UNAUTHORIZED_ACTOR');

      const snapshot = await hostSnapshot(party);
      expect(snapshot.game?.round2?.pendingWinnerTeamId).toBeNull();
    } finally {
      await closeParty(party);
    }
  });

  it('refuses a PHONE that tries to confirm a result', async () => {
    const party = await makeParty();
    try {
      await enterRound2(party);
      await beginChallenge(party);
      await party.host.submit(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: 'TEAM_A' });

      const ack = await party.p1.submit(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT, {});
      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.code).toBe('UNAUTHORIZED_ACTOR');

      const snapshot = await hostSnapshot(party);
      expect(snapshot.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_000);
    } finally {
      await closeParty(party);
    }
  });

  it('ignores a BB amount sent in the confirmation payload', async () => {
    // CLAUDE.md — no client decides how much BB to add. There is no field for
    // it, and this proves sending one over a real socket changes nothing.
    const party = await makeParty();
    try {
      await enterRound2(party);
      await beginChallenge(party);
      await party.host.submit(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: 'TEAM_A' });
      await party.host.submit(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT, {
        awardedBb: 99_999,
        baseRewardBb: 99_999,
        bbDeltas: { TEAM_A: 99_999 },
        doubled: true,
      });

      const snapshot = await hostSnapshot(party);
      expect(snapshot.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_500);
      expect(snapshot.game?.round2?.challenges[0]?.doubled).toBe(false);
    } finally {
      await closeParty(party);
    }
  });

  it('does not award twice when the same confirmation is retried', async () => {
    const party = await makeParty();
    try {
      await enterRound2(party);
      await beginChallenge(party);
      await party.host.submit(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: 'TEAM_A' });
      await party.host.submit(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT, {});

      // A second, DISTINCT intent — a stale Host socket, not a retry.
      const again = await party.host.submit(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT, {
        teamId: 'TEAM_A',
      });
      expect(again.ok).toBe(false);

      const snapshot = await hostSnapshot(party);
      expect(snapshot.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_500);
      expect(snapshot.game?.round2?.resolvedCount).toBe(1);
    } finally {
      await closeParty(party);
    }
  });
});

// ---------------------------------------------------------------------------
// Double It, on the wire
// ---------------------------------------------------------------------------

describe('Double It over a real socket', () => {
  it('pays 1,000 and reports the doubling in the snapshot and the event', async () => {
    const party = await makeParty();
    try {
      await enterRound2(party);
      await beginChallenge(party);

      // Redeal until Team A holds a DOUBLE_IT. The development redeal exists
      // for exactly this; a random deal will not reliably produce it.
      let doubleCardId: string | null = null;
      await party.host.submit(SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS, {});
      for (let attempt = 0; attempt < 200 && doubleCardId === null; attempt += 1) {
        const snapshot = await playerSnapshot(party.p1);
        const card = snapshot.shared?.yourHand.find((c) => c.cardType === 'DOUBLE_IT');
        if (card !== undefined) {
          doubleCardId = card.cardInstanceId;
          break;
        }
        await party.host.submit(SHARED_INTENTS.DEV_REDEAL_BACCHANAL_CARDS, {});
      }
      expect(doubleCardId).not.toBeNull();

      await party.host.submit(SHARED_INTENTS.HOST_OPEN_CARD_WINDOW, {
        challengeKind: 'ROUND2_PHYSICAL',
      });
      const played = await party.p1.submit(SHARED_INTENTS.PLAY_BACCHANAL_CARD, {
        cardInstanceId: doubleCardId,
      });
      expect(played.ok).toBe(true);

      // The real 6-second hidden window (D-029), resolved by the server's own
      // tick with nobody countering — Round 2 permits no counter card.
      await party.host.waitForEvent('CLASH_RESOLVED', 12_000);

      await party.host.submit(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: 'TEAM_A' });
      const resolvedEvent = party.p1.waitForEvent(ROUND2_EVENTS.ROUND2_CHALLENGE_RESOLVED);
      await party.host.submit(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT, {});

      const payload = (await resolvedEvent).payload as {
        awardedBb: number;
        doubled: boolean;
        baseRewardBb: number;
      };
      expect(payload.baseRewardBb).toBe(500);
      expect(payload.awardedBb).toBe(1_000);
      expect(payload.doubled).toBe(true);

      const snapshot = await hostSnapshot(party);
      expect(snapshot.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(2_000);
      expect(snapshot.game?.round2?.challenges[0]?.doubled).toBe(true);
      expect(snapshot.game?.round2?.challenges[0]?.awardedBb).toBe(1_000);
    } finally {
      await closeParty(party);
    }
  }, 30_000);

  it('refuses an illegal card in a Round 2 window, over the wire', async () => {
    const party = await makeParty();
    try {
      await enterRound2(party);
      await beginChallenge(party);
      await party.host.submit(SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS, {});
      await party.host.submit(SHARED_INTENTS.HOST_OPEN_CARD_WINDOW, {
        challengeKind: 'ROUND2_PHYSICAL',
      });

      const snapshot = await playerSnapshot(party.p1);
      const illegal = snapshot.shared?.yourHand.find((c) => c.cardType !== 'DOUBLE_IT');
      expect(illegal).toBeDefined();
      // The server told the phone it is unplayable...
      expect(illegal?.playable).toBe(false);

      // ...and refuses it anyway when the phone asks.
      const ack = await party.p1.submit(SHARED_INTENTS.PLAY_BACCHANAL_CARD, {
        cardInstanceId: illegal?.cardInstanceId,
        targetTeamId: 'TEAM_B',
      });
      expect(ack.ok).toBe(false);
    } finally {
      await closeParty(party);
    }
  });
});

// ---------------------------------------------------------------------------
// The whole round, and completion
// ---------------------------------------------------------------------------

describe('a whole Round 2 over a real socket', () => {
  it('runs Market, four challenges and reaches ROUND 2 COMPLETE', async () => {
    const party = await makeParty();
    try {
      await enterRound2(party);

      // The locked sequence: intro -> Market -> close -> challenges (§5).
      await party.host.submit(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'MARKET' });
      await party.host.submit(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 2 });
      const bought = await party.p1.submit(SHARED_INTENTS.PURCHASE_MARKET_ITEM, { item: 'CLUE' });
      expect(bought.ok).toBe(true);
      await party.host.submit(SHARED_INTENTS.HOST_CLOSE_MARKET, {});

      await playChallenge(party, 'TEAM_A');
      await playChallenge(party, 'TEAM_B');
      await playChallenge(party, 'TEAM_A');

      const completed = party.host.waitForEvent(ROUND2_EVENTS.ROUND2_CHALLENGE_RESOLVED);
      await playChallenge(party, 'TEAM_B');
      const payload = (await completed).payload as { roundComplete: boolean };

      const snapshot = await hostSnapshot(party);
      const round2 = snapshot.game?.round2;
      expect(round2?.complete).toBe(true);
      expect(round2?.resolvedCount).toBe(4);
      expect(round2?.current).toBeNull();
      expect(round2?.challenges.map((c) => c.winningTeamId)).toEqual([
        'TEAM_A',
        'TEAM_B',
        'TEAM_A',
        'TEAM_B',
      ]);
      // 1,000 - 200 (Clue) + 1,000 (two wins)
      expect(snapshot.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_800);
      expect(snapshot.teams.find((t) => t.teamId === 'TEAM_B')?.bb).toBe(2_000);
      expect(payload.roundComplete).toBeDefined();
    } finally {
      await closeParty(party);
    }
  }, 30_000);

  it('restores a reconnecting phone mid-round without duplicating an award', async () => {
    // Phase 7A §22, §34 — the reconnect case that matters most at a party.
    const party = await makeParty();
    try {
      await enterRound2(party);
      await playChallenge(party, 'TEAM_A');
      await beginChallenge(party);
      await party.host.submit(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: 'TEAM_B' });

      // The phone drops and comes back on a NEW socket, as a real phone does.
      await party.p1.disconnect();
      const back = await connectClient();
      back.roomId = party.roomId;
      const ack = await back.submit(ROOM_INTENTS.RECONNECT_PLAYER, {
        playerId: party.p1.playerId,
        reconnectToken: party.p1.reconnectToken,
      });
      expect(ack.ok).toBe(true);

      const snapshot = await playerSnapshot(back);
      const round2 = snapshot.game?.round2;
      expect(round2?.resolvedCount).toBe(1);
      expect(round2?.challenges[0]?.winningTeamId).toBe('TEAM_A');
      expect(round2?.challenges[0]?.awardedBb).toBe(500);
      expect(round2?.current?.challengeType).toBe('MATCH_MAKERS');
      expect(round2?.pendingWinnerTeamId).toBe('TEAM_B');
      // Nothing was paid twice by the reconnect.
      expect(snapshot.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_500);

      await back.disconnect();
    } finally {
      await closeParty(party);
    }
  });

  it('restores the Unity Host to the same round after a reconnect', async () => {
    // Phase 7A §24 — and it must NOT reselect a winner.
    const party = await makeParty();
    try {
      await enterRound2(party);
      await playChallenge(party, 'TEAM_A');
      await beginChallenge(party);

      await party.host.disconnect();
      const back = await connectClient();
      back.roomId = party.roomId;
      const ack = await back.submit(ROOM_INTENTS.RECONNECT_HOST, { hostToken: party.hostToken });
      expect(ack.ok).toBe(true);

      const snapshotAck = await back.submit(GAME_INTENTS.REQUEST_GAME_SNAPSHOT, {});
      expect(snapshotAck.ok).toBe(true);
      const snapshot = snapshotAck.ok ? (snapshotAck.snapshot as HostGameSnapshot) : null;
      expect(snapshot?.isHost).toBe(true);
      expect(snapshot?.game?.round2?.resolvedCount).toBe(1);
      expect(snapshot?.game?.round2?.current?.challengeType).toBe('MATCH_MAKERS');
      expect(snapshot?.game?.round2?.pendingWinnerTeamId).toBeNull();
      expect(snapshot?.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_500);

      await back.disconnect();
    } finally {
      await Promise.all([party.p1.disconnect(), party.p2.disconnect()]);
    }
  });
});

// ---------------------------------------------------------------------------
// The development entry
// ---------------------------------------------------------------------------

describe('the development Round 2 entry', () => {
  it('is refused by a server started WITHOUT development tools', async () => {
    // Phase 7A §28 — "never appear in production mode". The gate is the
    // server's, so a client built with the button still cannot use it.
    const prodPort = PORT + 1;
    const prodServer = createGameServer(
      {
        ...loadConfig({}),
        port: prodPort,
        host: '127.0.0.1',
        publicBaseUrl: 'http://127.0.0.1:3000',
        devTools: false,
      },
      logger,
    );
    await prodServer.listen();

    const host = new RoomClient({ url: `ws://127.0.0.1:${prodPort}/room/ws` });
    await host.connect();
    try {
      const created = await host.submit(ROOM_INTENTS.CREATE_ROOM, {});
      const payload = created.ok
        ? (created.snapshot as { roomId: string; roomCode: string })
        : null;
      host.roomId = payload?.roomId ?? '';

      const phone = new RoomClient({ url: `ws://127.0.0.1:${prodPort}/room/ws` });
      await phone.connect();
      phone.roomId = host.roomId;
      const join = await phone.submit(ROOM_INTENTS.JOIN_ROOM, {
        roomCode: payload?.roomCode,
        displayName: 'Javal',
      });
      const joined = join.ok ? (join.snapshot as { playerId: string }) : null;
      await host.submit(ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM, {
        playerId: joined?.playerId,
        teamId: 'TEAM_A',
      });
      const phone2 = new RoomClient({ url: `ws://127.0.0.1:${prodPort}/room/ws` });
      await phone2.connect();
      phone2.roomId = host.roomId;
      const join2 = await phone2.submit(ROOM_INTENTS.JOIN_ROOM, {
        roomCode: payload?.roomCode,
        displayName: 'Ama',
      });
      const joined2 = join2.ok ? (join2.snapshot as { playerId: string }) : null;
      await host.submit(ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM, {
        playerId: joined2?.playerId,
        teamId: 'TEAM_B',
      });
      await host.submit(ROOM_INTENTS.HOST_LOCK_TEAMS, {});
      await host.submit(GAME_INTENTS.START_GAME, {});

      const ack = await host.submit(ROUND2_INTENTS.DEV_START_ROUND2, {});
      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.code).toBe('ILLEGAL_ACTION');

      await Promise.all([phone.disconnect(), phone2.disconnect()]);
    } finally {
      await host.disconnect();
      await prodServer.close();
    }
  });
});
