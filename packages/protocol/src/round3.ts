import type { CardChallengeKind } from './cards.js';
import type { ChallengeId, ServerTimestamp, TeamId } from './ids.js';

/**
 * Round 3. Phase 7B.
 *
 * GAME_RULES_LOCKED.md §13-§18 and DECISION_LOG.md D-031.
 *
 * ================== TWO THINGS ARE COUNTED, AND THEY ARE NOT THE SAME ==========
 * This is the distinction the whole round turns on, and the one a refactor is
 * most likely to collapse:
 *
 *   1. CHALLENGE POINTS — logos guessed, prompts answered, songs sung. Temporary,
 *      scoped to one challenge, and they decide only who won THAT challenge.
 *   2. The ROUND 3 CHALLENGE-WIN COUNTER — +1 when a challenge is won. This is
 *      what decides the Round 3 winner.
 *   3. BB — the game's actual score, awarded only where a locked rule says so:
 *      Think Fast (§14) and Sing a Song (§17), 500 each. The other two award
 *      none.
 *
 * Five logos is ONE Round 3 win, not five, and not BB. §13 states this with a
 * worked example precisely because it is easy to get wrong.
 *
 * They are three separate fields here, never derived from one another.
 * ==============================================================================
 *
 * ================== THE GAME SUPPLIES THE CONTENT ==============================
 * §13 — for Rounds 1, 3 and 4 the game supplies challenge content from its
 * content source. The Host controls progression and judgment; the Host does not
 * invent the topic, the logo, the letter or the song scenario during play.
 *
 * So a content item arrives by REFERENCE plus the minimum a client must render,
 * and only the CURRENT item is ever sent. There is no field here for a queue, a
 * future item or an accepted answer — CONTENT_POLICY.md, and the absence is the
 * protection.
 * ==============================================================================
 */

// ---------------------------------------------------------------------------
// The four challenges
// ---------------------------------------------------------------------------

/**
 * The locked Round 3 order. GAME_RULES_LOCKED.md §13.
 *
 * Order is data, not control flow — the engine walks this array by index, and
 * no code says "after Guess the Logo comes All Answers Begin With".
 */
export const ROUND3_CHALLENGE_TYPES = [
  'THINK_FAST',
  'GUESS_THE_LOGO',
  'ALL_ANSWERS_BEGIN_WITH',
  'SING_A_SONG',
] as const;

export type Round3ChallengeType = (typeof ROUND3_CHALLENGE_TYPES)[number];

export const ROUND3_ROUND_INDEX = 3;

/**
 * How a challenge decides its winner.
 *
 *   elimination — Think Fast: teams drop out until one remains (§14)
 *   points      — the other three: score challenge points toward a target (§15-§17)
 *
 * Named rather than inferred from the challenge type, so the Host UI and the
 * engine both branch on the SHAPE of a challenge rather than on its identity.
 */
export const ROUND3_FORMATS = ['elimination', 'points'] as const;

export type Round3Format = (typeof ROUND3_FORMATS)[number];

/** Display names. Presentation only — nothing branches on these. */
export const ROUND3_DISPLAY_NAME: Readonly<Record<Round3ChallengeType, string>> = {
  THINK_FAST: 'Think Fast',
  GUESS_THE_LOGO: 'Guess the Logo',
  ALL_ANSWERS_BEGIN_WITH: 'All Answers Begin With...',
  SING_A_SONG: 'Sing a Song',
} as const;

/**
 * One Round 3 challenge, as configuration.
 *
 * `baseRewardBb` is 0 for two of the four, and that is a locked rule rather
 * than an omission: §15 and §16 award no BB. Modelling it as 0 rather than null
 * keeps the award path identical for all four — the engine always asks, and
 * sometimes the answer is nothing.
 */
export interface Round3ChallengeDefinition {
  readonly challengeType: Round3ChallengeType;
  readonly displayName: string;
  readonly roundIndex: typeof ROUND3_ROUND_INDEX;
  readonly order: number;
  readonly format: Round3Format;
  /** BB to the winner. 500 for Think Fast and Sing a Song; 0 for the others. */
  readonly baseRewardBb: number;
  /**
   * Challenge points that normally end it. Null for the elimination format.
   *
   * "NORMAL target" is exact: §15-§17 give the Host discretion to confirm a
   * winner before or after it. Reaching it never resolves the challenge.
   */
  readonly targetScore: number | null;
  /** Seconds per content item. Null for Think Fast, whose timer is still open. */
  readonly itemWindowMs: number | null;
  readonly cardChallengeKind: CardChallengeKind;
}

