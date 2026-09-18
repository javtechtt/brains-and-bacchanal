import type { ChallengeId, ServerTimestamp, TeamId } from './ids.js';

/**
 * Bacchanal Cards — the wire vocabulary. Phase 6.
 *
 * GAME_RULES_LOCKED.md §2, §3, §5, §6 and DECISION_LOG.md D-007.
 *
 * ================== IDENTIFIERS, NOT LABELS ==================
 * Phase 6 spec §2 — "Use stable internal IDs/types. Do not let display labels
 * become implementation identifiers."
 *
 * So the card is `GIMME_DAT`, never "Gimme Dat!". The punctuation, the
 * capitalisation and the Trini spelling are all presentation, and presentation
 * changes: a Unity designer renaming a card on screen must not be able to break
 * an eligibility table. `CARD_DISPLAY_LABELS` below is the one place the two
 * meet, and it is for display only.
 * =============================================================
 */

// ---------------------------------------------------------------------------
// Card types and categories
// ---------------------------------------------------------------------------

/**
 * The seven Bacchanal card types. GAME_RULES_LOCKED.md §2.
 *
 * MACO IS NOW LEGAL, IN ROUND 1 ONLY. D-030 closed OPEN_RULES.md §7, and Phase
 * 7C added the `ROUND1_TRIVIA` entry that `CARDS_WITHOUT_LEGAL_CHALLENGE` was
 * built to notice. The card is no longer held-but-unplayable.
 */
export const BACCHANAL_CARD_TYPES = [
  'STEUPS',
  'GIMME_DAT',
  'MACO',
  'DOUBLE_IT',
  'DOH_KNOW',
  'FORGIVE_MEH',
  'ALLYUH_HELP_ME',
] as const;

export type BacchanalCardType = (typeof BACCHANAL_CARD_TYPES)[number];

/**
 * The three Clash categories. GAME_RULES_LOCKED.md §2 and §5.
 *
 * These are not cosmetic groupings — the Clash triangle is defined over them,
 * so the category IS the combat mechanic.
 */
export const BACCHANAL_CATEGORIES = ['DISRUPTION', 'POWER', 'RECOVERY'] as const;

export type BacchanalCategory = (typeof BACCHANAL_CATEGORIES)[number];

/**
 * Which category each card belongs to.
 *
 * Phase 6 spec §4 — "Use category information centrally. Do not duplicate
 * category mappings throughout round code." This constant is that single place;
 * `categoryOf` below is the only way anything should ask.
 *
 * GAME_RULES_LOCKED.md §2 names the groups "Disruption", "Power / Strategy" and
 * "Recovery / Social". The shortened identifiers are the same three groups.
 */
const CARD_CATEGORY: Readonly<Record<BacchanalCardType, BacchanalCategory>> = {
  STEUPS: 'DISRUPTION',
  GIMME_DAT: 'DISRUPTION',
  MACO: 'DISRUPTION',
  DOUBLE_IT: 'POWER',
  DOH_KNOW: 'POWER',
  FORGIVE_MEH: 'RECOVERY',
  ALLYUH_HELP_ME: 'RECOVERY',
} as const;

/** The category a card belongs to. The single source for this mapping. */
export function categoryOf(cardType: BacchanalCardType): BacchanalCategory {
  return CARD_CATEGORY[cardType];
}

/** Every card in a category, in declaration order. */
export function cardsInCategory(category: BacchanalCategory): readonly BacchanalCardType[] {
  return BACCHANAL_CARD_TYPES.filter((type) => CARD_CATEGORY[type] === category);
}

/**
 * Display labels, for presentation only.
 *
 * NOTHING MAY BRANCH ON THESE. They exist so Unity and the web app agree on
 * spelling without either inventing it, and so a rename is a one-line change
 * here rather than a search through rule code.
 */
export const CARD_DISPLAY_LABELS: Readonly<Record<BacchanalCardType, string>> = {
  STEUPS: 'Steups!',
  GIMME_DAT: 'Gimme Dat!',
  MACO: 'Maco!',
  DOUBLE_IT: 'Double It!',
  DOH_KNOW: 'Doh Know',
  FORGIVE_MEH: 'FORGIVE MEH!',
  ALLYUH_HELP_ME: 'ALLYUH HELP ME!',
} as const;

