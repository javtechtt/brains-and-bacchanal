import { describe, expect, it } from 'vitest';
import {
  damerauLevenshtein,
  fuzzyToleranceFor,
  gradeAnswer,
  gradeDeterministic,
  guardedJudge,
  normalizeAnswer,
  UnavailableSemanticJudge,
  type AnswerSemanticJudge,
  type SemanticJudgeRequest,
  type SemanticJudgeResult,
} from './round1-grading.js';

/**
 * Round 1 grading tests. Phase 7C spec §20 (GRADING).
 *
 * NO NETWORK ANYWHERE. Every semantic case uses a deterministic stub, per spec
 * §4D: "tests MUST use a deterministic fake/stub; tests must NOT require
 * internet access."
 */

/** A judge that answers from a lookup table. Deterministic, no I/O. */
class StubJudge implements AnswerSemanticJudge {
  readonly seen: SemanticJudgeRequest[] = [];
  constructor(private readonly table: Record<string, SemanticJudgeResult>) {}
  async judge(request: SemanticJudgeRequest): Promise<SemanticJudgeResult> {
    this.seen.push(request);
    return (
      this.table[request.submittedAnswer.toLowerCase()] ?? {
        verdict: 'NEEDS_HOST_REVIEW',
        reason: 'stub has no opinion',
      }
    );
  }
}

const SHAKESPEARE = {
  prompt: 'TEST: who wrote the test placeholder play?',
  canonicalAnswer: 'Shakespeare',
};

describe('normalisation (spec §4A)', () => {
  it('is case-insensitive', () => {
    expect(normalizeAnswer('SHAKESPEARE')).toBe(normalizeAnswer('shakespeare'));
  });

  it('trims and collapses whitespace', () => {
    expect(normalizeAnswer('   world   war    two  ')).toBe('world war two');
  });

  it('normalises harmless punctuation', () => {
    expect(normalizeAnswer('Spider-Man')).toBe(normalizeAnswer('spider man'));
    expect(normalizeAnswer("Hawai'i")).toBe(normalizeAnswer('hawai i'));
  });

  it('folds curly quotes and dashes from phone autocorrect', () => {
    expect(normalizeAnswer('‘Rock’n’Roll’')).toBe(
      normalizeAnswer("'rock'n'roll'"),
    );
  });

  it('treats & and "and" as the same word', () => {
    expect(normalizeAnswer('Rhythm & Blues')).toBe(normalizeAnswer('Rhythm and Blues'));
    // Spaced, so the letters do not run together.
    expect(normalizeAnswer('R&B')).toBe('r and b');
  });

  it('folds accents', () => {
    expect(normalizeAnswer('Beyoncé')).toBe(normalizeAnswer('Beyonce'));
  });

  it('strips only a LEADING article', () => {
    expect(normalizeAnswer('The Beatles')).toBe('beatles');
    // The internal "the" survives — it is part of the title.
    expect(normalizeAnswer('Lord of the Rings')).toBe('lord of the rings');
  });

  it('does NOT normalise away a meaningful distinction', () => {
    // The thing §4A warns about. These are different answers and must stay so.
    expect(normalizeAnswer('World War II')).not.toBe(normalizeAnswer('World War III'));
    expect(normalizeAnswer('Ford')).not.toBe(normalizeAnswer('Fort'));
  });
});

describe('edit distance', () => {
  it('counts a substitution as one', () => {
    expect(damerauLevenshtein('cat', 'cut')).toBe(1);
  });

  it('counts a TRANSPOSITION as one, not two', () => {
    // The reason Damerau was chosen over plain Levenshtein: a finger slip on
    // two adjacent keys is the single commonest typo there is.
    expect(damerauLevenshtein('shakespaere', 'shakespeare')).toBe(1);
  });

  it('counts an insertion and a deletion as one each', () => {
    expect(damerauLevenshtein('canada', 'canadaa')).toBe(1);
    expect(damerauLevenshtein('brazil', 'brazl')).toBe(1);
  });

  it('returns 0 for identical strings and the length for an empty one', () => {
    expect(damerauLevenshtein('same', 'same')).toBe(0);
    expect(damerauLevenshtein('', 'abc')).toBe(3);
    expect(damerauLevenshtein('abc', '')).toBe(3);
  });

  it('stops early past the bound rather than computing the true distance', () => {
    // The value is only required to EXCEED the bound, not to be exact.
    expect(damerauLevenshtein('aaaaaaaa', 'zzzzzzzz', 2)).toBeGreaterThan(2);
  });
});

