import { describe, expect, it } from 'vitest';
import {
  asIntentId,
  asRoomId,
  GAME_INTENTS,
  PROTOCOL_VERSION,
  ROOM_INTENTS,
  SUDDEN_DEATH_INTENTS,
  type IntentEnvelope,
  type PlayerId,
  type SuddenDeathStateView,
} from '@bb/protocol';
import { FakeClock } from './clock.js';
import { Room, type RoomOutcome } from './room.js';

/**
 * Sudden Death. Phase 7D-B2. GAME_RULES_LOCKED.md §21, replaced by D-034.
 *
 * Driven through `Room`, exactly as `round4-room.test.ts` drives Round 4 —
 * authority, idempotency and timers are all part of what Sudden Death must
 * guarantee once wired into the production room, not just what the
 * standalone `SuddenDeath` engine (sudden-death.test.ts) guarantees alone.
 */

const HOST = 'conn-host';
const PHONE_1 = 'conn-p1';
const PHONE_2 = 'conn-p2';

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
  readonly players: readonly PlayerId[];
  host(type: string, payload?: unknown): RoomOutcome;
  player(phone: string, type: string, payload?: unknown): RoomOutcome;
  suddenDeath(): SuddenDeathStateView;
}

function makeRoom(): Harness {
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
    devTools: true,
  });

  room.attachHost(HOST);

  const phones = [PHONE_1, PHONE_2];
  const teamIds = ['TEAM_A', 'TEAM_B'];
  const players: PlayerId[] = [];

  const host = (type: string, payload: unknown = {}): RoomOutcome =>
    room.handle(HOST, intent(type, payload));

  phones.forEach((phone, index) => {
    room.onConnect(phone);
    const join = room.handle(phone, intent(ROOM_INTENTS.JOIN_ROOM, { displayName: `P${index}` }));
    const payload = join.ack.ok
      ? (join.ack.value.payload as { playerId: string; reconnectToken: string })
      : { playerId: '', reconnectToken: '' };
    players.push(payload.playerId as PlayerId);
    host(ROOM_INTENTS.HOST_ASSIGN_PLAYER_TEAM, { playerId: payload.playerId, teamId: teamIds[index] });
  });

  host(ROOM_INTENTS.HOST_LOCK_TEAMS);
  host(GAME_INTENTS.START_GAME);

  return {
    room,
    clock,
    players,
    host,
    player: (phone, type, payload = {}) => room.handle(phone, intent(type, payload)),
    suddenDeath: () => {
      const view = room.game.suddenDeathView();
      if (view === null) throw new Error('Sudden Death has not started');
      return view;
    },
  };
}

function beginSuddenDeath(h: Harness): RoomOutcome {
  return h.host(SUDDEN_DEATH_INTENTS.HOST_BEGIN_SUDDEN_DEATH, {
    teamIds: ['TEAM_A', 'TEAM_B'],
  });
}

function startFaceoff(h: Harness): RoomOutcome {
  return h.host(SUDDEN_DEATH_INTENTS.HOST_START_SUDDEN_DEATH_FACEOFF);
}

describe('Sudden Death — the Host can trigger it at any point', () => {
  it('begins Sudden Death from ROUND_INTRO (fresh game), not only ROUND_COMPLETE with a genuine tie', () => {
    const h = makeRoom();
    // The game is freshly started — well before any round or tie exists —
    // and the Host still gets to force Sudden Death, per the project
    // owner's explicit request (D-034). The engine walks the phase to
    // ROUND_COMPLETE first (see #walkPhaseToRoundComplete) and then into
    // SUDDEN_DEATH, never loosening what any OTHER phase is allowed to do.
    const started = beginSuddenDeath(h);
    expect(started.ack.ok).toBe(true);
    expect(h.suddenDeath().participantTeamIds).toEqual(['TEAM_A', 'TEAM_B']);
  });

  it('a non-Host cannot begin Sudden Death', () => {
    const h = makeRoom();
    const attempt = h.player(PHONE_1, SUDDEN_DEATH_INTENTS.HOST_BEGIN_SUDDEN_DEATH, {
      teamIds: ['TEAM_A', 'TEAM_B'],
    });
    expect(attempt.ack.ok).toBe(false);
  });

  it('refuses a teamIds payload that is not exactly two teams', () => {
    const h = makeRoom();
    const attempt = h.host(SUDDEN_DEATH_INTENTS.HOST_BEGIN_SUDDEN_DEATH, {
      teamIds: ['TEAM_A'],
    });
    expect(attempt.ack.ok).toBe(false);
  });

  it('refuses to begin twice', () => {
    const h = makeRoom();
    beginSuddenDeath(h);
    const again = beginSuddenDeath(h);
    expect(again.ack.ok).toBe(false);
  });
});

