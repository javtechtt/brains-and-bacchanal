# Brains & Bacchanal — Locked Game Rules

This file contains rules considered settled for development.

Anything not clearly defined here may still be listed in `OPEN_RULES.md`.

## 1. Core

- Each team begins with **1,000 BB**.
- BB is both spendable currency and final score.
- BB cannot go below 0.
- Highest BB after Round 4 wins unless tied leaders enter Sudden Death.
- Market opens before Rounds 2, 3 and 4.
- No digital buzzer is used before Family Feud.
- **Winning a round** means holding the most total BB when that round ends.
  Since BB is the score, the leader on BB is the leader. This is what later
  rounds mean by "the previous round's winner" — see §14. (Round 3 separately
  tracks a challenge-win counter that decides *its* winner; see §13.)

## 2. Bacchanal Cards

Each team starts with:
- one random Disruption card,
- one random Power / Strategy card,
- one random Recovery / Social card.

Categories:

**Disruption**
- Steups!
- Gimme Dat!
- Maco!

**Power / Strategy**
- Double It!
- Doh Know

**Recovery / Social**
- FORGIVE MEH!
- ALLYUH HELP ME!

A team may play a maximum of **one Bacchanal Card per question/challenge**.

Illegal cards must not be selectable.

## 3. Card Effects

### Steups!
Only usable in eligible multi-answer challenges in Rounds 3 and 4.

When an opposing team gives a valid answer:
- that answer is removed from the defending team's available answer pool,
- defending team must give another valid answer,
- defending team cannot reuse the removed answer during that challenge,
- the Steups team may later use the removed answer,
- using it is optional.

### ALLYUH HELP ME!
Your team may consult another team.

If the assisting team gives the correct answer in time, both teams receive the applicable BB reward.

### Gimme Dat!
Steal another team's assigned question before that team answers.

Target is chosen before reveal.

Requires a challenge that assigns different questions to different teams. Round 1
does not (§11 — every team answers the same question simultaneously), so this
card is not legal there. See §6.

### Double It!
Double the BB reward on one eligible question/challenge.

- activate before result,
- multipliers never stack,
- already doubled challenges cannot be doubled again.

### Maco!
Look at another team's **submitted** answer in a compatible challenge.

Viewing time: 10 seconds.

**Legal in Round 1 trivia only** (§6, §11). The target team must already have
submitted; a half-typed answer is never exposed. Seeing the answer does not copy
or submit it — the viewing team chooses whether to use or trust it.

### Doh Know
Pass your assigned question to another team.

- if they answer correctly, they receive normal BB,
- if they answer incorrectly, your team receives double normal BB,
- no stacking.

Like Gimme Dat!, this needs an individually assigned question, which Round 1 does
not have (§11). It is not legal there. See §6.

### FORGIVE MEH!
After an incorrect answer, receive one final answer opportunity.

The retry answer is final.

## 4. Retry Rule

Market Second Chance and FORGIVE MEH! cannot be chained.

Maximum **one retry on the same question**.

If both are available:
- team chooses which one to use,
- the other remains available for a later eligible question.

## 5. Bacchanal Clash

When a Bacchanal Card is played:
- opponents get a **6-second hidden response window**,
- responding teams secretly choose one eligible card,
- targets are locked before reveal.

Category triangle:
- Disruption beats Power / Strategy.
- Power / Strategy beats Recovery / Social.
- Recovery / Social beats Disruption.

No response → original card resolves.

Winning card resolves and is consumed.

Losing card returns but cannot be played again in that challenge.

If surviving categories tie → **PART DAT FIGHT!**

No effect resolves. Tied cards return. Those teams cannot play another Bacchanal Card in that challenge.

### Three-team Clash
- all three categories → Part Dat Fight,
- all three same category → Part Dat Fight,
- two same + one different → compare categories,
- if single category wins, single card wins,
- if paired category wins, single card is eliminated and surviving pair causes Part Dat Fight.

