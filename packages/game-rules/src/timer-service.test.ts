import { describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { TimerService } from './timer-service.js';

/**
 * The server's authoritative timer.
 *
 * Every test runs on a FakeClock, so a thirty-second window is exercised
 * instantly and never flakes under CI load — CLAUDE.md requires a deterministic
 * clock for exactly this.
 *
 * NO DURATION HERE IS A GAME RULE. The numbers are test fixtures; the real ones
 * are open (OPEN_RULES.md §2, §6, §11).
 */

function makeTimer(): { timer: TimerService; clock: FakeClock } {
  const clock = new FakeClock(0);
  let n = 0;
  return { timer: new TimerService(clock, () => `timer-${++n}`), clock };
}

describe('TimerService basics', () => {
  it('starts and reports remaining time', () => {
    const { timer, clock } = makeTimer();
    timer.start({ durationMs: 30_000 });

    expect(timer.remainingMs()).toBe(30_000);
    clock.advance(10_000);
    expect(timer.remainingMs()).toBe(20_000);
  });

  it('reports nothing running before a start', () => {
    const { timer } = makeTimer();
    expect(timer.running).toBe(false);
    expect(timer.view()).toBeNull();
    expect(timer.remainingMs()).toBe(0);
  });

  it('cancels', () => {
    const { timer } = makeTimer();
    timer.start({ durationMs: 5_000 });
    expect(timer.cancel()).not.toBeNull();
    expect(timer.running).toBe(false);
    expect(timer.cancel()).toBeNull();
  });

  it('rejects a non-positive duration', () => {
    const { timer } = makeTimer();
    expect(() => timer.start({ durationMs: 0 })).toThrow(RangeError);
    expect(() => timer.start({ durationMs: -1 })).toThrow(RangeError);
  });

  it('replaces a running timer when a new one starts', () => {
    const { timer, clock } = makeTimer();
    timer.start({ durationMs: 10_000 });
    clock.advance(5_000);
    timer.start({ durationMs: 30_000 });
    expect(timer.remainingMs()).toBe(30_000);
  });
});

describe('TimerService expiry', () => {
  it('expires when the deadline passes', () => {
    const { timer, clock } = makeTimer();
    timer.start({ durationMs: 1_000 });

    expect(timer.expireIfDue()).toBeNull();
    clock.advance(1_000);
    expect(timer.expireIfDue()).not.toBeNull();
  });

  it('reports an expiry exactly once', () => {
    const { timer, clock } = makeTimer();
    timer.start({ durationMs: 1_000 });
    clock.advance(5_000);

    expect(timer.expireIfDue()).not.toBeNull();
    // A deadline stays expired forever; without the once-only guard every
    // later poll would announce the same expiry again.
    expect(timer.expireIfDue()).toBeNull();
    expect(timer.expireIfDue()).toBeNull();
  });

  it('reports a fresh expiry after a new timer', () => {
    const { timer, clock } = makeTimer();
    timer.start({ durationMs: 1_000 });
    clock.advance(1_000);
    expect(timer.expireIfDue()).not.toBeNull();

    timer.start({ durationMs: 1_000 });
    clock.advance(1_000);
    expect(timer.expireIfDue()).not.toBeNull();
  });
});

describe('TimerService pause and resume', () => {
  it('freezes remaining time while paused', () => {
    const { timer, clock } = makeTimer();
    timer.start({ durationMs: 30_000 });
    clock.advance(10_000);

    timer.pause();
    expect(timer.remainingMs()).toBe(20_000);

    // GAME_RULES_LOCKED.md §20 — a long pause must not consume the deadline.
    clock.advance(600_000);
    expect(timer.remainingMs()).toBe(20_000);
  });

  it('continues from the remaining time on resume', () => {
    const { timer, clock } = makeTimer();
    timer.start({ durationMs: 30_000 });
    clock.advance(10_000);
    timer.pause();
    clock.advance(120_000);
    timer.resume();

    expect(timer.remainingMs()).toBe(20_000);
    clock.advance(5_000);
    expect(timer.remainingMs()).toBe(15_000);
  });

  it('never expires while paused with time left', () => {
    const { timer, clock } = makeTimer();
    timer.start({ durationMs: 10_000 });
    clock.advance(4_000);
    timer.pause();

    clock.advance(1_000_000);
    expect(timer.expireIfDue()).toBeNull();
    expect(timer.remainingMs()).toBe(6_000);
  });

  it('survives repeated pause and resume without losing time', () => {
    const { timer, clock } = makeTimer();
    timer.start({ durationMs: 30_000 });

    for (let i = 0; i < 5; i += 1) {
      clock.advance(2_000);
      timer.pause();
      clock.advance(60_000);
      timer.resume();
    }

    // Only the five 2-second running stretches count.
    expect(timer.remainingMs()).toBe(20_000);
  });

  it('treats a second pause as a no-op rather than banking time twice', () => {
    const { timer, clock } = makeTimer();
    timer.start({ durationMs: 30_000 });
    clock.advance(5_000);

    timer.pause();
    clock.advance(10_000);
    timer.pause();
    clock.advance(10_000);
    timer.resume();

    expect(timer.remainingMs()).toBe(25_000);
  });

  it('treats a resume with no pause as a no-op', () => {
    const { timer, clock } = makeTimer();
    timer.start({ durationMs: 10_000 });
    clock.advance(3_000);
    timer.resume();
    expect(timer.remainingMs()).toBe(7_000);
  });

  it('reports an expiry that happened before the pause', () => {
    const { timer, clock } = makeTimer();
    timer.start({ durationMs: 1_000 });
    clock.advance(2_000);
    timer.pause();

    expect(timer.expireIfDue()).not.toBeNull();
  });

  it('pausing and resuming nothing is harmless', () => {
    const { timer } = makeTimer();
    expect(() => {
      timer.pause();
      timer.resume();
    }).not.toThrow();
  });
});
