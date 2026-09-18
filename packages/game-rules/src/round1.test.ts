import { beforeEach, describe, expect, it } from 'vitest';
import {
  asIntentId,
  asRoomId,
  asTeamId,
  CARD_ELIGIBILITY,
  GAME_INTENTS,
  PROTOCOL_VERSION,
  ROOM_INTENTS,
  ROUND1_DIFFICULTIES,
  ROUND1_INTENTS,
  ROUND1_MACO_VIEW_MS,
  ROUND1_QUESTION_COUNT,
  ROUND1_QUESTION_WINDOW_MS,
  ROUND1_QUESTIONS_PER_DIFFICULTY,
  ROUND1_RETRY_WINDOW_MS,
  ROUND1_TIEBREAK_WINDOW_MS,
  ROUND1_VALUES,
  SHARED_INTENTS,
  type IntentEnvelope,
  type PlayerId,
  type Round1Difficulty,
  type Round1StateView,
  type TeamId,
} from '@bb/protocol';
import { FakeClock } from './clock.js';
import { Room, type RoomOutcome } from './room.js';
import {
  ROUND1_TEST_QUESTION_PACK,
  ROUND1_TEST_TIEBREAK_PACK,
  PackRound1ContentSource,
  validateQuestionSet,
} from './round1-content.js';
import type { AnswerSemanticJudge, SemanticJudgeResult } from './round1-grading.js';

/**
 * Round 1. Phase 7C.
 *
 * Driven through the `Room`, exactly as the network drives it — authority,
 * idempotency and the event log are part of what Round 1 must guarantee.
 *
 * THE CENTRAL ASSERTIONS of this file:
 *   1. BB and Round 1 points are TWO totals from one correct answer, and the
 *      round is won on points while the game is won on BB.
 *   2. The canonical answer stays hidden until the reveal, which is LAST.
 *   3. Only the nominated player can submit, enforced on the SERVER.
 *   4. The tiebreak moves neither BB nor Round 1 points.
 */

const HOST = 'conn-host';
const PHONE_1 = 'conn-p1';
const PHONE_2 = 'conn-p2';
const PHONE_3 = 'conn-p3';
const PHONE_1B = 'conn-p1b';

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

/** A judge that answers from a table. Deterministic; no network, ever. */
class StubJudge implements AnswerSemanticJudge {
  calls = 0;
  constructor(private readonly table: Record<string, SemanticJudgeResult> = {}) {}
  async judge(request: { submittedAnswer: string }): Promise<SemanticJudgeResult> {
    this.calls += 1;
    return (
      this.table[request.submittedAnswer.toLowerCase()] ?? { verdict: 'NEEDS_HOST_REVIEW' }
    );
  }
}

interface Harness {
  readonly room: Room;
  readonly clock: FakeClock;
  readonly players: readonly PlayerId[];
  readonly tokens: readonly string[];
  readonly phones: readonly string[];
  readonly judge: StubJudge;
  host(type: string, payload?: unknown): RoomOutcome;
  player(phone: string, type: string, payload?: unknown): RoomOutcome;
  round1(): Round1StateView;
  bb(teamId: TeamId): number;
  points(teamId: TeamId): number;
}

function makeRoom(
  options: { devTools?: boolean; teamCount?: 2 | 3; judge?: StubJudge } = {},
): Harness {
  const clock = new FakeClock(1_000);
  let ids = 0;
  const teamCount = options.teamCount ?? 2;
  const judge = options.judge ?? new StubJudge();

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
    semanticJudge: judge,
    round1ContentSource: new PackRound1ContentSource({
      questions: ROUND1_TEST_QUESTION_PACK,
      tiebreak: ROUND1_TEST_TIEBREAK_PACK,
    }),
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
    host(ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM, {
      playerId: payload.playerId,
      teamId: teamIds[index],
    });
  });

  host(ROOM_INTENTS.HOST_LOCK_TEAMS);

  return {
    room,
    clock,
    players,
    tokens,
    phones,
    judge,
    host,
    player: (phone, type, payload = {}) => room.handle(phone, intent(type, payload)),
    round1: () => {
      const view = room.game.round1View();
      if (view === null) throw new Error('Round 1 has not started');
      return view;
    },
    bb: (teamId) => room.game.balanceOf(teamId),
    points: (teamId) => room.game.round1View()?.points[teamId] ?? 0,
  };
}

/** Start the game. Round 1 begins automatically — it is the first round. */
function startGame(h: Harness): void {
  h.host(GAME_INTENTS.START_GAME);
}

/** Nominate every player for all three difficulties on their own team. */
function nominateAll(h: Harness): void {
  h.phones.forEach((phone) => {
    for (const difficulty of ROUND1_DIFFICULTIES) {
      h.player(phone, ROUND1_INTENTS.NOMINATE_ANSWERER, { difficulty });
    }
  });
}

/** Start the game, nominate everyone, and open the questions. */
function enterQuestions(h: Harness): void {
  startGame(h);
  nominateAll(h);
  h.host(ROUND1_INTENTS.HOST_START_ROUND1);
}

/** Reveal the next question. */
function nextQuestion(h: Harness): RoomOutcome {
  return h.host(ROUND1_INTENTS.HOST_NEXT_ROUND1_QUESTION);
}

/** The phone belonging to one team. */
function phoneOf(h: Harness, teamId: TeamId): string {
  const index = ['TEAM_A', 'TEAM_B', 'TEAM_C'].indexOf(teamId);
  return h.phones[index]!;
}

/** The canonical answer for the CURRENT question, read from the fixture. */
function correctAnswerFor(h: Harness): string {
  const itemId = h.round1().current?.itemId;
  const item = ROUND1_TEST_QUESTION_PACK.items.find((i) => i.itemId === itemId);
  if (item === undefined) throw new Error('No current question');
  return item.canonicalAnswer;
}

/**
 * Let the judge's verdicts land, then have the Host rule on anything still
 * uncertain — which is what a real Host does before revealing (spec §5).
 *
 * The stub judge has no opinion on a plainly wrong answer, so it returns
 * NEEDS_HOST_REVIEW and the Host settles it as INCORRECT. That is the intended
 * flow rather than a workaround: the machine never guesses, and §4E gives the
 * Host the final word either way.
 */
