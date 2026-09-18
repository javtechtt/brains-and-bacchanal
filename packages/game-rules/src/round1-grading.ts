import type { Round1GradeSource, Round1Verdict } from '@bb/protocol';

/**
 * Round 1 free-text answer grading. Phase 7C spec §4.
 *
 * ================== WHY A PIPELINE AND NOT ONE MATCHER ==================
 * Spec §4: "Do NOT make an LLM the sole grading mechanism." A party game cannot
 * wait on a network call for every answer, and an LLM that is down must not stop
 * the game — but "Shakespear" for "Shakespeare" must still be accepted, and so
 * must "the second world war" for "World War II".
 *
 * So four layers run in order of confidence, and each one that answers
 * definitively STOPS the pipeline:
 *
 *   1. normalise      cheap, deterministic, lossless-ish text cleanup
 *   2. exact match    against the canonical answer and approved variants
 *   3. fuzzy match    conservative edit distance, for obvious typos only
 *   4. semantic judge the AI, for genuine rephrasing — and only if reached
 *
 * Anything still unresolved becomes NEEDS_HOST_REVIEW. The Host is the final
 * authority in this game (CLAUDE.md), so handing an uncertain answer over is a
 * normal outcome rather than a failure.
 * ========================================================================
 *
 * ================== THE BIAS IS TOWARD ASKING, NOT GUESSING ==================
 * Every threshold here is deliberately conservative. A false ACCEPT silently
 * awards BB for a wrong answer and nobody notices; a NEEDS_HOST_REVIEW costs the
 * Host two seconds. Those costs are not symmetric, so the tuning is not either.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// A. Normalisation
// ---------------------------------------------------------------------------

/**
 * Reduce an answer to a comparable form. Spec §4A.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: strip digits, expand abbreviations,
 * remove stop words, or stem. Each of those collapses real distinctions —
 * "World War II" vs "World War III" differ by one character that a naive
 * digit-strip would erase entirely.
 *
 * Accents are folded (NFD then strip combining marks) because a phone keyboard
 * makes them near-random, not because they are meaningless.
 */
export function normalizeAnswer(raw: string): string {
  return (
    raw
      // Unicode-safe: compose first so visually identical strings agree.
      .normalize('NFD')
      // Strip combining marks — "Bardòt" and "Bardot" are the same guess typed
      // on different keyboards.
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      // Curly quotes and dashes arrive from phone autocorrect; fold them onto
      // their plain equivalents before punctuation is stripped.
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[‐-―]/g, '-')
      // "&" and "and" are the same word typed two ways. Spaced so "R&B"
      // becomes "r and b" rather than "randb".
      .replace(/&/g, ' and ')
      // A leading article is noise in a trivia answer: "the Beatles" and
      // "Beatles" are one answer. Only stripped at the START, so "Lord of the
      // Rings" keeps its internal "the".
      .replace(/^(?:the|a|an)\s+/i, '')
      // Punctuation to spaces rather than nothing, so "spider-man" and
      // "spider man" agree while "USA" does not become "u s a".
      .replace(/[.,!?;:"'()[\]{}\-_/\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Every accepted form of one answer, normalised. */
function acceptedForms(
  canonical: string,
  variants: readonly string[] | undefined,
): readonly string[] {
  const all = [canonical, ...(variants ?? [])];
  return [...new Set(all.map(normalizeAnswer))].filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// C. Fuzzy matching
// ---------------------------------------------------------------------------

/**
 * Damerau-Levenshtein distance (optimal string alignment).
 *
 * Chosen over plain Levenshtein specifically for TRANSPOSITION: "Shakespaere"
 * is one keystroke slip, and plain Levenshtein charges it as two edits, which
 * would push a very common typo past any sane threshold.
 *
 * Bounded by `max`: once every cell in a row exceeds it the answer cannot come
 * back under, so the scan stops early. That keeps a pathological long answer
 * from costing anything measurable.
 */
export function damerauLevenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr: number[] = [];

  for (let i = 1; i <= a.length; i += 1) {
    curr = new Array<number>(b.length + 1);
    curr[0] = i;
    let rowMin = curr[0];

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (curr[j - 1] ?? 0) + 1, // insertion
        (prev[j] ?? 0) + 1, // deletion
        (prev[j - 1] ?? 0) + cost, // substitution
      );

      // The transposition case: two adjacent characters swapped.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (prev2[j - 2] ?? 0) + 1);
      }

      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }

    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = curr;
  }

  return prev[b.length] ?? 0;
}