/** Ten seconds per item. §15, §16, §17 — locked for three of the four. */
export const ROUND3_ITEM_WINDOW_MS = 10_000;

/** The BB a Think Fast or Sing a Song win pays. §14, §17. */
export const ROUND3_BB_CHALLENGE_REWARD = 500;

/**
 * THE ROUND 3 CONFIGURATION. GAME_RULES_LOCKED.md §13-§17.
 *
 * Unlike Round 2's four identical entries, these differ — different formats,
 * targets and rewards — because the locked rules genuinely differ. Each value
 * traces to a section.
 */
export const ROUND3_CHALLENGES: readonly Round3ChallengeDefinition[] = [
  {
    challengeType: 'THINK_FAST',
    displayName: ROUND3_DISPLAY_NAME.THINK_FAST,
    roundIndex: ROUND3_ROUND_INDEX,
    order: 0,
    format: 'elimination',
    baseRewardBb: ROUND3_BB_CHALLENGE_REWARD,
    targetScore: null,
    // OPEN_RULES.md §2 — the Think Fast answer timer is NOT locked. Null means
    // the caller supplies one from configuration, exactly as every other
    // undecided duration in this project does.
    itemWindowMs: null,
    cardChallengeKind: 'THINK_FAST',
  },
  {
    challengeType: 'GUESS_THE_LOGO',
    displayName: ROUND3_DISPLAY_NAME.GUESS_THE_LOGO,
    roundIndex: ROUND3_ROUND_INDEX,
    order: 1,
    format: 'points',
    baseRewardBb: 0,
    targetScore: 5,
    itemWindowMs: ROUND3_ITEM_WINDOW_MS,
    cardChallengeKind: 'GUESS_THE_LOGO',
  },
  {
    challengeType: 'ALL_ANSWERS_BEGIN_WITH',
    displayName: ROUND3_DISPLAY_NAME.ALL_ANSWERS_BEGIN_WITH,
    roundIndex: ROUND3_ROUND_INDEX,
    order: 2,
    format: 'points',
    baseRewardBb: 0,
    targetScore: 5,
    itemWindowMs: ROUND3_ITEM_WINDOW_MS,
    cardChallengeKind: 'ALL_ANSWERS_BEGIN_WITH',
  },
  {
    challengeType: 'SING_A_SONG',
    displayName: ROUND3_DISPLAY_NAME.SING_A_SONG,
    roundIndex: ROUND3_ROUND_INDEX,
    order: 3,
    format: 'points',
    baseRewardBb: ROUND3_BB_CHALLENGE_REWARD,
    targetScore: 3,
    itemWindowMs: ROUND3_ITEM_WINDOW_MS,
    cardChallengeKind: 'SING_A_SONG',
  },
];

export const ROUND3_CHALLENGE_COUNT = ROUND3_CHALLENGES.length;

export function round3Definition(
  challengeType: string,
): Round3ChallengeDefinition | null {
  return ROUND3_CHALLENGES.find((c) => c.challengeType === challengeType) ?? null;
}

