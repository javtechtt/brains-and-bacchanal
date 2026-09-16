import type { ServerTimestamp, TeamId } from './ids.js';

/**
 * Maco Mail — the wire vocabulary. Phase 6.
 *
 * GAME_RULES_LOCKED.md §7 and §8, DECISION_LOG.md D-010.
 *
 * Draw WITHOUT REPLACEMENT from a 20-card playtest deck. Used outcomes go to a
 * discard pile. Held advantages stay OUT of the deck until used or the game
 * ends. An eligible card with no valid target is a DUD — no redraw, no refund.
 */

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * The fifteen Maco Mail outcomes. GAME_RULES_LOCKED.md §7 / §8.
 *
 * Identifiers, not labels — the same rule as Bacchanal cards. "Wrong Investment
 * Bro!" is `WRONG_INVESTMENT_BRO` here and a display string in the labels map.
 */
export const MACO_OUTCOMES = [
  // Money — §8 "Money/penalty"
  'PLUS_100',
  'PLUS_500',
  'PLUS_1000',
  'PLUS_1500',
  'WRONG_INVESTMENT_BRO',
  'PARTNER_I_SORRY',
  'CUSTOMS_SEIZE_YUH_MONEY',
  // Advantages — §8 "Advantages". These are HELD, not immediate.
  'PLUS_15_SECONDS',
  'FREE_CLUE',
  'BACCHANAL_IMMUNITY',
  'DOUBLE_POINTS',
  // Game-changing — §8 "Game-changing"
  'CANCEL_MARKET_PURCHASE',
  'CARD_CONFISCATION',
  'PRICE_GONE_UP',
  'HANDS_TIED',
] as const;

export type MacoOutcome = (typeof MACO_OUTCOMES)[number];

export const MACO_OUTCOME_LABELS: Readonly<Record<MacoOutcome, string>> = {
  PLUS_100: '+100 BB',
  PLUS_500: '+500 BB',
  PLUS_1000: '+1,000 BB',
  PLUS_1500: '+1,500 BB',
  WRONG_INVESTMENT_BRO: 'Wrong Investment Bro!',
  PARTNER_I_SORRY: 'Partner, I Sorry',
  CUSTOMS_SEIZE_YUH_MONEY: 'Customs Seize Yuh Money',
  PLUS_15_SECONDS: '+15 Seconds',
  FREE_CLUE: 'Free Clue',
  BACCHANAL_IMMUNITY: 'Bacchanal Immunity',
  DOUBLE_POINTS: 'Double Points',
  CANCEL_MARKET_PURCHASE: 'Cancel Market Purchase',
  CARD_CONFISCATION: 'Card Confiscation',
  PRICE_GONE_UP: 'Price Gone Up!',
  HANDS_TIED: 'Hands Tied',
} as const;

/**
 * How an outcome behaves once drawn. Decides the resolution path, not the
 * amount.
 *
 *   immediate_money  resolves at once through the BB ledger
 *   held_advantage   goes to the team's held advantages, used later
 *   targeted         needs a valid opposing target, else a DUD
 *   held_effect      a lasting effect on another team, applied when relevant
 */
export const MACO_RESOLUTION_KINDS = [
  'immediate_money',
  'held_advantage',
  'targeted',
  'held_effect',
] as const;

export type MacoResolutionKind = (typeof MACO_RESOLUTION_KINDS)[number];

export const MACO_RESOLUTION: Readonly<Record<MacoOutcome, MacoResolutionKind>> = {
  PLUS_100: 'immediate_money',
  PLUS_500: 'immediate_money',
  PLUS_1000: 'immediate_money',
  PLUS_1500: 'immediate_money',
  WRONG_INVESTMENT_BRO: 'immediate_money',
  CUSTOMS_SEIZE_YUH_MONEY: 'immediate_money',
  // Needs an opposing team to pay. §8 — "give 500 BB to an opposing team".
  PARTNER_I_SORRY: 'targeted',
  PLUS_15_SECONDS: 'held_advantage',
  FREE_CLUE: 'held_advantage',
  BACCHANAL_IMMUNITY: 'held_advantage',
  DOUBLE_POINTS: 'held_advantage',
  CANCEL_MARKET_PURCHASE: 'targeted',
  CARD_CONFISCATION: 'targeted',
  PRICE_GONE_UP: 'held_effect',
  HANDS_TIED: 'held_effect',
} as const;

