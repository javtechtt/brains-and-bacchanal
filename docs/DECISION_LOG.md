# Brains & Bacchanal — Decision Log

These decisions supersede older conflicting documents.

## D-001 — No Digital Buzzers Before Family Feud
Rounds 1–3 do not use the phone as a digital buzzer.

Family Feud is the first main buzzer section.

Sudden Death may also use a buzzer.

## D-002 — Round 1 Uses Different Questions — ⚠ SUPERSEDED BY D-030
~~Teams take turns answering different questions.~~

**No longer true.** D-030 resolved Round 1: every team answers the **same**
question simultaneously, 15 questions total, 60 seconds each. The turn-based,
different-questions format is gone, and with it the legality of Gimme Dat! and
Doh Know in Round 1.

What survives from this entry: **no buzzer** (still true, and still D-001).

## D-003 — Round 2 Physical Rules Stay Outside the App
Host runs Bottle Battle, Match Makers, Grabbers and Bombers physically.

Software only needs Host winner selection and configured 500 BB award.

## D-004 — Think Fast Is Turn-Based — ⚠ AMENDED BY D-031
- no buzzer,
- teams alternate,
- ~~two-team order via rock-paper-scissors~~ → **order comes from the previous
  round's standings** (D-031),
- Host validates,
- no BB per answer,
- last team able to provide valid answer wins 500 BB (**unchanged**), and now
  also gains +1 Round 3 challenge-win counter.

## D-005 — Guess the Logo Is Spoken
- 10-second window per logo,
- any team may shout,
- Host decides who spoke first,
- wrong first answer does not stop other teams,
- no correct answer → next logo.

Overall scoring remains open.

## D-006 — One Retry Maximum
Second Chance and FORGIVE MEH! cannot be chained.

Maximum one retry on a question.

## D-007 — Bacchanal Compatibility Table Approved
Use the table in `GAME_RULES_LOCKED.md`.

~~Maco! currently has no legal challenge and remains unresolved.~~ **Resolved by
D-030: Maco! is legal in Round 1 trivia, and only there.** The Round 1 row also
loses Gimme Dat! and Doh Know, which need an individually assigned question that
Round 1 no longer has.

## D-008 — Three-Team Round 4
- 2nd vs 3rd first,
- first two Family Feud questions,
- loser remains in game but cannot earn more Family Feud BB,
- winner faces entering 1st place,
- remaining questions are played,
- tie after first two → entering 2nd advances,
- no new final wager.

## D-009 — Host Deal Frequency
Maximum one Host Deal per round.

## D-010 — Maco Mail Initial Deck
Use the 20-card playtest mix in `GAME_RULES_LOCKED.md`.

Config-driven.

## D-011 — Disconnect Auto-Pauses
- active player disconnect → automatic pause,
- timers pause,
- only Host resumes,
- reconnect does not auto-resume,
- Host may resume without waiting.

## D-012 — Family Feud Survey
The existing custom survey has 47 responses and is acceptable for its custom boards.

Additional boards may use approved external datasets.

Store board source metadata.

## D-013 — All Answers Begin With Can Be Finalized Later
Development may proceed without its final scoring/win condition.

Its template must remain configurable.

## D-014 — Realtime Transport: Raw WebSockets
Phase 3's measured comparison is complete. The project uses **raw WebSockets**
(`ws` on the server, `ClientWebSocket` in Unity, the browser WebSocket API on
phones), not Socket.IO.

Decided on evidence, not preference:
- loopback, real phones on LAN, and a real public-internet path with TLS and a
  reverse proxy all show the two transports behaving correctly and performing
  comparably (identical 98 ms median RTT over the internet; raw WebSockets
  showed tighter tails and less jitter),
- raw WebSockets connected cleanly through a real TLS proxy, so Socket.IO's
  HTTP long-polling fallback — the one thing that could have decided it the
  other way — was never needed,
- **Unity settled it.** The Host Display is Unity (ARCHITECTURE.md §1).
  `ClientWebSocket` ships with .NET and passed 29/29 checks plus an IL2CPP
  standalone build with zero dependencies. Socket.IO has no official C# client;
  it would require an unofficial community package with IL2CPP/AOT stripping
  risk in the component that must not fail during a live game.

Accepted costs: the raw adapter hand-rolls request/response correlation in every
client, and Socket.IO's fallback/reconnection remain genuinely better on hostile
networks that testing never encountered.

This does not remove the `RealtimeTransport` adapter. Transport-specific code
stays behind it, so the decision is reversible if raw WebSockets later fail on
mobile data, a captive portal, a specific hosting ingress, or if the Host ever
needs WebGL (where `ClientWebSocket` does not work).

Full evidence: `docs/NETWORK_BENCHMARK.md`, `docs/UNITY_HOST.md`.

