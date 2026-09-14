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

### Double It!
Double the BB reward on one eligible question/challenge.

- activate before result,
- multipliers never stack,
- already doubled challenges cannot be doubled again.

### Maco!
Look at another team's answer while that team is actively answering in a compatible challenge.

Viewing time: 10 seconds.

**Current challenge compatibility is unresolved. See `OPEN_RULES.md`.**

### Doh Know
Pass your assigned question to another team.

- if they answer correctly, they receive normal BB,
- if they answer incorrectly, your team receives double normal BB,
- no stacking.

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
- opponents get a **3-second hidden response window**,
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
| Round 1 Trivia | Gimme Dat!, Double It!, Doh Know, ALLYUH HELP ME!, FORGIVE MEH! |
| Round 2 Physical Games | Double It! only |
| Think Fast | Steups!, Double It!, FORGIVE MEH! |
| Guess the Logo | Double It! only |
| All Answers Begin With... | Double It!, FORGIVE MEH! |
| Sing a Song | Double It! only |
| Family Feud Q1–Q3 | Steups!, Double It!, FORGIVE MEH! |
| Family Feud Q4–Q5 | Steups!, FORGIVE MEH! |
| Sudden Death | no Bacchanal Cards |

Q4/Q5 are already doubled, so Double It cannot be used.

Maco! appears nowhere in this approved table. That is intentionally left open.

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

Locked:
- trivia round,
- Easy = 100 BB,
- Medium = 200 BB,
- Hard = 300 BB,
- each team nominates one player for Easy, one for Medium, one for Hard,
- teams take turns,
- teams answer different questions,
- no buzzer.

Question-count/allocation is still open.

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

## 13. Think Fast

Locked:
- no buzzer,
- teams take turns,
- two-team game uses rock-paper-scissors to choose first and second,
- teams alternate answers,
- Host judges validity,
- no BB per individual answer,
- continue until a team cannot give another valid answer,
- team that gave the last valid answer wins 500 BB,
- Steups follows its normal rule.

Exact answer timer and three-team starting order remain open.

## 14. Guess the Logo

Locked:
- no buzzer,
- each logo has a 10-second window,
- any team may call out,
- Host determines who spoke first and whether correct,
- if first shouted answer is wrong, other teams may continue answering during the same window,
- if nobody gets it correct, move to next logo.

Overall scoring across multiple logos remains open.

## 15. All Answers Begin With...

Locked concept:
- one required letter,
- prompts change,
- every valid answer starts with the required letter.

Final competition format, scoring, tie handling and win condition are open.

## 16. Sing a Song

Locked:
- based on a picture/artiste, word or scenario,
- Host judges/selects winner,
- challenge value is 500 BB.

Exact timing remains open.

## 17. Family Feud

Family Feud is the **first main game section using the phone buzzer**.

Existing concepts:
- face-off,
- board answers,
- control,
- strikes,
- steal,
- steal wager.

Steal wager:
- after three strikes, opposing team may steal,
- stealing team may wager up to 50% of current BB before answering,
- correct steal → board BB + wager winnings,
- wrong steal → lose wager and original team gets board BB,
- BB floor is 0.

Questions 4 and 5 are already doubled.

## 18. Three-Team Round 4

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

## 19. Winner & Sudden Death

Highest BB after Round 4 wins.

If tied leaders remain:
- tied leaders enter Sudden Death,
- first team to achieve **two consecutive correct answers** wins,
- wrong answer after buzzing = immediate loss,
- buzz then fail to answer in time = immediate loss,
- no buzz before buzzer window closes = no penalty; next question.

No:
- Market,
- Maco Mail,
- Bacchanal Cards,
- advantages,
- wagers,
- multipliers.

## 20. Disconnect

If an active player disconnects:
- gameplay pauses automatically,
- active gameplay timers pause,
- reconnect does not auto-resume,
- only Host can resume,
- Host may resume with or without reconnection,
- reconnecting player should return to same team/game/session where possible.
