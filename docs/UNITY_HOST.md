# Brains & Bacchanal — Unity Host

The Unity Host Display: the Phase 3 test that proved Unity can act as a client of
the authoritative game server, and the Phase 4 Host lobby built on it.

> **Status: COMPLETE. Unity raw WebSocket compatibility is proven.**
>
> The Editor runtime test passes **29/29 checks against the live benchmark
> server**; both Mono and **IL2CPP** Windows standalone `.exe` builds succeed and
> run cleanly with zero exceptions; and **real-device tests A–E all pass** with
> two physical phones, the Unity Host and the browser Host on one session.

---

## Phase 4 — the Host lobby

The first functional Host screen: create a room, show the code and a scannable
QR, list players as they join, build teams, lock them.

| | |
|---|---|
| **Scene** | `Assets/Scenes/HostLobby.unity` (startup scene) |
| **Behaviour** | `Assets/Scripts/HostLobby.cs` |
| **DTOs** | `Assets/Scripts/Protocol/RoomMessages.cs` |
| **QR encoder** | `Assets/Scripts/Util/QrCode.cs` |
| **Socket** | `ws://<host>:4000/room/ws` |

### Results

| Check | Result |
|---|---|
| C# compilation (batch mode) | **PASS** — 0 errors, 0 warnings |
| Headless lobby check vs live compiled server | **PASS — 47/47** |
| **Headless ENGINE check vs live compiled server** | **PASS — 49/49** |
| IL2CPP Windows standalone build | **PASS** — 0 errors, 0 warnings |
| Standalone `.exe` runs | **PASS** — no exceptions, clean D3D12 init |
| QR decoded by a real scanner | **PASS — 307/307** (`tools/qr-verify/`) |

### The engine check exists because JsonUtility fails quietly

`HeadlessEngineCheck.cs` (Phase 5) drives a whole generic game through the real
C# DTOs against the real compiled server: START_GAME, starting BB, a generic
challenge, turn and active player, a timer, the D-011 auto-pause, reconnect,
Host-only resume, a Host ruling, resolution through the ledger, the floor at
zero, and Host reconnect to the *same* game.

It is not redundant with the TypeScript tests. **JsonUtility does not throw on a
field mismatch** — it deserialises to zero or null. A drifted DTO would show up
as "0 BB" on a television in front of a room of people, not as an error. The only
way to catch that is to read real server JSON through the real DTOs and assert
the values, which is what this check does.

```
Unity.exe -batchmode -quit -nographics -projectPath unity/host   -executeMethod BrainsAndBacchanal.EditorTools.HeadlessEngineCheck.Run
```

The server must be running with `GAME_SERVER_DEV_TOOLS=1` for the BB-floor check;
it is skipped, not failed, when development tools are off.

`HeadlessLobbyCheck.cs` runs the SAME client, DTOs and QR encoder the scene uses,
against the real production server. It covers room creation, the join flow,
credential secrecy on broadcasts, Host-authority rejection, team assignment,
three-team mode, lock validation, Host reconnect to the same room, and rejection
of a forged Host credential.

```
Unity.exe -batchmode -quit -nographics -projectPath unity/host \
  -executeMethod BrainsAndBacchanal.EditorTools.HeadlessLobbyCheck.Run
```

### The QR encoder is hand-written, and verified by decoding

Unity ships no QR encoder, and D-014 deliberately avoids third-party C# packages
in the Host. `QrCode.cs` implements ISO/IEC 18004 byte mode at EC level M.

**Generating an image proves nothing.** `tools/qr-verify/` renders the output and
decodes it with OpenCV. That caught three real bugs, none visible by inspection —
format bits in the wrong modules (every code unreadable), a one-sided mask
penalty rule, and mask 2 producing valid-but-poorly-scanning codes (D-020).

### Reused, not rewritten

`BenchmarkWebSocketClient` serves both the benchmark and the production lobby;
only its `RoomId` differs. Writing a second client would have discarded the
29/29 evidence that justified D-014 and doubled the hand-rolled ack-correlation
code that decision already counts as its ongoing cost.

### The Phase 5 engine test panel

