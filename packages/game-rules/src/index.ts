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
 * Phase 4 added the production lobby (room.ts, room-store.ts). Phase 5 adds the
 * generic authoritative engine: the BB ledger, the timer service and the
 * GameEngine that owns phase, challenge, turn, active players and pause.
 *
 * Still out: cards and Clash, the Market, Maco Mail, Host Deals, wagers and
 * every round's rules. Those belong to Phases 6-7, and several remain
 * unresolved in docs/OPEN_RULES.md and must not be implemented until decided.
 */

export * from './clock.js';
export * from './deadline.js';
export * from './bb.js';
export * from './transitions.js';
export * from './event-log.js';
export * from './idempotency.js';
export * from './session.js';
export * from './room.js';
export * from './room-store.js';
export * from './bb-ledger.js';
export * from './timer-service.js';
export * from './game-engine.js';