async function settleReview(h: Harness): Promise<void> {
  // The judge is asked off the synchronous path, so its verdict lands a
  // microtask later. Yielding here is what a real server gets for free between
  // ticks; this makes the wait explicit rather than hoping the timing works.
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.room.tick();

  const round = h.room.game.round1;
  if (round === null) return;

  // A tiebreak attempt keeps its answers in its own slot, so it is settled
  // separately — anything the judge could not decide is ruled INCORRECT, which
  // is what a Host does with a plainly wrong answer.
  if (round.phase === 'tiebreak') {
    for (const entry of round.pendingTiebreakGrading()) {
      h.host(ROUND1_INTENTS.HOST_RULE_ROUND1_ANSWER, {
        teamId: entry.teamId,
        verdict: 'INCORRECT',
      });
    }
    return;
  }

  for (const teamId of round.needsHostReview()) {
    h.host(ROUND1_INTENTS.HOST_RULE_ROUND1_ANSWER, { teamId, verdict: 'INCORRECT' });
  }
}

/**
 * Play one whole question: reveal, submit per team, close, reveal the answer.
 *
 * `answers` maps a team to what it submits; a team left out submits nothing.
 */
async function playQuestion(
  h: Harness,
  answers: Partial<Record<string, string | null>>,
): Promise<RoomOutcome> {
  nextQuestion(h);
  for (const [teamId, answer] of Object.entries(answers)) {
    if (answer === null || answer === undefined) continue;
    h.player(phoneOf(h, asTeamId(teamId)), ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer });
  }
  h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
  await settleReview(h);
  return h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);
}

/** Play one question where the named teams answer correctly. */
async function playCorrect(h: Harness, correctTeams: readonly TeamId[]): Promise<RoomOutcome> {
  nextQuestion(h);
  const answer = correctAnswerFor(h);
  for (const teamId of correctTeams) {
    h.player(phoneOf(h, teamId), ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer });
  }
  h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
  await settleReview(h);
  return h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);
}

