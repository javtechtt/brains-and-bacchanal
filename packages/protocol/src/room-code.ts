/**
 * Short human-readable room codes.
 *
 * A player reads this off a TV across a room and types it into a phone, or the
 * Host reads it aloud over music and noise. Every decision here serves that,
 * not cryptography — ARCHITECTURE.md §10: "room codes are convenience IDs, not
 * authentication." Authority comes from the Host and reconnect credentials.
 */

/**
 * Code alphabet. 24 characters: A-Z and 2-9 minus the confusable ones.
 *
 * Removed and why:
 *   O / 0  — indistinguishable in most display fonts
 *   I / 1  — same, and worse in condensed fonts
 *   L      — reads as 1 or I when capitalised
 *   S / 5  — routinely confused when read aloud or over a bad connection
 *   U / V  — confused in several display faces
 *   Z / 2  — confused in handwriting and some faces
 *
 * This is about the failure mode that actually costs time at a party: someone
 * typing the code wrong three times while everyone waits.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRTWXY346789';

/** Code length. Four characters over this alphabet gives 390,625 codes. */
export const ROOM_CODE_LENGTH = 4;

/** Injectable randomness so tests can be deterministic. Returns [0, 1). */
export type RandomSource = () => number;

/**
 * Generate one candidate code.
 *
 * NOT derived from the internal room id (Phase 4 spec §2). Deriving it would
 * leak room ids to anyone who can read a code off a screen, and would couple a
 * public convenience string to an internal identifier.
 */
export function generateRoomCode(random: RandomSource = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    const index = Math.floor(random() * ALPHABET.length) % ALPHABET.length;
    code += ALPHABET[index] ?? ALPHABET[0];
  }
  return code;
}

/**
 * Normalise user input into canonical code form.
 *
 * Codes are case-insensitive, and this is where that is implemented — once,
 * rather than at every comparison. It also maps the characters people
 * substitute by reflex: someone told "BX7K" who types a zero meant O, and since
 * neither O nor 0 is in the alphabet, the intent is unambiguous.
 *
 * Returns null if the result is not a well-formed code.
 */
export function normaliseRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const upper = raw.trim().toUpperCase().replace(/[\s-]/g, '');

  // Fold confusables onto the alphabet member people meant. Safe precisely
  // because neither side of each pair other than the target is in ALPHABET.
  const folded = upper
    .replace(/[0O]/g, 'Q') // O and 0 are absent; Q is the nearest round glyph
    .replace(/[1IL]/g, 'J')
    .replace(/[5S]/g, '6')
    .replace(/[2Z]/g, '3')
    .replace(/[UV]/g, 'W');

  if (folded.length !== ROOM_CODE_LENGTH) return null;
  for (const char of folded) {
    if (!ALPHABET.includes(char)) return null;
  }
  return folded;
}

/** Whether a string is already a canonical room code. */
export function isRoomCode(value: unknown): boolean {
  if (typeof value !== 'string' || value.length !== ROOM_CODE_LENGTH) return false;
  for (const char of value) {
    if (!ALPHABET.includes(char)) return false;
  }
  return true;
}

/**
 * Generate a code not already in use.
 *
 * Uniqueness is checked against ACTIVE rooms only (Phase 4 spec §2), so codes
 * are recycled once a room closes — which is what keeps four characters viable
 * indefinitely. Gives up after a bounded number of attempts rather than looping
 * forever; at that point the server is out of codes and must say so rather than
 * hang.
 */
export function generateUniqueRoomCode(
  isTaken: (code: string) => boolean,
  random: RandomSource = Math.random,
  maxAttempts = 100,
): string | null {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = generateRoomCode(random);
    if (!isTaken(code)) return code;
  }
  return null;
}

/** Exposed for tests and documentation. */
export const ROOM_CODE_ALPHABET = ALPHABET;
