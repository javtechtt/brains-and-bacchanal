# Brains & Bacchanal — Lobby, Rooms, Players & Teams

Phase 4. How a party actually starts: a Host creates a room, phones scan a code,
the Host builds teams, and teams lock.

> **Status: implemented.** The lobby ends at a locked set of teams. Starting a
> game from there is Phase 5 — see `docs/GAME_ENGINE.md`.

---

## ⚠ Rooms do not survive a server restart

**Room storage is in memory only. Restarting the game server destroys every
active room — every room code, every player, every team assignment and every
reconnect credential.**

There is no file, no database, no recovery. If the server restarts mid-party,
the Host creates a new room and everyone re-scans. Phones will show their saved
identity being rejected and fall back to the join screen, which is the correct
behaviour, but it is still a re-join for everyone.

This is deliberate for Phase 4 (spec §27: do not add Redis or distributed
sessions yet). `RoomStore` in `packages/game-rules/src/room-store.ts` is the seam
where durable storage goes; `ARCHITECTURE.md` §8 nominates PostgreSQL/Neon.

---

## The room model

| Field | Meaning |
|---|---|
| `roomId` | Internal identifier. A UUID. Never shown to players. |
| `roomCode` | Short public code, e.g. `BX7K`. What people read and type. |
| `status` | `OPEN` → `LOCKED` → `CLOSED` |
| `teamMode` | `2` or `3` |
| `teamsLocked` | Whether assignments are frozen |
| `hostConnected` | Whether a Host connection is attached |

**`roomId` and `roomCode` are separate and neither is derived from the other.**
Deriving the code from the id would leak an internal identifier to anyone who can
read a screen; deriving the id from the code would make ids guessable.

### Room status vs game phase

`RoomStatus` is not `GamePhase`. The room's status answers "can a phone still
join?"; the game phase answers "what is the game doing?". Merging them would make
room closure depend on gameplay state, which is exactly the coupling that makes
lobbies fragile later.

---

## Room codes

Four characters from a 24-character alphabet — **390,625 combinations**, checked
for uniqueness against *active* rooms only, so codes recycle when rooms close.

```
ABCDEFGHJKMNPQRTWXY346789
```

Excluded, and why — this is about the failure that actually costs time at a
party, someone typing the code wrong three times while everyone waits:

| Removed | Confused with |
|---|---|
| `O` `0` | each other, in almost every font |
| `I` `1` `L` | each other, especially condensed fonts |
| `S` `5` | each other, particularly read aloud |
| `U` `V` | each other, in several display faces |
| `Z` `2` | each other, in handwriting |

Input is **case-insensitive** and confusables are **folded to what the reader
meant**: someone shown `QX7K` who types `0X7K` or `OX7K` gets `QX7K`, which is
unambiguous precisely because neither `O` nor `0` is in the alphabet. Spaces and
dashes are stripped.

---

## Join URL and QR code

```
http://<host>:3000/join/<ROOMCODE>
```

The code sits in the **path**, not a query string: it survives copy-paste and
link previews better, and reads naturally aloud as a fallback.

**No IP address is ever hardcoded.** The server takes `PUBLIC_BASE_URL` when set,
otherwise detects a LAN address at startup, so a local party needs no
configuration and a DHCP change cannot silently break the QR code. The browser
derives the server URL from the page's own origin — the address that
demonstrably reached that phone.

### The QR encoder

`unity/host/Assets/Scripts/Util/QrCode.cs` is a hand-written encoder (byte mode,
EC level M, versions 1–10). Unity ships none, and D-014 deliberately avoids
third-party C# packages in the Host.

**It is verified by decoding, not by looking at it.** `tools/qr-verify/` renders
the output and decodes it with OpenCV: **307/307 correct** across symbol sizes
21–37. Three real bugs were caught that way, all invisible to inspection:

1. Format-information bits 6 and 7 in the wrong modules — **every code
   unreadable**.
2. Mask penalty rule 3 matching in only one orientation, selecting weaker masks.
3. **Mask 2 excluded.** Its vertical stripes produce spec-valid codes that
   OpenCV fails to decode ~6.5% of the time. Confirmed as a decoder-population
   problem, not an encoder fault, by forcing an independent reference encoder to
   mask 2 and watching it fail identically. Mask choice is a robustness
   heuristic, not a correctness requirement, so the trade is easy.

