# Brains & Bacchanal — Architecture

## 1. Components

### Player / Admin Web
**Technology**
- Next.js
- React
- TypeScript

**Responsibilities**
- room joining,
- player controller,
- legal action buttons,
- admin/content tools,
- optional browser Host tools.

Not authoritative for gameplay.

### Game Server
**Technology**
- Node.js
- TypeScript

**Responsibilities**
- authoritative room/session state,
- BB ledger,
- timers/deadlines,
- card state,
- Market,
- Maco Mail,
- wagers,
- challenge state,
- pause/resume,
- event ordering,
- reconnect snapshots,
- Host ruling commands.

### Host Display
**Technology**
- Unity
- C#

**Responsibilities**
- game-show presentation,
- Host controls,
- audio,
- animation,
- scores,
- reveals,
- Family Feud board,
- Market/Maco/Card presentation.

Unity renders server state and does not duplicate game rules.

## 2. Repository

```text
brains-and-bacchanal/
├─ CLAUDE.md
├─ START_HERE.md
├─ apps/
│  ├─ web/
│  └─ game-server/
├─ unity/
│  └─ host/
├─ packages/
│  ├─ protocol/
│  ├─ game-rules/
│  └─ ui-tokens/
├─ content/
│  └─ test-only/
├─ docs/
│  ├─ GAME_RULES_LOCKED.md
│  ├─ OPEN_RULES.md
│  ├─ DECISION_LOG.md
│  ├─ ARCHITECTURE.md
│  ├─ DEVELOPMENT_ROADMAP.md
│  ├─ CONTENT_POLICY.md
│  └─ PLAYER_HOST_REFERENCE.md
└─ pnpm-workspace.yaml
```

## 3. Shared Contracts

Use language-neutral schemas where practical:

```text
schema
  ↓
TypeScript types
  ↓
C# DTOs
```

Protocol versioning should be explicit.

## 4. Authority

Clients send intents.

Server validates and emits resulting events.

Never trust a client to directly mutate BB, inventory, timers, or winner state.

## 5. Event Log

Accepted state changes should record:
- sequence number,
- server timestamp,
- actor,
- intent/event type,
- relevant payload,
- resulting state reference where useful.

Full event sourcing is not required initially.

## 6. Timing

Server owns:
- open times,
- deadlines,
- paused time,
- resume deadlines,
- buzzer acceptance.

Never trust a client device's claimed time as the deciding time.

## 7. Realtime Transport

Do not choose only from preference.

Compare:
- Socket.IO,
- raw WebSockets.

Keep transport behind an adapter.

Measure:
- RTT,
- jitter,
- ordering,
- reconnect,
- timer sync,
- Family Feud buzzer fairness,
- Unity integration,
- LAN,
- online behavior.

## 8. Persistence

Recommended later:
- PostgreSQL / Neon.

Optional future:
- Redis only when multi-instance realtime scaling needs it,
- local SQLite/session log for LAN recovery.

## 9. Local Party vs Online

Use the same game core.

### Local Party
- server runs locally,
- phones connect over LAN,
- Unity connects locally,
- should keep running if internet fails.

### Online
- persistent cloud realtime server,
- phones and Host connect over internet.

## 10. Security / Reliability

- room codes are convenience IDs, not authentication,
- use secure host/player session tokens,
- rate-limit joins/spam,
- sanitize names/text,
- do not send unrevealed production answers to players,
- use idempotency IDs,
- keep secrets out of Git,
- log recovery/admin actions.