/**
 * How many edits are forgiven for an answer of this length. Spec §4C.
 *
 * ================== THE THRESHOLDS, AND WHY THESE ==================
 * Not one permissive percentage — spec §4C forbids that, and rightly: 20% of a
 * four-letter answer is nearly a different word.
 *
 *   1-4 chars    0 edits.  "Ford"/"Fort", "Rome"/"Rose", "Mars"/"Mark" are all
 *                one edit apart and all different answers. At this length a typo
 *                is indistinguishable from a wrong guess, so nothing is forgiven
 *                and the AI judge or the Host decides instead.
 *   5-7 chars    1 edit.   Catches "Brazl", "Frnace", "Canadaa".
 *   8-11 chars   1 edit.   Still one: "Einstein"/"Einstien" is a transposition,
 *                which costs 1 here thanks to Damerau.
 *   12+ chars    2 edits.  Long answers attract more slips, and at this length
 *                two edits cannot reach a different real answer.
 * ===================================================================
 */
export function fuzzyToleranceFor(length: number): number {
  if (length <= 4) return 0;
  if (length <= 11) return 1;
  return 2;
}

/**
 * Whether a normalised guess is a typo of a normalised accepted form.
 *
 * MULTI-WORD ANSWERS are compared BOTH whole and word-by-word, because the two
 * fail differently: "Willam Shakespere" is two separate one-character slips, so
 * the whole-string distance is 2 — inside the 12+ tolerance — while word-wise it
 * is one slip in each word. Requiring word counts to match keeps "New York" from
 * fuzzily matching "York".
 */
function isTypoOf(guess: string, accepted: string): boolean {
  const tolerance = fuzzyToleranceFor(accepted.length);
  if (tolerance > 0 && damerauLevenshtein(guess, accepted, tolerance) <= tolerance) {
    return true;
  }

  const guessWords = guess.split(' ');
  const acceptedWords = accepted.split(' ');
  if (guessWords.length < 2 || guessWords.length !== acceptedWords.length) return false;

  // Every word must be within its OWN length-based tolerance. A short word in a
  // long answer still gets no slack, so "New York" cannot become "Old York".
  return acceptedWords.every((word, i) => {
    const got = guessWords[i] ?? '';
    const wordTolerance = fuzzyToleranceFor(word.length);
    if (wordTolerance === 0) return got === word;
    return damerauLevenshtein(got, word, wordTolerance) <= wordTolerance;
  });
}

// ---------------------------------------------------------------------------
// D. The semantic judge
// ---------------------------------------------------------------------------

/** What the judge is asked. Deliberately the minimum. Spec §4D. */
export interface SemanticJudgeRequest {
  readonly prompt: string;
  readonly canonicalAnswer: string;
  readonly acceptedVariants: readonly string[];
  readonly submittedAnswer: string;
}

export interface SemanticJudgeResult {
  readonly verdict: Round1Verdict;
  readonly reason?: string;
}

/**
 * The AI judge seam. Spec §4D.
 *
 * ================== VENDOR-NEUTRAL ON PURPOSE ==================
 * The repository has no AI provider decision — no abstraction, no DECISION_LOG
 * entry, nothing in config. Spec §4D: "Do not choose or hardcode a paid provider
 * simply because it is convenient if the project has no existing provider
 * decision."
 *
 * So Phase 7C ships this interface, a deterministic stub for tests, and a
 * refusing default for production. It ships NO vendor adapter. Writing one would
 * make the choice by default, which is exactly what the project's discipline
 * about open decisions exists to prevent.
 * ===============================================================
 *
 * ================== WHAT IT MUST NEVER RECEIVE ==================
 * Future questions, other teams' answers, room secrets, Bacchanal hands or
 * reconnect credentials. `SemanticJudgeRequest` has no field for any of them,
 * so a careless adapter cannot leak one.
 * ===============================================================
 */
export interface AnswerSemanticJudge {
  judge(request: SemanticJudgeRequest): Promise<SemanticJudgeResult>;
}

/**
 * The default judge: it refuses to guess.
 *
 * Used when no provider is configured, which is every environment today. Spec
 * §4D — an unavailable judge returns NEEDS_HOST_REVIEW, never a verdict. The
 * game stays playable with no AI at all; the Host simply rules more often.
 */
