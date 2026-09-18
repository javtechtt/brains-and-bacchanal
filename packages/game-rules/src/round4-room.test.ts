import { describe, expect, it } from 'vitest';
import {
  asIntentId,
  asRoomId,
  asTeamId,
  CLASH_RESPONSE_WINDOW_MS,
  GAME_INTENTS,
  PROTOCOL_VERSION,
  ROOM_INTENTS,
  ROUND4_INTENTS,
  SHARED_INTENTS,
  type IntentEnvelope,
  type PlayerId,
  type Round4StateView,
  type TeamId,
} from '@bb/protocol';
import { FakeClock } from './clock.js';
import { Room, type RoomOutcome } from './room.js';
import { ROUND4_TEST_PACK } from './round4-content.js';

/**
 * Round 4 — Family Feud. Phase 7D-A2.
 *
 * Driven through `Room`, exactly as the network drives it — authority,
 * idempotency, timers and the shared card/wager systems are all part of what
 * Round 4 must guarantee once wired into the production room, not just what
 * the standalone `Round4` engine (round4.test.ts) guarantees in isolation.
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
  readonly phones: readonly string[];
  host(type: string, payload?: unknown): RoomOutcome;
  player(phone: string, type: string, payload?: unknown): RoomOutcome;
  round4(): Round4StateView;
  bb(teamId: TeamId): number;
}

function makeRoom(options: { teamCount?: 2 | 3 } = {}): Harness {
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
    devTools: true,
  });

  room.attachHost(HOST);

  const phones = [PHONE_1, PHONE_2, PHONE_3].slice(0, teamCount);
  const teamIds = ['TEAM_A', 'TEAM_B', 'TEAM_C'].slice(0, teamCount);
  const players: PlayerId[] = [];

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
    host(ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM, { playerId: payload.playerId, teamId: teamIds[index] });
  });

  host(ROOM_INTENTS.HOST_LOCK_TEAMS);

  return {
    room,
    clock,
    players,
    phones,
    host,
    player: (phone, type, payload = {}) => room.handle(phone, intent(type, payload)),
    round4: () => {
      const view = room.game.round4View();
      if (view === null) throw new Error('Round 4 has not started');
      return view;
    },
    bb: (teamId) => room.game.balanceOf(teamId),
  };
}

/** Start a game and enter Round 4 through the development entry. */
function enterRound4(h: Harness): void {
  h.host(GAME_INTENTS.START_GAME);
  devEnterRound4(h);
}

/** Enter Round 4 through the development entry. Assumes the game already started. */
function devEnterRound4(h: Harness): void {
  const entered = h.host(ROUND4_INTENTS.DEV_START_ROUND4);
  if (!entered.ack.ok) throw new Error(`DEV_START_ROUND4 failed: ${entered.ack.ok}`);
}

/** Host reveals the next survey and opens its face-off. */
function startFaceoff(h: Harness): RoomOutcome {
  return h.host(ROUND4_INTENTS.HOST_START_FACEOFF);
}

/**
 * The #1-ranked board answer's text for the survey currently revealed.
 *
 * The client-safe view never carries unrevealed text (by design — see
 * `Round4BoardAnswerView`), so this reads the raw content pack by
 * `surveyId` instead of the (deliberately blind) room snapshot.
 */
function rank1Answer(h: Harness): string {
  const surveyId = h.round4().current?.board.surveyId;
  const survey = ROUND4_TEST_PACK.surveys.find((s) => s.surveyId === surveyId);
  const top = survey?.answers.find((a) => a.rank === 1);
  if (top === undefined) throw new Error('No rank-1 answer on the current survey.');
  return top.text;
}

/** Drive a face-off to a PLAY decision by `winningTeamId`, with #1-rank answer. */
function winFaceoffAndPlay(h: Harness, buzzTeam: TeamId, phone: string): void {
  h.player(phone, ROUND4_INTENTS.SUBMIT_BUZZ);
  h.player(phone, ROUND4_INTENTS.SUBMIT_FACEOFF_ANSWER, { answer: rank1Answer(h) });
  h.player(phone, ROUND4_INTENTS.CHOOSE_PLAY_OR_PASS, { decision: 'PLAY' });
}

describe('Round 4 — entering production flow', () => {
  it('is reachable through the development entry from a fresh game', () => {
    const h = makeRoom();
    enterRound4(h);
    const view = h.round4();
    expect(view.roundIndex).toBe(4);
    expect(view.matchupTeamIds).toEqual([TEAM_A, TEAM_B]);
  });

  it('freezes the entering BB ranking exactly once at Round 4 entry (D-008)', () => {
    const h = makeRoom({ teamCount: 3 });
    h.host(GAME_INTENTS.START_GAME);
    // Give TEAM_C a head start before Round 4 begins, so entry order isn't
    // alphabetical or team-assignment order by coincidence.
    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: TEAM_C, delta: 5_000 });
    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: TEAM_B, delta: 2_000 });
    devEnterRound4(h);

    const standings = h.round4().enteringStandings;
    expect(standings.find((s) => s.teamId === TEAM_C)?.rank).toBe('FIRST');
    expect(standings.find((s) => s.teamId === TEAM_B)?.rank).toBe('SECOND');
    expect(standings.find((s) => s.teamId === TEAM_A)?.rank).toBe('THIRD');

    // A later BB change must never re-seed the frozen ranking.
    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: TEAM_A, delta: 50_000 });
    const after = h.round4().enteringStandings;
    expect(after.find((s) => s.teamId === TEAM_A)?.rank).toBe('THIRD');
  });

  it('3-team Round 4 starts 2nd-vs-3rd, with entering-1st inactive', () => {
    const h = makeRoom({ teamCount: 3 });
    h.host(GAME_INTENTS.START_GAME);
    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: TEAM_C, delta: 5_000 }); // 1st
    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: TEAM_B, delta: 2_000 }); // 2nd
    devEnterRound4(h); // TEAM_A stays 3rd

    const view = h.round4();
    expect(view.matchupTeamIds).toEqual([TEAM_B, TEAM_A]);
    expect(view.inactiveTeamId).toBe(TEAM_C);
  });
});

