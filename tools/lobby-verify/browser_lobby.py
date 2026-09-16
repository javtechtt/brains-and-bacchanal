"""
Drive the real player lobby in a real browser against the real server.

Phase 3's ungrouped-radio bug proved that a 200 response and a clean build say
nothing about whether the page works.

Covers: joining, a live team update arriving without a reload, refresh-reconnect
(§31B), close/reopen-reconnect (§31C), and intentional leave killing the
credential (§31D) — asserting against the SERVER's view at each step, not just
what the page happens to render.
"""
import asyncio, json, sys
import websockets
from playwright.async_api import async_playwright

SERVER = "ws://127.0.0.1:4000/room/ws"
WEB = "http://127.0.0.1:3000"

results = []
def check(label, ok, detail=""):
    results.append((label, ok, detail))
    print(("PASS " if ok else "FAIL ") + label + ("" if ok else f" -- {detail}"))

async def host_create():
    """Create a room the way Unity does, and keep the socket open."""
    ws = await websockets.connect(SERVER)
    await ws.send(json.dumps({
        "kind": "intent", "requestId": "r1",
        "intent": {"protocolVersion": 1, "intentId": "i1", "roomId": "pending",
                   "type": "CREATE_ROOM", "payload": {}}}))
    while True:
        msg = json.loads(await ws.recv())
        if msg.get("kind") == "ack":
            return ws, msg["ack"]["snapshot"]

async def host_submit(ws, type_, payload, room_id, n):
    await ws.send(json.dumps({
        "kind": "intent", "requestId": f"r{n}",
        "intent": {"protocolVersion": 1, "intentId": f"i{n}", "roomId": room_id,
                   "type": type_, "payload": payload}}))
    while True:
        msg = json.loads(await ws.recv())
        if msg.get("kind") == "ack" and msg.get("requestId") == f"r{n}":
            return msg["ack"]

