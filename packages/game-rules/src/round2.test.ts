import { beforeEach, describe, expect, it } from 'vitest';
import {
  asIntentId,
  asRoomId,
  asTeamId,
  CARD_ELIGIBILITY,
  CLASH_RESPONSE_WINDOW_MS,
  GAME_INTENTS,
  isHostGameSnapshot,
  MARKET_PRICES,
  PROTOCOL_VERSION,
  ROOM_INTENTS,
  ROUND2_BASE_REWARD_BB,
  ROUND2_CHALLENGES,
  ROUND2_CHALLENGE_TYPES,
  ROUND2_EVENTS,
  ROUND2_INTENTS,
  SHARED_INTENTS,
  type BacchanalCardType,
  type EventEnvelope,
  type IntentEnvelope,
  type OwnCardView,
  type PlayerId,
  type Round2StateView,
  type TeamId,
} from '@bb/protocol';
import { FakeClock } from './clock.js';
import { Room, type RoomOutcome } from './room.js';

/**
 * Round 2 — "Shake Up Yuhself!". Phase 7A.
 *
 * Driven through the `Room` exactly as the network drives it, for the same
 * reason the Phase 5 tests are: authority, idempotency and the event log are
 * part of what Round 2 must guarantee, and a test that called `GameEngine`
 * directly would pass while the real path was broken.
 *
 * NOTHING HERE ASSERTS A PHYSICAL RULE. No test knows how Bottle Battle is
 * played, how long it lasts or how it is scored — D-003 puts all of that
 * outside the software, so there is nothing to assert. What is asserted is the
 * software's entire job: the locked order, the 500 BB award, the Host's
 * authority over the winner, and the fact that only Double It can change the
 * number.
 */

const HOST = 'conn-host';
const PHONE_1 = 'conn-p1';
const PHONE_2 = 'conn-p2';
const PHONE_3 = 'conn-p3';

const TEAM_A = asTeamId('TEAM_A');
const TEAM_B = asTeamId('TEAM_B');
const TEAM_C = asTeamId('TEAM_C');

let intentCounter = 0;
function intent(type: string, payload: unknown = {}, roomId = 'room-1'): IntentEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    intentId: asIntentId(`intent-${++intentCounter}`),
    roomId: asRoomId(roomId),
    type,
    payload,
  };
}

interface Harness {
  readonly room: Room;
  readonly clock: FakeClock;
  readonly players: readonly PlayerId[];
  readonly tokens: readonly string[];
  readonly phones: readonly string[];
  host(type: string, payload?: unknown): RoomOutcome;
  player(phone: string, type: string, payload?: unknown): RoomOutcome;
  round2(): Round2StateView;
  bb(teamId: TeamId): number;
}

/**
 * A room of `teamCount` teams, one player each, locked and ready to start.
 *
 * Both team counts run the SAME Round 2 (Phase 7A §17 — "Do not create a
 * separate Round 2 format for three teams unless a locked rule requires it"),
 * so the harness is parameterised rather than duplicated.
 */
function makeRoom(
  options: { devTools?: boolean; teamCount?: 2 | 3 } = {},
): Harness {
  const clock = new FakeClock(1_000);
  let ids = 0;
  const teamCount = options.teamCount ?? 2;

  const room = new Room({
    roomId: asRoomId('room-1'),
    roomCode: 'BX7K',
    mode: 'local_party',
    clock,
    hostToken: 'host-token',
    capacity: 24,
    mintToken: () => `token-${++ids}`,
    mintPlayerId: () => `id-${++ids}`,
    devTools: options.devTools ?? true,
  });

  room.attachHost(HOST);

  const phones = [PHONE_1, PHONE_2, PHONE_3].slice(0, teamCount);
  const teamIds = ['TEAM_A', 'TEAM_B', 'TEAM_C'].slice(0, teamCount);
  const players: PlayerId[] = [];
  const tokens: string[] = [];

  const host = (type: string, payload: unknown = {}): RoomOutcome =>
    room.handle(HOST, intent(type, payload));

  if (teamCount === 3) host(ROOM_INTENTS.HOST_SET_TEAM_MODE, { teamMode: 3 });

  phones.forEach((phone, index) => {
    room.onConnect(phone);
    const join = room.handle(phone, intent(ROOM_INTENTS.JOIN_ROOM, { displayName: `P${index}` }));
    const ackPayload = join.ack.ok
      ? (join.ack.value.payload as { playerId: string; reconnectToken: string })
      : { playerId: '', reconnectToken: '' };
    const playerId = ackPayload.playerId as PlayerId;
    players.push(playerId);
    tokens.push(ackPayload.reconnectToken);
    host(ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM, { playerId, teamId: teamIds[index] });
  });

  host(ROOM_INTENTS.HOST_LOCK_TEAMS);

  return {
    room,
    clock,
    players,
    tokens,
    phones,
    host,
    player: (phone, type, payload = {}) => room.handle(phone, intent(type, payload)),
    round2: () => {
      const view = room.game.round2View();
      if (view === null) throw new Error('Round 2 has not started');
      return view;
    },
    bb: (teamId) => room.game.balanceOf(teamId),
  };
}

/** Start a game and enter Round 2 through the development entry. */
function enterRound2(h: Harness): void {
  h.host(GAME_INTENTS.START_GAME);
  const entered = h.host(ROUND2_INTENTS.DEV_START_ROUND2);
  if (!entered.ack.ok) throw new Error('DEV_START_ROUND2 failed');
}

