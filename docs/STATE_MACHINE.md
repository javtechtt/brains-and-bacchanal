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

## Room lifecycle is a SEPARATE state machine

Phase 4 adds `RoomStatus`, which is **not** a `GamePhase`:

```text
OPEN ──(HOST_LOCK_TEAMS)──▶ LOCKED
  ▲                            │
  └──(HOST_UNLOCK_TEAMS)───────┘
  │                            │
  └──────────┬─────────────────┘
             ▼
          CLOSED   (terminal)
```

| Status | Joins | Reconnects | Team edits |
|---|---|---|---|
| `OPEN` | yes | yes | yes |
| `LOCKED` | **no** | **yes** | no |
| `CLOSED` | no | no | no |

They are deliberately distinct because they answer different questions.
`RoomStatus` answers *"can a phone still join?"*; `GamePhase` answers *"what is
the game doing?"*. Merging them would make room closure depend on gameplay
state — so a room could not be closed mid-challenge without inventing a rule,
and `LOBBY` would have to mean both "accepting joins" and "not playing yet".

`LOCKED` still accepts **reconnects**, and that is the important asymmetry: a
locked roster is final for *new* players, but an existing player whose phone died
must be able to come back. Reconnecting never unlocks a room.

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

`GAME_RULES_LOCKED.md` §22 and `DECISION_LOG.md` D-011:

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

Phase 2 implemented the state model. **Phase 5 wires it to the real game**:
`GameEngine` owns the phase, every change goes through `applyTransition`, and an
active player's disconnect now triggers `player_disconnect` automatically in the
production room path. See `docs/GAME_ENGINE.md`.

### Gameplay cannot slip past a pause

The table already refuses an ordinary `advance` out of `PAUSED`. But several
engine actions change state **without** a phase transition — resolving a
challenge moves BB, a ruling is recorded, a turn is reassigned. Phase 5 routes
those through one shared guard so they are refused while paused too.

That was a real bug, caught by a test: before the guard, a Host could resolve a
challenge and award BB while the game was paused for a player whose phone had
died.

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

Phase 5 implements its lifecycle — prepare, begin, review, resolve — and adds
turn ownership, an active-player set and recorded Host rulings, all still without
knowing what any challenge *is*. `docs/GAME_ENGINE.md`.

### Phase 6 adds two state machines beside it, not inside it

Neither is a game phase, and both are deliberately scoped smaller than one:

```text
CARD LIFECYCLE
HELD ──play──▶ PENDING ──survives──▶ RESOLVING ──▶ CONSUMED
                 │
                 └──loses / Part Dat Fight──▶ HELD (barred for this challenge)

CLASH
open ──(3s hidden window, pausable)──▶ reveal ──▶ uncontested | winner | part_dat_fight
```

The Clash window is a `Deadline`, so it pauses with the game exactly as the
challenge timer does (D-011) and is **polled**, not scheduled — `@bb/game-rules`
owns no wall clock.

**Per-challenge state resets when a challenge is prepared or resolved.** The
one-card-per-team bar (`GAME_RULES_LOCKED.md` §2) and the advantage budgets (§4,
§10) are scoped to a question; carrying them forward would silently deny a team
its card or its one retry in the next challenge. Hands, held advantages and
Market purchases are game-long and survive.

**Round expiry happens on entry to `ROUND_INTRO`.** §10 expires Market items
after the round that follows their purchase; Maco Mail advantages are skipped,
per §7. See `docs/SHARED_SYSTEMS.md`.

### Phase 7A adds a round WITHOUT adding a phase

Round 2 is the first real round, and it introduces **no new phase and no new
transition**. It runs entirely on the table above:

```text
ROUND_INTRO ──▶ MARKET ──▶ CHALLENGE_INTRO ──▶ ACTIVE_PLAY ──▶ RESULT
                              ▲                                   │
                              └───────────────────────────────────┤
                                  (next physical challenge)       │
                                                                  ▼
                                                          ROUND_COMPLETE
```

That is the point. `Round2` is a **cursor over four challenges**, not a second
state machine: it tracks which game is current, which have resolved and who the
Host has selected, while the phase, the challenge container and the pause model
stay exactly where Phase 5 put them. Phase 7A spec §2 forbids a second
round-state system, and there is none.

The one thing Round 2 adds to this document's vocabulary is a **per-challenge
progress** value (`not_started` / `in_progress` / `resolved`) which is
deliberately distinct from the engine's `ChallengeStatus`. `ChallengeStatus`
describes one container's lifecycle; Round 2's progress describes the ROUND's
position through its four games — the thing a display needs to say "3 of 4".

**`ROUND_COMPLETE` is where Phase 7A stops.** `ROUND_COMPLETE → ROUND_INTRO` is
already legal and Round 3 will use it, but nothing in Phase 7A takes it.

## What intentionally remains undefined

Phase 2 does **not** decide, and must not be read as deciding:

- the Think Fast answer timer (`OPEN_RULES.md` §2), and what a timeout means
  there
- Family Feud Steups board behaviour (§8)
- FORGIVE MEH! and strike ordering (§9)
- three-team Family Feud card eligibility (§10)
- Round 4 / Sudden Death timers (§11)
- `Partner, I Sorry` with insufficient BB (§12)
- the Round 1 FORGIVE MEH! retry window (§13)

Resolved since this document was written, and no longer undefined: Round 1's
allocation and Maco!'s eligibility (D-030), and Round 3's scoring, targets,
Think Fast order and tiebreaker (D-031). None of them are implemented — the
engine stays generic regardless.

Also deferred by phase, not by open rule: rounds and the buzzer. (The BB ledger
arrived in Phase 5; Bacchanal Cards, the Clash, the Market, Maco Mail, Host Deals
and wagers arrived in Phase 6 — **without** resolving any of the open rules
above. §7, §8 and §12 visibly shaped what was built: see
`docs/SHARED_SYSTEMS.md`.)

Phase 4 has since implemented disconnect detection and room-scoped credentials
(`docs/LOBBY.md`). It deliberately did **not** implement:

- **Auto-pause on disconnect in the lobby.** D-011 pauses gameplay when an
  active player drops, but a lobby has no gameplay to pause. Phase 5 wires it
  when there is something to protect.
- **A disconnect timeout.** Nothing drops a disconnected player after any
  interval, because "how long before a missing player is removed" is not a
  locked rule. The Host removes people deliberately.
- **What happens if the HOST disconnects mid-game.** Phase 4 records
  `hostConnected` and lets the Host reconnect to the same room. It does not
  decide whether play should halt, because no rule says.
