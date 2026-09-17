# Brains & Bacchanal — The Shared Systems

Phase 6. The systems every round draws on: Bacchanal Cards and the Clash, the
Market, held advantages, Maco Mail, Host Deals and the generic wager.

> **Status: implemented.** No round. No Round 1 allocation, no Think Fast, no
> Guess the Logo, no Family Feud board, no Sudden Death, no buzzer. Nothing in
> `OPEN_RULES.md` is resolved — and three of its entries visibly shape what is
> here.

---

## ⚠ A server restart still destroys the game

Unchanged from Phase 5, and now with more to lose: **card hands, Market
purchases, held advantages, the Maco Mail deck and every wager live in memory
only.** `ARCHITECTURE.md` §8 nominates PostgreSQL later; `RoomStore` remains the
seam. Do not restart the server during a game.

---

## Where the pieces live

| Concern | File |
|---|---|
| Card vocabulary, eligibility table, Clash types | `packages/protocol/src/cards.ts` |
| Market items, prices, advantages, stacking limits | `packages/protocol/src/market.ts` |
| Maco Mail outcomes, deck composition | `packages/protocol/src/maco-mail.ts` |
| Host Deal templates, wager rules | `packages/protocol/src/deals.ts` |
| Intents, events, the two safe views | `packages/protocol/src/shared-systems.ts` |
| Deterministic randomness | `packages/game-rules/src/rng.ts` |
| Ownership, dealing, play validation | `packages/game-rules/src/bacchanal-cards.ts` |
| Clash + Part Dat Fight | `packages/game-rules/src/clash.ts` |
| Market | `packages/game-rules/src/market.ts` |
| The one stacking/retry budget | `packages/game-rules/src/advantages.ts` |
| Maco Mail deck and outcomes | `packages/game-rules/src/maco-mail.ts` |
| Host Deals and wagers | `packages/game-rules/src/deals.ts` |
| Coordination + the safe views | `packages/game-rules/src/shared-systems.ts` |

`SharedSystems` is held by the `GameEngine`, not beside it. Every subsystem moves
BB through the **same** `BbLedger`, and several key on the challenge and pause
state the engine owns — so "a purchase cannot happen while the game is paused" is
one guard rather than a rule each subsystem must remember.

---

## Randomness is injected, like the clock

Four things are random, and every one decides something players will argue
about: the starting deal, the Maco Mail shuffle, Card Confiscation's victim, and
any reshuffle. A test that cannot fix those cannot assert anything about them.

```ts
interface Rng { nextFloat(): number }   // SystemRng in production, SeededRng in tests
```

The engine never calls `Math.random`. `rng.ts` also carries `pickOne` and a
non-mutating Fisher-Yates `shuffle`; `pickOne` returns **null** for an empty
list rather than throwing, because "no legal candidate" is a real game outcome
here (a dud), not an error.

---

## Bacchanal Cards

### Identifiers, never labels

The card is `GIMME_DAT`; "Gimme Dat!" is a display string in
`CARD_DISPLAY_LABELS`. A designer renaming a card on screen must not be able to
break an eligibility table.

### The seven cards and three categories

`GAME_RULES_LOCKED.md` §2. Categories are not cosmetic — the Clash triangle is
defined over them, so **the category is the combat mechanic**.

| Category | Cards |
|---|---|
| `DISRUPTION` | `STEUPS`, `GIMME_DAT`, `MACO` |
| `POWER` | `DOUBLE_IT`, `DOH_KNOW` |
| `RECOVERY` | `FORGIVE_MEH`, `ALLYUH_HELP_ME` |

`categoryOf()` is the single source. Phase 6 spec §4 forbids duplicating this
mapping into round code.

### The starting hand

One random card from each category — exactly three, dealt authoritatively
through `HOST_DEAL_BACCHANAL_CARDS`, and reproducible for a given seed.

Dealing is **separate from `START_GAME`** deliberately: a Host may want to
explain the cards first, and a deal that happened invisibly at game start would
have no place in the event log's causal order.

### Card lifecycle

```text
HELD ──play──▶ PENDING ──survives Clash──▶ RESOLVING ──▶ CONSUMED
                  │
                  └──loses Clash / Part Dat Fight──▶ HELD (barred for this challenge)
```