describe('Round 4 — face-off through Room', () => {
  it('reveals a survey and opens the buzzer', () => {
    const h = makeRoom();
    enterRound4(h);
    const started = startFaceoff(h);
    expect(started.ack.ok).toBe(true);
    expect(h.round4().current?.progress).toBe('faceoff');
    expect(h.round4().current?.faceoff?.status).toBe('reading');
  });

  it('the first buzz wins; the second, later buzz is rejected', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);

    const first = h.player(PHONE_1, ROUND4_INTENTS.SUBMIT_BUZZ);
    expect(first.ack.ok).toBe(true);
    expect(h.round4().current?.faceoff?.buzzedTeamId).toBe(TEAM_A);

    const second = h.player(PHONE_2, ROUND4_INTENTS.SUBMIT_BUZZ);
    expect(second.ack.ok).toBe(false);
  });

  it('an inactive third team cannot buzz', () => {
    const h = makeRoom({ teamCount: 3 });
    h.host(GAME_INTENTS.START_GAME);
    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: TEAM_C, delta: 5_000 }); // 1st, inactive
    devEnterRound4(h);
    startFaceoff(h);

    const buzzed = h.player(PHONE_3, ROUND4_INTENTS.SUBMIT_BUZZ);
    expect(buzzed.ack.ok).toBe(false);
  });

  it('the #1-ranked survey answer wins the face-off outright', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    h.player(PHONE_1, ROUND4_INTENTS.SUBMIT_BUZZ);
    const answered = h.player(PHONE_1, ROUND4_INTENTS.SUBMIT_FACEOFF_ANSWER, {
      answer: 'TEST APPLE',
    });
    expect(answered.ack.ok).toBe(true);
    expect(h.round4().current?.faceoff?.status).toBe('decided');
    expect(h.round4().current?.faceoff?.winningTeamId).toBe(TEAM_A);
  });

  it('a lower-ranked answer gives the opponent one response, and a higher-ranked reply wins', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    h.player(PHONE_1, ROUND4_INTENTS.SUBMIT_BUZZ);
    // TEST ORANGE is rank 3.
    h.player(PHONE_1, ROUND4_INTENTS.SUBMIT_FACEOFF_ANSWER, { answer: 'TEST ORANGE' });
    expect(h.round4().current?.faceoff?.status).toBe('opponent_chance');
    expect(h.round4().current?.faceoff?.opponentTeamId).toBe(TEAM_B);

    // TEST BANANA is rank 2 — higher-ranked than rank 3.
    const answered = h.player(PHONE_2, ROUND4_INTENTS.SUBMIT_FACEOFF_ANSWER, {
      answer: 'TEST BANANA',
    });
    expect(answered.ack.ok).toBe(true);
    expect(h.round4().current?.faceoff?.winningTeamId).toBe(TEAM_B);
  });

  it('a 3-second face-off answer window times out and hands the opponent one shot', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    h.player(PHONE_1, ROUND4_INTENTS.SUBMIT_BUZZ);

    h.clock.advance(3_001);
    h.room.tick();

    expect(h.round4().current?.faceoff?.status).toBe('opponent_chance');
    expect(h.round4().current?.faceoff?.opponentTeamId).toBe(TEAM_B);
  });

  it('PLAY makes the face-off winner the controlling team', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);
    expect(h.round4().current?.boardPlay?.controllingTeamId).toBe(TEAM_A);
    expect(h.round4().current?.progress).toBe('board_play');
  });

  it('PASS hands the board to the opponent', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    h.player(PHONE_1, ROUND4_INTENTS.SUBMIT_BUZZ);
    h.player(PHONE_1, ROUND4_INTENTS.SUBMIT_FACEOFF_ANSWER, { answer: 'TEST APPLE' });
    const passed = h.player(PHONE_1, ROUND4_INTENTS.CHOOSE_PLAY_OR_PASS, { decision: 'PASS' });
    expect(passed.ack.ok).toBe(true);
    expect(h.round4().current?.boardPlay?.controllingTeamId).toBe(TEAM_B);
  });
});

