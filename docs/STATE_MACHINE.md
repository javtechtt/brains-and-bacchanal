# Brains & Bacchanal — Generic State Machine

## These are engine states, not round rules

This document describes the **generic lifecycle** the engine moves through. A
phase says what *kind* of thing the game is doing — introducing a challenge,
waiting on the Host, showing a result.

A phase never says:

- which round it is,
- how many questions remain,
- how scoring works,
- who plays next.

That separation is deliberate. `OPEN_RULES.md` leaves Round 1 allocation, Guess
the Logo scoring, the All Answers Begin With format and several timers
unresolved. Keeping this model generic is what lets those be answered later
without reshaping the engine.

Source of truth: `packages/protocol/src/lifecycle.ts` and
`packages/game-rules/src/transitions.ts`.

## Phases

| Phase | Meaning |
|---|---|
| `BOOT` | Process started, room not yet open |
| `LOBBY` | Room open, players joining and being assigned |
| `TEAM_LOCK` | Teams fixed; no further joins or reassignment |
| `ROUND_INTRO` | Presenting a round |
| `MARKET` | Market open |
| `CHALLENGE_INTRO` | Presenting a challenge |
| `ACTIVE_PLAY` | Players actively playing; deadlines typically run here |
| `HOST_REVIEW` | Waiting on a Host ruling |
| `RESULT` | Showing a challenge outcome |
| `ROUND_COMPLETE` | A round has finished |
| `PAUSED` | Gameplay suspended |
| `SUDDEN_DEATH` | Tied leaders playing for the win |
| `GAME_OVER` | Terminal |

## Legal transitions

```text
BOOT ──▶ LOBBY ──▶ TEAM_LOCK ──┬──▶ ROUND_INTRO ──┬──▶ MARKET ──┐
                   ▲           │                  │             │
                   └───────────┘                  └─────────────┴──▶ CHALLENGE_INTRO
                  (unlock to fix                                          │
                   a team)                                                ▼
                                                                    ACTIVE_PLAY
                                                                     │       │
                                                          ┌──────────┘       │
                                                          ▼                  ▼
                                                    HOST_REVIEW ────────▶ RESULT
                                                          │                  │
                                                          └──▶ ACTIVE_PLAY   │
                                                                             ▼
                                              ┌──────────────────── CHALLENGE_INTRO
                                              │                             or
                                              ▼                      ROUND_COMPLETE
                                       ROUND_INTRO ◀──────────────────────┤
                                                                          ├──▶ SUDDEN_DEATH
                                                                          └──▶ GAME_OVER
```

Full table:

| From | To |
|---|---|
| `BOOT` | `LOBBY` |
| `LOBBY` | `TEAM_LOCK` |
| `TEAM_LOCK` | `ROUND_INTRO`, `LOBBY` |
| `ROUND_INTRO` | `MARKET`, `CHALLENGE_INTRO` |
| `MARKET` | `CHALLENGE_INTRO`, `ROUND_INTRO` |
| `CHALLENGE_INTRO` | `ACTIVE_PLAY` |
| `ACTIVE_PLAY` | `HOST_REVIEW`, `RESULT` |
| `HOST_REVIEW` | `RESULT`, `ACTIVE_PLAY` |
| `RESULT` | `CHALLENGE_INTRO`, `ROUND_COMPLETE` |
| `ROUND_COMPLETE` | `ROUND_INTRO`, `SUDDEN_DEATH`, `GAME_OVER` |
| `SUDDEN_DEATH` | `ACTIVE_PLAY`, `RESULT`, `GAME_OVER` |
| `PAUSED` | *(none — see below)* |
| `GAME_OVER` | *(none — terminal)* |

`GAME_OVER → ACTIVE_PLAY` is not legal, and `GAME_OVER` has no outgoing
transitions at all.

Why `ROUND_INTRO` may lead either to `MARKET` or straight to
`CHALLENGE_INTRO`: `GAME_RULES_LOCKED.md` §10 opens the Market before Rounds 2,
3 and 4 — so not before Round 1.

## Transitions are centralised

