import { beforeEach, describe, expect, it } from 'vitest';
import {
  asIntentId,
  asRoomId,
  asTeamId,
  CARD_ELIGIBILITY,
  GAME_INTENTS,
  PROTOCOL_VERSION,
  ROOM_INTENTS,
  ROUND3_CHALLENGES,
  ROUND3_CHALLENGE_TYPES,
  ROUND3_EVENTS,
  ROUND3_INTENTS,
  ROUND3_ITEM_WINDOW_MS,
  SHARED_INTENTS,
  type EventEnvelope,
  type IntentEnvelope,
  type PlayerId,
  type Round3StateView,
  type TeamId,
} from '@bb/protocol';
import { asChallengeId, rpsBeats, type RpsChoice } from '@bb/protocol';
import { FakeClock } from './clock.js';
import { Room, type RoomOutcome } from './room.js';
import { Round3 } from './round3.js';

/**
 * Round 3. Phase 7B.
 *
 * Driven through the `Room`, exactly as the network drives it — authority,
 * idempotency and the event log are part of what Round 3 must guarantee.
 *
 * THE CENTRAL ASSERTION of this file is that three counters stay separate:
 * challenge points decide one challenge, the challenge-win counter decides the
 * round, and BB is the game's score. §13 states it with a worked example
 * because it is the thing most easily collapsed.
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
  round3(): Round3StateView;
  bb(teamId: TeamId): number;
  wins(teamId: TeamId): number;
}

function makeRoom(options: { devTools?: boolean; teamCount?: 2 | 3 } = {}): Harness {
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
    const payload = join.ack.ok
      ? (join.ack.value.payload as { playerId: string; reconnectToken: string })
      : { playerId: '', reconnectToken: '' };
    players.push(payload.playerId as PlayerId);
    tokens.push(payload.reconnectToken);
    host(ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM, { playerId: payload.playerId, teamId: teamIds[index] });
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
    round3: () => {
      const view = room.game.round3View();
      if (view === null) throw new Error('Round 3 has not started');
      return view;
    },
    bb: (teamId) => room.game.balanceOf(teamId),
    wins: (teamId) => room.game.round3View()?.challengeWins[teamId] ?? 0,
  };
}

/** Start a game and enter Round 3 through the development entry. */
function enterRound3(h: Harness): void {
  h.host(GAME_INTENTS.START_GAME);
  const entered = h.host(ROUND3_INTENTS.DEV_START_ROUND3);
  if (!entered.ack.ok) throw new Error('DEV_START_ROUND3 failed');
}

/** Prepare and start the next Round 3 challenge. */
function beginChallenge(h: Harness): RoomOutcome {
  h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'CHALLENGE_INTRO' });
  const prepared = h.host(ROUND3_INTENTS.HOST_PREPARE_ROUND3_CHALLENGE);
  h.host(GAME_INTENTS.HOST_START_CHALLENGE);
  return prepared;
}

/** Run one challenge to a confirmed winner, with no points scored. */
function playChallenge(h: Harness, winner: TeamId): RoomOutcome {
  beginChallenge(h);
  return h.host(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, { teamId: winner });
}

function types(events: readonly EventEnvelope[]): string[] {
  return events.map((e) => e.type);
}