/**
 * THE LOCKED MONEY AMOUNTS. GAME_RULES_LOCKED.md §8.
 *
 *   +100 / +500 / +1,000 / +1,500 BB
 *   Wrong Investment Bro!     → lose 250 BB
 *   Customs Seize Yuh Money   → lose 1,000 BB, floor 0
 *
 * PARTNER_I_SORRY IS ABSENT. Its amount (500) is locked, but §8's rule is a
 * TRANSFER between two teams rather than a delta on one, and OPEN_RULES.md §12
 * leaves the payer-under-500 case undecided. Putting a number here would invite
 * treating it as a simple delta and quietly deciding that open rule. It is
 * handled explicitly instead — see PARTNER_I_SORRY_AMOUNT.
 */
export const MACO_MONEY_DELTAS: Readonly<Partial<Record<MacoOutcome, number>>> = {
  PLUS_100: 100,
  PLUS_500: 500,
  PLUS_1000: 1000,
  PLUS_1500: 1500,
  WRONG_INVESTMENT_BRO: -250,
  CUSTOMS_SEIZE_YUH_MONEY: -1000,
} as const;

/**
 * The Partner, I Sorry transfer amount. GAME_RULES_LOCKED.md §8.
 *
 * The AMOUNT is locked at 500. What is NOT locked — OPEN_RULES.md §12 — is what
 * happens when the payer holds less than 500:
 *
 *   - does the recipient get only what can be transferred?
 *   - does the recipient get the full 500 while the payer floors at 0?
 *   - or another rule?
 *
 * Phase 6 spec §26: "Do NOT decide this... keep activation blocked when this
 * open case matters." So the resolver refuses when the payer holds under 500 and
 * resolves normally when they hold 500 or more, where no open question arises.
 */
export const PARTNER_I_SORRY_AMOUNT = 500;

/** The +15 Seconds extension, in milliseconds. GAME_RULES_LOCKED.md §8. */
export const PLUS_15_SECONDS_MS = 15_000;

// ---------------------------------------------------------------------------
// Deck composition
// ---------------------------------------------------------------------------

/**
 * THE APPROVED 20-CARD PLAYTEST DECK. GAME_RULES_LOCKED.md §7 / D-010.
 *
 * | Outcome                 | Copies |
 * | +100 BB                 |      2 |
 * | +500 BB                 |      2 |
 * | +1,000 BB               |      1 |
 * | +1,500 BB               |      1 |
 * | Wrong Investment Bro!   |      2 |
 * | Partner, I Sorry        |      1 |
 * | Customs Seize Yuh Money |      1 |
 * | +15 Seconds             |      2 |
 * | Free Clue               |      2 |
 * | Bacchanal Immunity      |      1 |
 * | Double Points           |      1 |
 * | Cancel Market Purchase  |      1 |
 * | Card Confiscation       |      1 |
 * | Price Gone Up!          |      1 |
 * | Hands Tied              |      1 |
 * |                   TOTAL |     20 |
 *
 * Phase 6 spec §23 — "Keep deck composition configuration-driven. Do not bury
 * counts in implementation code where changing the test deck becomes
 * difficult." This constant is the whole composition; the deck builder reads it
 * and nothing else, so changing the playtest mix is a change to this table.
 */
export const MACO_DECK_COMPOSITION: Readonly<Record<MacoOutcome, number>> = {
  PLUS_100: 2,
  PLUS_500: 2,
  PLUS_1000: 1,
  PLUS_1500: 1,
  WRONG_INVESTMENT_BRO: 2,
  PARTNER_I_SORRY: 1,
  CUSTOMS_SEIZE_YUH_MONEY: 1,
  PLUS_15_SECONDS: 2,
  FREE_CLUE: 2,
  BACCHANAL_IMMUNITY: 1,
  DOUBLE_POINTS: 1,
  CANCEL_MARKET_PURCHASE: 1,
  CARD_CONFISCATION: 1,
  PRICE_GONE_UP: 1,
  HANDS_TIED: 1,
} as const;

/** Total cards in a fresh deck. Derived, so it can never disagree. */
export const MACO_DECK_SIZE = Object.values(MACO_DECK_COMPOSITION).reduce(
  (total, count) => total + count,
  0,
);

// ---------------------------------------------------------------------------
// Draw results
// ---------------------------------------------------------------------------

