import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { ROOM_EVENTS, ROOM_INTENTS, type LobbySnapshot } from '@bb/protocol';
import { createGameServer, type GameServer } from '../server.js';
import { loadConfig } from '../config.js';
import { RoomClient } from './client.js';

/**
 * END-TO-END tests over a REAL WebSocket against the REAL production server.
 *
 * The Room model is already covered in isolation (packages/game-rules). What
 * this file covers is everything BETWEEN the model and a phone: the upgrade
 * path, framing, ack correlation, per-room fan-out, and the socket lifecycle.
 *
 * Phase 3 is the reason this exists. Every one of its worst bugs — the build
 * that silently emitted nothing, the two adapters fighting over an upgrade, the
 * ack parser matching the wrong key — passed unit tests and failed the moment
 * something real connected.
 */

const PORT = 4610;
const logger = pino({ level: 'silent' });

let server: GameServer;

function url(): string {
  return `ws://127.0.0.1:${PORT}/room/ws`;
}

async function connectClient(): Promise<RoomClient> {
  const client = new RoomClient({ url: url() });
  await client.connect();
  return client;
}

/** Create a room and return the Host client plus its credentials. */
async function createRoom(): Promise<{
  host: RoomClient;
  roomCode: string;
  roomId: string;
  hostToken: string;
}> {
  const host = await connectClient();
  const ack = await host.submit(ROOM_INTENTS.CREATE_ROOM, {});
  // Name the rejection: a bare "create failed" cost real debugging time here.
  if (!ack.ok) throw new Error(`create failed: ${ack.error.code} ${ack.error.message}`);

  const payload = ack.snapshot as {
    roomId: string;
    roomCode: string;
    hostToken: string;
    joinUrl: string;
  };
  host.roomId = payload.roomId;
  host.hostToken = payload.hostToken;
  return { host, roomCode: payload.roomCode, roomId: payload.roomId, hostToken: payload.hostToken };
}

/** Join a player to a room by code. */
async function joinPlayer(
  roomCode: string,
  roomId: string,
  displayName: string,
): Promise<RoomClient> {
  const client = await connectClient();
  client.roomId = roomId;
  const ack = await client.submit(ROOM_INTENTS.JOIN_ROOM, { roomCode, displayName });
  if (!ack.ok) throw new Error(`join failed: ${ack.error.code}`);

  const payload = ack.snapshot as { playerId: string; reconnectToken: string };
  client.playerId = payload.playerId;
  client.reconnectToken = payload.reconnectToken;
  return client;
}