// ---------------------------------------------------------------------------
// The Clash triangle
// ---------------------------------------------------------------------------

/**
 * What each category beats. GAME_RULES_LOCKED.md §5.
 *
 *   DISRUPTION beats POWER
 *   POWER      beats RECOVERY
 *   RECOVERY   beats DISRUPTION
 *
 * A closed three-cycle, so there is no strongest card — which is why a tie has
 * to be its own outcome (Part Dat Fight) rather than a tiebreak.
 */
const BEATS: Readonly<Record<BacchanalCategory, BacchanalCategory>> = {
  DISRUPTION: 'POWER',
  POWER: 'RECOVERY',
  RECOVERY: 'DISRUPTION',
} as const;

/** Whether `attacker` beats `defender` in the category triangle. */
export function categoryBeats(
  attacker: BacchanalCategory,
  defender: BacchanalCategory,
): boolean {
  return BEATS[attacker] === defender;
}

// ---------------------------------------------------------------------------
// Challenge compatibility
// ---------------------------------------------------------------------------

/**
 * The challenge kinds the locked compatibility table names.
 *
 * DISTINCT FROM `challengeType`, which stays a free string on a challenge (see
 * game.ts). This enum is only the vocabulary of the eligibility table, so a
 * round can declare "for card purposes I am a Round 1 trivia question" without
 * the engine gaining an opinion about what a round contains — OPEN_RULES.md §1
 * still leaves that open.
 *
 * FAMILY_FEUD is split at Q3/Q4 because the locked table splits there:
 * GAME_RULES_LOCKED.md §6 — "Q4/Q5 are already doubled, so Double It cannot be
 * used."
 */
export const CARD_CHALLENGE_KINDS = [
  'ROUND1_TRIVIA',
  'ROUND2_PHYSICAL',
  'THINK_FAST',
  'GUESS_THE_LOGO',
  'ALL_ANSWERS_BEGIN_WITH',
  'SING_A_SONG',
  'FAMILY_FEUD_Q1_Q3',
  'FAMILY_FEUD_Q4_Q5',
  'SUDDEN_DEATH',
] as const;

export type CardChallengeKind = (typeof CARD_CHALLENGE_KINDS)[number];

/**
 * THE APPROVED COMPATIBILITY TABLE. GAME_RULES_LOCKED.md §6 / D-007.
 *
 * Transcribed exactly. Nothing is added, and the absences are as deliberate as
 * the entries:
 *
 *   - MACO is legal in ROUND1_TRIVIA, and only there (D-030). Round 1's
 *     simultaneous format is what gives the card a meaning: there is a submitted
 *     opponent answer to look at.
 *   - GIMME_DAT and DOH_KNOW were REMOVED from ROUND1_TRIVIA by D-030. Both act
 *     on an individually assigned question, and Round 1 no longer assigns one —
 *     every team answers the same question at the same time (§11).
 *   - SUDDEN_DEATH is empty because §21 bars cards entirely.
 *   - DOUBLE_IT is absent from FAMILY_FEUD_Q4_Q5 because those questions are
 *     already doubled and multipliers never stack (§3).
 */
export const CARD_ELIGIBILITY: Readonly<
  Record<CardChallengeKind, readonly BacchanalCardType[]>
> = {
  ROUND1_TRIVIA: ['MACO', 'DOUBLE_IT', 'ALLYUH_HELP_ME', 'FORGIVE_MEH'],
  ROUND2_PHYSICAL: ['DOUBLE_IT'],
  THINK_FAST: ['STEUPS', 'DOUBLE_IT', 'FORGIVE_MEH'],
  GUESS_THE_LOGO: ['DOUBLE_IT'],
  ALL_ANSWERS_BEGIN_WITH: ['DOUBLE_IT', 'FORGIVE_MEH'],
  SING_A_SONG: ['DOUBLE_IT'],
  FAMILY_FEUD_Q1_Q3: ['STEUPS', 'DOUBLE_IT', 'FORGIVE_MEH'],
  FAMILY_FEUD_Q4_Q5: ['STEUPS', 'FORGIVE_MEH'],
  SUDDEN_DEATH: [],
} as const;

