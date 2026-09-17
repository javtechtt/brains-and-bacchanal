# Brains & Bacchanal — Round 3

Phase 7B. Four challenges, a challenge-win counter that decides the round, and a
rock-paper-scissors tiebreaker.

> **Status: implemented.** No Round 1, no Round 4, no Family Feud, no Sudden
> Death, no buzzer. The Think Fast answer timer stays open (`OPEN_RULES.md` §2).

---

## ⚠ A server restart still destroys the game

Unchanged since Phase 5. **Everything is in memory only**, and Round 3 adds
challenge scores, the challenge-win counter and the tiebreaker to what is lost.
`RoomStore` remains the seam; `ARCHITECTURE.md` §8 nominates PostgreSQL. Do not
restart the server during a game.

---

## Three counters, and they are not the same

This is the thing the whole round turns on, and the one a refactor is most
likely to collapse. `GAME_RULES_LOCKED.md` §13 states it with a worked example
for exactly that reason.

| | Scope | Decides | Resets |
|---|---|---|---|
| **Challenge points** | one challenge | who won *that* challenge | every challenge |
| **Challenge-win counter** | the round | the **Round 3 winner** | never, within the round |
| **BB** | the game | the game's score | never |

```text
Guess the Logo:  Team A = 5 logos,  Team B = 3 logos
  → Host confirms Team A
  → Team A challenge-win counter += 1
  → NO BB (§15 awards none)

Five logos is ONE Round 3 win. Not five. Not BB.
```

They are three separate fields in `Round3StateView`, and none is derived from
another. `challengeWins` is **never written to the BB ledger** — it is not
money, and a ledger entry for it would make it look like money.

---

## The four challenges

`GAME_RULES_LOCKED.md` §13–§17, in the locked order:

| # | Challenge | Format | Target | BB | Cards |
|---|---|---|---:|---:|---|
| 1 | Think Fast | elimination | — | **500** | Steups, Double It, Forgive Meh |
| 2 | Guess the Logo | points | 5 | 0 | Double It |
| 3 | All Answers Begin With… | points | 5 | 0 | Double It, Forgive Meh |
| 4 | Sing a Song | points | 3 | **500** | Double It |

**BB is awarded exactly where a locked rule says so** — §14 and §17. Guess the
Logo and All Answers Begin With award none; their scoring was never defined as
BB, and inventing one would have been a rule decision.

**Winning Round 3 overall awards no BB.** No locked rule grants one.

### Format, not identity

The engine and the Host UI branch on `format` (`elimination` or `points`) rather
than on the challenge's name. Think Fast eliminates; the other three score
points. A future challenge of either shape needs no new UI and no new engine
path.

### Where the pieces live

| Concern | File |
|---|---|
| Config, order, intents, events, views | `packages/protocol/src/round3.ts` |
| Progression, Think Fast, RPS | `packages/game-rules/src/round3.ts` |
| Content source and TEST packs | `packages/game-rules/src/round3-content.ts` |
| Engine wiring | `packages/game-rules/src/game-engine.ts` |
| Routing and authority | `packages/game-rules/src/room.ts` |
| Host display | `unity/host/Assets/Scripts/HostRound3Panel.cs` |
| Host DTOs | `unity/host/Assets/Scripts/Protocol/Round3Messages.cs` |
| Player screen | `apps/web/src/rooms/PlayerRound3.tsx` |

---

## The game supplies the content

`GAME_RULES_LOCKED.md` §13 — for Rounds 1, 3 and 4 the **game** supplies
challenge content. The Host runs the challenge and judges it; the Host does not
invent the topic, the logo, the letter or the song scenario during play.

So `HOST_NEXT_ROUND3_ITEM` **reads no content from its payload**. It asks the
room's `Round3ContentSource` for the next item of the running challenge. A Host
client sending `{"body": "..."}` changes nothing, because no handler looks at
it — asserted over a real socket, and again in the Unity check.