beforeEach(() => {
  intentCounter = 0;
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('Round 3 configuration', () => {
  it('has the four locked challenges in the documented order', () => {
    expect(ROUND3_CHALLENGE_TYPES).toEqual([
      'THINK_FAST',
      'GUESS_THE_LOGO',
      'ALL_ANSWERS_BEGIN_WITH',
      'SING_A_SONG',
    ]);
  });

  it('pays BB only where a locked rule says so', () => {
    // §14 and §17 award 500; §15 and §16 award none. D-031.
    const byType = Object.fromEntries(ROUND3_CHALLENGES.map((c) => [c.challengeType, c]));
    expect(byType['THINK_FAST']?.baseRewardBb).toBe(500);
    expect(byType['SING_A_SONG']?.baseRewardBb).toBe(500);
    expect(byType['GUESS_THE_LOGO']?.baseRewardBb).toBe(0);
    expect(byType['ALL_ANSWERS_BEGIN_WITH']?.baseRewardBb).toBe(0);
  });

  it('carries the locked targets and windows', () => {
    const byType = Object.fromEntries(ROUND3_CHALLENGES.map((c) => [c.challengeType, c]));
    expect(byType['GUESS_THE_LOGO']?.targetScore).toBe(5);
    expect(byType['ALL_ANSWERS_BEGIN_WITH']?.targetScore).toBe(5);
    expect(byType['SING_A_SONG']?.targetScore).toBe(3);
    // Think Fast is elimination, not points — it has no target.
    expect(byType['THINK_FAST']?.targetScore).toBeNull();
    // OPEN_RULES.md §2 — the Think Fast timer is NOT locked, so it stays null.
    expect(byType['THINK_FAST']?.itemWindowMs).toBeNull();
    expect(byType['GUESS_THE_LOGO']?.itemWindowMs).toBe(ROUND3_ITEM_WINDOW_MS);
    expect(ROUND3_ITEM_WINDOW_MS).toBe(10_000);
  });

  it('uses the locked card-eligibility rows rather than restating them', () => {
    expect(CARD_ELIGIBILITY.THINK_FAST).toEqual(['STEUPS', 'DOUBLE_IT', 'FORGIVE_MEH']);
    expect(CARD_ELIGIBILITY.GUESS_THE_LOGO).toEqual(['DOUBLE_IT']);
    expect(CARD_ELIGIBILITY.ALL_ANSWERS_BEGIN_WITH).toEqual(['DOUBLE_IT', 'FORGIVE_MEH']);
    expect(CARD_ELIGIBILITY.SING_A_SONG).toEqual(['DOUBLE_IT']);
    for (const challenge of ROUND3_CHALLENGES) {
      expect(CARD_ELIGIBILITY[challenge.cardChallengeKind]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Entry and progression
// ---------------------------------------------------------------------------

describe('Round 3 entry and progression', () => {
  it('enters Round 3 with every counter at zero', () => {
    const h = makeRoom();
    enterRound3(h);

    const view = h.round3();
    expect(view.roundIndex).toBe(3);
    expect(view.complete).toBe(false);
    expect(view.challengeWins).toEqual({ TEAM_A: 0, TEAM_B: 0 });
    expect(view.challenges.map((c) => c.progress)).toEqual([
      'not_started',
      'not_started',
      'not_started',
      'not_started',
    ]);
  });

  it('is refused without development tools', () => {
    const h = makeRoom({ devTools: false });
    h.host(GAME_INTENTS.START_GAME);
    const entered = h.host(ROUND3_INTENTS.DEV_START_ROUND3);
    expect(entered.ack.ok).toBe(false);
    expect(h.room.game.round3View()).toBeNull();
  });

  it('walks the four challenges in the locked order', () => {
    const h = makeRoom();
    enterRound3(h);

    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const prepared = beginChallenge(h);
      const payload = prepared.broadcast.at(-1)?.payload as { challengeType: string };
      seen.push(payload.challengeType);
      h.host(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, { teamId: TEAM_A });
    }

    expect(seen).toEqual([
      'THINK_FAST',
      'GUESS_THE_LOGO',
      'ALL_ANSWERS_BEGIN_WITH',
      'SING_A_SONG',
    ]);
  });

  it('refuses a second challenge while one is unresolved', () => {
    const h = makeRoom();
    enterRound3(h);
    beginChallenge(h);
    expect(h.host(ROUND3_INTENTS.HOST_PREPARE_ROUND3_CHALLENGE).ack.ok).toBe(false);
  });

  it('refuses a fifth challenge', () => {
    const h = makeRoom();
    enterRound3(h);
    for (let i = 0; i < 4; i += 1) playChallenge(h, TEAM_A);

    h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'CHALLENGE_INTRO' });
    const fifth = h.host(ROUND3_INTENTS.HOST_PREPARE_ROUND3_CHALLENGE);
    expect(fifth.ack.ok).toBe(false);
    if (!fifth.ack.ok) expect(fifth.ack.error.code).toBe('ILLEGAL_ACTION');
  });
});

// ---------------------------------------------------------------------------
// The three counters stay separate — §13
// ---------------------------------------------------------------------------

describe('challenge points, challenge wins and BB stay separate', () => {
  it('five logo points is ONE round win and ZERO BB', () => {
    // The worked example from §13, asserted directly. This is the single most
    // important test in the file.
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A); // Think Fast out of the way

    beginChallenge(h); // Guess the Logo
    const bbBefore = h.bb(TEAM_A);
    for (let i = 0; i < 5; i += 1) {
      h.host(ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT, { teamId: TEAM_A });
    }

    const challenge = h.round3().current!;
    expect(challenge.scores['TEAM_A']).toBe(5);
    // Points are NOT BB.
    expect(h.bb(TEAM_A)).toBe(bbBefore);
    // Points are NOT round wins.
    expect(h.wins(TEAM_A)).toBe(1); // only Think Fast so far

    h.host(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, { teamId: TEAM_A });

    // ONE more win, still no BB — Guess the Logo pays none (§15).
    expect(h.wins(TEAM_A)).toBe(2);
    expect(h.bb(TEAM_A)).toBe(bbBefore);
  });

  it('awards a challenge point without touching the ledger', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h);

    const entriesBefore = h.room.game.ledgerEntries.length;
    h.host(ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT, { teamId: TEAM_B });
    expect(h.room.game.ledgerEntries.length).toBe(entriesBefore);
    expect(h.round3().current?.scores['TEAM_B']).toBe(1);
  });

  it('resets challenge points between challenges', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);

    beginChallenge(h);
    h.host(ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT, { teamId: TEAM_A });
    h.host(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, { teamId: TEAM_A });

    beginChallenge(h);
    // The new challenge starts from zero; points never accumulate.
    expect(h.round3().current?.scores['TEAM_A']).toBe(0);
  });

  it('increments the challenge-win counter exactly once per challenge', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    expect(h.wins(TEAM_A)).toBe(1);

    // A second confirmation of the same challenge is refused.
    const again = h.host(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, { teamId: TEAM_A });
    expect(again.ack.ok).toBe(false);
    expect(h.wins(TEAM_A)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// BB
// ---------------------------------------------------------------------------

describe('Round 3 BB', () => {
  it('pays 500 for Think Fast and Sing a Song only', () => {
    const h = makeRoom();
    enterRound3(h);

    const start = h.bb(TEAM_A);
    playChallenge(h, TEAM_A); // Think Fast — 500
    expect(h.bb(TEAM_A)).toBe(start + 500);

    playChallenge(h, TEAM_A); // Guess the Logo — none
    expect(h.bb(TEAM_A)).toBe(start + 500);

    playChallenge(h, TEAM_A); // All Answers — none
    expect(h.bb(TEAM_A)).toBe(start + 500);

    playChallenge(h, TEAM_A); // Sing a Song — 500
    expect(h.bb(TEAM_A)).toBe(start + 1_000);
  });

  it('awards no BB for winning Round 3 overall', () => {
    // D-031 — no locked rule grants one, so none is invented.
    const h = makeRoom();
    enterRound3(h);
    for (let i = 0; i < 4; i += 1) playChallenge(h, TEAM_A);

    const afterChallenges = h.bb(TEAM_A);
    expect(h.round3().winningTeamId).toBe(TEAM_A);
    // Deciding the winner moved nothing.
    expect(h.bb(TEAM_A)).toBe(afterChallenges);
    expect(afterChallenges).toBe(2_000); // 1,000 start + 500 + 500
  });

  it('ignores a BB amount supplied by a Host client', () => {
    const h = makeRoom();
    enterRound3(h);
    beginChallenge(h);
    h.host(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, {
      teamId: TEAM_A,
      awardedBb: 99_999,
      bbDeltas: { TEAM_A: 99_999 },
    });
    expect(h.bb(TEAM_A)).toBe(1_500);
  });
});

// ---------------------------------------------------------------------------
// Host discretion — §15, §16, §17
// ---------------------------------------------------------------------------

describe('Host discretion over the challenge end', () => {
  it('does NOT resolve a challenge when the target is reached', () => {
    // The rule that stops a score ending a spoken challenge on its own.
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);

    beginChallenge(h); // Guess the Logo, target 5
    for (let i = 0; i < 5; i += 1) {
      h.host(ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT, { teamId: TEAM_B });
    }

    const view = h.round3();
    expect(view.current?.targetReached).toBe(true);
    // Reached, but still running and still unresolved.
    expect(view.current?.progress).toBe('in_progress');
    expect(view.current?.winningTeamId).toBeNull();
    expect(h.wins(TEAM_B)).toBe(0);
  });

  it('lets the Host confirm BEFORE the target', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);

    beginChallenge(h);
    h.host(ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT, { teamId: TEAM_B });
    expect(h.round3().current?.targetReached).toBe(false);

    const confirmed = h.host(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, { teamId: TEAM_B });
    expect(confirmed.ack.ok).toBe(true);
    expect(h.wins(TEAM_B)).toBe(1);
  });

  it('lets the Host keep going PAST the target', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);

    beginChallenge(h);
    for (let i = 0; i < 7; i += 1) {
      h.host(ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT, { teamId: TEAM_A });
    }
    expect(h.round3().current?.scores['TEAM_A']).toBe(7);
    expect(h.round3().current?.progress).toBe('in_progress');

    h.host(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, { teamId: TEAM_A });
    expect(h.wins(TEAM_A)).toBe(2);
  });

  it('lets the Host confirm a team that did NOT lead on points', () => {
    // Host judgment is authoritative (§15-§17); the score is not a rule input.
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);

    beginChallenge(h);
    for (let i = 0; i < 4; i += 1) {
      h.host(ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT, { teamId: TEAM_A });
    }
    const confirmed = h.host(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, { teamId: TEAM_B });
    expect(confirmed.ack.ok).toBe(true);
    expect(h.wins(TEAM_B)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

describe('the game supplies the content', () => {
  it('reveals an item from the content source, not from the Host payload', () => {
    // §13 — the Host controls progression, the game supplies content. A prompt
    // in the payload must not become the item on screen.
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h);

    const revealed = h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM, {
      body: 'HOST-INVENTED PROMPT',
      itemId: 'forged',
    });
    expect(revealed.ack.ok).toBe(true);

    const item = h.round3().current?.currentItem;
    expect(item?.body).not.toBe('HOST-INVENTED PROMPT');
    expect(item?.itemId).not.toBe('forged');
    // TEST fixtures are obviously fake, by policy.
    expect(item?.body).toContain('TEST');
  });

  it('advances through items and counts them for display', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h);

    h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM);
    const first = h.round3().current?.currentItem;
    h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM);
    const second = h.round3().current?.currentItem;

    expect(first?.index).toBe(1);
    expect(second?.index).toBe(2);
    expect(second?.itemId).not.toBe(first?.itemId);
  });

  it('carries the required letter for All Answers Begin With', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    playChallenge(h, TEAM_A);
    beginChallenge(h); // All Answers Begin With

    h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM);
    expect(h.round3().current?.currentItem?.letter).toBe('T');
  });

  it('runs the item window on the server clock, and pauses it with the game', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h);
    h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM);

    expect(h.round3().current?.currentItem?.remainingMs).toBe(ROUND3_ITEM_WINDOW_MS);
    h.clock.advance(4_000);
    expect(h.round3().current?.currentItem?.remainingMs).toBe(6_000);

    // A paused window holds still. D-011.
    h.host(GAME_INTENTS.HOST_PAUSE_GAME);
    h.clock.advance(30_000);
    expect(h.round3().current?.currentItem?.remainingMs).toBe(6_000);

    h.host(GAME_INTENTS.HOST_RESUME_GAME);
    h.clock.advance(1_000);
    expect(h.round3().current?.currentItem?.remainingMs).toBe(5_000);
  });

  it('never exposes a queue, a total or an accepted answer', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h);
    h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM);

    const item = h.round3().current?.currentItem;
    const keys = Object.keys(item ?? {}).sort();
    expect(keys).toEqual([
      'body',
      'imageRef',
      'index',
      'itemId',
      'letter',
      'remainingMs',
      'revealedAt',
    ]);
    // The shape is the protection: there is nowhere to put a future item.
    expect(JSON.stringify(h.round3())).not.toContain('gtl-test-002');
  });
});

