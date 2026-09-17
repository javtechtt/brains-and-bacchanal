# Brains & Bacchanal — The Generic Game Engine

Phase 5. The authoritative engine every later round will run on: starting a
game, moving BB, running a challenge, owning a turn, running a timer, pausing,
and recording a Host ruling.

> **Status: implemented.** No rounds. No cards, Market, Maco Mail, wagers or
> buzzer. Nothing in `OPEN_RULES.md` is resolved.

---

## ⚠ A server restart still destroys the game

**Storage is in memory only. Restarting the game server destroys every active
room AND every active game — balances, ledger, challenge, timer and all.**

Phase 4 documented this for the lobby; Phase 5 raises the stakes, because now
there are scores to lose. There is still no file, no database and no recovery.

This is deliberate (Phase 5 spec §31: do not add Redis or Postgres yet).
`RoomStore` in `packages/game-rules/src/room-store.ts` remains the seam where
durable storage goes, and `ARCHITECTURE.md` §8 nominates PostgreSQL/Neon.

What this means at a party: if the server restarts mid-game, the Host creates a
new room, everyone re-scans, and **the scores are gone**. Do not restart the
server during a game.

---

## Why the engine is generic

There is no round in this engine. No trivia question, no Think Fast order, no
logo, no Family Feud board, no card and no Market item. `challengeType` is a
plain string the Host supplies.

That is the point, not an omission. `OPEN_RULES.md` leaves Round 1 allocation,
Think Fast's timer and three-team order, Guess the Logo scoring, the All Answers
Begin With format, Sing a Song's timings and the Round 4 / Sudden Death timers
unresolved. An engine that knew about rounds would have to assume answers to
those. This one runs a challenge without knowing what the challenge is, so
Phases 6–7 can add each round's rules without reshaping it.

## Where the pieces live

| Concern | File |
|---|---|
| Wire vocabulary | `packages/protocol/src/game.ts` |
| The engine | `packages/game-rules/src/game-engine.ts` |
| BB ledger | `packages/game-rules/src/bb-ledger.ts` |
| Timer service | `packages/game-rules/src/timer-service.ts` |
| Phase transitions | `packages/game-rules/src/transitions.ts` (Phase 2) |
| Routing, authority, delivery | `packages/game-rules/src/room.ts` |
| Socket, tick | `apps/game-server/src/rooms/server.ts` |

### Room and game are separate objects

The `Room` knows about sockets, credentials and rosters. The `GameEngine` knows
about BB, phases, challenges, turns and timers, and **has never heard of a
connection**. The room routes intents to it after checking authority.

They share **one event log**, deliberately. A client must be able to order "Team
A reached 1,500 BB" against "Javal disconnected"; two independent sequences could
not express that, and a gap in either would stop meaning "you missed something".

---

## Starting a game

```text
LOCKED LOBBY ──START_GAME (Host)──▶ ROUND_INTRO, every team seeded 1,000 BB
```

Preconditions: the room exists, is not closed, **teams are locked**, every
participating team has at least one player, and no game has started.

**Teams must be locked.** Starting with an open roster would mean a player could
join mid-game with no rule for what they receive — and no locked rule says. The
Host locks deliberately first.

**Starting twice is refused twice over.** A retried intent is caught by
idempotency; a second, genuinely distinct `START_GAME` is refused by the engine.
Either would otherwise double every balance.

It enters `ROUND_INTRO`, not a round. What Round 1 contains is Phase 7's, and
partly still open.

---

## BB and the ledger

`GAME_RULES_LOCKED.md` §1 — BB is both spendable currency and final score, every
team begins with **1,000**, and **BB can never go below 0**.

### Why a ledger and not a number

A balance alone cannot answer the question a Host will actually be asked at a
party: *"how did we get 300?"* Every change records what was requested, what was
applied, what it produced and why.

```text
entryId, teamId, delta, applied, balanceBefore, balanceAfter,
reason, at, seq, challengeId, note
```

`delta` is what was **asked for**; `applied` is what **actually moved**. They
differ exactly when a deduction hit the floor — which is the one case a Host most
needs explained.