A card is **not** consumed when played. §5 gives opponents three seconds to
counter, and a losing card returns — so consumption waits for the Clash.

### Eligibility — the locked table

`GAME_RULES_LOCKED.md` §6 / D-007, transcribed into `CARD_ELIGIBILITY` and
nowhere else.

| Challenge kind | Allowed |
|---|---|
| `ROUND1_TRIVIA` | Gimme Dat, Double It, Doh Know, Allyuh Help Me, Forgive Meh |
| `ROUND2_PHYSICAL` | Double It |
| `THINK_FAST` | Steups, Double It, Forgive Meh |
| `GUESS_THE_LOGO` | Double It |
| `ALL_ANSWERS_BEGIN_WITH` | Double It, Forgive Meh |
| `SING_A_SONG` | Double It |
| `FAMILY_FEUD_Q1_Q3` | Steups, Double It, Forgive Meh |
| `FAMILY_FEUD_Q4_Q5` | Steups, Forgive Meh |
| `SUDDEN_DEATH` | *(none)* |

`CardChallengeKind` is **distinct from `challengeType`**, which stays a free
string. A round declares "for card purposes I am a Round 1 trivia question"
without the engine gaining an opinion about what a round contains —
`OPEN_RULES.md` §1 still leaves that open.

Q4/Q5 excludes Double It because those questions are already doubled and
multipliers never stack.

### 🔓 Maco! — `OPEN_RULES.md` §7 is still open

**Maco! exists, is dealt, and can never be played.**

It appears in no row of the approved table, and the owner's standing instruction
is to leave it out without deleting it. So:

- the card type exists, so a later decision has something to attach to,
- it stays in the Disruption pool and **may be dealt** (spec §6 forbids removing
  it),
- `cardHasAnyLegalChallenge('MACO')` is `false`, and
  `CARDS_WITHOUT_LEGAL_CHALLENGE` **derives** to `['MACO']` rather than being
  written down — so resolving §7 by adding MACO to the table empties it
  automatically,
- a player sees it as held with reason `compatibility_unresolved` — "the rule is
  still being decided", never "wrong challenge", which would imply a right one
  exists,
- the server refuses the play regardless of what a client offers.

A test asserts all of this. If someone gives Maco! a challenge, that test fails.

### Playing a card — what the server checks

Phase 6 spec §7, every item, in `BacchanalCards.play`:

correct team · card owned · still `HELD` · challenge exists · eligible for this
challenge kind · timing window open · team has not already played · target valid
where required · not paused.

Actor authority is the **room's**, checked before the engine is reached — the
same split as every Phase 5 intent. A client disabling a button is never the
protection.

### One card per team per challenge

`GAME_RULES_LOCKED.md` §2, and it holds **even when the card comes back**. Two
separate facts, stored separately (spec §8):

| Fact | Scope | Set when |
|---|---|---|
| `teamsWhoPlayed` | the team | a card is committed |
| `barredCardInstanceIds` | one card | that card loses a Clash |

Inferring either from the other gets Part Dat Fight wrong, where cards return to
hand **and** their teams are finished for the challenge.

---

## The Bacchanal Clash

### The triangle is a cycle

```text
DISRUPTION ──beats──▶ POWER ──beats──▶ RECOVERY ──beats──▶ DISRUPTION
```

There is no strongest category, so "which card wins" is not a maximum over an
ordering — it does not have one. **A tie is therefore a first-class locked
outcome, not an edge case to break.**

### The window

Three seconds, hidden, targets locked before reveal. `CLASH_RESPONSE_WINDOW_MS`
is a constant because §5 actually locks it — nearly every other duration in this
game is open (`OPEN_RULES.md` §2, §6, §11) and stays caller-supplied.

Built on the Phase 2 `Deadline`, so it pauses with the game (D-011) and a
FakeClock drives it in tests. A team does not lose its chance to counter because
someone's phone died.

**One response per team, no revision.** A duplicate is refused rather than
replacing the first — replacing would let a team probe and revise inside a window
whose whole point is that it is hidden.

Resolution is **polled**, not scheduled: `@bb/game-rules` owns no wall clock, so
the room checks on every intent and on the server's 250 ms tick. A window closing
with nobody acting is the normal case.

