# Round 1 — "Nah, That Too Easy!"

Phase 7C. Implementation reference, not a rule source. The rules live in
`GAME_RULES_LOCKED.md` §11 and `DECISION_LOG.md` D-030 and D-032.

---

## What Round 1 is

Fifteen trivia questions — five Easy, five Medium, five Hard. **Every team
answers the same question at the same time**, 60 seconds each, typed as free
text by one nominated player per difficulty.

It is the first round played, and the first round where a phone does real work.

---

## The two totals

The distinction the whole round turns on, and the one most easily collapsed:

| | What it is | Decides |
|---|---|---|
| **BB** | The game's score and currency | The game |
| **Round 1 points** | A separate running total | The Round 1 winner |

A correct answer awards its value to **both**. They are not two BB transactions,
and neither is derived from the other.

```text
Easy   20 BB  +  20 Round 1 points
Medium 30 BB  +  30 Round 1 points
Hard   50 BB  +  50 Round 1 points

A perfect round: 5×20 + 5×30 + 5×50 = 500 to each total.
```

They mirror each other per question but diverge over a game, because BB also
moves in the Market and through Maco Mail. **The Round 1 winner is decided on
points, never on BB** — a team can win Round 1 while trailing on BB, and that is
a legal outcome rather than a bug.

BB earned here stays in the main balance for the rest of the game.

---

## Architecture

The same shape as Round 2 and Round 3: the round is a cursor plus the state it
genuinely owns; the engine keeps the phase, the ledger and the shared systems.

```text
Room                 owns the content source, the AI judge, and the tick
  └─ GameEngine      owns the phase, the BB ledger, the active-player set
       └─ Round1     owns the questions, the nominees, the rulings, the POINTS
```

`Round1` holds no phase, no BB and no cards. Points live there because nothing
else owns them; BB moves through the engine's ledger like every other award.

### Files

| File | What it holds |
|---|---|
| `packages/protocol/src/round1.ts` | wire types, the locked constants, intents and events |
| `packages/game-rules/src/round1.ts` | the `Round1` class — questions, nominees, rulings, points, tiebreak |
| `packages/game-rules/src/round1-grading.ts` | the grading pipeline and the judge seam |
| `packages/game-rules/src/round1-content.ts` | the content source, validation, TEST packs |
| `packages/game-rules/src/game-engine.ts` | Round 1 methods; BB awards; active players |
| `packages/game-rules/src/room.ts` | intents, grading, polling, per-viewer snapshots |
| `apps/web/src/rooms/PlayerRound1.tsx` | the player screen |
| `unity/host/Assets/Scripts/HostRound1Panel.cs` | the Host panel |
| `unity/host/Assets/Scripts/Protocol/Round1Messages.cs` | the C# DTO mirror |

---

## The reveal is last

This is the sequencing rule the round is built around (§11, spec §5):

```text
1. 60-second window opens; nominees submit
2. window closes (Host, or the clock)
3. answers are graded
4. Host review resolves anything uncertain
5. FORGIVE MEH! retry runs, if a team is eligible and wants it
6. the retry is graded, and reviewed if necessary
7. scores are finalised
8. THE CORRECT ANSWER IS REVEALED
```

The canonical answer is held privately by `Round1` and crosses the view boundary
only at step 8 — `Round1QuestionView.correctAnswer` is `null` in every other
phase, for the **Host as well as the players**. A retrying player must never be
handed the answer they are about to give, and the only way to guarantee that is
for the server not to send it.

`revealRound1Answer()` refuses while anything is ungraded or awaiting a Host
ruling, so a premature press is rejected rather than leaking.

---

## Grading

Four layers, in order of confidence. Each one that answers definitively stops
the pipeline.

### A. Normalisation

Case, surrounding and repeated whitespace, accents (NFD then strip combining
marks), curly quotes and dashes, `&`/`and`, punctuation to spaces, and a
**leading** article only.

Deliberately **not** done: stripping digits, expanding abbreviations, removing
stop words, stemming. Each collapses real distinctions — "World War II" and
"World War III" differ by one character a naive digit-strip would erase.

### B. Exact match

Against the canonical answer and every approved variant, all normalised.

