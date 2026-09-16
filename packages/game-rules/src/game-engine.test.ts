import { beforeEach, describe, expect, it } from 'vitest';
import {
  asIntentId,
  asRoomId,
  asTeamId,
  GAME_EVENTS,
  GAME_INTENTS,
  isHostGameSnapshot,
  PROTOCOL_VERSION,
  ROOM_INTENTS,
  type EventEnvelope,
  type HostGameSnapshot,
  type IntentEnvelope,
  type PlayerGameSnapshot,
  type PlayerId,
} from '@bb/protocol';
import { FakeClock } from './clock.js';
import { Room, type RoomOutcome } from './room.js';

/**
 * The Phase 5 engine, driven through the Room exactly as the network drives it.
 *
 * Testing through the Room rather than against GameEngine directly is
 * deliberate: authority, idempotency and the event log are part of what Phase 5
 * must guarantee, and a test that bypassed them would pass while the real path
 * was broken.
 *
 * NOTHING HERE ASSERTS A ROUND RULE. The challenge types are fixtures
 * ("TEST_CHALLENGE"), the BB amounts are arbitrary test inputs, and the timer
 * durations are not any challenge's real duration — those remain open in
 * docs/OPEN_RULES.md.
 */

const HOST = 'conn-host';
const PHONE_1 = 'conn-p1';
const PHONE_2 = 'conn-p2';

const TEAM_A = asTeamId('TEAM_A');
const TEAM_B = asTeamId('TEAM_B');

let intentCounter = 0;
function intent(type: string, payload: unknown = {}, roomId = 'room-1'): IntentEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    intentId: asIntentId(`intent-${++intentCounter}`),
    roomId: asRoomId(roomId),
    type,
    payload,
  };
}

interface Harness {
  readonly room: Room;
  readonly clock: FakeClock;
  readonly p1: PlayerId;
  readonly p2: PlayerId;
  host(type: string, payload?: unknown): RoomOutcome;
}

/** A room with two players, one per team, teams locked. */
function makeRoom(options: { devTools?: boolean; lock?: boolean } = {}): Harness {
  const clock = new FakeClock(1_000);
  let ids = 0;

  const room = new Room({
    roomId: asRoomId('room-1'),
    roomCode: 'BX7K',
    mode: 'local_party',
    clock,
    hostToken: 'host-token',
    capacity: 24,
    mintToken: () => `token-${++ids}`,
    mintPlayerId: () => `id-${++ids}`,
    devTools: options.devTools ?? true,
  });

  room.attachHost(HOST);
  room.onConnect(PHONE_1);
  room.onConnect(PHONE_2);

  const join1 = room.handle(PHONE_1, intent(ROOM_INTENTS.JOIN_ROOM, { displayName: 'Javal' }));
  const join2 = room.handle(PHONE_2, intent(ROOM_INTENTS.JOIN_ROOM, { displayName: 'Ama' }));

  const p1 = (join1.ack.ok ? (join1.ack.value.payload as { playerId: string }).playerId : '') as PlayerId;
  const p2 = (join2.ack.ok ? (join2.ack.value.payload as { playerId: string }).playerId : '') as PlayerId;

  const host = (type: string, payload: unknown = {}): RoomOutcome =>
    room.handle(HOST, intent(type, payload));

  host(ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM, { playerId: p1, teamId: 'TEAM_A' });
  host(ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM, { playerId: p2, teamId: 'TEAM_B' });
  if (options.lock !== false) host(ROOM_INTENTS.HOST_LOCK_TEAMS);

  return { room, clock, p1, p2, host };
}

/** Start a game and open a running challenge with p1 active on Team A's turn. */
function startChallenge(h: Harness, durationMs = 30_000): void {
  h.host(GAME_INTENTS.START_GAME);
  h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'CHALLENGE_INTRO' });
  h.host(GAME_INTENTS.HOST_PREPARE_CHALLENGE, { challengeType: 'TEST_CHALLENGE' });
  h.host(GAME_INTENTS.HOST_START_CHALLENGE);
  h.host(GAME_INTENTS.HOST_SET_TURN, { teamId: 'TEAM_A', playerId: h.p1 });
  h.host(GAME_INTENTS.HOST_SET_ACTIVE_PLAYERS, { playerIds: [h.p1] });
  h.host(GAME_INTENTS.HOST_START_TIMER, { durationMs });
}

function types(events: readonly EventEnvelope[]): string[] {
  return events.map((event) => event.type);
}

beforeEach(() => {
  intentCounter = 0;
});

// ---------------------------------------------------------------------------
// Game start
// ---------------------------------------------------------------------------