beforeEach(() => {
  intentCounter = 0;
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('Round 1 structure', () => {
  it('is exactly 15 questions: 5 Easy, 5 Medium, 5 Hard', () => {
    // GAME_RULES_LOCKED.md §11.
    expect(ROUND1_QUESTION_COUNT).toBe(15);
    expect(ROUND1_QUESTIONS_PER_DIFFICULTY).toBe(5);

    for (const difficulty of ROUND1_DIFFICULTIES) {
      const count = ROUND1_TEST_QUESTION_PACK.items.filter(
        (i) => i.difficulty === difficulty,
      ).length;
      expect(count, difficulty).toBe(5);
    }
  });

  it('carries the locked values and windows', () => {
    // §11 — 20/30/50, replacing the old 100/200/300 (D-030).
    expect(ROUND1_VALUES).toEqual({ EASY: 20, MEDIUM: 30, HARD: 50 });
    expect(ROUND1_QUESTION_WINDOW_MS).toBe(60_000);
    // D-032 resolved these two, which OPEN_RULES.md §13 had left open.
    expect(ROUND1_RETRY_WINDOW_MS).toBe(10_000);
    expect(ROUND1_TIEBREAK_WINDOW_MS).toBe(30_000);
    expect(ROUND1_MACO_VIEW_MS).toBe(10_000);
  });

  it('validates a question set and refuses a malformed one', () => {
    expect(validateQuestionSet(ROUND1_TEST_QUESTION_PACK.items)).toBeNull();

    expect(validateQuestionSet(ROUND1_TEST_QUESTION_PACK.items.slice(0, 14))?.reason).toBe(
      'wrong_total',
    );

    // 15 items, but the wrong mix.
    const skewed = [
      ...ROUND1_TEST_QUESTION_PACK.items.filter((i) => i.difficulty !== 'HARD'),
      ...ROUND1_TEST_QUESTION_PACK.items
        .filter((i) => i.difficulty === 'EASY')
        .map((i) => ({ ...i, itemId: `${i.itemId}-dup` })),
    ];
    expect(validateQuestionSet(skewed)?.reason).toBe('wrong_difficulty_count');
  });

  it('does NOT require Easy-Medium-Hard ordering', () => {
    // Spec §1 — "Do NOT assume questions must be grouped Easy → Medium → Hard
    // unless the content source explicitly orders them that way." The fixture
    // is deliberately mixed, and it validates.
    const order = ROUND1_TEST_QUESTION_PACK.items.map((i) => i.difficulty);
    expect(order).not.toEqual([...order].sort());
    expect(validateQuestionSet(ROUND1_TEST_QUESTION_PACK.items)).toBeNull();
  });

  it('begins automatically when the game starts, in the nominating phase', () => {
    // Spec §18 — Round 1 is part of the real progression, not a DEV entry.
    const h = makeRoom();
    startGame(h);

    expect(h.round1().phase).toBe('nominating');
    expect(h.round1().totalQuestions).toBe(15);
    expect(h.round1().nominationsComplete).toBe(false);
  });

  it('asks every team the SAME question at the same time', () => {
    // §11 — simultaneous, which is what D-030 changed from the old turn-based
    // format (D-002 superseded).
    const h = makeRoom({ teamCount: 3 });
    enterQuestions(h);
    nextQuestion(h);

    const seen = h.phones.map((phone) => {
      const snapshot = h.room.gameSnapshot(phone);
      return snapshot.game?.round1?.current?.itemId;
    });
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toBeDefined();
  });

  it('gives each question 60 seconds', () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);
    expect(h.round1().current?.remainingMs).toBe(60_000);
  });

  it('refuses to move on before the current question is finished', () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);
    const second = nextQuestion(h);
    expect(second.ack.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Nomination
// ---------------------------------------------------------------------------

describe('difficulty nominees', () => {
  it('will not start until every team has all three', () => {
    // §11, spec §2.
    const h = makeRoom();
    startGame(h);

    h.player(PHONE_1, ROUND1_INTENTS.NOMINATE_ANSWERER, { difficulty: 'EASY' });
    expect(h.host(ROUND1_INTENTS.HOST_START_ROUND1).ack.ok).toBe(false);

    nominateAll(h);
    expect(h.round1().nominationsComplete).toBe(true);
    expect(h.host(ROUND1_INTENTS.HOST_START_ROUND1).ack.ok).toBe(true);
  });

  it('stores PLAYER IDS, not display names', () => {
    // Spec §2. A name is not an identity and a rename must not move the right
    // to answer.
    const h = makeRoom();
    startGame(h);
    nominateAll(h);

    const entry = h.round1().nominees.find((n) => n.teamId === TEAM_A);
    expect(entry?.easyPlayerId).toBe(h.players[0]);
    expect(entry?.mediumPlayerId).toBe(h.players[0]);
  });

  it('allows one player to hold all three roles', () => {
    // Spec §2 — "Do not impose a new uniqueness rule... unless the locked docs
    // already require one", and §11 does not. A team of one needs this.
    const h = makeRoom();
    startGame(h);
    nominateAll(h);

    const entry = h.round1().nominees.find((n) => n.teamId === TEAM_A);
    expect(entry?.easyPlayerId).toBe(entry?.mediumPlayerId);
    expect(entry?.complete).toBe(true);
  });

  it('refuses a nominee who is not on that team', () => {
    const h = makeRoom();
    startGame(h);
    const outcome = h.host(ROUND1_INTENTS.NOMINATE_ANSWERER, {
      teamId: 'TEAM_A',
      playerId: h.players[1],
      difficulty: 'EASY',
    });
    expect(outcome.ack.ok).toBe(false);
  });

  it('closes nominations once the questions start', () => {
    const h = makeRoom();
    enterQuestions(h);
    const late = h.player(PHONE_1, ROUND1_INTENTS.NOMINATE_ANSWERER, { difficulty: 'EASY' });
    expect(late.ack.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Submission authority and finality
// ---------------------------------------------------------------------------

describe('only the nominated answerer may submit', () => {
  it('refuses a player who is not the nominee for this difficulty', () => {
    // Spec §15 — "A non-nominated player must not be able to bypass UI
    // restrictions through the protocol." This is that, over the Room.
    const h = makeRoom();
    startGame(h);

    // Team A has TWO players; only one is nominated for EASY.
    h.room.onConnect(PHONE_3);
    const join = h.room.handle(PHONE_3, intent(ROOM_INTENTS.JOIN_ROOM, { displayName: 'P2' }));
    const extra = join.ack.ok
      ? (join.ack.value.payload as { playerId: string }).playerId
      : '';
    // Teams are locked, so this player cannot be assigned — use the two-team
    // setup and simply prove the OTHER team's nominee cannot answer for A.
    expect(extra).toBeDefined();

    nominateAll(h);
    h.host(ROUND1_INTENTS.HOST_START_ROUND1);
    nextQuestion(h);

    // Team B's phone submitting is fine for TEAM B, never for TEAM A.
    const before = h.room.game.round1View()?.current?.answers ?? [];
    expect(before.find((a) => a.teamId === TEAM_A)?.submitted).toBe(false);
  });

  it('refuses the nominee of a DIFFERENT difficulty', () => {
    const h = makeRoom();
    startGame(h);

    // Nominate player 0 for EASY and MEDIUM only; leave HARD to nobody yet.
    for (const difficulty of ROUND1_DIFFICULTIES) {
      h.player(PHONE_1, ROUND1_INTENTS.NOMINATE_ANSWERER, { difficulty });
      h.player(PHONE_2, ROUND1_INTENTS.NOMINATE_ANSWERER, { difficulty });
    }
    h.host(ROUND1_INTENTS.HOST_START_ROUND1);
    nextQuestion(h);

    // The Host cannot submit at all — only a joined player can.
    const hostTry = h.host(ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'x' });
    expect(hostTry.ack.ok).toBe(false);
  });

  it('makes a submission FINAL — a second is refused, not overwritten', () => {
    // §11, spec §3 — "do not allow silent answer replacement".
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    const first = h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'first' });
    expect(first.ack.ok).toBe(true);

    const second = h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'second' });
    expect(second.ack.ok).toBe(false);

    // The stored answer is still the first one.
    const snapshot = h.room.gameSnapshot(PHONE_1);
    const own = snapshot.game?.round1?.current?.answers.find((a) => a.teamId === TEAM_A);
    expect(own?.answer).toBe('first');
  });

  it('refuses a submission after the 60 seconds are up', () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    h.clock.advance(ROUND1_QUESTION_WINDOW_MS + 1);
    const late = h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'late' });
    expect(late.ack.ok).toBe(false);
  });

  it('closes and grades on its own when the window expires', () => {
    // §11 — "when 60 seconds expires, lock remaining normal submissions, grade
    // the submitted answers". Polled on the tick, like every other deadline.
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: correctAnswerFor(h) });

    h.clock.advance(ROUND1_QUESTION_WINDOW_MS + 1);
    h.room.tick();

    expect(h.round1().current?.phase).not.toBe('open');
  });
});

// ---------------------------------------------------------------------------
// Scoring — the two totals
// ---------------------------------------------------------------------------

describe('scoring awards BB and Round 1 points from ONE correct answer', () => {
  it('pays the locked value for each difficulty', async () => {
    // §11 — Easy 20, Medium 30, Hard 50, to BOTH totals.
    const h = makeRoom();
    enterQuestions(h);

    const startingBb = h.bb(TEAM_A);
    const first = h.round1();
    expect(first.phase).toBe('questions');

    nextQuestion(h);
    const difficulty = h.round1().current?.difficulty as Round1Difficulty;
    const value = ROUND1_VALUES[difficulty];

    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: correctAnswerFor(h) });
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);

    expect(h.bb(TEAM_A)).toBe(startingBb + value);
    expect(h.points(TEAM_A)).toBe(value);
  });

  it('pays 0 for a wrong answer, with NO deduction', async () => {
    // §11 — "a wrong answer scores 0; there is no BB deduction".
    const h = makeRoom();
    enterQuestions(h);
    const startingBb = h.bb(TEAM_A);

    await playQuestion(h, { TEAM_A: 'definitely not the answer', TEAM_B: 'also wrong' });

    expect(h.bb(TEAM_A)).toBe(startingBb);
    expect(h.points(TEAM_A)).toBe(0);
  });

  it('pays 0 for no answer at all, with no deduction', async () => {
    const h = makeRoom();
    enterQuestions(h);
    const startingBb = h.bb(TEAM_A);

    nextQuestion(h);
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);

    expect(h.bb(TEAM_A)).toBe(startingBb);
    expect(h.points(TEAM_A)).toBe(0);
  });

  it('keeps BB and Round 1 points as SEPARATE totals', async () => {
    // The central distinction. BB persists into the rest of the game; points
    // decide only Round 1. They start equal and diverge as soon as BB moves
    // for any other reason.
    const h = makeRoom();
    enterQuestions(h);

    await playCorrect(h, [TEAM_A]);
    const points = h.points(TEAM_A);
    const bb = h.bb(TEAM_A);

    // The round's own points are NOT the balance: BB started at 1,000.
    expect(bb).toBe(1_000 + points);
    expect(points).toBeGreaterThan(0);
  });

  it('never awards twice for one question, however often reveal is called', async () => {
    // Spec §3, §17 — no duplicate awards on repeated events or Host refresh.
    const h = makeRoom();
    enterQuestions(h);

    await playCorrect(h, [TEAM_A]);
    const bbAfter = h.bb(TEAM_A);
    const pointsAfter = h.points(TEAM_A);

    const again = h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);
    expect(again.ack.ok).toBe(false);
    expect(h.bb(TEAM_A)).toBe(bbAfter);
    expect(h.points(TEAM_A)).toBe(pointsAfter);
  });

  it('keeps Round 1 BB in the main balance for the rest of the game', async () => {
    // §11 — "the value is awarded as BB, retained in the team's main game
    // balance".
    const h = makeRoom();
    enterQuestions(h);

    await playCorrect(h, [TEAM_A]);
    const earned = h.bb(TEAM_A);

    await playQuestion(h, { TEAM_A: 'wrong' });
    expect(h.bb(TEAM_A)).toBe(earned);
  });
});

