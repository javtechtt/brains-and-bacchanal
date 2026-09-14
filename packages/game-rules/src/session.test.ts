import { beforeEach, describe, expect, it } from 'vitest';
import {
  asIntentId,
  asPlayerId,
  asRoomId,
  asSequenceNumber,
  asSessionId,
  asTeamId,
  PROTOCOL_VERSION,
  type Actor,
  type IntentEnvelope,
} from '@bb/protocol';
import { FakeClock } from './clock.js';
import { GameSession } from './session.js';
import { STARTING_BB } from './bb.js';

const ROOM = asRoomId('room-1');
const HOST: Actor = { kind: 'host', sessionId: asSessionId('s-host') };
const PLAYER: Actor = { kind: 'player', sessionId: asSessionId('s-p1'), playerId: asPlayerId('p1') };

let clock: FakeClock;
let session: GameSession;
let counter = 0;

beforeEach(() => {
  clock = new FakeClock(1_000);
  session = new GameSession(ROOM, 'ABCD', 'local_party', clock);
  counter = 0;
});

function intent(type: string, payload: unknown = {}): IntentEnvelope {
  counter += 1;
  return {
    protocolVersion: PROTOCOL_VERSION,
    intentId: asIntentId(`intent-${counter}`),
    roomId: ROOM,
    type,
    payload,
  };
}

function advanceTo(phase: string, actor: Actor = HOST): void {
  const outcome = session.submit(intent('ADVANCE_PHASE', { to: phase }), actor);
  if (!outcome.ok) throw new Error(`could not advance to ${phase}: ${outcome.error.code}`);
}

describe('session setup', () => {
  it('starts at BOOT with no events', () => {
    expect(session.phase).toBe('BOOT');
    expect(session.events()).toHaveLength(0);
  });

  it('seeds each team with the locked starting balance', () => {
    // GAME_RULES_LOCKED.md §1 — "Each team begins with 1,000 BB."
    const team = session.addTeam(asTeamId('t1'), 'Team One');
    expect(team.bb).toBe(STARTING_BB);
    expect(team.bb).toBe(1_000);
    expect(team.status).toBe('active');
  });

  it('adds players to their team', () => {
    session.addTeam(asTeamId('t1'), 'Team One');
    session.addPlayer(asPlayerId('p1'), 'Ayo', 'player', asTeamId('t1'));

    expect(session.team(asTeamId('t1'))?.memberIds).toEqual([asPlayerId('p1')]);
    expect(session.player(asPlayerId('p1'))?.teamId).toBe(asTeamId('t1'));
  });

  it('allows a Host with no team', () => {
    const host = session.addPlayer(asPlayerId('h1'), 'Host', 'host', null);
    expect(host.teamId).toBeNull();
    expect(host.role).toBe('host');
  });
});

describe('sequence numbers', () => {
  it('assigns monotonically increasing numbers', () => {
    advanceTo('LOBBY');
    advanceTo('TEAM_LOCK');
    advanceTo('ROUND_INTRO');

    const seqs = session.events().map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('never reuses a number after a rejected intent', () => {
    advanceTo('LOBBY');
    const rejected = session.submit(intent('ADVANCE_PHASE', { to: 'GAME_OVER' }), HOST);
    expect(rejected.ok).toBe(false);

    advanceTo('TEAM_LOCK');
    // The rejected intent consumed no sequence number.
    expect(session.events().map((e) => e.seq)).toEqual([1, 2]);
  });

  it('stamps every event with the server clock', () => {
    advanceTo('LOBBY');
    clock.advance(5_000);
    advanceTo('TEAM_LOCK');

    const [first, second] = session.events();
    expect(first?.serverTime).toBe(1_000);
    expect(second?.serverTime).toBe(6_000);
  });
});

describe('idempotency', () => {
  it('rejects a duplicate intent id', () => {
    const first = session.submit(intent('ADVANCE_PHASE', { to: 'LOBBY' }), HOST);
    expect(first.ok).toBe(true);

    // Same envelope submitted again, as a flaky phone would retry it.
    const replay: IntentEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      intentId: asIntentId('intent-1'),
      roomId: ROOM,
      type: 'ADVANCE_PHASE',
      payload: { to: 'TEAM_LOCK' },
    };
    const second = session.submit(replay, HOST);

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('DUPLICATE_INTENT');
  });

  it('does not apply a duplicate intent twice', () => {
    session.submit(intent('ADVANCE_PHASE', { to: 'LOBBY' }), HOST);
    const replay: IntentEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      intentId: asIntentId('intent-1'),
      roomId: ROOM,
      type: 'ADVANCE_PHASE',
      payload: { to: 'TEAM_LOCK' },
    };
    session.submit(replay, HOST);

    // The retry must not have advanced the phase or logged a second event.
    expect(session.phase).toBe('LOBBY');
    expect(session.events()).toHaveLength(1);
  });

  it('reports the sequence number of the original attempt', () => {
    session.submit(intent('ADVANCE_PHASE', { to: 'LOBBY' }), HOST);
    const replay: IntentEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      intentId: asIntentId('intent-1'),
      roomId: ROOM,
      type: 'ADVANCE_PHASE',
      payload: { to: 'LOBBY' },
    };
    const second = session.submit(replay, HOST);
    if (!second.ok) expect(second.error.details?.['originalSeq']).toBe(1);
  });

  it('does not deduplicate a rejected intent', () => {
    // A rejected intent was never applied, so retrying it must be allowed.
    const bad = intent('ADVANCE_PHASE', { to: 'GAME_OVER' });
    expect(session.submit(bad, HOST).ok).toBe(false);
    expect(session.submit(bad, HOST).ok).toBe(false);
  });
});

