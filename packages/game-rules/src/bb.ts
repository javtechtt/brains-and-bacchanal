/**
 * BB — the game's currency and score.
 *
 * GAME_RULES_LOCKED.md §1 — "BB is both spendable currency and final score."
 * and "BB cannot go below 0."
 *
 * PHASE 1 SCOPE: this file exists to prove the pure-rule-function pattern and
 * the test harness end to end. It contains ONLY the floor-at-zero rule, which
 * is unambiguous and unconditionally locked.
 *
 * The BB ledger itself is Phase 5. Awards, multipliers, Market pricing, wagers
 * and Maco Mail amounts are Phases 5-6. Do not grow this file into the rules
 * engine ahead of those phases.
 */

/** BB cannot go below 0. (GAME_RULES_LOCKED.md §1) */
export const BB_FLOOR = 0;

/**
 * Clamp a BB amount to the floor.
 *
 * Applied wherever a deduction could take a team negative. The rules are
 * explicit that the floor applies rather than allowing debt.
 */
export function clampBb(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new RangeError('BB amount must be a finite number');
  }
  return Math.max(BB_FLOOR, amount);
}
