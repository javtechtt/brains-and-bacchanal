import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import {
  elapsedMs,
  extendDeadline,
  hasExpired,
  isPaused,
  pauseDeadline,
  remainingMs,
  resumeDeadline,
  startDeadline,
} from './deadline.js';

describe('deadline', () => {
  it('starts with the full duration remaining', () => {
    const clock = new FakeClock(1_000);
    const d = startDeadline(clock, 10_000);
    expect(remainingMs(clock, d)).toBe(10_000);
    expect(hasExpired(clock, d)).toBe(false);
  });

  it('counts down as the clock advances', () => {
    const clock = new FakeClock(1_000);
    const d = startDeadline(clock, 10_000);
    clock.advance(4_000);
    expect(remainingMs(clock, d)).toBe(6_000);
    expect(elapsedMs(clock, d)).toBe(4_000);
  });

  it('expires and floors at zero', () => {
    const clock = new FakeClock();
    const d = startDeadline(clock, 3_000);
    clock.advance(5_000);
    expect(remainingMs(clock, d)).toBe(0);
    expect(hasExpired(clock, d)).toBe(true);
  });

  it('rejects a negative duration', () => {
    expect(() => startDeadline(new FakeClock(), -1)).toThrow(RangeError);
  });
});

// GAME_RULES_LOCKED.md §20 / DECISION_LOG.md D-011 — on pause, active gameplay
// timers pause. Paused time must not be charged against a team.
describe('deadline pause and resume', () => {
  it('does not consume time while paused', () => {
    const clock = new FakeClock(0);
    let d = startDeadline(clock, 10_000);

    clock.advance(3_000);
    d = pauseDeadline(clock, d);
    expect(isPaused(d)).toBe(true);
    expect(remainingMs(clock, d)).toBe(7_000);

    // A long pause must not eat the remaining time.
    clock.advance(60_000);
    expect(remainingMs(clock, d)).toBe(7_000);
    expect(hasExpired(clock, d)).toBe(false);
  });

  it('restores the same remaining time on resume', () => {
    const clock = new FakeClock(0);
    let d = startDeadline(clock, 10_000);

    clock.advance(6_000);
    d = pauseDeadline(clock, d);
    clock.advance(45_000);
    d = resumeDeadline(clock, d);

    expect(isPaused(d)).toBe(false);
    expect(remainingMs(clock, d)).toBe(4_000);

    clock.advance(4_000);
    expect(hasExpired(clock, d)).toBe(true);
  });

  it('accumulates across several pauses', () => {
    const clock = new FakeClock(0);
    let d = startDeadline(clock, 10_000);

    clock.advance(2_000);
    d = pauseDeadline(clock, d);
    clock.advance(10_000);
    d = resumeDeadline(clock, d);

    clock.advance(3_000);
    d = pauseDeadline(clock, d);
    clock.advance(10_000);
    d = resumeDeadline(clock, d);

    expect(remainingMs(clock, d)).toBe(5_000);
  });

  it('treats a repeated pause or resume as a no-op', () => {
    const clock = new FakeClock(0);
    let d = startDeadline(clock, 5_000);

    d = pauseDeadline(clock, d);
    const pausedAt = d.pausedAt;
    clock.advance(1_000);
    d = pauseDeadline(clock, d);
    expect(d.pausedAt).toBe(pausedAt);

    d = resumeDeadline(clock, d);
    const banked = d.accumulatedPauseMs;
    d = resumeDeadline(clock, d);
    expect(d.accumulatedPauseMs).toBe(banked);
  });
});

describe('extendDeadline', () => {
  it('adds time to the duration', () => {
    const clock = new FakeClock(0);
    let d = startDeadline(clock, 10_000);
    clock.advance(8_000);
    expect(remainingMs(clock, d)).toBe(2_000);

    d = extendDeadline(d, 15_000);
    expect(remainingMs(clock, d)).toBe(17_000);
  });

  it('rejects a negative extension', () => {
    const d = startDeadline(new FakeClock(), 1_000);
    expect(() => extendDeadline(d, -1)).toThrow(RangeError);
  });
});