/**
 * Prepare and start the next physical challenge.
 *
 * Round 2 uses the GENERIC `HOST_START_CHALLENGE` — Phase 7A §26 asks not to
 * duplicate a message the engine already provides.
 */
function beginChallenge(h: Harness): RoomOutcome {
  h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'CHALLENGE_INTRO' });
  const prepared = h.host(ROUND2_INTENTS.HOST_PREPARE_ROUND2_CHALLENGE);
  h.host(GAME_INTENTS.HOST_START_CHALLENGE);
  return prepared;
}

/** Run one whole physical challenge to a confirmed result. */
function playChallenge(h: Harness, winner: TeamId): RoomOutcome {
  beginChallenge(h);
  h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: winner });
  return h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT);
}

function types(events: readonly EventEnvelope[]): string[] {
  return events.map((event) => event.type);
}

/**
 * Deal cards until a team holds DOUBLE_IT.
 *
 * Uses the development redeal, which exists for exactly this (Phase 6): a
 * random starting deal will not reliably give the team under test the one card
 * Round 2 permits. The redeal is a real intent through the real path, so
 * nothing here reaches around the card system.
 */
function dealDoubleItTo(h: Harness, teamId: TeamId): OwnCardView {
  h.host(SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const hand = h.room.game.shared.cards.handOf(teamId);
    const double = hand.find((card) => card.cardType === 'DOUBLE_IT');
    if (double !== undefined) return double as OwnCardView;
    h.host(SHARED_INTENTS.DEV_REDEAL_BACCHANAL_CARDS);
  }
  throw new Error('no deal produced a DOUBLE_IT');
}

beforeEach(() => {
  intentCounter = 0;
});

// ---------------------------------------------------------------------------
// Configuration — the locked shape of the round
// ---------------------------------------------------------------------------

describe('Round 2 configuration', () => {
  it('has exactly the four locked challenges, in the documented order', () => {
    // GAME_RULES_LOCKED.md §12 — "Bottle Battle, Match Makers, Grabbers,
    // Bombers". Phase 7A §3 — use the documented order, add nothing.
    expect(ROUND2_CHALLENGE_TYPES).toEqual([
      'BOTTLE_BATTLE',
      'MATCH_MAKERS',
      'GRABBERS',
      'BOMBERS',
    ]);
    expect(ROUND2_CHALLENGES).toHaveLength(4);
    expect(ROUND2_CHALLENGES.map((c) => c.order)).toEqual([0, 1, 2, 3]);
  });

  it('pays 500 BB for every challenge, from one constant', () => {
    // §12 — "Each is worth 500 BB." One value, not four.
    expect(ROUND2_BASE_REWARD_BB).toBe(500);
    for (const challenge of ROUND2_CHALLENGES) {
      expect(challenge.baseRewardBb).toBe(500);
      expect(challenge.roundIndex).toBe(2);
      expect(challenge.category).toBe('ROUND2_PHYSICAL');
      expect(challenge.hostJudged).toBe(true);
    }
  });

  it('carries no physical rule, duration or scoring anywhere in its config', () => {
    // D-003 — the physical rules stay outside the app. This asserts the ABSENCE
    // that guarantees it: a definition has no field that could hold one, so a
    // future edit that tries to add "how to play Bottle Battle" has nowhere to
    // put it without changing the type.
    for (const challenge of ROUND2_CHALLENGES) {
      expect(Object.keys(challenge).sort()).toEqual([
        'baseRewardBb',
        'cardChallengeKind',
        'category',
        'challengeType',
        'displayName',
        'hostJudged',
        'order',
        'roundIndex',
      ]);
    }
  });

  it('points at the locked eligibility row rather than restating it', () => {
    // Phase 7A §6 — no separate Round 2 card rule. The config names the row;
    // the row itself is GAME_RULES_LOCKED.md §6 in cards.ts.
    for (const challenge of ROUND2_CHALLENGES) {
      expect(challenge.cardChallengeKind).toBe('ROUND2_PHYSICAL');
    }
    expect(CARD_ELIGIBILITY.ROUND2_PHYSICAL).toEqual(['DOUBLE_IT']);
  });
});

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