beforeAll(async () => {
  server = createGameServer(
    { ...loadConfig({}), port: PORT, host: '127.0.0.1', publicBaseUrl: 'http://127.0.0.1:3000' },
    logger,
  );
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

describe('production room over a real websocket', () => {
  it('creates a room and returns a code, a Host credential and a join URL', async () => {
    const host = await connectClient();
    const ack = await host.submit(ROOM_INTENTS.CREATE_ROOM, {});

    expect(ack.ok).toBe(true);
    if (!ack.ok) throw new Error('expected success');
    const payload = ack.snapshot as {
      roomCode: string;
      hostToken: string;
      joinUrl: string;
      snapshot: LobbySnapshot;
    };

    expect(payload.roomCode).toHaveLength(4);
    expect(payload.hostToken).toBeTruthy();
    expect(payload.joinUrl).toContain(`/join/${payload.roomCode}`);
    expect(payload.snapshot.isHost).toBe(true);

    await host.disconnect();
  });

  it('lets a phone join by code and tells the Host', async () => {
    const { host, roomCode, roomId } = await createRoom();
    const player = await joinPlayer(roomCode, roomId, 'Javal');

    const event = await host.waitForEvent(ROOM_EVENTS.PLAYER_JOINED);
    const payload = event.payload as { player: { displayName: string } };
    expect(payload.player.displayName).toBe('Javal');
    expect(player.playerId).toBeTruthy();

    await player.disconnect();
    await host.disconnect();
  });

  it('never sends one player the credential of another', async () => {
    const { host, roomCode, roomId } = await createRoom();
    const a = await joinPlayer(roomCode, roomId, 'Javal');
    const b = await joinPlayer(roomCode, roomId, 'Andrea');

    await host.waitForEvent(ROOM_EVENTS.PLAYER_JOINED);

    // Everything B has received, plus a fresh snapshot, must be free of A's
    // credential — this is the leak that would let anyone impersonate anyone.
    const ack = await b.submit(ROOM_INTENTS.REQUEST_LOBBY_SNAPSHOT);
    const seen = JSON.stringify({ events: b.receivedEvents(), ack });

    expect(a.reconnectToken).toBeTruthy();
    expect(seen).not.toContain(a.reconnectToken);
    expect(seen).not.toContain(host.hostToken);

    await a.disconnect();
    await b.disconnect();
    await host.disconnect();
  });

  it('rejects a Host action sent by a player, over the wire', async () => {
    const { host, roomCode, roomId } = await createRoom();
    const player = await joinPlayer(roomCode, roomId, 'Javal');

    const ack = await player.submit(ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM, {
      playerId: player.playerId,
      teamId: 'TEAM_A',
      isHost: true, // must change nothing
    });

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('UNAUTHORIZED_ACTOR');

    await player.disconnect();
    await host.disconnect();
  });

  it('assigns a team and pushes it to the phone', async () => {
    const { host, roomCode, roomId } = await createRoom();
    const player = await joinPlayer(roomCode, roomId, 'Javal');

    const ack = await host.submit(ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM, {
      playerId: player.playerId,
      teamId: 'TEAM_A',
    });
    expect(ack.ok).toBe(true);

    const event = await player.waitForEvent(ROOM_EVENTS.TEAM_ASSIGNMENT_CHANGED);
    const payload = event.payload as { teamId: string };
    expect(payload.teamId).toBe('TEAM_A');

    await player.disconnect();
    await host.disconnect();
  });

  it('restores the same player and team after a real disconnect', async () => {
    const { host, roomCode, roomId } = await createRoom();
    const player = await joinPlayer(roomCode, roomId, 'Javal');
    await host.submit(ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM, {
      playerId: player.playerId,
      teamId: 'TEAM_A',
    });

    const originalId = player.playerId;
    const token = player.reconnectToken;
    await player.disconnect();
    await host.waitForEvent(ROOM_EVENTS.PLAYER_DISCONNECTED);

    const returning = await connectClient();
    returning.roomId = roomId;
    const ack = await returning.submit(ROOM_INTENTS.RECONNECT_PLAYER, {
      playerId: originalId,
      reconnectToken: token,
    });

    expect(ack.ok).toBe(true);
    if (!ack.ok) throw new Error('expected success');
    const payload = ack.snapshot as { playerId: string; snapshot: LobbySnapshot };

    expect(payload.playerId).toBe(originalId);
    const me = payload.snapshot.players.find((p) => p.playerId === originalId);
    expect(me?.teamId).toBe('TEAM_A');
    expect(me?.connection).toBe('connected');
    // No duplicate: exactly one player in the room.
    expect(payload.snapshot.players).toHaveLength(1);

    await returning.disconnect();
    await host.disconnect();
  });

  it('closes the old socket when a player reconnects over it', async () => {
    const { host, roomCode, roomId } = await createRoom();
    const player = await joinPlayer(roomCode, roomId, 'Javal');

    // Reconnect WITHOUT disconnecting first — the phone-wakes-from-sleep case.
    const second = await connectClient();
    second.roomId = roomId;
    const ack = await second.submit(ROOM_INTENTS.RECONNECT_PLAYER, {
      playerId: player.playerId,
      reconnectToken: player.reconnectToken,
    });
    expect(ack.ok).toBe(true);

    // The displaced socket must actually be closed by the server.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(player.isOpen).toBe(false);

    await second.disconnect();
    await host.disconnect();
  });

  it('keeps rooms isolated from each other', async () => {
    const first = await createRoom();
    const second = await createRoom();

    const playerA = await joinPlayer(first.roomCode, first.roomId, 'In room one');
    const playerB = await joinPlayer(second.roomCode, second.roomId, 'In room two');

    await first.host.waitForEvent(ROOM_EVENTS.PLAYER_JOINED);
    await second.host.waitForEvent(ROOM_EVENTS.PLAYER_JOINED);

    // Neither room's Host may learn anything about the other room's players.
    expect(JSON.stringify(first.host.receivedEvents())).not.toContain('In room two');
    expect(JSON.stringify(second.host.receivedEvents())).not.toContain('In room one');

    await playerA.disconnect();
    await playerB.disconnect();
    await first.host.disconnect();
    await second.host.disconnect();
  });

  it('rejects a join with an unknown room code', async () => {
    const client = await connectClient();
    const ack = await client.submit(ROOM_INTENTS.JOIN_ROOM, {
      roomCode: 'ZZZZ',
      displayName: 'Nobody',
    });

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('NOT_FOUND');
    await client.disconnect();
  });

  it('handles a duplicate intent without applying it twice', async () => {
    const { host, roomCode, roomId } = await createRoom();
    const player = await joinPlayer(roomCode, roomId, 'Javal');

    const intentId = 'fixed-intent-for-this-test';
    const first = await host.submit(
      ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM,
      { playerId: player.playerId, teamId: 'TEAM_A' },
      intentId,
    );
    const replay = await host.submit(
      ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM,
      { playerId: player.playerId, teamId: 'TEAM_B' },
      intentId,
    );

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe('DUPLICATE_INTENT');

    const snapshot = await host.submit(ROOM_INTENTS.REQUEST_LOBBY_SNAPSHOT);
    if (!snapshot.ok) throw new Error('expected success');
    const state = snapshot.snapshot as LobbySnapshot;
    expect(state.players[0]?.teamId).toBe('TEAM_A');

    await player.disconnect();
    await host.disconnect();
  });

  it('delivers events in sequence order', async () => {
    const { host, roomCode, roomId } = await createRoom();
    const player = await joinPlayer(roomCode, roomId, 'Javal');
    host.clearEvents();

    for (const teamId of ['TEAM_A', 'TEAM_B', 'TEAM_A', 'TEAM_B']) {
      await host.submit(ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM, {
        playerId: player.playerId,
        teamId,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    const seqs = host.receivedEvents().map((e) => e.seq);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates

    await player.disconnect();
    await host.disconnect();
  });

  it('restores the Host to the SAME room without creating another', async () => {
    const { host, roomCode, roomId, hostToken } = await createRoom();
    const player = await joinPlayer(roomCode, roomId, 'Javal');
    await host.submit(ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM, {
      playerId: player.playerId,
      teamId: 'TEAM_A',
    });

    const roomsBefore = server.rooms.store.size;
    await host.disconnect();

    const returning = await connectClient();
    returning.roomId = roomId;
    const ack = await returning.submit(ROOM_INTENTS.RECONNECT_HOST, { hostToken });

    expect(ack.ok).toBe(true);
    if (!ack.ok) throw new Error('expected success');
    const payload = ack.snapshot as { roomCode: string; snapshot: LobbySnapshot };

    expect(payload.roomCode).toBe(roomCode);
    expect(server.rooms.store.size).toBe(roomsBefore); // no new room
    expect(payload.snapshot.players[0]?.teamId).toBe('TEAM_A');
    expect(payload.snapshot.isHost).toBe(true);

    await player.disconnect();
    await returning.disconnect();
  });

  it('rejects a forged Host credential', async () => {
    const { host, roomId } = await createRoom();
    const attacker = await connectClient();
    attacker.roomId = roomId;

    const ack = await attacker.submit(ROOM_INTENTS.RECONNECT_HOST, { hostToken: 'not-the-token' });
    expect(ack.ok).toBe(false);

    await attacker.disconnect();
    await host.disconnect();
  });

  it('a left player cannot return with the old credential', async () => {
    const { host, roomCode, roomId } = await createRoom();
    const player = await joinPlayer(roomCode, roomId, 'Javal');
    const { playerId, reconnectToken } = player;

    const left = await player.submit(ROOM_INTENTS.LEAVE_ROOM);
    expect(left.ok).toBe(true);
    await player.disconnect();

    const returning = await connectClient();
    returning.roomId = roomId;
    const ack = await returning.submit(ROOM_INTENTS.RECONNECT_PLAYER, { playerId, reconnectToken });
    expect(ack.ok).toBe(false);

    await returning.disconnect();
    await host.disconnect();
  });

  it('resolves a room code over HTTP without revealing the roster', async () => {
    const { host, roomCode } = await createRoom();
    await joinPlayer(roomCode, host.roomId, 'Javal');

    const response = await fetch(`http://127.0.0.1:${PORT}/rooms/${roomCode}`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body['roomCode']).toBe(roomCode);
    expect(body['acceptingJoins']).toBe(true);
    // An unauthenticated caller must not learn who is in the room.
    expect(JSON.stringify(body)).not.toContain('Javal');

    const missing = await fetch(`http://127.0.0.1:${PORT}/rooms/ZZZZ`);
    expect(missing.status).toBe(404);

    await host.disconnect();
  });

  it('serves /health', async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['status']).toBe('ok');
  });
});
