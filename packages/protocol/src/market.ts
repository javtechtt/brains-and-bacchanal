import type { ServerTimestamp, TeamId } from './ids.js';

/**
 * The Market — the wire vocabulary. Phase 6.
 *
 * GAME_RULES_LOCKED.md §10. Opens before Rounds 2, 3 and 4 — never before
 * Round 1. Shopping is hidden until the Market closes.
 *
 * PRICES ARE CONFIGURATION, NOT CODE PATHS. Phase 6 spec §19 — "Keep pricing
 * config-driven. Do not scatter prices through UI code." The table below is the
 * one place a price is written; every client asks the server what something
 * costs, and the server answers from here.
 */

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * The five Market items. GAME_RULES_LOCKED.md §10.
 *
 * `MACO_MAIL` is a purchase that yields a Maco Mail draw, not an advantage in
 * itself — §10: "purchased Maco Mail opens after reveal."
 */
export const MARKET_ITEMS = [
  'CLUE',
  'SECOND_CHANCE',
  'DOUBLE_BB',
  'EXTRA_TIME',
  'MACO_MAIL',
] as const;

export type MarketItem = (typeof MARKET_ITEMS)[number];

export const MARKET_ITEM_LABELS: Readonly<Record<MarketItem, string>> = {
  CLUE: 'Clue',
  SECOND_CHANCE: 'Second Chance',
  DOUBLE_BB: 'Double BB',
  EXTRA_TIME: 'Extra Time (+15 sec)',
  MACO_MAIL: 'Maco Mail',
} as const;

/**
 * Which round a Market activation precedes.
 *
 * GAME_RULES_LOCKED.md §10 — the Market opens before Rounds 2, 3 and 4, and
 * NOT before Round 1. Typing it as 2 | 3 | 4 means "Market before Round 1" is
 * not a state the protocol can express, which is a stronger guarantee than a
 * runtime check.
 */
export type MarketRound = 2 | 3 | 4;

export const MARKET_ROUNDS: readonly MarketRound[] = [2, 3, 4];

/**
 * THE LOCKED PRICE TABLE. GAME_RULES_LOCKED.md §10.
 *
 * | Item           | Before R2 | Before R3 | Before R4 |
 * | Clue           |       200 |       250 |       400 |
 * | Second Chance  |       250 |       300 |       500 |
 * | Double BB      |       250 |       300 |       750 |
 * | Extra Time     |       200 |       250 |       400 |
 * | Maco Mail      |       500 |       500 |       750 |
 *
 * Transcribed exactly, and nowhere else.
 */
export const MARKET_PRICES: Readonly<Record<MarketItem, Readonly<Record<MarketRound, number>>>> = {
  CLUE: { 2: 200, 3: 250, 4: 400 },
  SECOND_CHANCE: { 2: 250, 3: 300, 4: 500 },
  DOUBLE_BB: { 2: 250, 3: 300, 4: 750 },
  EXTRA_TIME: { 2: 200, 3: 250, 4: 400 },
  MACO_MAIL: { 2: 500, 3: 500, 4: 750 },
} as const;

/** The listed price of an item for a given Market round, before surcharge. */
export function listedPrice(item: MarketItem, round: MarketRound): number {
  return MARKET_PRICES[item][round];
}

/**
 * The Price Gone Up! surcharge, in BB. GAME_RULES_LOCKED.md §8 via the Maco
 * Mail effect list, and Phase 6 spec §33 — "target team's NEXT Market purchase
 * costs +500".
 */
export const PRICE_GONE_UP_SURCHARGE = 500;

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

/**
 * One purchase made by one team in one Market activation.
 *
 * `pricePaid` RECORDS WHAT ACTUALLY LEFT THE LEDGER, including any surcharge.
 * Phase 6 spec §31 — Cancel Market Purchase refunds "the actual amount paid...
 * includes any surcharge paid", and "Do not recalculate refund from current
 * listed price". Storing the listed price and re-deriving would get that wrong
 * for any team that was surcharged, so the paid amount is stored outright.
 */