// ---------------------------------------------------------------------------
// Think Fast
// ---------------------------------------------------------------------------

describe('Think Fast', () => {
  it('orders turns by the previous round standings, best first', () => {
    // §14 / D-031 — the team that won the previous round goes first, and
    // winning a round means the most total BB (§1).
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    // Give Team B a lead before Round 3 begins.
    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_B', delta: 500 });
    h.host(ROUND3_INTENTS.DEV_START_ROUND3);

    expect(h.round3().previousRoundOrder).toEqual([TEAM_B, TEAM_A]);
    beginChallenge(h);
    expect(h.round3().current?.thinkFast?.currentTeamId).toBe(TEAM_B);
  });

  it('advances the turn on a valid answer', () => {
    const h = makeRoom();
    enterRound3(h);
    beginChallenge(h);

    const first = h.round3().current?.thinkFast?.currentTeamId;
    h.host(ROUND3_INTENTS.HOST_THINK_FAST_VALID);
    const second = h.round3().current?.thinkFast?.currentTeamId;

    expect(second).not.toBe(first);
    expect(h.round3().current?.thinkFast?.validAnswerCount).toBe(1);
  });

  it('eliminates a team and skips it thereafter', () => {
    const h = makeRoom({ teamCount: 3 });
    enterRound3(h);
    beginChallenge(h);

    const order = h.round3().current!.thinkFast!.turnOrder;
    const victim = order[0]!;
    h.host(ROUND3_INTENTS.HOST_THINK_FAST_ELIMINATE);

    const tf = h.round3().current!.thinkFast!;
    expect(tf.eliminatedTeamIds).toEqual([victim]);
    expect(tf.remainingTeamIds).toHaveLength(2);
    expect(tf.currentTeamId).not.toBe(victim);

    // And it stays skipped as the turn cycles.
    h.host(ROUND3_INTENTS.HOST_THINK_FAST_VALID);
    h.host(ROUND3_INTENTS.HOST_THINK_FAST_VALID);
    expect(h.round3().current?.thinkFast?.currentTeamId).not.toBe(victim);
  });

  it('refuses to eliminate the last remaining team', () => {
    const h = makeRoom();
    enterRound3(h);
    beginChallenge(h);

    expect(h.host(ROUND3_INTENTS.HOST_THINK_FAST_ELIMINATE).ack.ok).toBe(true);
    const second = h.host(ROUND3_INTENTS.HOST_THINK_FAST_ELIMINATE);
    expect(second.ack.ok).toBe(false);
    expect(h.round3().current?.thinkFast?.remainingTeamIds).toHaveLength(1);
  });

  it('pays the last remaining team 500 BB and one round win', () => {
    const h = makeRoom();
    enterRound3(h);
    beginChallenge(h);

    const order = h.round3().current!.thinkFast!.turnOrder;
    const loser = order[0]!;
    const winner = order[1]!;
    h.host(ROUND3_INTENTS.HOST_THINK_FAST_ELIMINATE);
    expect(h.round3().current?.thinkFast?.remainingTeamIds).toEqual([winner]);

    const before = h.bb(winner);
    h.host(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, { teamId: winner });

    expect(h.bb(winner)).toBe(before + 500);
    expect(h.wins(winner)).toBe(1);
    expect(h.wins(loser)).toBe(0);
  });

  it('refuses to confirm an eliminated team as the winner', () => {
    const h = makeRoom();
    enterRound3(h);
    beginChallenge(h);
    const eliminated = h.round3().current!.thinkFast!.turnOrder[0]!;
    h.host(ROUND3_INTENTS.HOST_THINK_FAST_ELIMINATE);

    const confirmed = h.host(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, {
      teamId: eliminated,
    });
    expect(confirmed.ack.ok).toBe(false);
  });

  it('refuses point awards in an elimination challenge', () => {
    const h = makeRoom();
    enterRound3(h);
    beginChallenge(h);
    const awarded = h.host(ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT, { teamId: TEAM_A });
    expect(awarded.ack.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

describe('Host authority', () => {
  const HOST_ONLY = [
    ROUND3_INTENTS.HOST_PREPARE_ROUND3_CHALLENGE,
    ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM,
    ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT,
    ROUND3_INTENTS.HOST_THINK_FAST_VALID,
    ROUND3_INTENTS.HOST_THINK_FAST_ELIMINATE,
    ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE,
    ROUND3_INTENTS.DEV_START_ROUND3,
  ];

  for (const type of HOST_ONLY) {
    it(`refuses ${type} from a player`, () => {
      const h = makeRoom();
      enterRound3(h);
      beginChallenge(h);

      const outcome = h.player(PHONE_1, type, { teamId: TEAM_A });
      expect(outcome.ack.ok).toBe(false);
      if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('UNAUTHORIZED_ACTOR');
    });
  }

  it('does not let a player award their own team a point', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h);

    h.player(PHONE_1, ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT, { teamId: TEAM_A });
    expect(h.round3().current?.scores['TEAM_A']).toBe(0);
  });

  it('refuses an unknown or non-participating team', () => {
    const h = makeRoom({ teamCount: 2 });
    enterRound3(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h);

    expect(h.host(ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT, { teamId: 'TEAM_C' }).ack.ok).toBe(false);
    expect(h.host(ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT, { teamId: 'TEAM_Z' }).ack.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round winner and the RPS tiebreaker
// ---------------------------------------------------------------------------

describe('Round 3 winner', () => {
  it('declares the highest counter the winner, with no tiebreaker', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    playChallenge(h, TEAM_A);
    playChallenge(h, TEAM_A);
    const last = playChallenge(h, TEAM_B);

    expect(h.wins(TEAM_A)).toBe(3);
    expect(h.wins(TEAM_B)).toBe(1);
    expect(h.round3().winningTeamId).toBe(TEAM_A);
    expect(h.round3().tiebreaker).toBeNull();
    expect(types(last.broadcast)).toContain(ROUND3_EVENTS.ROUND3_WINNER_CONFIRMED);
  });

  it('starts rock-paper-scissors when the counter ties', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    playChallenge(h, TEAM_B);
    playChallenge(h, TEAM_A);
    const last = playChallenge(h, TEAM_B);

    expect(h.wins(TEAM_A)).toBe(2);
    expect(h.wins(TEAM_B)).toBe(2);
    expect(h.round3().winningTeamId).toBeNull();
    expect(types(last.broadcast)).toContain(ROUND3_EVENTS.RPS_STARTED);

    const tb = h.round3().tiebreaker;
    expect(tb?.tiedTeamIds).toEqual([TEAM_A, TEAM_B]);
    expect(tb?.current?.participatingTeamIds).toEqual([TEAM_A, TEAM_B]);
  });
});

describe('the rock-paper-scissors tiebreaker', () => {
  /** Play four challenges so two teams tie 2-2. */
  function tieTwoTeams(h: Harness): void {
    enterRound3(h);
    playChallenge(h, TEAM_A);
    playChallenge(h, TEAM_B);
    playChallenge(h, TEAM_A);
    playChallenge(h, TEAM_B);
  }

  it('hides choices until every tied team has locked one', () => {
    // §18 — and this is the secrecy assertion that matters.
    const h = makeRoom();
    tieTwoTeams(h);

    h.player(PHONE_1, ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'ROCK' });

    const publicView = h.round3();
    expect(publicView.tiebreaker?.current?.submittedTeamIds).toEqual([TEAM_A]);
    // WHO chose, never WHAT.
    expect(publicView.tiebreaker?.current?.choices).toEqual({});
    expect(JSON.stringify(publicView)).not.toContain('ROCK');
  });

  it("shows a team its OWN choice but not an opponent's", () => {
    const h = makeRoom();
    tieTwoTeams(h);
    h.player(PHONE_1, ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'ROCK' });

    const mine = h.room.gameSnapshot(PHONE_1);
    const theirs = h.room.gameSnapshot(PHONE_2);
    expect(mine.game?.round3?.tiebreaker?.yourChoice).toBe('ROCK');
    expect(theirs.game?.round3?.tiebreaker?.yourChoice).toBeNull();
    expect(JSON.stringify(theirs)).not.toContain('ROCK');
  });

  it('resolves Rock over Scissors when both have chosen', () => {
    const h = makeRoom();
    tieTwoTeams(h);
    h.player(PHONE_1, ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'ROCK' });
    h.player(PHONE_2, ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'SCISSORS' });
    h.room.tick();

    const tb = h.round3().tiebreaker;
    expect(tb?.complete).toBe(true);
    expect(tb?.winningTeamId).toBe(TEAM_A);
    expect(h.round3().winningTeamId).toBe(TEAM_A);
    // Revealed now, and only now.
    expect(tb?.history[0]?.choices).toEqual({ TEAM_A: 'ROCK', TEAM_B: 'SCISSORS' });
  });

  it('replays an identical throw', () => {
    const h = makeRoom();
    tieTwoTeams(h);
    h.player(PHONE_1, ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'PAPER' });
    h.player(PHONE_2, ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'PAPER' });
    h.room.tick();

    const tb = h.round3().tiebreaker;
    expect(tb?.complete).toBe(false);
    expect(tb?.history[0]?.outcome).toBe('replay');
    // A fresh attempt is already open, with nothing submitted.
    expect(tb?.current?.attemptNumber).toBe(2);
    expect(tb?.current?.submittedTeamIds).toEqual([]);

    h.player(PHONE_1, ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'SCISSORS' });
    h.player(PHONE_2, ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'PAPER' });
    h.room.tick();
    expect(h.round3().winningTeamId).toBe(TEAM_A);
  });

  it('refuses a second choice from the same team', () => {
    const h = makeRoom();
    tieTwoTeams(h);
    expect(h.player(PHONE_1, ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'ROCK' }).ack.ok).toBe(true);
    const again = h.player(PHONE_1, ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'PAPER' });
    expect(again.ack.ok).toBe(false);
  });

  it('refuses a team that is not in the tiebreaker', () => {
    const h = makeRoom({ teamCount: 3 });
    enterRound3(h);
    playChallenge(h, TEAM_A);
    playChallenge(h, TEAM_B);
    playChallenge(h, TEAM_A);
    playChallenge(h, TEAM_B);
    // A=2, B=2, C=0 — C is not tied for the lead.
    const outcome = h.player(PHONE_3, ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'ROCK' });
    expect(outcome.ack.ok).toBe(false);
  });

  it('refuses a nonsense choice', () => {
    const h = makeRoom();
    tieTwoTeams(h);
    const outcome = h.player(PHONE_1, ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'DYNAMITE' });
    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('INVALID_REQUEST');
  });

});