### The floor lives in one place

```text
current = 300, penalty = -500  →  balance 0, applied -300, clamped
never                          →  -200
```

`BbLedger.apply` is the single mutation point for every balance in the game, and
`clampBb` (the locked rule) is applied there. Phase 5 spec §3 requires exactly
this: the floor must not be scattered through future round code.

Every later system — Market purchases, Maco Mail money cards, Family Feud
wagers, Host Deals, round awards — **must** move BB through this ledger rather
than assigning a balance. None of them exist yet, and the ledger anticipates none
of their amounts.

### How BB moves

| Reason | Source |
|---|---|
| `game_start` | Seeding 1,000 at `START_GAME` |
| `challenge_result` | A resolved challenge |
| `host_adjustment` | A Host correction |
| `dev_adjustment` | **Development tooling only.** Never in a real game |

Round awards go through `challenge_result`, so an award is always attached to the
thing that earned it.

---

## The generic challenge

```text
challengeId, challengeType, status, configRef, turn,
activePlayerIds, startedAt, timer, rulings, result
```

There is no board, no strike count, no answer pool, no logo list and no scoring.

**`configRef` is an opaque reference, never content.** Per `CONTENT_POLICY.md`,
there is nowhere in a challenge to put question text, an accepted answer or a
board label — the absence is the protection, not a rule someone must remember.

### Lifecycle

```text
prepare ──▶ pending ──begin──▶ active ──▶ awaiting_host ──resolve──▶ resolved
             (CHALLENGE_INTRO)  (ACTIVE_PLAY)  (HOST_REVIEW)          (RESULT)
```

Each step is a Host intent, and each phase change goes through the Phase 2
transition table rather than assigning a phase. Illegal steps are refused with a
structured rejection: preparing outside `CHALLENGE_INTRO`, starting a challenge
twice, preparing a second while one runs, resolving twice.

**A new challenge inherits nothing.** Turn ownership, active players and any
timer are cleared on prepare and on resolve. A stale active player from the
previous challenge would silently decide whose disconnect pauses the game.

---

## Turn ownership

```text
{ teamId: null, playerId: null }   nobody
{ teamId: 'TEAM_A', playerId: null }   Team A's turn — every member
{ teamId: 'TEAM_A', playerId: 'p1' }   one nominated player
```

Player-level ownership exists because `GAME_RULES_LOCKED.md` §11 nominates
individual players per difficulty in Round 1 — but no challenge is forced to use
it.

**Only the server assigns a turn.** It is reached through a Host intent the room
has already authorised; a player client has no route to it at all. A player turn
on a team the player is not on is refused, as is a player turn with no team.

Nothing here decides a round's order. Round 1 allocation (`OPEN_RULES.md` §1) and
the Think Fast three-team order (§3) remain open.

---

## "Active player" — the operational definition

> An **active player** is one whose participation the current challenge
> requires.

This matters because D-011 keys on it: marking a player active means **their
phone dropping will stop the game**. Leaving them out means it will not.

It is set deliberately by the engine (`HOST_SET_ACTIVE_PLAYERS`), never inferred
from who happens to be connected, and never "everyone in the room" — most of the
room is watching at any given moment.

Later rounds will set it when they nominate an answerer, pass control, or open a
challenge to a whole team.

---

## The timer

Server-authoritative, built on the Phase 2 pausable `Deadline` so paused time is
excluded by the same code those tests already cover.

- **A client may interpolate, never decide.** A phone counts down locally so its
  display moves smoothly; expiry is the server's, announced as an event.
  `ARCHITECTURE.md` §6, and the reason no client timestamp exists anywhere in
  this protocol.
- **A paused timer never expires.** Disconnect with four seconds left and the
  team has four seconds when the Host resumes — however long the pause lasted.
- **One timer at a time.** The engine runs one challenge at a time; a second
  start replaces the first. Concurrent timers would need a rule for two expiring
  at once, and none exists.