## 6. Approved Card Compatibility

| Challenge | Allowed Cards |
|---|---|
| Round 1 Trivia | Maco!, Double It!, ALLYUH HELP ME!, FORGIVE MEH! |
| Round 2 Physical Games | Double It! only |
| Think Fast | Steups!, Double It!, FORGIVE MEH! |
| Guess the Logo | Double It! only |
| All Answers Begin With... | Double It!, FORGIVE MEH! |
| Sing a Song | Double It! only |
| Family Feud Q1–Q3 | Steups!, Double It!, FORGIVE MEH! |
| Family Feud Q4–Q5 | Steups!, FORGIVE MEH! |
| Sudden Death | no Bacchanal Cards |

Q4/Q5 are already doubled, so Double It cannot be used.

**Maco! is legal in Round 1 trivia, and only there.** That resolves what was
`OPEN_RULES.md` §7 — the card previously appeared nowhere in this table and was
deliberately left undecided. Round 1's simultaneous-answer format is what gives
it a meaning: there is a submitted opponent answer to look at. See §11 and
`DECISION_LOG.md` D-030.

Gimme Dat! and Doh Know are **not** legal in Round 1. Both pass or steal an
assigned question, and Round 1 no longer assigns different questions to
different teams — every team answers the same one.

## 7. Maco Mail

- draw without replacement,
- used outcomes go to discard,
- empty draw pile reshuffles discard,
- held advantages stay out until used or game ends,
- eligible effect with no target = dud / lose-out,
- no redraw/refund/compensation for dud,
- structurally impossible future effects are removed before drawing.

Initial playtest deck:

| Outcome | Copies |
|---|---:|
| +100 BB | 2 |
| +500 BB | 2 |
| +1,000 BB | 1 |
| +1,500 BB | 1 |
| Wrong Investment Bro! | 2 |
| Partner, I Sorry | 1 |
| Customs Seize Yuh Money | 1 |
| +15 Seconds | 2 |
| Free Clue | 2 |
| Bacchanal Immunity | 1 |
| Double Points | 1 |
| Cancel Market Purchase | 1 |
| Card Confiscation | 1 |
| Price Gone Up! | 1 |
| Hands Tied | 1 |

Deck composition is configurable.

## 8. Maco Mail Effects

Money/penalty:
- +100 BB
- +500 BB
- +1,000 BB
- +1,500 BB
- Wrong Investment Bro! → lose 250 BB
- Partner, I Sorry → give 500 BB to an opposing team
- Customs Seize Yuh Money → lose 1,000 BB, floor 0

Advantages:
- +15 Seconds
- Free Clue
- Bacchanal Immunity
- Double Points

Game-changing:
- Cancel Market Purchase
- Card Confiscation
- Price Gone Up!
- Hands Tied

Detailed behavior should follow the existing Developer Rules Specification unless an item is listed in `OPEN_RULES.md`.

## 9. Host Deals

Maximum **one Host Deal per round**.

Host chooses when to offer it.

Deal mathematics come from predefined templates and are not improvised.

## 10. Market

Market opens before Rounds 2, 3 and 4.

Rules:
- multiple different items may be purchased if affordable,
- max one copy of each item per Market visit,
- spending reduces BB,
- purchases are final unless an effect grants refund,
- items expire after the immediately following round,
- shopping is hidden,
- purchases reveal when Market closes,
- purchased Maco Mail opens after reveal.

Prices:

| Item | Before R2 | Before R3 | Before R4 |
|---|---:|---:|---:|
| Clue | 200 | 250 | 400 |
| Second Chance | 250 | 300 | 500 |
| Double BB | 250 | 300 | 750 |
| Extra Time (+15 sec) | 200 | 250 | 400 |
| Maco Mail | 500 | 500 | 750 |

No stacking:
- one Double,
- one clue,
- one time extension,
- one retry maximum.