---

## Identity

Four separate things, deliberately:

| | Stable? | Secret? | What it is |
|---|---|---|---|
| `playerId` | **yes**, for the room's life | no | The identity everything keys on |
| `displayName` | no | no | A label. **Never** identity |
| `connectionId` | no — new every socket | no | One physical socket |
| `reconnectToken` | yes | **yes** | Proof of "I am this player" |

**Duplicate display names are allowed and harmless**, because nothing is ever
keyed on a name. Two players called "Javal" are distinct `playerId`s.

Names are trimmed, internal whitespace collapsed, control characters stripped
(invisible characters can spoof another player's name), and capped at 20
characters. No profanity filtering — out of scope, and this is a party game
among friends.

### Reconnect credentials

32 bytes of CSPRNG output, base64url, minted per player and scoped to the room.

- **`playerId` alone is never accepted.** Every client in the room can see every
  `playerId` in a snapshot, so accepting one as proof would let anyone
  impersonate anyone.
- Compared in **constant time**, so the time a comparison takes cannot reveal how
  many leading characters were right.
- **Unknown player and wrong credential return an identical rejection**, so the
  set of valid `playerId`s cannot be probed.
- Never broadcast, never in an event payload, never in a snapshot. The only route
  from server state to a client is `toPublicPlayer`, which strips it.
- Stored in the browser's `localStorage`, keyed by room code. A credential is a
  bearer token for a party lobby, not a bank session; the exposure is that
  someone holding your unlocked phone could rejoin as you, which is already true
  of the phone.

The Host holds an equivalent `hostToken`, returned **once** to the creating
connection.

---

## Host authority

Authority comes from the **connection's verified role**, never from anything in
a payload.

```
CREATE_ROOM / RECONNECT_HOST  →  credential checked  →  connection marked host
every Host-only intent        →  is this connection host?  →  act or reject
```

Sending `isHost: true`, `role: "host"` or a forged `actor` changes nothing,
because **no code path reads such a field**. There is one gate, `#requireHost`,
and it consults only the connection's resolved role.

Host-only: set team mode, assign/unassign a team, remove a player, lock/unlock
teams, close the room.

---

## Stale and duplicate connections

**Policy: the newest authenticated connection wins.**

When a valid reconnect arrives for a player who already has a socket:

1. The new connection becomes authoritative.
2. The old one receives `CONNECTION_SUPERSEDED` and is **closed by the server**.
3. The old one can no longer act — its role is cleared, so its intents are
   rejected as unauthorised.

This is what makes "lock the phone, unlock it, keep playing" work without waiting
for a timeout and without duplicating the player. A second browser tab takes over
rather than competing; the displaced tab is told why instead of appearing frozen.

**Late close events are ignored.** If a displaced socket's `close` arrives after
the new one is established — normal on a flaky phone connection — it does not
mark the player disconnected, because the server checks that the closing socket
is still the current one.

---

## Leave vs disconnect

These are opposites and are never conflated.

| | `LEAVE_ROOM` | Socket dropped |
|---|---|---|
| Membership | **destroyed** | preserved |
| Team | cleared | **preserved** |
| Credential | **invalidated** | preserved |
| Can return? | no — must join as a new player | **yes**, same player, same team |

Leaving destroys the player record, which invalidates the credential *by
construction* — there is nothing left to authenticate against. Host removal works
the same way, so a removed player cannot reconnect back in.

### Lobby disconnects do not pause anything

D-011 auto-pauses gameplay when an active player disconnects. **That rule does
not apply in the lobby**, because there is no gameplay to pause.

**Phase 5 wired it for the real game.** Once a game is running, an *active*
player's disconnect pauses automatically and freezes the timer; a non-active
player's does not, and a lobby disconnect still does not. See
`docs/GAME_ENGINE.md`.

---

## Teams

Stable IDs `TEAM_A`, `TEAM_B`, `TEAM_C`; the labels "Team A" etc. are
presentation only and Phase 8 may rename them freely.

A player belongs to **at most one team** — assignment replaces, and there is no
add-to-team operation that could leave someone on two.

### Changing 3 → 2 with players in Team C

**Refused**, naming how many players are in the way. Silently reassigning them is
the kind of thing nobody notices until the game has started and someone is on the
wrong team. The Host moves them deliberately, then changes the mode.

### Locking

Rejected if any participating team has **zero players**.

**Team sizes are NOT checked.** Uneven teams are explicitly acceptable and no
locked rule requires balance, so requiring it would be inventing a rule.

After locking: assignments rejected, mode changes rejected, new joins rejected.
Reconnecting does not unlock. Disconnecting does not unlock.

`HOST_UNLOCK_TEAMS` exists — not in the original spec list, but `TEAM_LOCK →
LOBBY` is already a legal phase transition for exactly this reason: the Host
spots a wrong team before starting. Without it, one misclick would strand a room.

---

## Snapshots

There is **one** lobby snapshot shape, because at this stage the Host and players
are entitled to the same facts: who is here, which team they are on, whether
teams are locked. What differs is what each may *do*, and that is enforced on
intents rather than by hiding state.

Per-recipient fields are `you` (which listed player you are) and `isHost`.
Neither is a secret.

**Phase 5 split it.** The lobby snapshot stays as it is; the *game* snapshot is
two separate types, `HostGameSnapshot` and `PlayerGameSnapshot`. The split landed
before there was anything secret to put on the wrong side of it, which is the
point — a Phase 6 field (a card hand, a hidden Market basket) now has to be
placed deliberately. See `docs/GAME_ENGINE.md`.

No snapshot ever contains a reconnect credential or the Host token.

---

## Capacity

**Default 24 players**, configurable via `GAME_SERVER_ROOM_CAPACITY`.

Sized for the game, not for a limit's own sake: three teams of eight is already a
very large party, and the Host has to be able to read the list on a TV. A full
room rejects new joins cleanly while existing players and reconnects keep working.

A server-wide cap of 50 simultaneous rooms guards against unbounded memory growth.

---

## Protocol

**Intents** (client → server)

| Intent | Who | Notes |
|---|---|---|
| `CREATE_ROOM` | Unity Host | Only intent needing no existing room |
| `JOIN_ROOM` | phone | By room **code** |
| `RECONNECT_PLAYER` | phone | `playerId` + credential |
| `RECONNECT_HOST` | Unity Host | `hostToken` |
| `LEAVE_ROOM` | phone | Deliberate exit |
| `REQUEST_LOBBY_SNAPSHOT` | any | **Read-only** |
| `HOST_SET_TEAM_MODE` | Host | 2 or 3 |
| `HOST_ASSIGN_PLAYER_TEAM` | Host | |
| `HOST_UNASSIGN_PLAYER` | Host | |
| `HOST_REMOVE_PLAYER` | Host | |
| `HOST_LOCK_TEAMS` | Host | |
| `HOST_UNLOCK_TEAMS` | Host | |
| `HOST_CLOSE_ROOM` | Host | |

**Events** (server → clients): `PLAYER_JOINED`, `PLAYER_RECONNECTED`,
`PLAYER_DISCONNECTED`, `PLAYER_LEFT`, `PLAYER_REMOVED`, `TEAM_MODE_CHANGED`,
`TEAM_ASSIGNMENT_CHANGED`, `TEAMS_LOCKED`, `TEAMS_UNLOCKED`, `ROOM_CLOSED`,
`HOST_CONNECTION_CHANGED`, `CONNECTION_SUPERSEDED`.

### `NO_ROOM_ID`

`IntentEnvelope.roomId` is required and non-empty, but `CREATE_ROOM` has no room
yet and `JOIN_ROOM` knows only a code. Both send the placeholder `"pending"`.
Naming the case beats relaxing the envelope — which would let a genuinely missing
`roomId` through everywhere else — or letting each client invent its own.

### Reads emit nothing

`REQUEST_LOBBY_SNAPSHOT` returns state **in the acknowledgement**: no sequence
number, no broadcast. This preserves the meaning of the sequence — a number is
issued only for an accepted change to shared state, so a gap still means "you
missed something". (Phase 3 shipped the opposite briefly, and idle Unity clients
inflated the sequence by ~10 every 5 seconds.)