**No duration is defined anywhere.** Think Fast (`OPEN_RULES.md` §2), Sing a Song
(§6) and the Round 4 / Sudden Death timers (§11) are all open. Callers supply
durations from configuration.

### Expiry is observed, not scheduled

`@bb/game-rules` owns no wall clock — ESLint bans `setTimeout` there, and its
tests run on a `FakeClock` where no real interval would fire. So expiry is
detected by polling: on every intent, and on a 250 ms tick in the server process
for the case where nobody acts. `TimerService` reports each expiry **exactly
once**.

### What expiry means: nothing

Phase 5 spec §13 forbids assuming a timeout is a wrong answer, and no locked rule
says it is. `TIMER_EXPIRED` states the fact, hands the challenge to the Host by
moving to `HOST_REVIEW`, and stops. Its payload carries `requiresHostDecision:
true` so no client invents a consequence either.

---

## Pause and resume — D-011

```text
any non-terminal phase ──pause──▶ PAUSED ──resume (Host only)──▶ the same phase
```

### Pause is an overlay, not a transition

The challenge, the turn, the active players and the timer all survive untouched,
and the interrupted phase is **captured at pause time** rather than recomputed —
so a resume restores the situation rather than approximating it.

### What pauses, and what does not

| Event | Pauses? | Why |
|---|---|---|
| **Active** player disconnects mid-game | **yes** | D-011 |
| Non-active player disconnects | no | Pausing every time a spectator's phone sleeps would stop the party constantly |
| Any player disconnects in the **lobby** | no | There is no gameplay to protect |
| **Host** disconnects | no | No locked rule says what should happen — see below |
| Second disconnect while already paused | no | Nesting a pause would overwrite the captured return phase |

### Only the Host resumes

Authority is enforced **inside** `applyTransition`, not at a call site, so there
is exactly one implementation and no route around it. A reconnect is a
server-side event and the server is not the Host — which is precisely why
**reconnection alone can never resume a game**.

The Host may resume with or without the player coming back.

### Gameplay cannot slip past a pause

The transition table already refuses an ordinary `advance` out of `PAUSED`, but
several engine actions change state *without* a phase transition — resolving a
challenge moves BB, a ruling is recorded, a turn is reassigned. Those go through
a shared `#requireRunning` guard.

This was a real bug, caught by a test: before the guard, a Host could resolve a
challenge and award BB while the game was paused for a player whose phone had
died.

---

## Objective vs subjective authority

| The **server** decides | The **Host** decides |
|---|---|
| BB and the floor | Whether a spoken answer counts |
| Timers and expiry | Who spoke first |
| Sequence and ordering | Who won a physical or creative challenge |
| Legal state transitions | |
| Turn ownership | |
| Pause and connection state | |
| Duplicate handling | |

A player client **cannot** send `correct: true` and have the server believe it.
There is no such field, and every judgment intent is Host-gated.

### Rulings are recorded, never re-judged

```text
rulingId, kind, challengeId, teamId, playerId, at, seq, note
```

`kind` is one of `valid`, `invalid`, `select_winner`, `note`.

**A ruling moves no BB by itself.** It records what the Host judged; what it is
*worth* is decided when the challenge resolves, against rules that in most cases
are not written yet. Keeping those separate is what stops a ruling implying a
round's scoring.

There is **no universal Undo** (Phase 5 spec §14 forbids inventing one).

---

## The result model

```text
winningTeamIds, winningPlayerIds, bbApplied,
decidedByHost, resolvedAt, completion, note
```

`bbApplied` records what **actually** moved, after the floor. Amounts come from
the caller — in Phase 7 a round's locked rules, today a Host's test input.

Validation completes before anything is applied, so a rejected result cannot
leave one team paid and another not.

---

## Snapshots — the content boundary

Phase 4 had **one** lobby snapshot, because Host and players were entitled to the
same facts. Phase 5 splits it, as `docs/LOBBY.md` anticipated.

The split is not needed for the fields that exist today. It exists so the
boundary is drawn **before** there is anything secret to put on the wrong side of
it — and so a future field has to be placed deliberately on one side or the
other.