## 11. Round 1 — Nah, That Too Easy!

### Format

- trivia round,
- **15 questions total**: 5 Easy, 5 Medium, 5 Hard,
- **all teams receive the same question simultaneously**,
- **60 seconds per question**,
- no buzzer,
- each team nominates one player for Easy, one for Medium, one for Hard,
- **only the nominated player for that difficulty submits the team's answer**,
- the correct answer is revealed **after the question/retry flow is complete**.

### Scoring

| Difficulty | Value |
|---|---:|
| Easy | 20 |
| Medium | 30 |
| Hard | 50 |

- a wrong answer scores **0**; there is **no BB deduction**,
- the value is awarded as **BB**, retained in the team's main game balance,
- the same value is **also** counted as **Round 1 points**, totalled separately
  to decide the Round 1 winner.

Both are awarded from the one correct answer. Round 1 points are a separate
running total, not a second BB transaction.

### Round 1 Bacchanal compatibility

| Legal | Not legal |
|---|---|
| Maco! | Steups! |
| Double It! | Gimme Dat! |
| ALLYUH HELP ME! | Doh Know |
| FORGIVE MEH! | |

**Double It!**
- must be used before the result,
- a correct answer doubles **both** the BB and the Round 1 question score —
  Easy 20 → 40, Medium 30 → 60, Hard 50 → 100,
- a wrong answer remains 0,
- no stacking.

**Maco!**
- the target team must have **already submitted**,
- the nominated player sees that submitted answer for **10 seconds**,
- a half-typed answer is **never** exposed,
- viewing an answer does not copy or submit it — the player chooses whether to
  use or trust it.

**ALLYUH HELP ME!**
- target another team,
- the requesting team relies on the assisting team's **submitted** answer,
- if that answer is correct, **both** teams receive the question's normal BB and
  Round 1 score,
- if it is wrong, there is no additional benefit.

**FORGIVE MEH!**
- available after the team's first answer has a **final INCORRECT ruling**,
- the nominated player gets **10 seconds** for one final retry **before** the
  correct answer is revealed,
- the retry answer is final and is what the question is scored on,
- the shared one-retry maximum still applies (§4), so it cannot be chained with
  the Market's Second Chance.

The 10-second window was resolved by the project owner (D-032), closing what was
`OPEN_RULES.md` §13.

### Answers and grading

Answers are **free text**, typed by the nominated player.

- **60 seconds** per question; a submission is **final** and cannot be replaced,
- a team that does not submit is treated as having no correct answer — which is
  **not** the same as a wrong answer, and does not open FORGIVE MEH!,
- grading is **server-authoritative** and runs deterministic layers first
  (normalisation, canonical/variant match, a conservative typo tolerance), then
  an AI semantic judge only for answers still genuinely ambiguous,
- an unavailable, slow, malformed or unsure judge returns **NEEDS_HOST_REVIEW**;
  it never guesses,
- **the Host is the final authority** and may rule any answer correct or
  incorrect, including overturning an automated ruling,
- a stored ruling is **reused, never recomputed** — a reconnect or refresh must
  not re-grade an answer.

### The reveal is last

The correct answer is revealed only after grading, any Host review and any
FORGIVE MEH! retry have all completed. A retrying player must never see the
answer they are about to give.

### Round 1 score and placement

Two totals are kept, and they are **not** the same:

| | What it is | Decides |
|---|---|---|
| **BB** | The question's value, awarded to the main balance | The game's score |
| **Round 1 points** | The same value, counted separately | The Round 1 winner |

The Round 1 winner is the team with the **highest Round 1 points** after all 15
questions — **not** the highest BB. The two usually agree, but BB also moves in
the Market, so they can differ.

### Round 1 sudden-death trivia tiebreaker

If two or more teams tie on the highest Round 1 points, they play a
sudden-death trivia tiebreaker (D-032).

