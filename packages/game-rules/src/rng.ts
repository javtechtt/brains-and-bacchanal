/**
 * Deterministic randomness abstraction.
 *
 * Phase 6 spec §3 — "Use a deterministic/randomness abstraction suitable for
 * testing. Do not rely directly on Math.random scattered in the engine."
 *
 * Four things in Phase 6 are random, and every one of them decides something a
 * player will argue about at a party:
 *   - which three Bacchanal cards a team is dealt (GAME_RULES_LOCKED.md §2),
 *   - the Maco Mail draw order (§7, without replacement),
 *   - which card Card Confiscation takes,
 *   - any later shuffle of the discard back into the draw pile.
 *
 * A test that cannot fix those cannot assert anything about them. So the engine
 * never reaches for Math.random; it takes an `Rng` the way it already takes a
 * `Clock`, and tests inject a seeded one whose sequence is reproducible.
 *
 * ESLint does not ban Math.random in this package the way it bans Date.now, so
 * this file is a convention rather than a wall. The convention is: if a rule
 * function needs a random value, it takes an Rng parameter.
 */

/**
 * A source of random numbers.
 *
 * Deliberately tiny. Everything else — picking one of a list, shuffling — is a
 * pure helper built on `nextFloat`, so an implementation has exactly one method
 * to get right.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  nextFloat(): number;
}

/**
 * Real randomness. Used in production.
 *
 * `Math.random` is right for this: nothing here is a secret, a credential or a
 * shuffle an opponent could profit from predicting. The cards are revealed to
 * their owner the moment they are dealt.
 */
export class SystemRng implements Rng {
  nextFloat(): number {
    return Math.random();
  }
}

/**
 * Seeded, reproducible randomness for tests and replays.
 *
 * mulberry32 — a small, well-distributed 32-bit generator. Chosen over
 * a hand-rolled LCG because low-bit patterns in a bad LCG would show up as a
 * biased deal, and over a crypto generator because reproducibility is the whole
 * point here and none of this is security-sensitive.
 *
 * The same seed always produces the same sequence, so a test can assert the
 * exact hand a team is dealt, or replay a Maco Mail deck.
 */
export class SeededRng implements Rng {
  #state: number;

  constructor(seed: number) {
    if (!Number.isFinite(seed)) {
      throw new RangeError('SeededRng seed must be a finite number');
    }
    // >>> 0 coerces to an unsigned 32-bit integer, which is the state space
    // mulberry32 is defined over.
    this.#state = seed >>> 0;
  }

  nextFloat(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

/**
 * Pick one item uniformly.
 *
 * Returns null for an empty list rather than throwing: "no legal candidate" is a
 * real and expected case in Phase 6 — Card Confiscation with nothing to take,
 * a Maco Mail effect with no valid target — and it is handled as a game outcome
 * (a dud), not as an error.
 */
export function pickOne<T>(rng: Rng, items: readonly T[]): T | null {
  if (items.length === 0) return null;
  const index = Math.floor(rng.nextFloat() * items.length);
  // nextFloat is specified as [0, 1), but clamping costs nothing and protects
  // against an Rng implementation that returns exactly 1.
  return items[Math.min(index, items.length - 1)] ?? null;
}

/**
 * Fisher-Yates shuffle, returning a new array.
 *
 * Non-mutating because the caller's list is usually configuration — the Maco
 * Mail deck composition, a team's hand — and shuffling configuration in place is
 * the kind of bug that only shows up on the second game.
 */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng.nextFloat() * (i + 1));
    const a = result[i];
    const b = result[Math.min(j, i)];
    if (a === undefined || b === undefined) continue;
    result[i] = b;
    result[Math.min(j, i)] = a;
  }
  return result;
}