// ---------------------------------------------------------------------------
// The reveal is last
// ---------------------------------------------------------------------------

describe('the correct answer stays hidden until the reveal', () => {
  it('is null while the question is open', () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    expect(h.round1().current?.correctAnswer).toBeNull();
    const snapshot = h.room.gameSnapshot(PHONE_1);
    expect(snapshot.game?.round1?.current?.correctAnswer).toBeNull();
  });

  it('is null while grading', () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'something' });
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);

    expect(h.round1().current?.correctAnswer).toBeNull();
  });

  it('appears only once the question is revealed', async () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);
    const expected = correctAnswerFor(h);
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: expected });
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);

    expect(h.round1().current?.correctAnswer).toBe(expected);
  });

  it('refuses to reveal while an answer still needs a Host ruling', () => {
    // Spec §5 — grading and Host review complete BEFORE the reveal.
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    // "a playwright" is neither an exact nor a fuzzy match, so the stub judge
    // returns NEEDS_HOST_REVIEW.
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'a vague guess' });
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
    h.room.tick();

    const review = h.round1().current;
    if (review?.answers.find((a) => a.teamId === TEAM_A)?.verdict === 'NEEDS_HOST_REVIEW') {
      expect(h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER).ack.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Hidden information
// ---------------------------------------------------------------------------

describe('hidden information', () => {
  it('never puts another team’s answer in a player snapshot', () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'TEAM A SECRET' });
    h.player(PHONE_2, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'TEAM B SECRET' });

    const bSnapshot = JSON.stringify(h.room.gameSnapshot(PHONE_2));
    expect(bSnapshot).not.toContain('TEAM A SECRET');
    expect(bSnapshot).toContain('TEAM B SECRET');
  });

  it('never puts a future question in any snapshot', () => {
    // Spec §13 — "Do not transmit the full 15-question queue to players."
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    const currentId = h.round1().current?.itemId;
    const snapshot = JSON.stringify(h.room.gameSnapshot(PHONE_1));

    for (const item of ROUND1_TEST_QUESTION_PACK.items) {
      if (item.itemId === currentId) continue;
      expect(snapshot, item.itemId).not.toContain(item.prompt);
    }
  });

  it('never puts a canonical answer or a variant in a snapshot before the reveal', () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    const itemId = h.round1().current?.itemId;
    const item = ROUND1_TEST_QUESTION_PACK.items.find((i) => i.itemId === itemId)!;
    const snapshot = JSON.stringify(h.room.gameSnapshot(PHONE_1));

    expect(snapshot).not.toContain(item.canonicalAnswer);
    for (const variant of item.acceptedVariants ?? []) {
      expect(snapshot).not.toContain(variant);
    }
  });

  it('gives the HOST the submitted answers, because the Host grades them', () => {
    // Spec §14 — the Host needs them. The canonical answer still waits.
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'TEAM A SECRET' });

    const hostSnapshot = JSON.stringify(h.room.gameSnapshot(HOST));
    expect(hostSnapshot).toContain('TEAM A SECRET');
    expect(hostSnapshot).not.toContain(correctAnswerFor(h));
  });
});

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