**This is NOT the end-of-game Sudden Death of §21.** That mode needs two
consecutive correct answers, uses the phone buzzer and wins the whole game. This
one only decides who won Round 1.

- only teams still tied for the highest Round 1 points take part,
- the content source supplies additional approved questions,
- every remaining tied team gets the **same** question, with a **30-second**
  answer window,
- the same grading pipeline and the same nominated answerer apply,
- **no BB is awarded or deducted, and no Round 1 points are added** — the
  tiebreaker exists only to eliminate.

Resolution:

- exactly **one** correct → that team wins Round 1,
- **some but not all** correct → the incorrect teams are eliminated; the rest
  continue,
- **all** correct → nothing separates them; play another question,
- **none** correct → nothing separates them; play another question.

Repeat until one team remains.

No Bacchanal card behaviour is defined for the tiebreaker, and none is invented:
cards are simply unavailable there.

## 12. Round 2 — Shake Up Yuhself!

Games:
- Bottle Battle
- Match Makers
- Grabbers
- Bombers

Each is worth **500 BB**.

Software flow:
1. Host runs physical game.
2. Host selects winning team.
3. Server awards configured BB.

Detailed physical rules are not required in the app.

## 13. Round 3 — Structure

Round 3 contains four challenges, played in this order:

1. Think Fast
2. Guess the Logo
3. All Answers Begin With...
4. Sing a Song

### Two separate things are counted

| | What it is | Decides |
|---|---|---|
| **BB** | The locked BB value of a challenge, where it has one | The game's score |
| **Round 3 challenge-win counter** | +1 per challenge won | The Round 3 winner |

These are **not** the same and must not be merged. A challenge's internal score
(logos guessed, prompts answered) is a third, temporary thing that decides only
who won that challenge.

Worked example:

```text
Guess the Logo:  Team A = 5 logos,  Team B = 3 logos
  -> Host confirms Team A as challenge winner
  -> Team A Round 3 counter += 1

The 5 logos are NOT BB, and NOT five Round 3 wins.
```

### BB in Round 3

BB is awarded exactly where the individual challenge rules below say so —
**Think Fast (500 BB)** and **Sing a Song (500 BB)**. Guess the Logo and All
Answers Begin With award no BB; their locked scoring was never defined and
remains undefined.

**Winning Round 3 overall awards no BB.** No locked rule grants one.

### Challenge content comes from the game

For Rounds 1, 3 and 4 the **game supplies the content** — the Think Fast topic,
the logos, the letter and prompts, the Sing a Song scenarios — from its content
source. The Host does not invent challenge content during play.

The Host controls progression and judgment. The game supplies the content.
See `CONTENT_POLICY.md`.

### Host discretion

For Guess the Logo, All Answers Begin With and Sing a Song, each challenge has a
**normal target score**. Reaching it signals the challenge is normally over, but
**the Host confirms the winner**, and may confirm earlier or let play continue.

A challenge is never resolved automatically by a score alone.

### Round 3 winner

After all four challenges, the team with the **highest challenge-win counter**
wins Round 3.

If the highest counter is tied, the tie is broken by **actual
Rock-Paper-Scissors** (§17). This is not a Bacchanal Clash; no card is involved
or spent.

## 14. Think Fast

Locked:
- no buzzer,
- turn-based; teams take turns,
- **turn order comes from the previous round's standings** — the team that won
  the previous round goes first, then the others in placement order,
- Host judges validity,
- no BB per individual answer,
- a team that cannot give another valid answer is out of this challenge,
- play continues until one team remains,
- the last team still able to answer wins **500 BB**,
- the winner also gains **+1 Round 3 challenge-win counter**,
- Steups follows its normal rule (§3).

Cards: Steups!, Double It!, FORGIVE MEH! (§6).

The answer timer remains open — see `OPEN_RULES.md`.

## 15. Guess the Logo