describe('Round 2 entry', () => {
  it('enters Round 2 and reports all four challenges not started', () => {
    const h = makeRoom();
    enterRound2(h);

    const view = h.round2();
    expect(view.roundIndex).toBe(2);
    expect(view.complete).toBe(false);
    expect(view.resolvedCount).toBe(0);
    expect(view.currentIndex).toBe(0);
    expect(view.challenges.map((c) => c.progress)).toEqual([
      'not_started',
      'not_started',
      'not_started',
      'not_started',
    ]);
    expect(view.participatingTeamIds).toEqual([TEAM_A, TEAM_B]);
  });

  it('arrives on round 2 through real phase transitions', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    expect(h.room.game.phase).toBe('ROUND_INTRO');

    const entered = h.host(ROUND2_INTENTS.DEV_START_ROUND2);
    expect(entered.ack.ok).toBe(true);
    // The generic counter advanced the ordinary way; nothing assigned it.
    expect(h.room.game.sessionView()?.roundIndex).toBe(2);
    expect(h.room.game.phase).toBe('ROUND_INTRO');
    expect(types(entered.broadcast)).toContain(ROUND2_EVENTS.ROUND2_STARTED);
  });

  it('is REFUSED when the server runs without development tools', () => {
    // Phase 7A §4, §28 — the development entry "must be unavailable when dev
    // tools are disabled". Gated by the server (D-024), not by hiding a button.
    const h = makeRoom({ devTools: false });
    h.host(GAME_INTENTS.START_GAME);

    const entered = h.host(ROUND2_INTENTS.DEV_START_ROUND2);
    expect(entered.ack.ok).toBe(false);
    if (!entered.ack.ok) expect(entered.ack.error.code).toBe('ILLEGAL_ACTION');
    expect(h.room.game.round2View()).toBeNull();
  });

  it('refuses a player who asks to start Round 2', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);

    const outcome = h.player(PHONE_1, ROUND2_INTENTS.DEV_START_ROUND2);
    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('UNAUTHORIZED_ACTOR');
  });

  it('refuses to enter Round 2 twice', () => {
    const h = makeRoom();
    enterRound2(h);

    const again = h.host(ROUND2_INTENTS.DEV_START_ROUND2);
    expect(again.ack.ok).toBe(false);
    if (!again.ack.ok) expect(again.ack.error.code).toBe('WRONG_STATE');
    expect(h.round2().resolvedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Progression
// ---------------------------------------------------------------------------

describe('Round 2 progression', () => {
  it('walks the four challenges in the locked order', () => {
    const h = makeRoom();
    enterRound2(h);

    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const prepared = beginChallenge(h);
      const payload = prepared.broadcast.at(-1)?.payload as { challengeType: string };
      seen.push(payload.challengeType);
      h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_A });
      h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT);
    }

    expect(seen).toEqual(['BOTTLE_BATTLE', 'MATCH_MAKERS', 'GRABBERS', 'BOMBERS']);
  });

  it('does not let a second challenge be prepared while one is unresolved', () => {
    // Phase 7A §29 — "no skipping unresolved challenge".
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);

    const second = h.host(ROUND2_INTENTS.HOST_PREPARE_ROUND2_CHALLENGE);
    expect(second.ack.ok).toBe(false);
    expect(h.round2().current?.challengeType).toBe('BOTTLE_BATTLE');
  });

  it('completes the round after the fourth challenge', () => {
    const h = makeRoom();
    enterRound2(h);

    for (let i = 0; i < 3; i += 1) {
      playChallenge(h, TEAM_A);
      expect(h.round2().complete).toBe(false);
    }

    const last = playChallenge(h, TEAM_B);
    const view = h.round2();
    expect(view.complete).toBe(true);
    expect(view.resolvedCount).toBe(4);
    expect(view.currentIndex).toBeNull();
    expect(view.current).toBeNull();
    expect(types(last.broadcast)).toContain(ROUND2_EVENTS.ROUND2_CHALLENGE_RESOLVED);
    const payload = last.broadcast.at(-1)?.payload as { roundComplete: boolean };
    expect(payload.roundComplete).toBe(true);
  });

  it('refuses a fifth physical challenge', () => {
    // §18, §29 — Round 2 contains exactly four. What follows is Round 3, which
    // Phase 7A does not implement.
    const h = makeRoom();
    enterRound2(h);
    for (let i = 0; i < 4; i += 1) playChallenge(h, TEAM_A);

    h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'CHALLENGE_INTRO' });
    const fifth = h.host(ROUND2_INTENTS.HOST_PREPARE_ROUND2_CHALLENGE);

    expect(fifth.ack.ok).toBe(false);
    if (!fifth.ack.ok) expect(fifth.ack.error.code).toBe('ILLEGAL_ACTION');
    expect(h.round2().resolvedCount).toBe(4);
  });

  it('stops at the completed round rather than starting Round 3', () => {
    const h = makeRoom();
    enterRound2(h);
    for (let i = 0; i < 4; i += 1) playChallenge(h, TEAM_A);

    h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'ROUND_COMPLETE' });
    expect(h.room.game.phase).toBe('ROUND_COMPLETE');
    // The engine is READY to move on; Phase 7A deliberately does not.
    expect(h.room.game.sessionView()?.roundIndex).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Host authority over the winner
// ---------------------------------------------------------------------------