### The seam

```ts
interface Round3ContentSource {
  nextItem(challengeType): Round3ContentItem | null;
  remaining(challengeType): number;
}
```

There is no production content pipeline yet, and Phase 7B deliberately did not
build one — `CONTENT_POLICY.md` describes a sealing flow that lives outside this
repository. Development uses `createTestContentSource()`; when a real source
arrives it implements this interface and **nothing in the round changes**.

That seam is the point. The alternative — a Host typing prompts into a box —
would have quietly become the production flow.

### What never reaches a client

- **No accepted answer.** `Round3ContentItem` has no field for one, because
  every Round 3 answer is judged subjectively by the Host.
- **No queue, no "next", no total.** Only the current item is ever sent, so a
  snapshot cannot carry a future logo or reveal how many remain.
- **TEST content is obviously fake.** `TEST LOGO 1`, not a plausible brand. The
  project owner also plays the game, and a realistic fixture invites someone to
  promote it — which `CONTENT_POLICY.md` forbids absolutely.

---

## Think Fast — §14

**One topic for the whole challenge.** §14 describes teams alternating answers
against a single topic ("name things in a kitchen") until one remains — there is
no next item, and the topic IS the challenge.

So the topic is revealed **automatically when the challenge starts**, and a
second reveal is refused. Every definition declares `itemMode`: `single` for
Think Fast, `stream` for the other three, which each advance item by item.

Turn-based elimination. A team that cannot give another valid answer is out of
*this challenge*; the last team still answering wins 500 BB and one Round 3 win.

### Turn order comes from the previous round's standings

D-031, and `GAME_RULES_LOCKED.md` §1: **winning a round means holding the most
total BB when it ends.** The team that won the previous round answers first,
then the others in placement order.

This replaced §13's old rock-paper-scissors rule, and closed the three-team
question `OPEN_RULES.md` §3 had left open — the same rule now covers both.

**The order is fixed when the challenge starts**, not read live. A Market
purchase or a Maco Mail penalty mid-challenge cannot reorder play already under
way.

Accepted consequence, recorded so it is not later mistaken for a bug: total BB
includes Market spending and Maco Mail outcomes, so a team can lead entering
Round 3 without having won a physical challenge. That follows from BB being both
currency and score.

### The Host judges, and confirms

`HOST_THINK_FAST_VALID` passes the turn; `HOST_THINK_FAST_ELIMINATE` puts the
current team out. Eliminating the last remaining team is refused — there would
be nobody left to win.

The winner is still **confirmed** by the Host, exactly like the other three. An
eliminated team cannot be confirmed as the winner.

### 🔓 The answer timer is still open

`OPEN_RULES.md` §2. An 8-second timer was discussed early and 10 seconds has
been suggested since; **neither is locked**, so `itemWindowMs` is `null` for
Think Fast and nothing starts a timer on its own.

What a **timeout means** is also undecided, and D-022 is explicit that expiry
decides nothing by itself. Until that is settled, a Think Fast timeout hands the
challenge to the Host rather than eliminating anyone automatically.

---

## The three points-scored challenges — §15, §16, §17

Each supplied item has a **10-second window**. A valid answer scores **+1
challenge point**. The Host may move to the next item immediately, or let the
window run out.

### The Host confirms the winner — always

Each has a **normal target**: 5 logos, 5 prompts, 3 songs. Reaching it is a
display hint (`targetReached`), **not a resolution**.

> §15–§17 give the Host discretion to confirm a winner before or after the
> target.

So a score never resolves a challenge. The Host may end it early, let it run
long, or — because these are spoken challenges and the Host is the authority on
who answered first — confirm a team that is not leading on points. All three are
tested.

**All Answers Begin With** additionally carries the required letter on the item,
supplied by the game with the prompts.

**Sing a Song** is judged entirely by the Host: who sang first, whether the line
was complete enough, whether it matched. There is no audio recognition anywhere,
deliberately.