`HostEnginePanel.cs` is a **separate partial class**, deliberately: it is
development-only tooling, and keeping it out of `HostLobby.cs` means that is
obvious at a glance and that deleting it later touches nothing else.

It shows game status, phase, team balances, the current challenge, turn, active
players, the timer, the pause state and the last event; and it offers Start Game,
phase moves, prepare/begin/review/resolve, set turn, set active player, start and
cancel a timer, Host VALID/INVALID/WINNER rulings, resume, and development BB
adjustments.

**None of it ships.** Everything is labelled `[DEV]`, the BB controls are hidden
entirely when the server reports `devToolsEnabled: false`, and the real Host
presentation is Phase 8.

`_game` is captured **once** at the top of `OnGUI`, exactly as `_snapshot` is and
for the same reason — see the IMGUI Layout/Repaint note below. It matters more
here: game state changes far more often than the lobby roster (every BB award,
every turn, every timer event), so an uncaptured read would hit the mismatch
routinely rather than rarely.

### Not yet done

- **The standalone `.exe` has not been driven through a full game by hand.** It
  launches and initialises cleanly, but creating a room needs a button press, so
  the end-to-end proof for the standalone rests on the Editor check exercising
  the identical code path.
- No presentation work: no artwork, animation, sound or branded layout. IMGUI
  only. That is Phase 8.

---

## Scope

This is a **functional networking test**, not the game presentation.

There is deliberately no Family Feud board, no Bacchanal animation, no Market or
Maco Mail screen, no artwork and no sound. `DEVELOPMENT_ROADMAP.md` places all of
that in **Phase 8**, after the game logic works. The test screen is ugly on
purpose.

## Unity version

| | |
|---|---|
| **Version** | `6000.3.24f1` (Unity 6.3 LTS) |
| **Path** | `G:\Programs\Unity\Hub\Editor\6000.3.24f1\Editor\Unity.exe` |
| **Install size** | 13.67 GB |
| **License** | Unity Personal — valid, active |
| **Build support** | Windows Standalone with **IL2CPP** and Mono (plus WebGL) |
| **Chosen because** | The only version installed; there was no choice to make |

Note the install is on **G:**, not the default `C:\Program Files` — Unity Hub is
configured with a secondary install path (`%APPDATA%\UnityHub\secondaryInstallPath.json`).
Anything scripting the Editor must not assume the default location.

### History worth keeping

An earlier install of `6000.6.0f1` was **broken**: `UnityPackageManager.exe` was
missing from an otherwise complete 5.85 GB install (a normal launch exited 1),
and no build support module was present at all. It was replaced with the
13.67 GB `6000.3.24f1` LTS install documented above. Both problems are resolved:
Package Manager connects and resolves packages, and IL2CPP is available.

The project's `ProjectSettings/ProjectVersion.txt` was repinned from
`6000.6.0f1` to `6000.3.24f1`, and the stale `Library/` from the old Editor was
deleted so the project reimports cleanly.

## Project location and structure

The project lives in `unity/host/`, inside the existing monorepo — not a separate
repository.

```text
unity/host/
├─ Assets/
│  ├─ Editor/
│  │  ├─ BenchmarkSceneBuilder.cs    Builds NetworkingTest.unity from code
│  │  └─ HeadlessNetworkCheck.cs     Batch-mode end-to-end protocol check
│  ├─ Scenes/
│  │  └─ NetworkingTest.unity        The one test scene
│  └─ Scripts/
│     ├─ NetworkingTest.cs           MonoBehaviour: renders state, sends intents
│     ├─ Net/
│     │  └─ BenchmarkWebSocketClient.cs   Raw WebSocket client
│     └─ Protocol/
│        ├─ Envelopes.cs             Intent/event envelopes, actor, rejection, ack
│        ├─ BenchmarkMessages.cs     Benchmark DTOs: snapshot, timer, buzzer, clients
│        └─ WireFraming.cs           Raw-WebSocket framing + JSON extraction
├─ Packages/manifest.json            Built-in Unity modules only
└─ ProjectSettings/
```

