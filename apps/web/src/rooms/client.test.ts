import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GAME_INTENTS, ROOM_INTENTS } from '@bb/protocol';
import { BrowserRoomClient } from './client';

/**
 * The browser room client.
 *
 * WHY THIS FILE EXISTS: the Phase 5 physical test found a bug that every
 * server-side test missed, because the server was never wrong. A phone that
 * dropped mid-game reconnected, kept the snapshot it held BEFORE the
 * disconnect — where the game was not yet paused — and carried on counting its
 * timer down on that one screen while every other client correctly showed the
 * game stopped.
 *
 * The server had the right answer the whole time. The client simply never
 * asked for it again. That is a class of fault only a client test can catch,
 * so the reconnect path is tested here against a fake socket.
 */

// ---------------------------------------------------------------------------
// A minimal fake WebSocket, enough to drive the client's request/response
// correlation. Raw WebSockets have no built-in acks, so the client hand-rolls
// that — see D-014's acknowledged cost — and this stands in for the server.
// ---------------------------------------------------------------------------

interface SentFrame {
  readonly kind: string;
  readonly requestId: string;
  readonly intent: { readonly type: string; readonly payload: unknown };
}

class FakeSocket {
  static instances: FakeSocket[] = [];

  // The client guards every send with `readyState !== WebSocket.OPEN`, reading
  // the STATIC off the constructor. Without these the comparison comes out
  // `1 !== undefined` and every send is silently dropped.
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  readyState = 1;
  readonly sent: SentFrame[] = [];

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
    // setTimeout, NOT queueMicrotask: the client assigns onopen AFTER the
    // constructor returns, and a microtask would run before that assignment —
    // so connect() would never resolve. A real socket cannot open that fast
    // either.
    setTimeout(() => this.onopen?.(), 0);
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as SentFrame);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  /**
   * Answer the pending request of a given intent type.
   *
   * Waits for the frame to appear: the client sends from inside an async
   * chain, so a synchronous reply would race the request it is answering.
   */
  async reply(type: string, snapshot: unknown, ok = true): Promise<void> {
    const frame = await this.waitForSend(type);
    this.onmessage?.({
      data: JSON.stringify({
        kind: 'ack',
        requestId: frame.requestId,
        ack: ok
          ? { ok: true, seq: 1, snapshot }
          : { ok: false, error: { code: 'UNAUTHORIZED_ACTOR', message: 'no' } },
      }),
    });
  }

  typesSent(): string[] {
    return this.sent.map((f) => f.intent.type);
  }

  /** Resolve once an intent of this type has been sent. */
  async waitForSend(type: string): Promise<SentFrame> {
    for (let i = 0; i < 50; i += 1) {
      const found = this.sent.find((f) => f.intent.type === type);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`no ${type} was sent`);
  }
}

function lobbySnapshot() {
  return {
    room: { roomId: 'room-1', roomCode: 'BX7K' },
    players: [],
    teams: [],
  };
}

/** A paused game, as the server reports it to a returning phone. */
function pausedGameSnapshot() {
  return {
    isHost: false,
    you: 'p1',
    yourTeamId: 'TEAM_A',
    teams: [{ teamId: 'TEAM_A', displayName: 'Team A', memberIds: ['p1'], bb: 1_000 }],
    game: {
      gameId: 'g1',
      phase: 'PAUSED',
      paused: true,
      challenge: {
        challengeId: 'c1',
        timer: { timerId: 't1', remainingMs: 18_000, paused: true },
      },
    },
  };
}

/**
 * A mid-Round-4 game, as the server reports it to a returning phone.
 *
 * Phase 7D-B: the same reconnect regression client.test.ts already guards
 * against (a phone that keeps a stale pre-disconnect snapshot) applies to
 * Round 4 with nothing round-specific in `BrowserRoomClient` to carry it —
 * `game.round4` rides through the SAME `REQUEST_GAME_SNAPSHOT` round-trip as
 * every other round. This pins that the full Round 4 shape (matchup, board,
 * face-off, strikes, pot) survives that round-trip untouched, since the
 * client has no code path that could special-case or drop it.
 */
function midRound4GameSnapshot() {
  return {
    isHost: false,
    you: 'p1',
    yourTeamId: 'TEAM_A',
    teams: [{ teamId: 'TEAM_A', displayName: 'Team A', memberIds: ['p1'], bb: 1_000 }],
    game: {
      gameId: 'g1',
      phase: 'ACTIVE_PLAY',
      paused: false,
      challenge: { challengeId: 'c1', timer: null },
      round4: {
        roundIndex: 4,
        enteringStandings: [
          { teamId: 'TEAM_A', rank: 'SECOND', enteringBb: 1_000 },
          { teamId: 'TEAM_B', rank: 'THIRD', enteringBb: 800 },
        ],
        matchupStage: 'FIRST',
        matchupTeamIds: ['TEAM_A', 'TEAM_B'],
        inactiveTeamId: null,
        scoringGates: [],
        surveysPlayedInMatchup: 0,
        current: {
          progress: 'board_play',
          board: {
            surveyId: 'ff-test-q1',
            prompt: 'TEST SURVEY 1',
            questionNumber: 1,
            answerCount: 3,
            answers: [
              { answerId: 'a1', rank: 1, revealed: false, text: null, value: null, steupsRemoved: false, steupsRemovedForTeamId: null },
            ],
            doubled: false,
            accumulatedPoints: 40,
            strikes: 1,
            maxStrikes: 3,
          },
          faceoff: null,
          boardPlay: {
            controllingTeamId: 'TEAM_A',
            playerOrder: ['p1'],
            currentPlayerIndex: 0,
            strikes: 1,
            turnTimer: {
              durationMs: 5_000,
              remainingMs: 3_500,
              paused: true,
              expired: false,
              startedAt: 1_000,
            },
          },
          steal: null,
          resolvedWinnerTeamId: null,
          awardedBb: null,
          resolvedAt: null,
        },
        complete: false,
        matchupWinnerTeamId: null,
        round4WinnerTeamId: null,
      },
    },
  };
}