describe('Round 4 — board play through Room', () => {
  it('only the controlling team may submit a board answer', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1); // TEAM_A controls

    const wrongTeam = h.player(PHONE_2, ROUND4_INTENTS.SUBMIT_BOARD_ANSWER, {
      answer: 'TEST BANANA',
    });
    expect(wrongTeam.ack.ok).toBe(false);

    const rightTeam = h.player(PHONE_1, ROUND4_INTENTS.SUBMIT_BOARD_ANSWER, {
      answer: 'TEST BANANA',
    });
    expect(rightTeam.ack.ok).toBe(true);
  });

  it('a 5-second board turn timeout records a strike', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);

    // Live play: the Host starts the clock explicitly — it does not start
    // itself the instant PLAY/PASS is chosen.
    h.host(ROUND4_INTENTS.HOST_START_BOARD_TURN_TIMER);
    h.clock.advance(5_001);
    h.room.tick();

    expect(h.round4().current?.boardPlay?.strikes).toBe(1);
  });

  it('three strikes triggers a steal, opened automatically for the opposing team', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);

    for (let i = 0; i < 3; i += 1) {
      h.host(ROUND4_INTENTS.HOST_RECORD_STRIKE, { reason: 'wrong' });
    }

    expect(h.round4().current?.progress).toBe('steal');
    expect(h.round4().current?.steal?.stealingTeamId).toBe(TEAM_B);
    expect(h.round4().current?.steal?.defendingTeamId).toBe(TEAM_A);
  });

  it('a non-Host cannot cancel the board turn timer or set strikes', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);
    h.host(ROUND4_INTENTS.HOST_START_BOARD_TURN_TIMER);

    const cancelAttempt = h.player(PHONE_1, ROUND4_INTENTS.HOST_CANCEL_BOARD_TURN_TIMER);
    expect(cancelAttempt.ack.ok).toBe(false);

    const setAttempt = h.player(PHONE_1, ROUND4_INTENTS.HOST_SET_STRIKES, { count: 2 });
    expect(setAttempt.ack.ok).toBe(false);
  });

  it('the Host cancels the board turn timer live, without a strike, then rules the answer', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);
    h.host(ROUND4_INTENTS.HOST_START_BOARD_TURN_TIMER);

    // Someone answered live, before the timer ran out.
    const cancelled = h.host(ROUND4_INTENTS.HOST_CANCEL_BOARD_TURN_TIMER);
    expect(cancelled.ack.ok).toBe(true);
    expect(h.round4().current?.boardPlay?.turnTimer).toBeNull();
    expect(h.round4().current?.boardPlay?.strikes).toBe(0);

    // The timer being cancelled does not prevent the Host from ruling the
    // spoken answer directly, exactly as if the timer were still running.
    const survey = ROUND4_TEST_PACK.surveys[0]!;
    const bananaId = survey.answers.find((a) => a.text === 'TEST BANANA')!.answerId;
    const ruled = h.host(ROUND4_INTENTS.HOST_RULE_BOARD_ANSWER, { answerId: bananaId });
    expect(ruled.ack.ok).toBe(true);
  });

  it('the Host sets the strike count directly, opening the steal once it crosses the ceiling', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);

    const set = h.host(ROUND4_INTENTS.HOST_SET_STRIKES, { count: 3 });
    expect(set.ack.ok).toBe(true);
    expect(h.round4().current?.progress).toBe('steal');
    expect(h.round4().current?.steal?.stealingTeamId).toBe(TEAM_B);
  });

  it('the Host can walk strikes back down, live', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);
    h.host(ROUND4_INTENTS.HOST_RECORD_STRIKE, { reason: 'wrong' });
    h.host(ROUND4_INTENTS.HOST_RECORD_STRIKE, { reason: 'duplicate' });
    expect(h.round4().current?.boardPlay?.strikes).toBe(2);

    const reduced = h.host(ROUND4_INTENTS.HOST_SET_STRIKES, { count: 0 });
    expect(reduced.ack.ok).toBe(true);
    expect(h.round4().current?.boardPlay?.strikes).toBe(0);
  });
});

describe('Round 4 — Host-chosen strike ceiling at entry', () => {
  it('DEV_START_ROUND4 accepts a custom strike ceiling', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    const entered = h.host(ROUND4_INTENTS.DEV_START_ROUND4, { maxStrikes: 5 });
    expect(entered.ack.ok).toBe(true);

    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);
    expect(h.round4().current?.board.maxStrikes).toBe(5);

    for (let i = 0; i < 4; i += 1) {
      h.host(ROUND4_INTENTS.HOST_RECORD_STRIKE, { reason: 'wrong' });
    }
    expect(h.round4().current?.progress).toBe('board_play'); // not yet 5
    h.host(ROUND4_INTENTS.HOST_RECORD_STRIKE, { reason: 'wrong' });
    expect(h.round4().current?.progress).toBe('steal');
  });

  it('DEV_START_ROUND4 with no maxStrikes defaults to 3', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    h.host(ROUND4_INTENTS.DEV_START_ROUND4);

    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);
    expect(h.round4().current?.board.maxStrikes).toBe(3);
  });
});

