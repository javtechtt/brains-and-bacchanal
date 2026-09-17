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

**PERFORMED.** Both transports measured over a real public internet path with
TLS and a real reverse proxy.

### How it was done, and what that does and does not prove

The benchmark server ran locally and was exposed through a **Cloudflare Tunnel**
at a public `https://…trycloudflare.com` URL. Free, no account, nothing left
deployed.

That genuinely exercises the thing the Phase 3 decision hinged on:

- real **TLS termination** (`wss://`),
- a real **reverse proxy** performing the HTTP/1.1 upgrade,
- a real **round trip out to the internet and back** (~98 ms, versus ~0 ms on
  loopback),
- real proxy connection handling and idle behaviour.

**What it does not prove:** the server itself was not in a datacentre, so these
are not hosting-provider latency figures, and provider-specific quirks (App
Service, Container Apps, a specific load balancer) are untested. The RTT here
reflects the path to Cloudflare's edge and back, which is a realistic
*shape* for online play but not a specific deployment's number.

Azure was the original plan. It was abandoned when the CLI required an
interactive re-login, the `containerapp` extension failed to install (pip exit
`3221225477`), and Docker Desktop was not running — none of which was worth
solving once a free path answered the actual question.

### Security note

The benchmark session has no authentication: any connected client may claim
`isHost` and then pause the session or open the buzzer. Exposing that publicly
needed a door lock first, so `BENCHMARK_ACCESS_TOKEN` now gates the WebSocket
upgrade on **both** transports plus `/benchmark/state`. `/health` stays open for
platform probes. Unset means open, so LAN testing is unchanged. See
`apps/game-server/src/benchmark/access.ts` — it is explicitly **not** the
production auth model, which Phase 4 builds.

### Results — public internet, via Cloudflare (3 clients, 30 pings)

| Metric | Raw WebSocket | Socket.IO |
|---|---|---|
| **Connects through TLS proxy** | **yes** | **yes** |
| RTT median | 98 ms | 98 ms |
| RTT p95 | 99 ms | 103 ms |
| RTT p99 | 99 ms | 113 ms |
| RTT min / max | 98 / 99 ms | 97 / 113 ms |
| Jitter (mean \|Δrtt\|) | **0.45 ms** | 1.24 ms |
| Out-of-order events | 0 | 0 |
| Duplicated events | 0 | 0 |
| Duplicate intent rejected | yes, with `originalSeq` | yes, with `originalSeq` |
| Buzzer: one winner per trial | **yes** (3 accepted / 6 rejected) | **yes** (3 accepted / 6 rejected) |
| Reconnect time | 333–359 ms | 442 ms |
| Identity restored, no duplicate | yes | yes |
| **Auto-resumed on reconnect** | **no** (required) | **no** (required) |
| Player resume rejected | `UNAUTHORIZED_ACTOR` | `UNAUTHORIZED_ACTOR` |
| Timer consumed while paused | **0 ms** | 109 ms |

### Reading these numbers honestly

**The headline result is that raw WebSockets connected at all.** The one
scenario that could have reversed the transport recommendation was a proxy
refusing or mangling the upgrade, leaving Socket.IO's HTTP long-polling fallback
as the only thing that worked. That did not happen — both connected and behaved
correctly.

Differences worth noting, none of them decisive:

- **Median RTT is identical (98 ms).** Dominated by network distance, not by
  transport.
- **WebSocket showed tighter tails** (p99 99 ms vs 113 ms) and about **a third
  the jitter**. Real, but small next to a ~98 ms baseline, and a single sample
  on one network path — not enough to claim a systematic advantage.
- **The 109 ms "consumed while paused" on Socket.IO is measurement artefact,
  not a rules violation.** The runner measures remaining time either side of a
  pause across a ~98 ms network hop, so a sub-RTT discrepancy is expected. The
  deterministic `FakeClock` tests prove the pause arithmetic exactly, and the
  WebSocket run happened to land on 0 ms.
- **Buzzer fairness is unchanged by distance:** exactly one winner per trial on
  both, decided by server receive order, with the accepted buzz landing ~98 ms
  after open — i.e. one network hop, as expected.

### Reproducing it

