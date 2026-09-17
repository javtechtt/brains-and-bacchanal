# Brains & Bacchanal — Round 2, "Shake Up Yuhself!"

Phase 7A. The first real round: four Host-judged physical challenges, 500 BB
each, running on the generic engine and the Phase 6 shared systems.

> **Status: implemented.** No Round 1, no Round 3, no Round 4, no Family Feud,
> no Sudden Death, no buzzer. Nothing in `OPEN_RULES.md` is resolved.

---

## ⚠ A server restart still destroys the game

Unchanged from Phases 5 and 6, and now with a round's results to lose as well.
**Everything is in memory only.** `ARCHITECTURE.md` §8 nominates PostgreSQL
later; `RoomStore` remains the seam. Do not restart the server during a game.

---

## The physical games are not in the software

`DECISION_LOG.md` D-003 is unusually direct:

> Host runs Bottle Battle, Match Makers, Grabbers and Bombers physically.
> Software only needs Host winner selection and configured 500 BB award.

So there is **no rule anywhere in this codebase** about bottles, matches,
grabbing or bombs. No duration, no scoring, no player input, no sensor, no
motion tracking, no automatic winner. The four challenges differ **only by
identity** — and that is the test: if they ever stop looking alike in the
configuration, something has been invented.

What the software does, in full:

1. name the challenge on a screen,
2. take the Host's winner,
3. pay the configured BB through the ledger.

Detailed physical rules stay outside the app, as D-003 requires, and there is
nowhere in any type here to put one.

---

## The four challenges

`GAME_RULES_LOCKED.md` §12. The locked order, transcribed into
`ROUND2_CHALLENGE_TYPES` and nowhere else:

| # | Challenge | Display name | Reward |
|---|---|---|---:|
| 1 | `BOTTLE_BATTLE` | Bottle Battle | 500 BB |
| 2 | `MATCH_MAKERS` | Match Makers | 500 BB |
| 3 | `GRABBERS` | Grabbers | 500 BB |
| 4 | `BOMBERS` | Bombers | 500 BB |

**Order is data, not control flow.** The engine walks the array by index; no
code says "after Grabbers comes Bombers". Reordering the round is editing that
list. Adding a fifth game would be a rule change and must come from the owner —
§12 names exactly four, and a fifth is refused at runtime.

**Identifiers, never labels.** The challenge is `BOTTLE_BATTLE`; "Bottle Battle"
is a display string the server sends. Neither Unity nor the web app holds a list
of Round 2 names, so renaming one for the TV cannot break the round.

### Where the pieces live

| Concern | File |
|---|---|
| Challenge config, order, reward, intents, events | `packages/protocol/src/round2.ts` |
| Progression and the winner flow | `packages/game-rules/src/round2.ts` |
| Engine wiring | `packages/game-rules/src/game-engine.ts` |
| Routing and authority | `packages/game-rules/src/room.ts` |
| Host display | `unity/host/Assets/Scripts/HostRound2Panel.cs` |
| Host DTOs | `unity/host/Assets/Scripts/Protocol/Round2Messages.cs` |
| Player screen | `apps/web/src/rooms/PlayerRound2.tsx` |

---

## The round's shape

```text
ROUND 2 INTRO ──▶ MARKET ──▶ MARKET CLOSE ──▶ four physical challenges ──▶ ROUND COMPLETE
```

`GAME_RULES_LOCKED.md` §10 opens the Market before Round 2, and Phase 6 already
built it. Round 2 **opens the existing Market at round 2** and duplicates
nothing — no price is written in any Round 2 file.

Each challenge, in the engine:

```text
CHALLENGE_INTRO ──prepare──▶ pending ──begin──▶ ACTIVE_PLAY ──confirm──▶ RESULT
```

Those are the Phase 5 generic lifecycle and the Phase 2 transition table,
unchanged. Round 2 adds **no phase**, and `Round2` is a cursor over four
challenges — not a second round-state system.

---

## `Round2` is a cursor, not an engine