const identity = {
  roomId: 'room-1',
  roomCode: 'BX7K',
  playerId: 'p1',
  reconnectToken: 'secret',
  displayName: 'Javal',
};

let handlers: {
  onSnapshot: ReturnType<typeof vi.fn>;
  onGameSnapshot: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  onStatus: ReturnType<typeof vi.fn>;
  onEvicted: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  // The client persists credentials; a stub keeps the test from depending on a
  // DOM implementation it does not otherwise need.
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });

  handlers = {
    onSnapshot: vi.fn(),
    onGameSnapshot: vi.fn(),
    onEvent: vi.fn(),
    onStatus: vi.fn(),
    onEvicted: vi.fn(),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reconnecting mid-game', () => {
  it('re-reads the GAME state, not only the lobby', async () => {
    const client = new BrowserRoomClient('http://localhost:4000', handlers);
    await client.connect();
    const socket = FakeSocket.instances[0]!;

    const resumed = client.resumeIdentity(identity);
    await socket.reply(ROOM_INTENTS.RECONNECT_PLAYER, { snapshot: lobbySnapshot() });

    // The regression: without this second request the phone keeps whatever game
    // state it held before the socket dropped.
    await socket.waitForSend(GAME_INTENTS.REQUEST_GAME_SNAPSHOT);

    await socket.reply(GAME_INTENTS.REQUEST_GAME_SNAPSHOT, pausedGameSnapshot());
    await resumed;

    expect(handlers.onGameSnapshot).toHaveBeenCalledTimes(1);
  });

  it('learns that the game is paused and the timer is frozen', async () => {
    const client = new BrowserRoomClient('http://localhost:4000', handlers);
    await client.connect();
    const socket = FakeSocket.instances[0]!;

    const resumed = client.resumeIdentity(identity);
    await socket.reply(ROOM_INTENTS.RECONNECT_PLAYER, { snapshot: lobbySnapshot() });
    await socket.reply(GAME_INTENTS.REQUEST_GAME_SNAPSHOT, pausedGameSnapshot());
    await resumed;

    const delivered = handlers.onGameSnapshot.mock.calls[0]?.[0];
    expect(delivered.game.paused).toBe(true);
    // Both matter. `paused` stops the UI pretending play continues; the timer's
    // own `paused` flag stops a local countdown draining a frozen clock.
    expect(delivered.game.challenge.timer.paused).toBe(true);
    expect(delivered.game.challenge.timer.remainingMs).toBe(18_000);
  });

  it('does not ask for game state when the credential is rejected', async () => {
    const client = new BrowserRoomClient('http://localhost:4000', handlers);
    await client.connect();
    const socket = FakeSocket.instances[0]!;

    const resumed = client.resumeIdentity(identity);
    await socket.reply(ROOM_INTENTS.RECONNECT_PLAYER, undefined, false);
    const ack = await resumed;

    expect(ack.ok).toBe(false);
    // Nothing to read: the player is no longer in the room.
    expect(socket.typesSent()).not.toContain(GAME_INTENTS.REQUEST_GAME_SNAPSHOT);
    expect(handlers.onGameSnapshot).not.toHaveBeenCalled();
  });

  it('restores the full Round 4 shape on reconnect, with no action replayed', async () => {
    const client = new BrowserRoomClient('http://localhost:4000', handlers);
    await client.connect();
    const socket = FakeSocket.instances[0]!;

    const resumed = client.resumeIdentity(identity);
    await socket.reply(ROOM_INTENTS.RECONNECT_PLAYER, { snapshot: lobbySnapshot() });
    await socket.reply(GAME_INTENTS.REQUEST_GAME_SNAPSHOT, midRound4GameSnapshot());
    await resumed;

    // The reconnect path sends nothing but the two lookups above — no buzz,
    // no answer, no wager is replayed to "catch up" the returning phone.
    expect(socket.typesSent()).toEqual([
      ROOM_INTENTS.RECONNECT_PLAYER,
      GAME_INTENTS.REQUEST_GAME_SNAPSHOT,
    ]);

    const delivered = handlers.onGameSnapshot.mock.calls[0]?.[0];
    const round4 = delivered.game.round4;
    expect(round4.matchupStage).toBe('FIRST');
    expect(round4.matchupTeamIds).toEqual(['TEAM_A', 'TEAM_B']);
    expect(round4.current.progress).toBe('board_play');
    expect(round4.current.board.accumulatedPoints).toBe(40);
    expect(round4.current.board.strikes).toBe(1);
    expect(round4.current.boardPlay.controllingTeamId).toBe('TEAM_A');
    // CONTENT SAFETY survives the round-trip too: an unrevealed answer's text
    // and value are still null, never backfilled by the client.
    expect(round4.current.board.answers[0].revealed).toBe(false);
    expect(round4.current.board.answers[0].text).toBeNull();
    expect(round4.current.board.answers[0].value).toBeNull();
    // Phase 7D-B1: the board-turn timer reaches the client shape exactly as
    // the server sent it — paused and with its banked remaining time, not
    // reset to the full 5 seconds by the reconnect round-trip itself.
    expect(round4.current.boardPlay.turnTimer.durationMs).toBe(5_000);
    expect(round4.current.boardPlay.turnTimer.remainingMs).toBe(3_500);
    expect(round4.current.boardPlay.turnTimer.paused).toBe(true);
  });
});
