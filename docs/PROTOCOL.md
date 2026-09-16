# Brains & Bacchanal — Protocol

The shared language of the game server, the player/admin web app and the Unity
host display.

Source of truth: `packages/protocol`. This document explains it; the code
defines it.

## Scope

Phase 2 defined the **envelopes**. Phase 4 adds the first concrete messages that
travel in them: the production lobby — rooms, players, teams and reconnect.
They are specified in **`docs/LOBBY.md`** and listed under
[Phase 4 messages](#phase-4-messages-lobby) below.

Phase 5 adds the **generic game** messages: starting a game, the BB ledger,
generic challenges, turn ownership, timers, Host rulings and the split
Host/player game snapshots. They are specified in **`docs/GAME_ENGINE.md`** and
listed under [Phase 5 messages](#phase-5-messages-game-engine) below.

Round-specific intents (`PLAY_CARD`, `PURCHASE_ITEM`, `BUZZ`, …) are still
**not** defined. They belong to the phases that implement those behaviours, and
several depend on rules still open in `OPEN_RULES.md`.

## Transport independence

Nothing in `packages/protocol` imports Socket.IO, `ws`, the browser WebSocket
API, Next.js, React or any Unity type. The protocol describes **messages, not
how they travel**.

This is a hard constraint, not a preference. `CLAUDE.md` requires a measured
comparison between Socket.IO and raw WebSockets in Phase 3, and
`ARCHITECTURE.md` §7 lists what that comparison must measure. Binding the
protocol to a transport now would make that measurement pointless.

## Authority model

`ARCHITECTURE.md` §4:

```text
Client  ──intent──▶  Server  ──event──▶  Clients
```

- A client **asks**. It never reports an outcome.
- The server **decides**, then states what happened.
- A client that believes it won, buzzed first, or earned BB is describing a
  hope, not a fact.

The Host rules on subjective matters — whether a spoken answer was valid, who
spoke first, who won a physical game. Those rulings still travel as intents and
are recorded as events, so every ruling is auditable afterwards.

## Protocol version

```ts
export const PROTOCOL_VERSION = 1;
export function isSupportedProtocolVersion(version: number): boolean;
```

A single integer, so it survives the TypeScript → C# boundary without parsing
rules.

Bump it when a change would break an older client: a removed field, a changed
field meaning, or a changed envelope shape. Additive optional fields do not
require a bump.

Compatibility is **exact match only**. There is no negotiation and no
compatibility window — the roadmap does not call for one, and a speculative
scheme would be an abstraction built for an imagined future. The check lives in
one function so a later phase can widen the policy in a single place.

An incompatible client is rejected with `UNSUPPORTED_PROTOCOL_VERSION`.

## Intent envelope

Client → server.

| Field | Type | Notes |
|---|---|---|
| `protocolVersion` | `number` | Rejected if unsupported |
| `intentId` | `IntentId` | Idempotency key |
| `roomId` | `RoomId` | |
| `sessionId` | `SessionId?` | Absent on a first join |
| `type` | `string` | |
| `payload` | `unknown` | Type-specific |

**There is no client timestamp field, deliberately.** `ARCHITECTURE.md` §6 says
a client's claimed time is never the deciding time, so the protocol offers
nowhere to put one.

`isIntentEnvelope(value)` validates shape at runtime. Types vanish at runtime
and intents arrive from phones over a network, so the server does not trust the
shape of anything a client sends.

## Event envelope

Server → clients. An authoritative statement of fact.

| Field | Type | Notes |
|---|---|---|
| `protocolVersion` | `number` | |
| `seq` | `SequenceNumber` | Monotonic per room |
| `serverTime` | `ServerTimestamp` | Authoritative |
| `roomId` | `RoomId` | |
| `actor` | `Actor` | Who caused it |
| `type` | `string` | |
| `payload` | `unknown` | |
| `causedBy` | `IntentId?` | The intent that produced it |

By the time a client sees an event, the server has already committed the change.

### Actors

```ts
type Actor =
  | { kind: 'server' }
  | { kind: 'host';   sessionId }
  | { kind: 'player'; sessionId; playerId }
  | { kind: 'admin';  sessionId };
```

`admin` is **not** `host`. Host authority is checked with `isHostActor`, and
admin does not pass it.

## Sequence numbers

- Assigned only by the server, only in `EventLog.append`.
- Monotonic within a room, starting at 1.
- A **rejected intent consumes no sequence number.**
- A gap tells a client it missed an event and should request a snapshot or
  replay from `eventsSince`.

## Timestamps

Every event carries `serverTime`, taken from the server's injected `Clock`.
Client clocks are never consulted, never trusted, and have nowhere to be sent.

## Idempotency

State-changing intents carry an `intentId`.

Why it matters: phones on weak Wi-Fi retry. A player who taps "buy" and sees
nothing happen taps again. Without deduplication the team spends BB twice for
one purchase.

Rules:

- A repeated `intentId` is rejected with `DUPLICATE_INTENT` and the original
  outcome stands. Its `details.originalSeq` names the event the first attempt
  produced.
- Deduplication happens **before** rule evaluation, so a retry is never
  re-judged against rules whose answer may since have changed.
- A **rejected** intent is not recorded, so retrying it is allowed — it was
  never applied.

In-memory and per-room, per `ARCHITECTURE.md` §8. Database-backed idempotency
is not needed yet.

## Rejections

```ts
interface Rejection {
  code: RejectionCode;
  message: string;
  details?: Record<string, string | number | boolean>;
}
```

A UI must be able to react without parsing prose, so `code` carries the meaning
and `message` is for humans and logs.

| Code | Meaning |
|---|---|
| `INVALID_REQUEST` | Malformed envelope or failed validation |
| `UNSUPPORTED_PROTOCOL_VERSION` | Incompatible client |
| `DUPLICATE_INTENT` | Already accepted; original outcome stands |
| `ILLEGAL_ACTION` | Well-formed but not permitted by the rules |
| `WRONG_STATE` | Not valid from the current phase |
| `UNAUTHORIZED_ACTOR` | Actor lacks authority |
| `NOT_FOUND` | Unknown room, player, team or challenge |
| `CONFLICT` | Lost a race |
| `INTERNAL_ERROR` | Server fault |

The set is deliberately small and generic. There are **no game-specific codes**
— no `CARD_NOT_LEGAL`, no `INSUFFICIENT_BB`. Those belong to the phases that
implement those systems. `details` is the extension point until then.

**Content safety:** a rejection explains why an action failed, never what the
right answer was.

## Snapshots

```ts
interface StateSnapshot {
  protocolVersion, seq, takenAt,
  room, players, teams, challenge
}
```

A client that has just connected, or that detected a sequence gap, replaces its
local state with one of these and then applies only events with `seq` greater
than the snapshot's.

**A snapshot carries no game content.** `ChallengeState` holds a `configRef`,
not question text, accepted answers or board labels. Per `CONTENT_POLICY.md`,
"player browsers must never receive future/unrevealed answer payloads."

Phase 2 defines the shape. Delivering it over a wire is Phase 3+.

## Phase 4 messages (lobby)

Full behaviour is in `docs/LOBBY.md`; this is the protocol-level summary.

**Intents**

| Intent | Sender | Notes |
|---|---|---|
| `CREATE_ROOM` | Unity Host | Needs no existing room |
| `JOIN_ROOM` | phone | Addressed by room **code** |
| `RECONNECT_PLAYER` | phone | `playerId` + reconnect credential |
| `RECONNECT_HOST` | Unity Host | `hostToken` |
| `LEAVE_ROOM` | phone | Deliberate; destroys membership |
| `REQUEST_LOBBY_SNAPSHOT` | any | **Read-only** |
| `HOST_SET_TEAM_MODE` | Host | 2 or 3 |
| `HOST_ASSIGN_PLAYER_TEAM` | Host | |
| `HOST_UNASSIGN_PLAYER` | Host | |
| `HOST_REMOVE_PLAYER` | Host | |
| `HOST_LOCK_TEAMS` | Host | |
| `HOST_UNLOCK_TEAMS` | Host | |
| `HOST_CLOSE_ROOM` | Host | |

**Events**: `PLAYER_JOINED`, `PLAYER_RECONNECTED`, `PLAYER_DISCONNECTED`,
`PLAYER_LEFT`, `PLAYER_REMOVED`, `TEAM_MODE_CHANGED`,
`TEAM_ASSIGNMENT_CHANGED`, `TEAMS_LOCKED`, `TEAMS_UNLOCKED`, `ROOM_CLOSED`,
`HOST_CONNECTION_CHANGED`, `CONNECTION_SUPERSEDED`.

### `NO_ROOM_ID`

`roomId` is required and non-empty, but `CREATE_ROOM` has no room yet and
`JOIN_ROOM` knows only a code. Both send the placeholder `"pending"`.

Naming the case beats the alternatives: relaxing the envelope would let a
genuinely missing `roomId` through *everywhere else*, and letting each client
invent its own placeholder would leave the server guessing.

### Reads return state in the acknowledgement

`REQUEST_LOBBY_SNAPSHOT` consumes **no sequence number** and emits **no event**.

This preserves what a sequence number means — an accepted change to shared state
— so a gap still reliably means "you missed something". Phase 3 briefly did the
opposite and idle Unity clients inflated the sequence by ~10 every 5 seconds.

### Transient events

`CONNECTION_SUPERSEDED` is addressed to **one** connection, carries the current
sequence number, and never enters history. It reports that a socket is about to
be closed, which changed nothing about the room; numbering it would create a gap
in every other client's stream describing a non-event.

### Credentials never travel on a broadcast

A reconnect credential and the `hostToken` appear **only** in the acknowledgement
to the one connection that earned them. They are absent from every event payload
and every snapshot — `toPublicPlayer` is the only route from server state to a
client, and it strips the secret.

## Phase 5 messages (game engine)

Full behaviour is in `docs/GAME_ENGINE.md`; this is the protocol-level summary.

**Intents** — every one is Host-only except the read.

| Intent | Notes |
|---|---|
| `START_GAME` | Requires locked teams. Seeds 1,000 BB per team |
| `HOST_ADVANCE_PHASE` | Legality comes from `lifecycle.ts`, not the intent |
| `HOST_PREPARE_CHALLENGE` | Generic `challengeType` + opaque `configRef` |
| `HOST_START_CHALLENGE` | |
| `HOST_SET_TURN` | Team, optionally a player on that team |
| `HOST_SET_ACTIVE_PLAYERS` | What the D-011 auto-pause keys on |
| `HOST_START_TIMER` / `HOST_CANCEL_TIMER` | Caller supplies the duration |
| `HOST_REQUEST_REVIEW` | Hand the challenge to the Host |
| `HOST_RULING` | Subjective judgment; recorded, never re-judged |
| `HOST_RESOLVE_CHALLENGE` | Applies BB **through the ledger** |
| `HOST_PAUSE_GAME` / `HOST_RESUME_GAME` | Resume is Host-only |
| `REQUEST_GAME_SNAPSHOT` | **Read-only**, any client |
| `DEV_ADJUST_BB` | **Development only** — see D-024 |

**Events**: `GAME_STARTED`, `PHASE_CHANGED`, `BB_CHANGED`, `CHALLENGE_PREPARED`,
`CHALLENGE_STARTED`, `CHALLENGE_RESOLVED`, `TURN_CHANGED`,
`ACTIVE_PLAYERS_CHANGED`, `TIMER_STARTED`, `TIMER_CANCELLED`, `TIMER_EXPIRED`,
`HOST_RULING_RECORDED`, `REVIEW_REQUESTED`, `GAME_PAUSED`, `GAME_RESUMED`.

### The snapshot splits in two

Phase 4 had one lobby snapshot because Host and players were entitled to the
same facts. Phase 5 splits it into `HostGameSnapshot` and `PlayerGameSnapshot`.

They are **separate types, not one shape with fields blanked out**, so a future
field has to be placed deliberately on one side or the other. The Host gets the
BB ledger; a player gets their own identity, team, `youAreActive` and `yourTurn`.
Team balances are on both — a party game shows the scores.

Neither has anywhere to put a credential, the Host token, an unrevealed answer, a
hidden Market selection or another team's card hand. The boundary is drawn before
there is anything secret to put on the wrong side of it.

A connection that has not identified itself receives the **player-safe** shape.

### `TIMER_EXPIRED` decides nothing

It reports that a deadline passed and hands the challenge to the Host. Its
payload carries `requiresHostDecision: true` so no client invents a consequence.
A timeout is **not** a wrong answer — D-022.

### One sequence for lobby and gameplay

Gameplay events share the room's `EventLog`, so a client can order a BB change
against a disconnect. D-023.

## Event history

`EventLog` is an in-memory, ordered record of accepted state changes:
sequence number, server timestamp, actor, type, payload, causing intent.

`ARCHITECTURE.md` §5 — "Full event sourcing is not required initially." This is
a readable audit trail, enough to understand how the current state was reached,
not a mechanism for rebuilding the world. Persistence is deferred; §8
recommends PostgreSQL later.

Callers must not pass unrevealed content as a payload. The log stores whatever
it is given.

## C# compatibility

`ARCHITECTURE.md` §3 defines the chain:

```text
schema → TypeScript types → C# DTOs
```

**Current approach: hand-written C# DTOs mirroring `packages/protocol`,
validated by a protocol version assertion at connection time.**

No generator exists, and building one now would be a large system serving a
Unity project that does not yet exist (Phase 8). The protocol is instead kept
*generation-friendly* so a generator can be added later without reshaping it:

- `PROTOCOL_VERSION` is an integer, not a semver string.
- Branded IDs erase to plain `string` / `number` at runtime.
- Unions are discriminated by a literal `kind` or `type` field, which maps
  cleanly to C# polymorphic deserialisation.
- String-literal unions are declared as `as const` arrays, so the permitted
  values are enumerable at runtime and can be emitted as C# enums.
- No TypeScript-only constructs (conditional types, mapped types, template
  literal types) appear in any wire-facing shape.

Revisit when the Unity project is created.