It knows which game is current, which have resolved, who the Host has selected
and whether the round is finished. It owns **no** phase, challenge container,
timer, BB or card state — those stay with `GameEngine` and `SharedSystems`,
which it never touches.

It does not compute the award either. It reports the base reward from
configuration; the engine asks `SharedSystems.applyMultiplier` for the final
number and moves it through `BbLedger`. Keeping the multiplier out of Round 2 is
what stops it growing its own copy of "multipliers never stack" (§3).

---

## The Host winner flow

`CLAUDE.md` and D-003 make the Host authoritative for "winners of
physical/creative games". The server is authoritative for everything else.

```text
1. Server prepares the challenge, in the locked order
2. Unity shows the title
3. Host begins the challenge; card window opens
4. THE PHYSICAL GAME HAPPENS IN THE ROOM
5. Host SELECTS a winning team          ── moves no BB
6. Host CONFIRMS                        ── this pays
7. Server validates authority and the team
8. Server takes 500 from configuration
9. Server applies any legal multiplier
10. BbLedger records the award
11. Result is broadcast; the challenge is resolved
```

### Two steps, deliberately

Selecting and paying are separate intents. A single button would award 500 or
1,000 BB irreversibly on a misclick, in front of a room of people. So the
selection appears on the TV and on every phone first, and a separate CONFIRM
commits it. Selecting again simply replaces the selection — which is what makes
a mistake correctable.

### What the server checks

The winner must **exist in this game** and be **participating**. A raw team id
off the wire is never trusted. Whether the *caller* is the Host is checked by the
room before the engine is reached — the same split every Phase 5 and 6 intent
uses.

**A player client cannot nominate a winner.** There is no player intent, and the
Host intents are refused from a player connection. A phone's UI offers no such
control, but that is a courtesy; the server is the protection.

### No amount travels on the wire

The confirmation carries a **team**, never a number. `HOST_RESOLVE_CHALLENGE`'s
client-supplied `bbDeltas` is deliberately **not** used by Round 2: a Host client
naming an amount would be exactly the "client decides how much BB to add"
`CLAUDE.md` forbids. A payload containing `awardedBb: 99999` changes nothing,
because no handler reads one — asserted by a test over a real socket.

### 🔓 A tie is refused, not resolved

No locked rule says what a drawn Round 2 game does. So a confirmation with no
winner selected is **rejected**, and the Host is told to pick one. Nothing
invents a split, a replay or a shared award.

---

## Cards — Double It only

`GAME_RULES_LOCKED.md` §6: **Round 2 Physical Games → Double It! only.**

Round 2 has **no card rule of its own**. It names the row of the approved table
that applies (`ROUND2_PHYSICAL`) and the Phase 6 eligibility engine does the
rest, so a change to the approved table reaches Round 2 automatically.

Refused, server-side: Steups, Gimme Dat, Maco, Doh Know, Forgive Meh, Allyuh
Help Me. A phone sees each as unplayable with a reason — and Maco reports
`compatibility_unresolved`, never "wrong challenge", because `OPEN_RULES.md` §7
is still open.

### Double It

| | |
|---|---|
| Base reward | 500 BB, from Round 2's configuration |
| Doubled | 1,000 BB — because `applyMultiplier` doubles it |
| Timing | **Before the result.** §3: "activate before result" |
| Stacking | Never. One shared `DOUBLE` budget (§3, §10) |
| Scope | Per challenge. Doubling Bottle Battle does not double Match Makers |

**1,000 is written nowhere.** The multiplier is read from the shared system at
confirmation time, which is what makes the locked timing rule true: a card
played after the Host confirms has nothing left to double, and the challenge is
resolved so the play is refused outright.

The multiplier belongs to the **team that played it**. A losing doubler is paid
nothing; doubling does not create a reward where there is no win.

### The Clash

Round 2 permits only Double It, so an opposing team usually holds **no legal
counter** and the card resolves uncontested — exactly as §5 says it should.

Nothing was changed to manufacture drama here. Phase 7A §9 is explicit: do not
enable another card just to create a Clash.

---

## Market advantages in Round 2 — what is deliberately NOT wired