describe('START_GAME', () => {
  it('starts from locked teams and seeds every team with 1,000 BB', () => {
    const h = makeRoom();
    const outcome = h.host(GAME_INTENTS.START_GAME);

    expect(outcome.ack.ok).toBe(true);
    expect(types(outcome.broadcast)).toContain(GAME_EVENTS.GAME_STARTED);
    expect(h.room.game.balanceOf(TEAM_A)).toBe(1_000);
    expect(h.room.game.balanceOf(TEAM_B)).toBe(1_000);
  });

  it('rejects a start while teams are unlocked', () => {
    const h = makeRoom({ lock: false });
    const outcome = h.host(GAME_INTENTS.START_GAME);

    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('WRONG_STATE');
    expect(h.room.gameStarted).toBe(false);
  });

  it('rejects a second START_GAME', () => {
    const h = makeRoom();
    expect(h.host(GAME_INTENTS.START_GAME).ack.ok).toBe(true);

    // A distinct intentId, so this is not caught by deduplication — the engine
    // itself must refuse.
    const second = h.host(GAME_INTENTS.START_GAME);
    expect(second.ack.ok).toBe(false);
    if (!second.ack.ok) expect(second.ack.error.code).toBe('WRONG_STATE');
    expect(h.room.game.balanceOf(TEAM_A)).toBe(1_000);
  });

  it('rejects a duplicate START_GAME intent without reapplying it', () => {
    const h = makeRoom();
    const first = intent(GAME_INTENTS.START_GAME);
    expect(h.room.handle(HOST, first).ack.ok).toBe(true);

    const replay = h.room.handle(HOST, first);
    expect(replay.ack.ok).toBe(false);
    if (!replay.ack.ok) expect(replay.ack.error.code).toBe('DUPLICATE_INTENT');
    expect(h.room.game.balanceOf(TEAM_A)).toBe(1_000);
  });

  it('refuses a player who asks to start the game', () => {
    const h = makeRoom();
    const outcome = h.room.handle(PHONE_1, intent(GAME_INTENTS.START_GAME));

    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('UNAUTHORIZED_ACTOR');
    expect(h.room.gameStarted).toBe(false);
  });

  it('enters ROUND_INTRO rather than jumping into a round', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    expect(h.room.game.phase).toBe('ROUND_INTRO');
  });

  it('refuses to start in a closed room', () => {
    const h = makeRoom();
    h.host(ROOM_INTENTS.HOST_CLOSE_ROOM);
    expect(h.host(GAME_INTENTS.START_GAME).ack.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BB
// ---------------------------------------------------------------------------

describe('BB through the engine', () => {
  it('awards, deducts and floors at 0, keeping the entries separate', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);

    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: 500 });
    expect(h.room.game.balanceOf(TEAM_A)).toBe(1_500);

    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: -300 });
    expect(h.room.game.balanceOf(TEAM_A)).toBe(1_200);

    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: -5_000 });
    expect(h.room.game.balanceOf(TEAM_A)).toBe(0);

    const entries = h.room.game.ledgerEntries.filter((entry) => entry.teamId === TEAM_A);
    expect(entries.map((entry) => entry.balanceAfter)).toEqual([1_000, 1_500, 1_200, 0]);
  });

  it('leaves the other team untouched', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: -1_000 });

    expect(h.room.game.balanceOf(TEAM_A)).toBe(0);
    expect(h.room.game.balanceOf(TEAM_B)).toBe(1_000);
  });

  it('says on the wire when the floor clamped a deduction', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    const outcome = h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: -9_000 });

    const event = outcome.broadcast.find((e) => e.type === GAME_EVENTS.BB_CHANGED);
    const payload = event?.payload as { clampedAtFloor: boolean; applied: number; balance: number };
    expect(payload.clampedAtFloor).toBe(true);
    expect(payload.applied).toBe(-1_000);
    expect(payload.balance).toBe(0);
  });

  it('does not double-apply a duplicated award intent', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);

    const award = intent(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: 500 });
    h.room.handle(HOST, award);
    const replay = h.room.handle(HOST, award);

    expect(replay.ack.ok).toBe(false);
    expect(h.room.game.balanceOf(TEAM_A)).toBe(1_500);
  });

  it('refuses a player who tries to award BB', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    const outcome = h.room.handle(
      PHONE_1,
      intent(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: 10_000 }),
    );

    expect(outcome.ack.ok).toBe(false);
    expect(h.room.game.balanceOf(TEAM_A)).toBe(1_000);
  });

  it('refuses development BB controls when dev tools are off', () => {
    const h = makeRoom({ devTools: false });
    h.host(GAME_INTENTS.START_GAME);
    const outcome = h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: 500 });

    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('ILLEGAL_ACTION');
    expect(h.room.game.balanceOf(TEAM_A)).toBe(1_000);
  });

  it('marks development adjustments so they can never look like earned BB', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: 500 });

    const last = h.room.game.ledgerEntries.at(-1);
    expect(last?.reason).toBe('dev_adjustment');
  });

  it('rejects BB for a team that is not playing', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    const outcome = h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_C', delta: 500 });

    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('NOT_FOUND');
  });

  it('refuses BB changes before the game starts', () => {
    const h = makeRoom();
    expect(h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: 500 }).ack.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Challenge lifecycle
// ---------------------------------------------------------------------------

describe('challenge lifecycle', () => {
  it('runs prepare -> start -> review -> resolve', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'CHALLENGE_INTRO' });

    expect(h.host(GAME_INTENTS.HOST_PREPARE_CHALLENGE, { challengeType: 'TEST' }).ack.ok).toBe(true);
    expect(h.room.game.challengeView()?.status).toBe('pending');

    expect(h.host(GAME_INTENTS.HOST_START_CHALLENGE).ack.ok).toBe(true);
    expect(h.room.game.challengeView()?.status).toBe('active');
    expect(h.room.game.phase).toBe('ACTIVE_PLAY');

    expect(h.host(GAME_INTENTS.HOST_REQUEST_REVIEW).ack.ok).toBe(true);
    expect(h.room.game.challengeView()?.status).toBe('awaiting_host');
    expect(h.room.game.phase).toBe('HOST_REVIEW');

    expect(h.host(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, {}).ack.ok).toBe(true);
    expect(h.room.game.challengeView()?.status).toBe('resolved');
    expect(h.room.game.phase).toBe('RESULT');
  });

  it('refuses to prepare a challenge outside CHALLENGE_INTRO', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    // Still in ROUND_INTRO.
    const outcome = h.host(GAME_INTENTS.HOST_PREPARE_CHALLENGE, { challengeType: 'TEST' });

    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('WRONG_STATE');
  });

  it('refuses to start a challenge that was never prepared', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    const outcome = h.host(GAME_INTENTS.HOST_START_CHALLENGE);

    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('NOT_FOUND');
  });

  it('refuses to start the same challenge twice', () => {
    const h = makeRoom();
    startChallenge(h);
    const outcome = h.host(GAME_INTENTS.HOST_START_CHALLENGE);

    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('ILLEGAL_ACTION');
  });

  it('refuses to prepare a second challenge while one is running', () => {
    const h = makeRoom();
    startChallenge(h);
    const outcome = h.host(GAME_INTENTS.HOST_PREPARE_CHALLENGE, { challengeType: 'OTHER' });
    expect(outcome.ack.ok).toBe(false);
  });

  it('applies BB through the ledger when resolving', () => {
    const h = makeRoom();
    startChallenge(h);
    h.host(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, {
      winningTeamIds: ['TEAM_A'],
      bbDeltas: { TEAM_A: 500 },
    });

    expect(h.room.game.balanceOf(TEAM_A)).toBe(1_500);
    const entry = h.room.game.ledgerEntries.at(-1);
    expect(entry?.reason).toBe('challenge_result');
    // The award is attached to the challenge that earned it.
    expect(entry?.challengeId).not.toBeNull();
  });

  it('floors a resolution that would take a team below zero', () => {
    const h = makeRoom();
    startChallenge(h);
    h.host(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, { bbDeltas: { TEAM_B: -4_000 } });

    expect(h.room.game.balanceOf(TEAM_B)).toBe(0);
  });

  it('refuses to resolve the same challenge twice', () => {
    const h = makeRoom();
    startChallenge(h);
    expect(h.host(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, { bbDeltas: { TEAM_A: 500 } }).ack.ok).toBe(true);

    const second = h.host(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, { bbDeltas: { TEAM_A: 500 } });
    expect(second.ack.ok).toBe(false);
    if (!second.ack.ok) expect(second.ack.error.code).toBe('WRONG_STATE');
    // The award happened once, not twice.
    expect(h.room.game.balanceOf(TEAM_A)).toBe(1_500);
  });

  it('does not double-award a duplicated resolution intent', () => {
    const h = makeRoom();
    startChallenge(h);
    const resolve = intent(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, { bbDeltas: { TEAM_A: 500 } });

    h.room.handle(HOST, resolve);
    h.room.handle(HOST, resolve);

    expect(h.room.game.balanceOf(TEAM_A)).toBe(1_500);
  });

  it('applies nothing when one team in a result is unknown', () => {
    const h = makeRoom();
    startChallenge(h);
    const outcome = h.host(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, {
      bbDeltas: { TEAM_A: 500, TEAM_C: 500 },
    });

    expect(outcome.ack.ok).toBe(false);
    // Validation completes before anything is applied, so TEAM_A is not paid
    // while TEAM_C fails.
    expect(h.room.game.balanceOf(TEAM_A)).toBe(1_000);
    expect(h.room.game.challengeView()?.status).toBe('active');
  });

  it('clears turn and active players when a challenge resolves', () => {
    const h = makeRoom();
    startChallenge(h);
    h.host(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, {});

    expect(h.room.game.turn.teamId).toBeNull();
    expect(h.room.game.activePlayerIds()).toEqual([]);
  });

  it('does not carry stale turn or active players into a new challenge', () => {
    const h = makeRoom();
    startChallenge(h);
    h.host(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, {});
    h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'CHALLENGE_INTRO' });
    h.host(GAME_INTENTS.HOST_PREPARE_CHALLENGE, { challengeType: 'SECOND' });

    expect(h.room.game.activePlayerIds()).toEqual([]);
    expect(h.room.game.turn.playerId).toBeNull();
  });

  it('carries no game content in a challenge view', () => {
    const h = makeRoom();
    startChallenge(h);
    const view = h.room.game.challengeView();

    // CONTENT_POLICY.md — a configRef points at configuration; there is nowhere
    // to put question text, an accepted answer or a board label.
    expect(Object.keys(view ?? {})).not.toContain('question');
    expect(Object.keys(view ?? {})).not.toContain('answers');
    expect(view?.configRef).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Turn ownership and active players
// ---------------------------------------------------------------------------

describe('turn ownership', () => {
  it('assigns a team turn', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    expect(h.host(GAME_INTENTS.HOST_SET_TURN, { teamId: 'TEAM_A' }).ack.ok).toBe(true);
    expect(h.room.game.turn).toEqual({ teamId: 'TEAM_A', playerId: null });
  });

  it('assigns a player turn within their team', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    expect(h.host(GAME_INTENTS.HOST_SET_TURN, { teamId: 'TEAM_A', playerId: h.p1 }).ack.ok).toBe(true);
    expect(h.room.game.turn.playerId).toBe(h.p1);
  });

  it('refuses a player turn on a team the player is not on', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    const outcome = h.host(GAME_INTENTS.HOST_SET_TURN, { teamId: 'TEAM_B', playerId: h.p1 });

    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('ILLEGAL_ACTION');
  });

  it('refuses a player turn with no team', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    expect(h.host(GAME_INTENTS.HOST_SET_TURN, { playerId: h.p1 }).ack.ok).toBe(false);
  });

  it('refuses a turn for an unknown team', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    const outcome = h.host(GAME_INTENTS.HOST_SET_TURN, { teamId: 'TEAM_Z' });
    expect(outcome.ack.ok).toBe(false);
  });

  it('does not let a player give themselves a turn', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    const outcome = h.room.handle(
      PHONE_2,
      intent(GAME_INTENTS.HOST_SET_TURN, { teamId: 'TEAM_B', playerId: h.p2 }),
    );

    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('UNAUTHORIZED_ACTOR');
    expect(h.room.game.turn.teamId).toBeNull();
  });

  it('clears a turn back to nobody', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    h.host(GAME_INTENTS.HOST_SET_TURN, { teamId: 'TEAM_A' });
    h.host(GAME_INTENTS.HOST_SET_TURN, {});
    expect(h.room.game.turn.teamId).toBeNull();
  });
});