## D-015 — Stale Connections: Newest Authenticated Connection Wins
When a player proves identity on a new connection while an older one is still
open, the **new** connection becomes authoritative immediately. The old one is
sent `CONNECTION_SUPERSEDED`, closed by the server, and stripped of its role so
it can no longer act.

Chosen over waiting for the old socket to time out, because the common case is a
phone waking from sleep: the player is holding the device that just
authenticated, and the old socket is a locked screen or a forgotten tab. Waiting
would leave the player unable to act for as long as the timeout.

A late `close` from a displaced socket is ignored, so it cannot mark a present
player as away.

This is engineering, not a game rule. See `docs/LOBBY.md`.

## D-016 — Leave and Removal Destroy Membership; Disconnect Preserves It
`LEAVE_ROOM` and `HOST_REMOVE_PLAYER` delete the player record, which
invalidates the reconnect credential *by construction* — there is nothing left
to authenticate against. A dropped socket does the opposite: membership, team
and credential all survive.

Prevents the two failure modes that matter: someone who left reappearing on a
team, and someone whose phone died losing their place.

## D-017 — Team-Mode Change 3 → 2 Is Refused, Never Silently Resolved
If Team C holds players, switching to two-team mode is **rejected**, naming how
many players are in the way. The Host moves them deliberately first.

Silent reassignment is the kind of thing nobody notices until the game has
started and someone is on the wrong team.

## D-018 — Team Lock Requires Non-Empty Teams, Not Equal Ones
Locking is refused if any participating team has zero players.

**Team sizes are deliberately not checked.** No locked rule requires balance, so
requiring it would be inventing a rule. Uneven teams lock successfully.

`HOST_UNLOCK_TEAMS` exists so a misclick is recoverable; `TEAM_LOCK → LOBBY` was
already a legal phase transition for exactly this reason.

## D-019 — Room Codes Avoid Confusable Characters
Four characters from `ABCDEFGHJKMNPQRTWXY346789` (390,625 combinations), unique
among **active** rooms so codes recycle when rooms close.

`O/0`, `I/1/L`, `S/5`, `U/V` and `Z/2` are excluded, and input folds confusables
onto the intended character. This targets the failure that actually costs time at
a party: someone typing the code wrong three times while everyone waits.

## D-020 — QR Mask 2 Excluded from the Hand-Written Encoder
`QrCode.cs` never selects mask 2, a deliberate deviation from ISO/IEC 18004's
"lowest penalty wins".

Mask 2 (`x % 3 == 0`) produces solid vertical stripes. Those codes are valid and
this encoder builds them correctly, but OpenCV's detector failed to decode **13
of 200** of them. Confirmed as a decoder-population problem rather than an
encoding fault by forcing an independent reference encoder to mask 2 and watching
it fail identically.

Mask choice is a robustness heuristic, not a correctness requirement, and the
other seven masks always include a good one. Verified by decoding, not
inspection: `tools/qr-verify/` decodes **307/307**.

## D-021 — "Active Player" Means Required by the Current Challenge
D-011 pauses gameplay when an **active** player disconnects. Phase 5 had to say
operationally who that is, without inventing a game rule.

**An active player is one whose participation the current challenge requires.**
It is set deliberately by the engine (`HOST_SET_ACTIVE_PLAYERS`), never inferred
from who happens to be connected.

Chosen over "everyone in the room", which was the only other reading available
without deciding round rules. At a party most of the room is watching at any
moment; pausing every time a spectator's phone sleeps would stop the game
constantly, and the Host would learn to ignore the pause — which would defeat
D-011 precisely when it mattered.

This is engineering, not a game rule. Later rounds decide who is active by
nominating an answerer, passing control, or opening a challenge to a team.
See `docs/GAME_ENGINE.md`.

## D-022 — Timer Expiry Decides Nothing
When a server-owned deadline runs out, the engine emits `TIMER_EXPIRED`, moves
the challenge to `HOST_REVIEW`, and **stops**.

It does **not** mean a wrong answer, a lost turn, a forfeited question or any
BB change. No locked rule says a timeout means any of those, and different
challenges will almost certainly differ — Family Feud's clock and Guess the
Logo's 10-second window are not the same kind of deadline.

The event payload says `requiresHostDecision: true` on the wire, so no client
invents a consequence either.

Phases 6–7 give expiry a meaning per challenge, once those rules are decided.

## D-023 — One Event Sequence for Lobby and Gameplay
The `GameEngine` shares the room's `EventLog` rather than keeping its own.

A client must be able to order "Team A reached 1,500 BB" against "Javal
disconnected". Two independent counters cannot express that, and a gap in either
would stop reliably meaning "you missed a state change" — which is the whole
value of the sequence number.