describe('Sudden Death — face-off through Room', () => {
  it('reveals a question and opens the buzzer', () => {
    const h = makeRoom();
    beginSuddenDeath(h);
    const started = startFaceoff(h);
    expect(started.ack.ok).toBe(true);
    expect(h.suddenDeath().current?.status).toBe('reading');
  });

  it('the first buzz wins; the second is rejected', () => {
    const h = makeRoom();
    beginSuddenDeath(h);
    startFaceoff(h);

    const first = h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_BUZZ);
    expect(first.ack.ok).toBe(true);
    const second = h.player(PHONE_2, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_BUZZ);
    expect(second.ack.ok).toBe(false);
    expect(h.suddenDeath().current?.buzzedTeamId).toBe('TEAM_A');
  });

  it('the inactive/non-participant caller cannot buzz', () => {
    const h = makeRoom();
    beginSuddenDeath(h);
    startFaceoff(h);
    // PHONE_1/PHONE_2 ARE the two Sudden Death participants here (2-team
    // game) — a connection with no team bound cannot buzz at all.
    const outsider = h.room.handle('conn-unregistered', intent(SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_BUZZ));
    expect(outsider.ack.ok).toBe(false);
  });

  it('the #1 answer wins the face-off, correct answer via player submission', () => {
    const h = makeRoom();
    beginSuddenDeath(h);
    startFaceoff(h);
    h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_BUZZ);
    const answered = h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_ANSWER, {
      answer: 'TEST RED',
    });
    expect(answered.ack.ok).toBe(true);
    expect(h.suddenDeath().current?.winningTeamId).toBe('TEAM_A');
  });

  it('a wrong answer loses the face-off outright for the answering team', () => {
    const h = makeRoom();
    beginSuddenDeath(h);
    startFaceoff(h);
    h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_BUZZ);
    h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_ANSWER, { answer: 'nonsense' });
    expect(h.suddenDeath().current?.winningTeamId).toBe('TEAM_B');
  });

  it('a 3-second timeout after buzzing is ruled as an immediate loss, automatically', () => {
    const h = makeRoom();
    beginSuddenDeath(h);
    startFaceoff(h);
    h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_BUZZ);

    h.clock.advance(3_001);
    h.room.tick();

    expect(h.suddenDeath().current?.status).toBe('decided');
    expect(h.suddenDeath().current?.winningTeamId).toBe('TEAM_B');
  });

  it('the Host can rule the answer directly', () => {
    const h = makeRoom();
    beginSuddenDeath(h);
    startFaceoff(h);
    h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_BUZZ);

    const ruled = h.host(SUDDEN_DEATH_INTENTS.HOST_RULE_SUDDEN_DEATH_ANSWER, {
      teamId: 'TEAM_A',
      correct: true,
    });
    expect(ruled.ack.ok).toBe(true);
    expect(h.suddenDeath().current?.winningTeamId).toBe('TEAM_A');
  });

  it('a non-Host cannot rule the answer', () => {
    const h = makeRoom();
    beginSuddenDeath(h);
    startFaceoff(h);
    h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_BUZZ);

    const attempt = h.player(PHONE_1, SUDDEN_DEATH_INTENTS.HOST_RULE_SUDDEN_DEATH_ANSWER, {
      teamId: 'TEAM_A',
      correct: true,
    });
    expect(attempt.ack.ok).toBe(false);
  });
});