describe('active players', () => {
  it('marks a player active', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    h.host(GAME_INTENTS.HOST_SET_ACTIVE_PLAYERS, { playerIds: [h.p1] });

    expect(h.room.game.isActivePlayer(h.p1)).toBe(true);
    expect(h.room.game.isActivePlayer(h.p2)).toBe(false);
  });

  it('refuses an unknown player', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    const outcome = h.host(GAME_INTENTS.HOST_SET_ACTIVE_PLAYERS, { playerIds: ['nobody'] });

    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('NOT_FOUND');
  });

  it('does not let a player mark themselves active', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    const outcome = h.room.handle(
      PHONE_1,
      intent(GAME_INTENTS.HOST_SET_ACTIVE_PLAYERS, { playerIds: [h.p1] }),
    );
    expect(outcome.ack.ok).toBe(false);
    expect(h.room.game.isActivePlayer(h.p1)).toBe(false);
  });

  it('replaces the set rather than adding to it', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    h.host(GAME_INTENTS.HOST_SET_ACTIVE_PLAYERS, { playerIds: [h.p1] });
    h.host(GAME_INTENTS.HOST_SET_ACTIVE_PLAYERS, { playerIds: [h.p2] });

    expect(h.room.game.isActivePlayer(h.p1)).toBe(false);
    expect(h.room.game.isActivePlayer(h.p2)).toBe(true);
  });

  it('drops a removed player from the active set and the turn', () => {
    const h = makeRoom();
    startChallenge(h);
    h.host(ROOM_INTENTS.HOST_REMOVE_PLAYER, { playerId: h.p1 });

    expect(h.room.game.isActivePlayer(h.p1)).toBe(false);
    expect(h.room.game.turn.playerId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

describe('timers through the engine', () => {
  it('starts a timer and reports remaining time', () => {
    const h = makeRoom();
    startChallenge(h, 30_000);

    expect(h.room.game.timerView()?.remainingMs).toBe(30_000);
    h.clock.advance(10_000);
    expect(h.room.game.timerView()?.remainingMs).toBe(20_000);
  });

  it('emits TIMER_EXPIRED once, on a tick, and asks the Host to decide', () => {
    const h = makeRoom();
    startChallenge(h, 5_000);

    expect(h.room.tick()).toEqual([]);
    h.clock.advance(5_000);

    const expired = h.room.tick();
    expect(types(expired)).toEqual([GAME_EVENTS.TIMER_EXPIRED]);
    // Phase 5 spec §13 — expiry states a fact and hands over; it does not
    // decide that time ran out means a wrong answer.
    expect((expired[0]?.payload as { requiresHostDecision: boolean }).requiresHostDecision).toBe(true);
    expect(h.room.game.phase).toBe('HOST_REVIEW');

    expect(h.room.tick()).toEqual([]);
  });

  it('refuses to start a timer while paused', () => {
    const h = makeRoom();
    startChallenge(h);
    h.host(GAME_INTENTS.HOST_PAUSE_GAME);

    expect(h.host(GAME_INTENTS.HOST_START_TIMER, { durationMs: 10_000 }).ack.ok).toBe(false);
  });

  it('does not expire a paused timer, however long the pause', () => {
    const h = makeRoom();
    startChallenge(h, 10_000);
    h.clock.advance(4_000);
    h.host(GAME_INTENTS.HOST_PAUSE_GAME);

    h.clock.advance(1_000_000);
    expect(h.room.tick()).toEqual([]);
    expect(h.room.game.timerView()?.remainingMs).toBe(6_000);
  });

  it('rejects a non-positive duration', () => {
    const h = makeRoom();
    startChallenge(h);
    expect(h.host(GAME_INTENTS.HOST_START_TIMER, { durationMs: 0 }).ack.ok).toBe(false);
    expect(h.host(GAME_INTENTS.HOST_START_TIMER, { durationMs: 'soon' }).ack.ok).toBe(false);
  });

  it('cancels a running timer', () => {
    const h = makeRoom();
    startChallenge(h);
    expect(h.host(GAME_INTENTS.HOST_CANCEL_TIMER).ack.ok).toBe(true);
    expect(h.room.game.timerView()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Disconnect, pause and resume — D-011
// ---------------------------------------------------------------------------

describe('auto-pause on an active player disconnect', () => {
  it('pauses automatically and freezes the timer', () => {
    const h = makeRoom();
    startChallenge(h, 30_000);
    h.clock.advance(10_000);

    const events = h.room.onDisconnect(PHONE_1);

    expect(types(events)).toEqual(['PLAYER_DISCONNECTED', GAME_EVENTS.GAME_PAUSED]);
    expect(h.room.game.paused).toBe(true);
    expect(h.room.game.timerView()?.remainingMs).toBe(20_000);

    // Wall-clock time keeps running; the deadline must not.
    h.clock.advance(500_000);
    expect(h.room.game.timerView()?.remainingMs).toBe(20_000);
  });

  it('records why the game paused', () => {
    const h = makeRoom();
    startChallenge(h);
    h.room.onDisconnect(PHONE_1);

    const pause = h.room.game.sessionView()?.pause;
    expect(pause?.reason).toBe('player_disconnect');
    expect(pause?.pausedByPlayerId).toBe(h.p1);
    expect(pause?.resumePhase).toBe('ACTIVE_PLAY');
  });

  it('does NOT pause when a non-active player disconnects', () => {
    const h = makeRoom();
    startChallenge(h);

    const events = h.room.onDisconnect(PHONE_2);

    expect(types(events)).toEqual(['PLAYER_DISCONNECTED']);
    expect(h.room.game.paused).toBe(false);
    // Their connection state still updates.
    expect(h.room.player(h.p2)?.connection).toBe('disconnected');
  });

  it('does NOT pause in the lobby, where there is no gameplay', () => {
    const h = makeRoom();
    const events = h.room.onDisconnect(PHONE_1);

    expect(types(events)).toEqual(['PLAYER_DISCONNECTED']);
    expect(h.room.game.paused).toBe(false);
  });

  it('does NOT pause when the Host disconnects, and invents no rule', () => {
    const h = makeRoom();
    startChallenge(h);

    const events = h.room.onDisconnect(HOST);

    expect(types(events)).toEqual(['HOST_CONNECTION_CHANGED']);
    expect(h.room.game.paused).toBe(false);
  });

  it('reconnecting does not resume', () => {
    const h = makeRoom();
    startChallenge(h);
    h.room.onDisconnect(PHONE_1);

    const token = h.room.playerPrivate(h.p1)?.reconnectToken ?? '';
    h.room.onConnect('conn-p1b');
    const outcome = h.room.handle(
      'conn-p1b',
      intent(ROOM_INTENTS.RECONNECT_PLAYER, { playerId: h.p1, reconnectToken: token }),
    );

    expect(outcome.ack.ok).toBe(true);
    expect(h.room.player(h.p1)?.connection).toBe('connected');
    // D-011 — reconnection alone can never leave PAUSED.
    expect(h.room.game.paused).toBe(true);
  });

  it('only the Host can resume', () => {
    const h = makeRoom();
    startChallenge(h);
    h.room.onDisconnect(PHONE_1);

    const byPlayer = h.room.handle(PHONE_2, intent(GAME_INTENTS.HOST_RESUME_GAME));
    expect(byPlayer.ack.ok).toBe(false);
    expect(h.room.game.paused).toBe(true);

    const byHost = h.host(GAME_INTENTS.HOST_RESUME_GAME);
    expect(byHost.ack.ok).toBe(true);
    expect(h.room.game.paused).toBe(false);
  });

  it('resumes to the interrupted phase with the challenge and turn intact', () => {
    const h = makeRoom();
    startChallenge(h, 30_000);
    const challengeId = h.room.game.challengeView()?.challengeId;

    h.clock.advance(12_000);
    h.room.onDisconnect(PHONE_1);
    h.clock.advance(300_000);
    h.host(GAME_INTENTS.HOST_RESUME_GAME);

    expect(h.room.game.phase).toBe('ACTIVE_PLAY');
    expect(h.room.game.challengeView()?.challengeId).toBe(challengeId);
    expect(h.room.game.turn.playerId).toBe(h.p1);
    // Continues from what was left, not from zero.
    expect(h.room.game.timerView()?.remainingMs).toBe(18_000);
  });

  it('the Host may resume without the player coming back', () => {
    const h = makeRoom();
    startChallenge(h);
    h.room.onDisconnect(PHONE_1);

    expect(h.host(GAME_INTENTS.HOST_RESUME_GAME).ack.ok).toBe(true);
    expect(h.room.game.paused).toBe(false);
    expect(h.room.player(h.p1)?.connection).toBe('disconnected');
  });

  it('a second disconnect while paused does not corrupt the return state', () => {
    const h = makeRoom();
    startChallenge(h, 30_000);
    h.host(GAME_INTENTS.HOST_SET_ACTIVE_PLAYERS, { playerIds: [h.p1, h.p2] });
    h.clock.advance(10_000);

    h.room.onDisconnect(PHONE_1);
    const first = h.room.game.sessionView()?.pause;

    const secondEvents = h.room.onDisconnect(PHONE_2);
    // No second pause is nested; the original capture survives.
    expect(types(secondEvents)).toEqual(['PLAYER_DISCONNECTED']);
    expect(h.room.game.sessionView()?.pause?.pausedByPlayerId).toBe(first?.pausedByPlayerId);
    expect(h.room.game.sessionView()?.pause?.resumePhase).toBe('ACTIVE_PLAY');

    h.host(GAME_INTENTS.HOST_RESUME_GAME);
    expect(h.room.game.phase).toBe('ACTIVE_PLAY');
    expect(h.room.game.timerView()?.remainingMs).toBe(20_000);
  });

  it('refuses to resume a game that is not paused', () => {
    const h = makeRoom();
    startChallenge(h);
    expect(h.host(GAME_INTENTS.HOST_RESUME_GAME).ack.ok).toBe(false);
  });

  it('refuses to pause an already-paused game', () => {
    const h = makeRoom();
    startChallenge(h);
    h.host(GAME_INTENTS.HOST_PAUSE_GAME);
    expect(h.host(GAME_INTENTS.HOST_PAUSE_GAME).ack.ok).toBe(false);
  });

  it('refuses ordinary progress while paused', () => {
    const h = makeRoom();
    startChallenge(h);
    h.host(GAME_INTENTS.HOST_PAUSE_GAME);

    const outcome = h.host(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, { bbDeltas: { TEAM_A: 500 } });
    expect(outcome.ack.ok).toBe(false);
    expect(h.room.game.balanceOf(TEAM_A)).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// Host judgment
// ---------------------------------------------------------------------------

describe('Host rulings', () => {
  it('records a ruling against the challenge', () => {
    const h = makeRoom();
    startChallenge(h);
    const outcome = h.host(GAME_INTENTS.HOST_RULING, { kind: 'valid', teamId: 'TEAM_A' });

    expect(outcome.ack.ok).toBe(true);
    const rulings = h.room.game.challengeView()?.rulings ?? [];
    expect(rulings).toHaveLength(1);
    expect(rulings[0]?.kind).toBe('valid');
    expect(rulings[0]?.teamId).toBe('TEAM_A');
  });

  it('records a selected winner', () => {
    const h = makeRoom();
    startChallenge(h);
    h.host(GAME_INTENTS.HOST_RULING, { kind: 'select_winner', teamId: 'TEAM_B' });

    expect(h.room.game.challengeView()?.rulings.at(-1)?.kind).toBe('select_winner');
  });

  it('refuses a ruling from a player', () => {
    const h = makeRoom();
    startChallenge(h);
    const outcome = h.room.handle(
      PHONE_1,
      intent(GAME_INTENTS.HOST_RULING, { kind: 'valid', teamId: 'TEAM_A' }),
    );

    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('UNAUTHORIZED_ACTOR');
    expect(h.room.game.challengeView()?.rulings).toHaveLength(0);
  });

  it('refuses an unknown ruling kind', () => {
    const h = makeRoom();
    startChallenge(h);
    const outcome = h.host(GAME_INTENTS.HOST_RULING, { kind: 'correct', teamId: 'TEAM_A' });
    expect(outcome.ack.ok).toBe(false);
  });

  it('refuses a ruling about an unknown team', () => {
    const h = makeRoom();
    startChallenge(h);
    expect(h.host(GAME_INTENTS.HOST_RULING, { kind: 'valid', teamId: 'TEAM_Z' }).ack.ok).toBe(false);
  });

  it('does not award BB by itself', () => {
    const h = makeRoom();
    startChallenge(h);
    h.host(GAME_INTENTS.HOST_RULING, { kind: 'valid', teamId: 'TEAM_A' });

    // A ruling says what the Host judged. What it is worth is decided when the
    // challenge resolves, against rules that mostly are not written yet.
    expect(h.room.game.balanceOf(TEAM_A)).toBe(1_000);
  });

  it('does not record a duplicated ruling twice', () => {
    const h = makeRoom();
    startChallenge(h);
    const ruling = intent(GAME_INTENTS.HOST_RULING, { kind: 'valid', teamId: 'TEAM_A' });

    h.room.handle(HOST, ruling);
    h.room.handle(HOST, ruling);

    expect(h.room.game.challengeView()?.rulings).toHaveLength(1);
  });

  it('refuses a ruling on a resolved challenge', () => {
    const h = makeRoom();
    startChallenge(h);
    h.host(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, {});
    expect(h.host(GAME_INTENTS.HOST_RULING, { kind: 'valid', teamId: 'TEAM_A' }).ack.ok).toBe(false);
  });

  it('stamps every ruling with the sequence of the event that carried it', () => {
    const h = makeRoom();
    startChallenge(h);
    const outcome = h.host(GAME_INTENTS.HOST_RULING, { kind: 'note', note: 'checked' });

    const seq = outcome.ack.ok ? outcome.ack.value.seq : -1;
    expect(h.room.game.challengeView()?.rulings.at(-1)?.seq).toBe(seq);
  });
});

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

describe('game snapshots', () => {
  it('gives the Host the ledger', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);

    const snapshot = h.room.gameSnapshot(HOST);
    expect(isHostGameSnapshot(snapshot)).toBe(true);
    expect((snapshot as HostGameSnapshot).ledger.length).toBeGreaterThan(0);
  });

  it('does NOT give a player the ledger', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);

    const snapshot = h.room.gameSnapshot(PHONE_1);
    expect(snapshot.isHost).toBe(false);
    expect('ledger' in snapshot).toBe(false);
    expect('devToolsEnabled' in snapshot).toBe(false);
  });

  it('never carries a reconnect credential or the Host token', () => {
    const h = makeRoom();
    startChallenge(h);

    for (const connection of [HOST, PHONE_1, PHONE_2]) {
      const json = JSON.stringify(h.room.gameSnapshot(connection));
      expect(json).not.toContain('reconnectToken');
      expect(json).not.toContain('host-token');
      expect(json).not.toContain('token-');
    }
  });

  it('tells a player who they are, their team and their balance', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);

    const snapshot = h.room.gameSnapshot(PHONE_1) as PlayerGameSnapshot;
    expect(snapshot.you).toBe(h.p1);
    expect(snapshot.yourTeamId).toBe('TEAM_A');
    expect(snapshot.teams.find((t) => t.teamId === TEAM_A)?.bb).toBe(1_000);
  });

  it('tells a player when it is their turn and when they are active', () => {
    const h = makeRoom();
    startChallenge(h);

    const mine = h.room.gameSnapshot(PHONE_1) as PlayerGameSnapshot;
    expect(mine.yourTurn).toBe(true);
    expect(mine.youAreActive).toBe(true);

    const theirs = h.room.gameSnapshot(PHONE_2) as PlayerGameSnapshot;
    expect(theirs.yourTurn).toBe(false);
    expect(theirs.youAreActive).toBe(false);
  });

  it('treats a team turn as every member of that team', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    h.host(GAME_INTENTS.HOST_SET_TURN, { teamId: 'TEAM_B' });

    expect((h.room.gameSnapshot(PHONE_2) as PlayerGameSnapshot).yourTurn).toBe(true);
    expect((h.room.gameSnapshot(PHONE_1) as PlayerGameSnapshot).yourTurn).toBe(false);
  });

  it('gives an unidentified connection the player-safe shape', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);

    // Defaulting to the narrower view means a new caller cannot accidentally
    // receive the Host's.
    expect(h.room.gameSnapshot('conn-unknown').isHost).toBe(false);
  });

  it('reports no game before START_GAME, and no provisional balances', () => {
    const h = makeRoom();
    const snapshot = h.room.gameSnapshot(HOST);

    expect(snapshot.game).toBeNull();
    expect(snapshot.teams.every((team) => team.bb === 0)).toBe(true);
  });

  it('reports the pause state to both Host and players', () => {
    const h = makeRoom();
    startChallenge(h);
    h.room.onDisconnect(PHONE_1);

    expect(h.room.gameSnapshot(HOST).game?.paused).toBe(true);
    expect(h.room.gameSnapshot(PHONE_2).game?.paused).toBe(true);
  });

  it('is a read: REQUEST_GAME_SNAPSHOT consumes no sequence number', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    const before = h.room.seq;

    const outcome = h.room.handle(PHONE_1, intent(GAME_INTENTS.REQUEST_GAME_SNAPSHOT));

    expect(outcome.ack.ok).toBe(true);
    expect(outcome.broadcast).toEqual([]);
    expect(h.room.seq).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Sequence and recovery
// ---------------------------------------------------------------------------

describe('sequence and recovery', () => {
  it('shares one monotonic sequence across lobby and gameplay events', () => {
    const h = makeRoom();
    startChallenge(h);
    h.room.onDisconnect(PHONE_1);

    const all = h.room.events();
    const seqs = all.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // Both kinds are present in one ordered stream.
    expect(types(all)).toContain('PLAYER_JOINED');
    expect(types(all)).toContain(GAME_EVENTS.GAME_STARTED);
    expect(types(all)).toContain(GAME_EVENTS.GAME_PAUSED);
  });

  it('a rejected intent consumes no sequence number', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    const before = h.room.seq;

    h.room.handle(PHONE_1, intent(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: 9_999 }));

    expect(h.room.seq).toBe(before);
  });

  it('restores state from a snapshot after a reconnect', () => {
    const h = makeRoom();
    startChallenge(h, 30_000);
    h.host(GAME_INTENTS.DEV_ADJUST_BB, { teamId: 'TEAM_A', delta: -5_000 });
    h.clock.advance(10_000);
    h.room.onDisconnect(PHONE_1);

    const token = h.room.playerPrivate(h.p1)?.reconnectToken ?? '';
    h.room.onConnect('conn-p1b');
    h.room.handle(
      'conn-p1b',
      intent(ROOM_INTENTS.RECONNECT_PLAYER, { playerId: h.p1, reconnectToken: token }),
    );

    const snapshot = h.room.gameSnapshot('conn-p1b') as PlayerGameSnapshot;
    expect(snapshot.you).toBe(h.p1);
    expect(snapshot.yourTeamId).toBe('TEAM_A');
    // The floor held across the reconnect; the balance is not recomputed by the
    // client.
    expect(snapshot.teams.find((t) => t.teamId === TEAM_A)?.bb).toBe(0);
    expect(snapshot.game?.paused).toBe(true);
    expect(snapshot.game?.challenge?.timer?.remainingMs).toBe(20_000);
  });

  it('does not create a second game when the Host reconnects', () => {
    const h = makeRoom();
    startChallenge(h);
    const gameId = h.room.game.sessionView()?.gameId;
    h.room.onDisconnect(HOST);

    h.room.onConnect('conn-host2');
    h.room.handle('conn-host2', intent(ROOM_INTENTS.RECONNECT_HOST, { hostToken: 'host-token' }));

    const snapshot = h.room.gameSnapshot('conn-host2');
    expect(snapshot.game?.gameId).toBe(gameId);
    expect(snapshot.teams.find((t) => t.teamId === TEAM_A)?.bb).toBe(1_000);
    expect(snapshot.isHost).toBe(true);
  });

  it('keeps events replayable from a sequence number', () => {
    const h = makeRoom();
    const mark = h.room.seq;
    startChallenge(h);

    const since = h.room.eventsSince(mark);
    expect(types(since)).toContain(GAME_EVENTS.GAME_STARTED);
    expect(since.every((event) => event.seq > mark)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

describe('generic phase transitions', () => {
  it('walks the documented generic path', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    expect(h.room.game.phase).toBe('ROUND_INTRO');

    h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'CHALLENGE_INTRO' });
    h.host(GAME_INTENTS.HOST_PREPARE_CHALLENGE, { challengeType: 'TEST' });
    h.host(GAME_INTENTS.HOST_START_CHALLENGE);
    expect(h.room.game.phase).toBe('ACTIVE_PLAY');

    h.host(GAME_INTENTS.HOST_REQUEST_REVIEW);
    expect(h.room.game.phase).toBe('HOST_REVIEW');

    h.host(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, {});
    expect(h.room.game.phase).toBe('RESULT');

    h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'ROUND_COMPLETE' });
    expect(h.room.game.phase).toBe('ROUND_COMPLETE');
  });

  it('refuses an illegal transition', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    // ROUND_INTRO -> ACTIVE_PLAY is not in the table.
    const outcome = h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'ACTIVE_PLAY' });

    expect(outcome.ack.ok).toBe(false);
    if (!outcome.ack.ok) expect(outcome.ack.error.code).toBe('ILLEGAL_ACTION');
    expect(h.room.game.phase).toBe('ROUND_INTRO');
  });

  it('refuses an unknown phase name', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    expect(h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'ROUND_ONE' }).ack.ok).toBe(false);
  });

  it('does not force MARKET into the first round', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    // ROUND_INTRO -> CHALLENGE_INTRO directly is legal; §10 opens the Market
    // before Rounds 2, 3 and 4 only, so nothing here requires it.
    expect(h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'CHALLENGE_INTRO' }).ack.ok).toBe(true);
  });

  it('counts rounds without deciding what a round contains', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    expect(h.room.game.sessionView()?.roundIndex).toBe(1);

    h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'CHALLENGE_INTRO' });
    h.host(GAME_INTENTS.HOST_PREPARE_CHALLENGE, { challengeType: 'TEST' });
    h.host(GAME_INTENTS.HOST_START_CHALLENGE);
    h.host(GAME_INTENTS.HOST_RESOLVE_CHALLENGE, {});
    h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'ROUND_COMPLETE' });
    h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'ROUND_INTRO' });

    expect(h.room.game.sessionView()?.roundIndex).toBe(2);
  });

  it('refuses gameplay intents before the game starts', () => {
    const h = makeRoom();
    for (const type of [
      GAME_INTENTS.HOST_ADVANCE_PHASE,
      GAME_INTENTS.HOST_START_CHALLENGE,
      GAME_INTENTS.HOST_SET_TURN,
      GAME_INTENTS.HOST_START_TIMER,
      GAME_INTENTS.HOST_PAUSE_GAME,
    ]) {
      expect(h.host(type, { to: 'CHALLENGE_INTRO', durationMs: 1_000 }).ack.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Things Phase 5 must NOT have decided
// ---------------------------------------------------------------------------

describe('open rules are not resolved', () => {
  it('accepts any challenge type without knowing what it means', () => {
    const h = makeRoom();
    h.host(GAME_INTENTS.START_GAME);
    h.host(GAME_INTENTS.HOST_ADVANCE_PHASE, { to: 'CHALLENGE_INTRO' });

    // challengeType is a plain string precisely so that fixing the set now does
    // not imply a decision about round composition (OPEN_RULES.md §1).
    const outcome = h.host(GAME_INTENTS.HOST_PREPARE_CHALLENGE, { challengeType: 'ANYTHING_AT_ALL' });
    expect(outcome.ack.ok).toBe(true);
    expect(h.room.game.challengeView()?.challengeType).toBe('ANYTHING_AT_ALL');
  });

  it('defines no default challenge duration', () => {
    const h = makeRoom();
    startChallenge(h);
    h.host(GAME_INTENTS.HOST_CANCEL_TIMER);

    // Nothing starts a timer on its own, because no locked rule says how long
    // any challenge lasts (OPEN_RULES.md §2, §6, §11).
    expect(h.room.game.timerView()).toBeNull();
  });

  it('attaches no consequence to an expired timer', () => {
    const h = makeRoom();
    startChallenge(h, 1_000);
    h.clock.advance(1_000);
    h.room.tick();

    // No BB moved, nobody lost, nothing was marked wrong.
    expect(h.room.game.balanceOf(TEAM_A)).toBe(1_000);
    expect(h.room.game.balanceOf(TEAM_B)).toBe(1_000);
    expect(h.room.game.challengeView()?.result).toBeNull();
  });
});
