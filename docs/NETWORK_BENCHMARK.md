# Brains & Bacchanal — Network Benchmark

Phase 3 compares **Socket.IO** and **raw WebSockets** so the transport choice
follows measurement rather than preference (`ARCHITECTURE.md` §7, `CLAUDE.md`
"Networking").

---

## The buzzer in this document is not the game buzzer

`CLAUDE.md`: **there is no digital buzzer before Family Feud.**

`BENCHMARK_BUZZ` is a **network measurement primitive** — the smallest
timing-sensitive round trip we can measure. It stands in for the kind of
interaction Family Feud and Sudden Death will later need, and nothing here is
reusable as their rules. Family Feud's face-off, control, strikes, steal and
wager are Phase 7, with several details still open in `OPEN_RULES.md`.

Every identifier is prefixed `BENCHMARK_` so this can never be mistaken for the
real engine.

---

## Architecture

```text
                    ┌──────────────────────────────┐
                    │      BenchmarkSession        │
                    │  (ONE instance, shared)      │
                    │                              │
                    │  · intent deduplication      │
                    │  · sequence numbers          │
                    │  · server timestamps         │
                    │  · pausable deadline         │
                    │  · Host-only resume          │
                    │  · authoritative buzzer      │
                    └──────────────┬───────────────┘
                                   │  RealtimeTransport
                   ┌───────────────┴───────────────┐
                   │                               │
        ┌──────────▼─────────┐        ┌────────────▼─────────┐
        │ SocketIOTransport  │        │ WebSocketTransport   │
        │ /benchmark/socketio│        │ /benchmark/ws        │
        └──────────┬─────────┘        └────────────┬─────────┘
                   │                               │
             browser / synthetic            browser / synthetic
```

**Both transports drive one session instance.** Identical state, identical
rules, identical metrics — so any difference the benchmark reports is a
property of the transport, not of two divergent implementations.

The transport layer contains **no game rules**: no BB, no cards, no Market, no
Maco Mail, no rounds. It moves envelopes and reports connection facts.

### Sharing one HTTP server

Both adapters attach to one `http.Server`. Socket.IO installs an `upgrade`
listener that **destroys the socket for any path it does not recognise**, so
the WebSocket adapter uses `noServer: true` plus `prependListener('upgrade')`,
claims exactly `/benchmark/ws`, and returns for everything else.

This was found the hard way: with a plain `on('upgrade')`, Socket.IO answered
the raw-WebSocket handshake and the client failed with
`Invalid WebSocket frame: RSV1 must be clear`. Worth knowing before anyone
"simplifies" that line.

---

## Metric definitions

The formulas live in `apps/game-server/src/benchmark/metrics.ts` and are
repeated here so results are comparable. Both transports are measured by the
**same code**. Nothing favours either one.

### RTT

```text
rtt = clientReceivedAt − clientSentAt
```

