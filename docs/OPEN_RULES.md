# Brains & Bacchanal — Open Rules

Claude Code must **not** invent answers to these.

## 1. Round 1 Question Count / Allocation — ✅ RESOLVED

**Resolved by the project owner.** 15 questions total (5 Easy, 5 Medium, 5
Hard), all teams answering the **same** question simultaneously, 60 seconds
each. Values changed to Easy 20, Medium 30, Hard 50, awarded as BB and counted
again as separate Round 1 points.

The old "teams take turns / teams receive different questions" wording is gone;
see `GAME_RULES_LOCKED.md` §11 and `DECISION_LOG.md` D-030.

**Still open, and narrowly:** the FORGIVE MEH! retry-window duration in Round 1
(§13 below).

## 2. Think Fast — Exact Timer

Still open. An 8-second timer was discussed early; 10 seconds has since been
suggested to match the other three Round 3 challenges.

**Neither is locked**, so nothing implements one. The timer stays
caller-supplied from configuration, as every undecided duration does.

Also undecided: what a **timeout means**. No locked rule says running out of
time is the same as failing to answer, and D-022 is explicit that expiry decides
nothing on its own. Until that is settled, a Think Fast timeout hands the
challenge to the Host rather than eliminating anyone automatically.

## 3. Think Fast — Starting Order — ✅ RESOLVED

**Resolved by the project owner: turn order comes from the previous round's
standings.** The team that won the previous round goes first, then the others in
placement order. This applies to two and three teams alike.

Rock-paper-scissors is **no longer** used to choose Think Fast order — it is now
only the Round 3 overall tiebreaker (`GAME_RULES_LOCKED.md` §18).

See `GAME_RULES_LOCKED.md` §14 and `DECISION_LOG.md` D-031.

## 4. Guess the Logo — Scoring — ✅ RESOLVED

**Resolved by the project owner.** Each correct logo scores **+1 challenge
point**, the normal target is **5**, and the **Host confirms the challenge
winner** — before or after the target. The winner gains +1 Round 3 challenge-win
counter and **no BB**.

A team that shouted wrong may keep answering within the same 10-second window;
that was already locked. The number of logos is not fixed — the challenge runs
until the Host confirms a winner.

See `GAME_RULES_LOCKED.md` §15 and `DECISION_LOG.md` D-031.

## 5. All Answers Begin With... — ✅ RESOLVED

**Resolved by the project owner.** The game supplies the letter and the prompts.
Each prompt has a **10-second window**; a valid first answer scores **+1
challenge point**; the normal target is **5**; the **Host confirms the challenge
winner** before or after it. The winner gains +1 Round 3 challenge-win counter
and **no BB**.

The number of prompts is not fixed — play continues until the Host confirms.
There is no turn order: any team may answer, and the Host judges who was first.

See `GAME_RULES_LOCKED.md` §16 and `DECISION_LOG.md` D-031.

## 6. Sing a Song — Timing — ✅ RESOLVED

**Resolved by the project owner.** Each supplied item has a **10-second
window**. The first team to sing a full matching line scores **+1 challenge
point**; the normal target is **3**; the **Host confirms the challenge winner**
before or after it.

The challenge keeps its locked **500 BB** for the winner, who also gains +1
Round 3 challenge-win counter.

The earlier "15 seconds to start, 20 seconds performance" suggestions are
dropped.

See `GAME_RULES_LOCKED.md` §17 and `DECISION_LOG.md` D-031.

## 7. Maco! Card Compatibility — ✅ RESOLVED

**Resolved by the project owner: Maco! is legal in Round 1 trivia, and only
there.**

Round 1's new simultaneous-answer format is what gives the card a meaning —
there is a submitted opponent answer to look at. The target must already have
submitted, a half-typed answer is never exposed, and viewing does not copy or
submit it.

This closes the deferral that had stood since Phase 4. See
`GAME_RULES_LOCKED.md` §3, §6 and §11, and `DECISION_LOG.md` D-030.

**Implementation note.** Phase 6 built `CARDS_WITHOUT_LEGAL_CHALLENGE` as a
DERIVED list precisely so this moment would need no hunting: adding MACO to
`CARD_ELIGIBILITY.ROUND1_TRIVIA` empties it automatically. A Phase 6 test
asserts Maco is unplayable and **will fail** when that entry is added — that
failure is the signal to update the test, not a regression.

Nothing is implemented yet; Round 1 is not built.

## 8. Family Feud — Steups Board Behavior

Steups is approved for Family Feud, but exact board behavior is not fully defined.

Need to decide:
- does the Steups'd valid answer remain unrevealed?
- does its BB stay off the board?
- can the Steups team later use that answer?
- what if the answer was already visually revealed?

## 9. Family Feud — FORGIVE MEH! and Strikes

Need to decide whether the first wrong answer:
- waits until the retry is complete before a strike is applied,
- or creates a strike immediately and the retry happens afterward.

## 10. Three-Team Family Feud — Inactive Team Card Use

Need to confirm:
- only the two teams currently playing a Family Feud question may use cards,
- inactive/sitting-out teams cannot use cards.

Do not assume until confirmed.

## 11. Round 4 / Sudden Death Timers

Exact default timers are not yet locked.

Keep timers configuration-driven.

## 12. Partner, I Sorry — Insufficient BB

Rule says give 500 BB to an opposing team.

Still unclear if payer has less than 500:
- recipient gets only what can actually be transferred,
- or recipient gets full 500 while payer floors at 0,
- or another rule.

Do not invent.

## 13. Round 1 — FORGIVE MEH! Retry Window

Round 1 is otherwise fully locked (`GAME_RULES_LOCKED.md` §11): 60 seconds per
question, retry available after a wrong first answer, one retry maximum shared
with the Market's Second Chance, and the correct answer revealed only after the
retry flow completes.

**Still open:** how long the nominated player gets for that retry.

- the remainder of the original 60 seconds?
- a fresh, shorter window?
- and if a fresh window, how long?

Do not invent one. Keep it configuration-driven.

## Development Guidance

These open rules do not block:
- repo foundation,
- generic room/session system,
- protocol,
- event log,
- timer infrastructure,
- content separation,
- generic round/challenge framework.

They only block finalizing the affected gameplay behavior.