`CONNECTION_SUPERSEDED` is likewise **transient**: addressed to one socket,
numbered with the current sequence, never entering history, because it describes
nothing that changed in the room.

---

## Transport

**Raw WebSockets**, per D-014, at `/room/ws`.

Socket.IO is not imported by the production room service at all. It stays
installed for the benchmark, which is separate infrastructure kept intact.
**There is no transport selector on any production page** — that comparison
served Phase 3 and belongs to the benchmark pages.

The room path is deliberately **not** gated by the benchmark's dev access token:
a guest scanning a QR code has no shared secret, and requiring one would make the
game unjoinable. Authority is proved *after* connecting, by credential.

---

## Real-device results

**The Phase 4 lobby was tested on real hardware and PASSED.**

Windows IL2CPP standalone Unity Host + two physical phones on the LAN, against
the compiled game server and the production web build.

| Step | Result |
|---|---|
| Unity Windows Host launched | **PASS** |
| Create Room | **PASS** |
| Room code displayed | **PASS** |
| **QR scanned with a real phone camera** | **PASS** |
| QR opened the correct `/join/<CODE>` | **PASS** |
| Phone 1 joined | **PASS** |
| Phone 2 joined | **PASS** |
| Both players listed in Unity | **PASS** |
| Host assigned Phone 1 → Team A | **PASS** |
| Host assigned Phone 2 → Team B | **PASS** |
| **Both phones updated live** with their team | **PASS** |
| Lock Teams | **PASS** |
| Phone screen locked, then unlocked | **PASS** — reconnected, **same identity**, **same team**, **no duplicate** |
| Other phone's browser refreshed | **PASS** — restored automatically, no name prompt |