export class UnavailableSemanticJudge implements AnswerSemanticJudge {
  async judge(): Promise<SemanticJudgeResult> {
    return { verdict: 'NEEDS_HOST_REVIEW', reason: 'No semantic judge is configured.' };
  }
}

/**
 * Wrap a judge so it cannot hang, throw or return nonsense. Spec §4D.
 *
 * All four failure modes the spec names — unavailable, timeout, malformed,
 * unsure — collapse to the same safe answer: NEEDS_HOST_REVIEW. A judge that
 * rejects, exceeds its time budget, or returns a verdict outside the enum is
 * treated as having no opinion.
 */
export function guardedJudge(
  inner: AnswerSemanticJudge,
  options: { readonly timeoutMs: number; readonly setTimeoutFn?: typeof setTimeout },
): AnswerSemanticJudge {
  const schedule = options.setTimeoutFn ?? setTimeout;
  return {
    async judge(request: SemanticJudgeRequest): Promise<SemanticJudgeResult> {
      const fallback: SemanticJudgeResult = {
        verdict: 'NEEDS_HOST_REVIEW',
        reason: 'The semantic judge did not answer in time.',
      };
      try {
        const timeout = new Promise<SemanticJudgeResult>((resolve) => {
          schedule(() => resolve(fallback), options.timeoutMs);
        });
        const result = await Promise.race([inner.judge(request), timeout]);

        // A malformed answer is not trusted, even if it arrived quickly.
        if (
          result === null ||
          typeof result !== 'object' ||
          (result.verdict !== 'CORRECT' &&
            result.verdict !== 'INCORRECT' &&
            result.verdict !== 'NEEDS_HOST_REVIEW')
        ) {
          return { verdict: 'NEEDS_HOST_REVIEW', reason: 'Malformed judge response.' };
        }
        return result;
      } catch {
        return { verdict: 'NEEDS_HOST_REVIEW', reason: 'The semantic judge failed.' };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export interface GradeOutcome {
  readonly verdict: Round1Verdict;
  readonly source: Round1GradeSource;
  /** Why, for the Host's review screen. Never shown to players. */
  readonly detail: string;
}

export interface GradeInput {
  readonly prompt: string;
  readonly canonicalAnswer: string;
  readonly acceptedVariants?: readonly string[];
  readonly submittedAnswer: string;
}

/**
 * The deterministic layers: normalise, exact, fuzzy. No I/O, no clock, no AI.
 *
 * Returns null when nothing deterministic could decide, which is the signal to
 * consult the semantic judge. Split out from `gradeAnswer` so it can be tested
 * exhaustively without any async machinery, and so the engine can grade
 * synchronously when no judge is configured.
 */
export function gradeDeterministic(input: GradeInput): GradeOutcome | null {
  const guess = normalizeAnswer(input.submittedAnswer);

  // An empty answer is a non-answer. Nothing to judge, nothing to review.
  if (guess.length === 0) {
    return { verdict: 'INCORRECT', source: 'exact', detail: 'No answer was given.' };
  }

  const accepted = acceptedForms(input.canonicalAnswer, input.acceptedVariants);

  // B — exact match against canonical or an approved variant.
  if (accepted.includes(guess)) {
    return { verdict: 'CORRECT', source: 'exact', detail: 'Matched exactly once normalised.' };
  }

  // C — conservative typo tolerance.
  for (const form of accepted) {
    if (isTypoOf(guess, form)) {
      return {
        verdict: 'CORRECT',
        source: 'fuzzy',
        detail: `Within the typo tolerance for "${form}".`,
      };
    }
  }

  return null;
}

/**
 * Grade one answer through the whole pipeline. Spec §4.
 *
 * The judge is consulted ONLY for answers the deterministic layers could not
 * decide — which is both a cost control and a safety property: an answer that
 * exactly matches can never be overturned by an AI having a bad day.
 */
export async function gradeAnswer(
  input: GradeInput,
  judge: AnswerSemanticJudge,
): Promise<GradeOutcome> {
  const deterministic = gradeDeterministic(input);
  if (deterministic !== null) return deterministic;

  const result = await judge.judge({
    prompt: input.prompt,
    canonicalAnswer: input.canonicalAnswer,
    acceptedVariants: input.acceptedVariants ?? [],
    submittedAnswer: input.submittedAnswer,
  });

  return {
    verdict: result.verdict,
    source: 'semantic',
    detail: result.reason ?? 'Judged by the semantic judge.',
  };
}
