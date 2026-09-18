import type { Round4ContentPack, Round4Survey } from '@bb/protocol';

/**
 * The Round 4 content source. Phase 7D-A.
 *
 * GAME_RULES_LOCKED.md §19, D-012 — the game supplies the survey board; the
 * Host never types board content during play. Mirrors `Round3ContentSource`'s
 * seam exactly, for the same reason: no production content pipeline exists yet
 * (`CONTENT_POLICY.md`), so the round asks an interface and development fills
 * it with TEST fixtures.
 *
 * A survey is handed out WHOLE, unlike a Round 3 item — the round genuinely
 * needs every ranked answer and value to grade against, not just what is
 * currently on screen. What that means for content safety is on `Round4`, not
 * here: the round is the one place that must never leak a survey's un-revealed
 * answers into a client view, and its tests pin that directly.
 */
export interface Round4ContentSource {
  /** The next unseen survey, or null when the source is exhausted. */
  nextSurvey(): Round4Survey | null;

  /** How many surveys remain. Host-only display. */
  remaining(): number;
}

/** A content source backed by an in-memory pack of surveys. */
export class PackRound4ContentSource implements Round4ContentSource {
  readonly #surveys: Round4Survey[];
  #cursor = 0;

  constructor(pack: Round4ContentPack) {
    this.#surveys = [...pack.surveys];
  }

  nextSurvey(): Round4Survey | null {
    const survey = this.#surveys[this.#cursor];
    if (survey === undefined) return null;
    this.#cursor += 1;
    return survey;
  }

  remaining(): number {
    return Math.max(0, this.#surveys.length - this.#cursor);
  }
}

/**
 * TEST content for Round 4. **Never production.**
 *
 * `CONTENT_POLICY.md` — EXAMPLE and TEST can never become PRODUCTION_SEALED.
 * Every prompt and answer below is obviously fake so nobody mistakes it for a
 * real board, exactly as `ROUND3_TEST_PACKS` and Round 1's TEST questions are.
 *
 * `questionNumber` runs 1-5 so the Q4/Q5 doubling rule can be exercised by
 * data. Five surveys is enough to play a full three-team progression (two for
 * the FIRST matchup, three for the FINAL) with no reuse.
 */
export const ROUND4_TEST_PACK: Round4ContentPack = {
  status: 'TEST',
  source: 'TEST_FIXTURE',
  surveys: [
    {
      surveyId: 'ff-test-q1',
      prompt: 'TEST SURVEY 1: name a test placeholder fruit',
      questionNumber: 1,
      status: 'TEST',
      source: 'TEST_FIXTURE',
      answers: [
        { answerId: 'ff-test-q1-a1', rank: 1, text: 'TEST APPLE', value: 40 },
        { answerId: 'ff-test-q1-a2', rank: 2, text: 'TEST BANANA', value: 25 },
        { answerId: 'ff-test-q1-a3', rank: 3, text: 'TEST ORANGE', value: 15 },
        { answerId: 'ff-test-q1-a4', rank: 4, text: 'TEST GRAPE', value: 12 },
        { answerId: 'ff-test-q1-a5', rank: 5, text: 'TEST MANGO', value: 8 },
      ],
    },
    {
      surveyId: 'ff-test-q2',
      prompt: 'TEST SURVEY 2: name a test placeholder pet',
      questionNumber: 2,
      status: 'TEST',
      source: 'TEST_FIXTURE',
      answers: [
        { answerId: 'ff-test-q2-a1', rank: 1, text: 'TEST DOG', value: 45 },
        { answerId: 'ff-test-q2-a2', rank: 2, text: 'TEST CAT', value: 30 },
        { answerId: 'ff-test-q2-a3', rank: 3, text: 'TEST FISH', value: 15 },
        { answerId: 'ff-test-q2-a4', rank: 4, text: 'TEST BIRD', value: 10 },
      ],
    },
    {
      surveyId: 'ff-test-q3',
      prompt: 'TEST SURVEY 3: name a test placeholder drink',
      questionNumber: 3,
      status: 'TEST',
      source: 'TEST_FIXTURE',
      answers: [
        { answerId: 'ff-test-q3-a1', rank: 1, text: 'TEST WATER', value: 38 },
        { answerId: 'ff-test-q3-a2', rank: 2, text: 'TEST JUICE', value: 27 },
        { answerId: 'ff-test-q3-a3', rank: 3, text: 'TEST SODA', value: 20 },
        { answerId: 'ff-test-q3-a4', rank: 4, text: 'TEST TEA', value: 10 },
        { answerId: 'ff-test-q3-a5', rank: 5, text: 'TEST COFFEE', value: 5 },
      ],
    },
    {
      surveyId: 'ff-test-q4',
      prompt: 'TEST SURVEY 4: name a test placeholder colour',
      questionNumber: 4,
      status: 'TEST',
      source: 'TEST_FIXTURE',
      answers: [
        { answerId: 'ff-test-q4-a1', rank: 1, text: 'TEST RED', value: 42 },
        { answerId: 'ff-test-q4-a2', rank: 2, text: 'TEST BLUE', value: 28 },
        { answerId: 'ff-test-q4-a3', rank: 3, text: 'TEST GREEN', value: 18 },
        { answerId: 'ff-test-q4-a4', rank: 4, text: 'TEST YELLOW', value: 12 },
      ],
    },
    {
      surveyId: 'ff-test-q5',
      prompt: 'TEST SURVEY 5: name a test placeholder sport',
      questionNumber: 5,
      status: 'TEST',
      source: 'TEST_FIXTURE',
      answers: [
        { answerId: 'ff-test-q5-a1', rank: 1, text: 'TEST FOOTBALL', value: 35 },
        { answerId: 'ff-test-q5-a2', rank: 2, text: 'TEST CRICKET', value: 30 },
        { answerId: 'ff-test-q5-a3', rank: 3, text: 'TEST BASKETBALL', value: 20 },
        { answerId: 'ff-test-q5-a4', rank: 4, text: 'TEST TENNIS', value: 15 },
      ],
    },
  ],
};

/** A fresh TEST source. Each game gets its own so cursors never leak between rooms. */
export function createTestRound4ContentSource(): Round4ContentSource {
  return new PackRound4ContentSource(ROUND4_TEST_PACK);
}

/**
 * A source with nothing. The default when no content is configured, so a
 * server without one refuses to reveal a survey rather than inventing one.
 */
export function createEmptyRound4ContentSource(): Round4ContentSource {
  return new PackRound4ContentSource({ status: 'TEST', source: 'EMPTY', surveys: [] });
}
