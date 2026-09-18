# CLAUDE.md — Brains & Bacchanal

This is the main instruction file for Claude Code.

## Project

**Brains & Bacchanal** is a host-led team party game.

Tagline: **Where knowledge meets foolishness.**

The product will use:
- a web app for player phones and admin,
- an authoritative game server,
- a Unity host display,
- TEST content during development,
- sealed production content later.

## Read Order

Before changing gameplay or architecture, read these files in this order:

1. `docs/GAME_RULES_LOCKED.md`
2. `docs/OPEN_RULES.md`
3. `docs/DECISION_LOG.md`
4. `docs/ARCHITECTURE.md`
5. `docs/DEVELOPMENT_ROADMAP.md`
6. `docs/CONTENT_POLICY.md`
7. `docs/PLAYER_HOST_REFERENCE.md`

Implementation references (generated during development, not rule sources):

- `docs/PROTOCOL.md`
- `docs/STATE_MACHINE.md`
- `docs/LOBBY.md`
- `docs/GAME_ENGINE.md`
- `docs/SHARED_SYSTEMS.md`
- `docs/NETWORK_BENCHMARK.md`
- `docs/UNITY_HOST.md`
- `docs/ROUND_1.md`
- `docs/ROUND_2.md`
- `docs/ROUND_3.md`

These repo files override older PDFs, DOCX files, screenshots, or previous AI-generated plans unless the project owner explicitly says otherwise.

## Most Important Rule

**Do not invent missing game rules.**

If implementation depends on a rule that is listed in `docs/OPEN_RULES.md` or is genuinely undefined:
- stop that rule-dependent part,
- explain the missing decision in simple language,
- ask the project owner,
- continue unrelated work where possible.

Do not choose a rule merely because it is common, easier to code, or seems obvious.

## Clean Start

We are restarting implementation cleanly.

Do not assume previous Codex-generated scaffolding is correct.

If this is an existing repository:
1. inspect it first,
2. report what is reusable,
3. report what conflicts with these docs,
4. preserve useful work,
5. do not delete substantial work without explaining why.

If this is a fresh repository, build from `docs/ARCHITECTURE.md`.

## Server Authority

The server is authoritative for:
- room/session state,
- player/team state,
- BB balances,
- timers,
- card inventory,
- card legality,
- Bacchanal Clash,
- Market,
- Maco Mail,
- wagers,
- Family Feud objective state,
- event ordering,
- pause/resume state,
- reconnect state.

Clients send intents.

Never make React, Unity, or browser code directly decide authoritative outcomes such as:
- who won,
- who buzzed first,
- how much BB to add,
- whether a card is legal,
- whether a wager succeeded.

## Host Authority

The Host decides subjective matters such as:
- whether a spoken answer is valid,
- who spoke first in spoken/no-buzzer challenges when human judgment is required,
- winners of physical/creative games,
- other manual rulings.

Host decisions still go through the server so they are recorded.

## Buzzer Rule

There is **no digital buzzer before Family Feud**.

Do not add digital buzzer logic to:
- Round 1,
- Round 2,
- Think Fast,
- Guess the Logo,
- All Answers Begin With,
- Sing a Song.

Family Feud is the first main game section using the phone buzzer.

Sudden Death may also use the buzzer.

## Content Safety

Normal development uses TEST content only.

Never place production questions, accepted answers, Family Feud boards, or unrevealed challenge secrets in:
- the normal Git repository,
- automated tests,
- logs,
- prompts,
- example fixtures.

`EXAMPLE` and `TEST` content must never later become production sealed content.

See `docs/CONTENT_POLICY.md`.

## Code Architecture Rules

- Keep game rules out of UI components.
- Prefer pure, testable server-side rule functions.
- TypeScript strict mode.
- Use shared, language-neutral protocol schemas where practical.
- Unity should render server state; it should not duplicate game logic.
- Use a deterministic/fake clock for timing tests.
- Use explicit game states and legal transitions.
- State-changing client requests should use intent/idempotency IDs.
- Accepted state-changing events should have sequence numbers and server timestamps.
- Do not trust client clocks.
- Do not introduce Redis unless scale actually requires it.
- Keep realtime transport separate from game rules.

## Networking

**Decided in Phase 3: raw WebSockets (DECISION_LOG.md D-014).**

Production room connections use raw WebSockets at `/room/ws`. Socket.IO remains
installed for benchmark tooling only and must not be used by production code.

Transport-specific code must still sit behind the adapter/interface, so the
decision stays reversible.

## Disconnect Rule

If an active player disconnects:
- gameplay pauses automatically,
- active gameplay timers pause,
- reconnecting does not automatically resume gameplay,
- only the Host can resume,
- the Host may resume with or without the player reconnecting,
- reconnect should restore the same player/team/session where possible.

## Commands

Once the monorepo is created, keep these root commands working:

```bash
pnpm install
pnpm dev
pnpm build
pnpm lint
pnpm test
pnpm typecheck
```

Do not claim a task is complete when relevant checks are failing.

## Task Format

Before a substantial implementation task, summarize it as:

```text
TASK:
SOURCE:
IN SCOPE:
OUT OF SCOPE:
ACCEPTANCE:
```

Then implement.

## Completion Report

After each major task, report:
1. what you inspected,
2. files created,
3. files changed,
4. architecture decisions made,
5. tests/checks run,
6. results,
7. anything intentionally left unfinished,
8. any rule decision still needed,
9. recommended next task.

## Current Phase

**Phases 1–6 are complete. Phase 7A (Round 2), Phase 7B (Round 3), Phase 7C
(Round 1), Phase 7D-A/7D-A2 (Round 4 engine + server wiring), Phase 7D-B
(Round 4 Unity Host + player clients) and Phase 7D-B1/7D-B2 (live-play Host
controls + Sudden Death) are complete.**

- Phase 1 — Project Foundation
- Phase 2 — Protocol + Generic Game State
- Phase 3 — Realtime Transport Comparison (closed: raw WebSockets, D-014)
- Phase 4 — Rooms, Players, Teams & Reconnect (`docs/LOBBY.md`)
- Phase 5 — Generic Authoritative Engine (`docs/GAME_ENGINE.md`)
- Phase 6 — Shared Systems (`docs/SHARED_SYSTEMS.md`)
- Phase 7A — Round 2, "Shake Up Yuhself!" (`docs/ROUND_2.md`)
- Phase 7B — Round 3 (`docs/ROUND_3.md`)
- Phase 7C — Round 1, "Nah, That Too Easy!" (`docs/ROUND_1.md`)
- Phase 7D-A / 7D-A2 — Round 4, "Family Feud" engine, content seam and
  production server/room wiring (`GAME_RULES_LOCKED.md` §19-§20, D-008, D-033)
- Phase 7D-B — Round 4 Unity Host panel and player web clients
- Phase 7D-B1 — Live-play Host controls: Host-started board/steal/opponent-
  chance timers, Host-visible board for live spoken answers, a Host-chosen
  strike ceiling, and free Host jurisdiction over strikes mid-game
- Phase 7D-B2 — Sudden Death (`GAME_RULES_LOCKED.md` §21, **replaced** by
  D-034 during live playtesting — see that decision before touching §21)

Next is **Phase 7D-C** (Round 1 → Round 2 → Round 3 → Round 4 → Sudden Death
progression wiring, and the still-open 3-team FIRST→FINAL matchup advance
control — see below) from `docs/DEVELOPMENT_ROADMAP.md`.
**Do not begin it without the project owner asking.**

Do not jump ahead to full gameplay.

Do not build production content.

Do not finalize any rule listed in `docs/OPEN_RULES.md`.

### Phase 7D-A / 7D-A2 / 7D-B / 7D-B1 / 7D-B2 leave these deliberately undecided

Round 4 ("Family Feud") and Sudden Death are implemented and playable through
the production server, Unity Host and player web clients — engine, room
wiring, content seam, and functional (not Phase 8-polished) UI on both ends.

**Genuinely unresolved, and not to be invented:**

- **The 3-team FIRST → FINAL matchup advance.** `Round4.decideFirstMatchup`
  and `Round4.beginRound4FinalMatchup` exist and are tested at the engine
  layer, but **no room intent, Host button, or player control calls them**.
  A 3-team game correctly seats and displays the FIRST matchup (entering-2nd
  vs entering-3rd, entering-1st shown "sitting out"), but nothing currently
  lets the Host actually decide that matchup and advance to the FINAL one.
  This is the next piece of wiring, not a rule question.
- **Bacchanal cards in Round 4 and Sudden Death remain untested end-to-end**
  by the project owner. The server-side card eligibility
  (`CARD_ELIGIBILITY.FAMILY_FEUD_Q1_Q3` / `FAMILY_FEUD_Q4_Q5` /
  `SUDDEN_DEATH: []`) and Steups!/Forgive Meh! integration are implemented
  and covered by automated tests, but have not been exercised live.
- **A production content pipeline.** The `Round4ContentSource` and
  `SuddenDeathContentSource` seams exist and TEST content fills them; the
  Host never types survey or Sudden Death question content.
- **Round 1 → 2 → 3 → 4 → Sudden Death progression is not wired end to end.**
  Round 4 and Sudden Death are each reachable only through their own
  development-gated entry point (`DEV_START_ROUND4`,
  `HOST_BEGIN_SUDDEN_DEATH`); completing an earlier round does not yet
  automatically advance into the next.
