"""
Reconnect and stale-connection scenarios (Phase 4 spec §31 A–E), driven over
real sockets against a running game server.

These are the cases that cannot be proved by unit tests alone, because they are
about SOCKET lifecycle: a connection dying mid-party, a second tab taking over,
an old socket closing after a new one is already established.

    python tools/lobby-verify/reconnect_cases.py
"""
import asyncio
import json
import sys

import websockets

SERVER = "ws://127.0.0.1:4000/room/ws"

results = []


def check(label, ok, detail=""):
    results.append((label, ok))
    print(("PASS " if ok else "FAIL ") + label + ("" if ok else f" -- {detail}"))


class Client:
    """One socket. Mirrors what a phone or the Unity Host does."""

    def __init__(self):
        self.ws = None
        self.room_id = "pending"
        self.n = 0
        self.events = []

    async def connect(self):
        self.ws = await websockets.connect(SERVER)
        return self

    async def submit(self, type_, payload=None, intent_id=None):
        self.n += 1
        rid = f"r{id(self)}-{self.n}"
        await self.ws.send(json.dumps({
            "kind": "intent", "requestId": rid,
            "intent": {
                "protocolVersion": 1,
                "intentId": intent_id or f"i{id(self)}-{self.n}",
                "roomId": self.room_id,
                "type": type_,
                "payload": payload or {},
            }}))
        while True:
            msg = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=5))
            if msg.get("kind") == "event":
                self.events.append(msg["event"])
                continue
            if msg.get("kind") == "ack" and msg.get("requestId") == rid:
                return msg["ack"]

    async def drain(self, seconds=0.6):
        """Collect events that arrive without a request of our own."""
        try:
            while True:
                msg = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=seconds))
                if msg.get("kind") == "event":
                    self.events.append(msg["event"])
        except (asyncio.TimeoutError, websockets.exceptions.ConnectionClosed):
            pass

    def saw(self, type_):
        return any(e.get("type") == type_ for e in self.events)

    async def close(self):
        if self.ws is not None:
            await self.ws.close()

    @property
    def open(self):
        return self.ws is not None and self.ws.state.name == "OPEN"


async def new_room():
    host = await Client().connect()
    ack = await host.submit("CREATE_ROOM")
    room = ack["snapshot"]
    host.room_id = room["roomId"]
    return host, room


async def join(room, name):
    player = await Client().connect()
    player.room_id = room["roomId"]
    ack = await player.submit(
        "JOIN_ROOM", {"roomCode": room["roomCode"], "displayName": name})
    info = ack["snapshot"]
    return player, info


async def case_a_network_interruption():
    """A: the phone loses the network entirely, then comes back."""
    host, room = await new_room()
    player, info = await join(room, "Javal")
    await host.submit("HOST_ASSIGN_PLAYER_TEAM",
                      {"playerId": info["playerId"], "teamId": "TEAM_A"})

    # Kill the socket the way a dying Wi-Fi link does.
    await player.close()
    await asyncio.sleep(0.3)

    snap = await host.submit("REQUEST_LOBBY_SNAPSHOT")
    players = snap["snapshot"]["players"]
    check("A: player survives the disconnect", len(players) == 1, str(players))
    check("A: player shows as disconnected",
          players and players[0]["connection"] == "disconnected", str(players))
    check("A: team is preserved while away",
          players and players[0]["teamId"] == "TEAM_A", str(players))

    returning = await Client().connect()
    returning.room_id = room["roomId"]
    ack = await returning.submit("RECONNECT_PLAYER", {
        "playerId": info["playerId"], "reconnectToken": info["reconnectToken"]})
    check("A: reconnect accepted", ack.get("ok") is True, str(ack)[:200])

    snap = await host.submit("REQUEST_LOBBY_SNAPSHOT")
    players = snap["snapshot"]["players"]
    check("A: still exactly one player — no duplicate", len(players) == 1, str(players))
    check("A: same player id", players[0]["playerId"] == info["playerId"], str(players))
    check("A: same team", players[0]["teamId"] == "TEAM_A", str(players))
    check("A: connected again", players[0]["connection"] == "connected", str(players))

    await returning.close()
    await host.close()


