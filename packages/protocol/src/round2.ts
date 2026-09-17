import type { CardChallengeKind } from './cards.js';
import type { ChallengeId, ServerTimestamp, TeamId } from './ids.js';

/**
 * Round 2 — "Shake Up Yuhself!". Phase 7A.
 *
 * GAME_RULES_LOCKED.md §12 and DECISION_LOG.md D-003.
 *
 * ================== THE PHYSICAL GAME IS NOT IN HERE ==================
 * D-003 is unusually explicit for a decision log entry: "Host runs Bottle
 * Battle, Match Makers, Grabbers and Bombers physically. Software only needs
 * Host winner selection and configured 500 BB award."
 *
 * So there is no rule here about bottles, matches, grabbing or bombs. No
 * duration, no scoring, no per-player input, no sensor, no motion tracking and
 * no automatic winner. A challenge definition carries an identifier, a name to
 * put on a TV, a reward the server pays, and which row of the locked card table
 * it counts as. That is the entire software surface of a Round 2 game.
 *
 * What that buys: the four challenges differ ONLY by identity. Nothing in the
 * server can drift away from the physical game, because it never modelled it.
 * ======================================================================
 *
 * The round's shape (§12, and §10 for the Market):
 *
 *   ROUND 2 INTRO -> MARKET -> four physical challenges -> ROUND COMPLETE
 *
 * Each challenge: the Host runs it in the room, selects the winning team, and
 * the server awards the configured BB through the ledger — doubled only if the
 * winning team has a legally played Double It in force (§3, §6).
 */

// ---------------------------------------------------------------------------
// The four challenges
// ---------------------------------------------------------------------------

/**
 * The locked Round 2 challenge order. GAME_RULES_LOCKED.md §12.
 *
 * The docs list the games as "Bottle Battle, Match Makers, Grabbers, Bombers"
 * and nothing states another order, so that documented order is the order —
 * Phase 7A spec §3: "Unless the locked docs explicitly state otherwise, use
 * that documented order."
 *
 * ORDER IS DATA, NOT CONTROL FLOW. The engine walks this array by index; no
 * code anywhere says "after Grabbers comes Bombers". Reordering the round is
 * editing this list, and adding a fifth game would be a rule change that must
 * come from the owner (§12 names exactly four).
 */
export const ROUND2_CHALLENGE_TYPES = [
  'BOTTLE_BATTLE',
  'MATCH_MAKERS',
  'GRABBERS',
  'BOMBERS',
] as const;

export type Round2ChallengeType = (typeof ROUND2_CHALLENGE_TYPES)[number];

/**
 * The BB a Round 2 physical challenge pays its winner. GAME_RULES_LOCKED.md
 * §12 — "Each is worth 500 BB."
 *
 * THE BASE ONLY. Phase 6 spec §13 and SHARED_SYSTEMS.md: "a round supplies the
 * base reward and the shared system applies the allowed multiplier". A doubled
 * win is 1,000 BB because `SharedSystems.applyMultiplier` doubles this number,
 * not because 1,000 is written anywhere.
 */
export const ROUND2_BASE_REWARD_BB = 500;

/**
 * Which round this is. GAME_RULES_LOCKED.md §12 — Round 2 of four.
 *
 * Used to check that a Round 2 challenge is being run in Round 2, and to open
 * the Market at its locked Round 2 prices (§10).
 */
export const ROUND2_ROUND_INDEX = 2;

/**
 * The row of the locked card-compatibility table every Round 2 physical
 * challenge counts as. GAME_RULES_LOCKED.md §6 — "Round 2 Physical Games:
 * Double It! only".
 *
 * NAMED ONCE, HERE. The eligibility rule itself lives in `CARD_ELIGIBILITY`
 * (cards.ts) and is not restated — Phase 7A spec §6 forbids "a separate Round 2
 * card-rule implementation". This constant only says which existing row
 * applies, so a change to the approved table reaches Round 2 automatically.
 */