describe('Round 4 — steal, wager and settlement', () => {
  function atSteal(h: Harness): void {
    enterRound4(h);
    startFaceoff(h);
    // The face-off's #1 answer ('TEST APPLE', 40) reveals and scores on the
    // win itself; 'TEST ORANGE' (15) is banked on top — 55 accumulated.
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);
    h.player(PHONE_1, ROUND4_INTENTS.SUBMIT_BOARD_ANSWER, { answer: 'TEST ORANGE' }); // +15
    for (let i = 0; i < 3; i += 1) {
      h.host(ROUND4_INTENTS.HOST_RECORD_STRIKE, { reason: 'wrong' });
    }
  }

  it('a wager above 50% of current BB is refused', () => {
    const h = makeRoom();
    atSteal(h);
    const bb = h.bb(TEAM_B);
    const wagered = h.player(PHONE_2, ROUND4_INTENTS.SUBMIT_STEAL_WAGER, {
      amount: Math.floor(bb / 2) + 100,
    });
    expect(wagered.ack.ok).toBe(false);
  });

  it('a wager at or below 50% of current BB is accepted', () => {
    const h = makeRoom();
    atSteal(h);
    const bb = h.bb(TEAM_B);
    const wagered = h.player(PHONE_2, ROUND4_INTENTS.SUBMIT_STEAL_WAGER, {
      amount: Math.floor(bb / 2),
    });
    expect(wagered.ack.ok).toBe(true);
  });

  it('a correct steal pays the survey pot AND the wager to the stealing team', () => {
    const h = makeRoom();
    atSteal(h);
    const before = h.bb(TEAM_B);
    h.player(PHONE_2, ROUND4_INTENTS.SUBMIT_STEAL_WAGER, { amount: 100 });
    const resolved = h.player(PHONE_2, ROUND4_INTENTS.SUBMIT_STEAL_ANSWER, {
      answer: 'TEST BANANA', // Rank 2, still unrevealed — a valid steal answer.
    });
    expect(resolved.ack.ok).toBe(true);
    // +55 (survey pot: 40 face-off + 15 board) +100 (wager win).
    expect(h.bb(TEAM_B)).toBe(before + 55 + 100);
    expect(h.round4().current?.progress).toBe('resolved');
  });

  it('a wrong steal costs the wager and pays the pot to the ORIGINAL team', () => {
    const h = makeRoom();
    atSteal(h);
    const stealerBefore = h.bb(TEAM_B);
    const defenderBefore = h.bb(TEAM_A);
    h.player(PHONE_2, ROUND4_INTENTS.SUBMIT_STEAL_WAGER, { amount: 100 });
    const resolved = h.player(PHONE_2, ROUND4_INTENTS.SUBMIT_STEAL_ANSWER, {
      answer: 'completely off board nonsense',
    });
    expect(resolved.ack.ok).toBe(true);
    expect(h.bb(TEAM_B)).toBe(stealerBefore - 100);
    expect(h.bb(TEAM_A)).toBe(defenderBefore + 55);
  });

  it('the Host may rule the steal directly, and settlement is idempotent', () => {
    const h = makeRoom();
    atSteal(h);
    h.player(PHONE_2, ROUND4_INTENTS.SUBMIT_STEAL_WAGER, { amount: 50 });
    const before = h.bb(TEAM_B);

    const ruled = h.host(ROUND4_INTENTS.HOST_RULE_STEAL_ANSWER, { correct: true });
    expect(ruled.ack.ok).toBe(true);
    expect(h.bb(TEAM_B)).toBe(before + 55 + 50);

    // A second, distinct resolution attempt must not double-pay.
    const again = h.host(ROUND4_INTENTS.HOST_RULE_STEAL_ANSWER, { correct: true });
    expect(again.ack.ok).toBe(false);
    expect(h.bb(TEAM_B)).toBe(before + 55 + 50);
  });

  it('a replayed steal-resolution intent (same intentId) does not double-pay', () => {
    const h = makeRoom();
    atSteal(h);
    h.player(PHONE_2, ROUND4_INTENTS.SUBMIT_STEAL_WAGER, { amount: 50 });
    const before = h.bb(TEAM_B);

    const replayed: IntentEnvelope = intent(ROUND4_INTENTS.HOST_RULE_STEAL_ANSWER, {
      correct: true,
    });
    const first = h.room.handle(HOST, replayed);
    expect(first.ack.ok).toBe(true);
    const second = h.room.handle(HOST, replayed);
    expect(second.ack.ok).toBe(false);
    expect(h.bb(TEAM_B)).toBe(before + 55 + 50);
  });

  it('BB never goes below 0 even against a large wager loss', () => {
    const h = makeRoom();
    atSteal(h);
    // Drain TEAM_B close to 0 first via a dev adjustment, then wager the max
    // allowed against the tiny remaining balance.
    const current = h.bb(TEAM_B);
    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: TEAM_B, delta: -(current - 10) });
    h.player(PHONE_2, ROUND4_INTENTS.SUBMIT_STEAL_WAGER, { amount: 5 });
    h.player(PHONE_2, ROUND4_INTENTS.SUBMIT_STEAL_ANSWER, { answer: 'nonsense' });
    expect(h.bb(TEAM_B)).toBeGreaterThanOrEqual(0);
  });

  describe('the Host cannot rule a steal before a wager exists, unless the timer ran out', () => {
    it('refuses a Host ruling before any wager is locked, while the timer still has time left', () => {
      const h = makeRoom();
      atSteal(h);
      h.host(ROUND4_INTENTS.HOST_START_STEAL_TIMER);

      const ruled = h.host(ROUND4_INTENTS.HOST_RULE_STEAL_ANSWER, { correct: true });
      expect(ruled.ack.ok).toBe(false);
      // Nothing moved — the steal is still open, not silently resolved.
      expect(h.round4().current?.steal?.resolved).toBe(false);
    });

    it('refuses a Host ruling before any wager, even before the timer has been started at all', () => {
      const h = makeRoom();
      atSteal(h);
      // The Host never even started the 30s clock — a wager cannot possibly
      // have "timed out" if the window was never opened.
      const ruled = h.host(ROUND4_INTENTS.HOST_RULE_STEAL_ANSWER, { correct: true });
      expect(ruled.ack.ok).toBe(false);
    });

    it('allows a Host ruling once the wager is locked, even with time still on the clock', () => {
      const h = makeRoom();
      atSteal(h);
      h.host(ROUND4_INTENTS.HOST_START_STEAL_TIMER);
      h.player(PHONE_2, ROUND4_INTENTS.SUBMIT_STEAL_WAGER, { amount: 50 });

      const ruled = h.host(ROUND4_INTENTS.HOST_RULE_STEAL_ANSWER, { correct: true });
      expect(ruled.ack.ok).toBe(true);
    });

    it('allows a Host ruling with no wager once the 30-second window has genuinely expired', () => {
      const h = makeRoom();
      atSteal(h);
      h.host(ROUND4_INTENTS.HOST_START_STEAL_TIMER);
      h.clock.advance(30_001);

      const before = h.bb(TEAM_B);
      const ruled = h.host(ROUND4_INTENTS.HOST_RULE_STEAL_ANSWER, { correct: true });
      expect(ruled.ack.ok).toBe(true);
      // Correct, but nothing was ever staked — the team wins only the
      // accumulated board points, exactly like a real Family Feud steal with
      // no side wager: the wager is an ADDITION on top of the board points,
      // never a requirement for the steal itself to pay out.
      expect(h.bb(TEAM_B)).toBe(before + 55);
    });
  });
});

