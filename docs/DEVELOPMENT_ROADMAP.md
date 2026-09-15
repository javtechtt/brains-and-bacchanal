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

## Phase 5 — Generic Authoritative Engine ◀ NEXT

Build:
- BB ledger,
- timer service,
- challenge state,
- turn ownership,
- Host judgment commands,
- generic results,
- pause/resume,
- snapshots,
- event history,
- recovery commands.

Avoid unresolved round-specific rules.

## Phase 6 — Shared Systems

Build:
- Bacchanal Cards,
- eligibility,
- Clash,
- Part Dat Fight,
- Market,
- Maco Mail,
- advantages,
- Host Deals,
- Family Feud wager primitive.

Do not finalize open Maco / Family Feud card interactions until answered.

## Phase 7 — Rounds

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
