import type { Round4BoardAnswer } from '@bb/protocol';
import { damerauLevenshtein, fuzzyToleranceFor, normalizeAnswer } from './round1-grading.js';

/**
 * Family Feud free-text answer matching. Phase 7D-A.
 *
 * ================== ONE ANSWER, MANY BOARD ENTRIES — NOT ROUND 1's SHAPE ======
 * Round 1 grades a submission against ONE canonical answer plus its variants.
 * Family Feud grades against a WHOLE BOARD of independently-ranked answers, and
 * getting that wrong in either direction is a real gameplay bug:
 *
 *   - collapsing "test apple" and "test orange" into the same match because
 *     they are both fruity would silently let a team score twice off one entry,
 *     or block a legitimately different answer as a "duplicate",
 *   - being too strict would make an obviously-equivalent phrasing ("dog" vs
 *     "a dog") score as off-board.
 *
 * So this reuses Round 1's deterministic layers (normalise, exact, the same
 * conservative typo tolerance) but applies them per-candidate and REFUSES to
 * return a match when more than one board answer is plausible at once — that
 * case goes to the Host rather than guessing which one was meant. Round 1 has
 * no such case because it only ever has one candidate.
 * ================================================================================
 *
 * ================== THE HOST IS STILL FINAL AUTHORITY ==========================
 * This module never rules anything by itself in a way the round cannot
 * override. `Round4` stores whatever ruling the Host confirms and never
 * re-grades it — the matcher here is a suggestion the Host UI can pre-fill and
 * a deterministic fallback so the game does not stall waiting on a human for
 * the obvious cases, exactly like Round 1's deterministic layers versus its
 * semantic judge.
 * ================================================================================
 */

export interface Round4MatchResult {
  /** The one board answer matched, or null when nothing matched confidently. */
  readonly answer: Round4BoardAnswer | null;
  /** True when more than one candidate matched and the Host must decide. */
  readonly ambiguous: boolean;
  readonly detail: string;
}

/** Every normalised accepted form of one board answer. */
function acceptedFormsOf(answer: Round4BoardAnswer): readonly string[] {
  const all = [answer.text, ...(answer.variants ?? [])];
  return [...new Set(all.map(normalizeAnswer))].filter((s) => s.length > 0);
}

function isTypoOfForm(guess: string, form: string): boolean {
  const tolerance = fuzzyToleranceFor(form.length);
  if (tolerance === 0) return false;
  return damerauLevenshtein(guess, form, tolerance) <= tolerance;
}

/**
 * Match a submitted answer against the board's UNREVEALED answers.
 *
 * Deliberately takes only unrevealed answers: a revealed answer cannot be
 * scored again (§19 — "a valid, UNREVEALED board answer"), and the caller
 * (`Round4`) is responsible for excluding anything already revealed or removed
 * by Steups! for this team, so this function never needs to know about reveal
 * state or Steups! itself.
 */
export function matchRound4Answer(
  submitted: string,
  candidates: readonly Round4BoardAnswer[],
): Round4MatchResult {
  const guess = normalizeAnswer(submitted);
  if (guess.length === 0) {
    return { answer: null, ambiguous: false, detail: 'No answer was given.' };
  }

  const exact = candidates.filter((answer) => acceptedFormsOf(answer).includes(guess));
  if (exact.length === 1) {
    return { answer: exact[0] ?? null, ambiguous: false, detail: 'Matched exactly.' };
  }
  if (exact.length > 1) {
    // Two board entries sharing an accepted form would be a content bug, not a
    // grading one — but refusing to guess is still the right failure mode.
    return {
      answer: null,
      ambiguous: true,
      detail: 'Matched more than one board answer exactly. Host must choose.',
    };
  }

  const typo = candidates.filter((answer) =>
    acceptedFormsOf(answer).some((form) => isTypoOfForm(guess, form)),
  );
  if (typo.length === 1) {
    return { answer: typo[0] ?? null, ambiguous: false, detail: 'Within the typo tolerance.' };
  }
  if (typo.length > 1) {
    return {
      answer: null,
      ambiguous: true,
      detail: 'Within typo tolerance of more than one board answer. Host must choose.',
    };
  }

  return { answer: null, ambiguous: false, detail: 'No board answer matched.' };
}

/**
 * Whether a submitted answer matches the board's #1-ranked answer.
 *
 * Used only for the face-off's immediate-win check (§19) — kept separate from
 * `matchRound4Answer` because the face-off never needs the "which of several"
 * ambiguity path: there is exactly one #1 answer, so a match against it alone
 * is unambiguous by construction.
 */
export function matchesTopAnswer(
  submitted: string,
  answers: readonly Round4BoardAnswer[],
): boolean {
  const top = answers.find((answer) => answer.rank === 1);
  if (top === undefined) return false;
  const guess = normalizeAnswer(submitted);
  if (guess.length === 0) return false;
  const forms = acceptedFormsOf(top);
  return forms.includes(guess) || forms.some((form) => isTypoOfForm(guess, form));
}