/**
 * How a drawn card ended up. GAME_RULES_LOCKED.md §7.
 *
 * THE DUD DISTINCTION MATTERS (Phase 6 spec §35). Two different things can make
 * a card unusable, and they are handled at different moments:
 *
 *   STRUCTURALLY IMPOSSIBLE — filtered out BEFORE the draw. The effect could
 *   never apply for the rest of the game (e.g. Hands Tied with no eligible
 *   future challenge). It is removed from the draw pool, so it is never drawn.
 *
 *   CURRENTLY NO VALID TARGET — a DUD, decided AFTER the draw. The card was a
 *   legitimate candidate, was drawn fairly, and simply has nothing to hit right
 *   now (e.g. Cancel Market Purchase when no opponent holds an unused item).
 *   §7: "no redraw/refund/compensation for dud."
 */
export const MACO_DRAW_RESULTS = [
  /** Resolved immediately — money moved. */
  'resolved',
  /** Became a held advantage the team uses later. */
  'held',
  /** Applied a lasting effect to another team. */
  'applied',
  /** Eligible but no valid target. No redraw, no refund. §7. */
  'dud',
  /**
   * Could not resolve because a rule is still open.
   *
   * Today this is only Partner, I Sorry with a payer under 500 BB
   * (OPEN_RULES.md §12). The card is NOT treated as a dud, because a dud is a
   * locked outcome with consequences and this is an absence of a rule. The Host
   * is told, and the card is held aside pending the owner's decision.
   */
  'blocked_open_rule',
] as const;

export type MacoDrawResult = (typeof MACO_DRAW_RESULTS)[number];

/**
 * One drawn Maco Mail card.
 *
 * VISIBILITY: a draw is revealed to the drawing team and the Host. Phase 6 spec
 * §42 forbids leaking "unrevealed Maco Mail draw if not yet meant to be shown"
 * — so the deck's remaining order is never on the wire at all, and this record
 * only ever describes a card that has already been drawn.
 */
export interface MacoDrawView {
  readonly drawId: string;
  readonly teamId: TeamId;
  readonly outcome: MacoOutcome;
  readonly result: MacoDrawResult;
  readonly drawnAt: ServerTimestamp;
  /** BB actually moved, after the floor. Zero for non-money outcomes. */
  readonly bbApplied: number;
  /** The team affected, for targeted and held effects. */
  readonly targetTeamId: TeamId | null;
  /** The held advantage created, when the outcome produced one. */
  readonly advantageId: string | null;
  /**
   * Plain-language explanation for the Host display.
   *
   * Descriptive only — never a rule input. Explains a dud or an open-rule block
   * so the Host is not left guessing why a card did nothing.
   */
  readonly explanation: string;
}

/**
 * The deck as clients may see it.
 *
 * COUNTS ONLY, NEVER ORDER. Phase 6 spec §42 lists "future deck order" as
 * hidden information. Knowing the next card would be worth more than any card
 * in the game, so the remaining order does not appear in any view — not even
 * the Host's. The Host runs the show; they do not need to see the deck, and a
 * Host display is often pointed at a TV the players can see.
 */
export interface MacoDeckView {
  /** Cards left in the draw pile. */
  readonly drawPileCount: number;
  /** Cards in the discard pile. */
  readonly discardCount: number;
  /** Cards currently held as advantages, and therefore out of the deck. §7. */
  readonly heldOutOfDeckCount: number;
  /** Cards removed as structurally impossible before drawing. §7. */
  readonly removedImpossibleCount: number;
}

// ---------------------------------------------------------------------------
// Held effects on another team
// ---------------------------------------------------------------------------

/**
 * A lasting effect one team has placed on another.
 *
 * Distinct from a held ADVANTAGE (market.ts), which benefits its holder. These
 * are burdens: Price Gone Up! raises a rival's next purchase, Hands Tied lets
 * an opponent choose a rival's answerer.
 */
export const HELD_EFFECT_TYPES = [
  /** Target's next Market purchase costs +500. One purchase only. §8. */
  'PRICE_GONE_UP',
  /**
   * The placing team chooses the target's next eligible individual answerer.
   *
   * WHICH challenges count is NOT decided here. Phase 6 spec §34 — "Do not
   * invent which future rounds/challenges count beyond existing challenge
   * metadata. Future round implementation supplies the eligibility."
   */
  'HANDS_TIED',
] as const;

export type HeldEffectType = (typeof HELD_EFFECT_TYPES)[number];

export interface HeldEffectView {
  readonly effectId: string;
  readonly type: HeldEffectType;
  /** The team the effect acts upon. */
  readonly targetTeamId: TeamId;
  /** The team that placed it, and who benefits from it. */
  readonly placedByTeamId: TeamId;
  readonly placedAt: ServerTimestamp;
  readonly consumed: boolean;
  readonly consumedAt: ServerTimestamp | null;
}
