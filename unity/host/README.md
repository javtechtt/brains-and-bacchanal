# unity/host — Host Display

**Placeholder. No Unity project has been created yet.**

## Status

Phase 1 establishes this folder only. The Unity project itself belongs to
**Phase 8 — Unity Presentation / Tutorials**, which
[docs/DEVELOPMENT_ROADMAP.md](../../docs/DEVELOPMENT_ROADMAP.md) places *after*
the game logic works.

Creating a Unity project requires the Unity Editor and would produce a large
amount of generated scaffolding with nothing yet to render.

## What this will become

Per [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §1, the Host Display is
Unity + C# and is responsible for:

- game-show presentation,
- Host controls,
- audio,
- animation,
- scores,
- reveals,
- the Family Feud board,
- Market / Maco Mail / Card presentation.

## The rule that governs this folder

> Unity renders server state and does not duplicate game rules.

No BB arithmetic, card legality check, timer authority or winner determination
may live in C#. The Host Display shows what the server has already decided.

## Shared contracts

ARCHITECTURE.md §3 defines the contract chain:

```text
schema -> TypeScript types -> C# DTOs
```

C# DTOs will be generated from or kept in sync with `packages/protocol`, and
must assert the protocol version at connection time.

## When the project is created

`.gitignore` already excludes the standard Unity generated directories
(`Library/`, `Temp/`, `Obj/`, `Build/`, `Logs/`, `UserSettings/`) and generated
solution files.
