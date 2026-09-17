# Brains & Bacchanal — Development Roadmap

Keep Claude Code working in small, verifiable stages.

## Phase 1 — Project Foundation ✅ COMPLETE

Build:
- pnpm monorepo,
- `apps/web`,
- `apps/game-server`,
- `packages/protocol`,
- `packages/game-rules`,
- `packages/ui-tokens`,
- `content/test-only`,
- Unity host project/folder,
- TypeScript strict mode,
- linting/formatting,
- test runner,
- `.env.example`,
- logging,
- CI-friendly scripts,
- deterministic fake clock,
- game-server `/health`,
- simple web health check.

Do not implement actual rounds yet.

### Exit
These root commands pass:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Phase 2 — Protocol + Generic Game State ✅ COMPLETE

Define/build:
- room/session model,
- player/team model,
- server event envelope,
- client intent envelope,
- sequence numbers,
- server timestamps,
- idempotency IDs,
- structured errors,
- snapshot/reconnect format,
- pause/resume,
- generic game states.

No detailed rounds yet.

## Phase 3 — Realtime Transport Comparison ✅ COMPLETE

Build equivalent minimal prototypes with:
- Socket.IO,
- raw WebSockets.

Measure:
- latency,
- jitter,
- ordering,
- reconnect,
- timer sync,
- Family Feud-style buzzer acceptance,
- multiple phones,
- LAN,
- cloud,
- Unity stability.

No buzzers in Rounds 1–3.

Select transport only after measurement.

## Phase 4 — Lobby / Room / Teams ✅ COMPLETE

Build:
- Host room creation,
- short room code,
- QR join,
- player names,
- reconnect token,
- team assignment,
- Host team management,
- team lock,
- connection state,
- 2-team / 3-team setup.

All implemented. See `docs/LOBBY.md` for behaviour and the LAN test procedure.

Not included, deliberately: durable room storage (in-memory only — a server
restart destroys active rooms), lobby auto-pause (no gameplay to pause yet), any
disconnect timeout, and any rule for a mid-game Host disconnect.

## Phase 5 — Generic Authoritative Engine ✅ COMPLETE

Built:
- BB ledger (floor at zero, full history),
- timer service,
- generic challenge state and lifecycle,
- turn ownership and the active-player model,
- Host judgment commands,
- generic results,
- production auto-pause on an active player's disconnect (D-011),
- split Host/player game snapshots,
- event history and reconnect recovery.

All implemented. See `docs/GAME_ENGINE.md`.

Not included, deliberately: durable storage (in memory only — a server restart
now destroys balances and the ledger as well as the room), any round, and any
rule for a mid-game Host disconnect. Nothing in `OPEN_RULES.md` was resolved.

## Phase 6 — Shared Systems ✅ COMPLETE

Built:
- Bacchanal Cards: ownership, the locked starting deal, lifecycle,
- the approved eligibility table, configuration-driven,
- the Bacchanal Clash with its locked 6-second hidden window,
- Part Dat Fight, all five locked cases,
- the Market: locked prices, hidden shopping, reveal, expiry, surcharges,
- Maco Mail: the 20-card deck, draw without replacement, the dud rule,
- held advantages and one centralised retry/multiplier/stacking budget,
- Host Deals from the four locked templates, one per round,
- the generic wager primitive (not connected to any board),
- secrecy-aware Host and player views, and reconnect for all of it.

All implemented. See `docs/SHARED_SYSTEMS.md`.

Not included, deliberately: durable storage (still in memory only), any round,
and any rule for a mid-game Host disconnect.

**Nothing in `OPEN_RULES.md` was resolved.** Three entries visibly shaped the
result: Maco! exists and is dealt but has no legal challenge (§7); Steups is a
generic effect with no Family Feud board behaviour (§8); Partner, I Sorry
resolves at ≥500 BB and is blocked below it (§12).

## Phase 7 — Rounds ◀ NEXT

### Round 1
Wait for final question allocation before hard-coding sequence.

### Round 2
Host winner → server awards 500 BB.

### Round 3
Implement locked parts:
- Think Fast,
- Guess the Logo,
- configurable All Answers Begin With,
- Host-judged Sing a Song.

Do not invent open timers/scoring.

### Round 4
Implement:
- Family Feud,
- digital buzzer,
- strikes/control/steal,
- three-team progression,
- Q4/Q5 doubled,
- wager.

Wait for open Steups/FORGIvE MEH interactions before finalizing those pieces.

### Sudden Death
Implement locked streak/immediate-loss rules.

## Phase 8 — Unity Presentation / Tutorials

After game logic works:
- branded scenes,
- scoreboard,
- round intros,
- challenge screens,
- Family Feud board,
- Market,
- Maco Mail,
- Clash,
- Part Dat Fight,
- winner screens,
- sound,
- animation,
- progressive tutorials.

## Phase 9 — QA / Balance / Release

Test:
- real phones,
- mixed iOS/Android,
- 2-team and 3-team,
- weak Wi-Fi,
- sleep/wake,
- reconnect,
- LAN without internet,
- cloud,
- balance,
- content secrecy,
- recovery/admin actions.

Then:
- seal production content,
- create release candidate,
- package Unity host,
- deploy web/server,
- configure backups/monitoring.