async def case_d_intentional_leave():
    """D: leaving is permanent — the old credential must not work."""
    host, room = await new_room()
    player, info = await join(room, "Javal")

    await player.submit("LEAVE_ROOM")
    await player.close()

    returning = await Client().connect()
    returning.room_id = room["roomId"]
    ack = await returning.submit("RECONNECT_PLAYER", {
        "playerId": info["playerId"], "reconnectToken": info["reconnectToken"]})
    check("D: old credential is refused after leaving", ack.get("ok") is False, str(ack)[:200])

    snap = await host.submit("REQUEST_LOBBY_SNAPSHOT")
    check("D: membership did not come back",
          len(snap["snapshot"]["players"]) == 0, str(snap["snapshot"]["players"]))

    await returning.close()
    await host.close()


async def case_room_close():
    """
    Closing is terminal: the Host is told, and the room refuses everything
    afterward. This is the server-side contract HostLobby.cs relies on when it
    resets to the create-room screen on ROOM_CLOSED rather than merely
    reflecting a "status: CLOSED" snapshot forever.
    """
    host, room = await new_room()
    player, info = await join(room, "Javal")

    ack = await host.submit("HOST_CLOSE_ROOM")
    check("close accepted", ack.get("ok") is True, str(ack)[:200])

    await host.drain(0.5)
    check("host receives ROOM_CLOSED",
          host.saw("ROOM_CLOSED"), str([e.get("type") for e in host.events]))

    # A snapshot request must still be answerable (it is read-only), but must
    # report the closed status rather than silently pretending the room is
    # still open.
    snap = await host.submit("REQUEST_LOBBY_SNAPSHOT")
    check("snapshot reports CLOSED status",
          snap["snapshot"]["room"]["status"] == "CLOSED", str(snap["snapshot"]["room"]))

    # Nothing further should be possible: no new joins, no reconnects, no
    # further Host actions.
    late = await Client().connect()
    late.room_id = room["roomId"]
    ack = await late.submit("JOIN_ROOM",
                            {"roomCode": room["roomCode"], "displayName": "TooLate"})
    check("join refused after close", ack.get("ok") is False, str(ack)[:200])

    ack = await host.submit("HOST_LOCK_TEAMS")
    check("host actions refused after close", ack.get("ok") is False, str(ack)[:200])

    returning = await Client().connect()
    returning.room_id = room["roomId"]
    ack = await returning.submit("RECONNECT_PLAYER", {
        "playerId": info["playerId"], "reconnectToken": info["reconnectToken"]})
    check("player reconnect refused after close", ack.get("ok") is False, str(ack)[:200])

    for client in (late, returning, player, host):
        await client.close()


async def case_e_stale_connection():
    """E: a second connection takes over while the first is still open."""
    host, room = await new_room()
    first, info = await join(room, "Javal")

    second = await Client().connect()
    second.room_id = room["roomId"]
    ack = await second.submit("RECONNECT_PLAYER", {
        "playerId": info["playerId"], "reconnectToken": info["reconnectToken"]})
    check("E: newest connection is accepted", ack.get("ok") is True, str(ack)[:200])

    # The displaced socket should be told, then closed by the server.
    await first.drain(1.0)
    check("E: displaced connection was told why",
          first.saw("CONNECTION_SUPERSEDED"),
          str([e.get("type") for e in first.events]))

    await asyncio.sleep(0.4)
    check("E: displaced connection was closed by the server",
          not first.open, "old socket still open")

    snap = await host.submit("REQUEST_LOBBY_SNAPSHOT")
    players = snap["snapshot"]["players"]
    check("E: still one player after takeover", len(players) == 1, str(players))
    check("E: player is connected on the new socket",
          players[0]["connection"] == "connected", str(players))

    await second.close()
    await host.close()


async def case_late_close():
    """
    A displaced socket's close arriving AFTER the new one is established.

    Normal on a flaky phone link, and the ordering that would wrongly mark a
    present player as away.
    """
    host, room = await new_room()
    first, info = await join(room, "Javal")

    second = await Client().connect()
    second.room_id = room["roomId"]
    await second.submit("RECONNECT_PLAYER", {
        "playerId": info["playerId"], "reconnectToken": info["reconnectToken"]})

    # Now let the old socket's close land, late.
    await first.close()
    await asyncio.sleep(0.5)

    snap = await host.submit("REQUEST_LOBBY_SNAPSHOT")
    players = snap["snapshot"]["players"]
    check("late close does not mark the player away",
          players and players[0]["connection"] == "connected", str(players))

    await second.close()
    await host.close()