/**
 * Whether a card may legally be played into a challenge kind.
 *
 * The ONLY place this question is answered. Phase 6 spec §5 requires the table
 * to stay configuration-driven and §7 requires the server to reject an illegal
 * play even when a client would have hidden the button.
 */
export function isCardEligible(
  cardType: BacchanalCardType,
  kind: CardChallengeKind,
): boolean {
  return CARD_ELIGIBILITY[kind].includes(cardType);
}

/**
 * Whether a card type has ANY legal challenge at all.
 *
 * Now true for all seven. It was false for MACO while OPEN_RULES.md §7 stood
 * open, which is why the question is asked here rather than special-cased in the
 * play path: resolving the rule (D-030) changed one table entry and this
 * followed. Kept because the same situation can recur for a future card.
 */
export function cardHasAnyLegalChallenge(cardType: BacchanalCardType): boolean {
  return CARD_CHALLENGE_KINDS.some((kind) => isCardEligible(cardType, kind));
}

/**
 * Card types that currently have no legal challenge anywhere.
 *
 * Today: `['GIMME_DAT', 'DOH_KNOW']`.
 *
 * It held `['MACO']` until D-030, which swapped the membership entirely: Maco
 * gained Round 1, and Gimme Dat! and Doh Know LOST it, leaving those two with no
 * legal row anywhere. That is a genuine consequence of Round 1 dropping
 * individually assigned questions, not an oversight — Family Feud and Round 4
 * may yet give them one, and until then they are dealt and held exactly as Maco
 * was.
 *
 * Derived rather than written down, which is why the swap needed no hunting.
 */
export const CARDS_WITHOUT_LEGAL_CHALLENGE: readonly BacchanalCardType[] =
  BACCHANAL_CARD_TYPES.filter((type) => !cardHasAnyLegalChallenge(type));

// ---------------------------------------------------------------------------
// The starting hand
// ---------------------------------------------------------------------------

/**
 * The pool each starting card is drawn from. GAME_RULES_LOCKED.md §2 — one
 * random card from each of the three categories.
 *
 * MACO IS IN THE DISRUPTION POOL, and since D-030 it is playable — in Round 1
 * trivia, and only there (§6). Phase 6 kept it dealt while it had no legal
 * challenge rather than engineering it out of the deck, which is why resolving
 * the rule needed no change here at all.
 */
export const STARTING_HAND_POOLS: readonly (readonly BacchanalCardType[])[] = [
  cardsInCategory('DISRUPTION'),
  cardsInCategory('POWER'),
  cardsInCategory('RECOVERY'),
];

// ---------------------------------------------------------------------------
// Card instances
// ---------------------------------------------------------------------------

/**
 * A card's lifecycle state. Phase 6 spec §2.
 *
 *   HELD      in the owner's hand, not committed to anything
 *   PENDING   played into a challenge, inside the Clash response window
 *   RESOLVING past the window, its effect being applied
 *   CONSUMED  spent; gone for the rest of the game
 *
 * A losing Clash card goes back to HELD — GAME_RULES_LOCKED.md §5, "Losing card
 * returns" — while the separate one-card-per-challenge record keeps it out of
 * that challenge. Those are two different facts and are stored separately, per
 * Phase 6 spec §8: "Represent this explicitly rather than inferring from card
 * inventory."
 */
export const CARD_STATUSES = ['HELD', 'PENDING', 'RESOLVING', 'CONSUMED'] as const;

export type CardStatus = (typeof CARD_STATUSES)[number];

/**
 * One physical card belonging to one team.
 *
 * `cardInstanceId` rather than a bare type because a team could, through Card
 * Confiscation, end up holding two of the same type — and "which one was
 * played" has to have an answer.
 */