`Assets/`, `Packages/` and `ProjectSettings/` are **tracked**. `Library/`,
`Temp/`, `Logs/`, `Obj/`, `Builds/`, `UserSettings/` and Unity batch logs are
ignored — see the Unity section of `.gitignore`.

## Networking architecture

```text
   Unity Host (C#)                      Game server (TypeScript)
   ────────────────                     ────────────────────────
   NetworkingTest.cs                    BenchmarkSession
        │  renders                            │  authoritative
        ▼                                     ▼
   BenchmarkSnapshot  ◀──── event ───── WebSocketTransport
        │                                     ▲
        │  Host action                        │
        ▼                                     │
   BenchmarkWebSocketClient ──── intent ──────┘
```

**Unity is a client, never an authority.** Per `CLAUDE.md` — "Unity should render
server state; it should not duplicate game logic" — nothing in `unity/host/`
decides:

- who won a buzzer,
- whether a timer expired,
- BB values,
- sequence ordering,
- pause state,
- challenge results,
- card legality.

Every Host action (Resume, Request Snapshot, Ping) is submitted as an **intent**.
The server decides and replies with an authoritative event, including rejections
— for example a non-Host resume comes back `UNAUTHORIZED_ACTOR`, and the scene
displays that rather than acting on its own.

`NetworkingTest.cs` deliberately re-requests a snapshot on any event type it does
not model locally, rather than computing a delta. Unity never derives state it
was not told.

## C# protocol layer

`ARCHITECTURE.md` §3 defines the chain `schema -> TypeScript types -> C# DTOs`.
These DTOs are **hand-written to match `packages/protocol` exactly**. The
TypeScript side stays the source of truth; it was not reshaped to make C# easier.

Covered: protocol version, IDs, intent envelope, event envelope, sequence number,
server timestamp, structured rejection, intent acknowledgement, snapshot state,
benchmark client info, timer info, buzzer info, transport summary.

Three details worth recording, because a hand-written DTO layer has to get them
right and a generator would not have been asked:

1. **`serverTime` and `seq` are `long`, not `int`.** Epoch milliseconds overflow
   `Int32`. The headless check asserts `serverTime > 1_600_000_000_000` precisely
   to catch a silent truncation.
2. **The intent envelope has no client timestamp**, matching the TypeScript type.
   `ARCHITECTURE.md` §6 says a client's claimed time never decides anything, so
   the protocol offers nowhere to put one. It was not added for Unity's
   convenience.
3. **`sessionId` is omitted, not null,** when absent — the server's
   `isIntentEnvelope` rejects a non-string `sessionId` if the key is present.

### JSON approach

Unity's built-in `JsonUtility` is used, so the project needs **no third-party JSON
dependency**. Its limitation is real: it cannot represent an arbitrary `payload`
(there is no `unknown`/`object` equivalent) and it silently drops unknown fields
rather than erroring.

`WireFraming.cs` works around this with a small hand-rolled brace-matching scanner
that extracts a named sub-object verbatim, which is then handed to `JsonUtility`
for the one concrete type the caller expects. The workaround is contained to that
one file. If the protocol grows substantially in later phases, a proper JSON
library (or generated DTOs) becomes worth revisiting.

## Raw WebSocket implementation

Uses **`System.Net.WebSockets.ClientWebSocket`** — the standard .NET API that
ships with Unity. **No third-party package.**

`docs/NETWORK_BENCHMARK.md` previously flagged that `ClientWebSocket` works in the
Editor and desktop standalone but **not in WebGL**, where a `jslib` bridge would
be needed. The Host Display is a desktop application (`ARCHITECTURE.md` §1), so
that limitation does not apply. It would matter if the Host ever had to run in a
browser.

### Framing cost — evidence for the transport decision

Raw WebSockets have no built-in request/response, so the server's adapter defines
its own framing: every message carries a `kind`, and an intent carries a
`requestId` the server echoes on the reply.

The Unity client therefore reimplements that correlation: a
`ConcurrentDictionary<string, TaskCompletionSource<IntentAck>>` keyed by
`requestId`, plus timeout handling and failing every in-flight request on
disconnect.