describe('Round 4 — Q4/Q5 doubling applied exactly once', () => {
  /** Play and clear ONE survey outright (no steal), using ITS OWN board's answers. */
  function playAndClearSurvey(h: Harness, surveyIndex: number, winner: TeamId, phone: string): void {
    startFaceoff(h);
    winFaceoffAndPlay(h, winner, phone);
    const survey = ROUND4_TEST_PACK.surveys[surveyIndex]!;
    // Rank 1 already revealed by the face-off win; clear the rest in order.
    const remaining = survey.answers.filter((a) => a.rank !== 1);
    for (const a of remaining) {
      h.player(phone, ROUND4_INTENTS.SUBMIT_BOARD_ANSWER, { answer: a.text });
    }
  }

  it('doubles the Q4 and Q5 pots exactly once, never composed with a shared multiplier', () => {
    const h = makeRoom();
    enterRound4(h);
    // Surveys 1-3 (undoubled) so the content cursor lands on Q4.
    playAndClearSurvey(h, 0, TEAM_A, PHONE_1);
    playAndClearSurvey(h, 1, TEAM_B, PHONE_2);
    playAndClearSurvey(h, 2, TEAM_A, PHONE_1);

    const before = h.bb(TEAM_A);
    const undoubledTotal = ROUND4_TEST_PACK.surveys[3]!.answers.reduce((s, a) => s + a.value, 0);
    playAndClearSurvey(h, 3, TEAM_A, PHONE_1); // Q4 — doubled.

    const after = h.bb(TEAM_A);
    expect(after - before).toBe(undoubledTotal * 2);
  });
});