---

## Winning Round 3, and the tiebreaker — §18

After the fourth challenge, the **highest challenge-win counter** takes the
round. A tie goes to **actual rock-paper-scissors**.

> **This is not a Bacchanal Clash.** No card is involved or spent, the
> categories are unrelated, and the UI is deliberately not reused. The only
> similarity is that both hide choices until a reveal — which is precisely why
> RPS is a separate type all the way down rather than a borrowed one.

### How it runs

Only tied teams take part. Each locks a choice privately; the server reveals
when **every** tied team has chosen, on its own tick, so the reveal is
simultaneous rather than triggered by whoever acted last. A duplicate submission
is refused rather than replacing the first — the window is hidden so a team
cannot probe and revise.

| Case | Outcome |
|---|---|
| Two teams, different choices | the winner takes the round |
| Two teams, same choice | replay |
| Three, all the same | replay |
| Three, all different | replay — the cycle closes, nothing is unbeaten |
| Three, two-same + one, **single wins** | that team takes the round |
| Three, two-same + one, **pair wins** | the single is out; the pair replays |

### A three-way tie cannot happen with four challenges

Verified exhaustively over all 81 ways four challenges can be split between
three teams: the only ties reachable are **two-way at 2-2-0**. The three-team
branches above are still implemented and tested, because §18 locks them and a
change to the challenge count would make them reachable — and a test records the
impossibility so that change surfaces it.

### Secrecy

An unrevealed choice is not in **anyone's** JSON — not an opponent's, and not
the Host's. The Host adjudicates but has no reason to see a throw early, and
seeing one would force them to act unaware.

A team sees its **own** locked choice (`yourChoice`), scoped to its owner — the
one deliberate exception, exactly as the Clash makes for `yourClashResponse`.
This is asserted against real wire bytes in the network test and again in the
Unity check.

---

## Cards and the shared systems

Round 3 has **no card rule of its own**. Each challenge names its row of the
approved table (`THINK_FAST`, `GUESS_THE_LOGO`, `ALL_ANSWERS_BEGIN_WITH`,
`SING_A_SONG`) and the Phase 6 eligibility engine does the rest.

### Double It

It doubles a challenge's **BB**, one per challenge, exactly as
`GAME_RULES_LOCKED.md` §3 has always said. D-031 confirmed no change was needed.

Where a Round 3 challenge awards no BB — Guess the Logo, All Answers Begin
With — Double It has **nothing to double**. It remains legal there per the
approved table, and doubling simply has no effect.

**It is deliberately not given a counter meaning.** "Two Round 3 wins" is not a
rule anyone wrote, and inventing one would decide something the owner did not.
The resolution reports `doubled: false` when the award was zero, so a display
cannot imply an effect that did not occur.

---

## Pause, and the active-player rule

The 10-second item window is a `Deadline`, so it **freezes with the game** like
the challenge timer and the Clash window (D-011). A team does not lose its
window because someone's phone died.

Like Round 2, Round 3 marks **no software-active players**: these are spoken
challenges happening in the room, and nobody's participation is required through
a phone. A sleeping phone does not stop the party. D-021.

---

## Reconnect

| During | Restored |
|---|---|
| Any challenge | the challenge, its points, and the current item |
| An item window | the window, with its remaining time |
| Think Fast | the turn order, whose turn, and who is out |
| Between challenges | the round's position and every earlier result |
| An open RPS attempt | the attempt — **without leaking a hidden choice** |
| After the reveal | the revealed choices and the winner |
| Unity Host | the same round, same counters, same state |

Nothing duplicates: no double points, no double counter increment, no repeated
BB.

---

## Development entry

Round 1 does not exist, so `DEV_START_ROUND3` exists for the same reason
`DEV_START_ROUND2` does — and with the same discipline. It walks the **real**
transitions with a clearly-named `DEV_ROUND_SKIP` placeholder per skipped round,
then calls the same `beginRound3()` a real Round 2 completion will.