The Market sells its full locked range before Round 2, and every purchase,
price, refund and expiry works. What a bought advantage **does** during a
physical challenge is a different question, and mostly has no answer.

| Item | Round 2 status | Why |
|---|---|---|
| `DOUBLE_BB` | **Works** | Doubling a reward is meaningful for any challenge with a reward. Shares the one `DOUBLE` budget with Double It, so they cannot stack |
| `MACO_MAIL` | **Works** | Independent of the challenge entirely |
| `CLUE` | **Not applied** | A clue to *what*? There is no question, no answer and no hidden information in a physical game |
| `EXTRA_TIME` | **Not applied** | Round 2 runs no software timer. "+15 seconds" of what is undefined |
| `SECOND_CHANCE` | **Not applied** | A retry of a physical game is a rule decision — replay the whole thing? one attempt? — and no locked rule says |

Phase 7A §10 asks for exactly this: *"If a Market item's challenge-specific
integration is undefined for Round 2, leave that item/effect disabled for that
physical challenge rather than guessing."*

The items are still **sellable** — §10's Market rules are locked and a team may
spend BB on something it will use in Round 3. They simply have no Round 2 effect,
and nothing pretends otherwise. A team is not blocked from buying one, and the
advantage remains held and usable where it does apply.

---

## The active-player rule, and why Round 2 does not pause

**Round 2 marks nobody as an active player.** That is deliberate, and it follows
from D-021's operational definition:

> An active player is one whose participation the **current challenge**
> requires.

D-011 pauses the game when an active player disconnects. In Round 2 the
challenge is happening **in the room**, not on anyone's phone — nobody's software
participation is required by anything. A player who is physically running around
with a bottle is not a software-active player.

So a phone that sleeps, drops or is put in a pocket mid-challenge **does not stop
the game**. Phase 7A §23 asks for precisely this and warns against inventing a
physical-challenge pause rule based on who is moving around the room.

What still pauses: a deliberate Host pause. And the pause guard is untouched —
while the game is paused, confirming a result is refused like every other
state-changing action.

---

## BB

Every Round 2 award goes through `BbLedger` with reason `challenge_result`.
Nothing assigns a balance.

```text
delta 500, applied 500, before 1,000, after 1,500,
reason challenge_result, challengeId <the challenge>, note "Bottle Battle"
```

The note names the challenge — a Host asked "how did we get 2,300?" can answer
it. A doubled award notes `Bottle Battle (Double It)`, so 1,000 where 500 was
expected is explainable rather than surprising. And the round records what the
**ledger applied**, not what was intended, so the two can never disagree.

---

## Two teams and three teams

The same round, both ways. Phase 7A §17: *"Do not create a separate Round 2
format for three teams unless a locked rule requires it."* None does.

All teams participate in every challenge. The Host picks one winner. **Nothing
is eliminated** — a team that loses all four still plays all four, and no locked
rule for Round 2 says otherwise.

---

## Reconnect

Everything survives, and **nothing repeats**:

| During | Restored |
|---|---|
| Round 2 Market | Own purchases, hidden from opponents, not rebought |
| Between challenges | The round's position and every earlier result |
| An active card window | The hand and the window |
| After Double It, before the result | The multiplier, still applied exactly once |
| After a winner is selected | The pending selection, unconfirmed |
| After a result | The result, paid once |
| **Unity Host reconnect** | The same round, same results, same balances — and **no winner is reselected** |

A Host reconnect never re-pays a challenge or re-picks a winner. Recovery is by
authoritative snapshot plus sequence, exactly as Phases 5 and 6.

---

## Development entry — because Round 1 does not exist

Round 1 is not implemented, so **no production path reaches Round 2 yet**.

Phase 7A §4 is explicit that inventing one would be worse: *"DO NOT invent a
production rule that allows normal games to skip Round 1."* So there is a
development-gated entry instead, `DEV_START_ROUND2`:

- **Host-only**, like every engine intent,
- **refused outright** unless the server runs with `GAME_SERVER_DEV_TOOLS`
  enabled — default on in development, **off** in production (D-024),
