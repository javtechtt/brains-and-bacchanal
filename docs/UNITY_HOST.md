# Brains & Bacchanal — Unity Host

The Unity Host Display, and the Phase 3 test that proves Unity can act as a
client of the authoritative game server.

> **Status: Unity compatibility testing is INCOMPLETE.**
> The project, the C# protocol layer and the NetworkingTest scene are built and
> compile cleanly. The Editor runtime test and the Windows standalone build have
> **not** been completed — see [Blockers](#blockers). Until they are, the Phase 3
> transport decision stays **OPEN**.

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
| **Version** | `6000.6.0f1` (Unity 6.3) |
| **Path** | `C:\Program Files\Unity\Hub\Editor\6000.6.0f1\Editor\Unity.exe` |
| **License** | Unity Personal — valid, active |
| **Chosen because** | It is the only version installed; there was no choice to make |

**Worth knowing:** 6000.6 is a Tech/Supported release, **not an LTS**. The Unity 6
LTS line is 6000.0. For a Host application maintained over years, an LTS is
usually the better base. This does not block the Phase 3 test, but it is a
decision worth taking deliberately before Phase 8 rather than inheriting by
accident.

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

### Compilation — PASS

C# compiled cleanly in batch mode, **zero errors**, and
`BenchmarkSceneBuilder.Build` generated `Assets/Scenes/NetworkingTest.unity` and
registered it as the build scene (Unity exit code 0).

### Editor runtime — NOT COMPLETED

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

### Windows standalone — NOT COMPLETED

Blocked on the missing build module.

### Real-device tests (A–E) — NOT COMPLETED

Tests A (players), B (timer), C (phone lock / auto-pause), D (buzzer) and
E (Unity reconnect) require the Editor or a standalone build running against the
benchmark server alongside real phones.

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
