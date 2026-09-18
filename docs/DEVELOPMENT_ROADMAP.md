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

### Round 1 ✅ COMPLETE (Phase 7C)

Built:
- 15 questions (5 Easy / 5 Medium / 5 Hard), every team answering the **same**
  question simultaneously, 60 seconds each,
- **two totals from one correct answer** — BB to the main balance, and a
  separate Round 1 point total that decides the round winner,
- difficulty nominees stored as **player ids**, with the server refusing a
  submission from anyone else,
- a **hybrid grading pipeline**: normalisation, canonical/variant match, a
  conservative Damerau-Levenshtein typo tolerance, then an AI semantic judge
  only for what those cannot decide, then the Host,
- **the reveal last** — the canonical answer is withheld from players *and the
  Host* until grading, review and any retry have completed,
- Maco!, Double It!, ALLYUH HELP ME! and FORGIVE MEH! through the existing
  Phase 6 card systems, with the 10-second retry window D-032 locked,
- a **sudden-death trivia tiebreaker** that moves no BB and adds no points,
  kept architecturally distinct from §21's end-of-game Sudden Death,
- Round 1 state on both snapshots, the Unity Host panel and the player screen,
- **entry through the real progression** — Round 1 begins when the game starts,
  because it is the first round. `DEV_START_ROUND1` exists for isolated testing
  only.

`OPEN_RULES.md` §13 is **resolved** (D-032), so Round 1 is fully locked.
`CARD_ELIGIBILITY.ROUND1_TRIVIA` now lists MACO, and the Phase 6 tests that
asserted it was unplayable were **inverted rather than deleted**.

Verified: 1021 tests, a 30/30 compiled-server walkthrough, a 41/41 Unity
headless check with zero compile errors, every earlier Unity check unchanged,
and an IL2CPP standalone build with 0 errors and 0 warnings.

**Physical testing is still outstanding** — see `docs/ROUND_1.md`.

Not included, deliberately: an AI provider adapter (no provider decision exists,
and Phase 7C did not make one by default); Bacchanal cards in the tiebreaker
(no locked source addresses them — `OPEN_RULES.md` §14); and a production
content pipeline.

Still deferred, and now the obvious next piece of work: **Round 1's completion
does not yet feed Round 2.** Round 2 and Round 3 keep their development-gated
entries.

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

**Nothing in `OPEN_RULES.md` was resolved by Phase 7A.** Maco! was still
unplayable then (§7, since resolved by D-030), and Round 1's absence is what
forced the development entry — which still stands until Round 1's completion is
wired into Round 2.

### Round 3 ✅ COMPLETE (Phase 7B)

Built:
- four challenges in the locked order: Think Fast, Guess the Logo, All Answers
  Begin With, Sing a Song,
- a **challenge-win counter** that decides the round, kept strictly separate
  from challenge points and from BB,
- BB exactly where the locked rules put it — Think Fast 500, Sing a Song 500,
  the other two none; winning the round pays none,
- Host discretion: targets of 5/5/3 are hints, and the Host confirms every
  challenge winner before or after them,
- Think Fast elimination with turn order from the previous round's standings,
- a **content source** seam — the game supplies every topic, logo, letter and
  scenario; the Host never types content,
- the **rock-paper-scissors tiebreaker** (§18), hidden until every tied team has
  chosen, and explicitly not a Bacchanal Clash,
- Round 3 state on both snapshots, the Unity Host view and the player screen,
- a development-only entry, because Rounds 1 and 2 may not have been played.

All implemented. See `docs/ROUND_3.md`.

Not included, deliberately: the Think Fast answer timer and the meaning of a
timeout (`OPEN_RULES.md` §2 — still open); any counter meaning for Double It (no
rule defines one); BB for winning the round; a production content pipeline (the
seam exists, TEST content fills it); any audio, music or logo recognition.

### Round 4

**Rules are locked** (D-033, `GAME_RULES_LOCKED.md` §19-§20). **Implemented**
(Phase 7D-A / 7D-A2 / 7D-B / 7D-B1) — engine, production server/room wiring,
Unity Host panel and player web client:
- Family Feud face-off (buzzer opens while the Host reads; 3-second answer;
  #1-answer-wins-outright or opponent gets one higher-ranked shot),
- normal board play (turn order, no conferring, 5-second timer, strikes),
- steal (30 seconds, existing custom wager up to 50% of current BB),
- three-team progression (D-008, unchanged) — the FIRST matchup (entering-2nd
  vs entering-3rd) is seated and displayed correctly; **the FIRST → FINAL
  matchup advance has no Host control yet** (`Round4.decideFirstMatchup` /
  `beginRound4FinalMatchup` exist and are tested, but nothing calls them from
  a room intent),
- Q4/Q5 doubled,
- Steups!, FORGIVE MEH! and inactive-third-team card behavior, now locked and
  wired (not yet exercised live by the project owner),
- live-play Host controls added in 7D-B1: Host-started (not automatic)
  board-turn/steal/opponent-chance timers, a Host-cancellable board timer, a
  Host-chosen strike ceiling, free Host jurisdiction over strikes at any
  time, and the Host's own snapshot showing the full board (never leaked to
  players or into any broadcast event) so the Host can run the round live
  against spoken answers.

`OPEN_RULES.md` §8, §9 and §10 are resolved; nothing here is still waiting on
them. See `CLAUDE.md`'s "Phase 7D-A / 7D-A2 / 7D-B / 7D-B1 / 7D-B2 leave these
deliberately undecided" for the current gap list.

### Sudden Death

**Implemented** (Phase 7D-B2) — engine, room wiring, Unity Host panel and
player web client. **D-034 replaced** the format this section originally
pointed at (individual questions, first to two consecutive correct answers)
with a face-off sequence, decided during live playtesting — read D-034 before
touching this again:
- a face-off sequence (same mechanic as §19's own face-off — buzzer opens
  while the Host reads, first valid buzz locks out the other side, a timed
  answer window),
- the #1 board answer wins a face-off outright; anything else (wrong, or a
  buzz-then-timeout) loses that face-off IMMEDIATELY — no opponent's-chance
  fallback,
- neither side answering validly decides nothing; the Host reveals a fresh
  face-off,
- first team to win two face-offs **in a row** (a loss resets the streak)
  wins Sudden Death and the game,
- no Market, Maco Mail, Bacchanal Cards, advantages, wagers or multipliers
  (§21, unchanged by D-034),
- the Host can trigger Sudden Death at **any point**, naming any two teams —
  not gated behind a genuine BB tie, per the project owner's explicit request.

Not locked: the exact answer-window duration (configuration-driven, defaulted
to Round 4's own 3 seconds — `OPEN_RULES.md` §11).

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