### Outcomes

| Case | Result |
|---|---|
| No counter | `uncontested` — the original card resolves |
| One category survives | `winner` — it resolves and is **consumed**; losers return |
| Categories tie | **PART DAT FIGHT** — no effect, every card returns |

### Part Dat Fight — all five locked cases

`GAME_RULES_LOCKED.md` §5, Phase 6 spec §10. Implemented in one pure function,
`resolveClashEntries`, so every branch is testable without a clock or a card
system.

| Situation | Outcome | Why |
|---|---|---|
| Two teams, same category | Part Dat Fight | Nothing separates them |
| Three teams, all three categories | Part Dat Fight | Closed cycle — no card is unbeaten |
| Three teams, all same category | Part Dat Fight | Nothing separates them |
| Two same + one different, **single wins** | Single card wins | The triangle is total between any two distinct categories |
| Two same + one different, **pair wins** | Single eliminated, then Part Dat Fight between the pair | §5 exactly: "surviving pair causes Part Dat Fight" |

In every Part Dat Fight: **no effect resolves**, every card returns, and the
teams stay barred for that challenge. The bar is never lifted — this function
returns cards, it does not restore anyone's right to play.

---

## Card effects

The shared system tracks **ownership, legality, timing and consumption**, then
hands the round a resolved, legal effect. What the effect is *worth* is the
round's, and for several challenges is still open.

| Card | What Phase 6 does | What Phase 7 supplies |
|---|---|---|
| `DOUBLE_IT` | Spends the shared multiplier budget; `applyMultiplier()` returns ×2 | The base reward |
| `FORGIVE_MEH` | Spends the shared **retry** budget (§4) | What a retry means in that challenge |
| `STEUPS` | Records the effect and its target | The answer pool it removes from |
| `GIMME_DAT` | Records the steal and its target | The question allocation |
| `DOH_KNOW` | Records the pass and receiving team | The question and the reward |
| `ALLYUH_HELP_ME` | Records the consult and assisting team | The challenge's timing |

### Steups, stated precisely

When played on an opposing team's valid answer: that answer leaves the defending
team's pool, the defenders must give another, and they cannot reuse it. The
Steups team **may** later use that answer — and is **not required to**. It does
not mean "you must use their answer next turn."

🔓 The Family Feud board specifics (`OPEN_RULES.md` §8) are **not** implemented:
whether the answer stays unrevealed, whether its BB stays off the board, what
happens if it was already revealed.

---

## Retry and stacking — one budget, two sources

The reason `advantages.ts` exists in this shape. `GAME_RULES_LOCKED.md` §4:

> Market Second Chance and FORGIVE MEH! cannot be chained. Maximum **one retry
> on the same question**. If both are available: the team chooses which one to
> use, the other remains available for a later eligible question.

A Market advantage and a Bacchanal card therefore draw on **one** per-challenge
budget. If each tracked its own, a team holding both would get two retries.

| Limit | Per | Source |
|---|---|---|
| One retry | challenge | §4 / D-006 |
| One Double | challenge | §3, §10 — "multipliers never stack" |
| One clue | challenge | §10 |
| One time extension | challenge | §10 |
| One copy of each Market item | activation | §10 |

Budgets are **per question**, so they reset when a challenge ends. The
advantages themselves persist until used or expired.

Phase 6 spec §40: future round code **queries** this rather than implementing
its own stacking logic.

A Market `DOUBLE_BB`, a Maco Mail `DOUBLE_POINTS` and a `DOUBLE_IT` card all
resolve to the single `DOUBLE` advantage type — which is what makes "multipliers
never stack" checkable in one place.

---

## The Market

Opens before Rounds 2, 3 and 4 — **never Round 1**. `MarketRound` is typed
`2 | 3 | 4`, so "Market before Round 1" is not expressible.

### Prices — locked, in one place

| Item | R2 | R3 | R4 |
|---|---:|---:|---:|
| Clue | 200 | 250 | 400 |
| Second Chance | 250 | 300 | 500 |
| Double BB | 250 | 300 | 750 |
| Extra Time | 200 | 250 | 400 |
| Maco Mail | 500 | 500 | 750 |

Clients ask the server what something costs; no price is written in any UI.

### Affordability is checked *before* deduction