**This is the third time that cost has been paid** — server adapter (~40 lines),
browser client, now Unity. `docs/NETWORK_BENCHMARK.md` predicted exactly this.
Socket.IO provides the same thing free via ack callbacks. It is a real,
recurring maintenance input to the transport decision, not a footnote.

### Threading

`ClientWebSocket` is async and its continuations do not run on Unity's main
thread, but Unity API calls must. So:

- `BenchmarkWebSocketClient` touches **no** Unity API at all — it queues received
  frames on a `ConcurrentQueue`,
- `NetworkingTest.Update()` drains that queue on the main thread,
- every `await` in the client uses `.ConfigureAwait(false)`.

That last point was not theoretical. The first headless run **deadlocked**: it
connected, printed nothing further and hung until killed, because the harness
blocked Unity's main thread while awaiting continuations that wanted to return to
it. Fixed by `ConfigureAwait(false)` throughout plus running the check body on a
thread-pool thread. Worth knowing before anyone writes `.Result` in Unity code.

## Socket.IO findings

**Not implemented, and not attempted as a hack.** `§8` of the task is explicit
that `ClientWebSocket` must not be pointed at a Socket.IO endpoint as though it
were plain WebSocket — Socket.IO layers Engine.IO framing on top and would fail
(the TypeScript side hit exactly this: `Invalid WebSocket frame: RSV1 must be
clear`).

Using Socket.IO from Unity requires a third-party C# client. There is **no
official Unity or C# client from the Socket.IO team.** The realistic options are
community packages such as `SocketIOUnity` or `socket.io-client-csharp`.

Assessment against the criteria requested:

| Criterion | Finding |
|---|---|
| Maintenance | Community-maintained; no vendor backing. Risk of lagging behind Socket.IO server major versions |
| Unity compatibility | Varies by package; IL2CPP/AOT code-stripping issues are a known class of problem |
| Licensing | Typically MIT, generally acceptable — must be confirmed per package |
| Dependency burden | Adds a dependency the project currently does not have; the raw WebSocket path adds none |
| Windows standalone | Plausible but unverified |
| Reconnect behaviour | Socket.IO's reconnection logic is a genuine strength — if the C# client implements it faithfully |
| Protocol fit | Engine.IO framing must match the server's major version exactly |

**Recommendation: do not add a Socket.IO C# dependency to satisfy symmetry.** The
task says not to force the test "merely to say both were tested". The raw
WebSocket path already works with zero dependencies. If Socket.IO were otherwise
the preferred transport, a spike on one specific package would be justified —
but that spike should be a deliberate decision, not a side effect of this test.

## Blockers

Two problems with the installed Unity prevented completing the runtime tests.

### 1. Windows Build Support module missing

`PlaybackEngines` was empty and there was no `il2cpp` directory, so **no `.exe`
could be produced**. §12 (Windows standalone) is blocked until
**Windows Build Support (IL2CPP and/or Mono)** is added via
Unity Hub → Installs → gear → Add modules.

### 2. Package Manager server missing (install appeared corrupt)

A normal Editor launch exited with code **1**:

```text
Could not find Unity Package Manager local server application at
  ...\Editor\Data\Resources\PackageManager\Server\UnityPackageManager.exe
Missing files could be the result of an antivirus action or a corrupt Unity installation.
```

The `Server\` directory was genuinely absent from an otherwise complete 5.85 GB
install. Unity **did** launch successfully with `-noUpm` (exit code 0), which is
how the project was created and the C# compiled — but it is a real defect, and
normal GUI use would hit it constantly.

The Editor was being reinstalled when this document was written.

## Results

### Editor runtime — PASS (27/27)

`HeadlessNetworkCheck` run against the live benchmark server on
`ws://127.0.0.1:4500/benchmark/ws`: **checks=27 failures=0**.

Every point of the Phase 3 raw-WebSocket checklist verified:

| # | Check | Result |
|---|---|---|
| 1 | Unity connects | PASS |
| 2 | Protocol version correct | PASS |
| 3 | Server events deserialize | PASS (envelope + payload) |
| 4 | Sequence numbers correct | PASS |
| 5 | Server timestamps correct | PASS (ms precision, `long`) |
| 6 | Authoritative snapshot received | PASS (in `CLIENT_JOINED` and on request) |
| 7 | Sees connected benchmark players | PASS (`clients` array parsed; self present) |
| 8 | Sees timer state | PASS |
| 9 | Sees pause/resume state | PASS (observed `phase=PAUSED`) |
| 10 | Receives server-selected buzzer winner | PASS (`acceptedBuzz` field parsed) |
| 11 | Disconnects cleanly | PASS |
| 12 | Reconnects cleanly | PASS |
| 13 | Reconnect restores current state | PASS (`reconnected: true` + fresh snapshot) |
| 14 | No duplicate Unity Host identity | PASS (exactly 1 entry for the identity) |

Also verified: an unknown intent is rejected with a structured code, and a
repeated `intentId` comes back `DUPLICATE_INTENT`.

### Windows standalone — Mono PASS, IL2CPP BLOCKED

**Mono: PASS, confirmed running against the live server.** Builds (123 MB, 0
errors), the `.exe` runs cleanly (window opens, D3D11 initialises, no
exceptions), and when connected it correctly rendered authoritative state:

```text
Latest sequence number   16
Session state            PAUSED
Paused                   PAUSED — player disconnected (probe-client)
Transports               socketio=0 websocket=1
CONNECTED BENCHMARK CLIENTS (4)
  [online ] HOST  unity-host  (websocket)
RECENT SERVER EVENTS
  #17 BENCHMARK_SNAPSHOT
  #16 BENCHMARK_CLIENT_JOINED
```

Note what this demonstrates beyond "it connected": the standalone player
received a `CLIENT_JOINED` then a `SNAPSHOT`, identified itself as HOST over
`websocket`, listed all four known clients with their per-client transports,
and rendered the **auto-pause reason including which client caused it**
(`player disconnected (probe-client)`) — all of it read from server state, none
of it decided locally.

**IL2CPP: PASS.**

```text
result=Succeeded errors=0 warnings=0 sizeBytes=529318874 time=00:02:50
```

Verified to be genuinely IL2CPP rather than a silent Mono fallback:
`GameAssembly.dll` (25 MB of compiled C++) and `il2cpp_data/` are present, and
there is **no** `MonoBleedingEdge` runtime in the output.

The `.exe` launches and runs with **zero exceptions** in the player log — no
AOT/stripping failures, which was the main risk for a reflection-based
`JsonUtility` path. `ManagedStrippingLevel.Minimal` is set in the builder to
keep that risk low.

#### The blocker this hit first, and the fix

The initial attempt failed with:

```text
Could not set up a toolchain for Architecture x64.
IL2CPP C++ code builder is unable to build C++ code.
```

