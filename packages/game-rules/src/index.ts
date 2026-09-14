/**
 * @bb/game-rules — pure, testable game rule functions.
 *
 * CLAUDE.md — "Keep game rules out of UI components. Prefer pure, testable
 * server-side rule functions."
 *
 * This package stays pure: no I/O, no transport, no framework, no wall-clock
 * reads. ESLint enforces those bans (see eslint.config.mjs).
 *
 * Phase 2 scope: the deterministic clock, pausable deadlines, the centralised
 * phase-transition system, the event log, intent deduplication, and a minimal
 * in-memory session that proves they work together.
 *
 * The rules engine proper — cards and Clash, the BB ledger, Market, Maco Mail,
 * round logic — belongs to Phases 5-7. Several of those rules remain unresolved
 * in docs/OPEN_RULES.md and must not be implemented until decided.
 */

export * from './clock.js';
export * from './deadline.js';
export * from './bb.js';
export * from './transitions.js';
export * from './event-log.js';
export * from './idempotency.js';
export * from './session.js';