All phase changes go through one function:

```ts
applyTransition(state, action, actor): TransitionOutcome
```

Application code never assigns `state.phase = 'ACTIVE_PLAY'`. The rules live in
one pure, testable place, and illegal transitions are rejected with a structured
`Rejection` rather than silently applied.

Actions are `advance`, `pause` and `resume`.

## Pause

`GAME_RULES_LOCKED.md` §20 and `DECISION_LOG.md` D-011:

- an active player disconnecting pauses gameplay automatically,
- active gameplay timers pause,
- reconnecting does **not** automatically resume gameplay,
- only the Host can resume,
- the Host may resume with or without the player reconnecting.

### PAUSED is not an ordinary phase

`PAUSED` appears in **no** transition list — neither as a destination nor as a
source. It is handled separately by `pause` and `resume` actions.

That is not a technicality. Resuming must return the game to exactly where it
left off, which a flat transition table cannot express. Handling it separately
means the "only the Host resumes" rule has exactly **one** implementation, with
no second path around it.

```text
any non-terminal phase ──pause──▶ PAUSED ──resume (Host only)──▶ the same phase
```

The phase to return to is **captured at pause time**, not recomputed on resume,
so a resume cannot drift to a different phase than the one play was suspended
from.

### Guarantees

- While `PAUSED`, an ordinary `advance` is rejected with `WRONG_STATE`.
  Gameplay cannot slip past a pause.
- `resume` by a player, an admin, or the **server itself** is rejected with
  `UNAUTHORIZED_ACTOR`.
- Because a reconnect is a server-side event and the server cannot resume,
  **reconnection alone can never leave `PAUSED`.**
- Pausing an already-paused or finished game is rejected.

Authority is checked *inside* `applyTransition`, not at a call site, so there is
no route by which a future caller can bypass it.

Phase 2 implements the state model. **Network disconnect detection is not
implemented** — nothing yet triggers `player_disconnect` automatically. The
reason code exists for the later phase that adds detection.

## Deadlines

`packages/game-rules/src/deadline.ts`. Pure functions over an injected `Clock`.

Paused time is excluded from elapsed time. If a player disconnects with four
seconds left, the team still has four seconds when the Host resumes — not zero
because wall-clock time kept running.

`extendDeadline` exists to support the Market's "Extra Time (+15 sec)" and Maco
Mail's "+15 Seconds" (`GAME_RULES_LOCKED.md` §10, §8). It is a primitive only:
it does not implement either, and it does not enforce the Market's no-stacking
rule. That is Phase 6.

**No challenge duration is defined anywhere in Phase 2.** Think Fast's timer
(`OPEN_RULES.md` §2), Sing a Song's timings (§6) and the Round 4 / Sudden Death
timers (§11) are all open. Callers supply durations from configuration.

## Challenge state

`ChallengeState` is a **reusable container**, not an implementation:

```ts
challengeId, challengeType, status, activeTeamId, activePlayerId,
startedAt, deadline, result, configRef
```

It deliberately contains no board, no strike count, no answer pool, no logo
list and no scoring. `challengeType` is a plain `string` rather than a union,
because fixing the set now would imply decisions about round composition that
`OPEN_RULES.md` §1 leaves open.

## What intentionally remains undefined

Phase 2 does **not** decide, and must not be read as deciding:

- how many questions Round 1 has, or how they are allocated (`OPEN_RULES.md` §1)
- the Think Fast answer timer (§2) or three-team starting order (§3)
- Guess the Logo scoring (§4)
- the All Answers Begin With format (§5)
- Sing a Song timings (§6)
- where `Maco!` may be played (§7)
- Family Feud Steups board behaviour (§8)
- FORGIVE MEH! and strike ordering (§9)
- three-team Family Feud card eligibility (§10)
- Round 4 / Sudden Death timers (§11)
- `Partner, I Sorry` with insufficient BB (§12)

Also deferred by phase, not by open rule: rounds, Bacchanal Cards, Clash, the
Market, Maco Mail, Host Deals, wagers, the buzzer, the BB ledger, authentication
and disconnect detection.
