# Brains & Bacchanal — Protocol

The shared language of the game server, the player/admin web app and the Unity
host display.

Source of truth: `packages/protocol`. This document explains it; the code
defines it.

## Scope

Phase 2 defines the **envelopes**, not the messages that travel in them.

Concrete intent types (`JOIN_ROOM`, `PLAY_CARD`, `PURCHASE_ITEM`, `BUZZ`,
`HOST_MARK_VALID`, …) are **not** defined yet. They belong to the phases that
implement those behaviours, and several depend on rules still open in
`OPEN_RULES.md`.

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
