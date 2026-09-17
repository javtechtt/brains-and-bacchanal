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

## Phase 7 — Rounds ◀ IN PROGRESS

### Round 1 — rules locked, NOT implemented

**The rules are now fully locked** (D-030, `GAME_RULES_LOCKED.md` §11): 15
questions (5/5/5), all teams answering the same question simultaneously, 60
seconds each, Easy 20 / Medium 30 / Hard 50 awarded as BB *and* as separate
Round 1 points. Card compatibility is Maco!, Double It!, ALLYUH HELP ME!,
FORGIVE MEH!

`OPEN_RULES.md` §1 and §7 are **resolved**. One narrow item remains: the
FORGIVE MEH! retry-window duration (§13).

**No code exists yet.** Round 2 therefore still has a development-gated entry
(`DEV_START_ROUND2`) rather than a production path, and `CARD_ELIGIBILITY` still
has no MACO entry — a Phase 6 test asserts Maco is unplayable and will fail when
one is added, which is the intended signal.

### Round 2 ✅ COMPLETE (Phase 7A)

Built:
- the four locked physical challenges in their documented order,
- 500 BB per challenge, from one configured constant,
- the two-step Host winner flow (select, then confirm) — the server computes
  every number,
- Double It only, through the existing Phase 6 eligibility table,
- the ×2 multiplier through the existing shared budget — 1,000 BB is written
  nowhere,
- the Phase 6 Market at its locked Round 2 prices,
- Round 2 state on both snapshots, the Unity Host view and the player screen,
- a development-only entry, because Round 1 does not exist.

All implemented and **verified on real hardware**: Unity Host, two real phones
on the LAN, the compiled server, all four challenges, Double It, round
completion and a mid-round reconnect. See `docs/ROUND_2.md`.

The physical test earned its place — it found a bug every automated test had
missed, where an awarded balance did not reach either client's screen until the
next challenge began.

Not included, deliberately: any physical rule, duration, score or automatic
winner (D-003); any tie behaviour (no locked rule — a result requires one
winner); Clue, Extra Time and Second Chance effects during a physical challenge
(undefined, so left disabled rather than guessed); durable storage; and any rule
for a mid-game Host disconnect.

Deferred to Phase 8, not forgotten: the Host still drives the round through the
raw engine phases (`CHALLENGE_INTRO`, prepare, begin, open card window) rather
than one "start the challenge" control. That is a test instrument, not the
intended Host experience.

**Nothing in `OPEN_RULES.md` was resolved.** Maco! is still unplayable (§7), and
Round 1's allocation (§1) is what forced the development entry.

### Round 3 — rules locked, NOT implemented ◀ NEXT

**The rules are now locked** (D-031, `GAME_RULES_LOCKED.md` §13–§18), closing
`OPEN_RULES.md` §3, §4, §5 and §6:

- four challenges in order: Think Fast, Guess the Logo, All Answers Begin With,
  Sing a Song,
- a **Round 3 challenge-win counter** (+1 per challenge) decides the round;
  BB stays exactly where the locked rules already put it — Think Fast 500,
  Sing a Song 500, the other two none,
- winning Round 3 overall awards **no BB**,
- targets: 5 logos, 5 prompts, 3 songs — but the **Host confirms** the winner and
  may end earlier or later,
- 10-second window per item,
- **Think Fast order comes from the previous round's standings** (most total BB),
  no longer rock-paper-scissors,
- an overall counter tie is broken by **real rock-paper-scissors**, not a Clash,
- the **game supplies challenge content**; the Host does not invent it.

Still open: the Think Fast answer timer and what a timeout means
(`OPEN_RULES.md` §2). Keep it configuration-driven.

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
