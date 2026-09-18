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

## 8. Family Feud — Steups Board Behavior — ✅ RESOLVED

**Resolved by the project owner.** Steups! removes an opponent's valid board
answer: it does not score for the defending team, and that team cannot reuse it
during the survey. The team that played Steups! may later use the removed
answer if they gain a legal opportunity to give it.

See `GAME_RULES_LOCKED.md` §19 and `DECISION_LOG.md` D-033.

## 9. Family Feud — FORGIVE MEH! and Strikes — ✅ RESOLVED

**Resolved by the project owner: the retry happens before the strike.** A wrong
board-play answer gives that player one final retry before any strike is
applied. Correct retry → no strike. Wrong retry → one strike, never two for the
same turn.

See `GAME_RULES_LOCKED.md` §19 and `DECISION_LOG.md` D-033.

## 10. Three-Team Family Feud — Inactive Team Card Use — ✅ RESOLVED

**Resolved by the project owner: confirmed.** Only the two teams currently
playing a Family Feud matchup may play Bacchanal cards into it. The inactive
third team's cards remain untouched and become playable again once it becomes
an active participant.

See `GAME_RULES_LOCKED.md` §19 and `DECISION_LOG.md` D-033.

## 11. Sudden Death Timers

Round 4's own timers are now locked (`GAME_RULES_LOCKED.md` §19, D-033):
face-off buzz-in has no separate countdown, the face-off answer window is 3
seconds, a normal board turn is 5 seconds, and a steal is 30 seconds.

**Still open:** the exact default timers for §21's end-of-game Sudden Death mode
are not yet locked. Keep them configuration-driven.

D-034 locked the FORMAT (a face-off sequence, first to two wins in a row) —
only the answer-window DURATION for a Sudden Death face-off remains open here.

## 12. Partner, I Sorry — Insufficient BB

Rule says give 500 BB to an opposing team.

Still unclear if payer has less than 500:
- recipient gets only what can actually be transferred,
- or recipient gets full 500 while payer floors at 0,
- or another rule.

Do not invent.

## 13. Round 1 — FORGIVE MEH! Retry Window — ✅ RESOLVED

**Resolved by the project owner: a fresh 10-second window.** It starts when the
Host opens the retry, not when the question closed, so a team that spent 58
seconds on its first answer still gets the full 10.

Round 1 is now **fully locked**. See `GAME_RULES_LOCKED.md` §11 and
`DECISION_LOG.md` D-032.

## 14. Round 1 Sudden-Death Tiebreaker — Card Compatibility

The tiebreaker itself is locked (`GAME_RULES_LOCKED.md` §11, D-032): 30 seconds,
same question to every still-tied team, no BB and no Round 1 points.

**Still open, and deliberately:** whether any Bacchanal card may be played
during it. No locked source addresses tiebreaker cards, so rather than invent a
rule, cards are **unavailable** there and the question is recorded here.

This is not urgent — it only matters if a Round 1 tie actually happens and a
team wants to play a card into the tiebreak.

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