describe('the fuzzy tolerance ladder (spec §4C)', () => {
  it('forgives NOTHING on very short answers', () => {
    // "Ford"/"Fort", "Rome"/"Rose" — one edit apart, different answers.
    expect(fuzzyToleranceFor(4)).toBe(0);
    expect(fuzzyToleranceFor(3)).toBe(0);
  });

  it('forgives one edit in the middle band and two when long', () => {
    expect(fuzzyToleranceFor(6)).toBe(1);
    expect(fuzzyToleranceFor(11)).toBe(1);
    expect(fuzzyToleranceFor(12)).toBe(2);
  });
});

describe('deterministic grading', () => {
  it('accepts an exact match', () => {
    const out = gradeDeterministic({ ...SHAKESPEARE, submittedAnswer: 'Shakespeare' });
    expect(out?.verdict).toBe('CORRECT');
    expect(out?.source).toBe('exact');
  });

  it('accepts an approved variant', () => {
    const out = gradeDeterministic({
      ...SHAKESPEARE,
      acceptedVariants: ['William Shakespeare'],
      submittedAnswer: 'william shakespeare',
    });
    expect(out?.verdict).toBe('CORRECT');
    expect(out?.source).toBe('exact');
  });

  it('accepts a one-character typo', () => {
    const out = gradeDeterministic({ ...SHAKESPEARE, submittedAnswer: 'Shakespear' });
    expect(out?.verdict).toBe('CORRECT');
    expect(out?.source).toBe('fuzzy');
  });

  it('accepts a transposition', () => {
    const out = gradeDeterministic({ ...SHAKESPEARE, submittedAnswer: 'Shakespaere' });
    expect(out?.verdict).toBe('CORRECT');
  });

  it('accepts a missing character and an extra character', () => {
    expect(
      gradeDeterministic({ ...SHAKESPEARE, submittedAnswer: 'Shakspeare' })?.verdict,
    ).toBe('CORRECT');
    expect(
      gradeDeterministic({ ...SHAKESPEARE, submittedAnswer: 'Shakespearee' })?.verdict,
    ).toBe('CORRECT');
  });

  it('accepts a typo in a MULTI-WORD answer', () => {
    const out = gradeDeterministic({
      prompt: 'TEST',
      canonicalAnswer: 'William Shakespeare',
      submittedAnswer: 'Willam Shakespere',
    });
    expect(out?.verdict).toBe('CORRECT');
    expect(out?.source).toBe('fuzzy');
  });

  it('REJECTS a materially different answer', () => {
    // The false-positive guard. This must never be accepted by the fuzzy layer.
    expect(gradeDeterministic({ ...SHAKESPEARE, submittedAnswer: 'Dickens' })).toBeNull();
    expect(gradeDeterministic({ ...SHAKESPEARE, submittedAnswer: 'Marlowe' })).toBeNull();
  });

  it('REJECTS a one-edit neighbour of a SHORT answer', () => {
    // §4C's "special care with very short answers", as a test. Each pair is one
    // edit apart and each is a genuinely different trivia answer, so the fuzzy
    // layer must decline and let the judge or the Host decide.
    for (const [canonical, guess] of [
      ['Ford', 'Fort'],
      ['Rome', 'Rose'],
      ['Mars', 'Mark'],
      ['Iran', 'Iraq'],
    ]) {
      const out = gradeDeterministic({
        prompt: 'TEST',
        canonicalAnswer: canonical!,
        submittedAnswer: guess!,
      });
      expect(out, `${canonical} vs ${guess}`).toBeNull();
    }
  });

  it('does not let a multi-word answer match a shorter one', () => {
    expect(
      gradeDeterministic({
        prompt: 'TEST',
        canonicalAnswer: 'New York',
        submittedAnswer: 'York',
      }),
    ).toBeNull();
  });

  it('treats an empty answer as incorrect without consulting anything', () => {
    const out = gradeDeterministic({ ...SHAKESPEARE, submittedAnswer: '   ' });
    expect(out?.verdict).toBe('INCORRECT');
  });
});

