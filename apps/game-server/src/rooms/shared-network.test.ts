import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  GAME_INTENTS,
  ROOM_INTENTS,
  SHARED_EVENTS,
  SHARED_INTENTS,
  type HostGameSnapshot,
  type PlayerGameSnapshot,
} from '@bb/protocol';
import { createGameServer, type GameServer } from '../server.js';
import { loadConfig } from '../config.js';
import { RoomClient } from './client.js';

/**
 * The Phase 6 shared systems END TO END, over a REAL WebSocket against the REAL
 * production server.
 *
 * The rules are already covered deterministically in @bb/game-rules. THIS file
 * exists for the one thing a unit test cannot prove:
 *
 *   WHAT ACTUALLY ARRIVES ON A PHONE.
 *
 * Phase 6 spec §42 is a claim about bytes on a wire, not about a function's
 * return value. A view can be perfectly shaped and still leak if the wrong
 * object is serialised into a snapshot or an event payload. So these tests read
 * the JSON a real client receives and assert that an opponent's cards, a hidden
 * purchase and an unrevealed Clash response are not in it.
 *
 * Real sockets and a real clock — the Clash window is genuinely 3 seconds here,
 * so the tests that wait for it say so.
 */

const PORT = 4613;
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

/** A room with two players on two teams, teams locked, game started. */
async function makeGame(): Promise<Party> {
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
  await host.submit(GAME_INTENTS.START_GAME, {});

  return { host, p1, p2, roomId: payload.roomId };
}

