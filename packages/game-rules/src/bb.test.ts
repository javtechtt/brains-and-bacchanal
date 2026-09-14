import { describe, expect, it } from 'vitest';
import { BB_FLOOR, clampBb } from './bb.js';

// GAME_RULES_LOCKED.md §1 — "BB cannot go below 0."
describe('clampBb', () => {
  it('leaves positive amounts untouched', () => {
    expect(clampBb(1_000)).toBe(1_000);
  });

  it('leaves zero untouched', () => {
    expect(clampBb(0)).toBe(0);
  });

  it('floors negative amounts at zero', () => {
    expect(clampBb(-1)).toBe(BB_FLOOR);
    expect(clampBb(-2_500)).toBe(BB_FLOOR);
  });

  it('rejects non-finite input', () => {
    expect(() => clampBb(Number.NaN)).toThrow(RangeError);
  });
});
