# Verification tools

Harnesses that check things `pnpm typecheck / lint / test / build` cannot.

Every one of these exists because green checks were not evidence. Phase 3's worst
bugs — a build that silently emitted nothing, two adapters fighting over one
WebSocket upgrade, an ack parser matching the wrong JSON key, radio buttons that
were never one group — all passed every automated check and failed the moment
something real ran.

These need Python and a couple of packages, so they are **not** wired into
`pnpm test`. Run them when touching the thing they cover.

```bash
pip install opencv-python-headless numpy playwright websockets
python -m playwright install chromium
```

---

## `qr-verify/` — is the QR code actually scannable?

```bash
cd tools/qr-verify && python verify.py
```

`qr_port.py` is a line-by-line port of
`unity/host/Assets/Scripts/Util/QrCode.cs`. `verify.py` renders its output and
**decodes it with a real scanner** (OpenCV), across 307 join URLs and symbol
sizes 21–37.

A QR code can have the right size, the right corner squares and a correct quiet
zone and still be unreadable. Only a decoder settles it.

**Keep `qr_port.py` in step with the C# whenever the encoder changes.**

Bugs it caught: format-information bits in the wrong modules (every code
unreadable), a mask penalty rule checked in only one orientation, and mask 2
producing spec-valid codes that decoders fail ~6.5% of the time (D-020).

---

## `lobby-verify/` — does the lobby work over real sockets?

Both need a running server (`node apps/game-server/dist/index.js`) and, for the
browser harness, the web app on port 3000.

### `browser_lobby.py` — 27 checks

Drives the player lobby in real Chromium at phone viewport: join, live team
update without reload, **refresh**-reconnect (§31B), **close/reopen**-reconnect
(§31C), and leaving invalidating the credential (§31D). Asserts against the
server's own view at each step, not just what the page renders. Fails on any
JavaScript error.

Close/reopen is deliberately separate from refresh: closing the page destroys
the WebSocket and all in-memory JS state, so the reopened page must rebuild
identity from `localStorage` alone. A reload can mask a dependency on surviving
memory; a close cannot.

```bash
python tools/lobby-verify/browser_lobby.py
```

### `reconnect_cases.py` — 48 checks

Socket-lifecycle scenarios that unit tests cannot reach (Phase 4 spec §31–§33):

- **A** — network interruption: membership, team and credential survive; no
  duplicate on return
- **D** — intentional leave: the old credential is dead
- **E** — stale connection: the newest authenticated connection wins, the old one
  is told and closed
- a displaced socket's `close` arriving **late**, which must not mark a present
  player as away
- **room closure**: Host is told, and joins / reconnects / Host actions are all
  refused afterward
- **displaced Host**: an old Host window loses authority; a connection without
  the credential is refused `UNAUTHORIZED_ACTOR`
- **three-team full flow** (§33): three players on three teams, locked, then a
  Team C player reconnecting after the lock with mode and lock intact
- Host removal, the 3→2 Team C guard, and lock validation (including that
  **uneven** teams lock successfully)

```bash
python tools/lobby-verify/reconnect_cases.py
```
