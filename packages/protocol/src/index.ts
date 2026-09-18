/**
 * @bb/protocol — the shared language of the game server, the web clients and
 * the Unity host display.
 *
 * ARCHITECTURE.md §3: schema -> TypeScript types -> C# DTOs.
 *
 * TRANSPORT INDEPENDENCE: nothing in this package imports Socket.IO, ws, the
 * browser WebSocket API, Next.js, React or any Unity type. It describes
 * MESSAGES, not how they travel. CLAUDE.md requires the transport choice to
 * follow the Phase 3 measurement, and that stays possible only while the
 * protocol knows nothing about transports.
 *
 * Phase 2 scope: version, identifiers, envelopes, rejections, lifecycle
 * phases, generic domain models and the snapshot shape.
 *
 * Phase 4 added the production lobby (room.ts): rooms, players, teams and
 * reconnect. Phase 5 adds the generic game engine (game.ts): game start, the BB
 * ledger, generic challenges, turn ownership, timers, Host rulings and the
 * split Host/player game snapshots.
 *
 * Phase 6 adds the SHARED SYSTEMS every round draws on: Bacchanal cards and the
 * Clash (cards.ts), the Market and held advantages (market.ts), Maco Mail
 * (maco-mail.ts), Host Deals and the generic wager (deals.ts), and the intents,
 * events and secrecy-aware views that tie them together (shared-systems.ts).
 *
 * Phase 7A adds the FIRST REAL ROUND (round2.ts): the four locked physical
 * challenges, their order, the 500 BB base reward and the Host winner flow.
 * It adds no physical rule — D-003 keeps those outside the app entirely.
 *
 * Still NOT here: Round 1, Round 3, Round 4. No question allocation, no Family
 * Feud board, no buzzer, no Sudden Death. Several of those depend on rules open
 * in docs/OPEN_RULES.md — including Maco!'s challenge compatibility (§7), which
 * is why cards.ts models the card but never gives it a legal challenge.
 */

export * from './version.js';
export * from './ids.js';
export * from './errors.js';
export * from './envelope.js';
export * from './lifecycle.js';
export * from './models.js';
export * from './room.js';
export * from './room-code.js';
export * from './game.js';
export * from './cards.js';
export * from './market.js';
export * from './maco-mail.js';
export * from './deals.js';
export * from './shared-systems.js';
export * from './round2.js';
export * from './round3.js';
export * from './snapshot.js';
export * from './transport.js';
export * from './benchmark.js';
export * from './health.js';
export * from './round1.js';
export * from './round4.js';
export * from './sudden-death.js';