### C. Fuzzy match — the thresholds, and why

Damerau-Levenshtein, chosen over plain Levenshtein specifically for
**transposition**: "Shakespaere" is one finger slip, and plain Levenshtein
charges it as two edits.

| Answer length | Edits forgiven | Why |
|---:|---:|---|
| 1–4 | **0** | "Ford"/"Fort", "Rome"/"Rose", "Iran"/"Iraq" are one edit apart and are different answers |
| 5–11 | 1 | catches "Brazl", "Frnace", "Einstien" |
| 12+ | 2 | long answers attract more slips, and two edits cannot reach a different real answer |

Multi-word answers are compared **both** whole and word-by-word, because they
fail differently — "Willam Shakespere" is two separate one-character slips.
Word counts must match, so "New York" cannot fuzzily match "York".

**The bias is toward asking, not guessing.** A false accept silently awards BB
and nobody notices; a NEEDS_HOST_REVIEW costs the Host two seconds.

### D. The AI semantic judge

Only for answers the first three layers could not decide — "the second world
war" for "World War II".

**No provider is chosen.** The repository has no AI provider decision, and
Phase 7C does not make one by default. It ships:

- `AnswerSemanticJudge`, a vendor-neutral interface,
- `UnavailableSemanticJudge`, the default, which refuses to guess,
- `guardedJudge`, which collapses timeout, throw and malformed response to
  NEEDS_HOST_REVIEW,
- a deterministic stub in tests. **No test touches the network.**

The judge receives only the prompt, the canonical answer, the approved variants
and the submitted answer. `SemanticJudgeRequest` has no field for a future
question, another team's answer, a hand or a credential.

**The game is fully playable with no AI at all.** The Host simply rules more
often.

### E. Host review

The Host can rule any submitted answer CORRECT or INCORRECT at any time before
the reveal, including overturning an automated ruling (§4E). The record keeps
the automated verdict, the final verdict, and whether the Host overrode it.

**A stored ruling is reused, never recomputed.** Re-grading on reconnect could
return a different verdict and make a score depend on when a phone woke up.

### Where grading runs

`Room` is synchronous by design. The deterministic layers therefore run
**inline**, which decides the overwhelming majority of answers; only a genuinely
ambiguous one is queued for the judge and lands on a later tick — the same
polled pattern as timer expiry, the Clash window and Round 3's item windows.

---

## Cards

The locked table (§6), as D-030 left it:

| Legal | Not legal |
|---|---|
| Maco! | Steups! |
| Double It! | Gimme Dat! |
| ALLYUH HELP ME! | Doh Know |
| FORGIVE MEH! | |

**Maco!** is legal *here and nowhere else*. The target must have **already
submitted** — that is what guarantees a half-typed answer is never exposed. One
nominated player sees one opponent answer for 10 seconds, scoped by the server
to that player's snapshot alone. Viewing neither copies nor submits it.

An expired viewing is dropped on the tick and **a reconnect cannot revive it**.

**Double It!** doubles both totals on a correct answer — 20→40, 30→60, 50→100.
A wrong answer stays 0; doubling nothing is nothing.

**ALLYUH HELP ME!** shares the assisting team's *grading outcome*, never their
answer text. If that answer is correct the requesting team receives the question's
**normal base value** — not the assisting team's doubled value, even if they
played Double It.

**FORGIVE MEH!** needs a **final INCORRECT ruling** first, which is why
NEEDS_HOST_REVIEW does not qualify and an unanswered question does not either.
Ten seconds, one retry, and it cannot chain with the Market's Second Chance (§4).

### Why Gimme Dat! and Doh Know left

Both act on an individually assigned question, and Round 1 no longer assigns one.
Removing them followed from the format change rather than being a separate
decision — and it left them with no legal challenge anywhere, exactly as Maco!
had none before. `CARDS_WITHOUT_LEGAL_CHALLENGE` names them; it was built derived
precisely so this kind of swap needs no hunting.

---

## Active players — Round 1 is the first

D-021: an active player is one the current challenge requires. Rounds 2 and 3
mark nobody, because their challenges are spoken and Host-judged.