// ---------------------------------------------------------------------------
// Snapshots and reconnect
// ---------------------------------------------------------------------------

describe('Round 3 snapshots and reconnect', () => {
  it('is null outside Round 3', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    expect(h.room.gameSnapshot(HOST).game?.round3).toBeNull();
  });

  it('restores the round, scores and counters for a reconnecting phone', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h);
    h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM);
    h.host(ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT, { teamId: TEAM_B });

    const credential = h.tokens[0]!;
    h.room.onDisconnect(PHONE_1);
    h.room.onConnect('conn-p1-again');
    const back = h.room.handle(
      'conn-p1-again',
      intent(ROOM_INTENTS.RECONNECT_PLAYER, {
        playerId: h.players[0],
        reconnectToken: credential,
      }),
    );
    expect(back.ack.ok).toBe(true);

    const view = h.room.gameSnapshot('conn-p1-again').game?.round3;
    expect(view?.resolvedCount).toBe(1);
    expect(view?.challengeWins['TEAM_A']).toBe(1);
    expect(view?.current?.scores['TEAM_B']).toBe(1);
    expect(view?.current?.currentItem).not.toBeNull();
    // Nothing duplicated.
    expect(h.bb(TEAM_A)).toBe(1_500);
  });

  it('restores an RPS attempt without leaking the hidden choice', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    playChallenge(h, TEAM_B);
    playChallenge(h, TEAM_A);
    playChallenge(h, TEAM_B);
    h.player(PHONE_1, ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'SCISSORS' });

    const credential = h.tokens[1]!;
    h.room.onDisconnect(PHONE_2);
    h.room.onConnect('conn-p2-again');
    h.room.handle(
      'conn-p2-again',
      intent(ROOM_INTENTS.RECONNECT_PLAYER, {
        playerId: h.players[1],
        reconnectToken: credential,
      }),
    );

    const snap = h.room.gameSnapshot('conn-p2-again');
    expect(snap.game?.round3?.tiebreaker?.submittedTeamIds ?? []).not.toContain('SCISSORS');
    expect(JSON.stringify(snap)).not.toContain('SCISSORS');
    // And Team B can still choose.
    expect(
      h.room.handle(
        'conn-p2-again',
        intent(ROUND3_INTENTS.SUBMIT_RPS_CHOICE, { choice: 'ROCK' }),
      ).ack.ok,
    ).toBe(true);
  });

  it('restores a Host reconnect mid-challenge', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h);
    h.host(ROUND3_INTENTS.HOST_AWARD_ROUND3_POINT, { teamId: TEAM_A });

    h.room.onDisconnect(HOST);
    h.room.onConnect('conn-host-again');
    h.room.handle('conn-host-again', intent(ROOM_INTENTS.RECONNECT_HOST, { hostToken: 'host-token' }));

    const view = h.room.gameSnapshot('conn-host-again').game?.round3;
    expect(view?.resolvedCount).toBe(1);
    expect(view?.current?.scores['TEAM_A']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Market and the shared systems
// ---------------------------------------------------------------------------

describe('Round 3 shared-system integration', () => {
  it('opens the Market at the locked Round 3 prices', () => {
    const h = makeRoom();
    enterRound3(h);
    const opened = h.host(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 3 });
    expect(opened.ack.ok).toBe(true);

    const market = h.room.game.shared.market.view();
    expect(market?.round).toBe(3);
    expect(market?.prices.CLUE).toBe(250);
    expect(market?.prices.SECOND_CHANCE).toBe(300);
  });

  it('doubles a BB-paying challenge but cannot double a counter', () => {
    // D-031 — Double It doubles BB. Guess the Logo pays none, so there is
    // nothing to double, and it is NOT given a counter meaning.
    const h = makeRoom();
    enterRound3(h);
    h.host(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 3 });
    h.player(PHONE_1, SHARED_INTENTS.PURCHASE_MARKET_ITEM, { item: 'DOUBLE_BB' });
    h.host(SHARED_INTENTS.HOST_CLOSE_MARKET);
    const afterMarket = h.bb(TEAM_A);

    beginChallenge(h); // Think Fast — pays 500
    const advantage = h.room.game.shared.advantages.usableFor(TEAM_A)[0]!;
    h.player(PHONE_1, SHARED_INTENTS.USE_ADVANTAGE, { advantageId: advantage.advantageId });
    h.host(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, { teamId: TEAM_A });

    expect(h.bb(TEAM_A)).toBe(afterMarket + 1_000);
    expect(h.round3().challenges[0]?.doubled).toBe(true);
    // Still exactly ONE round win, not two.
    expect(h.wins(TEAM_A)).toBe(1);
  });

  it('reports doubled=false when a doubled team wins a challenge paying no BB', () => {
    const h = makeRoom();
    enterRound3(h);
    h.host(SHARED_INTENTS.HOST_OPEN_MARKET, { round: 3 });
    h.player(PHONE_1, SHARED_INTENTS.PURCHASE_MARKET_ITEM, { item: 'DOUBLE_BB' });
    h.host(SHARED_INTENTS.HOST_CLOSE_MARKET);

    playChallenge(h, TEAM_B); // Think Fast to Team B
    beginChallenge(h); // Guess the Logo — pays nothing

    const advantage = h.room.game.shared.advantages.usableFor(TEAM_A)[0]!;
    h.player(PHONE_1, SHARED_INTENTS.USE_ADVANTAGE, { advantageId: advantage.advantageId });
    const before = h.bb(TEAM_A);
    h.host(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, { teamId: TEAM_A });

    // Nothing doubled, because nothing was paid.
    expect(h.bb(TEAM_A)).toBe(before);
    expect(h.round3().challenges[1]?.doubled).toBe(false);
    expect(h.wins(TEAM_A)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Team counts
// ---------------------------------------------------------------------------

describe('team counts', () => {
  for (const teamCount of [2, 3] as const) {
    it(`runs all four challenges with ${teamCount} teams`, () => {
      const h = makeRoom({ teamCount });
      enterRound3(h);

      const teams = teamCount === 2 ? [TEAM_A, TEAM_B] : [TEAM_A, TEAM_B, TEAM_C];
      expect(h.round3().participatingTeamIds).toEqual(teams);
      expect(h.round3().previousRoundOrder).toHaveLength(teamCount);

      for (const challengeType of ROUND3_CHALLENGE_TYPES) {
        const prepared = beginChallenge(h);
        const payload = prepared.broadcast.at(-1)?.payload as { challengeType: string };
        expect(payload.challengeType).toBe(challengeType);
        expect(
          h.host(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, { teamId: TEAM_A }).ack.ok,
        ).toBe(true);
      }

      expect(h.round3().complete).toBe(true);
      expect(h.wins(TEAM_A)).toBe(4);
      expect(h.round3().winningTeamId).toBe(TEAM_A);
      // Think Fast + Sing a Song only.
      expect(h.bb(TEAM_A)).toBe(2_000);
    });
  }

  it('orders three teams by previous-round BB', () => {
    const h = makeRoom({ teamCount: 3 });
    h.host(GAME_INTENTS.START_GAME);
    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_C', delta: 900 });
    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_B', delta: 400 });
    h.host(ROUND3_INTENTS.DEV_START_ROUND3);

    expect(h.round3().previousRoundOrder).toEqual([TEAM_C, TEAM_B, TEAM_A]);
    beginChallenge(h);
    expect(h.round3().current?.thinkFast?.currentTeamId).toBe(TEAM_C);
  });
});

// ---------------------------------------------------------------------------
// Three-team rock-paper-scissors — §18
//
// A THREE-WAY COUNTER TIE IS UNREACHABLE. With four challenges and three teams
// the only ties possible are two-way (2-2-0) — verified exhaustively over all
// 81 win distributions. So §18's three-team cases can only arise from a
// three-team tiebreaker that some future round creates, and these drive
// `Round3` directly rather than pretending the Room can produce one.
//
// They are still worth covering: §18 locks the behaviour, and a later round
// (or a rule change to the challenge count) would reach it.
// ---------------------------------------------------------------------------

describe('three-team rock-paper-scissors', () => {
  let counter = 0;
  const mintId = (): string => `rps-${++counter}`;

  /** A three-team Round 3, for asserting participation shape. */
  function threeTeamRound(): Round3 {
    const round = new Round3({ clock: new FakeClock(1_000), mintId });
    round.begin({
      teamIds: [TEAM_A, TEAM_B, TEAM_C],
      previousRoundOrder: [TEAM_A, TEAM_B, TEAM_C],
    });
    return round;
  }

  function resolveWith(
    choices: Readonly<Record<string, RpsChoice>>,
  ): { round: Round3; attempt: ReturnType<Round3['resolveRps']> } {
    const round = new Round3({ clock: new FakeClock(1_000), mintId });
    round.begin({
      teamIds: [TEAM_A, TEAM_B, TEAM_C],
      previousRoundOrder: [TEAM_A, TEAM_B, TEAM_C],
    });
    // A, B, A, B leaves A and B tied at 2 with C on 0 — the only tie four
    // challenges can produce.
    for (const [index, winner] of [TEAM_A, TEAM_B, TEAM_A, TEAM_B].entries()) {
      round.markPrepared(asChallengeId(`challenge-${index}`));
      round.prepareConfirmation(winner);
      round.recordChallengeResult({ winningTeamId: winner, awardedBb: 0, doubled: false });
    }
    round.decideWinner();
    for (const [team, choice] of Object.entries(choices)) {
      round.submitRpsChoice(asTeamId(team), choice);
    }
    return { round, attempt: round.resolveRps() };
  }

  it('confirms a three-way counter tie cannot occur with four challenges', () => {
    // Exhaustive over every way four challenges can be split between three
    // teams. Recorded as a test so a future change to the challenge count
    // surfaces the §18 three-team branch becoming reachable.
    const distributions = new Set<string>();
    const teams = ['TEAM_A', 'TEAM_B', 'TEAM_C'];
    const walk = (depth: number, wins: Record<string, number>): void => {
      if (depth === 4) {
        const max = Math.max(...Object.values(wins));
        const leaders = teams.filter((t) => wins[t] === max);
        distributions.add(String(leaders.length));
        return;
      }
      for (const team of teams) {
        walk(depth + 1, { ...wins, [team]: (wins[team] ?? 0) + 1 });
      }
    };
    walk(0, { TEAM_A: 0, TEAM_B: 0, TEAM_C: 0 });

    expect([...distributions].sort()).toEqual(['1', '2']);
    expect(distributions.has('3')).toBe(false);
  });

  it('resolves Paper over Rock between the two tied teams', () => {
    const { round, attempt } = resolveWith({ TEAM_A: 'PAPER', TEAM_B: 'ROCK' });
    expect(attempt.ok).toBe(true);
    expect(round.winningTeamId).toBe(TEAM_A);
  });

  it('resolves Scissors over Paper', () => {
    const { round } = resolveWith({ TEAM_A: 'PAPER', TEAM_B: 'SCISSORS' });
    expect(round.winningTeamId).toBe(TEAM_B);
  });

  it('replays an identical throw rather than picking one', () => {
    const { round, attempt } = resolveWith({ TEAM_A: 'ROCK', TEAM_B: 'ROCK' });
    expect(attempt.ok && attempt.value.outcome).toBe('replay');
    expect(round.winningTeamId).toBeNull();
    // A fresh attempt is open and empty.
    expect(round.tiebreakerView(null)?.current?.submittedTeamIds).toEqual([]);
  });

  it('keeps every choice hidden until the reveal', () => {
    const round = new Round3({ clock: new FakeClock(1_000), mintId });
    round.begin({
      teamIds: [TEAM_A, TEAM_B],
      previousRoundOrder: [TEAM_A, TEAM_B],
    });
    for (const [index, winner] of [TEAM_A, TEAM_B, TEAM_A, TEAM_B].entries()) {
      round.markPrepared(asChallengeId(`challenge-${index}`));
      round.prepareConfirmation(winner);
      round.recordChallengeResult({ winningTeamId: winner, awardedBb: 0, doubled: false });
    }
    round.decideWinner();
    round.submitRpsChoice(TEAM_A, 'SCISSORS');

    // Public view: who, never what.
    const open = round.tiebreakerView(null);
    expect(open?.current?.submittedTeamIds).toEqual([TEAM_A]);
    expect(open?.current?.choices).toEqual({});
    expect(JSON.stringify(open)).not.toContain('SCISSORS');

    // The owner sees its own, and only its own.
    expect(round.tiebreakerView(TEAM_A)?.yourChoice).toBe('SCISSORS');
    expect(round.tiebreakerView(TEAM_B)?.yourChoice).toBeNull();
  });

  it('exposes three-team pair-vs-single through the locked comparison', () => {
    // §18: if the single choice beats the pair, that team wins; if the pair
    // beats the single, the single is eliminated and the rest continue.
    // rpsBeats is the one place that comparison lives.
    expect(rpsBeats('ROCK', 'SCISSORS')).toBe(true);
    expect(rpsBeats('SCISSORS', 'PAPER')).toBe(true);
    expect(rpsBeats('PAPER', 'ROCK')).toBe(true);
    expect(rpsBeats('SCISSORS', 'ROCK')).toBe(false);
    expect(threeTeamRound().participatingTeamIds).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Think Fast uses ONE topic — regression
//
// Found in physical testing: NEXT ITEM was the only way to reveal Think Fast's
// topic, so a Host pressing it twice exhausted the TEST pack and the challenge
// could not be run at all ("the content source has no more items").
//
// §14 describes ONE topic per challenge, with teams alternating answers against
// it. There is no next item, so the topic is revealed when the challenge starts
// and a second reveal is refused.
// ---------------------------------------------------------------------------

describe('Think Fast has one topic for the whole challenge', () => {
  it('reveals its topic automatically when the challenge starts', () => {
    const h = makeRoom();
    enterRound3(h);
    beginChallenge(h);

    // No HOST_NEXT_ROUND3_ITEM was sent, and the topic is already on screen.
    const item = h.round3().current?.currentItem;
    expect(item).not.toBeNull();
    expect(item?.body).toContain('TEST TOPIC');
    expect(item?.index).toBe(1);
  });

  it('refuses a second topic', () => {
    const h = makeRoom();
    enterRound3(h);
    beginChallenge(h);
    const first = h.round3().current?.currentItem?.itemId;

    const second = h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM);
    expect(second.ack.ok).toBe(false);
    if (!second.ack.ok) expect(second.ack.error.code).toBe('ILLEGAL_ACTION');
    // The topic teams are mid-way through answering is untouched.
    expect(h.round3().current?.currentItem?.itemId).toBe(first);
  });

  it('declares itself single-item, unlike the other three', () => {
    const h = makeRoom();
    enterRound3(h);
    beginChallenge(h);
    expect(h.round3().current?.itemMode).toBe('single');

    h.host(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, { teamId: TEAM_A });
    beginChallenge(h);
    expect(h.round3().current?.itemMode).toBe('stream');
  });

  it('leaves a stream challenge free to advance', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h); // Guess the Logo

    h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM);
    h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM);
    const third = h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM);
    expect(third.ack.ok).toBe(true);
    expect(h.round3().current?.currentItem?.index).toBe(3);
  });

  it('has enough TEST content to run a challenge well past its target', () => {
    // The other half of the reported failure: a Host may let a challenge run
    // long (§15-§17), and 8 items was not generous enough to do that twice.
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h);

    for (let i = 0; i < 15; i += 1) {
      const next = h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM);
      expect(next.ack.ok).toBe(true);
    }
    expect(h.round3().current?.currentItem?.index).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// A timed-out item window advances on its own — regression
//
// §15, §16 and §17 all lock the same instruction: "if nobody answers
// correctly, move to the next item." Found in physical testing: a Guess the
// Logo item that ran out with nobody scoring simply never advanced, because
// Round3.itemWindowExpired() existed but nothing ever polled it.
// ---------------------------------------------------------------------------

describe('a timed-out stream item advances on its own', () => {
  it('reveals the next item once the window expires, with no Host action', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A); // Think Fast out of the way
    beginChallenge(h); // Guess the Logo
    h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM);

    const first = h.round3().current?.currentItem;
    expect(first?.index).toBe(1);

    h.clock.advance(ROUND3_ITEM_WINDOW_MS + 1);
    h.room.tick();

    const second = h.round3().current?.currentItem;
    expect(second?.index).toBe(2);
    expect(second?.itemId).not.toBe(first?.itemId);
  });

  it('awards no point for a timeout — a timeout decides nothing (D-022)', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h);
    h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM);

    h.clock.advance(ROUND3_ITEM_WINDOW_MS + 1);
    h.room.tick();

    expect(h.round3().current?.scores['TEAM_A']).toBe(0);
    expect(h.round3().current?.scores['TEAM_B']).toBe(0);
  });

  it('does not advance an elimination challenge (Think Fast has no window)', () => {
    const h = makeRoom();
    enterRound3(h);
    beginChallenge(h); // Think Fast — auto-revealed, no window

    const topic = h.round3().current?.currentItem;
    h.clock.advance(60_000);
    h.room.tick();

    expect(h.round3().current?.currentItem?.itemId).toBe(topic?.itemId);
  });

  it('does not advance while a NEXT ITEM confirms before the window expires', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h);
    h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM);
    const first = h.round3().current?.currentItem;

    h.clock.advance(ROUND3_ITEM_WINDOW_MS - 1_000);
    h.room.tick();

    expect(h.round3().current?.currentItem?.itemId).toBe(first?.itemId);
  });

  it('stops cleanly once the content source is exhausted', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h);

    // Exhaust the Guess the Logo pack (20 TEST items) by expiring windows.
    for (let i = 0; i < 20; i += 1) {
      h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM);
      h.clock.advance(ROUND3_ITEM_WINDOW_MS + 1);
      h.room.tick();
    }

    // The round is still resolvable by the Host even with no item left.
    const confirmed = h.host(ROUND3_INTENTS.HOST_CONFIRM_ROUND3_CHALLENGE, {
      teamId: TEAM_A,
    });
    expect(confirmed.ack.ok).toBe(true);
  });

  it('respects pause: a frozen window does not expire while paused', () => {
    const h = makeRoom();
    enterRound3(h);
    playChallenge(h, TEAM_A);
    beginChallenge(h);
    h.host(ROUND3_INTENTS.HOST_NEXT_ROUND3_ITEM);
    const first = h.round3().current?.currentItem;

    // Paused with time still left on the window — the pause banks elapsed
    // time going forward, so advancing the clock WHILE paused must not count
    // against it (D-011).
    h.host(GAME_INTENTS.HOST_PAUSE_GAME);
    h.clock.advance(ROUND3_ITEM_WINDOW_MS + 5_000);
    h.room.tick();
    expect(h.round3().current?.currentItem?.itemId).toBe(first?.itemId);

    // Resuming picks up with the time the window actually had left, so it
    // takes the REST of the original window to expire, not zero.
    h.host(GAME_INTENTS.HOST_RESUME_GAME);
    h.room.tick();
    expect(h.round3().current?.currentItem?.itemId).toBe(first?.itemId);

    h.clock.advance(ROUND3_ITEM_WINDOW_MS + 1);
    h.room.tick();
    expect(h.round3().current?.currentItem?.itemId).not.toBe(first?.itemId);
  });
});