Both readings come from **one clock** (the client's), so no clock
synchronisation is involved and no client/server skew can contaminate it.

### Percentiles

Nearest-rank on the sorted sample:

```text
index = ceil(p/100 × n) − 1
```

Nearest-rank rather than interpolation: with the small samples a party-game
benchmark produces, interpolation invents values that were never observed.

### Jitter

Mean absolute difference between **consecutive** RTT samples:

```text
jitter = mean( |rtt[i] − rtt[i−1]| )    for i = 1..n−1
```

RFC 3550-style interarrival, not standard deviation. For a buzzer what hurts is
one round trip differing sharply from the one before it; standard deviation
would hide that inside an overall spread.

### Clock offset (display only)

```text
offset = serverTime − (clientSentAt + rtt/2)
```

Assumes a symmetric path, which is why it is **display only**. A client uses it
to render a countdown that roughly agrees with other devices.

**It never decides a buzzer winner, deadline acceptance or event ordering.**
Those are server-side facts (`ARCHITECTURE.md` §6).

### Timer drift

```text
drift = |clientDisplayedRemainingMs − serverRemainingMs|
```

A display concern. The server's value is always the real one.

---

## Running the benchmark

### 1. Start the benchmark server

```bash
pnpm benchmark:server
```

It prints the LAN URLs you need for phone testing.

### 2. Run synthetic clients

```bash
pnpm benchmark --transport socketio
pnpm benchmark --transport websocket
pnpm benchmark --transport both --clients 3 --pings 50 --buzz-trials 6
pnpm benchmark --transport both --out results.json
```

Options: `--transport` (`socketio` | `websocket` | `both`), `--host`, `--port`,
`--clients`, `--pings`, `--buzz-trials`, `--out`, `--allow-mixed`.

Both transports run the **same scenario code**, parameterised by transport.

### 3. Browser pages

```bash
pnpm dev
```

- Host panel: `http://localhost:3000/benchmark/host`
- Player page: `http://localhost:3000/benchmark/player`

### Mixed-transport sessions

Because both adapters feed one shared `BenchmarkSession`, the Host browser and
each phone can each independently choose Socket.IO or raw WebSocket and still
interact correctly — this was discovered during real two-phone LAN testing and
is an intentional property of the architecture, not a bug. **It also means a
mixed session is easy to mistake for a valid transport comparison.**

The Host panel always shows, per connected client, which transport it is
using, plus a running count:

```text
browser-host    HOST      websocket
phone-xxxx      PLAYER    socketio
phone-yyyy      PLAYER    socketio

Socket.IO connections: 2   ·   WebSocket connections: 1
```

If the connected clients are not all on the same transport, the panel shows a
**MIXED TRANSPORT SESSION** warning. The session keeps working — nobody is
disconnected — but the warning is your signal that measurements taken right
now are not comparable to a transport-pure run.

The **synthetic CLI runner enforces this automatically**. Before measuring
anything, it checks whether the live session already has a client connected on
the *other* transport (a Host browser or phone left over from manual testing,
for example) and refuses to run:

```text
$ pnpm benchmark --transport socketio
✗ Refusing an official socketio run: the live benchmark session also has 1
  client(s) connected via the other transport (socketio=2, websocket=1).
  Disconnect them, or pass --allow-mixed to run this as an explicit
  interoperability test instead of an official comparison.
```

To run anyway — for example, to specifically test that a mixed session behaves
correctly, per the requirement that mixed-transport testing remain available —
pass `--allow-mixed`. The resulting report is marked
`official.overridden: true` and must not be quoted as a Socket.IO-vs-WebSocket
comparison result; only a report with `official.pure: true` may be.

---

## Testing with real phones (step by step)

You do not need to understand the code to do this.

**Before you start:** phones and computer must be on the **same Wi-Fi**.

1. **Start the two servers.** Open two terminals in the project folder:

   Terminal 1:
   ```bash
   pnpm benchmark:server
   ```
   Terminal 2:
   ```bash
   pnpm dev
   ```

2. **Find your address.** Terminal 1 prints something like:
   ```text
   On LAN:  http://192.168.50.62:4500/health
   ```
   The part you need is `192.168.50.62` — your computer's address. Yours will
   differ.

3. **Allow it through the firewall.** The first time, Windows asks whether to
   allow Node.js on the network. Choose **Allow on private networks**. If you
   missed the prompt, see the firewall section below.

4. **On each phone**, open a browser and go to:
   ```text
   http://192.168.50.62:3000/benchmark/player
   ```
   (your address, `:3000`, not `:4500`)

5. **On your computer**, open:
   ```text
   http://localhost:3000/benchmark/host
   ```

6. **Choose the same transport everywhere** — pick `socketio` on the Host page
   and on every phone. Press **Connect** on each.

7. **Check the phones appear** in the Host panel's client list.

8. **Run the tests:**
   - Press **Start timer test**. All phones should count down together.
   - Press **Pause**. Every countdown should freeze.
   - Press **Resume**. They continue from where they stopped.
   - Press **Open benchmark buzzer**, then have everyone tap **BENCHMARK BUZZ**
     at once. One phone shows ACCEPTED; the others show REJECTED.
   - On a phone, press **Measure RTT** and note the number.

9. **Switch to `websocket`** on every device, press Connect again, and repeat
   step 8.

10. **Write the numbers into the tables below.** Both transports should behave
    identically; what differs is the measurements.

### Extra checks worth doing

- **Reconnect:** turn one phone's Wi-Fi off for ~10 seconds, then on. It should
  return as the same client. **The game must stay paused** if it was paused —
  only the Host may resume.
- **Screen sleep:** let a phone lock, then wake it.
- **Mixed devices:** two phones plus a laptop browser.

### Firewall

If phones cannot reach the pages, Windows Firewall is the usual cause. Allow
Node.js on **private** networks only — never public. In an **Administrator**
PowerShell:

```powershell
New-NetFirewallRule -DisplayName "BB benchmark 3000" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "BB benchmark 4500" -Direction Inbound -LocalPort 4500 -Protocol TCP -Action Allow -Profile Private
```

Remove them when finished:

```powershell
Remove-NetFirewallRule -DisplayName "BB benchmark 3000"
Remove-NetFirewallRule -DisplayName "BB benchmark 4500"
```

### LAN safety note

The benchmark server binds `0.0.0.0` and allows any origin, because that is
what makes phone testing possible. That is acceptable for a **development
instrument on a private network** and is **not** a pattern for the production
game server, which is a separate process and a separate entry point. Do not
expose port 4500 to the internet.

---

## Cloud testing

**Not performed. No cloud measurements exist, and none are invented below.**

The benchmark takes `--host` and `--port`, so the same scenarios run against a
deployment without code changes:

```bash
pnpm benchmark --transport both --host <deployed-host> --port 443
```

Procedure when a deployment exists:

1. Deploy `apps/game-server` with the benchmark entry point enabled.
2. Ensure the platform supports **WebSocket upgrades** (some require explicit
   configuration; some proxies buffer or drop them).
3. Run the synthetic benchmark from a machine on a normal internet connection,
   not the same datacentre.
4. Repeat the phone procedure over mobile data rather than Wi-Fi.
5. Record results in the cloud table below.

Cloud behaviour matters disproportionately for Socket.IO because its fallback
and reconnection logic exist precisely for hostile networks. Local numbers
cannot predict it.

---

## Unity

**Not tested. No Unity Editor is installed on this machine** (checked: no
`Program Files/Unity`, no Unity Hub, nothing on PATH), and `unity/host/`
contains only a placeholder README. Unity work is Phase 8.

Per the Phase 3 instruction, **the transport decision must not be finalised
while Unity integration risk is unknown.**

### Integration approaches to evaluate

**Raw WebSocket**
- `System.Net.WebSockets.ClientWebSocket` ships with .NET and needs no package.
- Works in the Editor and on desktop standalone builds.
- **WebGL cannot use it** — that platform requires a `jslib` bridge to the
  browser WebSocket API. Community package: `NativeWebSocket`.
- The request/response correlation this project's adapter hand-rolls would need
  reimplementing in C#.

**Socket.IO**
- No official Unity or C# client from the Socket.IO team.
- Community options exist (`SocketIOUnity`, `socket.io-client-csharp`), with
  the usual third-party risks: protocol-version lag, maintenance uncertainty,
  IL2CPP/AOT stripping issues.
- Engine.IO's framing must match the server's major version exactly.

### What must be answered before deciding

1. Does the chosen client connect from the Unity Editor on Windows?
2. Does it survive an IL2CPP standalone build?
3. Does reconnection work when the Host display's network drops?
4. Is the community package maintained against the server's Socket.IO version?

**Unity stability: OPEN.**

---

## Results — local machine

Single Windows machine, loopback. **Loopback latency is ~0 ms and tells you
almost nothing about real Wi-Fi.** These numbers demonstrate that both
transports work correctly and identically; they are not evidence for choosing
one.

Environment: Windows 11, Node v24.13.0, 3 synthetic clients, 20 pings,
3 buzz trials, both transports against one shared session.

### Socket.IO — local

| Metric | Value |
|---|---|
| RTT median | 0 ms |
| RTT p95 | 1 ms |
| RTT p99 | 1 ms |
| RTT min / max | 0 / 1 ms |
| Jitter | 0.42 ms |
| Events observed | 15 |
| Out-of-order events | 0 |
| Duplicated events | 0 |
| Duplicate intent rejected | yes (`DUPLICATE_INTENT`) |
| Client can identify original | yes (`originalSeq` present) |
| Buzzes accepted / rejected | 3 / 6 |
| Timer consumed during 1200 ms pause | 5 ms |
| Player resume rejected | yes (`UNAUTHORIZED_ACTOR`) |
| Host resume accepted | yes |
| Double pause rejected | yes |
| Resume-while-running rejected | yes |

### Raw WebSocket — local

| Metric | Value |
|---|---|
| RTT median | 0 ms |
| RTT p95 | 1 ms |
| RTT p99 | 1 ms |
| RTT min / max | 0 / 1 ms |
| Jitter | 0.32 ms |
| Events observed | 15 |
| Out-of-order events | 0 |
| Duplicated events | 0 |
| Duplicate intent rejected | yes (`DUPLICATE_INTENT`) |
| Client can identify original | yes (`originalSeq` present) |
| Buzzes accepted / rejected | 3 / 6 |
| Timer consumed during 1200 ms pause | 4 ms |
| Reconnect time | 3 ms |
| Identity restored | yes |
| Duplicate client created | no |
| **Auto-resumed after reconnect** | **no** (required) |
| Player resume rejected | yes (`UNAUTHORIZED_ACTOR`) |
| Host resume accepted | yes |

### Buzzer fairness — local

Synthetic clients transmit at known offsets. **The server still decides purely
by receive order; no latency compensation exists anywhere in the acceptance
path.**

| Schedule | Socket.IO winner | WS winner | Accepted |
|---|---|---|---|
| Clearly separated (0 / 250 / 500 ms) | first sender | first sender | 1 of 3 |
| Close (0 / 15 / 30 ms) | first sender | first sender | 1 of 3 |
| Simultaneous (0 / 0 / 0 ms) | first received | first received | 1 of 3 |

On loopback the first sender always won. **This tells us nothing about Wi-Fi**,
where the ordering can differ — which is exactly what phone testing is for.

---

## Results — LAN phones (TO BE FILLED IN)

Follow the phone procedure above and enter what you observe.

| Metric | Socket.IO | Raw WebSocket |
|---|---|---|
| Devices used (count, models) | | |
| RTT median | | |
| RTT p95 | | |
| RTT p99 | | |
| Jitter | | |
| Timers visually in sync across phones? | | |
| Timer froze on pause? | | |
| Buzzer: one winner only? | | |
| Reconnect after Wi-Fi off/on | | |
| Still paused after reconnect? (must be yes) | | |
| Screen sleep / wake recovered? | | |
| Anything felt wrong or slow? | | |

## Results — cloud (PENDING)

| Metric | Socket.IO | Raw WebSocket |
|---|---|---|
| RTT median | | |
| RTT p95 / p99 | | |
| Jitter | | |
| Reconnect time | | |
| Behaviour on mobile data | | |
| Proxy / upgrade problems | | |

## Results — Unity (OPEN)

| Check | Socket.IO | Raw WebSocket |
|---|---|---|
| Connects from Editor | | |
| Survives IL2CPP build | | |
| Reconnect works | | |
| Package maintained | | |

---

## Decision criteria

Latency is **not** the deciding factor. A party game in one room does not care
about a few milliseconds, and loopback numbers cannot separate the two anyway.

Weigh:

| Criterion | Why it matters here |
|---|---|
| Ordering reliability | Sequence numbers are the authority; a transport must not reorder or duplicate |
| Reconnect reliability | Phones sleep, wander and drop; `GAME_RULES_LOCKED.md` §20 makes reconnect a first-class concern |
| **Unity integration** | The Host display is Unity; a transport Unity cannot use reliably is disqualifying |
| Implementation complexity | The raw adapter hand-rolls request/response; that cost recurs in every client |
| Debugging | Plain frames are readable in devtools; Socket.IO's Engine.IO framing is not |
| Browser reliability | iOS and Android Safari/Chrome, backgrounded tabs |
| LAN experience | Must work with no internet (`ARCHITECTURE.md` §9) |
| Online experience | Proxies, mobile data, captive portals |
| Maintenance burden | Socket.IO is a dependency with its own release cycle; `ws` is thinner |

**A meaningful performance difference must be demonstrated on real devices
before it outweighs simplicity and Unity compatibility.**

---

## Known limitations of the current results

1. **Loopback only.** No physical network. Sub-millisecond RTT is an artefact.
2. **Synthetic clients are Node, not phones.** No radio, no power management,
   no mobile browser quirks.
3. **No cloud measurements.** None invented.
4. **No Unity measurements.** No Editor on this machine.
5. **Same-machine buzzer fairness is not representative.** All clients share one
   loopback path with no contention.
6. **Socket.IO is pinned to `transports: ['websocket']`.** Its HTTP long-polling
   fallback is deliberately disabled so the comparison is WebSocket-to-WebSocket.
   That fallback is a genuine Socket.IO advantage on hostile networks and is
   **not** represented in these numbers.

---

## Current status

**The transport decision is OPEN.**

Both adapters are implemented, tested and behave identically on local
measurements. What is missing is the evidence that would actually differentiate
them: real phones on real Wi-Fi, cloud behaviour, and Unity integration.