async def main():
    ws, room = await host_create()
    code = room["roomCode"]
    room_id = room["roomId"]
    print(f"room {code} ({room_id})")

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        # A phone-sized viewport: this UI is read one-handed.
        ctx = await browser.new_context(viewport={"width": 390, "height": 844})
        page = await ctx.new_page()

        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        # ---- Join page loads with the code from the URL ----
        await page.goto(f"{WEB}/join/{code}", wait_until="networkidle")
        body = await page.inner_text("body")
        check("join page shows the room code", code in body, body[:120])
        check("join page shows the game name", "BRAINS" in body.upper(), body[:120])

        # ---- Enter a name and join ----
        await page.fill("#displayName", "Javal")
        await page.click("button:has-text('Join game')")
        await page.wait_for_timeout(1200)

        body = await page.inner_text("body")
        check("player sees their name after joining", "Javal" in body, body[:200])
        check("player is told they are waiting",
              "waiting" in body.lower(), body[:200])
        check("no Host controls on the player page",
              "Lock Teams" not in body and "Create Room" not in body, body[:200])

        # ---- Credential stored ----
        stored = await page.evaluate(
            "() => Object.keys(localStorage).filter(k => k.startsWith('bb.identity.'))")
        check("identity saved for reconnect", len(stored) == 1, str(stored))

        identity = await page.evaluate(
            f"() => JSON.parse(localStorage.getItem('bb.identity.{code}'))")
        player_id = identity["playerId"]
        check("stored identity has a player id", bool(player_id), str(identity)[:120])

        # ---- Host assigns a team; the phone must update WITHOUT a reload ----
        ack = await host_submit(ws, "HOST_ASSIGN_PLAYER_TEAM",
                                {"playerId": player_id, "teamId": "TEAM_A"}, room_id, 2)
        check("host assignment accepted", ack.get("ok") is True, str(ack)[:160])

        await page.wait_for_timeout(1500)
        body = await page.inner_text("body")
        check("phone shows TEAM A without reloading", "TEAM A" in body.upper(), body[:250])

        # ---- Reload: must restore the SAME player, no name prompt ----
        await page.reload(wait_until="networkidle")
        await page.wait_for_timeout(1500)
        body = await page.inner_text("body")
        check("reload restores the player", "Javal" in body, body[:250])
        check("reload keeps the team", "TEAM A" in body.upper(), body[:250])
        check("reload does not ask for a name again",
              await page.locator("#displayName").count() == 0, "name field reappeared")

        after = await page.evaluate(
            f"() => JSON.parse(localStorage.getItem('bb.identity.{code}'))")
        check("player id is unchanged after reload",
              after["playerId"] == player_id, f"{player_id} -> {after['playerId']}")

        # ---- Server agrees there is exactly ONE player ----
        snap = await host_submit(ws, "REQUEST_LOBBY_SNAPSHOT", {}, room_id, 3)
        players = snap["snapshot"]["players"]
        check("server still has exactly one player", len(players) == 1,
              f"{len(players)} players")
        check("server kept the team", players[0]["teamId"] == "TEAM_A", str(players[0]))

        # ---- Close the tab entirely, then reopen (spec §31C) ----
        #
        # Genuinely different from a reload: closing the page destroys the
        # WebSocket and every scrap of in-memory JS state, so the reopened page
        # must rebuild identity from localStorage alone. A reload can mask a
        # dependency on surviving memory; this cannot.
        await page.close()
        await asyncio.sleep(1.0)   # let the server observe the socket drop

        snap = await host_submit(ws, "REQUEST_LOBBY_SNAPSHOT", {}, room_id, 31)
        away = snap["snapshot"]["players"]
        check("closing the tab does not delete the player",
              len(away) == 1, str(away))
        check("closed tab shows as disconnected",
              away and away[0]["connection"] == "disconnected", str(away))
        check("team survives the tab being closed",
              away and away[0]["teamId"] == "TEAM_A", str(away))

        reopened = await ctx.new_page()
        reopened_errors = []
        reopened.on("pageerror", lambda e: reopened_errors.append(str(e)))
        reopened.on("console",
                    lambda m: reopened_errors.append(m.text) if m.type == "error" else None)
        await reopened.goto(f"{WEB}/join/{code}", wait_until="networkidle")
        await reopened.wait_for_timeout(1800)

        body = await reopened.inner_text("body")
        check("reopened tab restores the player", "Javal" in body, body[:250])
        check("reopened tab keeps the team", "TEAM A" in body.upper(), body[:250])
        check("reopened tab does not ask for a name",
              await reopened.locator("#displayName").count() == 0, "name field reappeared")

        restored = await reopened.evaluate(
            f"() => JSON.parse(localStorage.getItem('bb.identity.{code}'))")
        check("reopened tab has the same player id",
              restored["playerId"] == player_id,
              f"{player_id} -> {restored['playerId']}")

        snap = await host_submit(ws, "REQUEST_LOBBY_SNAPSHOT", {}, room_id, 32)
        back = snap["snapshot"]["players"]
        check("still exactly one player after reopen — no duplicate",
              len(back) == 1, str(back))
        check("reopened player is connected again",
              back and back[0]["connection"] == "connected", str(back))

        errors.extend(reopened_errors)
        page = reopened

        # ---- Leave: credential must die ----
        page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
        await page.click("button:has-text('Leave game')")
        await page.wait_for_timeout(1200)

        snap = await host_submit(ws, "REQUEST_LOBBY_SNAPSHOT", {}, room_id, 4)
        check("leaving removed the player",
              len(snap["snapshot"]["players"]) == 0,
              str(snap["snapshot"]["players"]))

        gone = await page.evaluate(
            f"() => localStorage.getItem('bb.identity.{code}')")
        check("leaving cleared the saved identity", gone is None, str(gone))

        # ---- No JS errors anywhere in that flow ----
        real = [e for e in errors if "favicon" not in e.lower()]
        check("no JavaScript errors", len(real) == 0, "; ".join(real[:3]))

        await browser.close()
    await ws.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results)-len(failed)}/{len(results)} passed")
    return 1 if failed else 0

sys.exit(asyncio.run(main()))