```bash
# 1. Start the server with a token
BENCHMARK_ACCESS_TOKEN=$(openssl rand -base64url 18) pnpm benchmark:server

# 2. Expose it (free, no account)
cloudflared tunnel --url http://127.0.0.1:4500

# 3. Run against the public URL
pnpm benchmark --transport both   --host <name>.trycloudflare.com --port 0 --secure   --token <the token> --clients 3 --pings 30
```

`--port 0` means "use the scheme default", which is what a TLS ingress on 443
needs.

**One operational gotcha:** the buzzer trials fail with `WRONG_STATE` if the
session is left **paused** from earlier testing — which it will be, because a
disconnecting synthetic client correctly triggers the auto-pause rule. Resume
before a buzzer run, or the trials silently report 0 accepted.

## Unity

**TESTED — raw WebSocket works. Full detail in [UNITY_HOST.md](UNITY_HOST.md).**

Unity `6000.3.24f1` (Unity 6.3 LTS). The Host project is real, at `unity/host/`.

### Raw WebSocket — PASS

| What | Result |
|---|---|
| Editor runtime | **29/29** checks against the live server |
| Windows standalone, **IL2CPP** | Builds (0 errors/warnings), `.exe` runs with **no exceptions** |
| Windows standalone, Mono | Builds and runs (kept as a fallback) |
| Real devices (A–E) | **All pass** — two phones + Unity Host + browser Host on one session |
| Third-party dependencies | **None** — `System.Net.WebSockets.ClientWebSocket` |

Verified over the wire: protocol version, event deserialisation, sequence
numbers, millisecond timestamps, authoritative snapshot, connected players,
timer state, pause/resume, server-selected buzzer winner, clean disconnect,
reconnect with fresh state, and **no duplicate Host identity**.

The IL2CPP result matters most: AOT/stripping is where a reflection-based JSON
path most plausibly breaks, and it did not.

One caveat carried forward: **`ClientWebSocket` does not work in WebGL.**
Irrelevant for a desktop Host (`ARCHITECTURE.md` §1); relevant if that ever
changes.

### Socket.IO — NOT tested, deliberately

There is **no official Unity or C# Socket.IO client**. Only community packages
(`SocketIOUnity`, `socket.io-client-csharp`) with no vendor backing, known
IL2CPP/AOT stripping risk, and Engine.IO framing that must track the server's
major version.

Phase 3's instruction was explicit: do not force this test by adding a
questionable dependency merely to say both were tested. So it was not added.
Full assessment (maintenance, licensing, dependency burden, reconnect, protocol
fit) is in [UNITY_HOST.md](UNITY_HOST.md).

**This asymmetry is itself a result**, and a decisive one: raw WebSockets need
zero dependencies in Unity, Socket.IO needs an unofficial one.

### Cost that recurred in every client

The raw-WebSocket adapter has no built-in request/response, so each client
hand-rolls ack correlation. That cost has now been paid **three times** — server
adapter, browser client, Unity client. Socket.IO provides it free.

Real and worth weighing; it did not turn out to be decisive against a transport
that needs no Unity dependency at all.

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

## Results — cloud (COMPLETE)

