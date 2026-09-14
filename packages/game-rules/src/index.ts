/**
 * @bb/game-rules — pure, testable game rule functions.
 *
 * CLAUDE.md — "Keep game rules out of UI components. Prefer pure, testable
 * server-side rule functions."
 *
 * This package must stay pure: no I/O, no transport, no framework, no
 * wall-clock reads. ESLint enforces those bans (see eslint.config.js).
 *
 * PHASE 1 SCOPE IS DELIBERATELY MINIMAL: the deterministic Clock abstraction
 * and a single locked rule (BB floor-at-zero) to prove the testing setup.
 *
 * The rules engine proper — card eligibility and Clash, the BB ledger, Market,
 * Maco Mail, challenge state and round logic — belongs to Phases 5-7. Several
 * of those rules are still unresolved in docs/OPEN_RULES.md and must not be
 * implemented until the project owner decides them.
 */

export * from './clock.js';
export * from './bb.js';