Two rules that interact badly if handled sloppily:

1. BB floors at 0, centrally, in the ledger.
2. A team must not buy what it cannot afford.

**These are not the same rule.** Relying on the first to deliver the second is a
real bug: deducting 500 from a team holding 300 would leave them at 0 and hand
them the item for 300. So affordability is checked first, and the ledger is only
touched once the purchase is known to be legal.

### Hidden shopping

While the Market is open, `otherTeamPurchases` is **empty** — not reduced to a
count. A count would itself reveal how much an opponent has committed, which is
what §10's hidden shopping protects. `revealed` is an explicit recorded flag
rather than `!open`, so a client cannot show purchases a moment early.

### An opponent's visible BB freezes too

Found during physical two-phone testing: Phase 5 makes every team's BB always
visible, on purpose — "a party game shows the scores on a TV" — and that
otherwise defeats §10's hidden shopping through a side channel. A live balance
dropping by 250 while the Market is open tells an opponent "they bought
something, and roughly what tier", even with the item itself correctly hidden.

So while a Market is open, a player's snapshot shows every **other** team's BB
frozen at the value it held the moment that Market opened
(`Market.frozenBalanceFor`); the asking team's **own** BB stays real-time. On
close, every balance snaps back to its true current value together with the
purchase reveal — the same moment §10 already reveals purchases.

**The Host is unaffected.** `frozenBalanceFor` is applied only when building a
*player* snapshot (`room.ts`); the Host's own `teams` stays fully live, because
the Host adjudicates and already sees every purchase as it happens.

### Withdrawing a purchase — the grocery-cart reading of §10

§10 says "purchases are final unless an effect grants refund." Read literally
on its own, that line could be taken to mean a purchase is locked in the
instant it is made. It is not: the surrounding rules describe a Market
**visit** — "multiple different items may be purchased", "shopping is
hidden", "purchases reveal when Market closes" — and "final" is what happens
at the end of that visit, at **checkout**, not at every tap along the way.
The same way putting a second item in a grocery cart and later taking the
first one back out is not "undoing a purchase" — the purchase happens at the
register.

So while the Market is **open**, a team may withdraw its own unrevealed
purchase (`WITHDRAW_MARKET_PURCHASE`, `SharedSystems.withdrawPurchase`):

- refunds the actual price paid, through the ledger, exactly like Cancel
  Market Purchase,
- frees the item to be bought again (or something else instead) — the "one
  copy per item per activation" rule only counts **standing** purchases,
- stays hidden exactly like the purchase itself was: the withdrawal reaches
  only the withdrawing team, and an opponent's snapshot never carries the
  purchase id needed to attempt one,
- is refused the instant the Market **closes** — that is checkout, and from
  that moment §10's "final" applies in full.

**Ownership is checked before anything else.** The engine verifies the
purchase actually belongs to the calling team before touching it, the same
discipline every other Phase 6 player intent uses — a team cannot even learn
whether a purchaseId exists by guessing one.

**The advantage moves with the purchase.** A purchase and the advantage it
grants (a Clue from buying `CLUE`, say) were two separate records the moment
either could stop existing — first from Maco Mail's Cancel Market Purchase
card, now from a team's own withdrawal too. `Advantages.revokeForPurchase`
removes an **unused** advantage by the purchaseId that granted it; both
`SharedSystems.cancelPurchase` (the coordination point both paths now share)
and the Maco Mail card call it, so neither can leave a team holding an
advantage whose Market slip no longer exists. Already-used advantages are
left alone — the same rule Cancel Market Purchase already applies to a
**used** purchase.

### Expiry

§10 — items "expire after the immediately following round". Bought before Round
2 → usable during Round 2 → gone once Round 2 ends. Driven by the engine when it
enters a new round intro.

**Maco Mail advantages do not expire this way** (§7 — held until used or the game
ends), and `Advantages.expireAfterRound` skips them by source. The source decides
expiry, not the caller, so passing the wrong thing cannot delete a Maco advantage
early.

### `pricePaid` is stored, never recomputed

Cancel Market Purchase refunds **the actual amount paid, surcharge included**
(spec §31). Re-deriving it from the current listed price would short-change any
surcharged team and break entirely across a round boundary where prices change.

---

