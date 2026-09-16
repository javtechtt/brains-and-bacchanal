# unity/host — Host Display

**A real Unity project. Functional, deliberately unstyled.**

## Status

The project exists and works: it creates a room, shows a scannable QR code,
manages teams, starts a game, and drives the Phase 5 generic engine through a
development test panel.

It is a **functional networking and engine test screen, not the presentation**.
IMGUI only — no artwork, animation, sound or branded layout.
[docs/DEVELOPMENT_ROADMAP.md](../../docs/DEVELOPMENT_ROADMAP.md) places all of
that in **Phase 8**, after the game logic works. Building it now would mean
rebuilding it then.

Full detail, including the Unity version, the headless checks and the IL2CPP
build: [docs/UNITY_HOST.md](../../docs/UNITY_HOST.md).

## Layout

| File | Purpose |
|---|---|
| `Assets/Scripts/HostLobby.cs` | Room creation, QR, roster, teams, Start Game |
| `Assets/Scripts/HostEnginePanel.cs` | **Development only** — Phase 5 engine test panel |
| `Assets/Scripts/Protocol/` | Hand-written C# DTOs mirroring `packages/protocol` |
| `Assets/Scripts/Net/` | `ClientWebSocket` transport (D-014) |
| `Assets/Scripts/Util/QrCode.cs` | Hand-written QR encoder, verified by decoding |
| `Assets/Editor/Headless*Check.cs` | End-to-end checks against the real server |

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