describe('Sudden Death — two consecutive wins ends the game', () => {
  it('a team taking its second consecutive face-off win becomes the overall winner', () => {
    const h = makeRoom();
    beginSuddenDeath(h);

    startFaceoff(h);
    h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_BUZZ);
    h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_ANSWER, { answer: 'TEST RED' });
    expect(h.suddenDeath().complete).toBe(false);

    startFaceoff(h);
    h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_BUZZ);
    h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_ANSWER, { answer: 'TEST LION' });

    expect(h.suddenDeath().complete).toBe(true);
    expect(h.suddenDeath().winnerTeamId).toBe('TEAM_A');
    expect(h.room.game.phase).toBe('GAME_OVER');
  });

  it('a broken streak (win, then lose) never ends the game after the third face-off re-wins one', () => {
    const h = makeRoom();
    beginSuddenDeath(h);

    startFaceoff(h);
    h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_BUZZ);
    h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_ANSWER, { answer: 'TEST RED' }); // A: 1

    startFaceoff(h);
    h.player(PHONE_2, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_BUZZ);
    h.player(PHONE_2, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_ANSWER, { answer: 'TEST LION' }); // B wins: B:1, A:0

    startFaceoff(h);
    h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_BUZZ);
    h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_ANSWER, { answer: 'wrong answer' }); // A wrong -> B wins again: B:2

    expect(h.suddenDeath().complete).toBe(true);
    expect(h.suddenDeath().winnerTeamId).toBe('TEAM_B');
  });
});

describe('Sudden Death — no decision leaves nothing changed', () => {
  it('the Host can record no decision, then reveal a fresh face-off', () => {
    const h = makeRoom();
    beginSuddenDeath(h);
    startFaceoff(h);

    // Nobody buzzed — the Host moves on manually.
    const recorded = h.host(SUDDEN_DEATH_INTENTS.HOST_RECORD_SUDDEN_DEATH_NO_DECISION);
    expect(recorded.ack.ok).toBe(true);
    expect(h.suddenDeath().current?.status).toBe('decided');
    expect(h.suddenDeath().current?.noDecision).toBe(true);
    expect(h.suddenDeath().current?.winningTeamId).toBeNull();

    const started = startFaceoff(h);
    expect(started.ack.ok).toBe(true);
    expect(h.suddenDeath().current?.status).toBe('reading');
  });

  it('a non-Host cannot record no decision', () => {
    const h = makeRoom();
    beginSuddenDeath(h);
    startFaceoff(h);
    const attempt = h.player(PHONE_1, SUDDEN_DEATH_INTENTS.HOST_RECORD_SUDDEN_DEATH_NO_DECISION);
    expect(attempt.ack.ok).toBe(false);
  });
});

describe('Sudden Death — pause / reconnect (D-011)', () => {
  it('a disconnect during a face-off pauses the game and freezes its timer', () => {
    const h = makeRoom();
    beginSuddenDeath(h);
    startFaceoff(h);
    h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_BUZZ);

    h.room.onDisconnect(PHONE_1);
    expect(h.room.game.paused).toBe(true);

    h.clock.advance(10_000);
    h.room.tick();
    // The 3-second window did not tick down while paused.
    expect(h.suddenDeath().current?.status).toBe('buzzed');
  });

  it('only the Host resumes, and remaining time is preserved', () => {
    const h = makeRoom();
    beginSuddenDeath(h);
    startFaceoff(h);
    h.player(PHONE_1, SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_BUZZ);
    h.room.onDisconnect(PHONE_1);

    h.clock.advance(50_000);
    h.host(GAME_INTENTS.HOST_RESUME_GAME);
    expect(h.room.game.paused).toBe(false);

    h.clock.advance(2_999);
    h.room.tick();
    expect(h.suddenDeath().current?.status).toBe('buzzed');
    h.clock.advance(2);
    h.room.tick();
    expect(h.suddenDeath().current?.status).toBe('decided');
  });
});

describe('Sudden Death — hidden board on the wire', () => {
  it('never exposes the board answers to a player', () => {
    const h = makeRoom();
    beginSuddenDeath(h);
    startFaceoff(h);

    const json = JSON.stringify(h.suddenDeath());
    expect(json).not.toContain('TEST RED');
    expect(json).not.toContain('TEST BLUE');
    expect(json).not.toContain('TEST GREEN');
  });
});