export interface BacchanalCardInstance {
  readonly cardInstanceId: string;
  readonly cardType: BacchanalCardType;
  readonly category: BacchanalCategory;
  readonly owningTeamId: TeamId;
  readonly status: CardStatus;
  readonly dealtAt: ServerTimestamp;
  /** Set when the card is spent. Null while it can still be played. */
  readonly usedAt: ServerTimestamp | null;
  /** The challenge it is currently committed to, if any. */
  readonly challengeId: ChallengeId | null;
}

/**
 * A card as its OWNER sees it, with whether it can be played right now.
 *
 * `playable` is computed by the server, so a phone never decides legality — it
 * renders what it is told. `reason` explains a disabled card, which is what
 * makes a permanently-unplayable MACO comprehensible rather than a bug report.
 */
export interface OwnCardView extends BacchanalCardInstance {
  readonly playable: boolean;
  /** Why not, when `playable` is false. Null when it is playable. */
  readonly unplayableReason: CardUnplayableReason | null;
}

export const CARD_UNPLAYABLE_REASONS = [
  /** No challenge is open to play into. */
  'no_challenge',
  /** The card is not in the challenge's eligibility list. */
  'not_eligible',
  /**
   * The card has no legal challenge anywhere — MACO, pending OPEN_RULES.md §7.
   * Distinct from `not_eligible` so a UI can say "not yet decided" rather than
   * "wrong challenge", which would imply a right one exists.
   */
  'compatibility_unresolved',
  /** This team already played a Bacchanal card in this challenge. §2. */
  'already_played_this_challenge',
  /** This specific card lost a Clash here and cannot return. §5. */
  'lost_clash_this_challenge',
  /** The card is not HELD — it is committed or spent. */
  'not_held',
  /** The timing window for playing a card has closed. */
  'window_closed',
  /** The game is paused. */
  'paused',
] as const;

export type CardUnplayableReason = (typeof CARD_UNPLAYABLE_REASONS)[number];

/**
 * What one team may know about ANOTHER team's hand.
 *
 * Phase 6 spec §42 — a player client must never receive "opponent unrevealed
 * Bacchanal cards". So this carries a COUNT and nothing else. There is no
 * optional `cards` field to forget to strip: the type cannot express the
 * secret.
 */
export interface OpponentHandView {
  readonly teamId: TeamId;
  /** How many cards they hold. Types deliberately absent. */
  readonly cardCount: number;
  /** Whether they have already played a card in the current challenge. */
  readonly playedThisChallenge: boolean;
}

// ---------------------------------------------------------------------------
// Clash
// ---------------------------------------------------------------------------

/**
 * The hidden response window, in milliseconds. GAME_RULES_LOCKED.md §5 —
 * "opponents get a 6-second hidden response window".
 *
 * Raised from 3 to 6 seconds by the project owner after physical testing
 * showed 3 seconds too short to actually notice and respond to a Clash. See
 * DECISION_LOG.md D-029.
 *
 * ONE OF THE FEW DURATIONS THAT IS ACTUALLY LOCKED. Think Fast (OPEN_RULES.md
 * §2), Sing a Song (§6) and the Round 4 timers (§11) are all open and must stay
 * caller-supplied; this one is written in the locked rules, so it lives here
 * rather than in a round's configuration.
 */
export const CLASH_RESPONSE_WINDOW_MS = 6_000;

/** How a Clash ended. GAME_RULES_LOCKED.md §5. */
export const CLASH_OUTCOMES = [
  /** Nobody countered. The original card resolves normally. */
  'uncontested',
  /** One card survived the triangle and resolves. */
  'winner',
  /**
   * PART DAT FIGHT — surviving categories tied. No effect resolves, tied cards
   * return, and those teams are done playing cards for this challenge.
   */
  'part_dat_fight',
] as const;

export type ClashOutcome = (typeof CLASH_OUTCOMES)[number];

/**
 * A Clash as clients may see it WHILE THE WINDOW IS OPEN.
 *
 * Phase 6 spec §42 — "hidden Clash responses before reveal" must not leak. This
 * view carries who has responded, never WHAT they responded with. A responder's
 * own choice comes back in their own acknowledgement, not in this broadcast.
 */