describe('Round 4 — three-team progression (D-008)', () => {
  function setupThreeTeam(): Harness {
    const h = makeRoom({ teamCount: 3 });
    h.host(GAME_INTENTS.START_GAME);
    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: TEAM_C, delta: 5_000 }); // entering 1st
    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: TEAM_B, delta: 2_000 }); // entering 2nd
    devEnterRound4(h); // entering 2nd (B) vs entering 3rd (A) play first; C inactive
    return h;
  }

  it('plays 2nd-vs-3rd first, with entering-1st sitting out', () => {
    const h = setupThreeTeam();
    expect(h.round4().matchupTeamIds).toEqual([TEAM_B, TEAM_A]);
    expect(h.round4().inactiveTeamId).toBe(TEAM_C);
  });

  it('the inactive third team is rejected from every Round 4 action', () => {
    const h = setupThreeTeam();
    startFaceoff(h);
    expect(h.player(PHONE_3, ROUND4_INTENTS.SUBMIT_BUZZ).ack.ok).toBe(false);
    winFaceoffAndPlay(h, TEAM_B, PHONE_2);
    expect(
      h.player(PHONE_3, ROUND4_INTENTS.SUBMIT_BOARD_ANSWER, { answer: 'TEST APPLE' }).ack.ok,
    ).toBe(false);
  });

  /** Play and clear ONE survey outright (no steal), using ITS OWN board's answers. */
  function playAndClearSurvey(h: Harness, surveyIndex: number, winner: TeamId, phone: string): void {
    startFaceoff(h);
    winFaceoffAndPlay(h, winner, phone);
    const survey = ROUND4_TEST_PACK.surveys[surveyIndex]!;
    const remaining = survey.answers.filter((a) => a.rank !== 1);
    for (const a of remaining) {
      h.player(phone, ROUND4_INTENTS.SUBMIT_BOARD_ANSWER, { answer: a.text });
    }
  }

  it('a tie after the first two surveys advances entering-2nd specifically', () => {
    const h = setupThreeTeam();
    // Survey 1: TEAM_A (entering 3rd) wins.
    playAndClearSurvey(h, 0, TEAM_A, PHONE_1);
    // Survey 2: TEAM_B (entering 2nd) wins.
    playAndClearSurvey(h, 1, TEAM_B, PHONE_2);

    const outcome = h.room.game.decideRound4FirstMatchup();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const payload = outcome.value.payload as { tied: boolean; advancingTeamId: string };
      expect(payload.tied).toBe(true);
      expect(payload.advancingTeamId).toBe(TEAM_B); // entering 2nd, not 3rd.
    }
  });

  it('winner of the first matchup faces entering-1st in the FINAL matchup', () => {
    const h = setupThreeTeam();
    playAndClearSurvey(h, 0, TEAM_B, PHONE_2);
    playAndClearSurvey(h, 1, TEAM_B, PHONE_2);

    h.room.game.decideRound4FirstMatchup();
    const finalStarted = h.room.game.beginRound4FinalMatchup();
    expect(finalStarted.ok).toBe(true);
    expect(h.round4().matchupTeamIds).toEqual([TEAM_B, TEAM_C]);
    expect(h.round4().inactiveTeamId).toBeNull();
  });

  it('the matchup loser earns no further Family Feud BB but keeps what it has', () => {
    const h = setupThreeTeam();
    playAndClearSurvey(h, 0, TEAM_B, PHONE_2);
    playAndClearSurvey(h, 1, TEAM_B, PHONE_2);
    h.room.game.decideRound4FirstMatchup();
    h.room.game.beginRound4FinalMatchup();

    const loserBefore = h.bb(TEAM_A);
    // TEAM_A is no longer in any matchup at all here (FINAL is B vs C), so it
    // has no route to earn or lose Round 4 BB — confirming it keeps exactly
    // what it had.
    expect(h.bb(TEAM_A)).toBe(loserBefore);
  });
});

describe('Round 4 — Bacchanal cards', () => {
  function playCardOfType(
    h: Harness,
    phone: string,
    teamId: TeamId,
    cardType: string,
    targetTeamId?: TeamId,
  ): boolean {
    const snapshot = h.room.gameSnapshot(phone);
    const card = snapshot.shared?.yourHand.find((c) => c.cardType === cardType);
    if (card === undefined) return false;
    const played = h.player(phone, SHARED_INTENTS.PLAY_BACCHANAL_CARD, {
      cardInstanceId: card.cardInstanceId,
      ...(targetTeamId === undefined ? {} : { targetTeamId }),
    });
    if (!played.ack.ok) return false;
    h.clock.advance(CLASH_RESPONSE_WINDOW_MS + 1);
    h.room.tick();
    return true;
  }

  it('an inactive third team cannot play a card into the current matchup', () => {
    let checked = false;
    for (let attempt = 0; attempt < 40 && !checked; attempt += 1) {
      const h = makeRoom({ teamCount: 3 });
      h.host(GAME_INTENTS.START_GAME);
      h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: TEAM_C, delta: 5_000 }); // entering 1st, inactive
      devEnterRound4(h);
      h.host(SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS);
      startFaceoff(h);

      const snapshot = h.room.gameSnapshot(PHONE_3);
      const anyCard = snapshot.shared?.yourHand[0];
      if (anyCard === undefined) continue;
      checked = true;

      const played = h.player(PHONE_3, SHARED_INTENTS.PLAY_BACCHANAL_CARD, {
        cardInstanceId: anyCard.cardInstanceId,
      });
      expect(played.ack.ok).toBe(false);
    }
    expect(checked).toBe(true);
  });

  it('Steups! removes a valid opposing board answer and its already-scored points', () => {
    let checked = false;
    for (let attempt = 0; attempt < 60 && !checked; attempt += 1) {
      const h = makeRoom();
      enterRound4(h);
      h.host(SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS);
      startFaceoff(h);
      winFaceoffAndPlay(h, TEAM_A, PHONE_1); // TEAM_A controls

      const before = h.round4().current?.board.accumulatedPoints ?? 0;
      h.player(PHONE_1, ROUND4_INTENTS.SUBMIT_BOARD_ANSWER, { answer: 'TEST BANANA' }); // +25
      const afterReveal = h.round4().current?.board.accumulatedPoints ?? 0;
      if (afterReveal !== before + 25) continue;

      const played = playCardOfType(h, PHONE_2, TEAM_B, 'STEUPS', TEAM_A);
      if (!played) continue;
      checked = true;

      const applied = h.room.game.applyRound4Steups({
        answerId: 'ff-test-q1-a2',
        defendingTeamId: TEAM_A,
      });
      expect(applied.ok).toBe(true);
      expect(h.round4().current?.board.accumulatedPoints).toBe(before);
      const bananaEntry = h.round4().current?.board.answers.find(
        (a) => a.answerId === 'ff-test-q1-a2',
      );
      expect(bananaEntry?.revealed).toBe(false);
      expect(bananaEntry?.steupsRemovedForTeamId).toBe(TEAM_A);
    }
    expect(checked).toBe(true);
  });

  it('FORGIVE MEH! grants a retry before a strike is committed; a second failure still strikes', () => {
    let checked = false;
    for (let attempt = 0; attempt < 60 && !checked; attempt += 1) {
      const h = makeRoom();
      enterRound4(h);
      h.host(SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS);
      startFaceoff(h);
      winFaceoffAndPlay(h, TEAM_A, PHONE_1); // TEAM_A controls

      const played = playCardOfType(h, PHONE_1, TEAM_A, 'FORGIVE_MEH');
      if (!played) continue;
      checked = true;

      expect(h.room.game.round4HasForgiveMehRetry(TEAM_A)).toBe(true);

      // The Host attempts a strike for a wrong answer — refused because the
      // retry has not been attempted yet.
      const blocked = h.host(ROUND4_INTENTS.HOST_RECORD_STRIKE, { reason: 'wrong' });
      expect(blocked.ack.ok).toBe(false);
      expect(h.round4().current?.boardPlay?.strikes).toBe(0);

      // The retry itself also fails — exactly one strike, never two.
      const afterRetry = h.host(ROUND4_INTENTS.HOST_RECORD_STRIKE, {
        reason: 'wrong',
        afterRetry: true,
      });
      expect(afterRetry.ack.ok).toBe(true);
      expect(h.round4().current?.boardPlay?.strikes).toBe(1);
    }
    expect(checked).toBe(true);
  });
});