- **Sudden Death's own answer-window duration** is configuration-driven
  (defaulted to 3 seconds, reusing Round 4's own locked face-off window) but
  not independently locked — see `OPEN_RULES.md` §11 and D-034.

**Standing note — D-034 replaced a locked rule.** `GAME_RULES_LOCKED.md` §21
originally locked an individual-question, first-to-two-consecutive-correct-
answers format for Sudden Death. The project owner replaced it with a
face-off sequence (same mechanic as §19) during live playtesting. This is
recorded as a genuine rule REPLACEMENT in `DECISION_LOG.md` D-034, not a
silent edit — read it before touching Sudden Death's rules again.

### Phase 5 leaves these deliberately undecided

The engine is generic on purpose. It does not define any challenge duration, does
not give timer expiry a meaning (D-022: a timeout is **not** a wrong answer), does
not constrain `challengeType`, and does not decide what a round contains. Phase 7
supplies those from locked rules — not from the engine's shape.

The mid-game **Host disconnect** rule is still open: connection loss is recorded
and play is left exactly as it was.

### Phase 7C leaves these deliberately undecided

Round 1 is implemented and **fully locked** (`GAME_RULES_LOCKED.md` §11, D-030,
D-032). Two totals are kept strictly separate — BB is the game's score, Round 1
points decide only the Round 1 winner — and the correct answer is revealed only
after grading, Host review and any retry complete.

Still undecided, and not to be invented:

- **Bacchanal cards in the Round 1 sudden-death tiebreaker**
  (`OPEN_RULES.md` §14). No locked source addresses them, so they are
  **unavailable** there rather than given a guessed rule.
- **An AI provider.** The repository has no provider decision and Phase 7C did
  not make one by default. `AnswerSemanticJudge` is vendor-neutral, the default
  refuses to guess, and tests use a deterministic stub. Round 1 is fully
  playable with no AI — the Host simply rules more often.
- **A production content pipeline.** The `Round1ContentSource` seam exists and
  TEST content fills it; the Host never types a question (§13).

### Phase 7B leaves these deliberately undecided

Round 3 is implemented. Three counters are kept strictly separate — challenge
points decide one challenge, a challenge-win counter decides the round, and BB
is the game's score (`GAME_RULES_LOCKED.md` §13). Five logos is ONE round win,
not five, and not BB.

Still undecided, and not to be invented:

- **The Think Fast answer timer**, and what a timeout means there
  (`OPEN_RULES.md` §2). Nothing starts a Think Fast timer, and a timeout hands
  the challenge to the Host rather than eliminating anyone (D-022).
- **What Double It means for a counter.** It doubles BB, one per challenge, as
  always. Where a Round 3 challenge pays no BB it has nothing to double, and it
  is NOT given a counter meaning.
- **BB for winning Round 3.** No locked rule grants any.
- **A production content pipeline.** The `Round3ContentSource` seam exists and
  TEST content fills it; the Host never types challenge content (§13).

### Phase 7A leaves these deliberately undecided

Round 2 is implemented, and the physical games stay **outside the software**
(D-003) — no rule, duration, score, sensor or automatic winner exists anywhere
for Bottle Battle, Match Makers, Grabbers or Bombers. The Host watches the game
and picks the winner; the server pays the configured 500 BB (or 1,000 with a
legally played Double It).

Still undecided, and not to be invented:

- **A Round 2 tie.** No locked rule says what a drawn physical game does, so a
  result requires exactly one winner and a confirmation without one is refused.
  It is never silently resolved.
- **Clue, Extra Time and Second Chance during a physical challenge.** What they
  would mean is undefined, so they are left disabled for Round 2 rather than
  guessed. They are still sellable, and still work where they do apply.
- **Round 1.** Implemented in Phase 7C (`docs/ROUND_1.md`). Round 2 is still
  reached by a development-gated entry; wiring Round 1's completion into Round 2
  is Phase 7D's work.
- **Round 3.** Round 2 stops at `ROUND_COMPLETE`.
- **A physical-challenge pause rule.** Round 2 marks nobody an active player, so
  a phone that sleeps mid-challenge does not stop the game (D-021).

### Phase 6 leaves these deliberately undecided

The shared systems track ownership, legality, timing and consumption. They do
**not** decide what any effect is worth — a round supplies the base reward and
the shared system applies the allowed multiplier. No challenge duration is
defined except the Clash's locked 3 seconds.

The generic wager is a primitive with **no Family Feud board**, deliberately.

### Standing note on Maco! (OPEN_RULES.md §7) — RESOLVED AND IMPLEMENTED

**D-030: Maco! is legal in Round 1 trivia, and only there.** Phase 7C added the
`CARD_ELIGIBILITY.ROUND1_TRIVIA` entry, and the Phase 6 tests that pinned the
open rule were **inverted rather than deleted** — they now pin the resolved
value.

**A consequence worth knowing.** The same decision removed Gimme Dat! and Doh
Know from Round 1, and no other locked row lists them, so
`CARDS_WITHOUT_LEGAL_CHALLENGE` is now `['GIMME_DAT', 'DOH_KNOW']` rather than
empty. That is a real result of Round 1 dropping individually assigned
questions, not an oversight. Family Feud and Round 4 may give them a row; until
then they are dealt and held, unplayable, exactly as Maco! was.

### Standing note on Partner, I Sorry (OPEN_RULES.md §12)

Resolves normally when the payer holds **500 BB or more**. Below that the rule
runs out, so the card is **blocked, not resolved** — `blocked_open_rule`, with no
BB moved on either side (D-027). It is deliberately not treated as a dud, which
is a locked outcome with consequences. Do not invent the under-500 behaviour.