export interface ClashView {
  readonly clashId: string;
  readonly challengeId: ChallengeId;
  /** The team that played the card being contested. */
  readonly initiatingTeamId: TeamId;
  /** The card that opened the Clash. Public — it is what is being responded to. */
  readonly initiatingCardType: BacchanalCardType;
  readonly openedAt: ServerTimestamp;
  /** Milliseconds left in the response window, computed server-side. */
  readonly remainingMs: number;
  /**
   * Teams that have locked a response. WHAT they chose is not here.
   *
   * Shown so the Host display can say "Team B has responded" — which is part of
   * the theatre — without revealing the card.
   */
  readonly respondedTeamIds: readonly TeamId[];
  /** Teams still able to respond. */
  readonly eligibleTeamIds: readonly TeamId[];
  readonly resolved: boolean;
  /** Populated only once the window closes and the reveal happens. */
  readonly result: ClashResult | null;
}

/**
 * The revealed outcome of a Clash.
 *
 * Every card played is named here, because after the reveal there is nothing
 * left to hide — and a Host explaining "why did our card do nothing?" needs the
 * whole picture.
 */
export interface ClashResult {
  readonly outcome: ClashOutcome;
  /** The team whose card resolves, if any. Null for a Part Dat Fight. */
  readonly winningTeamId: TeamId | null;
  readonly winningCardType: BacchanalCardType | null;
  /** Every card that took part, revealed. */
  readonly entries: readonly ClashEntryView[];
  /** Teams whose cards returned to hand but are barred for this challenge. §5. */
  readonly returnedTeamIds: readonly TeamId[];
  readonly resolvedAt: ServerTimestamp;
  /**
   * Plain-language explanation of the triangle result, for the Host display.
   * Never a rule input — purely descriptive.
   */
  readonly explanation: string;
}

/** One team's card in a revealed Clash. */
export interface ClashEntryView {
  readonly teamId: TeamId;
  readonly cardInstanceId: string;
  readonly cardType: BacchanalCardType;
  readonly category: BacchanalCategory;
  /** True for the card that opened the Clash. */
  readonly initiator: boolean;
  /** Whether this card survived to resolve. */
  readonly survived: boolean;
}

// ---------------------------------------------------------------------------
// Pending card effects
// ---------------------------------------------------------------------------

/**
 * A card effect that has resolved through the Clash and is now in force.
 *
 * WHAT AN EFFECT DOES IS NOT DECIDED HERE. This records that Team A's DOUBLE_IT
 * is active on challenge X; what the reward is, and therefore what doubling it
 * produces, is the round's — Phase 7's — and for several challenges still open.
 * The shared system tracks eligibility and consumption; the round supplies the
 * number.
 */
export interface ActiveCardEffectView {
  readonly effectId: string;
  readonly cardType: BacchanalCardType;
  readonly owningTeamId: TeamId;
  readonly challengeId: ChallengeId;
  /** The team this effect is aimed at, for cards that need a target. */
  readonly targetTeamId: TeamId | null;
  readonly appliedAt: ServerTimestamp;
  /** Cleared when the challenge ends or the effect is spent. */
  readonly active: boolean;
  /**
   * Free-form, effect-specific state that later rounds fill in.
   *
   * Deliberately opaque at this layer: STEUPS needs a removed answer, DOH_KNOW
   * needs the receiving team, HANDS_TIED needs a nominated player. Modelling
   * each precisely now would require deciding round rules that are not decided.
   */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Which cards require a target team when played.
 *
 * From the locked effects (GAME_RULES_LOCKED.md §3): Gimme Dat steals "another
 * team's" question, Doh Know passes "to another team", Allyuh Help Me consults
 * "another team", Steups acts "on an opposing team's valid answer".
 *
 * Double It and Forgive Meh act on the owner's own play and take no target.
 * MACO is absent for the same reason it is absent everywhere — §7 is open.
 */
export const CARDS_REQUIRING_TARGET: readonly BacchanalCardType[] = [
  'GIMME_DAT',
  'DOH_KNOW',
  'ALLYUH_HELP_ME',
  'STEUPS',
];

/** Whether playing this card requires naming an opposing team. */
export function cardRequiresTarget(cardType: BacchanalCardType): boolean {
  return CARDS_REQUIRING_TARGET.includes(cardType);
}