describe('Host winner selection', () => {
  it('accepts a Host selection and pays only on confirmation', () => {
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);

    const selected = h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_B });
    expect(selected.ack.ok).toBe(true);
    expect(types(selected.broadcast)).toContain(ROUND2_EVENTS.ROUND2_WINNER_SELECTED);
    // SELECTION MOVES NO BB. The whole reason it is a separate step.
    expect(h.bb(TEAM_B)).toBe(1_000);
    expect(h.round2().pendingWinnerTeamId).toBe(TEAM_B);

    h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT);
    expect(h.bb(TEAM_B)).toBe(1_500);
  });

  it('lets the Host change a selection before confirming', () => {
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);

    h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_A });
    h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_B });
    h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT);

    expect(h.bb(TEAM_B)).toBe(1_500);
    expect(h.bb(TEAM_A)).toBe(1_000);
  });

  it('REFUSES a player who tries to select the winner', () => {
    // Phase 7A §13 — "Do not let a player client submit the winner."
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);

    const outcome = h.player(PHONE_1, ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, {
      teamId: TEAM_A,
    });
    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('UNAUTHORIZED_ACTOR');
    expect(h.round2().pendingWinnerTeamId).toBeNull();
  });

  it('REFUSES a player who tries to confirm a result', () => {
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);
    h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_A });

    const outcome = h.player(PHONE_1, ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT);
    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('UNAUTHORIZED_ACTOR');
    expect(h.bb(TEAM_A)).toBe(1_000);
  });

  it('refuses an unknown team', () => {
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);

    const outcome = h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: 'TEAM_Z' });
    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('NOT_FOUND');
  });

  it('refuses a team that is not participating', () => {
    // A two-team game has no Team C. Phase 7A §13 — the winner must "exist" and
    // "participate in the game".
    const h = makeRoom({ teamCount: 2 });
    enterRound2(h);
    beginChallenge(h);

    const outcome = h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: 'TEAM_C' });
    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('NOT_FOUND');
  });

  it('refuses to resolve with no winner selected, rather than inventing a tie', () => {
    // Phase 7A §13 — "Do not invent tie rules... Do not silently resolve a tie."
    // No locked rule says what a drawn Round 2 game does, so the server requires
    // a winner and says so.
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);

    const outcome = h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT);
    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('ILLEGAL_ACTION');
    expect(h.bb(TEAM_A)).toBe(1_000);
    expect(h.bb(TEAM_B)).toBe(1_000);
    expect(h.round2().resolvedCount).toBe(0);
  });

  it('refuses a selection when no challenge is running', () => {
    const h = makeRoom();
    enterRound2(h);

    const outcome = h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_A });
    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('WRONG_STATE');
  });
});

// ---------------------------------------------------------------------------
// Result locking
// ---------------------------------------------------------------------------

