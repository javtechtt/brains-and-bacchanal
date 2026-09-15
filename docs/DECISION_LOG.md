# Brains & Bacchanal — Decision Log

These decisions supersede older conflicting documents.

## D-001 — No Digital Buzzers Before Family Feud
Rounds 1–3 do not use the phone as a digital buzzer.

Family Feud is the first main buzzer section.

Sudden Death may also use a buzzer.

## D-002 — Round 1 Uses Different Questions
Teams take turns answering different questions.

No buzzer.

Exact total allocation remains open.

## D-003 — Round 2 Physical Rules Stay Outside the App
Host runs Bottle Battle, Match Makers, Grabbers and Bombers physically.

Software only needs Host winner selection and configured 500 BB award.

## D-004 — Think Fast Is Turn-Based
- no buzzer,
- teams alternate,
- two-team order via rock-paper-scissors,
- Host validates,
- no BB per answer,
- last team able to provide valid answer wins 500 BB.

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

Maco! currently has no legal challenge and remains unresolved.

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
