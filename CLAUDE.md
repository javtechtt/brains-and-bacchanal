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

The project still needs a measured choice between Socket.IO and raw WebSockets.

Do not permanently bind game rules to either transport before the planned networking comparison.

Transport-specific code must sit behind an adapter/interface.

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

Start with **Phase 1 — Project Foundation** from `docs/DEVELOPMENT_ROADMAP.md`.

Do not jump ahead to full gameplay.

Do not build production content.

Do not finalize any rule listed in `docs/OPEN_RULES.md`.