describe('a confirmed result is final', () => {
  it('does not award twice on a duplicate intent', () => {
    // Phase 7A §14 — "duplicate Host submission does not award again". Caught by
    // the idempotency registry before any rule runs.
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);
    h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_A });

    const confirm = intent(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT);
    expect(h.room.handle(HOST, confirm).ack.ok).toBe(true);
    expect(h.bb(TEAM_A)).toBe(1_500);

    const replay = h.room.handle(HOST, confirm);
    expect(replay.ack.ok).toBe(false);
    if (!replay.ack.ok) expect(replay.ack.error.code).toBe('DUPLICATE_INTENT');
    expect(h.bb(TEAM_A)).toBe(1_500);
  });

  it('does not award twice on a second, distinct confirmation', () => {
    // A retried intent is caught above. This is the OTHER case: a stale Host
    // socket sending a genuinely new intent for a challenge already resolved.
    const h = makeRoom();
    enterRound2(h);
    playChallenge(h, TEAM_A);
    expect(h.bb(TEAM_A)).toBe(1_500);

    const again = h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT, { teamId: TEAM_A });
    expect(again.ack.ok).toBe(false);
    if (!again.ack.ok) expect(again.ack.error.code).toBe('WRONG_STATE');
    expect(h.bb(TEAM_A)).toBe(1_500);
    expect(h.round2().resolvedCount).toBe(1);
  });

  it('records the winner and award on the resolved challenge', () => {
    const h = makeRoom();
    enterRound2(h);
    playChallenge(h, TEAM_B);

    const resolved = h.round2().challenges[0]!;
    expect(resolved.progress).toBe('resolved');
    expect(resolved.winningTeamId).toBe(TEAM_B);
    expect(resolved.awardedBb).toBe(500);
    expect(resolved.doubled).toBe(false);
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it('clears the pending selection after resolving', () => {
    const h = makeRoom();
    enterRound2(h);
    playChallenge(h, TEAM_A);
    expect(h.round2().pendingWinnerTeamId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BB
// ---------------------------------------------------------------------------

describe('Round 2 BB', () => {
  it('pays exactly 500 BB for each of the four challenges', () => {
    // Phase 7A §31 — every challenge, normal win.
    for (const challengeType of ROUND2_CHALLENGE_TYPES) {
      const h = makeRoom();
      enterRound2(h);

      // Walk to the challenge under test, paying the others to the loser so the
      // winner's balance isolates this one award.
      const index = ROUND2_CHALLENGE_TYPES.indexOf(challengeType);
      for (let i = 0; i < index; i += 1) playChallenge(h, TEAM_B);

      const before = h.bb(TEAM_A);
      playChallenge(h, TEAM_A);
      expect(h.bb(TEAM_A) - before).toBe(500);
    }
  });

  it('moves BB through the ledger, not by assignment', () => {
    // Phase 7A §15 — "Do not directly mutate balances." The entry is the proof.
    const h = makeRoom();
    enterRound2(h);
    playChallenge(h, TEAM_A);

    const entries = h.room.game.ledgerEntries.filter(
      (e) => e.teamId === TEAM_A && e.reason === 'challenge_result',
    );
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.delta).toBe(500);
    expect(entry.applied).toBe(500);
    expect(entry.balanceBefore).toBe(1_000);
    expect(entry.balanceAfter).toBe(1_500);
    // The reason identifies the challenge that earned it (§15).
    expect(entry.challengeId).not.toBeNull();
    expect(entry.note).toContain('Bottle Battle');
    // The entry is attached to the event clients saw.
    expect(entry.seq).not.toBeNull();
  });

  it("leaves the losing teams' balances untouched", () => {
    const h = makeRoom({ teamCount: 3 });
    enterRound2(h);
    playChallenge(h, TEAM_A);

    expect(h.bb(TEAM_A)).toBe(1_500);
    expect(h.bb(TEAM_B)).toBe(1_000);
    expect(h.bb(TEAM_C)).toBe(1_000);
  });

  it('keeps balances independent across all four challenges', () => {
    const h = makeRoom();
    enterRound2(h);

    playChallenge(h, TEAM_A);
    playChallenge(h, TEAM_B);
    playChallenge(h, TEAM_A);
    playChallenge(h, TEAM_B);

    expect(h.bb(TEAM_A)).toBe(2_000);
    expect(h.bb(TEAM_B)).toBe(2_000);
  });

  it('ignores any BB amount a Host client tries to supply', () => {
    // CLAUDE.md — a client never decides "how much BB to add". The intent has
    // no amount field, and sending one changes nothing.
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);
    h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_A });
    h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT, {
      awardedBb: 99_999,
      bbDeltas: { TEAM_A: 99_999 },
      baseRewardBb: 99_999,
      doubled: true,
    });

    expect(h.bb(TEAM_A)).toBe(1_500);
    expect(h.round2().challenges[0]!.doubled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Card eligibility — GAME_RULES_LOCKED.md §6
// ---------------------------------------------------------------------------

describe('Round 2 card eligibility', () => {
  const ILLEGAL: readonly BacchanalCardType[] = [
    'STEUPS',
    'GIMME_DAT',
    'MACO',
    'DOH_KNOW',
    'FORGIVE_MEH',
    'ALLYUH_HELP_ME',
  ];

  it('permits Double It and refuses every other card', () => {
    // §6 — "Round 2 Physical Games: Double It! only". Asserted against the
    // shared table, which is the ONLY place the rule lives.
    expect(CARD_ELIGIBILITY.ROUND2_PHYSICAL).toEqual(['DOUBLE_IT']);
    for (const card of ILLEGAL) {
      expect(CARD_ELIGIBILITY.ROUND2_PHYSICAL).not.toContain(card);
    }
  });

  it('marks every non-Double-It card unplayable in a live Round 2 window', () => {
    // The server-computed view a phone renders. Phase 6 spec §5 — illegal cards
    // must not be selectable, and the server decides, not the UI.
    const h = makeRoom();
    enterRound2(h);
    h.host(SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS);
    beginChallenge(h);
    h.host(SHARED_INTENTS.HOST_OPEN_CARD_WINDOW, { challengeKind: 'ROUND2_PHYSICAL' });

    const view = h.room.game.shared.playerView(TEAM_A, false);
    for (const card of view.yourHand) {
      if (card.cardType === 'DOUBLE_IT') {
        expect(card.playable).toBe(true);
      } else {
        expect(card.playable).toBe(false);
        // MACO reports the OPEN RULE, never "wrong challenge" — OPEN_RULES.md §7.
        expect(card.unplayableReason).toBe(
          card.cardType === 'MACO' ? 'compatibility_unresolved' : 'not_eligible',
        );
      }
    }
  });

  it('REJECTS an illegal card played into a Round 2 challenge', () => {
    // The server refuses even when a client would have hidden the button.
    const h = makeRoom();
    enterRound2(h);
    h.host(SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS);
    beginChallenge(h);
    h.host(SHARED_INTENTS.HOST_OPEN_CARD_WINDOW, { challengeKind: 'ROUND2_PHYSICAL' });

    const illegal = h.room.game.shared.cards
      .handOf(TEAM_A)
      .find((card) => card.cardType !== 'DOUBLE_IT');
    expect(illegal).toBeDefined();

    const outcome = h.player(PHONE_1, SHARED_INTENTS.PLAY_BACCHANAL_CARD, {
      cardInstanceId: illegal!.cardInstanceId,
      targetTeamId: 'TEAM_B',
    });
    expect(outcome.ack.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Double It
// ---------------------------------------------------------------------------

describe('Double It in Round 2', () => {
  /** Play a Double It for `teamId` and let the Clash resolve uncontested. */
  function playDoubleIt(h: Harness, phone: string, teamId: TeamId): void {
    const double = dealDoubleItTo(h, teamId);
    h.host(SHARED_INTENTS.HOST_OPEN_CARD_WINDOW, { challengeKind: 'ROUND2_PHYSICAL' });

    const played = h.player(phone, SHARED_INTENTS.PLAY_BACCHANAL_CARD, {
      cardInstanceId: double.cardInstanceId,
    });
    expect(played.ack.ok).toBe(true);

    // §5's hidden window. Round 2 permits only Double It, so an opposing team
    // usually has no legal counter and the card resolves uncontested — Phase 7A
    // §9 forbids enabling another card just to manufacture a Clash.
    h.clock.advance(CLASH_RESPONSE_WINDOW_MS + 1);
    h.room.tick();
  }

  it('pays 1,000 BB when the winning team doubled before the result', () => {
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);
    playDoubleIt(h, PHONE_1, TEAM_A);

    expect(h.room.game.shared.isDoubledFor(TEAM_A)).toBe(true);

    h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_A });
    h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT);

    // 500 x 2 — and 1,000 appears nowhere in the code that produced it.
    expect(h.bb(TEAM_A)).toBe(2_000);
    const resolved = h.round2().challenges[0]!;
    expect(resolved.awardedBb).toBe(1_000);
    expect(resolved.doubled).toBe(true);
  });

  it('pays the LOSING doubler nothing, and the winner only 500', () => {
    // The multiplier belongs to the team that played it. Doubling does not
    // create a reward where there is no win.
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);
    playDoubleIt(h, PHONE_1, TEAM_A);

    h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_B });
    h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT);

    expect(h.bb(TEAM_B)).toBe(1_500);
    expect(h.bb(TEAM_A)).toBe(1_000);
    expect(h.round2().challenges[0]!.doubled).toBe(false);
  });

  it('REFUSES a Double It played after the result is confirmed', () => {
    // GAME_RULES_LOCKED.md §3 — "activate before result". Once the Host has
    // committed, there is no live challenge to play into.
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);
    const double = dealDoubleItTo(h, TEAM_A);
    h.host(SHARED_INTENTS.HOST_OPEN_CARD_WINDOW, { challengeKind: 'ROUND2_PHYSICAL' });

    h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_A });
    h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT);
    expect(h.bb(TEAM_A)).toBe(1_500);

    const late = h.player(PHONE_1, SHARED_INTENTS.PLAY_BACCHANAL_CARD, {
      cardInstanceId: double.cardInstanceId,
    });
    expect(late.ack.ok).toBe(false);
    // And no retroactive top-up.
    expect(h.bb(TEAM_A)).toBe(1_500);
  });

  it('does not stack a second multiplier', () => {
    // §3 — "multipliers never stack"; §10 — "one Double". Enforced by the ONE
    // shared budget, which is why Round 2 has no stacking code of its own.
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);
    playDoubleIt(h, PHONE_1, TEAM_A);

    expect(h.room.game.shared.advantages.canUse(TEAM_A, 'DOUBLE')).toBe(false);
    // Whatever else happens, the multiplier is x2 and not x4.
    expect(h.room.game.shared.applyMultiplier(TEAM_A, ROUND2_BASE_REWARD_BB)).toBe(1_000);

    h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_A });
    h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT);
    expect(h.bb(TEAM_A)).toBe(2_000);
  });

  it('doubles a Round 2 award from a MARKET Double BB too', () => {
    // docs/ROUND_2.md claims Market DOUBLE_BB works in Round 2 while Clue,
    // Extra Time and Second Chance are deliberately not wired. This asserts the
    // half that IS claimed to work, so the doc cannot drift from the code.
    //
    // It works for free: a Market Double and a Double It card both resolve to
    // the single shared DOUBLE advantage, which is what makes "multipliers never
    // stack" (§3, §10) checkable in one place — and what makes Round 2's award
    // path indifferent to where the multiplier came from.
    const h = makeRoom();
    enterRound2(h);
    h.host(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 2 });
    h.player(PHONE_1, SHARED_INTENTS.PURCHASE_MARKET_ITEM, { item: 'DOUBLE_BB' });
    h.host(SHARED_INTENTS.HOST_CLOSE_MARKET);
    expect(h.bb(TEAM_A)).toBe(750);

    beginChallenge(h);
    const advantage = h.room.game.shared.advantages.usableFor(TEAM_A)[0]!;
    const used = h.player(PHONE_1, SHARED_INTENTS.USE_ADVANTAGE, {
      advantageId: advantage.advantageId,
    });
    expect(used.ack.ok).toBe(true);

    h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_A });
    h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT);

    // 750 + (500 x 2)
    expect(h.bb(TEAM_A)).toBe(1_750);
    expect(h.round2().challenges[0]!.doubled).toBe(true);
  });

  it('does not carry a multiplier into the next challenge', () => {
    // Per-challenge budgets reset when a challenge ends (§4, §10 are per
    // question). A team that doubled Bottle Battle does not double Match Makers.
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);
    playDoubleIt(h, PHONE_1, TEAM_A);
    h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_A });
    h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT);
    expect(h.bb(TEAM_A)).toBe(2_000);

    playChallenge(h, TEAM_A);
    // +500, not +1,000.
    expect(h.bb(TEAM_A)).toBe(2_500);
    expect(h.round2().challenges[1]!.doubled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

describe('the Market before Round 2', () => {
  it('opens at the locked Round 2 prices, from the Phase 6 table', () => {
    // GAME_RULES_LOCKED.md §10. Phase 7A §5 — no duplicated price anywhere in
    // Round 2 code, so this asserts the shared table is what is used.
    const h = makeRoom();
    enterRound2(h);
    const opened = h.host(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 2 });
    expect(opened.ack.ok).toBe(true);

    const market = h.room.game.shared.market.view();
    expect(market?.round).toBe(2);
    for (const [item, price] of Object.entries(market?.prices ?? {})) {
      expect(price).toBe(MARKET_PRICES[item as keyof typeof MARKET_PRICES][2]);
    }
    expect(MARKET_PRICES.CLUE[2]).toBe(200);
    expect(MARKET_PRICES.MACO_MAIL[2]).toBe(500);
  });

  it('spends BB through the ledger and keeps the purchase hidden until close', () => {
    const h = makeRoom();
    enterRound2(h);
    h.host(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 2 });

    const bought = h.player(PHONE_1, SHARED_INTENTS.PURCHASE_MARKET_ITEM, { item: 'CLUE' });
    expect(bought.ack.ok).toBe(true);
    expect(h.bb(TEAM_A)).toBe(800);

    // Hidden from the opponent while open (§10).
    const opponent = h.room.game.shared.playerView(TEAM_B, false);
    expect(opponent.market.otherTeamPurchases).toHaveLength(0);

    h.host(SHARED_INTENTS.HOST_CLOSE_MARKET);
    const revealed = h.room.game.shared.playerView(TEAM_B, false);
    expect(revealed.market.otherTeamPurchases.length).toBeGreaterThan(0);
  });

  it('runs the whole locked sequence: intro, Market, close, first challenge', () => {
    // Phase 7A §5 — the conceptual Round 2 flow, exercised end to end.
    const h = makeRoom();
    enterRound2(h);
    expect(h.room.game.phase).toBe('ROUND_INTRO');

    h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'MARKET' });
    h.host(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 2 });
    h.player(PHONE_1, SHARED_INTENTS.PURCHASE_MARKET_ITEM, { item: 'SECOND_CHANCE' });
    h.host(SHARED_INTENTS.HOST_CLOSE_MARKET);
    h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'CHALLENGE_INTRO' });

    const prepared = h.host(ROUND2_INTENTS.HOST_PREPARE_ROUND2_CHALLENGE);
    expect(prepared.ack.ok).toBe(true);
    h.host(GAME_INTENTS.HOST_START_CHALLENGE);
    expect(h.room.game.phase).toBe('ACTIVE_PLAY');
    expect(h.bb(TEAM_A)).toBe(750);
  });

  it('expires a Round 2 Market item at the round boundary', () => {
    // §10 — items bought before Round 2 expire once Round 2 ends.
    const h = makeRoom();
    enterRound2(h);
    h.host(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 2 });
    h.player(PHONE_1, SHARED_INTENTS.PURCHASE_MARKET_ITEM, { item: 'CLUE' });
    h.host(SHARED_INTENTS.HOST_CLOSE_MARKET);

    expect(h.room.game.shared.advantages.usableFor(TEAM_A)).toHaveLength(1);

    for (let i = 0; i < 4; i += 1) playChallenge(h, TEAM_A);
    h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'ROUND_COMPLETE' });
    h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'ROUND_INTRO' });

    expect(h.room.game.shared.advantages.usableFor(TEAM_A)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Two and three teams
// ---------------------------------------------------------------------------

describe('team counts', () => {
  for (const teamCount of [2, 3] as const) {
    it(`runs all four challenges with ${teamCount} teams`, () => {
      // Phase 7A §16, §17 — the SAME format for both, and no elimination.
      const h = makeRoom({ teamCount });
      enterRound2(h);

      const teams = teamCount === 2 ? [TEAM_A, TEAM_B] : [TEAM_A, TEAM_B, TEAM_C];
      expect(h.round2().participatingTeamIds).toEqual(teams);

      for (const challengeType of ROUND2_CHALLENGE_TYPES) {
        const prepared = beginChallenge(h);
        const payload = prepared.broadcast.at(-1)?.payload as { challengeType: string };
        expect(payload.challengeType).toBe(challengeType);
        h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_B });
        expect(h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT).ack.ok).toBe(true);
      }

      expect(h.round2().complete).toBe(true);
      expect(h.bb(TEAM_B)).toBe(3_000);
      expect(h.bb(TEAM_A)).toBe(1_000);
      if (teamCount === 3) expect(h.bb(TEAM_C)).toBe(1_000);
    });
  }

  it('lets any of three teams win, with no team eliminated', () => {
    const h = makeRoom({ teamCount: 3 });
    enterRound2(h);

    playChallenge(h, TEAM_C);
    playChallenge(h, TEAM_A);
    playChallenge(h, TEAM_B);
    playChallenge(h, TEAM_C);

    expect(h.bb(TEAM_A)).toBe(1_500);
    expect(h.bb(TEAM_B)).toBe(1_500);
    expect(h.bb(TEAM_C)).toBe(2_000);
    // Every team was still eligible for the last challenge.
    expect(h.round2().participatingTeamIds).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Pause and the active-player rule
// ---------------------------------------------------------------------------

describe('Round 2 and the disconnect rule', () => {
  it('does NOT pause when a phone drops during a physical challenge', () => {
    // Phase 7A §23, and D-021. The physical game happens in the room; nobody is
    // a software-active player unless a challenge marks them one, and Round 2
    // marks nobody. So a phone going to sleep must not stop the party.
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);
    expect(h.room.game.activePlayerIds()).toHaveLength(0);

    h.room.onDisconnect(PHONE_1);
    expect(h.room.game.paused).toBe(false);
    expect(h.room.game.phase).toBe('ACTIVE_PLAY');
  });

  it('still refuses to award BB while the game IS paused', () => {
    // Nothing about Round 2 weakens the pause guard: a Host pause stops the
    // award exactly as it stops everything else.
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);
    h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_A });
    h.host(GAME_INTENTS.HOST_PAUSE_GAME);

    const blocked = h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT);
    expect(blocked.ack.ok).toBe(false);
    if (!blocked.ack.ok) expect(blocked.ack.error.code).toBe('WRONG_STATE');
    expect(h.bb(TEAM_A)).toBe(1_000);

    h.host(GAME_INTENTS.HOST_RESUME_GAME);
    expect(h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT).ack.ok).toBe(true);
    expect(h.bb(TEAM_A)).toBe(1_500);
  });
});

