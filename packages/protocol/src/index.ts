/**
 * @bb/protocol — shared contracts between the game server, the web app and the
 * Unity host display.
 *
 * ARCHITECTURE.md §3: schema -> TypeScript types -> C# DTOs.
 *
 * PHASE 1 SCOPE IS DELIBERATELY MINIMAL: the protocol version constant, the
 * health response shape, and enough structure to prove cross-package imports
 * work.
 *
 * The client intent envelope, server event envelope, sequence numbers,
 * idempotency IDs, structured errors, snapshot/reconnect format and game-state
 * messages are all PHASE 2 (see DEVELOPMENT_ROADMAP.md — "Phase 2 — Protocol +
 * Generic Game State"). Do not add them here ahead of that phase.
 */

export * from './version.js';
export * from './health.js';
