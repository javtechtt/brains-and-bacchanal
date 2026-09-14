import type { Clock, Millis } from './clock.js';

/**
 * Pausable deadlines.
 *
 * ARCHITECTURE.md §6 — the server owns "open times, deadlines, paused time,
 * resume deadlines, buzzer acceptance".
 * GAME_RULES_LOCKED.md §20 / DECISION_LOG.md D-011 — when the game pauses,
 * "active gameplay timers pause".
 *
 * Paused time is not cosmetic. If a player disconnects with four seconds left,
 * the team must still have four seconds when the Host resumes — not zero
 * because wall-clock time kept running. So elapsed time excludes paused time.
 *
 * These are PRIMITIVES. No challenge's duration is decided here: several remain
 * open (OPEN_RULES.md §2 Think Fast, §6 Sing a Song, §11 Round 4 / Sudden
 * Death). Callers supply durations from configuration.
 *
 * Pure and deterministic: every function takes a Clock and returns a new value.
 */

export interface Deadline {
  readonly durationMs: number;
  readonly startedAt: Millis;
  /** Set while paused; null while running. */
  readonly pausedAt: Millis | null;
  /** Total time already spent paused, excluding any current pause. */
  readonly accumulatedPauseMs: number;
}

export function startDeadline(clock: Clock, durationMs: number): Deadline {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new RangeError('Deadline duration must be a finite, non-negative number');
  }
  return {
    durationMs,
    startedAt: clock.now(),
    pausedAt: null,
    accumulatedPauseMs: 0,
  };
}

/** Pause a running deadline. Pausing an already-paused deadline is a no-op. */
export function pauseDeadline(clock: Clock, deadline: Deadline): Deadline {
  if (deadline.pausedAt !== null) return deadline;
  return { ...deadline, pausedAt: clock.now() };
}

/** Resume a paused deadline, banking the elapsed pause. No-op if running. */
export function resumeDeadline(clock: Clock, deadline: Deadline): Deadline {
  if (deadline.pausedAt === null) return deadline;
  return {
    ...deadline,
    pausedAt: null,
    accumulatedPauseMs: deadline.accumulatedPauseMs + (clock.now() - deadline.pausedAt),
  };
}

/** Whether the deadline is currently paused. */
export function isPaused(deadline: Deadline): boolean {
  return deadline.pausedAt !== null;
}

/** Milliseconds elapsed, excluding paused time. */
export function elapsedMs(clock: Clock, deadline: Deadline): number {
  // While paused, time is measured to the moment of pausing, so a long pause
  // does not consume the deadline.
  const reference = deadline.pausedAt ?? clock.now();
  return Math.max(0, reference - deadline.startedAt - deadline.accumulatedPauseMs);
}

/** Milliseconds remaining, floored at 0. */
export function remainingMs(clock: Clock, deadline: Deadline): number {
  return Math.max(0, deadline.durationMs - elapsedMs(clock, deadline));
}

/** Whether the deadline has run out. A paused deadline can still be expired. */
export function hasExpired(clock: Clock, deadline: Deadline): boolean {
  return remainingMs(clock, deadline) === 0;
}

/**
 * Extend a deadline.
 *
 * The Market sells "Extra Time (+15 sec)" and Maco Mail has a "+15 Seconds"
 * outcome (GAME_RULES_LOCKED.md §10, §8). This primitive supports them; it does
 * not implement either, and it does not enforce the Market's no-stacking rule.
 * That enforcement belongs to Phase 6.
 */
export function extendDeadline(deadline: Deadline, additionalMs: number): Deadline {
  if (!Number.isFinite(additionalMs) || additionalMs < 0) {
    throw new RangeError('Deadline extension must be a finite, non-negative number');
  }
  return { ...deadline, durationMs: deadline.durationMs + additionalMs };
}