// ---------------------------------------------------------------------------
// Snapshots and reconnect
// ---------------------------------------------------------------------------

describe('Round 2 snapshots', () => {
  it('carries Round 2 state to the Host and to a player alike', () => {
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);
    h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_B });

    const hostSnap = h.room.gameSnapshot(HOST);
    const playerSnap = h.room.gameSnapshot(PHONE_1);
    expect(isHostGameSnapshot(hostSnap)).toBe(true);

    for (const snap of [hostSnap, playerSnap]) {
      const round2 = snap.game?.round2;
      expect(round2?.current?.challengeType).toBe('BOTTLE_BATTLE');
      expect(round2?.current?.displayName).toBe('Bottle Battle');
      expect(round2?.pendingWinnerTeamId).toBe(TEAM_B);
      expect(round2?.challenges).toHaveLength(4);
      expect(round2?.resolvedCount).toBe(0);
    }
  });

  it('is null outside Round 2', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    expect(h.room.gameSnapshot(HOST).game?.round2).toBeNull();
  });

  it('restores the round for a reconnecting phone, duplicating nothing', () => {
    // Phase 7A §22, §34.
    const h = makeRoom();
    enterRound2(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h);
    h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_B });

    const credential = h.tokens[0]!;
    h.room.onDisconnect(PHONE_1);
    h.room.onConnect('conn-p1-again');
    const back = h.room.handle(
      'conn-p1-again',
      intent(ROOM_INTENTS.RECONNECT_PLAYER, { playerId: h.players[0], reconnectToken: credential }),
    );
    expect(back.ack.ok).toBe(true);

    const snap = h.room.gameSnapshot('conn-p1-again');
    const round2 = snap.game?.round2;
    expect(round2?.resolvedCount).toBe(1);
    expect(round2?.challenges[0]?.winningTeamId).toBe(TEAM_A);
    expect(round2?.challenges[0]?.awardedBb).toBe(500);
    expect(round2?.current?.challengeType).toBe('MATCH_MAKERS');
    expect(round2?.pendingWinnerTeamId).toBe(TEAM_B);
    // Nothing was paid again by the reconnect.
    expect(h.bb(TEAM_A)).toBe(1_500);
    expect(h.bb(TEAM_B)).toBe(1_000);
  });

  it('restores the round for a reconnecting Host without reselecting a winner', () => {
    // Phase 7A §24 — "Do not automatically select/reselect a winner."
    const h = makeRoom();
    enterRound2(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h);

    h.room.onDisconnect(HOST);
    h.room.onConnect('conn-host-again');
    const back = h.room.handle(
      'conn-host-again',
      intent(ROOM_INTENTS.RECONNECT_HOST, { hostToken: 'host-token' }),
    );
    expect(back.ack.ok).toBe(true);

    const snap = h.room.gameSnapshot('conn-host-again');
    expect(snap.game?.round2?.resolvedCount).toBe(1);
    expect(snap.game?.round2?.current?.challengeType).toBe('MATCH_MAKERS');
    expect(snap.game?.round2?.pendingWinnerTeamId).toBeNull();
    expect(h.bb(TEAM_A)).toBe(1_500);
  });

  it('restores an active Double It across a reconnect without redoubling', () => {
    const h = makeRoom();
    enterRound2(h);
    beginChallenge(h);
    const double = dealDoubleItTo(h, TEAM_A);
    h.host(SHARED_INTENTS.HOST_OPEN_CARD_WINDOW, { challengeKind: 'ROUND2_PHYSICAL' });
    h.player(PHONE_1, SHARED_INTENTS.PLAY_BACCHANAL_CARD, {
      cardInstanceId: double.cardInstanceId,
    });
    h.clock.advance(CLASH_RESPONSE_WINDOW_MS + 1);
    h.room.tick();
    expect(h.room.game.shared.isDoubledFor(TEAM_A)).toBe(true);

    const credential = h.tokens[0]!;
    h.room.onDisconnect(PHONE_1);
    h.room.onConnect('conn-p1-again');
    h.room.handle(
      'conn-p1-again',
      intent(ROOM_INTENTS.RECONNECT_PLAYER, { playerId: h.players[0], reconnectToken: credential }),
    );

    // Still doubled, still exactly once.
    expect(h.room.game.shared.isDoubledFor(TEAM_A)).toBe(true);
    h.host(ROUND2_INTENTS.HOST_SELECT_PHYSICAL_WINNER, { teamId: TEAM_A });
    h.host(ROUND2_INTENTS.HOST_CONFIRM_PHYSICAL_RESULT);
    expect(h.bb(TEAM_A)).toBe(2_000);
  });

  it('restores Market state mid-shop without rebuying', () => {
    const h = makeRoom();
    enterRound2(h);
    h.host(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 2 });
    h.player(PHONE_1, SHARED_INTENTS.PURCHASE_MARKET_ITEM, { item: 'CLUE' });
    expect(h.bb(TEAM_A)).toBe(800);

    const credential = h.tokens[0]!;
    h.room.onDisconnect(PHONE_1);
    h.room.onConnect('conn-p1-again');
    h.room.handle(
      'conn-p1-again',
      intent(ROOM_INTENTS.RECONNECT_PLAYER, { playerId: h.players[0], reconnectToken: credential }),
    );

    expect(h.bb(TEAM_A)).toBe(800);
    const snap = h.room.gameSnapshot('conn-p1-again');
    expect(snap.game?.round2?.roundIndex).toBe(2);
    if (!snap.isHost) {
      expect(snap.shared?.market.yourPurchases).toHaveLength(1);
    }
  });
});