Round 1 is different — the nominee is the only person who can submit, so their
phone dropping genuinely stops that team. **Scoped to an open question** by owner
decision (D-032):

- active while an answer window or a retry window is running,
- **not** during nomination, grading, review or the reveal,
- a team that has already submitted stops needing its nominee awake.

The set shrinks as answers arrive, which is what keeps a party from pausing
constantly.

---

## The sudden-death tiebreaker

If two or more teams tie on the highest Round 1 points.

**⚠ NOT §21's end-of-game Sudden Death.** That mode needs two consecutive correct
answers, uses the phone buzzer and wins the game. This one only decides who won
Round 1, and is kept architecturally distinct: separate types, separate events,
and it never enters the `SUDDEN_DEATH` phase.

- 30 seconds per question, same question to every still-tied team,
- same grading pipeline, same nominated answerer,
- content from the same abstraction, with a separate cursor so a consumed
  question is never reused.

| Outcome | Result |
|---|---|
| exactly one correct | that team wins Round 1 |
| some but not all correct | the incorrect teams are eliminated; the rest continue |
| all correct | replay — nothing separates them |
| none correct | replay — nothing separates them |

**It moves no BB and adds no Round 1 points.** Enforced structurally:
`resolveRound1Tiebreak` never calls the ledger and never calls `applyAwards`, so
there is no path from the tiebreak to either total.

Bacchanal cards are **unavailable** in the tiebreak — no locked source addresses
them, and inventing a rule was the wrong call. Recorded as `OPEN_RULES.md` §14.

---

## Content

`Round1ContentSource` is the same seam as Round 3's, for the same reason (§13):
the game supplies content, the Host never types it.

The one difference is that a Round 1 item **must** carry its canonical answer,
because the round is machine-graded. That makes `Round1ContentItem` a
**server-only type** — it never crosses the wire. `Round1QuestionView` is what
clients receive and has no field for a canonical answer or a variant.

The set is validated on entry: exactly 15 items, exactly 5 per difficulty, unique
ids, every item answerable. A malformed pack refuses the round rather than
surfacing mid-game as a missing question.

**The source decides the order.** §11 does not require Easy→Medium→Hard, and the
TEST pack is deliberately mixed so the engine is exercised against that from the
first run.

TEST fixtures are obviously fake on purpose (`CONTENT_POLICY.md`): the project
owner plays this game, and a fixture that read like real trivia would invite
someone to promote it.

---

## Hidden information

| Secret | Protection |
|---|---|
| the canonical answer before the reveal | the view carries `null` until `revealed` |
| accepted variants | `Round1QuestionView` has no field for them, ever |
| future questions | only the current question is ever built into a view |
| another team's answer | the room scopes `round1` per viewer |
| a Maco! viewing | scoped to one `playerId`, and expires on the tick |

Asserted at three levels: in-process, over a real WebSocket
(`round1-network.test.ts`), and through Unity's own DTOs
(`HeadlessRound1Check`) — because in-process tests can pass while the serialised
view is wrong, which is how Phase 6, 7A and 7B each found a bug.

---

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` | **1018** (73 Round 1, 34 grading, 8 network) |
| `pnpm build` | pass |
| compiled-server walkthrough | **30/30** |
| Unity headless Round 1 | **41/41**, 0 compile errors |
| Unity regressions | Round 3 36/36, Round 2 36/36, engine 49/49, shared 43/43, lobby 47/47 |
| IL2CPP Windows standalone | Succeeded, 0 errors, 0 warnings |

### Bugs found while building

**Tiebreak and retry answers were graded only when their window EXPIRED.**
`#gradeRound1Pending` ran from the expiry branch of the tick, so a Host closing
either early — which is the normal case once every team has answered — left the
answers ungraded and the question could never be revealed. Fixed by grading on
the tick whenever anything is pending, regardless of which path closed the
window. Caught by the test suite before any physical testing.

---

## Still open

- **Round 1 tiebreak card compatibility** (`OPEN_RULES.md` §14) — deliberately
  unavailable rather than invented.
- **A production content pipeline.** The seam exists and TEST content fills it.
- **An AI provider.** No decision exists; none was made by default.