describe('Round 4 — pause, reconnect and disconnect', () => {
  it('a disconnect during a face-off pauses the game and its timer', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    h.player(PHONE_1, ROUND4_INTENTS.SUBMIT_BUZZ);

    h.room.onDisconnect(PHONE_1);
    expect(h.room.game.paused).toBe(true);

    // The 3-second window does not tick down while paused.
    h.clock.advance(10_000);
    h.room.tick();
    expect(h.round4().current?.faceoff?.status).toBe('buzzed');
  });

  it('only the Host resumes, and remaining time is preserved', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    h.player(PHONE_1, ROUND4_INTENTS.SUBMIT_BUZZ);
    h.room.onDisconnect(PHONE_1);

    // Paused with the full 3-second window still banked (no time elapsed
    // pre-pause), for an arbitrarily long stretch.
    h.clock.advance(50_000);
    h.host(GAME_INTENTS.HOST_RESUME_GAME);
    expect(h.room.game.paused).toBe(false);

    // The full 3 seconds is still available after resume.
    h.clock.advance(2_999);
    h.room.tick();
    expect(h.round4().current?.faceoff?.status).toBe('buzzed');
    h.clock.advance(2);
    h.room.tick();
    expect(h.round4().current?.faceoff?.status).toBe('opponent_chance');
  });

  it('reconnect restores state without duplicating the buzz race', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    h.player(PHONE_1, ROUND4_INTENTS.SUBMIT_BUZZ);
    h.room.onDisconnect(PHONE_1);
    h.host(GAME_INTENTS.HOST_RESUME_GAME);

    // A reconnecting phone (fresh connection id, same player) must not be able
    // to buzz again for the same face-off.
    h.room.onConnect('conn-p1-reconnected');
    const replay = h.room.handle(
      'conn-p1-reconnected',
      intent(ROUND4_INTENTS.SUBMIT_BUZZ, {}),
    );
    // Not authorised (no team/session bound to this connection yet) — the
    // important property is that the ORIGINAL buzz result is untouched.
    expect(replay.ack.ok).toBe(false);
    expect(h.round4().current?.faceoff?.buzzedTeamId).toBe(TEAM_A);
  });
});

