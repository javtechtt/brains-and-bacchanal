import {
  asRoomId,
  generateUniqueRoomCode,
  normaliseRoomCode,
  type GameMode,
  type RandomSource,
} from '@bb/protocol';
import type { Clock } from './clock.js';
import { Room } from './room.js';

/**
 * Where rooms live.
 *
 * ================== READ THIS BEFORE RELYING ON IT ==================
 * STORAGE IS IN-MEMORY. RESTARTING THE SERVER DESTROYS EVERY ACTIVE
 * ROOM: every room code, every player, every team assignment and every
 * reconnect credential. There is no file, no database and no recovery.
 * A crash mid-party means re-creating the room and re-joining phones.
 * ====================================================================
 *
 * Phase 4 spec §27 permits exactly this and forbids reaching for Redis or a
 * distributed session store now. The interface below is the seam that makes
 * replacing it later a contained change; ARCHITECTURE.md §8 nominates
 * PostgreSQL/Neon when durability is actually needed.
 */
export interface RoomStore {
  create(mode: GameMode): CreatedRoom | null;
  byId(roomId: string): Room | undefined;
  byCode(code: string): Room | undefined;
  /** Remove a room entirely, freeing its code for reuse. */
  delete(roomId: string): void;
  all(): readonly Room[];
  readonly size: number;
}

export interface CreatedRoom {
  readonly room: Room;
  /** Host credential. Returned ONCE, to the creating connection only. */
  readonly hostToken: string;
}

export interface RoomStoreOptions {
  readonly clock: Clock;
  /**
   * Mints unguessable credentials. Injected rather than importing
   * `node:crypto` directly, both so tests are deterministic and so this package
   * stays runtime-neutral — @bb/game-rules is imported by the browser bundle.
   */
  readonly mintToken: () => string;
  readonly mintId: () => string;
  readonly random?: RandomSource;
  /**
   * Maximum players per room. Default 24.
   *
   * Sized for the game rather than for a limit's own sake: three teams of eight
   * is already a very large party, and the Host must be able to read the list on
   * a TV. Configurable via GAME_SERVER_ROOM_CAPACITY.
   */
  readonly capacity?: number;
  /** Maximum simultaneous rooms. Guards against unbounded memory growth. */
  readonly maxRooms?: number;
  /**
   * Whether rooms accept development engine controls (Phase 5 spec §17).
   *
   * Off unless the server explicitly enables it, so the default is the safe
   * one and a production deployment cannot acquire the tooling by omission.
   */
  readonly devTools?: boolean;
}

export const DEFAULT_ROOM_CAPACITY = 24;
export const DEFAULT_MAX_ROOMS = 50;

export class InMemoryRoomStore implements RoomStore {
  readonly #rooms = new Map<string, Room>();
  /** Canonical code -> roomId. Kept in step with #rooms on create and delete. */
  readonly #codes = new Map<string, string>();
  readonly #options: RoomStoreOptions;

  constructor(options: RoomStoreOptions) {
    this.#options = options;
  }

  create(mode: GameMode): CreatedRoom | null {
    const maxRooms = this.#options.maxRooms ?? DEFAULT_MAX_ROOMS;
    if (this.#rooms.size >= maxRooms) return null;

    const code = generateUniqueRoomCode(
      (candidate) => this.#codes.has(candidate),
      this.#options.random ?? Math.random,
    );
    if (code === null) return null;

    const roomId = asRoomId(this.#options.mintId());
    const hostToken = this.#options.mintToken();

    const room = new Room({
      roomId,
      roomCode: code,
      mode,
      clock: this.#options.clock,
      hostToken,
      capacity: this.#options.capacity ?? DEFAULT_ROOM_CAPACITY,
      mintToken: this.#options.mintToken,
      mintPlayerId: this.#options.mintId,
      devTools: this.#options.devTools ?? false,
    });

    this.#rooms.set(roomId, room);
    this.#codes.set(code, roomId);

    return { room, hostToken };
  }

  byId(roomId: string): Room | undefined {
    return this.#rooms.get(roomId);
  }

  /** Resolve a code as a player typed it. Case and confusables are folded. */
  byCode(code: string): Room | undefined {
    const canonical = normaliseRoomCode(code);
    if (canonical === null) return undefined;
    const roomId = this.#codes.get(canonical);
    return roomId === undefined ? undefined : this.#rooms.get(roomId);
  }

  delete(roomId: string): void {
    const room = this.#rooms.get(roomId);
    if (room === undefined) return;
    this.#codes.delete(room.roomCode);
    this.#rooms.delete(roomId);
  }

  all(): readonly Room[] {
    return [...this.#rooms.values()];
  }

  get size(): number {
    return this.#rooms.size;
  }
}