| | Host | Player |
|---|---|---|
| Room, roster, phase, pause | yes | yes |
| Every team's BB | yes | yes |
| Challenge state, turn, timer | yes | yes |
| **BB ledger** | **yes** | **no** |
| `devToolsEnabled` | yes | no |
| Own identity, team, `youAreActive`, `yourTurn` | — | yes |

Team balances are on both sides on purpose: a party game shows the scores on a
TV, and a phone is useful when the TV is behind you.

**Neither carries** a reconnect credential, the Host token, or — when Phase 6
builds them — unrevealed answers, hidden Market selections, another team's card
hand or undrawn Maco Mail. There is no field to carry them.

A connection that has not identified itself gets the **player-safe** shape, so a
new caller cannot accidentally receive the Host's.

`REQUEST_GAME_SNAPSHOT` is a **read**: it emits no event and consumes no
sequence number, preserving what a gap means.

---

## Reconnect during a game

| Case | Behaviour |
|---|---|
| Active player drops | Auto-pause, timer freezes |
| That player returns | Same player, same team, **still paused** |
| Host resumes | Back to the interrupted phase, timer continues from its remaining time |
| Non-active player drops | No pause; connection state updates; returns normally |
| Browser refresh mid-game | Same player restored, straight back into the game view |
| **Unity Host reconnects** | **The same game** — same `gameId`, same balances, same challenge, same timer, same pause state, sequence continues |

A Host reconnect never creates a second game session.

Recovery is by **authoritative snapshot plus sequence**, not by replaying client
guesses. `eventsSince(seq)` serves a client that knows where it was.

---

## Development tooling

Phase 5 spec §17 asks for a way to exercise the engine before any round exists.

`DEV_ADJUST_BB` moves BB directly. It is:

- **Host-only**, like every other engine intent,
- **refused outright** unless the server runs with `GAME_SERVER_DEV_TOOLS`
  enabled (default: on in development, **off** in production, so a deployment
  has to opt in rather than remember to opt out),
- stamped `dev_adjustment` in the ledger, so a test award can never be mistaken
  for earned BB.

No production player UI exposes it, and **no round code may call it** — rounds
award BB by resolving a challenge.

The Unity Host's engine controls live in `HostEnginePanel.cs`, a separate partial
class, so development-only tooling is obvious at a glance and deleting it later
touches nothing else. Phase 8 builds the real Host presentation.

---

## Protocol

**Intents** (all Host-only except the read)

| Intent | Notes |
|---|---|
| `START_GAME` | From a locked lobby |
| `HOST_ADVANCE_PHASE` | Legality comes from the transition table |
| `HOST_PREPARE_CHALLENGE` | Generic type + optional `configRef` |
| `HOST_START_CHALLENGE` | |
| `HOST_SET_TURN` | Team, optionally a player |
| `HOST_SET_ACTIVE_PLAYERS` | What D-011 keys on |
| `HOST_START_TIMER` / `HOST_CANCEL_TIMER` | Caller supplies the duration |
| `HOST_REQUEST_REVIEW` | Hand to the Host |
| `HOST_RULING` | Subjective judgment, recorded |
| `HOST_RESOLVE_CHALLENGE` | Applies BB through the ledger |
| `HOST_PAUSE_GAME` / `HOST_RESUME_GAME` | Resume is Host-only twice over |
| `REQUEST_GAME_SNAPSHOT` | **Read-only** — any client |
| `DEV_ADJUST_BB` | **Development only** |

**Events**: `GAME_STARTED`, `PHASE_CHANGED`, `BB_CHANGED`, `CHALLENGE_PREPARED`,
`CHALLENGE_STARTED`, `CHALLENGE_RESOLVED`, `TURN_CHANGED`,
`ACTIVE_PLAYERS_CHANGED`, `TIMER_STARTED`, `TIMER_CANCELLED`, `TIMER_EXPIRED`,
`HOST_RULING_RECORDED`, `REVIEW_REQUESTED`, `GAME_PAUSED`, `GAME_RESUMED`.

