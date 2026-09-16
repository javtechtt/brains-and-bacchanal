import { describe, expect, it } from 'vitest';
import { asTeamId, type TeamId } from '@bb/protocol';
import { BbLedger } from './bb-ledger.js';
import { FakeClock } from './clock.js';
import { STARTING_BB } from './bb.js';

/**
 * BB ledger — GAME_RULES_LOCKED.md §1.
 *
 * The rules under test are locked and unambiguous: teams start at 1,000, BB is
 * currency and score, and it can never go below 0. Nothing here asserts an
 * award amount for any round, because no round's scoring is implemented and
 * several remain open.
 */

const TEAM_A = asTeamId('TEAM_A');
const TEAM_B = asTeamId('TEAM_B');

function makeLedger(): { ledger: BbLedger; clock: FakeClock } {
  const clock = new FakeClock(1_000);
  let n = 0;
  return { ledger: new BbLedger(clock, () => `entry-${++n}`), clock };
}

describe('BbLedger seeding', () => {
  it('seeds each team with exactly 1,000 BB', () => {
    const { ledger } = makeLedger();
    ledger.seed(TEAM_A);
    ledger.seed(TEAM_B);

    expect(ledger.balanceOf(TEAM_A)).toBe(1_000);
    expect(ledger.balanceOf(TEAM_B)).toBe(1_000);
    expect(STARTING_BB).toBe(1_000);
  });

  it('records the starting balance as a ledger entry, not a bare number', () => {
    const { ledger } = makeLedger();
    ledger.seed(TEAM_A);

    const entries = ledger.entriesFor(TEAM_A);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reason).toBe('game_start');
    expect(entries[0]?.balanceBefore).toBe(0);
    expect(entries[0]?.balanceAfter).toBe(1_000);
  });

  it('refuses to seed the same team twice', () => {
    const { ledger } = makeLedger();
    expect(ledger.seed(TEAM_A)).not.toBeNull();
    // A duplicate START_GAME must never be able to double a balance.
    expect(ledger.seed(TEAM_A)).toBeNull();
    expect(ledger.balanceOf(TEAM_A)).toBe(1_000);
  });
});

describe('BbLedger arithmetic', () => {
  it('awards and deducts', () => {
    const { ledger } = makeLedger();
    ledger.seed(TEAM_A);

    ledger.apply({ teamId: TEAM_A, delta: 500, reason: 'challenge_result' });
    expect(ledger.balanceOf(TEAM_A)).toBe(1_500);

    ledger.apply({ teamId: TEAM_A, delta: -300, reason: 'challenge_result' });
    expect(ledger.balanceOf(TEAM_A)).toBe(1_200);
  });

  it('floors at 0 rather than going negative', () => {
    const { ledger } = makeLedger();
    ledger.seed(TEAM_A);

    const outcome = ledger.apply({ teamId: TEAM_A, delta: -5_000, reason: 'challenge_result' });

    expect(ledger.balanceOf(TEAM_A)).toBe(0);
    expect(outcome.clamped).toBe(true);
    // The requested amount and the applied amount differ exactly here, which is
    // what makes a clamped deduction visible instead of silent.
    expect(outcome.entry.delta).toBe(-5_000);
    expect(outcome.entry.applied).toBe(-1_000);
  });

  it('runs the spec example: 300 - 500 = 0, never -200', () => {
    const { ledger } = makeLedger();
    ledger.seed(TEAM_A, 300);

    ledger.apply({ teamId: TEAM_A, delta: -500, reason: 'challenge_result' });

    expect(ledger.balanceOf(TEAM_A)).toBe(0);
    expect(ledger.balanceOf(TEAM_A)).not.toBe(-200);
  });

  it('keeps team balances independent', () => {
    const { ledger } = makeLedger();
    ledger.seed(TEAM_A);
    ledger.seed(TEAM_B);

    ledger.apply({ teamId: TEAM_A, delta: 500, reason: 'challenge_result' });
    ledger.apply({ teamId: TEAM_B, delta: -100, reason: 'challenge_result' });

    expect(ledger.balanceOf(TEAM_A)).toBe(1_500);
    expect(ledger.balanceOf(TEAM_B)).toBe(900);
  });

  it('does not mark an ordinary deduction as clamped', () => {
    const { ledger } = makeLedger();
    ledger.seed(TEAM_A);
    const outcome = ledger.apply({ teamId: TEAM_A, delta: -100, reason: 'challenge_result' });
    expect(outcome.clamped).toBe(false);
    expect(outcome.entry.applied).toBe(-100);
  });

  it('rejects a non-finite delta', () => {
    const { ledger } = makeLedger();
    ledger.seed(TEAM_A);
    expect(() => ledger.apply({ teamId: TEAM_A, delta: Number.NaN, reason: 'host_adjustment' })).toThrow(
      RangeError,
    );
  });
});

describe('BbLedger history', () => {
  it('keeps every change as a separate entry, in order', () => {
    const { ledger, clock } = makeLedger();
    ledger.seed(TEAM_A);
    clock.advance(10);
    ledger.apply({ teamId: TEAM_A, delta: 500, reason: 'challenge_result' });
    clock.advance(10);
    ledger.apply({ teamId: TEAM_A, delta: -300, reason: 'challenge_result' });
    clock.advance(10);
    ledger.apply({ teamId: TEAM_A, delta: -5_000, reason: 'challenge_result' });

    const entries = ledger.entriesFor(TEAM_A);
    expect(entries.map((entry) => entry.balanceAfter)).toEqual([1_000, 1_500, 1_200, 0]);
    // Each entry timestamped from the injected clock, never Date.now().
    expect(entries.map((entry) => entry.at)).toEqual([1_000, 1_010, 1_020, 1_030]);
  });

  it('explains every change: team, delta, applied, result, reason', () => {
    const { ledger } = makeLedger();
    ledger.seed(TEAM_A);
    const outcome = ledger.apply({
      teamId: TEAM_A,
      delta: -250,
      reason: 'host_adjustment',
      note: 'test',
    });

    const entry = outcome.entry;
    expect(entry.teamId).toBe(TEAM_A);
    expect(entry.delta).toBe(-250);
    expect(entry.applied).toBe(-250);
    expect(entry.balanceBefore).toBe(1_000);
    expect(entry.balanceAfter).toBe(750);
    expect(entry.reason).toBe('host_adjustment');
    expect(entry.note).toBe('test');
  });

  it('links an entry to the event that carried it', () => {
    const { ledger } = makeLedger();
    const outcome = ledger.seed(TEAM_A);
    expect(outcome?.entry.seq).toBeNull();

    ledger.attachSeq(outcome!.entry.entryId, 7 as never);
    expect(ledger.entriesFor(TEAM_A)[0]?.seq).toBe(7);
  });

  it('reports 0 for a team that was never seeded', () => {
    const { ledger } = makeLedger();
    expect(ledger.balanceOf('TEAM_C' as TeamId)).toBe(0);
    expect(ledger.has('TEAM_C' as TeamId)).toBe(false);
  });
});