IL2CPP transpiles C# to C++ and needs a **C++ toolchain beyond Unity's own
build-support module**. MSVC was present (Visual Studio Community 2026, MSVC
14.51.36231) but the **Windows SDK was missing** — `Windows Kits\10` contained
only `UnionMetadata`, no `Include\` or `Lib\`.

Fixed by installing a Windows SDK via the Visual Studio Installer. Worth
recording for anyone setting up a new build machine: *Unity's build-support
module alone is not sufficient for IL2CPP.*

### Compilation — PASS

C# compiled cleanly in batch mode, **zero errors**, and
`BenchmarkSceneBuilder.Build` generated `Assets/Scenes/NetworkingTest.unity` and
registered it as the build scene (Unity exit code 0).

### Editor runtime — NOT COMPLETED *(SUPERSEDED — historical)*

> **This entry is an earlier snapshot, kept for the record. It was superseded by
> "Editor runtime — PASS (27/27)" above, and finally by the 29/29 run cited in
> the status block at the top of this file. Do not read it as current status.**

The headless end-to-end check (`HeadlessNetworkCheck.cs`) was written and one run
attempted. That run surfaced the deadlock described above; after fixing it, the
Editor was mid-reinstall and the check could not be re-run.

The check verifies, against the real running benchmark server: connect, hello
acknowledged, `CLIENT_JOINED` received, envelope parsed, protocol version match,
sequence number and millisecond-precision timestamp deserialised, actor present,
payload extracted, snapshot present and parsed, this client visible in the
server's client list, unknown intent rejected with a structured code, duplicate
`intentId` rejected as `DUPLICATE_INTENT`, clean disconnect, reconnect, fresh
state after reconnect, and **no duplicate Unity identity created**.

### Windows standalone — NOT COMPLETED *(SUPERSEDED — historical)*

> **Superseded.** The missing build module was installed and a Windows SDK
> added; both Mono and IL2CPP standalone builds now succeed and run. See the
> status block at the top of this file.

Blocked on the missing build module.

### Real-device tests (A–E) — ALL PASS

Run against the IL2CPP standalone `.exe` with **two physical phones**, the Unity
Host and the browser Host all on one session:

| Test | Result |
|---|---|
| **A — Players** | PASS. Unity listed both phones; disconnect/reconnect restored the **same identity**, no duplicate |
| **B — Timer** | PASS. Unity and both phones counted down together; pause froze all; resume continued from the frozen value |
| **C — Phone lock** | PASS. Locking a phone auto-paused the session, Unity showed `PAUSED — player disconnected (…)`, unlocking **did not** resume, only Host Resume continued play |
| **D — Buzzer** | PASS. Both phones buzzed; the server picked one winner and Unity displayed it |
| **E — Unity reconnect** | PASS. Disconnect/reconnect restored current authoritative state |

Final observed session state, all five clients on one shared session:

```text
seq: 22   phase: ACTIVE_PLAY   paused: False
transports: {socketio: 0, websocket: 4, mixed: False}
  phone-6rr3    | websocket | online | player
  phone-3l7f    | websocket | online | player
  unity-host    | websocket | online | HOST
  browser-host  | websocket | online | HOST