This is the criterion the phase hinged on: §30 says a QR is not proven by
generating an image, and §29 says Phase 4 is not complete without the physical
run. Both are now satisfied on real devices.

### Covered without another physical run

The remaining exit criteria were proven over **real WebSockets against the
running compiled server**, because they exercise the same server code paths the
phones just exercised, and repeating them by hand would add no information:

| Criterion | Where proven |
|---|---|
| §31C browser close/reopen | `tools/lobby-verify/browser_lobby.py` (real Chromium) |
| §31D leave, old credential refused | browser harness + `reconnect_cases.py` |
| §31E stale connection replacement | `reconnect_cases.py` |
| §33 three-team assign → lock → reconnect | `reconnect_cases.py` |
| 3 → 2 refused while Team C holds players | `reconnect_cases.py` |
| Host removal + removed player cannot return | `reconnect_cases.py` |
| Room closure; joins/reconnects refused after | `reconnect_cases.py` |
| Unity Host reconnect to the SAME room | `HeadlessLobbyCheck` (real Unity client) + `network.test.ts` |
| Displaced Host loses authority | `reconnect_cases.py` |
| Team lock surviving reconnect | `reconnect_cases.py` (2-team and 3-team) |
| Host authority / forged `isHost` | `HeadlessLobbyCheck`, `network.test.ts`, unit tests |
| Room capacity | unit tests (`room.test.ts`) — same code path, smaller constant |

Physical three-team play with three phones has **not** been run by hand. The
three-team flow is proven over real sockets end-to-end; what a third phone would
additionally prove is only that a third handset behaves like the first two.

## LAN test procedure

1. Start the game server: `pnpm --filter @bb/game-server dev`
2. Start the web app: `pnpm --filter @bb/web dev`
3. Launch the Unity Host and press **Create Room**.
4. Check the room code and QR appear.
5. Scan the QR with a phone. It should open `/join/<CODE>` directly.
6. Enter a name and join. The player appears in Unity.
7. Repeat on a second phone.
8. Select a player in Unity, assign a team. The phone updates.
9. Put at least one player on every team, then **Lock Teams**.
10. Lock a phone's screen or turn off its Wi-Fi. Unity shows *Disconnected*.
11. Unlock/reconnect. **Same player, same team, no duplicate.**
12. Refresh a phone's browser. It restores without asking for a name.
13. On a phone, tap **Leave game**, then reload — it must ask for a name again.

**Firewall:** Windows blocks inbound connections to Node on a new network by
default. Allow ports 3000 and 4000 for Private networks, and make sure the
laptop and phones are on the same network (guest Wi-Fi often isolates clients).
