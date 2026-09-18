import type { Round4Survey } from '@bb/protocol';

/**
 * Where Sudden Death questions come from. Same shape/reasoning as
 * `Round4ContentSource` (round4-content.ts) — its own interface for the same
 * reason that one is not defined in the protocol package: it is an
 * IMPLEMENTATION seam, not part of the wire protocol.
 */
export interface SuddenDeathContentSource {
  nextQuestion(): Round4Survey | null;
}

/**
 * The Sudden Death content source. Phase 7D-B2.
 *
 * Reuses `Round4Survey`'s shape exactly — a Sudden Death "question" is
 * structurally identical to a Family Feud board, mirroring
 * `Round4ContentSource`'s seam for the same reason: no production content
 * pipeline exists yet (`CONTENT_POLICY.md`), so TEST fixtures fill it during
 * development.
 */
export class PackSuddenDeathContentSource implements SuddenDeathContentSource {
  readonly #questions: Round4Survey[];
  #cursor = 0;

  constructor(questions: readonly Round4Survey[]) {
    this.#questions = [...questions];
  }

  nextQuestion(): Round4Survey | null {
    const question = this.#questions[this.#cursor % this.#questions.length];
    this.#cursor += 1;
    return question ?? null;
  }
}

/**
 * TEST content for Sudden Death. **Never production.**
 *
 * `CONTENT_POLICY.md` — EXAMPLE and TEST can never become PRODUCTION_SEALED.
 * Cycles rather than exhausting — Sudden Death can in principle run for many
 * face-offs (every "no decision" face-off consumes a question without
 * deciding anything), so a small TEST pack must never simply run out.
 */
export const SUDDEN_DEATH_TEST_QUESTIONS: readonly Round4Survey[] = [
  {
    surveyId: 'sd-test-q1',
    prompt: 'TEST SUDDEN DEATH 1: name a test placeholder color',
    questionNumber: 1,
    status: 'TEST',
    source: 'TEST_FIXTURE',
    answers: [
      { answerId: 'sd-test-q1-a1', rank: 1, text: 'TEST RED', value: 40 },
      { answerId: 'sd-test-q1-a2', rank: 2, text: 'TEST BLUE', value: 25 },
      { answerId: 'sd-test-q1-a3', rank: 3, text: 'TEST GREEN', value: 15 },
    ],
  },
  {
    surveyId: 'sd-test-q2',
    prompt: 'TEST SUDDEN DEATH 2: name a test placeholder animal',
    questionNumber: 2,
    status: 'TEST',
    source: 'TEST_FIXTURE',
    answers: [
      { answerId: 'sd-test-q2-a1', rank: 1, text: 'TEST LION', value: 45 },
      { answerId: 'sd-test-q2-a2', rank: 2, text: 'TEST TIGER', value: 30 },
      { answerId: 'sd-test-q2-a3', rank: 3, text: 'TEST BEAR', value: 15 },
    ],
  },
];

export function createTestSuddenDeathContentSource(): SuddenDeathContentSource {
  return new PackSuddenDeathContentSource(SUDDEN_DEATH_TEST_QUESTIONS);
}