export interface MarketPurchaseView {
  readonly purchaseId: string;
  readonly teamId: TeamId;
  readonly item: MarketItem;
  /** The Market activation this was bought in. */
  readonly round: MarketRound;
  /** Listed price at time of purchase, before surcharge. For display. */
  readonly listedPrice: number;
  /** Surcharge actually applied, 0 when none. */
  readonly surcharge: number;
  /** listedPrice + surcharge. What the ledger actually deducted. */
  readonly pricePaid: number;
  readonly purchasedAt: ServerTimestamp;
  /**
   * Whether the item has been used.
   *
   * Cancel Market Purchase may only destroy an UNUSED item (Phase 6 spec §31),
   * so this is a rule input, not just display.
   */
  readonly used: boolean;
  /** Set when Cancel Market Purchase destroyed this. */
  readonly cancelled: boolean;
  /**
   * The round after which this expires. GAME_RULES_LOCKED.md §10 — "items
   * expire after the immediately following round".
   *
   * Bought before Round 2 → usable during Round 2 → expires at the end of
   * Round 2. So this equals `round`.
   */
  readonly expiresAfterRound: number;
  /** Set once expiry has actually been applied. */
  readonly expired: boolean;
}

/**
 * A Market activation.
 *
 * `open` and the hidden/revealed distinction are the whole point: §10 says
 * "shopping is hidden" and "purchases reveal when Market closes".
 */
export interface MarketView {
  readonly marketId: string;
  readonly round: MarketRound;
  readonly open: boolean;
  readonly openedAt: ServerTimestamp;
  readonly closedAt: ServerTimestamp | null;
  /**
   * Whether purchases have been revealed. False while open, true after close.
   *
   * Separate from `open` rather than derived, so the reveal is an explicit
   * recorded step rather than an inference a client could get wrong.
   */
  readonly revealed: boolean;
  /** What each item costs this activation, before any surcharge. */
  readonly prices: Readonly<Record<MarketItem, number>>;
}

/**
 * What a TEAM may see of the Market.
 *
 * Phase 6 spec §42 — "hidden Market purchases before reveal" must not leak. So
 * this carries the team's OWN purchases plus, once revealed, everyone's. While
 * the Market is open, `otherTeamPurchases` is empty by construction rather than
 * filtered at send time.
 */
export interface TeamMarketView {
  readonly market: MarketView | null;
  /** This team's own purchases in the current activation. Always visible. */
  readonly yourPurchases: readonly MarketPurchaseView[];
  /**
   * Other teams' purchases. EMPTY until the Market closes and reveals.
   *
   * A count is not exposed either: knowing "Team B bought 3 things" before the
   * reveal is itself information §10 hides.
   */
  readonly otherTeamPurchases: readonly MarketPurchaseView[];
  /** Surcharge this team will pay on its next purchase. 0 when none. */
  readonly pendingSurcharge: number;
  /** Items this team may still buy — one copy each per activation. */
  readonly availableItems: readonly MarketItem[];
}

// ---------------------------------------------------------------------------
// Held advantages
// ---------------------------------------------------------------------------

/**
 * The advantages a team can hold, whatever their source.
 *
 * ONE VOCABULARY FOR TWO SOURCES. A Clue from the Market and a Free Clue from
 * Maco Mail are the same advantage arriving two ways, and Phase 6 spec §40
 * requires stacking limits to be centralised — "maximum one clue" has to mean
 * one clue total, not one per source. Sharing the type is what makes that
 * checkable in one place.
 */
export const ADVANTAGE_TYPES = [
  /** One clue on a clue-enabled question. Market CLUE, Maco FREE_CLUE. */
  'CLUE',
  /** One retry. Market SECOND_CHANCE. Shares a budget with FORGIVE_MEH. */
  'SECOND_CHANCE',
  /** Doubles an eligible reward. Market DOUBLE_BB, Maco DOUBLE_POINTS. */
  'DOUBLE',
  /** +15 seconds on a timed challenge. Market EXTRA_TIME, Maco PLUS_15_SECONDS. */
  'EXTRA_TIME',
  /** Cancels a Bacchanal card used against the holder. Maco only. */
  'BACCHANAL_IMMUNITY',
] as const;

