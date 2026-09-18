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
 * Phase 6 adds the SHARED SYSTEMS: Bacchanal cards and their eligibility
 * (bacchanal-cards.ts), the Clash and Part Dat Fight (clash.ts), the Market
 * (market.ts), the single stacking/retry budget (advantages.ts), Maco Mail
 * (maco-mail.ts), Host Deals and the generic wager (deals.ts), all coordinated
 * by shared-systems.ts — which also builds the two secrecy-aware views. The
 * deterministic Rng (rng.ts) joins the Clock as an injected dependency, so a
 * deal, a shuffle and a confiscation are all reproducible in tests.
 *
 * Still out: every round's rules. Round 1 allocation, Think Fast, Guess the
 * Logo, Family Feud, Sudden Death and the buzzer belong to Phase 7, and several
 * remain unresolved in docs/OPEN_RULES.md — including Maco!'s eligibility (§7),
 * which is why the card exists here with no legal challenge.
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
export * from './rng.js';
export * from './bacchanal-cards.js';
export * from './clash.js';
export * from './market.js';
export * from './advantages.js';
export * from './maco-mail.js';
export * from './deals.js';
export * from './shared-systems.js';
export * from './round2.js';
export * from './round3.js';
export * from './game-engine.js';
export * from './round1.js';
export * from './round1-content.js';
export * from './round1-grading.js';
export * from './round4.js';
export * from './round4-content.js';
export * from './round4-grading.js';
export * from './sudden-death.js';
export * from './sudden-death-content.js';
