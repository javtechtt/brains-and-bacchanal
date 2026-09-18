import {
  ROUND1_DIFFICULTIES,
  ROUND1_QUESTIONS_PER_DIFFICULTY,
  type Round1ContentItem,
  type Round1ContentPack,
  type Round1Difficulty,
} from '@bb/protocol';

/**
 * The Round 1 content source. Phase 7C spec §13.
 *
 * Same seam as `Round3ContentSource`, and for the same reason: GAME_RULES_LOCKED
 * §13 says the GAME supplies content for Rounds 1, 3 and 4, and the Host does
 * not type it during play. A Host-typed question would quietly become the
 * production pipeline.
 *
 * ================== WHAT IS DIFFERENT FROM ROUND 3 ==================
 * A Round 3 item carries no accepted answer, because the Host judges every
 * Round 3 answer subjectively. A Round 1 item MUST carry one — the whole round
 * is machine-graded free text (spec §4).
 *
 * So `Round1ContentItem` holds the canonical answer and its variants, and that
 * makes this type SERVER-ONLY. It never crosses the wire; `Round1QuestionView`
 * is what clients receive, and it has no field for either.
 * ====================================================================
 */
export interface Round1ContentSource {
  /**
   * The ordered 15-question set for one game. Spec §1.
   *
   * THE SOURCE DECIDES THE ORDER. Spec §1 is explicit: "Do NOT assume questions
   * must be grouped Easy → Medium → Hard unless the content source explicitly
   * orders them that way." So this returns a sequence and the round asks no
   * questions about its shape beyond validating the counts.
   */
  questionSet(): readonly Round1ContentItem[];

  /**
   * One more question for the sudden-death tiebreak, or null when exhausted.
   *
   * Spec §12 — tiebreak content comes through the same abstraction and must not
   * reuse consumed items. A separate cursor enforces that structurally.
   */
  nextTiebreakItem(): Round1ContentItem | null;
}

/** Why a question set was refused. */
export interface Round1ContentProblem {
  readonly reason: string;
  readonly difficulty?: Round1Difficulty;
  readonly found?: number;
  readonly expected?: number;
}

/**
 * Whether a question set satisfies the locked format. §11, spec §1.
 *
 * Checked rather than assumed, because a malformed pack is a content bug that
 * would otherwise surface mid-game as a missing question. Validating the counts
 * is NOT the same as ordering them — the order stays entirely the source's.
 */
export function validateQuestionSet(
  items: readonly Round1ContentItem[],
): Round1ContentProblem | null {
  const total = ROUND1_DIFFICULTIES.length * ROUND1_QUESTIONS_PER_DIFFICULTY;
  if (items.length !== total) {
    return { reason: 'wrong_total', found: items.length, expected: total };
  }

  for (const difficulty of ROUND1_DIFFICULTIES) {
    const count = items.filter((i) => i.difficulty === difficulty).length;
    if (count !== ROUND1_QUESTIONS_PER_DIFFICULTY) {
      return {
        reason: 'wrong_difficulty_count',
        difficulty,
        found: count,
        expected: ROUND1_QUESTIONS_PER_DIFFICULTY,
      };
    }
  }

  const ids = new Set(items.map((i) => i.itemId));
  if (ids.size !== items.length) return { reason: 'duplicate_item_ids' };

  const unanswerable = items.find((i) => i.canonicalAnswer.trim().length === 0);
  if (unanswerable !== undefined) {
    return { reason: 'missing_canonical_answer', found: 0, expected: 1 };
  }

  return null;
}

/**
 * A content source backed by in-memory packs.
 *
 * Equally usable by a future loader that reads approved production content and
 * hands it over — the packs are data, and this class does not care where they
 * came from or what their lifecycle state is. Enforcing that a production server
 * refuses TEST content belongs in the loader, not here.
 */
export class PackRound1ContentSource implements Round1ContentSource {
  readonly #questions: readonly Round1ContentItem[];
  readonly #tiebreak: readonly Round1ContentItem[];
  #tiebreakCursor = 0;

