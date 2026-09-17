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
- `docs/ROUND_2.md`

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

**Phases 1–6 are complete, and Phase 7A (Round 2) is complete.**

- Phase 1 — Project Foundation
- Phase 2 — Protocol + Generic Game State
- Phase 3 — Realtime Transport Comparison (closed: raw WebSockets, D-014)
- Phase 4 — Rooms, Players, Teams & Reconnect (`docs/LOBBY.md`)
- Phase 5 — Generic Authoritative Engine (`docs/GAME_ENGINE.md`)
- Phase 6 — Shared Systems (`docs/SHARED_SYSTEMS.md`)
- Phase 7A — Round 2, "Shake Up Yuhself!" (`docs/ROUND_2.md`)

Next is **Phase 7B** from `docs/DEVELOPMENT_ROADMAP.md`.
**Do not begin it without the project owner asking.**

Do not jump ahead to full gameplay.

Do not build production content.

Do not finalize any rule listed in `docs/OPEN_RULES.md`.

### Phase 5 leaves these deliberately undecided

The engine is generic on purpose. It does not define any challenge duration, does
not give timer expiry a meaning (D-022: a timeout is **not** a wrong answer), does
not constrain `challengeType`, and does not decide what a round contains. Phase 7
supplies those from locked rules — not from the engine's shape.

The mid-game **Host disconnect** rule is still open: connection loss is recorded
and play is left exactly as it was.

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
- **Round 1.** It is not implemented, and no production rule lets a game skip it.
  Round 2 is reached by a development-gated entry only.
- **Round 3.** Round 2 stops at `ROUND_COMPLETE`.
- **A physical-challenge pause rule.** Round 2 marks nobody an active player, so
  a phone that sleeps mid-challenge does not stop the game (D-021).

### Phase 6 leaves these deliberately undecided

The shared systems track ownership, legality, timing and consumption. They do
**not** decide what any effect is worth — a round supplies the base reward and
the shared system applies the allowed multiplier. No challenge duration is
defined except the Clash's locked 3 seconds.

The generic wager is a primitive with **no Family Feud board**, deliberately.

### Standing note on Maco! (OPEN_RULES.md §7) — NOW RESOLVED

**D-030: Maco! is legal in Round 1 trivia, and only there.** The deferral that
stood since Phase 4 is closed.

**The code has not caught up, deliberately.** `CARD_ELIGIBILITY.ROUND1_TRIVIA`
still has no MACO entry, because Round 1 is not implemented and Phase 7B is
Round 3. When Round 1 is built:

- add `MACO` to that row — `CARDS_WITHOUT_LEGAL_CHALLENGE` empties itself,
- the Phase 6 test asserting Maco is unplayable **will fail**. That failure is
  the signal to update it, not a regression.

Until then the card is still dealt and still unplayable, exactly as before.

### Standing note on Partner, I Sorry (OPEN_RULES.md §12)

Resolves normally when the payer holds **500 BB or more**. Below that the rule
runs out, so the card is **blocked, not resolved** — `blocked_open_rule`, with no
BB moved on either side (D-027). It is deliberately not treated as a dud, which
is a locked outcome with consequences. Do not invent the under-500 behaviour.