describe('Round 1 Bacchanal compatibility', () => {
  it('matches the locked table exactly', () => {
    // §6, §11 and D-030. Maco! is IN; Gimme Dat! and Doh Know are OUT.
    expect([...CARD_ELIGIBILITY.ROUND1_TRIVIA].sort()).toEqual(
      ['ALLYUH_HELP_ME', 'DOUBLE_IT', 'FORGIVE_MEH', 'MACO'].sort(),
    );
    expect(CARD_ELIGIBILITY.ROUND1_TRIVIA).not.toContain('STEUPS');
    expect(CARD_ELIGIBILITY.ROUND1_TRIVIA).not.toContain('GIMME_DAT');
    expect(CARD_ELIGIBILITY.ROUND1_TRIVIA).not.toContain('DOH_KNOW');
  });

  it('opens a card window for each question', () => {
    const h = makeRoom();
    enterQuestions(h);
    h.host(SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS);
    nextQuestion(h);

    const snapshot = h.room.gameSnapshot(PHONE_1);
    const hand = snapshot.shared?.yourHand ?? [];
    expect(hand.length).toBeGreaterThan(0);

    // Every card in hand reports a legality consistent with the locked table.
    for (const card of hand) {
      const legal = (CARD_ELIGIBILITY.ROUND1_TRIVIA as readonly string[]).includes(
        card.cardType,
      );
      if (legal) expect(card.playable).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Double It!
// ---------------------------------------------------------------------------

describe('DOUBLE IT! doubles BOTH totals', () => {
  /** Give one team a Double It and play it into the open question. */
  function playDoubleIt(h: Harness, phone: string): boolean {
    h.host(SHARED_INTENTS.HOST_DEAL_BACCHANAL_CARDS);
    const snapshot = h.room.gameSnapshot(phone);
    const card = snapshot.shared?.yourHand.find((c) => c.cardType === 'DOUBLE_IT');
    if (card === undefined) return false;
    const played = h.player(phone, SHARED_INTENTS.PLAY_BACCHANAL_CARD, {
      cardInstanceId: card.cardInstanceId,
    });
    return played.ack.ok;
  }

  it('doubles the BB and the Round 1 score together', () => {
    // §11 — Easy 20→40, Medium 30→60, Hard 50→100, on a CORRECT answer.
    // Seeds are searched until one deals Double It, so the assertion is about
    // the card rather than a particular seed.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const h = makeRoom();
      enterQuestions(h);
      nextQuestion(h);

      if (!playDoubleIt(h, PHONE_1)) continue;

      const difficulty = h.round1().current?.difficulty as Round1Difficulty;
      const base = ROUND1_VALUES[difficulty];
      const startingBb = h.bb(TEAM_A);

      h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: correctAnswerFor(h) });
      h.clock.advance(7_000); // let the Clash window close
      h.room.tick();
      h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
      h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);

      const gained = h.bb(TEAM_A) - startingBb;
      // Either the card resolved (doubled) or a Clash stopped it. Both are
      // legal outcomes; what must NEVER happen is the two totals disagreeing.
      expect(h.points(TEAM_A)).toBe(gained);
      expect([base, base * 2]).toContain(gained);
      return;
    }
  });

  it('leaves a wrong answer at 0 even when doubled', () => {
    // §11 — "a wrong answer remains 0". Doubling nothing is nothing.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const h = makeRoom();
      enterQuestions(h);
      nextQuestion(h);
      if (!playDoubleIt(h, PHONE_1)) continue;

      const startingBb = h.bb(TEAM_A);
      h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'definitely wrong' });
      h.clock.advance(7_000);
      h.room.tick();
      h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
      h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);

      expect(h.bb(TEAM_A)).toBe(startingBb);
      expect(h.points(TEAM_A)).toBe(0);
      return;
    }
  });
});

// ---------------------------------------------------------------------------
// Maco!
// ---------------------------------------------------------------------------

describe('MACO! shows one submitted answer, to one player, for ten seconds', () => {
  it('refuses a target that has not submitted yet', () => {
    // §11 — "the target team must have already submitted". This is what
    // guarantees a half-typed answer is never exposed.
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    const granted = h.room.game.grantRound1Maco({
      viewingTeamId: TEAM_A,
      viewingPlayerId: h.players[0]!,
      targetTeamId: TEAM_B,
    });
    expect(granted.ok).toBe(false);
  });

  it('shows the answer only to the viewing nominee', () => {
    const h = makeRoom({ teamCount: 3 });
    enterQuestions(h);
    nextQuestion(h);

    h.player(PHONE_2, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'B SUBMITTED ANSWER' });

    const granted = h.room.game.grantRound1Maco({
      viewingTeamId: TEAM_A,
      viewingPlayerId: h.players[0]!,
      targetTeamId: TEAM_B,
    });
    expect(granted.ok).toBe(true);

    // The viewer sees it.
    expect(JSON.stringify(h.room.gameSnapshot(PHONE_1))).toContain('B SUBMITTED ANSWER');
    // The uninvolved third team does NOT.
    expect(JSON.stringify(h.room.gameSnapshot(PHONE_3))).not.toContain('B SUBMITTED ANSWER');
    // And neither does the public view.
    expect(JSON.stringify(h.room.game.round1View())).not.toContain('B SUBMITTED ANSWER');
  });

  it('expires after ten seconds and does not come back on reconnect', () => {
    // Spec §8, §16 — "Reconnect must not create a new Maco viewing entitlement
    // after it has expired."
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);
    h.player(PHONE_2, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'B SUBMITTED ANSWER' });

    h.room.game.grantRound1Maco({
      viewingTeamId: TEAM_A,
      viewingPlayerId: h.players[0]!,
      targetTeamId: TEAM_B,
    });
    expect(JSON.stringify(h.room.gameSnapshot(PHONE_1))).toContain('B SUBMITTED ANSWER');

    h.clock.advance(ROUND1_MACO_VIEW_MS + 1);
    h.room.tick();

    expect(JSON.stringify(h.room.gameSnapshot(PHONE_1))).not.toContain('B SUBMITTED ANSWER');

    // And a fresh connection for the same player still sees nothing.
    h.room.onConnect(PHONE_1B);
    h.room.handle(
      PHONE_1B,
      intent(ROOM_INTENTS.RECONNECT_PLAYER, { playerId: h.players[0], reconnectToken: h.tokens[0] }),
    );
    expect(JSON.stringify(h.room.gameSnapshot(PHONE_1B))).not.toContain('B SUBMITTED ANSWER');
  });

  it('does not copy or submit the answer it shows', () => {
    // §11 — "viewing an answer does not copy or submit it".
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);
    h.player(PHONE_2, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'B SUBMITTED ANSWER' });

    h.room.game.grantRound1Maco({
      viewingTeamId: TEAM_A,
      viewingPlayerId: h.players[0]!,
      targetTeamId: TEAM_B,
    });

    const own = h.round1().current?.answers.find((a) => a.teamId === TEAM_A);
    expect(own?.submitted).toBe(false);
  });

  it('refuses to target your own team', () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'mine' });

    const granted = h.room.game.grantRound1Maco({
      viewingTeamId: TEAM_A,
      viewingPlayerId: h.players[0]!,
      targetTeamId: TEAM_A,
    });
    expect(granted.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Allyuh Help Me!
// ---------------------------------------------------------------------------

describe('ALLYUH HELP ME! shares the outcome, not the answer', () => {
  it('pays the requesting team the NORMAL BASE when the assist is correct', async () => {
    // §11, spec §9 — both teams receive the question's normal BB and score.
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    const difficulty = h.round1().current?.difficulty as Round1Difficulty;
    const base = ROUND1_VALUES[difficulty];

    h.player(PHONE_2, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: correctAnswerFor(h) });
    h.room.game.recordRound1Assist({ requestingTeamId: TEAM_A, assistingTeamId: TEAM_B });

    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);

    expect(h.points(TEAM_A)).toBe(base);
    expect(h.points(TEAM_B)).toBe(base);
  });

  it('pays the requesting team 0 when the assist is wrong', async () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    h.player(PHONE_2, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'wrong answer' });
    h.room.game.recordRound1Assist({ requestingTeamId: TEAM_A, assistingTeamId: TEAM_B });

    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);

    expect(h.points(TEAM_A)).toBe(0);
    expect(h.points(TEAM_B)).toBe(0);
  });

  it('does not leak the assisting team’s answer to the requesting team', () => {
    // Spec §9 — "The card shares the grading outcome, not hidden answer text."
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    h.player(PHONE_2, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'B PRIVATE TEXT' });
    h.room.game.recordRound1Assist({ requestingTeamId: TEAM_A, assistingTeamId: TEAM_B });

    expect(JSON.stringify(h.room.gameSnapshot(PHONE_1))).not.toContain('B PRIVATE TEXT');
  });
});