- gated by the **server**, so a client built with the button still cannot use it.

**It does not shortcut the engine.** It walks the real transition table —
`ROUND_INTRO → CHALLENGE_INTRO → ACTIVE_PLAY → RESULT → ROUND_COMPLETE →
ROUND_INTRO` — with an empty placeholder challenge (`DEV_ROUND_SKIP`) that awards
nothing and resolves `abandoned`. That placeholder is **not Round 1** and does
not pretend to be; Round 1's allocation is open (`OPEN_RULES.md` §1) and nothing
here decides it. Re-entering `ROUND_INTRO` is what advances the round counter and
expires the previous round's Market items, so Round 2 begins with exactly the
state a real Round 1 completion would leave.

When Round 1 arrives it calls the same `beginRound2()`.

---

## Round 2 completion

After the fourth challenge resolves, the round is **COMPLETE**:
`complete: true`, `resolvedCount: 4`, `current: null`, and a fifth physical
challenge is refused.

The engine is ready to transition onward — `ROUND_COMPLETE → ROUND_INTRO` is
already legal — but **Phase 7A stops here**. Round 3 is not implemented.

---

## Protocol

**Intents** (all Host-only)

| Intent | Notes |
|---|---|
| `HOST_PREPARE_ROUND2_CHALLENGE` | **Takes no challenge type.** The round hands out the next in the locked order, so a game cannot be skipped |
| `HOST_SELECT_PHYSICAL_WINNER` | Step one. Carries a team; moves no BB |
| `HOST_CONFIRM_PHYSICAL_RESULT` | Step two. **Carries no amount.** This pays |
| `DEV_START_ROUND2` | **Development only** |

Everything else Round 2 needs already exists and is **not restated**:
`HOST_START_CHALLENGE`, `HOST_OPEN_CARD_WINDOW`, `HOST_OPEN_MARKET`,
`PLAY_BACCHANAL_CARD`, the pause intents and `REQUEST_GAME_SNAPSHOT`.

**Events**: `ROUND2_STARTED`, `ROUND2_CHALLENGE_PREPARED`,
`ROUND2_WINNER_SELECTED`, `ROUND2_CHALLENGE_RESOLVED`, `ROUND2_COMPLETED`.

`ROUND2_WINNER_SELECTED` carries **no amount**, because it pays nothing.
`ROUND2_CHALLENGE_RESOLVED` carries the base, what was applied, and whether it
doubled.

### Snapshots

`Round2StateView` hangs off the shared `GameSessionView`, so the Host and every
phone see the same thing — and that is correct, because **every field of it is
public**. Which game is running, who the Host has selected, who won the earlier
ones and what they were paid is exactly what a party game puts on a TV.

Phase 6's secrets (hands, hidden purchases, unrevealed Clash responses) live in
the Phase 6 views and are not duplicated here. There is no field on this type
capable of carrying one.

It is `null` in every other round. A later round adds its own field rather than
reusing this one, so no round can inherit another's state by accident.

---

## Content

Round 2 challenge names are **locked game structure, not secret content**
(Phase 7A §25). "Bottle Battle" on a screen spoils nothing.

No production questions, no hidden instructions, no sealed content. The detailed
physical rules are not in the repository because they are not in the software at
all — D-003.

---

## What Phase 7A deliberately did NOT decide

- **No physical rule, duration, score or winner detection.** D-003.
- **No tie behaviour.** A result requires one winner; a tie is refused, never
  silently resolved.
- **No Round 1.** The development entry is not a production rule, and Round 1
  allocation stays open (`OPEN_RULES.md` §1).
- **No Round 3.** The round stops at `ROUND_COMPLETE`.
- **No meaning for Clue, Extra Time or Second Chance** in a physical challenge.
- **No Host-disconnect rule.** Still open, unchanged from Phases 5 and 6.
- **No Maco! eligibility.** §7 is still open; Round 2 refuses it like every
  other challenge.
- **No physical-challenge pause rule.** Nobody is software-active, so nobody's
  phone stops the game.