Host-only, and refused unless the server runs with `GAME_SERVER_DEV_TOOLS`
enabled (D-024). Gated by the **server**, so a client built with the button
still cannot use it.

---

## Protocol

**Intents** — Host-only except one

| Intent | Notes |
|---|---|
| `HOST_PREPARE_ROUND3_CHALLENGE` | Takes no type; the round hands out the next |
| `HOST_NEXT_ROUND3_ITEM` | **Reads no content from the payload** |
| `HOST_AWARD_ROUND3_POINT` | Points, never BB |
| `HOST_THINK_FAST_VALID` / `HOST_THINK_FAST_ELIMINATE` | §14 |
| `HOST_CONFIRM_ROUND3_CHALLENGE` | Carries a team, never an amount |
| `SUBMIT_RPS_CHOICE` | **PLAYER intent** — a team chooses its own throw |
| `DEV_START_ROUND3` | Development only |

`SUBMIT_RPS_CHOICE` resolves the acting team **from the connection**, never the
payload — the same protection every Phase 6 player intent uses.

**Events**: `ROUND3_STARTED`, `ROUND3_CHALLENGE_PREPARED`,
`ROUND3_ITEM_REVEALED`, `ROUND3_POINT_AWARDED`, `THINK_FAST_TURN_CHANGED`,
`THINK_FAST_TEAM_ELIMINATED`, `ROUND3_CHALLENGE_RESOLVED`,
`ROUND3_COUNTER_CHANGED`, `RPS_STARTED`, `RPS_CHOICE_SUBMITTED`,
`RPS_REVEALED`, `ROUND3_WINNER_CONFIRMED`, `ROUND3_COMPLETED`.

`RPS_CHOICE_SUBMITTED` carries **who**, never **what**.

### Per-team counts travel twice, on purpose

`scores`, `challengeWins` and the revealed `choices` each ship as a keyed
`Record` **and** as a parallel list (`scoreList`, `challengeWinList`,
`revealedChoices`).

**Unity's JsonUtility has no dictionary support at all.** A keyed object
deserialises to nothing, silently — which is precisely the failure that put
"0 BB" on a TV in Phase 7A. The web reads the Record; Unity reads the list; both
are built from the same source in one place so they cannot disagree.

---

## What Phase 7B deliberately did NOT decide

- **The Think Fast answer timer**, and what a timeout means (`OPEN_RULES.md` §2).
- **What Double It means for a counter.** No rule defines it; none was invented.
- **BB for winning Round 3.** No locked rule grants any.
- **Round 1 and Round 4.** Round 3 stops at its winner.
- **A production content pipeline.** The seam exists; TEST content fills it.
- **Any audio, music or logo recognition.** The Host judges.