Cost: the engine holds a reference to the room's log, so they are not entirely
independent objects. Accepted, because the alternative is clients merging two
streams with no defined interleaving.

## D-024 — Development BB Controls Are Gated by the Server, Not the Client
`DEV_ADJUST_BB` exists so the ledger and its floor can be exercised before any
round awards BB (Phase 5 spec §17).

It is refused **by the server** unless started with development tools enabled —
default on in development, **off** in production. Hiding the button in a client
would not have been enough: the intent travels over an open socket, and a room
is deliberately not gated by a shared secret (see `docs/LOBBY.md`).

Every entry it writes is stamped `dev_adjustment` in the ledger, so a test award
can never be mistaken for earned BB when reading a game's history.

## D-025 — Two Separate Bans Enforce "One Card Per Challenge"
`GAME_RULES_LOCKED.md` §5 returns a losing card to its owner's hand **and** bars
that team from playing again in the same challenge. Phase 6 stores those as two
facts: a team-level `teamsWhoPlayed` set and a card-level
`barredCardInstanceIds` set.

Deriving either from the other gets Part Dat Fight wrong. There, every card
returns to hand *and* every participating team is finished — so "does this team
hold a playable card?" and "may this team play?" have different answers, and one
set cannot express both.

Phase 6 spec §8 asks for exactly this: "Represent this explicitly rather than
inferring from card inventory."

## D-026 — Market Affordability Is Checked Before the Ledger, Not By It
BB floors at zero centrally (`BbLedger`), and a team must not buy what it cannot
afford. **These are not the same rule.**

Relying on the floor to deliver affordability would sell a 500 BB item to a team
holding 300, leaving them at 0 — the deduction clamps, the purchase succeeds, and
the team gets the item for 300. So `Market.purchase` compares the balance against
the actual price (surcharge included) and refuses **before** touching the ledger.

This is engineering, not a game rule; it is the correct reading of §10 plus §1.

## D-027 — A Blocked Open Rule Is Not a Dud
Maco Mail's dud (`GAME_RULES_LOCKED.md` §7) is a **locked outcome with
consequences**: the draw is spent, no redraw, no refund.

Partner, I Sorry with a payer under 500 BB is something else entirely — an
**absence of a rule** (`OPEN_RULES.md` §12). Calling it a dud would quietly
decide that open rule by giving it a locked consequence.

So `MacoDrawResult` carries a distinct `blocked_open_rule` value. No BB moves on
either side, the Host is told why, and the tests assert the block while asserting
nothing about what should happen instead.

When the owner resolves §12, this value's only use disappears.

## D-028 — Advantage Expiry Is Decided by Source, Not by the Caller
Market items "expire after the immediately following round" (§10). Maco Mail held
advantages "stay out until used or game ends" (§7). Two locked rules, two
lifetimes, one `HeldAdvantageView`.

`Advantages.grant` therefore sets `expiresAfterRound` **from the source**, and
ignores any value passed for a Maco Mail advantage. A caller passing the wrong
thing cannot delete a Maco advantage early, and a Market item cannot be made
immortal.

Sharing one type is what lets "maximum one clue" (§10) be checked over a single
list regardless of where each clue came from.

## D-029 — Bacchanal Clash Window Raised from 3 to 6 Seconds
GAME_RULES_LOCKED.md §5 locked the Clash's hidden response window at 3 seconds.
Physical two-phone testing (Phase 6) showed 3 seconds too short in practice —
by the time a player noticed a Clash had opened at all, there was often no time
left to choose and confirm a counter.

The project owner raised it to **6 seconds**. `CLASH_RESPONSE_WINDOW_MS` is the
one place the duration is defined; §5 is updated to match, and it is otherwise
unchanged — hidden until reveal, targets locked before reveal, one response per
team.

This is a genuine rule change, not a bug fix — recorded here rather than
silently edited into the locked doc, per the same discipline every other locked
rule gets.

## D-030 — Round 1 Format, Scoring and Card Compatibility Resolved
The project owner resolved Round 1, closing `OPEN_RULES.md` §1 and §7.

**Format.** 15 questions total — 5 Easy, 5 Medium, 5 Hard. **Every team answers
the same question simultaneously**, 60 seconds each, still no buzzer. Each team
nominates one player per difficulty, and only that nominated player submits.
The correct answer is revealed after the question/retry flow completes.

