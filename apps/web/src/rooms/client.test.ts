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
});
