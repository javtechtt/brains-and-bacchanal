/**
 * Deterministic clock abstraction.
 *
 * CLAUDE.md — "Use a deterministic/fake clock for timing tests." and
 * "Do not trust client clocks."
 * ARCHITECTURE.md §6 — the server owns open times, deadlines, paused time,
 * resume deadlines and buzzer acceptance.
 *
 * Every piece of game logic that cares about time will take a Clock rather than
 * reading Date.now() directly. That makes timing behaviour testable without
 * real waiting, which will matter later for the Bacchanal Clash response
 * window, the Guess the Logo window and Family Feud buzzer fairness.
 *
 * ESLint bans Date/Date.now/setTimeout/setInterval inside this package; this
 * file is the single audited exception.
 */

/** Epoch milliseconds as measured by the server. */
export type Millis = number;

export interface Clock {
  /** Current epoch milliseconds. */
  now(): Millis;
}

/** Real time. Used in production. */
export class SystemClock implements Clock {
  now(): Millis {
    return Date.now();
  }
}

/**
 * Manually advanced clock for tests.
 *
 * Time only moves when the test moves it, so a test for a ten-second window
 * runs instantly and never flakes under CI load.
 */
export class FakeClock implements Clock {
  #current: Millis;

  constructor(start: Millis = 0) {
    if (!Number.isFinite(start)) {
      throw new RangeError('FakeClock start must be a finite number');
    }
    this.#current = start;
  }

  now(): Millis {
    return this.#current;
  }

  /** Move time forward. Negative values are rejected: time does not run back. */
  advance(ms: Millis): void {
    if (!Number.isFinite(ms)) {
      throw new RangeError('FakeClock.advance requires a finite number');
    }
    if (ms < 0) {
      throw new RangeError('FakeClock.advance cannot move time backwards');
    }
    this.#current += ms;
  }

  /** Jump to an absolute time. Must not move backwards. */
  set(ms: Millis): void {
    if (!Number.isFinite(ms)) {
      throw new RangeError('FakeClock.set requires a finite number');
    }
    if (ms < this.#current) {
      throw new RangeError('FakeClock.set cannot move time backwards');
    }
    this.#current = ms;
  }
}