describe('protocol version enforcement', () => {
  it('rejects an incompatible client', () => {
    const outcome = session.submit(
      { ...intent('ADVANCE_PHASE', { to: 'LOBBY' }), protocolVersion: PROTOCOL_VERSION + 1 },
      HOST,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('UNSUPPORTED_PROTOCOL_VERSION');
  });

  it('rejects an intent for another room', () => {
    const outcome = session.submit(
      { ...intent('ADVANCE_PHASE', { to: 'LOBBY' }), roomId: asRoomId('other') },
      HOST,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('NOT_FOUND');
  });

  it('rejects an unknown intent type', () => {
    const outcome = session.submit(intent('PLAY_CARD', {}), HOST);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('INVALID_REQUEST');
  });

  it('rejects a malformed phase payload', () => {
    const outcome = session.submit(intent('ADVANCE_PHASE', { to: 'NOT_A_PHASE' }), HOST);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('INVALID_REQUEST');
  });
});

describe('pause and Host resume', () => {
  beforeEach(() => {
    advanceTo('LOBBY');
    advanceTo('TEAM_LOCK');
    advanceTo('ROUND_INTRO');
    advanceTo('CHALLENGE_INTRO');
    advanceTo('ACTIVE_PLAY');
  });

  it('pauses and records where to return to', () => {
    const outcome = session.submit(
      intent('PAUSE_GAME', { reason: 'player_disconnect' }),
      HOST,
    );
    expect(outcome.ok).toBe(true);
    expect(session.phase).toBe('PAUSED');

    const snap = session.snapshot();
    expect(snap.room.pause?.resumePhase).toBe('ACTIVE_PLAY');
    expect(snap.room.pause?.reason).toBe('player_disconnect');
  });

  it('blocks gameplay from advancing while paused', () => {
    session.submit(intent('PAUSE_GAME'), HOST);
    const outcome = session.submit(intent('ADVANCE_PHASE', { to: 'RESULT' }), HOST);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('WRONG_STATE');
    expect(session.phase).toBe('PAUSED');
  });

  it('lets only the Host resume', () => {
    session.submit(intent('PAUSE_GAME'), HOST);

    const byPlayer = session.submit(intent('HOST_RESUME_GAME'), PLAYER);
    expect(byPlayer.ok).toBe(false);
    if (!byPlayer.ok) expect(byPlayer.error.code).toBe('UNAUTHORIZED_ACTOR');
    expect(session.phase).toBe('PAUSED');

    const byHost = session.submit(intent('HOST_RESUME_GAME'), HOST);
    expect(byHost.ok).toBe(true);
    expect(session.phase).toBe('ACTIVE_PLAY');
  });

  it('clears the pause record on resume', () => {
    session.submit(intent('PAUSE_GAME'), HOST);
    session.submit(intent('HOST_RESUME_GAME'), HOST);
    expect(session.snapshot().room.pause).toBeNull();
  });
});

describe('event history', () => {
  it('records events in sequence order', () => {
    advanceTo('LOBBY');
    advanceTo('TEAM_LOCK');
    session.submit(intent('PAUSE_GAME'), HOST);
    session.submit(intent('HOST_RESUME_GAME'), HOST);

    expect(session.events().map((e) => e.type)).toEqual([
      'PHASE_ADVANCED',
      'PHASE_ADVANCED',
      'GAME_PAUSED',
      'GAME_RESUMED',
    ]);

    const seqs = session.events().map((e) => e.seq);
    expect([...seqs]).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('records the actor and the causing intent', () => {
    advanceTo('LOBBY');
    const [event] = session.events();
    expect(event?.actor).toEqual(HOST);
    expect(event?.causedBy).toBe(asIntentId('intent-1'));
  });

  it('returns only events after a given sequence number', () => {
    advanceTo('LOBBY');
    advanceTo('TEAM_LOCK');
    advanceTo('ROUND_INTRO');

    const since = session.eventsSince(asSequenceNumber(1));
    expect(since).toHaveLength(2);
    expect(since.every((e) => e.seq > 1)).toBe(true);
  });
});

describe('snapshot', () => {
  it('carries protocol version, sequence and state', () => {
    session.addTeam(asTeamId('t1'), 'Team One');
    session.addPlayer(asPlayerId('p1'), 'Ayo', 'player', asTeamId('t1'));
    advanceTo('LOBBY');

    const snap = session.snapshot();
    expect(snap.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(snap.seq).toBe(1);
    expect(snap.room.phase).toBe('LOBBY');
    expect(snap.teams).toHaveLength(1);
    expect(snap.players).toHaveLength(1);
    expect(snap.challenge).toBeNull();
  });

  it('reflects the sequence number a reconnecting client should resume from', () => {
    advanceTo('LOBBY');
    advanceTo('TEAM_LOCK');

    const snap = session.snapshot();
    expect(snap.seq).toBe(session.seq);
    // Nothing is newer than the snapshot, so a client needs no catch-up events.
    expect(session.eventsSince(snap.seq)).toHaveLength(0);
  });

  it('uses the injected clock for its timestamp', () => {
    clock.advance(9_000);
    expect(session.snapshot().takenAt).toBe(10_000);
  });
});