describe('the semantic judge (spec §4D)', () => {
  it('is consulted ONLY when the deterministic layers cannot decide', async () => {
    const judge = new StubJudge({});
    await gradeAnswer({ ...SHAKESPEARE, submittedAnswer: 'Shakespeare' }, judge);
    // An exact match must never reach the AI — it cannot be overturned.
    expect(judge.seen).toHaveLength(0);
  });

  it('accepts a differently-worded equivalent answer', async () => {
    // The spec's own example: "the second world war" for "World War II".
    const judge = new StubJudge({
      'the second world war': { verdict: 'CORRECT', reason: 'equivalent phrasing' },
    });
    const out = await gradeAnswer(
      {
        prompt: 'TEST: which test placeholder conflict?',
        canonicalAnswer: 'World War II',
        submittedAnswer: 'the second world war',
      },
      judge,
    );
    expect(out.verdict).toBe('CORRECT');
    expect(out.source).toBe('semantic');
  });

  it('rejects an answer the judge calls incorrect', async () => {
    const judge = new StubJudge({ dickens: { verdict: 'INCORRECT' } });
    const out = await gradeAnswer({ ...SHAKESPEARE, submittedAnswer: 'Dickens' }, judge);
    expect(out.verdict).toBe('INCORRECT');
    expect(out.source).toBe('semantic');
  });

  it('receives ONLY the current question and the submitted answer', async () => {
    // Spec §4D — no future questions, no other teams' answers, no room secrets,
    // no hands, no credentials. The request type has no field for any of them,
    // and this pins the payload that actually crosses the seam.
    const judge = new StubJudge({});
    await gradeAnswer(
      {
        prompt: 'TEST prompt',
        canonicalAnswer: 'TEST answer',
        acceptedVariants: ['TEST variant'],
        submittedAnswer: 'something else',
      },
      judge,
    );
    expect(Object.keys(judge.seen[0]!).sort()).toEqual([
      'acceptedVariants',
      'canonicalAnswer',
      'prompt',
      'submittedAnswer',
    ]);
  });

  it('asks the Host when it has no opinion', async () => {
    const out = await gradeAnswer(
      { ...SHAKESPEARE, submittedAnswer: 'a playwright' },
      new StubJudge({}),
    );
    expect(out.verdict).toBe('NEEDS_HOST_REVIEW');
  });
});

describe('judge failure always means NEEDS_HOST_REVIEW, never a guess', () => {
  it('when no judge is configured at all', async () => {
    const out = await gradeAnswer(
      { ...SHAKESPEARE, submittedAnswer: 'a playwright' },
      new UnavailableSemanticJudge(),
    );
    expect(out.verdict).toBe('NEEDS_HOST_REVIEW');
  });

  it('when the provider throws', async () => {
    const throwing: AnswerSemanticJudge = {
      async judge() {
        throw new Error('network down');
      },
    };
    const out = await guardedJudge(throwing, { timeoutMs: 50 }).judge({
      prompt: 'p',
      canonicalAnswer: 'a',
      acceptedVariants: [],
      submittedAnswer: 'b',
    });
    expect(out.verdict).toBe('NEEDS_HOST_REVIEW');
  });

  it('when the provider times out', async () => {
    const hanging: AnswerSemanticJudge = {
      judge: () => new Promise<SemanticJudgeResult>(() => {}),
    };
    const out = await guardedJudge(hanging, { timeoutMs: 10 }).judge({
      prompt: 'p',
      canonicalAnswer: 'a',
      acceptedVariants: [],
      submittedAnswer: 'b',
    });
    expect(out.verdict).toBe('NEEDS_HOST_REVIEW');
  });

  it('when the provider returns something malformed', async () => {
    const malformed = {
      async judge() {
        return { verdict: 'DEFINITELY' } as unknown as SemanticJudgeResult;
      },
    };
    const out = await guardedJudge(malformed, { timeoutMs: 50 }).judge({
      prompt: 'p',
      canonicalAnswer: 'a',
      acceptedVariants: [],
      submittedAnswer: 'b',
    });
    expect(out.verdict).toBe('NEEDS_HOST_REVIEW');
  });
});