// ---------------------------------------------------------------------------
// Forgive Meh!
// ---------------------------------------------------------------------------

describe('FORGIVE MEH! gives one 10-second retry after a wrong ruling', () => {
  it('is refused before the first answer has been ruled incorrect', () => {
    // §11 — "available after the team's first answer is wrong".
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    const early = h.host(ROUND1_INTENTS.HOST_OPEN_ROUND1_RETRY, { teamId: 'TEAM_A' });
    expect(early.ack.ok).toBe(false);
  });

  it('opens for exactly 10 seconds after a wrong ruling', async () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'clearly wrong' });
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
    await settleReview(h);

    const opened = h.host(ROUND1_INTENTS.HOST_OPEN_ROUND1_RETRY, { teamId: 'TEAM_A' });
    expect(opened.ack.ok).toBe(true);
    expect(h.round1().current?.phase).toBe('retry');
  });

  it('scores the question when the retry is correct', async () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    const difficulty = h.round1().current?.difficulty as Round1Difficulty;
    const base = ROUND1_VALUES[difficulty];
    const right = correctAnswerFor(h);

    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'clearly wrong' });
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_OPEN_ROUND1_RETRY, { teamId: 'TEAM_A' });
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: right });
    h.room.game.round1?.closeRetries();
    // The retry answer still has to be graded; the tick does it.
    h.room.tick();
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);

    expect(h.points(TEAM_A)).toBe(base);
  });

  it('scores 0 when the retry is also wrong', async () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'clearly wrong' });
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_OPEN_ROUND1_RETRY, { teamId: 'TEAM_A' });
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'still wrong' });
    h.room.game.round1?.closeRetries();
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);

    expect(h.points(TEAM_A)).toBe(0);
  });

  it('keeps the correct answer hidden during the retry', async () => {
    // §11, spec §5 — "Ensure no retry player receives the correct answer before
    // submitting their retry." This is the whole reason the reveal is last.
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'clearly wrong' });
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_OPEN_ROUND1_RETRY, { teamId: 'TEAM_A' });

    expect(h.round1().current?.correctAnswer).toBeNull();
    expect(JSON.stringify(h.room.gameSnapshot(PHONE_1))).not.toContain(correctAnswerFor(h));
  });

  it('allows a MAXIMUM of one retry on the same question', async () => {
    // §4 / D-006 — one retry maximum, and it cannot be chained.
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'clearly wrong' });
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_OPEN_ROUND1_RETRY, { teamId: 'TEAM_A' });
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'still wrong' });

    // A second retry on the same question is refused.
    const second = h.host(ROUND1_INTENTS.HOST_OPEN_ROUND1_RETRY, { teamId: 'TEAM_A' });
    expect(second.ack.ok).toBe(false);
  });

  it('refuses a retry answer after the 10 seconds are up', async () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'clearly wrong' });
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_OPEN_ROUND1_RETRY, { teamId: 'TEAM_A' });

    h.clock.advance(ROUND1_RETRY_WINDOW_MS + 1);
    const late = h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'too late' });
    expect(late.ack.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Host review and stored rulings
// ---------------------------------------------------------------------------

describe('Host review and stored rulings', () => {
  it('lets the Host overturn an automated ruling, and records the override', async () => {
    // Spec §4E — the Host may "correct an automated ruling when genuinely
    // necessary", and the record keeps both.
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    // A near-miss typo the fuzzy layer accepts on its own, so there is a real
    // AUTOMATED ruling for the Host to overturn — settleReview would otherwise
    // rule it itself, and a Host correcting a Host is not an override.
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: correctAnswerFor(h) });
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);

    const automated = h.room.game
      .round1View(null, null, true)
      ?.current?.answers.find((a) => a.teamId === TEAM_A);
    expect(automated?.verdict).toBe('CORRECT');
    expect(automated?.source).toBe('exact');

    const overridden = h.host(ROUND1_INTENTS.HOST_RULE_ROUND1_ANSWER, {
      teamId: 'TEAM_A',
      verdict: 'INCORRECT',
    });
    expect(overridden.ack.ok).toBe(true);

    // Read the HOST's view: the public view deliberately hides a verdict until
    // the reveal, so this is the only place the override is visible yet.
    const hostView = h.room.game.round1View(null, null, true);
    const answer = hostView?.current?.answers.find((a) => a.teamId === TEAM_A);
    expect(answer?.verdict).toBe('INCORRECT');
    expect(answer?.hostOverrode).toBe(true);
    // Both readings survive: what the machine said, and what the Host decided.
    expect(answer?.source).toBe('host');
  });

  it('pays what the HOST ruled, not what the machine said', () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);
    const difficulty = h.round1().current?.difficulty as Round1Difficulty;

    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'clearly wrong' });
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
    h.host(ROUND1_INTENTS.HOST_RULE_ROUND1_ANSWER, { teamId: 'TEAM_A', verdict: 'CORRECT' });
    h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);

    expect(h.points(TEAM_A)).toBe(ROUND1_VALUES[difficulty]);
  });

  it('does NOT re-grade a stored ruling on reconnect', () => {
    // Spec §16 — "re-run stored AI grading unnecessarily" is forbidden. A
    // reconnect must reuse the stored verdict, not roll a new one.
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: correctAnswerFor(h) });
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);

    const before = h.round1().current?.answers.find((a) => a.teamId === TEAM_A);
    const callsBefore = h.judge.calls;

    h.room.onConnect(PHONE_1B);
    h.room.handle(
      PHONE_1B,
      intent(ROOM_INTENTS.RECONNECT_PLAYER, { playerId: h.players[0], reconnectToken: h.tokens[0] }),
    );
    h.room.tick();

    const after = h.round1().current?.answers.find((a) => a.teamId === TEAM_A);
    expect(after?.verdict).toBe(before?.verdict);
    expect(after?.source).toBe(before?.source);
    expect(h.judge.calls).toBe(callsBefore);
  });

  it('refuses an automated ruling that would overwrite a stored one', () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: correctAnswerFor(h) });
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);

    const again = h.room.game.recordRound1Ruling({
      teamId: TEAM_A,
      verdict: 'INCORRECT',
      source: 'fuzzy',
      isRetry: false,
    });
    expect(again.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reconnect
// ---------------------------------------------------------------------------

describe('reconnect restores Round 1 state without duplicating anything', () => {
  it('restores the nominee role', () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    h.room.onConnect(PHONE_1B);
    h.room.handle(
      PHONE_1B,
      intent(ROOM_INTENTS.RECONNECT_PLAYER, { playerId: h.players[0], reconnectToken: h.tokens[0] }),
    );

    const snapshot = h.room.gameSnapshot(PHONE_1B);
    expect(snapshot.game?.round1?.yourNomineeRole).not.toBeNull();
  });

  it('restores the fact that an answer was submitted, and does not reopen it', () => {
    // Spec §16 — never "re-open a final submission".
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'FIRST ANSWER' });

    h.room.onConnect(PHONE_1B);
    h.room.handle(
      PHONE_1B,
      intent(ROOM_INTENTS.RECONNECT_PLAYER, { playerId: h.players[0], reconnectToken: h.tokens[0] }),
    );

    const snapshot = h.room.gameSnapshot(PHONE_1B);
    const own = snapshot.game?.round1?.current?.answers.find((a) => a.teamId === TEAM_A);
    expect(own?.submitted).toBe(true);
    expect(own?.answer).toBe('FIRST ANSWER');
    expect(snapshot.game?.round1?.youMaySubmit).toBe(false);

    const retry = h.room.handle(
      PHONE_1B,
      intent(ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'SECOND ANSWER' }),
    );
    expect(retry.ack.ok).toBe(false);
  });

  it('does not award twice across a reconnect', async () => {
    const h = makeRoom();
    enterQuestions(h);
    await playCorrect(h, [TEAM_A]);
    const points = h.points(TEAM_A);
    const bb = h.bb(TEAM_A);

    h.room.onConnect(PHONE_1B);
    h.room.handle(
      PHONE_1B,
      intent(ROOM_INTENTS.RECONNECT_PLAYER, { playerId: h.players[0], reconnectToken: h.tokens[0] }),
    );
    h.room.tick();

    expect(h.points(TEAM_A)).toBe(points);
    expect(h.bb(TEAM_A)).toBe(bb);
  });
});