---

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` / `lint` / `test` / `build` | **PASS** |
| Deterministic Round 3 rule tests (FakeClock) | **PASS — 77 new** |
| Round 3 end-to-end over real WebSockets | **PASS — 14 new** |
| Total suite | **PASS — 900** |
| Compiled-server smoke walkthrough | **PASS — 24 checks** |
| Item-window auto-advance, targeted | **PASS — 4 checks** |
| **Unity Round 3 client-shape check** | **PASS — 36/36** |
| Unity Round 2 check (regression) | **PASS — 36/36** |
| Unity engine check (regression) | **PASS — 49/49** |
| Unity shared-systems check (regression) | **PASS — 43/43** |
| Unity lobby check (regression) | **PASS — 47/47** |
| IL2CPP Windows standalone build | **PASS** — 0 errors, 0 warnings |
| **Physical two-phone test, Unity Host + real phones** | **PASS** |

### Think Fast was unplayable, and physical testing found it

The first Phase 7B build treated all four challenges as item streams, so Think
Fast's topic could only be revealed with NEXT ITEM. A Host pressing it twice
exhausted the TEST pack and the challenge could not be run at all — reported
from a real two-phone session as *"the content source has no more items for this
challenge."*

Every automated test had passed, because every one of them either confirmed the
challenge immediately or never pressed NEXT twice. The bug lived in the gap
between "the server behaves correctly" and "a Host can actually run this".

Two things were wrong, and both are fixed:

- **The model.** §14 has ONE topic; the other three have streams. That is now
  `itemMode` on the definition, the topic is revealed when the challenge starts,
  a second reveal is refused, and the Host panel offers no NEXT button there.
- **The TEST content.** Think Fast had 2 items and the streams had 8 — not
  enough to let a Host run a challenge long, which §15–§17 explicitly permit.
  Now 6 topics and 15–20 stream items.

### A timed-out item window did nothing, and physical testing found that too

§15, §16 and §17 all lock the same instruction: *"if nobody answers correctly,
move to the next item."* `Round3.itemWindowExpired()` existed to detect this —
but nothing ever called it. The window counted down to zero and then sat
there, because no poller checked it and no Host action followed a timeout
automatically. Reported from the physical test: a Guess the Logo item that
nobody answered simply never advanced.

`GameEngine.pollTimerExpiry()` and `pollClashResolution()` are both polled on
the server's tick precisely so a stalled window cannot happen — this one was
implemented on the `Round3` side but never wired into that same tick, an
oversight rather than a design gap.

Fixed by adding `round3ItemWindowExpired()` to the engine and a matching poll
in the room's tick handler, alongside the existing timer and Clash polls. On
expiry the room asks the content source for the next item — the same seam
`HOST_NEXT_ROUND3_ITEM` uses — and reveals it automatically. If the source is
exhausted the window is cleared without a replacement, so the poll does not
re-report the same expiry forever; the Host then confirms a winner from
whatever the scores show.

Deliberately **not** given a scoring meaning: nobody answering does not score
a point for anyone, per D-022 — a timeout decides nothing by itself unless a
locked rule says otherwise, and none does here.

Only ever applies to a `stream` challenge. Think Fast has one topic and no
window at all, so there is nothing for it to expire.

### The physical test

Run on the real thing after the two runtime fixes above: the Unity Host on a
Windows machine, two real phones on the LAN, the compiled game server, and the
development Round 3 entry.

Covered: room creation and QR join, two teams locked, game start, the
development Round 3 entry, Think Fast with its auto-revealed topic and turn
order from the previous round's standings, elimination down to one team,
Guess the Logo with the game-supplied TEST logos, an item window running out
with nobody answering and the challenge advancing on its own, All Answers
Begin With with the game-supplied letter, Sing a Song judged by the Host,
Host discretion to confirm before and after each target, the challenge-win
counter incrementing separately from BB, a tied counter triggering the
rock-paper-scissors tiebreaker with both hidden-choice assertions holding on
real devices, a declared Round 3 winner, and a mid-round phone disconnect and
reconnect with no duplicated score, counter or BB.

**Two real bugs were found by physical testing, and both are fixed** — see
below. Every automated test had passed before either was reported, because
the fault in each case was in what the server (or the client) did around a
correctly-behaving piece, not in the piece itself.

### The two JsonUtility traps, anticipated this time

Phase 7A learned that **JsonUtility cannot represent a null class field** — a
JSON `null` arrives as a default-filled object. Round 3 has five nullable
objects (`round3`, `current`, `currentItem`, `thinkFast`, `tiebreaker`), and
every one carries an `Exists` predicate keyed on a field the server never leaves
empty.

Round 3 added a second trap: **JsonUtility cannot deserialise a dictionary at
all.** Left alone, every challenge score and every challenge-win count would
have read zero on the TV while the server held the real numbers — silently, and
only during a live game. The parallel lists exist for that reason, and the Unity
check asserts they are populated rather than merely present.