async def case_host_removal():
    """A removed player is gone and cannot reconnect back in."""
    host, room = await new_room()
    player, info = await join(room, "Javal")

    ack = await host.submit("HOST_REMOVE_PLAYER", {"playerId": info["playerId"]})
    check("host can remove a player", ack.get("ok") is True, str(ack)[:200])

    await asyncio.sleep(0.3)
    returning = await Client().connect()
    returning.room_id = room["roomId"]
    ack = await returning.submit("RECONNECT_PLAYER", {
        "playerId": info["playerId"], "reconnectToken": info["reconnectToken"]})
    check("removed player cannot reconnect", ack.get("ok") is False, str(ack)[:200])

    await returning.close()
    await player.close()
    await host.close()


async def case_three_team_guard():
    """3 -> 2 must be refused while Team C holds players."""
    host, room = await new_room()
    await host.submit("HOST_SET_TEAM_MODE", {"teamMode": 3})
    player, info = await join(room, "Javal")
    await host.submit("HOST_ASSIGN_PLAYER_TEAM",
                      {"playerId": info["playerId"], "teamId": "TEAM_C"})

    ack = await host.submit("HOST_SET_TEAM_MODE", {"teamMode": 2})
    check("3->2 refused while Team C has players", ack.get("ok") is False, str(ack)[:200])

    snap = await host.submit("REQUEST_LOBBY_SNAPSHOT")
    players = snap["snapshot"]["players"]
    check("the Team C player was NOT moved silently",
          players and players[0]["teamId"] == "TEAM_C", str(players))

    await player.close()
    await host.close()


async def case_displaced_host_cannot_act():
    """
    A displaced Host connection must lose Host authority.

    The scenario that matters: the operator opens the Host somewhere else (or
    Unity restarts and reconnects) while the old window is still on screen.
    If the old connection kept its authority, two windows could both drive the
    game and whichever was clicked last would win — with no indication to
    either which one was authoritative.
    """
    host, room = await new_room()
    player, info = await join(room, "Javal")

    second = await Client().connect()
    second.room_id = room["roomId"]
    ack = await second.submit("RECONNECT_HOST", {"hostToken": room["hostToken"]})
    check("H: second Host connection accepted", ack.get("ok") is True, str(ack)[:200])

    await host.drain(1.0)
    check("H: displaced Host was told why",
          host.saw("CONNECTION_SUPERSEDED"),
          str([e.get("type") for e in host.events]))

    # The old Host socket is closed by the server, so the attempt has to come
    # from a fresh connection that never proved Host authority at all.
    third = await Client().connect()
    third.room_id = room["roomId"]
    ack = await third.submit("HOST_ASSIGN_PLAYER_TEAM",
                             {"playerId": info["playerId"], "teamId": "TEAM_A"})
    check("H: a connection without the credential cannot act as Host",
          ack.get("ok") is False, str(ack)[:200])
    check("H: rejection is UNAUTHORIZED_ACTOR",
          ack.get("error", {}).get("code") == "UNAUTHORIZED_ACTOR", str(ack)[:200])

    # The genuine new Host still works.
    ack = await second.submit("HOST_ASSIGN_PLAYER_TEAM",
                              {"playerId": info["playerId"], "teamId": "TEAM_A"})
    check("H: the current Host can still act", ack.get("ok") is True, str(ack)[:200])

    for client in (third, second, player):
        await client.close()


