import {
  ROUND3_CHALLENGE_TYPES,
  type Round3ChallengeType,
  type Round3ContentItem,
  type Round3ContentPack,
} from '@bb/protocol';

/**
 * The Round 3 content source. Phase 7B.
 *
 * GAME_RULES_LOCKED.md §13 — **the game supplies challenge content**. The Host
 * runs the challenge and judges the answers; the Host does not invent the
 * topic, the logo, the letter or the song scenario during play.
 *
 * ================== WHY THIS IS AN INTERFACE ==================
 * There is no production content pipeline yet, and Phase 7B must not build one
 * (`CONTENT_POLICY.md` describes a sealing flow that is deliberately outside
 * this repository).
 *
 * So the ROUND asks an interface, and development supplies a TEST
 * implementation. When the real source arrives — a database, an approved API —
 * it implements this and nothing in the round changes. That is the whole point
 * of the seam: the alternative, a Host typing prompts into a box, would become
 * the production flow by accident.
 * ==============================================================
 *
 * ================== WHAT A SOURCE NEVER RETURNS ==============
 * An accepted answer. Not because callers are trusted to ignore it, but because
 * `Round3ContentItem` has no field for one — the Host judges every Round 3
 * answer subjectively (§15-§17), so no client and no rule ever needs one.
 *
 * It also hands out ONE item at a time. A pack is never sent to a client, and
 * `nextItem` is the only way to advance, so a snapshot cannot carry a future
 * logo, letter or scenario.
 * ==============================================================
 */
export interface Round3ContentSource {
  /**
   * The next unseen item for a challenge, or null when the source is exhausted.
   *
   * Null is a real outcome rather than an error: a Host may keep pressing NEXT
   * past the end of a TEST pack, and the round should say "nothing left" rather
   * than throw.
   */
  nextItem(challengeType: Round3ChallengeType): Round3ContentItem | null;

  /** How many items remain. For the Host's own display only, never a player's. */
  remaining(challengeType: Round3ChallengeType): number;
}

/**
 * A content source backed by in-memory packs.
 *
 * Used with TEST fixtures during development, and equally usable by a future
 * loader that reads approved production content and hands it over — the packs
 * are data, and this class does not care where they came from.
 */
export class PackContentSource implements Round3ContentSource {
  readonly #items = new Map<string, Round3ContentItem[]>();
  readonly #cursor = new Map<string, number>();

  constructor(packs: readonly Round3ContentPack[]) {
    for (const pack of packs) {
      this.#items.set(pack.challengeType, [...pack.items]);
      this.#cursor.set(pack.challengeType, 0);
    }
  }

  nextItem(challengeType: Round3ChallengeType): Round3ContentItem | null {
    const items = this.#items.get(challengeType);
    if (items === undefined) return null;

    const index = this.#cursor.get(challengeType) ?? 0;
    const item = items[index];
    if (item === undefined) return null;

    this.#cursor.set(challengeType, index + 1);
    return item;
  }

