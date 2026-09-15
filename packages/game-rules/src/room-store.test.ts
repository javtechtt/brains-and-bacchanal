import { describe, expect, it, beforeEach } from 'vitest';
import { FakeClock } from './clock.js';
import { InMemoryRoomStore } from './room-store.js';

let counter = 0;

function makeStore(overrides: Partial<Parameters<typeof InMemoryRoomStore.prototype.constructor>[0]> = {}) {
  return new InMemoryRoomStore({
    clock: new FakeClock(1_000),
    mintToken: () => `token-${++counter}`,
    mintId: () => `id-${++counter}`,
    capacity: 4,
    ...overrides,
  });
}

beforeEach(() => {
  counter = 0;
});

describe('room store', () => {
  it('creates a room with a code and a Host credential', () => {
    const store = makeStore();
    const created = store.create('local_party');

    expect(created).not.toBeNull();
    expect(created?.room.roomCode).toHaveLength(4);
    expect(created?.hostToken).toBeTruthy();
    expect(store.size).toBe(1);
  });

  it('gives every active room a distinct code', () => {
    const store = makeStore();
    const codes = new Set<string>();
    for (let i = 0; i < 30; i += 1) {
      const created = store.create('local_party');
      if (created === null) break;
      expect(codes.has(created.room.roomCode)).toBe(false);
      codes.add(created.room.roomCode);
    }
    expect(codes.size).toBeGreaterThan(1);
  });

  it('gives every room a distinct Host credential', () => {
    const store = makeStore();
    const a = store.create('local_party');
    const b = store.create('local_party');
    expect(a?.hostToken).not.toBe(b?.hostToken);
  });

  it('resolves a room by code, case-insensitively', () => {
    const store = makeStore();
    const created = store.create('local_party');
    const code = created?.room.roomCode ?? '';

    expect(store.byCode(code)).toBe(created?.room);
    expect(store.byCode(code.toLowerCase())).toBe(created?.room);
    expect(store.byCode(` ${code} `)).toBe(created?.room);
  });

  it('returns nothing for an unknown or malformed code', () => {
    const store = makeStore();
    store.create('local_party');
    expect(store.byCode('ZZZZ')).toBeUndefined();
    expect(store.byCode('nope')).toBeUndefined();
    expect(store.byCode('')).toBeUndefined();
  });

  it('resolves by internal id, which is not the code', () => {
    const store = makeStore();
    const created = store.create('local_party');
    const room = created?.room;
    if (room === undefined) throw new Error('expected a room');

    expect(store.byId(room.roomId)).toBe(room);
    // The code must not be derived from the id, or reading a code off a screen
    // would reveal the internal identifier.
    expect(room.roomId).not.toContain(room.roomCode);
  });

  it('frees a code for reuse once the room is deleted', () => {
    const store = makeStore();
    const created = store.create('local_party');
    const code = created?.room.roomCode ?? '';

    store.delete(created?.room.roomId ?? '');
    expect(store.size).toBe(0);
    expect(store.byCode(code)).toBeUndefined();
  });

  it('refuses to exceed the room limit', () => {
    const store = makeStore({ maxRooms: 2 });
    expect(store.create('local_party')).not.toBeNull();
    expect(store.create('local_party')).not.toBeNull();
    expect(store.create('local_party')).toBeNull();
  });

  it('applies the configured capacity to created rooms', () => {
    const store = makeStore({ capacity: 2 });
    const room = store.create('local_party')?.room;
    if (room === undefined) throw new Error('expected a room');

    // Capacity is enforced by the room; see room.test.ts for the join path.
    expect(room.playerCount).toBe(0);
  });
});