export const ROUND2_CARD_CHALLENGE_KIND: CardChallengeKind = 'ROUND2_PHYSICAL';

/**
 * One Round 2 physical challenge, as configuration.
 *
 * Phase 7A spec §11 asks for a real challenge model, and §3 for it to be
 * "config-driven rather than spreading names/rewards through Unity code". Unity
 * and the web app read `displayName` from the server's snapshot; neither holds
 * a list of Round 2 games.
 */
export interface Round2ChallengeDefinition {
  /** Stable identifier. Also the engine's generic `challengeType` string. */
  readonly challengeType: Round2ChallengeType;
  /** What goes on the TV. Presentation only — nothing branches on it. */
  readonly displayName: string;
  /** Round 2. GAME_RULES_LOCKED.md §12. */
  readonly roundIndex: typeof ROUND2_ROUND_INDEX;
  /** 0-based position in the locked order. */
  readonly order: number;
  /** Base BB before any multiplier. Always ROUND2_BASE_REWARD_BB. */
  readonly baseRewardBb: number;
  /** The category every Round 2 game shares. Phase 7A spec §11. */
  readonly category: 'ROUND2_PHYSICAL';
  /** Which row of the locked eligibility table applies. */
  readonly cardChallengeKind: CardChallengeKind;
  /**
   * Whether the outcome is decided by the Host rather than by the server.
   *
   * Always true in Round 2 — D-003. The flag is here so a later round with a
   * server-decided outcome is a different value rather than a different shape,
   * and so the Host UI can be driven by configuration instead of by a
   * hard-coded "Round 2 means show winner buttons".
   */
  readonly hostJudged: true;
}

/**
 * Display names, for presentation only.
 *
 * Same discipline as `CARD_DISPLAY_LABELS` (cards.ts): the identifier is
 * `BOTTLE_BATTLE`, and "Bottle Battle" is a string on a screen. Nothing may
 * branch on these, so renaming a game for the TV cannot break the round.
 */
export const ROUND2_DISPLAY_NAME: Readonly<Record<Round2ChallengeType, string>> = {
  BOTTLE_BATTLE: 'Bottle Battle',
  MATCH_MAKERS: 'Match Makers',
  GRABBERS: 'Grabbers',
  BOMBERS: 'Bombers',
} as const;

/**
 * THE ROUND 2 CONFIGURATION. GAME_RULES_LOCKED.md §12.
 *
 * Every entry is identical except for identity and order, which is the point:
 * D-003 puts the physical rules outside the app, so there is nothing else for
 * the software to know. If these four ever stop looking alike, something has
 * been invented.
 */
export const ROUND2_CHALLENGES: readonly Round2ChallengeDefinition[] =
  ROUND2_CHALLENGE_TYPES.map((challengeType, index) => ({
    challengeType,
    displayName: ROUND2_DISPLAY_NAME[challengeType],
    roundIndex: ROUND2_ROUND_INDEX,
    order: index,
    baseRewardBb: ROUND2_BASE_REWARD_BB,
    category: 'ROUND2_PHYSICAL',
    cardChallengeKind: ROUND2_CARD_CHALLENGE_KIND,
    hostJudged: true,
  }));

/** The definition for a challenge type, or null when it is not a Round 2 game. */
export function round2Definition(
  challengeType: string,
): Round2ChallengeDefinition | null {
  return ROUND2_CHALLENGES.find((c) => c.challengeType === challengeType) ?? null;
}

/** Whether a string names one of the four locked Round 2 challenges. */
export function isRound2ChallengeType(value: string): value is Round2ChallengeType {
  return (ROUND2_CHALLENGE_TYPES as readonly string[]).includes(value);
}

/** How many physical challenges Round 2 contains. Always four (§12). */
export const ROUND2_CHALLENGE_COUNT = ROUND2_CHALLENGES.length;