async def case_three_team_full_flow():
    """
    A complete three-team game shape (spec §33): three players, one per team,
    locked, then reconnect after the lock.

    Distinct from case_three_team_guard, which only proves the 3->2 refusal.
    This proves Team C is a real, first-class team — assignable, lockable, and
    preserved across a reconnect — rather than merely a value the mode accepts.
    """
    host, room = await new_room()

    ack = await host.submit("HOST_SET_TEAM_MODE", {"teamMode": 3})
    check("3: team mode set to 3", ack.get("ok") is True, str(ack)[:200])

    snap = await host.submit("REQUEST_LOBBY_SNAPSHOT")
    check("3: three teams exposed",
          len(snap["snapshot"]["teams"]) == 3, str(snap["snapshot"]["teams"]))

    a, a_info = await join(room, "Javal")
    b, b_info = await join(room, "Andrea")
    c, c_info = await join(room, "Third")

    for info, team in ((a_info, "TEAM_A"), (b_info, "TEAM_B"), (c_info, "TEAM_C")):
        ack = await host.submit("HOST_ASSIGN_PLAYER_TEAM",
                                {"playerId": info["playerId"], "teamId": team})
        check(f"3: assigned a player to {team}", ack.get("ok") is True, str(ack)[:200])

    ack = await host.submit("HOST_LOCK_TEAMS")
    check("3: lock succeeds with all three teams populated",
          ack.get("ok") is True, str(ack)[:200])

    # Reconnect the Team C player specifically: Team C is the one that only
    # exists in three-team mode, so it is where a mode-dependent bug would hide.
    await c.close()
    await asyncio.sleep(0.3)
    returning = await Client().connect()
    returning.room_id = room["roomId"]
    ack = await returning.submit("RECONNECT_PLAYER", {
        "playerId": c_info["playerId"], "reconnectToken": c_info["reconnectToken"]})
    check("3: Team C player reconnects after lock", ack.get("ok") is True, str(ack)[:200])

    snap = await host.submit("REQUEST_LOBBY_SNAPSHOT")
    players = snap["snapshot"]["players"]
    restored = next((p for p in players if p["playerId"] == c_info["playerId"]), None)
    check("3: Team C membership restored",
          restored is not None and restored["teamId"] == "TEAM_C", str(restored))
    check("3: still exactly three players", len(players) == 3, str(len(players)))
    check("3: room still locked after reconnect",
          snap["snapshot"]["room"]["teamsLocked"] is True, str(snap["snapshot"]["room"]))
    check("3: still in three-team mode",
          snap["snapshot"]["room"]["teamMode"] == 3, str(snap["snapshot"]["room"]))

    for client in (a, b, returning, host):
        await client.close()


async def case_capacity_and_lock():
    """Locking needs every team populated; uneven teams are fine."""
    host, room = await new_room()
    a, a_info = await join(room, "Javal")
    b, b_info = await join(room, "Andrea")
    c, c_info = await join(room, "Third")

    await host.submit("HOST_ASSIGN_PLAYER_TEAM",
                      {"playerId": a_info["playerId"], "teamId": "TEAM_A"})
    ack = await host.submit("HOST_LOCK_TEAMS")
    check("lock refused while Team B is empty", ack.get("ok") is False, str(ack)[:200])

    await host.submit("HOST_ASSIGN_PLAYER_TEAM",
                      {"playerId": b_info["playerId"], "teamId": "TEAM_A"})
    await host.submit("HOST_ASSIGN_PLAYER_TEAM",
                      {"playerId": c_info["playerId"], "teamId": "TEAM_B"})

    ack = await host.submit("HOST_LOCK_TEAMS")
    check("lock allowed with UNEVEN teams (2 v 1)", ack.get("ok") is True, str(ack)[:200])

    ack = await host.submit("HOST_ASSIGN_PLAYER_TEAM",
                            {"playerId": a_info["playerId"], "teamId": "TEAM_B"})
    check("assignment refused after lock", ack.get("ok") is False, str(ack)[:200])

    late = await Client().connect()
    late.room_id = room["roomId"]
    ack = await late.submit("JOIN_ROOM",
                            {"roomCode": room["roomCode"], "displayName": "Late"})
    check("new join refused after lock", ack.get("ok") is False, str(ack)[:200])

    # A locked room must still let an existing player return.
    await a.close()
    await asyncio.sleep(0.3)
    returning = await Client().connect()
    returning.room_id = room["roomId"]
    ack = await returning.submit("RECONNECT_PLAYER", {
        "playerId": a_info["playerId"], "reconnectToken": a_info["reconnectToken"]})
    check("reconnect still works after lock", ack.get("ok") is True, str(ack)[:200])

    snap = await host.submit("REQUEST_LOBBY_SNAPSHOT")
    check("reconnecting did not unlock the room",
          snap["snapshot"]["room"]["teamsLocked"] is True, str(snap["snapshot"]["room"]))

    for client in (late, returning, b, c, host):
        await client.close()


async def main():
    for case in (case_a_network_interruption, case_d_intentional_leave,
                 case_room_close, case_e_stale_connection, case_late_close,
                 case_host_removal, case_displaced_host_cannot_act,
                 case_three_team_guard, case_three_team_full_flow,
                 case_capacity_and_lock):
        print(f"\n--- {case.__name__} ---")
        await case()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


sys.exit(asyncio.run(main()))