---

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` / `lint` / `test` / `build` | **PASS** |
| Deterministic Round 2 rule tests (FakeClock) | **PASS — 55 new** |
| Round 2 end-to-end over real WebSockets | **PASS — 16 new** |
| Total suite | **PASS — 809** |
| Compiled-server smoke walkthrough | **PASS — 18 checks** |
| Unity C# compile | **PASS** — 0 errors |
| **Unity Round 2 client-shape check** | **PASS — 36/36** |
| Unity engine check (regression) | **PASS — 49/49** |
| Unity shared-systems check (regression) | **PASS — 43/43** |
| Unity lobby check (regression) | **PASS — 47/47** |
| IL2CPP Windows standalone build | **PASS** — 0 errors, 0 warnings |
| **Physical two-phone test, Unity Host + real phones** | **PASS** |

### The physical test

Run on the real thing: the Unity Host on a Windows machine, two real phones on
the LAN, the compiled game server, and the development Round 2 entry (Round 1
does not exist). The Host nominated winners rather than anyone actually playing
Bottle Battle — Phase 7A §36 explicitly allows that, because the physical games
are outside the software and there is nothing in them for a software test to
exercise.

Covered: room creation and QR join, two teams locked, game start, the
development Round 2 entry, the Round 2 Market with a real purchase and close,
all four physical challenges through select-and-confirm, Double It played before
a result, the +500 and +1,000 awards, round completion, and a mid-round phone
refresh with no duplicated award.

**One real bug was found, and only by doing this.** The awarded BB did not
appear on screen until the following challenge began — see below. Every
automated test had passed, because the fault was in what the clients did with a
correct event rather than in the event itself.

### The awarded BB did not appear until the next challenge

Found in the first physical two-phone test, and the clearest possible symptom:
the **fourth** challenge's award never appeared at all, because there was no
fifth challenge to trigger the refresh that had been masking the bug for the
first three.

The server was correct throughout — `ROUND2_CHALLENGE_RESOLVED` has always
carried the post-award balances. The fault was in **both clients' event
filters**: the Unity Host refreshes its snapshot from an exhaustive `switch` of
event names, and the web player from a list of name prefixes. Neither knew about
`ROUND2_*`, so the resolution fell through unmatched and the screen kept the old
number until some *later* event happened to force a refresh.

**This was the third recurrence of the same gap.** Phase 5 shipped the filters
with a comment stating they should cover every gameplay event; Phase 6's events
were never added (fixed in `3cbbe1a`); Phase 7A's were never added either. An
exhaustive list of event names is a list somebody has to remember to extend, and
across three phases nobody did.

So the fix is not another five entries. The Unity switch now falls through to a
**prefix-matched default**, and the web list gained a single `'ROUND'` prefix
that covers `ROUND2_*`, a future `ROUND3_*` and `ROUND_COMPLETE` alike. A
Round 3 event cannot silently fail to reach a screen the way Round 2's did.

Refreshing on an unrecognised event is cheap and always correct: both clients
re-read the authoritative snapshot rather than interpreting any payload, so a
spurious refresh costs one round trip and changes nothing.

Two network tests pin the server-side half of the contract — that the resolution
event and the immediately-following snapshot both carry the new balances, with
the fourth challenge asserted specifically because it has no successor event.

### The client-shape check earned its place immediately

Phase 6 learned that in-process tests can pass while the serialised client view
is wrong, so Phase 7A spec §37 asks for a Unity check reading real server JSON.
It found a real bug on its first run.

**JsonUtility cannot represent a null class field.** A JSON `null` deserialises
to a fully-constructed object with every field at its default, never to `null`.
So `round2 == null` and `current == null` are **never true in C#**, even though
the server correctly sends `null` — which it does for every round other than
Round 2, and for `current` once the round is complete.

Left alone, the Host panel would have drawn the Round 2 screen during every
other round, and shown a stale "current challenge" after the round finished.
Nothing would have raised an error. The fix is an `Exists` predicate on each
nullable DTO, keyed on a field the server never leaves empty.