// ---------------------------------------------------------------------------
// Round progression
// ---------------------------------------------------------------------------

/**
 * Where one Round 2 challenge has got to.
 *
 * Deliberately NOT the same as the engine's generic `ChallengeStatus`, which
 * describes the container's lifecycle (pending/active/awaiting_host/resolved).
 * This describes the ROUND's progress through its four games, which is the
 * thing a Host display and a phone need in order to say "3 of 4".
 *
 *   not_started   the round has not reached this game yet
 *   in_progress   prepared and/or running now
 *   resolved      a winner was confirmed and BB was paid
 */
export const ROUND2_CHALLENGE_PROGRESS = ['not_started', 'in_progress', 'resolved'] as const;

export type Round2ChallengeProgress = (typeof ROUND2_CHALLENGE_PROGRESS)[number];

/**
 * One challenge's progress, as clients see it.
 *
 * CONTENT SAFETY: there is nowhere here to put a question, an answer or a
 * physical instruction. Round 2 names are locked game structure (Phase 7A §25),
 * not secret content — and the detailed physical rules stay outside the app
 * entirely, so the type has no field for them.
 */
export interface Round2ChallengeView {
  readonly challengeType: Round2ChallengeType;
  readonly displayName: string;
  readonly order: number;
  readonly baseRewardBb: number;
  readonly progress: Round2ChallengeProgress;
  /** The engine challenge this became, once prepared. */
  readonly challengeId: ChallengeId | null;
  /** Confirmed winner. Null until the Host confirms. */
  readonly winningTeamId: TeamId | null;
  /** BB actually paid to the winner, after any multiplier and the floor. */
  readonly awardedBb: number | null;
  /** Whether a legally played Double It doubled this award. §3. */
  readonly doubled: boolean;
  readonly resolvedAt: ServerTimestamp | null;
}

/**
 * The Round 2 state a client needs.
 *
 * Carried on both snapshots. Everything here is public: which game is running,
 * who won the ones already played and what they were paid. A party game shows
 * exactly this on a TV, and §21's secrets (hands, hidden purchases, unrevealed
 * Clash responses) all live in the Phase 6 views and are not duplicated here.
 */