```

Note `seq: 22` after a full A–E run: sequence numbers now track **real state
changes only**, not polling (see bug 2b).

Three bugs were found by these tests and fixed — the frozen timer, the snapshot
sequence-number inflation, and the ungrouped transport radios. All are recorded
below.

## Bugs found by running it (not by compiling it)

Both were caught by the headless check against the real server, and neither
would have been caught by "the C# compiles".

### 1. JSON field-name matching hit a false positive

Every acknowledgement failed with `MALFORMED_ACK` while the connection itself
looked perfectly healthy. Cause: an ack frame is

```json
{"kind":"ack","requestId":"probe-1","ack":{"ok":true,"seq":7}}
```

The text `"ack"` appears **twice** — first as the *value* of `kind`, then as the
real field. `ExtractObject` matched the first occurrence, found a comma where an
object should be, and returned null.

Fixed with `FindValueStart`, which keeps scanning until a match is followed by
`:` — the thing that actually distinguishes a field key from a string value.

### 2. Timer did not count down live (found on real devices)

The countdown sat frozen in Unity and only jumped forward when something else
caused a refresh. Every other value was correct, which is what made it easy to
miss: the panel updated on **events**, and a running timer produces no events.
The server has no reason to push a per-second tick, so a client wanting a live
countdown has to ask. The browser pages already poll every 400-500ms; Unity had
no equivalent.

Fixed with two separate things, deliberately kept distinct:

1. **Authoritative refresh** — `RequestSnapshot` every 500ms while connected,
   matching the browser clients.
2. **Display-only interpolation** — `DisplayedRemainingMs()` subtracts locally
   elapsed unscaled time between refreshes so the countdown ticks smoothly
   rather than stepping twice a second.

**The interpolation decides nothing.** Every refresh snaps the display back to
the server's value, so local drift cannot accumulate; the result is floored at 0
rather than implying an expiry the server has not declared; and a *paused* timer
is never interpolated at all, because `GAME_RULES_LOCKED.md` §20 requires paused
time not to consume the remaining time. The panel shows both
`Timer remaining (ms, displayed)` and `Timer remaining (ms, server)` so the two
can be compared during testing.

A background poll also no longer overwrites "Last acknowledgement" on success —
it would erase the result of whatever button the operator just pressed. A
**failed** poll still reports, because a silently dead refresh loop should stay
visible.

### 2b. Snapshot requests were spending sequence numbers (server-side)

Polling immediately exposed a **protocol design flaw** that had been invisible
while nothing polled: `BENCHMARK_REQUEST_SNAPSHOT` **emitted a broadcast event
and consumed a sequence number** — for a pure read.

The symptom was a wall of `BENCHMARK_SNAPSHOT` lines in every client's event
feed. The real damage was worse: an idle session burned ~10 sequence numbers
every 5 seconds (measured: 529 → 539 with nothing happening).

That contradicts `docs/PROTOCOL.md` directly — sequence numbers mark **accepted
state changes**, and *"a gap tells a client it missed an event and should
request a snapshot"*. Spending them on reads corrupts the one signal clients use
to detect genuine loss, and makes the event log useless for understanding how
the current state was reached.

**Fixed at the server**, which is where the flaw was: a snapshot request now
returns state in the **acknowledgement** and emits nothing. `IntentAck` gained
an optional `snapshot` field for read-only intents. The requester gets exactly
what it asked for, no other client is disturbed, and the `seq` reported is
simply the latest real one.

After the fix a fresh session sits at `seq=1` and holds steady under continuous
polling, where the old behaviour had reached 539.

Four server tests now enforce this: a read consumes no sequence number, emits no
event, returns the snapshot in the ack, and reports the latest *real* sequence
number.

### 2c. Transport radio buttons were not one group (web)

Both `socketio` and `websocket` rendered as selected and clicking one never
cleared the other, so **the transport could not be changed at all** — on the
Host page *or* the player page, meaning phones were affected too.

Cause: the radios had no `name` attribute. Without a shared name the browser
treats each radio as its own single-member group, so each tracks `checked`
independently. Fixed with a shared `name="bb-transport"` (plus `value`).

Verified in a real headless Chrome rather than by reading the bundle:
`sameGroup: true, exactlyOneChecked: true`.

### 3. Unity main-thread deadlock

The first headless run connected, printed nothing further and hung until killed.
Blocking Unity's main thread while awaiting continuations that want to return to
it is a deadlock. Fixed with `ConfigureAwait(false)` on every await in the client
plus running the check body on a thread-pool thread.

Worth knowing before anyone writes `.Result` in Unity code.

## Environment problems encountered (not code faults)

Recorded because they cost real time and will recur:

1. **Unity Hub holds the licensing mutex.** The Editor spawns its own
   `Unity.Licensing.Client`, which cannot acquire the global mutex
   `Unity-LicenseClient-Javal` while Hub's own client holds it:

   ```text
   Failed to acquire global mutex Unity-LicenseClient-Javal.
   Another instance of Unity.Licensing.Client is already running.
   ```

   The Editor then waits forever on a channel nobody opened, in **both** batch
   and GUI mode, surfacing the misleading
   `'com.unity.editor.headless' was not found` (the entitlement **is** granted —
   the full licence dump confirms it; it was being queried through a dead
   connection).

   **Workaround: fully quit Unity Hub — including the system-tray icon — before
   launching the Editor from its own `.exe`.** Hub's client cannot be killed
   while Hub is its parent. This reproduced after a clean reboot, so it is not a
   stale process.

2. An earlier `6000.6.0f1` install was corrupt (missing
   `UnityPackageManager.exe`, no build-support module). Replaced by the
   `6000.3.24f1` LTS install documented above.

## Dependencies introduced

**None.** `Packages/manifest.json` lists only built-in Unity modules
(`jsonserialize`, `uielements`, `ui`, `imgui`, `unitywebrequest`). No Asset Store
package, no NuGet package, no vendored DLL.

## Known limitations

- `ClientWebSocket` does not work in **WebGL**. Irrelevant for a desktop Host;
  relevant if that ever changes.
- `JsonUtility` cannot round-trip arbitrary payloads, hence the hand-rolled
  extraction in `WireFraming.cs`.
- The scene uses IMGUI (`OnGUI`), which is fine for a test panel and wrong for
  the real Host presentation. Phase 8 replaces it entirely.
- The project was created with `-noUpm`, so `Packages/manifest.json` was written
  by hand rather than generated.
- Unity 6000.6 is not an LTS release.