export function isRound3ChallengeType(value: string): value is Round3ChallengeType {
  return (ROUND3_CHALLENGE_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Content items
// ---------------------------------------------------------------------------

/**
 * What a client may see of the CURRENT challenge item.
 *
 * CONTENT SAFETY — the shape is the protection. There is:
 *   - no accepted answer (the Host judges; no client ever needs one),
 *   - no queue and no "next" field,
 *   - no total count that would reveal how much is left.
 *
 * `body` carries only what must be rendered to play: a Think Fast topic, a
 * letter, a prompt. `imageRef` is a REFERENCE the client resolves, never image
 * bytes or a production path.
 */
export interface Round3ItemView {
  readonly itemId: string;
  /** 1-based position within this challenge, for "Logo 3". Never a total. */
  readonly index: number;
  /** The visible prompt. TEST content during development. */
  readonly body: string;
  /** For All Answers Begin With: the required letter. Null elsewhere. */
  readonly letter: string | null;
  /** An image to resolve, when the item is pictorial. Null otherwise. */
  readonly imageRef: string | null;
  readonly revealedAt: ServerTimestamp;
  /** Milliseconds left in this item's window, server-computed. */
  readonly remainingMs: number | null;
}

/**
 * One item as the CONTENT SOURCE holds it.
 *
 * Distinct from `Round3ItemView` on purpose: this is the server-side record and
 * may carry fields no client receives. Today they happen to match closely; the
 * separation exists so a future accepted-answer or difficulty field has an
 * obvious home that is NOT the client view.
 */
export interface Round3ContentItem {
  readonly itemId: string;
  readonly body: string;
  readonly letter?: string | null;
  readonly imageRef?: string | null;
}

/** A pack of items for one challenge, from the content source. */
export interface Round3ContentPack {
  readonly challengeType: Round3ChallengeType;
  /** `TEST` during development. CONTENT_POLICY.md statuses. */
  readonly status: string;
  /** Where it came from, for audit. Never shown to players. */
  readonly source: string;
  readonly items: readonly Round3ContentItem[];
}

// ---------------------------------------------------------------------------
// Think Fast
// ---------------------------------------------------------------------------

/**
 * Think Fast state. §14.
 *
 * Elimination, not points: teams take turns, and a team that cannot answer is
 * out of THIS challenge. The last team able to answer wins.
 *
 * Turn order comes from the PREVIOUS ROUND'S STANDINGS (D-031) — the team with
 * the most total BB when Round 2 ended goes first. It is computed once when the
 * challenge starts and then fixed, so a BB change mid-challenge cannot reorder
 * play under way.
 */
export interface ThinkFastView {
  /** Teams in play order. Fixed when the challenge starts. */
  readonly turnOrder: readonly TeamId[];
  /** Whose turn it is now. Null before the challenge starts or once it ends. */
  readonly currentTeamId: TeamId | null;
  /** Teams eliminated from this challenge, in the order they went out. */
  readonly eliminatedTeamIds: readonly TeamId[];
  /** Teams still able to answer. */
  readonly remainingTeamIds: readonly TeamId[];
  /** How many valid answers have been given, for display. */
  readonly validAnswerCount: number;
}

// ---------------------------------------------------------------------------
// Rock-paper-scissors
// ---------------------------------------------------------------------------

/**
 * The three choices. §18.
 *
 * THIS IS NOT A BACCHANAL CLASH. No card is involved or spent, the categories
 * are unrelated, and it must not reuse the Clash UI. The only similarity is
 * that both hide choices until a reveal — and that similarity is exactly why
 * this is a separate type rather than a borrowed one.
 */
export const RPS_CHOICES = ['ROCK', 'PAPER', 'SCISSORS'] as const;

export type RpsChoice = (typeof RPS_CHOICES)[number];

/** What each choice beats. §18 — the standard cycle. */
const RPS_BEATS: Readonly<Record<RpsChoice, RpsChoice>> = {
  ROCK: 'SCISSORS',
  SCISSORS: 'PAPER',
  PAPER: 'ROCK',
} as const;

export function rpsBeats(attacker: RpsChoice, defender: RpsChoice): boolean {
  return RPS_BEATS[attacker] === defender;
}

export function isRpsChoice(value: string): value is RpsChoice {
  return (RPS_CHOICES as readonly string[]).includes(value);
}

/** How one RPS attempt ended. */
export const RPS_OUTCOMES = [
  /** Someone won outright; the tiebreaker is over. */
  'winner',
  /** Nothing separated them — play again. §18. */
  'replay',
  /** One team is out; the rest continue. Three-team pair-beats-single. */
  'elimination',
] as const;

export type RpsOutcome = (typeof RPS_OUTCOMES)[number];

/**
 * One RPS attempt, as clients may see it.
 *
 * WHILE OPEN, `choices` IS EMPTY. §18 hides choices until every tied team has
 * locked one. `submittedTeamIds` says WHO has chosen, never WHAT — the same
 * split the Bacchanal Clash uses, for the same reason, via a separate type.
 */
export interface RpsAttemptView {
  readonly attemptId: string;
  /** 1-based; a replay increments it. */
  readonly attemptNumber: number;
  /** Teams that must choose in this attempt. */
  readonly participatingTeamIds: readonly TeamId[];
  /** Who has locked a choice. NOT what they chose. */
  readonly submittedTeamIds: readonly TeamId[];
  readonly resolved: boolean;
  /** Populated only after the reveal. Empty while open. */
  readonly choices: Readonly<Record<string, RpsChoice>>;
  /** The same choices, as a list. For Unity — and equally empty while open. */
  readonly revealedChoices: readonly Round3TeamChoice[];
  readonly outcome: RpsOutcome | null;
  /** Set when the outcome is `winner`. */
  readonly winningTeamId: TeamId | null;
  /** Set when the outcome is `elimination`. */
  readonly eliminatedTeamIds: readonly TeamId[];
  /** Plain-language explanation for the display. Never a rule input. */
  readonly explanation: string | null;
  readonly resolvedAt: ServerTimestamp | null;
}

/** The whole tiebreaker: a series of attempts until one team remains. */
export interface RpsTiebreakerView {
  /** Teams that entered the tiebreaker. */
  readonly tiedTeamIds: readonly TeamId[];
  /** Still in contention. */
  readonly activeTeamIds: readonly TeamId[];
  /** The attempt in progress, or the last one resolved. */
  readonly current: RpsAttemptView | null;
  /** Every resolved attempt, oldest first. */
  readonly history: readonly RpsAttemptView[];
  readonly complete: boolean;
  readonly winningTeamId: TeamId | null;
  /** This team's own locked choice, for the asking team only. */
  readonly yourChoice: RpsChoice | null;
}

// ---------------------------------------------------------------------------
// Progression
// ---------------------------------------------------------------------------

export const ROUND3_CHALLENGE_PROGRESS = ['not_started', 'in_progress', 'resolved'] as const;

export type Round3ChallengeProgress = (typeof ROUND3_CHALLENGE_PROGRESS)[number];

/**
 * One team's count, as a serialisable pair.
 *
 * ================== WHY A LIST AND NOT JUST A RECORD ==================
 * The web client reads the `Record` forms below happily. **Unity cannot.**
 * JsonUtility has no dictionary support at all — a keyed object deserialises to
 * nothing, silently, which is exactly the class of failure that put "0 BB" on a
 * TV in Phase 7A.
 *
 * So every per-team count travels BOTH ways: as a `Record` for the web, and as
 * a parallel list for Unity. Duplication with a reason, and the two are built
 * from the same source in one place so they cannot disagree.
 * ======================================================================
 */
export interface Round3TeamCount {
  readonly teamId: TeamId;
  readonly value: number;
}

/** One team's revealed rock-paper-scissors choice. Same reason as above. */
export interface Round3TeamChoice {
  readonly teamId: TeamId;
  readonly choice: RpsChoice;
}

/** One Round 3 challenge as clients see it. */
export interface Round3ChallengeView {
  readonly challengeType: Round3ChallengeType;
  readonly displayName: string;
  readonly order: number;
  readonly format: Round3Format;
  readonly progress: Round3ChallengeProgress;
  readonly challengeId: ChallengeId | null;
  /**
   * Challenge points per team, THIS challenge only.
   *
   * Reset when the challenge ends — these never accumulate across the round,
   * which is what keeps them distinct from the challenge-win counter.
   */
  readonly scores: Readonly<Record<string, number>>;
  /** The same scores, as a list. For Unity — see `Round3TeamCount`. */
  readonly scoreList: readonly Round3TeamCount[];
  /** The normal target. Reaching it does NOT resolve the challenge. */
  readonly targetScore: number | null;
  /** True once some team has reached the target. Display hint only. */
  readonly targetReached: boolean;
  /** The current content item. Null before the first is revealed. */
  readonly currentItem: Round3ItemView | null;
  /** Think Fast state. Null for the other three. */
  readonly thinkFast: ThinkFastView | null;
  /** Confirmed winner. Null until the Host confirms. */
  readonly winningTeamId: TeamId | null;
  /** BB paid to the winner, after any multiplier. Null until resolved. */
  readonly awardedBb: number | null;
  readonly doubled: boolean;
  readonly resolvedAt: ServerTimestamp | null;
}

/** The Round 3 state a client needs. */
export interface Round3StateView {
  readonly roundIndex: typeof ROUND3_ROUND_INDEX;
  readonly challenges: readonly Round3ChallengeView[];
  readonly currentIndex: number | null;
  readonly current: Round3ChallengeView | null;
  readonly resolvedCount: number;
  readonly complete: boolean;
  readonly participatingTeamIds: readonly TeamId[];
  /**
   * THE ROUND 3 CHALLENGE-WIN COUNTER, per team. §13.
   *
   * +1 per challenge won. Decides the Round 3 winner. **Not BB**, and never
   * written to the ledger.
   */
  readonly challengeWins: Readonly<Record<string, number>>;
  /** The same counter, as a list. For Unity — see `Round3TeamCount`. */
  readonly challengeWinList: readonly Round3TeamCount[];
  /**
   * Standings carried in from the previous round, used for Think Fast order.
   *
   * §1 / D-031 — winning a round means the most total BB when it ended. Snapped
   * once on entry to Round 3 so later BB movement cannot reorder a challenge
   * already under way.
   */
  readonly previousRoundOrder: readonly TeamId[];
  /** The tiebreaker, when the counter ties. Null otherwise. */
  readonly tiebreaker: RpsTiebreakerView | null;
  /** The confirmed Round 3 winner. Null until decided. */
  readonly winningTeamId: TeamId | null;
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/**
 * Round 3 intents.
 *
 * Host-only except `SUBMIT_RPS_CHOICE`, which is a player intent because a team
 * chooses its own rock, paper or scissors. Everything else — awarding a point,
 * judging an answer, moving to the next item, confirming a winner — is
 * subjective Host authority (§14-§17), so a phone has no route to it.
 */
export const ROUND3_INTENTS = {
  /** Host prepares the next challenge in the locked order. Takes no type. */
  HOST_PREPARE_ROUND3_CHALLENGE: 'HOST_PREPARE_ROUND3_CHALLENGE',
  /** Host reveals the next content item and starts its window. */
  HOST_NEXT_ROUND3_ITEM: 'HOST_NEXT_ROUND3_ITEM',
  /** Host awards one challenge point to a team. Points, not BB. */
  HOST_AWARD_ROUND3_POINT: 'HOST_AWARD_ROUND3_POINT',
  /** Think Fast: the current team answered validly; the turn advances. */
  HOST_THINK_FAST_VALID: 'HOST_THINK_FAST_VALID',
  /** Think Fast: the current team is out of this challenge. */
  HOST_THINK_FAST_ELIMINATE: 'HOST_THINK_FAST_ELIMINATE',
  /**
   * Host confirms the challenge winner. This resolves it and pays any BB.
   *
   * Required even when a team has reached the target — §15-§17 give the Host
   * discretion to end a challenge earlier or later, so a score never resolves
   * anything on its own.
   */
  HOST_CONFIRM_ROUND3_CHALLENGE: 'HOST_CONFIRM_ROUND3_CHALLENGE',
  /** A tied team locks its rock-paper-scissors choice. PLAYER intent. */
  SUBMIT_RPS_CHOICE: 'SUBMIT_RPS_CHOICE',
  /** DEVELOPMENT ONLY — enter Round 3 without playing Rounds 1 and 2. */
  DEV_START_ROUND3: 'DEV_START_ROUND3',
} as const;

export type Round3IntentType = (typeof ROUND3_INTENTS)[keyof typeof ROUND3_INTENTS];

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const ROUND3_EVENTS = {
  ROUND3_STARTED: 'ROUND3_STARTED',
  ROUND3_CHALLENGE_PREPARED: 'ROUND3_CHALLENGE_PREPARED',
  /** A new content item is on screen. Carries only the current item. */
  ROUND3_ITEM_REVEALED: 'ROUND3_ITEM_REVEALED',
  ROUND3_POINT_AWARDED: 'ROUND3_POINT_AWARDED',
  THINK_FAST_TURN_CHANGED: 'THINK_FAST_TURN_CHANGED',
  THINK_FAST_TEAM_ELIMINATED: 'THINK_FAST_TEAM_ELIMINATED',
  ROUND3_CHALLENGE_RESOLVED: 'ROUND3_CHALLENGE_RESOLVED',
  /** The counter changed. Never a BB event. */
  ROUND3_COUNTER_CHANGED: 'ROUND3_COUNTER_CHANGED',
  RPS_STARTED: 'RPS_STARTED',
  /** A team locked a choice. Carries no choice — §18. */
  RPS_CHOICE_SUBMITTED: 'RPS_CHOICE_SUBMITTED',
  RPS_REVEALED: 'RPS_REVEALED',
  ROUND3_WINNER_CONFIRMED: 'ROUND3_WINNER_CONFIRMED',
  ROUND3_COMPLETED: 'ROUND3_COMPLETED',
} as const;

export type Round3EventType = (typeof ROUND3_EVENTS)[keyof typeof ROUND3_EVENTS];