export type AdvantageType = (typeof ADVANTAGE_TYPES)[number];

export const ADVANTAGE_LABELS: Readonly<Record<AdvantageType, string>> = {
  CLUE: 'Clue',
  SECOND_CHANCE: 'Second Chance',
  DOUBLE: 'Double',
  EXTRA_TIME: 'Extra Time',
  BACCHANAL_IMMUNITY: 'Bacchanal Immunity',
} as const;

/** Where an advantage came from. Decides its expiry rule. */
export type AdvantageSource = 'market' | 'maco_mail';

/**
 * A held advantage.
 *
 * EXPIRY DIFFERS BY SOURCE, and that is a locked distinction:
 *   - Market items "expire after the immediately following round" (§10).
 *   - Maco Mail held advantages "stay out until used or game ends" (§7).
 *
 * So `expiresAfterRound` is a number for a Market advantage and null for a Maco
 * Mail one. Modelling them with one type and a nullable field keeps the
 * stacking rules ("maximum one clue") over a single list.
 */
export interface HeldAdvantageView {
  readonly advantageId: string;
  readonly type: AdvantageType;
  readonly teamId: TeamId;
  readonly source: AdvantageSource;
  /** The Market purchase that produced it, when it came from the Market. */
  readonly purchaseId: string | null;
  readonly acquiredAt: ServerTimestamp;
  /** Null means "until used or the game ends" — the Maco Mail rule. */
  readonly expiresAfterRound: number | null;
  readonly used: boolean;
  readonly usedAt: ServerTimestamp | null;
  readonly expired: boolean;
}

// ---------------------------------------------------------------------------
// Stacking limits
// ---------------------------------------------------------------------------

/**
 * The advantage limits that apply WITHIN ONE CHALLENGE.
 *
 * GAME_RULES_LOCKED.md §10 — "No stacking: one Double, one clue, one time
 * extension, one retry maximum." §4 — Second Chance and FORGIVE MEH! cannot be
 * chained, maximum one retry on the same question. §3 — "multipliers never
 * stack".
 *
 * Phase 6 spec §40 — "Future round code must query this shared system rather
 * than implementing its own stacking logic."
 */
export const ADVANTAGE_LIMITS_PER_CHALLENGE: Readonly<Record<AdvantageType, number>> = {
  CLUE: 1,
  SECOND_CHANCE: 1,
  DOUBLE: 1,
  EXTRA_TIME: 1,
  // Immunity is not a per-challenge budget — it is consumed when it triggers.
  // Recorded as 1 so a team cannot burn two on one attacking card.
  BACCHANAL_IMMUNITY: 1,
} as const;

/**
 * The shared retry budget, per challenge. GAME_RULES_LOCKED.md §4 / D-006.
 *
 * ONE retry on the same question, whether it comes from Market Second Chance or
 * from FORGIVE MEH!. If a team holds both, using one leaves the other available
 * for a later question — so this is a per-challenge budget over a shared pool,
 * not a per-item flag.
 */
export const MAX_RETRIES_PER_CHALLENGE = 1;

/** What a team has already spent in the current challenge. */
export interface ChallengeAdvantageUsage {
  readonly clueUsed: boolean;
  readonly doubleUsed: boolean;
  readonly extraTimeUsed: boolean;
  /** Retries taken. Capped at MAX_RETRIES_PER_CHALLENGE. */
  readonly retriesUsed: number;
  /** How the retry was spent, for the audit trail and the Host display. */
  readonly retrySource: 'second_chance' | 'forgive_meh' | null;
  /** Whether a Bacchanal card has been played. GAME_RULES_LOCKED.md §2. */
  readonly bacchanalCardPlayed: boolean;
}
