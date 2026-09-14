import { describe, expect, it } from 'vitest';
import { FakeClock, SystemClock } from './clock.js';

describe('FakeClock', () => {
  it('starts at 0 by default', () => {
    expect(new FakeClock().now()).toBe(0);
  });

  it('starts at the supplied time', () => {
    expect(new FakeClock(1_700_000_000_000).now()).toBe(1_700_000_000_000);
  });

  it('advances only when told to', () => {
    const clock = new FakeClock(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(3_000);
    expect(clock.now()).toBe(4_000);
    // No implicit passage of time: reading twice gives the same answer.
    expect(clock.now()).toBe(4_000);
  });

  it('refuses to move time backwards via advance', () => {
    const clock = new FakeClock(1_000);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(clock.now()).toBe(1_000);
  });

  it('refuses to move time backwards via set', () => {
    const clock = new FakeClock(5_000);
    expect(() => clock.set(4_999)).toThrow(RangeError);
    expect(clock.now()).toBe(5_000);
  });

  it('jumps forward with set', () => {
    const clock = new FakeClock(1_000);
    clock.set(9_000);
    expect(clock.now()).toBe(9_000);
  });

  it('rejects non-finite input', () => {
    expect(() => new FakeClock(Number.NaN)).toThrow(RangeError);
    expect(() => new FakeClock(1).advance(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('SystemClock', () => {
  it('reports a plausible epoch time', () => {
    const now = new SystemClock().now();
    expect(Number.isFinite(now)).toBe(true);
    // Later than 2020-01-01, so we know it is epoch milliseconds not seconds.
    expect(now).toBeGreaterThan(1_577_836_800_000);
  });
});