This **supersedes** the previous locked wording ("teams take turns", "teams
answer different questions") and D-002. It is a genuine rule change, recorded
here rather than silently edited into the locked doc — the same discipline
D-029 got.

**Scoring changed.** Easy 100 → **20**, Medium 200 → **30**, Hard 300 → **50**.
A wrong answer scores 0 with no deduction. The value is awarded as BB *and*
counted again as a separate Round 1 point total that decides the Round 1 winner.
Two totals, one correct answer — not two BB transactions.

**Maco! is now legal, in Round 1 only.** This closes the deferral standing since
Phase 4. The simultaneous-answer format is what makes the card meaningful: there
is a submitted opponent answer to look at. The target must already have
submitted, a half-typed answer is never exposed, and viewing neither copies nor
submits.

**Gimme Dat! and Doh Know are no longer legal in Round 1.** Both operate on an
individually assigned question, and Round 1 no longer assigns one. Removing them
follows from the format change rather than being a separate decision.

Round 1's compatibility row therefore becomes: Maco!, Double It!, ALLYUH HELP
ME!, FORGIVE MEH!

**Double It! doubles both totals** on a correct answer — 20→40, 30→60, 50→100.
Wrong remains 0, and multipliers still never stack.

**ALLYUH HELP ME!** relies on the assisting team's submitted answer; if correct,
both teams receive the question's normal BB and Round 1 score.

Still open, narrowly: the FORGIVE MEH! retry-window duration
(`OPEN_RULES.md` §13).

**Nothing is implemented.** This is documentation only; Round 1 remains
unbuilt, and `CARD_ELIGIBILITY` still has no MACO entry. The Phase 6 test
asserting Maco is unplayable will fail when that entry is added — by design,
as the signal to update it.

## D-031 — Round 3 Resolved; Think Fast Order Comes from Standings
The project owner resolved Round 3, closing `OPEN_RULES.md` §3, §4, §5 and §6.

### Round 3 keeps its BB, and adds a counter

Two things are now counted, and they are **not** the same:

- **BB**, exactly where the locked rules already put it — Think Fast 500 BB
  (§14) and Sing a Song 500 BB (§17). Guess the Logo and All Answers Begin With
  award none, as before.
- **A Round 3 challenge-win counter**, +1 per challenge won, which decides the
  **Round 3 winner**.

Winning Round 3 overall awards **no BB**. No locked rule grants one, so none is
invented.

A challenge's internal score (logos guessed, prompts answered) is a third,
temporary thing that decides only who won that challenge. Five logos is one
Round 3 win, not five, and not BB.

### Host discretion over the challenge end

Guess the Logo and All Answers Begin With have a normal target of **5**; Sing a
Song **3**. Reaching the target signals the challenge is normally over, but the
**Host confirms the winner** and may confirm earlier or let play continue.

A challenge is never resolved by a score alone. This is deliberate: these are
spoken, Host-judged challenges at a party, and the Host is already the authority
on who answered first and whether an answer counts.

### Think Fast order — supersedes the locked rule

`GAME_RULES_LOCKED.md` §13 previously locked *"two-team game uses
rock-paper-scissors to choose first and second."* **That is replaced.**

Turn order now comes from the **previous round's standings**: the team that won
the previous round goes first, then the others in placement order. Two and three
teams alike, which also closes the three-team question §3 left open.

**Winning a round means having the most total BB when it ends.** Round 2 records
per-challenge winners but no placement, and rather than add one, the owner chose
the measure the game already has. BB is the score (§1), so the leader on BB is
the leader.

Accepted consequence, recorded so it is not mistaken for a bug: total BB
includes Market spending and Maco Mail outcomes, so a team can lead entering
Round 3 without having won a physical challenge. That is a real outcome of BB
being both currency and score, not an ordering fault.

Rock-paper-scissors is **no longer** used for Think Fast order. It survives only
as the Round 3 overall tiebreaker (§18), where it is an actual game of
rock-paper-scissors and **not** a Bacchanal Clash — no card is involved or spent.

### Double It is unchanged

It doubles a challenge's BB reward, one per challenge, exactly as §3 has always
said. An earlier proposal to defer it to a round-end bonus was dropped along
with the Round 2 redesign it belonged to; Round 2 stays as shipped, and Round 3
keeps its BB, so the card needs no new semantics.

Where a Round 3 challenge awards no BB (Guess the Logo, All Answers Begin With),
Double It has nothing to double. It remains legal there per the approved table,
and doubling simply has no effect — it is **not** given a counter meaning, since
no rule defines one.

### Content comes from the game, not the Host

For Rounds 1, 3 and 4 the game supplies challenge content — the Think Fast
topic, the logos, the letter and prompts, the Sing a Song items — from its
content source. The Host controls progression and judgment; the Host does not
invent challenge content during play. See `CONTENT_POLICY.md`.

### Still open

- the Think Fast answer timer, and what a timeout means (`OPEN_RULES.md` §2),
- Round 2 is **unchanged**: 500 BB per challenge, no counter, no round bonus.

**Nothing is implemented.** Round 3 is not built; this is the locked-rule
reconciliation that precedes building it.