async function closeParty(party: Party): Promise<void> {
  await Promise.all([party.host.disconnect(), party.p1.disconnect(), party.p2.disconnect()]);
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

/** Deal cards and open a window of the given kind on a live challenge. */
async function openCardWindow(party: Party, challengeKind: string): Promise<void> {
  await party.host.submit(SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS, {});
  await party.host.submit(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'CHALLENGE_INTRO' });
  await party.host.submit(GAME_INTENTS.HOST_PREPARE_CHALLENGE, { challengeType: 'TEST_CHALLENGE' });
  await party.host.submit(GAME_INTENTS.HOST_START_CHALLENGE, {});
  await party.host.submit(SHARED_INTENTS.HOST_OPEN_CARD_WINDOW, { challengeKind });
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

describe('dealing Bacchanal cards over a real socket', () => {
  it('gives each team three cards, one per category', async () => {
    const party = await makeGame();
    try {
      const ack = await party.host.submit(SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS, {});
      expect(ack.ok).toBe(true);

      const snapshot = await playerSnapshot(party.p1);
      expect(snapshot.shared).not.toBeNull();
      expect(snapshot.shared?.yourHand).toHaveLength(3);

      const categories = snapshot.shared?.yourHand.map((c) => c.category).sort();
      expect(categories).toEqual(['DISRUPTION', 'POWER', 'RECOVERY']);
    } finally {
      await closeParty(party);
    }
  });

  it('NEVER sends an opponent hand to a player', async () => {
    // Phase 6 spec §42, asserted against the actual JSON a phone receives.
    const party = await makeGame();
    try {
      await party.host.submit(SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS, {});

      const host = await hostSnapshot(party);
      const p1 = await playerSnapshot(party.p1);

      // The Host sees both hands — it adjudicates.
      const teamBHand = host.shared?.hands['TEAM_B'] ?? [];
      expect(teamBHand).toHaveLength(3);

      // The player sees a COUNT and nothing else. Every one of the opponent's
      // card instance ids must be absent from the entire serialised snapshot.
      const wire = JSON.stringify(p1);
      for (const card of teamBHand) {
        expect(wire).not.toContain(card.cardInstanceId);
      }
      expect(p1.shared?.opponentHands).toHaveLength(1);
      expect(p1.shared?.opponentHands[0]?.cardCount).toBe(3);
    } finally {
      await closeParty(party);
    }
  });

  it('restores the same hand after a reconnect', async () => {
    // Phase 6 spec §43 — reconnect must not redraw.
    const party = await makeGame();
    try {
      await party.host.submit(SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS, {});
      const before = await playerSnapshot(party.p1);
      const beforeIds = before.shared?.yourHand.map((c) => c.cardInstanceId).sort();

      await party.p1.disconnect();

      const returning = await connectClient();
      returning.roomId = party.roomId;
      const ack = await returning.submit(ROOM_INTENTS.RECONNECT_PLAYER, {
        playerId: party.p1.playerId,
        reconnectToken: party.p1.reconnectToken,
      });
      expect(ack.ok).toBe(true);

      const after = await playerSnapshot(returning);
      expect(after.shared?.yourHand.map((c) => c.cardInstanceId).sort()).toEqual(beforeIds);

      await returning.disconnect();
    } finally {
      await party.host.disconnect();
      await party.p2.disconnect();
    }
  });

  it('marks Maco! unplayable while OPEN_RULES.md §7 is open', async () => {
    // The open-rule guard, over the wire. Whichever team is dealt MACO must see
    // it as held-but-unplayable, never as a legal option.
    const party = await makeGame();
    try {
      await openCardWindow(party, 'ROUND1_TRIVIA');

      for (const client of [party.p1, party.p2]) {
        const snapshot = await playerSnapshot(client);
        const maco = snapshot.shared?.yourHand.find((c) => c.cardType === 'MACO');
        if (maco === undefined) continue;

        expect(maco.playable).toBe(false);
        expect(maco.unplayableReason).toBe('compatibility_unresolved');

        // And the server refuses it even if a client ignored that.
        const played = await client.submit(SHARED_INTENTS.PLAY_BACCHANAL_CARD, {
          cardInstanceId: maco.cardInstanceId,
        });
        expect(played.ok).toBe(false);
      }
    } finally {
      await closeParty(party);
    }
  });
});

describe('DEV_REDEAL_BACCHANAL_CARDS over a real socket', () => {
  it('discards the old hand and deals a new one, without disturbing the one-deal rule', async () => {
    // A dev-only escape hatch for exercising the Clash: since each team gets
    // one random card per category (§2), a real deal can legitimately leave
    // neither team holding anything playable for a given challenge kind — this
    // lets a test keep re-rolling instead of recreating the whole room.
    const party = await makeGame();
    try {
      await party.host.submit(SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS, {});
      const before = await playerSnapshot(party.p1);
      const beforeIds = before.shared?.yourHand.map((c) => c.cardInstanceId).sort();

      const redealt = await party.host.submit(SHARED_INTENTS.DEV_REDEAL_BACCHANAL_CARDS, {});
      expect(redealt.ok).toBe(true);

      const after = await playerSnapshot(party.p1);
      const afterIds = after.shared?.yourHand.map((c) => c.cardInstanceId).sort();
      expect(afterIds).toHaveLength(3);
      expect(afterIds).not.toEqual(beforeIds);

      // Still one card per category — the redeal uses the same locked rule.
      const categories = after.shared?.yourHand.map((c) => c.category).sort();
      expect(categories).toEqual(['DISRUPTION', 'POWER', 'RECOVERY']);

      // The ordinary, real deal still refuses a second call — the dev path is
      // a distinct escape hatch, not a weakening of the one-deal rule.
      const ordinaryRedeal = await party.host.submit(
        SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS,
        {},
      );
      expect(ordinaryRedeal.ok).toBe(false);

      // But the dev path itself may be used again.
      const redealtAgain = await party.host.submit(SHARED_INTENTS.DEV_REDEAL_BACCHANAL_CARDS, {});
      expect(redealtAgain.ok).toBe(true);
    } finally {
      await closeParty(party);
    }
  });

  it('is Host-only', async () => {
    const party = await makeGame();
    try {
      await party.host.submit(SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS, {});

      const byPlayer = await party.p1.submit(SHARED_INTENTS.DEV_REDEAL_BACCHANAL_CARDS, {});
      expect(byPlayer.ok).toBe(false);
    } finally {
      await closeParty(party);
    }
  });
});

describe('card play authority over a real socket', () => {
  it('refuses a card played by the wrong team', async () => {
    // A phone cannot play another team's card by naming it: the acting team is
    // resolved from the CONNECTION, never from the payload.
    const party = await makeGame();
    try {
      await openCardWindow(party, 'ROUND1_TRIVIA');

      const p1 = await playerSnapshot(party.p1);
      const card = p1.shared?.yourHand[0];
      expect(card).toBeDefined();

      // p2 tries to play p1's card.
      const played = await party.p2.submit(SHARED_INTENTS.PLAY_BACCHANAL_CARD, {
        cardInstanceId: card!.cardInstanceId,
      });

      expect(played.ok).toBe(false);
      if (!played.ok) expect(played.error.code).toBe('UNAUTHORIZED_ACTOR');
    } finally {
      await closeParty(party);
    }
  });

  it('refuses a card from the Host, who has no team', async () => {
    const party = await makeGame();
    try {
      await openCardWindow(party, 'ROUND1_TRIVIA');
      const p1 = await playerSnapshot(party.p1);
      const card = p1.shared?.yourHand[0];

      const played = await party.host.submit(SHARED_INTENTS.PLAY_BACCHANAL_CARD, {
        cardInstanceId: card!.cardInstanceId,
      });

      expect(played.ok).toBe(false);
    } finally {
      await closeParty(party);
    }
  });

  it('enforces one card per team per challenge across the wire', async () => {
    // GAME_RULES_LOCKED.md §2, including a network retry.
    const party = await makeGame();
    try {
      await openCardWindow(party, 'ROUND1_TRIVIA');

      const snapshot = await playerSnapshot(party.p1);
      const playable = snapshot.shared?.yourHand.filter((c) => c.playable) ?? [];
      if (playable.length < 2) return; // this deal cannot exercise the rule

      const first = await party.p1.submit(SHARED_INTENTS.PLAY_BACCHANAL_CARD, {
        cardInstanceId: playable[0]!.cardInstanceId,
        targetTeamId: 'TEAM_B',
      });
      expect(first.ok).toBe(true);

      const second = await party.p1.submit(SHARED_INTENTS.PLAY_BACCHANAL_CARD, {
        cardInstanceId: playable[1]!.cardInstanceId,
        targetTeamId: 'TEAM_B',
      });
      expect(second.ok).toBe(false);
    } finally {
      await closeParty(party);
    }
  });
});

describe('the Clash over a real socket', () => {
  it('broadcasts THAT a team responded, never WITH WHAT', async () => {
    // Phase 6 spec §42 — the hidden response, asserted against the real event
    // payload every client in the room receives.
    const party = await makeGame();
    try {
      // THINK_FAST allows STEUPS, DOUBLE_IT and FORGIVE_MEH, so both teams are
      // likely to hold a legal card.
      await openCardWindow(party, 'THINK_FAST');

      const p1 = await playerSnapshot(party.p1);
      const p2 = await playerSnapshot(party.p2);
      const attack = p1.shared?.yourHand.find((c) => c.playable);
      const counter = p2.shared?.yourHand.find((c) => c.playable);
      if (attack === undefined || counter === undefined) return;

      party.p1.clearEvents();

      await party.p1.submit(SHARED_INTENTS.PLAY_BACCHANAL_CARD, {
        cardInstanceId: attack.cardInstanceId,
        targetTeamId: 'TEAM_B',
      });
      const responded = await party.p2.submit(SHARED_INTENTS.RESPOND_TO_CLASH, {
        cardInstanceId: counter.cardInstanceId,
        targetTeamId: 'TEAM_A',
      });
      expect(responded.ok).toBe(true);

      // The broadcast p1 actually received.
      await party.p1.waitForEvent(SHARED_EVENTS.CLASH_RESPONSE_RECEIVED);

      // It names the responder but not the card.
      const received = party.p1.receivedEvents();
      const wire = JSON.stringify(received);
      expect(wire).not.toContain(counter.cardInstanceId);

      // The event that did arrive names TEAM_B as having responded.
      const responseEvent = received.find(
        (e) => e.type === SHARED_EVENTS.CLASH_RESPONSE_RECEIVED,
      );
      const payload = responseEvent?.payload as { respondedTeamIds?: string[] } | undefined;
      expect(payload?.respondedTeamIds).toEqual(['TEAM_B']);

      // The snapshot is NOT asserted for a live Clash here: this runs on a real
      // clock, and the locked 3-second window may legitimately have closed
      // between the response and the snapshot. What must hold either way is
      // that p1 never saw the card — which the event assertion above covers, and
      // this repeats against whatever the snapshot now contains.
      const p1After = await playerSnapshot(party.p1);
      if (p1After.shared?.clash !== null && p1After.shared?.clash?.resolved === false) {
        expect(JSON.stringify(p1After.shared.clash)).not.toContain(counter.cardInstanceId);
        expect(p1After.shared.clash.respondedTeamIds).toEqual(['TEAM_B']);
      }
    } finally {
      await closeParty(party);
    }
  });

  it('resolves after the real 3-second window and reveals everything', async () => {
    // A real clock: the window genuinely elapses, and the server's tick — not
    // an intent — is what closes it.
    const party = await makeGame();
    try {
      await openCardWindow(party, 'THINK_FAST');

      const p1 = await playerSnapshot(party.p1);
      const attack = p1.shared?.yourHand.find((c) => c.playable);
      if (attack === undefined) return;

      await party.p1.submit(SHARED_INTENTS.PLAY_BACCHANAL_CARD, {
        cardInstanceId: attack.cardInstanceId,
        targetTeamId: 'TEAM_B',
      });

      // Wait out the locked 3-second window, plus the tick interval.
      await new Promise((resolve) => setTimeout(resolve, 3_600));

      const after = await playerSnapshot(party.p1);
      // The Clash is gone or resolved; either way the card is no longer pending.
      const card = after.shared?.yourHand.find(
        (c) => c.cardInstanceId === attack.cardInstanceId,
      );
      expect(card === undefined || card.status !== 'PENDING').toBe(true);
    } finally {
      await closeParty(party);
    }
  }, 15_000);
});

describe('the Market over a real socket', () => {
  it('refuses to open before Round 1', async () => {
    const party = await makeGame();
    try {
      const opened = await party.host.submit(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 1 });
      expect(opened.ok).toBe(false);
    } finally {
      await closeParty(party);
    }
  });

  it('deducts BB and hides the purchase until the Market closes', async () => {
    // GAME_RULES_LOCKED.md §10, over the wire. The Phase 6 exit scenario:
    // Team A buys Extra Time for 200 and lands at 800.
    const party = await makeGame();
    try {
      await party.host.submit(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 2 });

      const bought = await party.p1.submit(SHARED_INTENTS.PURCHASE_MARKET_ITEM, {
        item: 'EXTRA_TIME',
      });
      expect(bought.ok).toBe(true);

      const p1 = await playerSnapshot(party.p1);
      expect(p1.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(800);
      expect(p1.shared?.market.yourPurchases).toHaveLength(1);

      // TEAM_B cannot see it while shopping is hidden.
      const p2 = await playerSnapshot(party.p2);
      expect(p2.shared?.market.otherTeamPurchases).toHaveLength(0);
      // Not even which item, anywhere in the payload.
      const purchaseId = p1.shared?.market.yourPurchases[0]?.purchaseId ?? 'none';
      expect(JSON.stringify(p2.shared)).not.toContain(purchaseId);

      // Close, and it reveals.
      await party.host.submit(SHARED_INTENTS.HOST_CLOSE_MARKET, {});
      const p2After = await playerSnapshot(party.p2);
      expect(p2After.shared?.market.otherTeamPurchases).toHaveLength(1);
      expect(p2After.shared?.market.otherTeamPurchases[0]?.item).toBe('EXTRA_TIME');
    } finally {
      await closeParty(party);
    }
  });

  it("freezes an opponent's visible BB while shopping stays hidden, unfreezing at close", async () => {
    // A live BB drop would leak "they bought something" even though WHAT they
    // bought stays hidden (§10) — the same information the item-hiding rule
    // already protects, leaking through a different channel. Team A's OWN
    // balance stays real-time throughout; only what TEAM B sees of Team A
    // freezes.
    const party = await makeGame();
    try {
      await party.host.submit(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 2 });

      // Before any purchase, both teams agree on the balance.
      const beforeA = await playerSnapshot(party.p1);
      const beforeB = await playerSnapshot(party.p2);
      expect(beforeA.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_000);
      expect(beforeB.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_000);

      await party.p1.submit(SHARED_INTENTS.PURCHASE_MARKET_ITEM, { item: 'EXTRA_TIME' });

      // Team A sees its OWN new balance immediately.
      const afterA = await playerSnapshot(party.p1);
      expect(afterA.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(800);

      // Team B still sees Team A frozen at the PRE-purchase figure.
      const afterB = await playerSnapshot(party.p2);
      expect(afterB.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_000);

      // The Host is unaffected — it adjudicates and already sees purchases.
      const hostView = await hostSnapshot(party);
      expect(hostView.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(800);

      // Closing the Market snaps everyone to the real figure, together with
      // the purchase reveal.
      await party.host.submit(SHARED_INTENTS.HOST_CLOSE_MARKET, {});
      const closedB = await playerSnapshot(party.p2);
      expect(closedB.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(800);
    } finally {
      await closeParty(party);
    }
  });

  it('refuses a duplicate purchase intent without charging twice', async () => {
    // Phase 6 spec §20 — a retried intent must not spend BB twice. The Phase 2
    // idempotency registry does this; here it is proven over a real socket.
    const party = await makeGame();
    try {
      await party.host.submit(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 2 });

      const intentId = 'fixed-intent-for-retry';
      const first = await party.p1.submit(
        SHARED_INTENTS.PURCHASE_MARKET_ITEM,
        { item: 'CLUE' },
        intentId,
      );
      expect(first.ok).toBe(true);

      const retry = await party.p1.submit(
        SHARED_INTENTS.PURCHASE_MARKET_ITEM,
        { item: 'CLUE' },
        intentId,
      );
      expect(retry.ok).toBe(false);
      if (!retry.ok) expect(retry.error.code).toBe('DUPLICATE_INTENT');

      // Charged exactly once: 1,000 - 200.
      const snapshot = await playerSnapshot(party.p1);
      expect(snapshot.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(800);
    } finally {
      await closeParty(party);
    }
  });

  it('refuses a purchase the team cannot afford', async () => {
    const party = await makeGame();
    try {
      // Drop TEAM_A to 100 BB using the dev control.
      await party.host.submit(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: -900 });
      await party.host.submit(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 2 });

      const bought = await party.p1.submit(SHARED_INTENTS.PURCHASE_MARKET_ITEM, {
        item: 'MACO_MAIL',
      });
      expect(bought.ok).toBe(false);

      // The floor did NOT quietly sell it to them.
      const snapshot = await playerSnapshot(party.p1);
      expect(snapshot.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(100);
    } finally {
      await closeParty(party);
    }
  });

  it('keeps purchases and advantages across a reconnect', async () => {
    // Phase 6 spec §43 — reconnect must not rebuy.
    const party = await makeGame();
    try {
      await party.host.submit(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 2 });
      await party.p1.submit(SHARED_INTENTS.PURCHASE_MARKET_ITEM, { item: 'EXTRA_TIME' });

      await party.p1.disconnect();

      const returning = await connectClient();
      returning.roomId = party.roomId;
      await returning.submit(ROOM_INTENTS.RECONNECT_PLAYER, {
        playerId: party.p1.playerId,
        reconnectToken: party.p1.reconnectToken,
      });

      const after = await playerSnapshot(returning);
      expect(after.shared?.market.yourPurchases).toHaveLength(1);
      expect(after.shared?.yourAdvantages).toHaveLength(1);
      // Charged once, not twice.
      expect(after.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(800);

      await returning.disconnect();
    } finally {
      await party.host.disconnect();
      await party.p2.disconnect();
    }
  });
});

describe('Host Deals over a real socket', () => {
  it('is Host-only, and pays from the server-side template', async () => {
    const party = await makeGame();
    try {
      // A player cannot offer themselves a deal.
      const byPlayer = await party.p1.submit(SHARED_INTENTS.HOST_OFFER_DEAL, {
        template: 'KEEP_OR_RISK',
        teamId: 'TEAM_A',
      });
      expect(byPlayer.ok).toBe(false);

      const offered = await party.host.submit(SHARED_INTENTS.HOST_OFFER_DEAL, {
        template: 'KEEP_OR_RISK',
        teamId: 'TEAM_A',
      });
      expect(offered.ok).toBe(true);

      const p1 = await playerSnapshot(party.p1);
      const deal = p1.shared?.yourDeal;
      expect(deal).not.toBeNull();
      expect(deal?.terms.declineBb).toBe(500);

      const answered = await party.p1.submit(SHARED_INTENTS.RESPOND_TO_HOST_DEAL, {
        dealId: deal!.dealId,
        choice: 'decline',
      });
      expect(answered.ok).toBe(true);

      const after = await playerSnapshot(party.p1);
      expect(after.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_500);
    } finally {
      await closeParty(party);
    }
  });

  it('allows only one deal per round', async () => {
    // D-009, over the wire.
    const party = await makeGame();
    try {
      const first = await party.host.submit(SHARED_INTENTS.HOST_OFFER_DEAL, {
        template: 'KEEP_OR_RISK',
        teamId: 'TEAM_A',
      });
      expect(first.ok).toBe(true);

      const second = await party.host.submit(SHARED_INTENTS.HOST_OFFER_DEAL, {
        template: 'MYSTERY_DEAL',
        teamId: 'TEAM_B',
      });
      expect(second.ok).toBe(false);
    } finally {
      await closeParty(party);
    }
  });

  it('ignores any amount a Host client tries to send', async () => {
    // GAME_RULES_LOCKED.md §9 — "Deal mathematics come from predefined
    // templates and are not improvised." A rogue amount in the payload must
    // change nothing, because no handler reads one.
    const party = await makeGame();
    try {
      const offered = await party.host.submit(SHARED_INTENTS.HOST_OFFER_DEAL, {
        template: 'KEEP_OR_RISK',
        teamId: 'TEAM_A',
        declineBb: 99_999,
        acceptCostBb: -5_000,
      });
      expect(offered.ok).toBe(true);

      const p1 = await playerSnapshot(party.p1);
      // The server's own terms, not the client's.
      expect(p1.shared?.yourDeal?.terms.declineBb).toBe(500);

      await party.p1.submit(SHARED_INTENTS.RESPOND_TO_HOST_DEAL, {
        dealId: p1.shared!.yourDeal!.dealId,
        choice: 'decline',
      });

      const after = await playerSnapshot(party.p1);
      expect(after.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_500);
    } finally {
      await closeParty(party);
    }
  });
});

describe('wagers over a real socket', () => {
  it('caps at 50%, locks, and resolves exactly once', async () => {
    // GAME_RULES_LOCKED.md §17, as a reusable primitive. No Family Feud board.
    const party = await makeGame();
    try {
      const tooBig = await party.p1.submit(SHARED_INTENTS.PROPOSE_WAGER, { amount: 501 });
      expect(tooBig.ok).toBe(false);

      const locked = await party.p1.submit(SHARED_INTENTS.PROPOSE_WAGER, { amount: 500 });
      expect(locked.ok).toBe(true);

      const p1 = await playerSnapshot(party.p1);
      const wager = p1.shared?.yourWagers[0];
      expect(wager?.status).toBe('locked');
      expect(wager?.maxAllowed).toBe(500);

      const resolved = await party.host.submit(SHARED_INTENTS.HOST_RESOLVE_WAGER, {
        wagerId: wager!.wagerId,
        won: true,
      });
      expect(resolved.ok).toBe(true);

      const after = await playerSnapshot(party.p1);
      expect(after.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_500);

      // Resolving again must not pay again.
      const again = await party.host.submit(SHARED_INTENTS.HOST_RESOLVE_WAGER, {
        wagerId: wager!.wagerId,
        won: true,
      });
      expect(again.ok).toBe(false);

      const final = await playerSnapshot(party.p1);
      expect(final.teams.find((t) => t.teamId === 'TEAM_A')?.bb).toBe(1_500);
    } finally {
      await closeParty(party);
    }
  });

  it('refuses a player resolving their own wager', async () => {
    const party = await makeGame();
    try {
      await party.p1.submit(SHARED_INTENTS.PROPOSE_WAGER, { amount: 100 });
      const p1 = await playerSnapshot(party.p1);

      const cheated = await party.p1.submit(SHARED_INTENTS.HOST_RESOLVE_WAGER, {
        wagerId: p1.shared!.yourWagers[0]!.wagerId,
        won: true,
      });
      expect(cheated.ok).toBe(false);
    } finally {
      await closeParty(party);
    }
  });
});

describe('Maco Mail over a real socket', () => {
  it('draws, resolves, and never exposes the deck order', async () => {
    const party = await makeGame();
    try {
      const drawn = await party.host.submit(SHARED_INTENTS.HOST_DRAW_MACO_MAIL, {
        teamId: 'TEAM_A',
      });
      expect(drawn.ok).toBe(true);

      const p1 = await playerSnapshot(party.p1);
      expect(p1.shared?.yourMacoDraws).toHaveLength(1);
      // Counts only, for players and the Host alike.
      expect(p1.shared?.macoDeck.drawPileCount).toBe(19);

      const host = await hostSnapshot(party);
      expect(Object.keys(host.shared?.macoDeck ?? {}).sort()).toEqual(
        ['discardCount', 'drawPileCount', 'heldOutOfDeckCount', 'removedImpossibleCount'].sort(),
      );
    } finally {
      await closeParty(party);
    }
  });

  it('shows a team only its own draws', async () => {
    const party = await makeGame();
    try {
      await party.host.submit(SHARED_INTENTS.HOST_DRAW_MACO_MAIL, { teamId: 'TEAM_A' });

      const p2 = await playerSnapshot(party.p2);
      expect(p2.shared?.yourMacoDraws).toHaveLength(0);
    } finally {
      await closeParty(party);
    }
  });

  it('keeps a held advantage across a reconnect', async () => {
    // Phase 6 spec §43 — reconnect must not redraw or lose held advantages.
    const party = await makeGame();
    try {
      // Draw until TEAM_A holds something.
      for (let i = 0; i < 6; i += 1) {
        await party.host.submit(SHARED_INTENTS.HOST_DRAW_MACO_MAIL, { teamId: 'TEAM_A' });
        const check = await playerSnapshot(party.p1);
        if ((check.shared?.yourAdvantages.length ?? 0) > 0) break;
      }

      const before = await playerSnapshot(party.p1);
      const advantageCount = before.shared?.yourAdvantages.length ?? 0;
      const drawCount = before.shared?.yourMacoDraws.length ?? 0;

      await party.p1.disconnect();
      const returning = await connectClient();
      returning.roomId = party.roomId;
      await returning.submit(ROOM_INTENTS.RECONNECT_PLAYER, {
        playerId: party.p1.playerId,
        reconnectToken: party.p1.reconnectToken,
      });

      const after = await playerSnapshot(returning);
      expect(after.shared?.yourAdvantages).toHaveLength(advantageCount);
      // Nothing was redrawn.
      expect(after.shared?.yourMacoDraws).toHaveLength(drawCount);

      await returning.disconnect();
    } finally {
      await party.host.disconnect();
      await party.p2.disconnect();
    }
  });
});