## Maco Mail

20 cards, drawn **without replacement**, composition entirely in
`MACO_DECK_COMPOSITION` (D-010).

### The dud distinction

The rule most easily blurred, and spec §35 asks for it explicitly:

| | When | What happens |
|---|---|---|
| **Structurally impossible** | filtered **before** the draw | Never drawn. The effect could never apply again all game |
| **Currently no valid target** | decided **after** the draw | A **DUD** — no redraw, no refund. The card is spent |

The difference is **permanence**. Cancel Market Purchase with no opponent
purchases *right now* is a dud — that may change next round. Hands Tied when no
eligible challenge remains at all is impossible; leaving it in would waste draws.

Which challenges count is **supplied by the caller**, never decided here (spec
§34). The defaults are permissive, because assuming no future challenge would
silently remove Hands Tied from the deck — a rule decision that belongs to a
round.

### Held advantages stay out of the deck

§7. A card that becomes a held advantage does **not** reach the discard, so a
reshuffle can never take it back (spec §36). The deck view counts them
separately.

### Outcomes

| Kind | Cards | Behaviour |
|---|---|---|
| Immediate money | +100, +500, +1,000, +1,500, Wrong Investment Bro (−250), Customs Seize Yuh Money (−1,000) | Applied through the ledger, floored at 0 |
| Held advantage | +15 Seconds, Free Clue, Bacchanal Immunity, Double Points | Out of the deck until used or the game ends |
| Targeted | Partner I Sorry, Cancel Market Purchase, Card Confiscation | Needs a valid opponent, else a dud |
| Held effect | Price Gone Up!, Hands Tied | A lasting burden on another team |

### 🔓 Partner, I Sorry — `OPEN_RULES.md` §12 is still open

The amount (500) is locked. What happens when the **payer holds less than 500**
is not: the recipient gets what can be transferred, or the full 500 with the
payer floored at 0, or another rule.

So the resolver splits:

- payer holds **500 or more** → resolves normally as a two-sided transfer,
- payer holds **under 500** → `blocked_open_rule`. No BB moves on either side,
  and the Host is told why.

It is deliberately **not** a dud. A dud is a locked outcome with consequences;
this is an absence of a rule. Tests assert the block and assert nothing about
what should happen instead.

### Bacchanal Immunity

Cancels a Bacchanal card used **against** the protected team. The immunity is
consumed, the attacking card has no effect, and the **attacking team keeps its
card** — it returns to hand rather than being consumed (though its team stays
barred for that challenge, because it did play).

It does **not** protect against the Market, Maco Mail, a Host Deal or a wager —
and those systems simply never ask.

---

## Host Deals

Maximum **one per round** (D-009), counted per round index. An offered-but-
unanswered deal still counts: otherwise a Host could offer four and let the team
pick the best.

### The Host cannot invent maths

§9 — "Deal mathematics come from predefined templates and are not improvised."

**No amount travels on the intent.** The Host names a template; every number
comes from `HOST_DEAL_TERMS`. A rogue `declineBb: 99999` in a payload changes
nothing, because no handler reads one. A network test asserts exactly this.

| Template | Decline | Accept |
|---|---|---|
| `KEEP_OR_RISK` | keep 500 | give it up, open a Maco Mail |
| `DOUBLE_OR_NOTHING_ISH` | keep 500 | risk it: correct next = 1,000, wrong = 0 |
| `MYSTERY_DEAL` | — | pay 300 for a Maco Mail |
| `OPPONENTS_DEAL` | take 500 | give an opponent 250, receive a Maco Mail |

Read `KEEP_OR_RISK` carefully: accepting costs **0**, not 500. The team never
receives the 500 — it is the price of the draw, not a deduction. Modelling it as
a deduction would wrongly charge a team holding under 500.

`MYSTERY_DEAL` is the only template that spends a team's own balance, so it is
the only one where affordability is checked.

`DOUBLE_OR_NOTHING_ISH` settles later, through `settlePendingBet`, because
"correct next answer" is a round's business. The deal records the stake and
stops.

---

## The generic wager

`GAME_RULES_LOCKED.md` §19 — up to **50% of current BB**, placed before
answering. Phase 6 builds the primitive only; it is **not** connected to a Family
Feud board, and no board exists.