Every state-changing intent keeps Phase 2's guarantees: intent IDs, deduplication
**before** rule evaluation, a monotonic sequence, a server timestamp, and
structured rejection. A rejected intent consumes no sequence number.

Verified not to apply twice: `START_GAME`, a BB award, a Host ruling, a challenge
resolution, and a reconnect retry.

---

## Phase 7A: the first round runs on this engine unchanged

Round 2 ("Shake Up Yuhself!") is implemented, and it is worth recording what it
did **not** need:

- no new phase and no new transition,
- no second challenge container — a Round 2 game IS a generic challenge whose
  `challengeType` happens to be `BOTTLE_BATTLE`,
- no second BB path — the award goes through `resolveChallenge` and the ledger,
- no round-specific stacking or multiplier logic — it asks the Phase 6 shared
  systems,
- no change to pause, reconnect, idempotency or the snapshot split.

What it added: a `Round2` cursor held by the engine (null outside Round 2), three
Host intents, and one field on the session view.

The generic design paid off exactly as intended — and the one place Round 2
deliberately does **not** reuse the engine is `HOST_RESOLVE_CHALLENGE`, whose
client-supplied `bbDeltas` exist for generic testing. A real round must not let a
client name an amount, so Round 2 computes 500 (or 1,000) server-side and calls
`resolveChallenge` internally.

**Round 2 marks no active players**, which follows from D-021 rather than
contradicting it: the physical game happens in the room, so no player's
*software* participation is required, and a sleeping phone must not stop the
party. See `docs/ROUND_2.md`.

## Phase 7B: Round 3 runs on it too

Round 3 is implemented, and like Round 2 it needed no new phase, no second
challenge container and no second BB path. What it DID add to the engine:

- a `Round3` cursor (null outside Round 3) holding challenge points, the
  challenge-win counter, Think Fast's turn order and the RPS tiebreaker,
- `standingsByBb()` — the previous round's order, which §1 defines as "most
  total BB when the round ends",
- an injected `Round3ContentSource` on the room, so the GAME supplies challenge
  content and the Host never types it (§13),
- a second polled resolver beside the Clash: the RPS reveal fires on the tick
  once the last tied team has chosen.

**The challenge-win counter never touches the BB ledger.** It is not money, and
a ledger entry would make it look like money. `GAME_RULES_LOCKED.md` §13.

A Round 3 challenge that awards no BB still goes through `resolveChallenge` with
a zero delta, so a paying and a non-paying challenge cannot drift apart.

See `docs/ROUND_3.md`.

## What Phase 5 deliberately did NOT decide

Nothing in `OPEN_RULES.md` is resolved. Specifically:

- **No challenge duration.** Nothing starts a timer on its own.
- **No meaning for expiry.** A timeout is not a wrong answer.
- **No challenge types.** `challengeType` accepts any string.
- **No round composition.** `roundIndex` counts rounds without saying what one
  contains.
- **No Host-disconnect rule.** Connection loss is recorded; play is left exactly
  as it was. Still open.
- **No Maco! eligibility**, no cards at all.

---

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` / `lint` / `test` / `build` | **PASS** |
| Deterministic engine tests (FakeClock) | **PASS** — 122 new |
| End-to-end over real WebSockets | **PASS** — 26 |
| Unity headless engine check vs the compiled server | **PASS — 49/49** |
| Phase 4 lobby check (regression) | **PASS — 47/47** |
| Unity C# compile | **PASS** — 0 errors, 0 warnings |
| IL2CPP Windows standalone build | **PASS** — 0 errors, 0 warnings |
| Standalone `.exe` runs | **PASS** — no exceptions |

`HeadlessEngineCheck.cs` matters more than it looks: **JsonUtility fails
quietly.** A C# field that does not match the server's JSON deserialises to zero
or null rather than throwing, so a DTO drift would appear as "0 BB" on a TV in
front of a room of people, not as an error. The only way to catch it is to read
real server JSON through the real DTOs and assert the values, which is what that
check does.