Locked:
- no buzzer,
- the game supplies each logo,
- each logo has a **10-second window**,
- any team may call out,
- Host determines who spoke first and whether correct,
- a wrong answer does not end the window; other teams may keep answering,
- if nobody answers correctly, move to the next logo,
- each correct logo scores **+1 challenge point** to that team (not BB),
- the **normal target is 5** correct logos,
- the Host may move to the next logo immediately once a logo is answered,
- **the Host confirms the challenge winner**, and may do so before or after the
  target is reached,
- the winner gains **+1 Round 3 challenge-win counter**,
- **no BB is awarded** for this challenge.

Cards: Double It! only (§6).

## 16. All Answers Begin With...

Locked:
- the game supplies the required letter and the prompts,
- every valid answer must start with that letter,
- each prompt has a **10-second window**,
- teams answer verbally; the Host judges who was first and whether the answer is
  valid,
- a valid first answer scores **+1 challenge point** (not BB),
- if nobody answers correctly, move to the next prompt,
- the Host may move to the next prompt immediately once one is answered,
- the **normal target is 5**,
- **the Host confirms the challenge winner**, and may do so before or after the
  target is reached,
- the winner gains **+1 Round 3 challenge-win counter**,
- **no BB is awarded** for this challenge.

Cards: Double It!, FORGIVE MEH! (§6).

## 17. Sing a Song

Locked:
- the game supplies the challenge item — a situational prompt (for example, a
  song you would hear at a wedding) or an image suggesting a song,
- each item has a **10-second window**,
- teams respond verbally,
- the first team to sing **a full line of a song** matching the supplied
  criterion scores **+1 challenge point**,
- the Host decides who responded first, whether the line is complete enough, and
  whether it matches — this is subjective Host authority,
- if nobody responds validly, move to the next item,
- the Host may move to the next item immediately once one is answered,
- the **normal target is 3**,
- **the Host confirms the challenge winner**, and may do so before or after the
  target is reached,
- the challenge is worth **500 BB** to the winner,
- the winner also gains **+1 Round 3 challenge-win counter**.

Cards: Double It! only (§6).

No automatic song, audio or music recognition is used. The Host judges.

## 18. Rock-Paper-Scissors Tiebreaker

Used when a round ends with tied leaders on the Round 3 challenge-win counter.
**This is not a Bacchanal Clash** — no Bacchanal card is involved or spent.

Only tied teams take part. Choices are hidden until every tied team has locked
one, then revealed together. Standard rules: Rock beats Scissors, Scissors beats
Paper, Paper beats Rock.

**Two teams**
- different choices → the winner takes the tiebreaker,
- same choice → replay.

**Three teams**
- all three the same → replay,
- all three different → replay,
- two the same and one different → compare the two choices:
  - if the single choice beats the pair, that team wins the tiebreaker,
  - if the pair beats the single, the single team is eliminated and the
    remaining two continue.

Repeat until one team remains.

## 19. Family Feud

Family Feud is the **first main game section using the phone buzzer**. It
follows authentic Family Feud-style mechanics as closely as practical, with the
Brains & Bacchanal card system, BB, question allocation, the 3-team matchup
structure and the custom steal wager layered on top. See D-033.

### Face-off

- the Host begins reading the survey question aloud,
- **the digital buzzer opens while the Host is reading** — there is no separate
  countdown before buzzing is allowed,
- the first valid buzz locks out the opposing face-off player and the Host
  stops reading,
- the buzzer winner has **3 seconds** to give an answer,
- if that answer is the **#1 board answer**, that team wins the face-off
  immediately,
- otherwise, the opposing face-off player gets **one opportunity** to give a
  higher-ranked board answer,
- whichever valid answer ranks higher wins the face-off,
- the face-off winner chooses **PLAY** or **PASS**.

### Normal board play