  remaining(challengeType: Round3ChallengeType): number {
    const items = this.#items.get(challengeType);
    if (items === undefined) return 0;
    return Math.max(0, items.length - (this.#cursor.get(challengeType) ?? 0));
  }
}

/**
 * TEST content for Round 3. **Never production.**
 *
 * `CONTENT_POLICY.md` — EXAMPLE and TEST can never become PRODUCTION_SEALED,
 * and every fixture is marked so a loader can refuse to serve it when the
 * server is configured for production content.
 *
 * Every item below is obviously fake on purpose. A plausible-looking logo or
 * song prompt here would be a liability: the project owner also plays the game,
 * and a fixture that reads like real content invites someone to promote it.
 */
export const ROUND3_TEST_PACKS: readonly Round3ContentPack[] = [
  {
    challengeType: 'THINK_FAST',
    status: 'TEST',
    source: 'TEST_FIXTURE',
    // §14 — Think Fast uses ONE topic per challenge, revealed when it starts.
    // Several are listed so repeated development runs do not exhaust the pack;
    // a single game consumes exactly one.
    items: [
      { itemId: 'tf-test-001', body: 'TEST TOPIC: name things in the test placeholder box' },
      { itemId: 'tf-test-002', body: 'TEST TOPIC: name test placeholder colours' },
      { itemId: 'tf-test-003', body: 'TEST TOPIC: name test placeholder shapes' },
      { itemId: 'tf-test-004', body: 'TEST TOPIC: name test placeholder animals' },
      { itemId: 'tf-test-005', body: 'TEST TOPIC: name test placeholder numbers' },
      { itemId: 'tf-test-006', body: 'TEST TOPIC: name test placeholder objects' },
    ],
  },
  {
    challengeType: 'GUESS_THE_LOGO',
    status: 'TEST',
    source: 'TEST_FIXTURE',
    items: [
      { itemId: 'gtl-test-001', body: 'TEST LOGO 1', imageRef: 'test://logo-1' },
      { itemId: 'gtl-test-002', body: 'TEST LOGO 2', imageRef: 'test://logo-2' },
      { itemId: 'gtl-test-003', body: 'TEST LOGO 3', imageRef: 'test://logo-3' },
      { itemId: 'gtl-test-004', body: 'TEST LOGO 4', imageRef: 'test://logo-4' },
      { itemId: 'gtl-test-005', body: 'TEST LOGO 5', imageRef: 'test://logo-5' },
      { itemId: 'gtl-test-006', body: 'TEST LOGO 6', imageRef: 'test://logo-6' },
      { itemId: 'gtl-test-007', body: 'TEST LOGO 7', imageRef: 'test://logo-7' },
      { itemId: 'gtl-test-008', body: 'TEST LOGO 8', imageRef: 'test://logo-8' },
      { itemId: 'gtl-test-009', body: 'TEST LOGO 9', imageRef: 'test://logo-9' },
      { itemId: 'gtl-test-010', body: 'TEST LOGO 10', imageRef: 'test://logo-10' },
      { itemId: 'gtl-test-011', body: 'TEST LOGO 11', imageRef: 'test://logo-11' },
      { itemId: 'gtl-test-012', body: 'TEST LOGO 12', imageRef: 'test://logo-12' },
      { itemId: 'gtl-test-013', body: 'TEST LOGO 13', imageRef: 'test://logo-13' },
      { itemId: 'gtl-test-014', body: 'TEST LOGO 14', imageRef: 'test://logo-14' },
      { itemId: 'gtl-test-015', body: 'TEST LOGO 15', imageRef: 'test://logo-15' },
      { itemId: 'gtl-test-016', body: 'TEST LOGO 16', imageRef: 'test://logo-16' },
      { itemId: 'gtl-test-017', body: 'TEST LOGO 17', imageRef: 'test://logo-17' },
      { itemId: 'gtl-test-018', body: 'TEST LOGO 18', imageRef: 'test://logo-18' },
      { itemId: 'gtl-test-019', body: 'TEST LOGO 19', imageRef: 'test://logo-19' },
      { itemId: 'gtl-test-020', body: 'TEST LOGO 20', imageRef: 'test://logo-20' },
    ],
  },
  {
    challengeType: 'ALL_ANSWERS_BEGIN_WITH',
    status: 'TEST',
    source: 'TEST_FIXTURE',
    items: [
      { itemId: 'aab-test-001', body: 'TEST PROMPT 1: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-002', body: 'TEST PROMPT 2: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-003', body: 'TEST PROMPT 3: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-004', body: 'TEST PROMPT 4: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-005', body: 'TEST PROMPT 5: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-006', body: 'TEST PROMPT 6: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-007', body: 'TEST PROMPT 7: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-008', body: 'TEST PROMPT 8: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-009', body: 'TEST PROMPT 9: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-010', body: 'TEST PROMPT 10: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-011', body: 'TEST PROMPT 11: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-012', body: 'TEST PROMPT 12: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-013', body: 'TEST PROMPT 13: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-014', body: 'TEST PROMPT 14: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-015', body: 'TEST PROMPT 15: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-016', body: 'TEST PROMPT 16: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-017', body: 'TEST PROMPT 17: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-018', body: 'TEST PROMPT 18: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-019', body: 'TEST PROMPT 19: a test placeholder answer', letter: 'T' },
      { itemId: 'aab-test-020', body: 'TEST PROMPT 20: a test placeholder answer', letter: 'T' },
    ],
  },
  {
    challengeType: 'SING_A_SONG',
    status: 'TEST',
    source: 'TEST_FIXTURE',
    items: [
      { itemId: 'sas-test-001', body: 'TEST SCENARIO 1: a test placeholder song' },
      { itemId: 'sas-test-002', body: 'TEST SCENARIO 2: a test placeholder song' },
      { itemId: 'sas-test-003', body: 'TEST IMAGE PROMPT 3', imageRef: 'test://song-3' },
      { itemId: 'sas-test-004', body: 'TEST SCENARIO 4: a test placeholder song' },
      { itemId: 'sas-test-005', body: 'TEST SCENARIO 5: a test placeholder song' },
      { itemId: 'sas-test-006', body: 'TEST IMAGE PROMPT 6', imageRef: 'test://song-6' },
      { itemId: 'sas-test-007', body: 'TEST SCENARIO 7: a test placeholder song' },
      { itemId: 'sas-test-008', body: 'TEST SCENARIO 8: a test placeholder song' },
      { itemId: 'sas-test-009', body: 'TEST IMAGE PROMPT 9', imageRef: 'test://song-9' },
      { itemId: 'sas-test-010', body: 'TEST SCENARIO 10: a test placeholder song' },
      { itemId: 'sas-test-011', body: 'TEST SCENARIO 11: a test placeholder song' },
      { itemId: 'sas-test-012', body: 'TEST IMAGE PROMPT 12', imageRef: 'test://song-12' },
      { itemId: 'sas-test-013', body: 'TEST SCENARIO 13: a test placeholder song' },
      { itemId: 'sas-test-014', body: 'TEST SCENARIO 14: a test placeholder song' },
      { itemId: 'sas-test-015', body: 'TEST IMAGE PROMPT 15', imageRef: 'test://song-15' },
    ],
  },
];

/** A fresh TEST source. Each game gets its own, so cursors never leak between rooms. */
export function createTestContentSource(): Round3ContentSource {
  return new PackContentSource(ROUND3_TEST_PACKS);
}

/**
 * A source that has nothing.
 *
 * The default when no content is configured, so a server without a content
 * source refuses to reveal an item rather than inventing one. Phase 7B spec §3:
 * the Host must not be able to supply production content by typing it.
 */
export function createEmptyContentSource(): Round3ContentSource {
  return new PackContentSource(
    ROUND3_CHALLENGE_TYPES.map((challengeType) => ({
      challengeType,
      status: 'TEST',
      source: 'EMPTY',
      items: [],
    })),
  );
}