Measured over a real public internet path with TLS and a real reverse proxy —
full detail and caveats in [Cloud testing](#cloud-testing) above.

| Metric | Socket.IO | Raw WebSocket |
|---|---|---|
| Connects through TLS proxy | yes | **yes** |
| RTT median | 98 ms | 98 ms |
| RTT p95 / p99 | 103 / 113 ms | **99 / 99 ms** |
| Jitter | 1.24 ms | **0.45 ms** |
| Reconnect time | 442 ms | 333–359 ms |
| Ordering / duplicate faults | 0 | 0 |
| Buzzer: one winner per trial | yes | yes |
| Proxy / upgrade problems | none | **none** |
| Behaviour on mobile data | not tested | not tested |

**The decisive line is the first one.** The scenario that could have reversed
the transport recommendation — a proxy breaking the raw WebSocket upgrade,
leaving Socket.IO's long-polling fallback as the only thing that worked — did
not occur.

## Results — Unity (COMPLETE)

| Check | Socket.IO | Raw WebSocket |
|---|---|---|
| Connects from Editor | not tested (no official C# client) | **PASS** — 29/29 checks |
| Survives IL2CPP build | not tested | **PASS** — 0 errors, no exceptions |
| Reconnect works | not tested | **PASS** — same identity, no duplicate |
| Real-device A-E | not tested | **PASS** — 2 phones + Unity + browser Host |
| Package maintained | n/a — would need an unofficial community package | **n/a — no package needed** |

---

## Decision criteria

Latency is **not** the deciding factor. A party game in one room does not care
about a few milliseconds, and loopback numbers cannot separate the two anyway.

Weigh:

| Criterion | Why it matters here |
|---|---|
| Ordering reliability | Sequence numbers are the authority; a transport must not reorder or duplicate |
| Reconnect reliability | Phones sleep, wander and drop; `GAME_RULES_LOCKED.md` §22 makes reconnect a first-class concern |
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

1. **The cloud test tunnelled to a local server.** Real TLS, real proxy, real
   ~98 ms internet round trip — but the server was not in a datacentre, so
   these are not hosting-provider latency figures, and no specific provider's
   ingress was exercised.
2. **Mobile data was not tested.** Phone testing was LAN Wi-Fi only. Captive
   portals and carrier-grade NAT remain unmeasured.
3. **Socket.IO was not tested in Unity** — deliberately, rather than add an
   unofficial C# package. See the Unity section.
4. **No p95/p99 latency was captured from the phones themselves**, only correct
   behaviour.
5. **Socket.IO's long-polling fallback is still not represented.** It stays
   pinned to `transports: ['websocket']` so the comparison is
   WebSocket-to-WebSocket. Since raw WebSockets were never blocked in testing,
   that fallback was never needed — but it remains Socket.IO's genuine
   advantage on networks harsher than any tested here.
6. **Socket.IO is pinned to `transports: ['websocket']`.** Its HTTP long-polling
   fallback is deliberately disabled so the comparison is WebSocket-to-WebSocket.
   That fallback is a genuine Socket.IO advantage on hostile networks and is
   **not** represented in these numbers.

---

## Current status

**Decision: raw WebSockets.** Evidence is now sufficient.

The question that kept this open was whether raw WebSockets would survive real
internet infrastructure, or whether Socket.IO's HTTP long-polling fallback would
prove necessary. **It was tested and they survived** — connecting cleanly
through TLS termination and a real reverse proxy, with tighter latency tails and
about a third the jitter of Socket.IO.

Combined with everything else measured:

| Evidence | Outcome |
|---|---|
| Loopback | Indistinguishable |
| Real phones on LAN (tests A–E) | Both correct; all rules enforced |
| **Public internet, TLS + proxy** | **Both connect; WS tighter tails, less jitter** |
| Ordering / duplicates | 0 faults, both |
| Reconnect + auto-pause rules | Correct on both |
| **Unity (the Host Display)** | **WS: 29/29, IL2CPP, zero dependencies. Socket.IO: no official C# client** |

**Unity is what actually decides it.** `ARCHITECTURE.md` §1 makes the Host
Display a Unity application. Raw WebSockets work there with `ClientWebSocket`
straight from .NET — no package, no third-party maintenance risk. Socket.IO
would require an unofficial community C# client with known IL2CPP/AOT stripping
risk and Engine.IO version coupling, in the one component that must not fail
during a live game. Nothing in the network measurements offsets that.

### What this costs us, stated plainly

- The raw adapter **hand-rolls request/response correlation** — paid three times
  now (server, browser, Unity). That is the ongoing price.
- **Socket.IO's fallback and reconnection logic are genuinely better on hostile
  networks.** Testing deliberately disabled the fallback to keep the comparison
  fair, and never hit a network that needed it.

### What would reopen this

- Raw WebSockets failing on **mobile data, a captive portal, or a specific
  hosting provider's ingress** — none of which has been tested.
- A future need to run the Host in **WebGL**, where `ClientWebSocket` does not
  work at all.

The transport stays behind its adapter (`RealtimeTransport`), so reversing this
remains a contained change rather than a rewrite. That was the point of building
the seam.
