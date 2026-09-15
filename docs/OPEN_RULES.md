# Brains & Bacchanal — Open Rules

Claude Code must **not** invent answers to these.

## 1. Round 1 Question Count / Allocation

Locked:
- teams take turns,
- teams receive different questions,
- no buzzer,
- Easy / Medium / Hard values are locked.

Still unclear:
- Does "5 Easy, 5 Medium, 5 Hard" mean 15 questions total across the round, 15 per team, or another allocation?
- When a team gets its own question wrong, does play simply move to the next team's separate question?

Do not hard-code final allocation.

## 2. Think Fast — Exact Timer

An 8-second timer was discussed as a suggestion.

It is not explicitly locked.

## 3. Think Fast — Three-Team Starting Order

For two teams, rock-paper-scissors determines first/second.

For three teams, first/second/third selection is not finalized.

## 4. Guess the Logo — Scoring

Locked:
- 10 seconds per logo,
- teams shout,
- Host judges first/correct,
- wrong first shout does not stop other teams,
- no correct answer → next logo.

Still open:
- number of logos,
- BB per logo versus 500 BB for whole challenge,
- how overall winner is determined,
- whether a team that shouted wrong may try again on the same logo.

## 5. All Answers Begin With...

Still open:
- number of prompts,
- turn order,
- answer timer,
- scoring,
- tie handling,
- overall winner condition.

Keep it configurable.

## 6. Sing a Song — Timing

Host judging and 500 BB winner are locked.

15 seconds to start and 20 seconds performance were only suggestions.

## 7. Maco! Card Compatibility

Maco! is still a defined Disruption card, but the approved compatibility table gives it no legal challenge.

Before Bacchanal dealing/eligibility is finalized, the project owner must decide:
- where Maco! can be used,
- or whether it leaves the starting pool,
- or whether it is replaced/reworked.

Claude must not decide.

**Owner instruction (Phase 4): leave it out for now. If it is never resolved, it does not go in the deck.**

This DEFERS the question; it does not answer it. When card dealing is built
(Phase 6), Maco! is simply absent from the starting pool — no eligibility rule
is invented for it, and it is not quietly given a legal challenge. The rule stays
open here in case the owner later wants to rework it.

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