  constructor(input: {
    readonly questions: Round1ContentPack;
    readonly tiebreak: Round1ContentPack;
  }) {
    this.#questions = [...input.questions.items];
    this.#tiebreak = [...input.tiebreak.items];
  }

  questionSet(): readonly Round1ContentItem[] {
    return this.#questions;
  }

  nextTiebreakItem(): Round1ContentItem | null {
    // Spec §12 — never reuse a consumed item. The cursor only moves forward.
    const item = this.#tiebreak[this.#tiebreakCursor];
    if (item === undefined) return null;
    this.#tiebreakCursor += 1;
    return item;
  }
}

/**
 * TEST content for Round 1. **Never production.**
 *
 * CONTENT_POLICY.md — EXAMPLE and TEST can never become PRODUCTION_SEALED.
 *
 * ================== WHY THESE LOOK SO FAKE ==================
 * Every prompt says TEST and every answer is a placeholder word. That is
 * deliberate and it is a safety property, not laziness: the project owner plays
 * this game, and a fixture that read like real trivia would invite someone to
 * promote it to production — which the content policy forbids absolutely.
 *
 * They are still good enough to exercise grading: the answers have real
 * spellings a Host can misspell on purpose during physical testing (TEST D),
 * and one carries an accepted variant so the variant path is reachable.
 * ============================================================
 */
export const ROUND1_TEST_QUESTION_PACK: Round1ContentPack = {
  packId: 'r1-test-questions',
  status: 'TEST',
  source: 'TEST_FIXTURE',
  // Deliberately NOT grouped Easy→Medium→Hard, so the engine is exercised
  // against a mixed order from the very first run (spec §1).
  items: [
    {
      itemId: 'r1-test-e1',
      difficulty: 'EASY',
      prompt: 'TEST EASY 1: name the test placeholder colour.',
      canonicalAnswer: 'Placeholder',
      status: 'TEST',
    },
    {
      itemId: 'r1-test-m1',
      difficulty: 'MEDIUM',
      prompt: 'TEST MEDIUM 1: name the test placeholder playwright.',
      canonicalAnswer: 'Shakespeare',
      acceptedVariants: ['William Shakespeare'],
      status: 'TEST',
    },
    {
      itemId: 'r1-test-h1',
      difficulty: 'HARD',
      prompt: 'TEST HARD 1: name the test placeholder conflict.',
      canonicalAnswer: 'World War II',
      acceptedVariants: ['WWII', 'Second World War'],
      status: 'TEST',
    },
    {
      itemId: 'r1-test-e2',
      difficulty: 'EASY',
      prompt: 'TEST EASY 2: name the test placeholder shape.',
      canonicalAnswer: 'Triangle',
      status: 'TEST',
    },
    {
      itemId: 'r1-test-m2',
      difficulty: 'MEDIUM',
      prompt: 'TEST MEDIUM 2: name the test placeholder country.',
      canonicalAnswer: 'Testland',
      status: 'TEST',
    },
    {
      itemId: 'r1-test-h2',
      difficulty: 'HARD',
      prompt: 'TEST HARD 2: name the test placeholder element.',
      canonicalAnswer: 'Placeholderium',
      status: 'TEST',
    },
    {
      itemId: 'r1-test-e3',
      difficulty: 'EASY',
      prompt: 'TEST EASY 3: name the test placeholder animal.',
      canonicalAnswer: 'Testudo',
      status: 'TEST',
    },
    {
      itemId: 'r1-test-m3',
      difficulty: 'MEDIUM',
      prompt: 'TEST MEDIUM 3: name the test placeholder river.',
      canonicalAnswer: 'Testahatchee',
      status: 'TEST',
    },
    {
      itemId: 'r1-test-h3',
      difficulty: 'HARD',
      prompt: 'TEST HARD 3: name the test placeholder mountain.',
      canonicalAnswer: 'Mount Placeholder',
      status: 'TEST',
    },
    {
      itemId: 'r1-test-e4',
      difficulty: 'EASY',
      prompt: 'TEST EASY 4: name the test placeholder fruit.',
      canonicalAnswer: 'Testberry',
      status: 'TEST',
    },
    {
      itemId: 'r1-test-m4',
      difficulty: 'MEDIUM',
      prompt: 'TEST MEDIUM 4: name the test placeholder instrument.',
      canonicalAnswer: 'Testophone',
      status: 'TEST',
    },
    {
      itemId: 'r1-test-h4',
      difficulty: 'HARD',
      prompt: 'TEST HARD 4: name the test placeholder constellation.',
      canonicalAnswer: 'Testarius',
      status: 'TEST',
    },
    {
      itemId: 'r1-test-e5',
      difficulty: 'EASY',
      prompt: 'TEST EASY 5: name the test placeholder number.',
      canonicalAnswer: 'Seven',
      status: 'TEST',
    },
    {
      itemId: 'r1-test-m5',
      difficulty: 'MEDIUM',
      prompt: 'TEST MEDIUM 5: name the test placeholder city.',
      canonicalAnswer: 'Testington',
      status: 'TEST',
    },
    {
      itemId: 'r1-test-h5',
      difficulty: 'HARD',
      prompt: 'TEST HARD 5: name the test placeholder treaty.',
      canonicalAnswer: 'Treaty of Testing',
      status: 'TEST',
    },
  ],
};

