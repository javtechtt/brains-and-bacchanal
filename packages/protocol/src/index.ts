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
 * Round-specific intents and events — cards, Clash, Market, Maco Mail, wagers,
 * the buzzer — still belong to the phases that implement those behaviours, and
 * several depend on rules open in docs/OPEN_RULES.md.
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
export * from './snapshot.js';
export * from './transport.js';
export * from './benchmark.js';
export * from './health.js';
