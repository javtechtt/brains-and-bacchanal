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
                 case_e_stale_connection, case_late_close, case_host_removal,
                 case_three_team_guard, case_capacity_and_lock):
        print(f"\n--- {case.__name__} ---")
        await case()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


sys.exit(asyncio.run(main()))