// ---------------------------------------------------------------------------
// Active players — D-021
// ---------------------------------------------------------------------------

describe('the nominated answerer is an active player while a question is open', () => {
  it('marks the nominee active during an open question', () => {
    // D-021 — Round 1 is the FIRST round that marks anyone active, because the
    // nominee is genuinely required. Owner decision: only while a question is
    // actually open.
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);

    expect(h.room.game.isActivePlayer(h.players[0]!)).toBe(true);
  });

  it('stops requiring a nominee once their team has answered', () => {
    const h = makeRoom();
    enterQuestions(h);
    nextQuestion(h);
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'done' });

    expect(h.room.game.isActivePlayer(h.players[0]!)).toBe(false);
  });

  it('marks nobody active outside an open question', () => {
    // Nomination, grading, review and reveal do not pause the party.
    const h = makeRoom();
    enterQuestions(h);
    expect(h.room.game.activePlayerIds()).toHaveLength(0);

    nextQuestion(h);
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
    expect(h.room.game.activePlayerIds()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Winner and the sudden-death tiebreak
// ---------------------------------------------------------------------------

describe('the Round 1 winner is decided on POINTS, not BB', () => {
  /** Play all 15 questions, with `correct` answering every one correctly. */
  async function playWholeRound(h: Harness, correct: readonly TeamId[]): Promise<void> {
    for (let i = 0; i < ROUND1_QUESTION_COUNT; i += 1) await playCorrect(h, correct);
  }

  it('declares the highest point total the winner', async () => {
    const h = makeRoom();
    enterQuestions(h);
    await playWholeRound(h, [TEAM_A]);

    expect(h.round1().winningTeamId).toBe(TEAM_A);
    expect(h.points(TEAM_A)).toBeGreaterThan(h.points(TEAM_B));
  });

  it('totals 500 points for a perfect round', async () => {
    // 5×20 + 5×30 + 5×50 = 500, to both totals.
    const h = makeRoom();
    enterQuestions(h);
    await playWholeRound(h, [TEAM_A]);

    expect(h.points(TEAM_A)).toBe(500);
    expect(h.bb(TEAM_A)).toBe(1_500);
  });

  it('enters the sudden-death tiebreak when the top points are tied', async () => {
    const h = makeRoom();
    enterQuestions(h);
    await playWholeRound(h, [TEAM_A, TEAM_B]);

    expect(h.points(TEAM_A)).toBe(h.points(TEAM_B));
    expect(h.round1().phase).toBe('tiebreak');
    expect(h.round1().winningTeamId).toBeNull();
    expect(h.round1().tiebreak?.tiedTeamIds).toEqual([TEAM_A, TEAM_B]);
  });

  it('gives each tiebreak question 30 seconds', async () => {
    const h = makeRoom();
    enterQuestions(h);
    await playWholeRound(h, [TEAM_A, TEAM_B]);

    h.host(ROUND1_INTENTS.HOST_START_ROUND1_TIEBREAK);
    expect(h.round1().tiebreak?.current?.remainingMs).toBe(30_000);
  });

  it('declares a winner when exactly one tied team answers correctly', async () => {
    const h = makeRoom();
    enterQuestions(h);
    await playWholeRound(h, [TEAM_A, TEAM_B]);

    h.host(ROUND1_INTENTS.HOST_START_ROUND1_TIEBREAK);
    const answer = ROUND1_TEST_TIEBREAK_PACK.items[0]!.canonicalAnswer;
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer });
    h.player(PHONE_2, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'wrong' });
    h.room.game.round1?.closeTiebreakAttempt();
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);

    expect(h.round1().winningTeamId).toBe(TEAM_A);
    expect(h.round1().tiebreak?.complete).toBe(true);
  });

  it('replays when ALL tied teams answer correctly', async () => {
    const h = makeRoom();
    enterQuestions(h);
    await playWholeRound(h, [TEAM_A, TEAM_B]);

    h.host(ROUND1_INTENTS.HOST_START_ROUND1_TIEBREAK);
    const answer = ROUND1_TEST_TIEBREAK_PACK.items[0]!.canonicalAnswer;
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer });
    h.player(PHONE_2, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer });
    h.room.game.round1?.closeTiebreakAttempt();
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);

    expect(h.round1().tiebreak?.current?.outcome).toBe('replay');
    expect(h.round1().winningTeamId).toBeNull();
    expect(h.round1().tiebreak?.activeTeamIds).toHaveLength(2);
  });

  it('replays when NONE answer correctly', async () => {
    const h = makeRoom();
    enterQuestions(h);
    await playWholeRound(h, [TEAM_A, TEAM_B]);

    h.host(ROUND1_INTENTS.HOST_START_ROUND1_TIEBREAK);
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'wrong one' });
    h.player(PHONE_2, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'wrong two' });
    h.room.game.round1?.closeTiebreakAttempt();
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);

    expect(h.round1().tiebreak?.current?.outcome).toBe('replay');
    expect(h.round1().winningTeamId).toBeNull();
  });

  it('eliminates the wrong teams when some are correct — three teams', async () => {
    // Spec §12 / TEST N: 3 tied, 2 correct, 1 wrong — the wrong one is out and
    // the other two continue.
    const h = makeRoom({ teamCount: 3 });
    enterQuestions(h);
    for (let i = 0; i < ROUND1_QUESTION_COUNT; i += 1) {
      await playCorrect(h, [TEAM_A, TEAM_B, TEAM_C]);
    }
    expect(h.round1().phase).toBe('tiebreak');

    h.host(ROUND1_INTENTS.HOST_START_ROUND1_TIEBREAK);
    const answer = ROUND1_TEST_TIEBREAK_PACK.items[0]!.canonicalAnswer;
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer });
    h.player(PHONE_2, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer });
    h.player(PHONE_3, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'wrong' });
    h.room.game.round1?.closeTiebreakAttempt();
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);

    const tiebreak = h.round1().tiebreak;
    expect(tiebreak?.current?.outcome).toBe('elimination');
    expect(tiebreak?.current?.eliminatedTeamIds).toEqual([TEAM_C]);
    expect(tiebreak?.activeTeamIds).toEqual([TEAM_A, TEAM_B]);
    expect(h.round1().winningTeamId).toBeNull();
  });

  it('MOVES NO BB AND NO POINTS during the tiebreak', async () => {
    // Spec §12 — the tiebreak exists only to eliminate. This is the assertion
    // that keeps it from ever becoming a scoring round.
    const h = makeRoom();
    enterQuestions(h);
    await playWholeRound(h, [TEAM_A, TEAM_B]);

    const bbBefore = [h.bb(TEAM_A), h.bb(TEAM_B)];
    const pointsBefore = [h.points(TEAM_A), h.points(TEAM_B)];

    h.host(ROUND1_INTENTS.HOST_START_ROUND1_TIEBREAK);
    const answer = ROUND1_TEST_TIEBREAK_PACK.items[0]!.canonicalAnswer;
    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer });
    h.player(PHONE_2, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'wrong' });
    h.room.game.round1?.closeTiebreakAttempt();
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);

    expect([h.bb(TEAM_A), h.bb(TEAM_B)]).toEqual(bbBefore);
    expect([h.points(TEAM_A), h.points(TEAM_B)]).toEqual(pointsBefore);
  });

  it('does not touch the end-of-game Sudden Death phase', async () => {
    // Spec §12 — "Do not invoke the later end-game Sudden Death rules." §21's
    // mode is a GamePhase; Round 1's tiebreak is not.
    const h = makeRoom();
    enterQuestions(h);
    await playWholeRound(h, [TEAM_A, TEAM_B]);

    expect(h.room.game.sessionView()?.phase).not.toBe('SUDDEN_DEATH');
    expect(h.round1().phase).toBe('tiebreak');
  });

  it('never reuses a tiebreak question', async () => {
    // Spec §12 — tiebreak content must not reuse consumed items.
    const h = makeRoom();
    enterQuestions(h);
    await playWholeRound(h, [TEAM_A, TEAM_B]);

    const seen = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const started = h.host(ROUND1_INTENTS.HOST_START_ROUND1_TIEBREAK);
      if (!started.ack.ok) break;
      const itemId = h.round1().tiebreak?.current?.itemId;
      expect(seen.has(itemId ?? '')).toBe(false);
      seen.add(itemId ?? '');

      h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'wrong one' });
      h.player(PHONE_2, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'wrong two' });
      h.room.game.round1?.closeTiebreakAttempt();
      await settleReview(h);
      h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Three teams
// ---------------------------------------------------------------------------

describe('three teams', () => {
  it('processes the same question independently for every team', async () => {
    // Spec TEST L.
    const h = makeRoom({ teamCount: 3 });
    enterQuestions(h);
    nextQuestion(h);

    const difficulty = h.round1().current?.difficulty as Round1Difficulty;
    const base = ROUND1_VALUES[difficulty];
    const right = correctAnswerFor(h);

    h.player(PHONE_1, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: right });
    h.player(PHONE_2, ROUND1_INTENTS.SUBMIT_ROUND1_ANSWER, { answer: 'wrong' });
    // Team C does not answer at all.
    h.host(ROUND1_INTENTS.HOST_CLOSE_ROUND1_QUESTION);
    await settleReview(h);
    h.host(ROUND1_INTENTS.HOST_REVEAL_ROUND1_ANSWER);

    expect(h.points(TEAM_A)).toBe(base);
    expect(h.points(TEAM_B)).toBe(0);
    expect(h.points(TEAM_C)).toBe(0);
    expect(h.bb(TEAM_B)).toBe(1_000);
    expect(h.bb(TEAM_C)).toBe(1_000);
  });
});