`maxWagerFor()` floors to a whole number, so it stays at or under the ceiling.

**The balance is captured at lock time.** A wager validated against 1,000 BB
stays valid even if the team's balance later falls — re-checking at resolution
would let an unrelated Maco Mail penalty silently void a legitimately placed bet.

Resolution is exactly once, and the loss floors at 0 through the ledger like
everything else. Board BB is **not** paid here — that is the round's, applied
through a challenge result.

---

## Hidden information — the boundary

Phase 6 spec §42 is the hardest requirement in this phase and the one a refactor
is most likely to break quietly. The protection is **structural**:

> A player's view has no field that could carry a secret.

| Secret | How it is protected |
|---|---|
| Opponent card hands | `OpponentHandView` has a count and **no card-type field** |
| Hidden Market purchases | `otherTeamPurchases` is empty until `revealed` |
| Clash responses before reveal | `ClashView` carries `respondedTeamIds`; card types live in `result`, null until the reveal |
| Own Clash response | `yourClashResponse` — the one deliberate exception, to its own team only |
| Maco Mail deck order | `MacoDeckView` is **counts only — for the Host too** |
| Another team's Maco draw | `yourMacoDraws` is scoped to the asking team |

The Host view is broad — every hand, every purchase — because the Host
adjudicates. It still gets **no deck order** (a Host display is usually pointed at
a TV the players can see) and **no Clash response before the reveal** (a Host who
could see early would have to act unaware).

Two channels, deliberately different:

- a **purchase** reaches its buyer in their own acknowledgement; the broadcast
  says only *that* a team bought something,
- a **Clash response** likewise.

This is asserted against real wire bytes in
`apps/game-server/src/rooms/shared-network.test.ts`, not only against function
return values — a view can be perfectly shaped and still leak if the wrong object
is serialised.

---

## Reconnect

Everything survives, and **nothing repeats**:

| During | Restored | Never |
|---|---|---|
| Held cards | the same hand, same instance ids | redealt |
| Open Market | own purchases, own advantages | rebought |
| Hidden purchases | still hidden from opponents | revealed early |
| Active Clash | the window, paused if the game is | re-responded |
| Held advantages | intact, Maco ones unexpired | redrawn |
| Host Deal | the pending offer and its terms | re-offered or re-paid |
| Wager | locked at its amount | re-resolved |

Recovery is by authoritative snapshot plus sequence, exactly as Phase 5.

---

## Open rules that shaped this phase

| Rule | Status | What was built instead |
|---|---|---|
| §7 Maco! compatibility | **open** | Card exists, dealt, no legal challenge anywhere; reported as `compatibility_unresolved` |
| §8 Family Feud Steups board | **open** | Generic Steups effect only; no board behaviour |
| §9 Family Feud Forgive Meh / strikes | **open** | Shared retry budget only; no strike interaction |
| §10 Inactive third-team card use | **open** | Nothing assumes who may play; a round declares eligibility |
| §12 Partner, I Sorry under 500 BB | **open** | Resolves at ≥500; `blocked_open_rule` below |
| §1, §2, §3, §4, §5, §6, §11 | **open** | No round, no timer, no scoring decided anywhere here |

---

## What Phase 6 deliberately did NOT decide

- **No challenge duration**, except the Clash's locked 3 seconds.
- **No reward amount.** A round supplies the base; this applies the multiplier.
- **No round composition.** `CardChallengeKind` names a row of an approved
  table, not a round's contents.
- **No meaning for a card effect** beyond ownership, legality and consumption.
- **No Family Feud anything.** The wager is a primitive with no board.
- **No Host-disconnect rule.** Still open, unchanged from Phase 5.

---

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` / `lint` / `test` / `build` | **PASS** |
| Deterministic rule tests (FakeClock + SeededRng) | **PASS** — 204 new |
| End-to-end over real WebSockets | **PASS** — 22 new |
| Total suite | **PASS — 712** |
| Compiled-server smoke walkthrough | **PASS** — all checks |

The network tests matter more than they look. Spec §42 is a claim about **bytes
on a wire**, not about a function's return value, so those tests read the JSON a
real client receives and assert that an opponent's cards, a hidden purchase and
an unrevealed Clash response are not in it.