describe('Round 4 — precise timer views through Room (7D-B1 / live-play Host-started timers)', () => {
  it('the board-play turn timer is null until the Host starts it, through Room', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);

    expect(h.round4().current?.boardPlay?.turnTimer).toBeNull();

    const started = h.host(ROUND4_INTENTS.HOST_START_BOARD_TURN_TIMER);
    expect(started.ack.ok).toBe(true);

    const timer = h.round4().current?.boardPlay?.turnTimer;
    expect(timer).not.toBeNull();
    expect(timer?.durationMs).toBe(5_000);
    expect(timer?.remainingMs).toBe(5_000);
    expect(timer?.expired).toBe(false);
  });

  it('a non-Host cannot start the board turn timer', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);

    const attempt = h.player(PHONE_1, ROUND4_INTENTS.HOST_START_BOARD_TURN_TIMER);
    expect(attempt.ack.ok).toBe(false);
    expect(h.round4().current?.boardPlay?.turnTimer).toBeNull();
  });

  it('the steal confer timer is null until the Host starts it, through Room', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);
    for (let i = 0; i < 3; i += 1) {
      h.host(ROUND4_INTENTS.HOST_RECORD_STRIKE, { reason: 'wrong' });
    }

    expect(h.round4().current?.steal?.conferTimer).toBeNull();

    const started = h.host(ROUND4_INTENTS.HOST_START_STEAL_TIMER);
    expect(started.ack.ok).toBe(true);

    const timer = h.round4().current?.steal?.conferTimer;
    expect(timer).not.toBeNull();
    expect(timer?.durationMs).toBe(30_000);
    expect(timer?.remainingMs).toBe(30_000);
  });

  it('a snapshot re-request mid-turn does not restart the board timer', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);
    h.host(ROUND4_INTENTS.HOST_START_BOARD_TURN_TIMER);

    h.clock.advance(2_000);
    const first = h.round4().current?.boardPlay?.turnTimer?.remainingMs;
    const second = h.round4().current?.boardPlay?.turnTimer?.remainingMs;
    expect(first).toBe(3_000);
    expect(second).toBe(3_000);
  });

  it('pause/resume during a board turn preserves the timer exactly, on reconnect', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);
    h.host(ROUND4_INTENTS.HOST_START_BOARD_TURN_TIMER);

    h.clock.advance(1_000);
    h.room.onDisconnect(PHONE_1);
    expect(h.room.game.paused).toBe(true);
    const paused = h.round4().current?.boardPlay?.turnTimer;
    expect(paused?.paused).toBe(true);
    expect(paused?.remainingMs).toBe(4_000);

    h.clock.advance(30_000); // long disconnect
    h.host(GAME_INTENTS.HOST_RESUME_GAME);
    const resumed = h.round4().current?.boardPlay?.turnTimer;
    expect(resumed?.paused).toBe(false);
    expect(resumed?.remainingMs).toBe(4_000);
  });

  it('the player-client (team-scoped) snapshot shape carries both the board and steal timers once started', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);
    h.host(ROUND4_INTENTS.HOST_START_BOARD_TURN_TIMER);

    // The Round4 view is unscoped (identical for Host and every player) —
    // GameSessionView.round4's own doc comment. Reading it via the room's
    // generic view is exactly what a player's snapshot request returns.
    const boardTimer = h.round4().current?.boardPlay?.turnTimer;
    expect(boardTimer).not.toBeNull();

    for (let i = 0; i < 3; i += 1) {
      h.host(ROUND4_INTENTS.HOST_RECORD_STRIKE, { reason: 'wrong' });
    }
    h.host(ROUND4_INTENTS.HOST_START_STEAL_TIMER);
    const stealTimer = h.round4().current?.steal?.conferTimer;
    expect(stealTimer).not.toBeNull();
  });

  it('no hidden board data is introduced by the timer views', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);

    const board = h.round4().current?.board;
    for (const answer of board?.answers ?? []) {
      if (!answer.revealed) {
        expect(answer.text).toBeNull();
        expect(answer.value).toBeNull();
      }
    }
  });
});

describe('Round 4 — snapshot hides the board', () => {
  it('never exposes unrevealed board text or values to a PLAYER', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);

    const playerJson = JSON.stringify(h.room.gameSnapshot(PHONE_1));

    for (const secret of ['TEST BANANA', 'TEST ORANGE', 'TEST GRAPE', 'TEST MANGO']) {
      expect(playerJson).not.toContain(secret);
    }
  });

  it('DOES expose unrevealed board text and value to the HOST — live play needs it (7D-B2)', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);

    const hostJson = JSON.stringify(h.room.gameSnapshot(HOST));

    // The Host runs the game live: reads the question aloud, matches a
    // spoken answer to a board slot. This is the ONE deliberate exception to
    // "the shape is the protection" (round4.ts's own header comment) —
    // scoped exactly like Round 1's canonical answer, and NEVER reaching a
    // broadcast event (see the "broadcast events never leak" test below).
    for (const secret of ['TEST BANANA', 'TEST ORANGE', 'TEST GRAPE', 'TEST MANGO']) {
      expect(hostJson).toContain(secret);
    }
  });

  it('a broadcast EVENT (not a snapshot request) never carries unrevealed board text, even to the Host', () => {
    const h = makeRoom();
    enterRound4(h);
    const started = startFaceoff(h);

    // `started` is the RoomOutcome from the very intent that revealed the
    // survey — its `broadcast` events are what every connection (Host
    // included) actually receives in real time. `forHost` must never reach
    // this path, only the per-connection REQUEST_GAME_SNAPSHOT response.
    const broadcastJson = JSON.stringify(started.broadcast);
    for (const secret of ['TEST BANANA', 'TEST ORANGE', 'TEST GRAPE', 'TEST MANGO']) {
      expect(broadcastJson).not.toContain(secret);
    }
  });

  it('reveals board text only after it is actually revealed', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    winFaceoffAndPlay(h, TEAM_A, PHONE_1);
    h.player(PHONE_1, ROUND4_INTENTS.SUBMIT_BOARD_ANSWER, { answer: 'TEST BANANA' });

    const json = JSON.stringify(h.room.gameSnapshot(PHONE_2));
    expect(json).toContain('TEST BANANA');
    expect(json).not.toContain('TEST ORANGE');
  });

  it('never exposes a future survey before it is revealed', () => {
    const h = makeRoom();
    enterRound4(h);
    startFaceoff(h);
    const json = JSON.stringify(h.room.gameSnapshot(PHONE_1));
    expect(json).not.toContain('ff-test-q2');
    expect(json).not.toContain('TEST DOG');
  });
});