export interface Round2StateView {
  readonly roundIndex: typeof ROUND2_ROUND_INDEX;
  /** All four, in locked order, with their progress. */
  readonly challenges: readonly Round2ChallengeView[];
  /** 0-based index of the current or next challenge; null once complete. */
  readonly currentIndex: number | null;
  /** The challenge running or awaiting a winner now. Null between games. */
  readonly current: Round2ChallengeView | null;
  /** How many of the four have resolved. */
  readonly resolvedCount: number;
  /** True once all four have resolved. §18. */
  readonly complete: boolean;
  /**
   * Teams taking part. Every team in the game (Phase 7A §16, §17 — all teams
   * participate, and no elimination is invented).
   */
  readonly participatingTeamIds: readonly TeamId[];
  /**
   * The winner the Host has selected but NOT yet confirmed.
   *
   * Two steps on purpose (§19: "Make the winner confirmation clear enough to
   * avoid accidental awards"). Selecting shows an intent on screen and moves no
   * BB; confirming is what pays. Null when nothing is selected.
   */
  readonly pendingWinnerTeamId: TeamId | null;
  /** Which row of the locked card table applies. Always ROUND2_PHYSICAL. */
  readonly cardChallengeKind: CardChallengeKind;
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/**
 * Round 2 intents. Phase 7A spec §26.
 *
 * DELIBERATELY FEW. The spec asks to "add only the concrete Round 2 protocol
 * additions actually needed" and to "prefer extending metadata/config rather
 * than duplicating generic engine behavior". So Round 2 reuses the generic
 * engine wholesale — `HOST_START_CHALLENGE`, `HOST_OPEN_CARD_WINDOW`,
 * `HOST_OPEN_MARKET`, `PLAY_BACCHANAL_CARD`, the pause intents and the
 * snapshot read are all Phase 5/6 intents and are NOT restated here.
 *
 * What genuinely has no generic equivalent is the winner flow. The generic
 * `HOST_RESOLVE_CHALLENGE` takes client-supplied `bbDeltas`, which Round 2 must
 * not use: §15 requires the server to compute 500 (or 1,000) itself, and a Host
 * client naming an amount would be exactly the "client decides how much BB to
 * add" that CLAUDE.md forbids. These three intents carry a TEAM and never a
 * number.
 */
export const ROUND2_INTENTS = {
  /**
   * Host prepares the next physical challenge in the locked order.
   *
   * Takes NO challenge type: the round knows what comes next. A Host cannot
   * skip Grabbers by naming Bombers, because there is no field to name one in.
   */
  HOST_PREPARE_ROUND2_CHALLENGE: 'HOST_PREPARE_ROUND2_CHALLENGE',

  /**
   * Host selects the winning team of the physical challenge — step one of two.
   *
   * Moves no BB. It records the Host's intended winner so the Unity display can
   * show it for confirmation (§19), and so a misclick is visible before it pays.
   * Selecting again replaces the selection, which is what makes it correctable.
   */
  HOST_SELECT_PHYSICAL_WINNER: 'HOST_SELECT_PHYSICAL_WINNER',

  /**
   * Host confirms the selected winner — step two. THIS is what pays.
   *
   * The server computes the award from configuration (§15) and applies any
   * legally active multiplier through the shared systems (§7). Once this
   * succeeds the challenge is resolved and a second confirmation is refused
   * (§14).
   */
  HOST_CONFIRM_PHYSICAL_RESULT: 'HOST_CONFIRM_PHYSICAL_RESULT',

  /**
   * DEVELOPMENT ONLY — enter Round 2 without playing Round 1.
   *
   * Round 1 does not exist yet (Phase 7A §4, §28), so there is no legitimate
   * production path into Round 2. Rather than invent one — which would be a
   * production rule allowing a game to skip Round 1 — this is gated on the same
   * server flag as `DEV_ADJUST_BB` (D-024) and refused outright in production.
   *
   * It does not change round progression: it advances the real engine through
   * the real phases to the real Round 2 pre-state, so the flow it exercises is
   * the flow Round 1 will eventually hand over.
   */
  DEV_START_ROUND2: 'DEV_START_ROUND2',
} as const;

export type Round2IntentType = (typeof ROUND2_INTENTS)[keyof typeof ROUND2_INTENTS];

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Round 2 server events. Past tense: each states a committed fact. */
export const ROUND2_EVENTS = {
  /** Round 2 began. Carries the four challenges and their order. */
  ROUND2_STARTED: 'ROUND2_STARTED',
  /** A physical challenge was prepared and is on screen. */
  ROUND2_CHALLENGE_PREPARED: 'ROUND2_CHALLENGE_PREPARED',
  /**
   * The Host selected a winner but has not confirmed.
   *
   * Broadcast so the Host display and the phones can show "Team B selected —
   * awaiting confirmation". It moves no BB, and the event says so by carrying
   * no amount.
   */
  ROUND2_WINNER_SELECTED: 'ROUND2_WINNER_SELECTED',
  /**
   * A physical challenge resolved: winner confirmed, BB paid.
   *
   * Carries what was actually applied, including whether a multiplier was in
   * force, so a Host can explain 1,000 to a room that expected 500.
   */
  ROUND2_CHALLENGE_RESOLVED: 'ROUND2_CHALLENGE_RESOLVED',
  /** All four resolved. §18 — the round stops here; Round 3 is not Phase 7A's. */
  ROUND2_COMPLETED: 'ROUND2_COMPLETED',
} as const;

export type Round2EventType = (typeof ROUND2_EVENTS)[keyof typeof ROUND2_EVENTS];