/** TEST tiebreak questions. Separate pack, separate cursor (spec §12). */
export const ROUND1_TEST_TIEBREAK_PACK: Round1ContentPack = {
  packId: 'r1-test-tiebreak',
  status: 'TEST',
  source: 'TEST_FIXTURE',
  items: [
    {
      itemId: 'r1-tb-test-001',
      difficulty: 'HARD',
      prompt: 'TEST TIEBREAK 1: name the test placeholder tiebreak answer.',
      canonicalAnswer: 'Tiebreaker',
      status: 'TEST',
    },
    {
      itemId: 'r1-tb-test-002',
      difficulty: 'HARD',
      prompt: 'TEST TIEBREAK 2: name the second test placeholder tiebreak answer.',
      canonicalAnswer: 'Sudden',
      status: 'TEST',
    },
    {
      itemId: 'r1-tb-test-003',
      difficulty: 'MEDIUM',
      prompt: 'TEST TIEBREAK 3: name the third test placeholder tiebreak answer.',
      canonicalAnswer: 'Decider',
      status: 'TEST',
    },
    {
      itemId: 'r1-tb-test-004',
      difficulty: 'MEDIUM',
      prompt: 'TEST TIEBREAK 4: name the fourth test placeholder tiebreak answer.',
      canonicalAnswer: 'Placeholder',
      status: 'TEST',
    },
    {
      itemId: 'r1-tb-test-005',
      difficulty: 'EASY',
      prompt: 'TEST TIEBREAK 5: name the fifth test placeholder tiebreak answer.',
      canonicalAnswer: 'Final',
      status: 'TEST',
    },
    {
      itemId: 'r1-tb-test-006',
      difficulty: 'EASY',
      prompt: 'TEST TIEBREAK 6: name the sixth test placeholder tiebreak answer.',
      canonicalAnswer: 'Last',
      status: 'TEST',
    },
  ],
};

/** A fresh TEST source. Each game gets its own, so cursors never leak. */
export function createTestRound1ContentSource(): Round1ContentSource {
  return new PackRound1ContentSource({
    questions: ROUND1_TEST_QUESTION_PACK,
    tiebreak: ROUND1_TEST_TIEBREAK_PACK,
  });
}

/**
 * A source that has nothing.
 *
 * The default when no content is configured, so a server without a content
 * source refuses to start Round 1 rather than inventing questions.
 */
export function createEmptyRound1ContentSource(): Round1ContentSource {
  const empty = (packId: string): Round1ContentPack => ({
    packId,
    status: 'TEST',
    source: 'EMPTY',
    items: [],
  });
  return new PackRound1ContentSource({
    questions: empty('r1-empty-questions'),
    tiebreak: empty('r1-empty-tiebreak'),
  });
}