- players answer in team order; **one player answers per turn**,
- **no team conferring** during normal board play,
- each turn has a **5-second** answer timer,
- a valid, unrevealed board answer is revealed and scores its board value,
- a wrong answer, a duplicate answer, an off-board answer, or failing to answer
  in time is **one strike**,
- after **3 strikes**, the opposing team gets one steal opportunity.

### Steal

- the stealing team gets **30 seconds** to confer and give **one** final
  answer,
- before answering, the stealing team may wager up to **50% of its current BB**
  — the existing custom steal wager, unchanged,
- correct steal → the stealing team wins the accumulated survey-board points
  **and** the wager amount, per the existing wager mechanic,
- wrong steal → the stealing team loses its wager, and the original controlling
  team receives the accumulated survey-board points,
- BB never goes below 0.

### Cards in Family Feud

Brains & Bacchanal cards remain layered on top of Family Feud play. The
existing one-card-per-team-per-question restriction and Clash behavior (§2, §5)
still apply.

**Steups!**
- may be used after an opposing team gives a valid board answer,
- that answer is removed for the defending team: it does not score, and the
  defending team cannot reuse it during that survey,
- the team that played Steups! may later use the removed answer if they gain a
  legal opportunity to give it,
- this is the general Steups! effect (§3), applied to a Family Feud board.

**FORGIVE MEH!**
- may be used after a wrong board-play answer,
- gives that player one final retry, **before** the strike is applied,
- a correct retry means **no strike**,
- a wrong retry means **one strike** — never two for the same turn,
- the shared retry restrictions (§4) still apply.

**Inactive third team, in a 3-team Round 4 matchup**
- the team not currently participating in a matchup **cannot** play Bacchanal
  cards into it,
- its cards remain untouched and become playable again once it is an active
  participant.

### Multipliers

Questions 4 and 5 are already doubled. No other multiplier is defined.

## 20. Three-Team Round 4

This structure is preserved exactly as locked; §19 layers the face-off, board
play, steal and card rules on top of each matchup it describes below.

1. Rank teams by BB entering Round 4.
2. 2nd and 3rd play first.
3. They play the first two Family Feud questions.
4. Loser stays in overall game.
5. Loser keeps BB already earned.
6. Loser cannot earn further Family Feud BB for remainder of Round 4.
7. Winner advances to face entering 1st-place team.
8. They play remaining Family Feud questions.
9. Tie after the two-question matchup → entering 2nd-place team advances.
10. No extra wager after Family Feud.
11. Normal steal wager remains.

## 21. Winner & Sudden Death

Highest BB after Round 4 wins.

If tied leaders remain, they enter Sudden Death. D-034 replaces the format
below (a face-off sequence) for what this section originally locked
(individual questions, first to two consecutive correct answers) — a
deliberate rule REPLACEMENT, not an addition.

Sudden Death is a sequence of **face-offs** — the same face-off mechanic as
§19 (the buzzer opens while the Host reads, the first valid buzz locks out the
other side, that team has a timed answer window):

- a team wins a face-off by giving the #1 board answer,
- a **wrong answer, or failing to answer after buzzing (a timeout), loses that
  face-off outright** — there is no opponent's-chance fallback inside Sudden
  Death,
- if **neither** team gives a valid answer in a face-off, nothing is decided
  and the game continues to another face-off with a fresh question,
- the **first team to win two face-offs in a row** (consecutive — a loss
  resets the streak to zero) wins Sudden Death, and the game.

No:
- Market,
- Maco Mail,
- Bacchanal Cards,
- advantages,
- wagers,
- multipliers.

The exact answer-window duration for a Sudden Death face-off is still not
locked — see `OPEN_RULES.md` §11.

## 22. Disconnect

If an active player disconnects:
- gameplay pauses automatically,
- active gameplay timers pause,
- reconnect does not auto-resume,
- only Host can resume,
- Host may resume with or without reconnection,
- reconnecting player should return to same team/game/session where possible.
