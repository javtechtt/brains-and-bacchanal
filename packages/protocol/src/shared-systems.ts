import type {
  ActiveCardEffectView,
  BacchanalCardInstance,
  CardChallengeKind,
  ClashView,
  OpponentHandView,
  OwnCardView,
} from './cards.js';
import type { HostDealView, WagerView } from './deals.js';
import type { TeamId } from './ids.js';
import type { HeldEffectView, MacoDeckView, MacoDrawView } from './maco-mail.js';
import type {
  ChallengeAdvantageUsage,
  HeldAdvantageView,
  MarketPurchaseView,
  MarketView,
  TeamMarketView,
} from './market.js';

/**
 * Phase 6 shared systems — intents, events and the snapshot views.
 *
 * ================== THE HIDDEN-INFORMATION BOUNDARY ==================
 * Phase 6 spec §42 is the hardest requirement in this phase, and the one a
 * refactor is most likely to break quietly. The protection here is structural:
 *
 *   A PLAYER'S VIEW HAS NO FIELD THAT COULD CARRY A SECRET.
 *
 * `PlayerSharedSystemsView` carries the player's OWN hand and, for opponents,
 * only `OpponentHandView` — which has a count and no card types. There is no
 * optional `allHands` to forget to strip. A Clash in progress carries who
 * responded, never what with. The Maco Mail deck is exposed as counts, never
 * order — not even to the Host.
 *
 * The same discipline the Phase 5 snapshot split established: separate types,
 * not one shape with fields blanked out, so a new field must be placed
 * deliberately on one side.
 * =====================================================================
 */

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/**
 * Phase 6 client intents.
 *
 * Naming follows the established convention: SCREAMING_SNAKE verbs, `HOST_`
 * where the action is privileged. Note which are NOT Host-prefixed —
 * `PLAY_BACCHANAL_CARD`, `RESPOND_TO_CLASH`, `PURCHASE_MARKET_ITEM`,
 * `RESPOND_TO_HOST_DEAL` and `PROPOSE_WAGER` come from a phone, because a team
 * decides its own card, purchase, deal answer and stake.
 *
 * A player intent still decides NOTHING. It asks; the server validates
 * ownership, legality, timing, affordability and authority, then states what
 * happened. Phase 6 spec §7: "A client hiding/disabling a button is not
 * sufficient. Server must reject illegal attempts."
 */
export const SHARED_INTENTS = {
  // --- Bacchanal cards ----------------------------------------------------
  /** Host deals every team its locked starting hand. GAME_RULES_LOCKED.md §2. */
  HOST_DEAL_BACCHANAL_CARDS: 'HOST_DEAL_BACCHANAL_CARDS',
  /**
   * Host opens the window in which cards may be played into this challenge,
   * declaring which locked-table challenge kind it counts as.
   */
  HOST_OPEN_CARD_WINDOW: 'HOST_OPEN_CARD_WINDOW',
  HOST_CLOSE_CARD_WINDOW: 'HOST_CLOSE_CARD_WINDOW',
  /** A team plays one of its cards. Player intent. */
  PLAY_BACCHANAL_CARD: 'PLAY_BACCHANAL_CARD',
  /** A team secretly counters during the 3-second Clash window. Player intent. */
  RESPOND_TO_CLASH: 'RESPOND_TO_CLASH',

  // --- Market -------------------------------------------------------------
  /** Host opens the Market before Round 2, 3 or 4. GAME_RULES_LOCKED.md §10. */
  HOST_OPEN_MARKET: 'HOST_OPEN_MARKET',
  /** Host closes it; purchases reveal. */
  HOST_CLOSE_MARKET: 'HOST_CLOSE_MARKET',
  /** A team buys one item. Player intent, hidden until close. */
  PURCHASE_MARKET_ITEM: 'PURCHASE_MARKET_ITEM',
  /** Host expires items whose round has ended. §10. */
  HOST_EXPIRE_MARKET_ITEMS: 'HOST_EXPIRE_MARKET_ITEMS',

  // --- Maco Mail ----------------------------------------------------------
  /** Host triggers a draw for a team. */
  HOST_DRAW_MACO_MAIL: 'HOST_DRAW_MACO_MAIL',
  /** Host resolves a targeted draw once a target is chosen. */
  HOST_RESOLVE_MACO_TARGET: 'HOST_RESOLVE_MACO_TARGET',

  // --- Advantages ---------------------------------------------------------
  /** A team uses a held advantage. Routed through the stacking rules. */
  USE_ADVANTAGE: 'USE_ADVANTAGE',

  // --- Host Deals ---------------------------------------------------------
  /** Host offers one of the four templates. Max one per round (D-009). */
  HOST_OFFER_DEAL: 'HOST_OFFER_DEAL',
  /** The team accepts or declines. Player intent. */
  RESPOND_TO_HOST_DEAL: 'RESPOND_TO_HOST_DEAL',

  // --- Wagers -------------------------------------------------------------
  /** A team proposes and locks a wager. Player intent. */
  PROPOSE_WAGER: 'PROPOSE_WAGER',
  /** Host resolves a locked wager as won or lost. */
  HOST_RESOLVE_WAGER: 'HOST_RESOLVE_WAGER',

  /** Read-only. Returns the caller's permitted shared-systems view. */
  REQUEST_SHARED_SNAPSHOT: 'REQUEST_SHARED_SNAPSHOT',
} as const;

export type SharedIntentType = (typeof SHARED_INTENTS)[keyof typeof SHARED_INTENTS];

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Phase 6 server events. Past tense: each states a committed fact.
 *
 * TWO EVENTS EXIST PURELY FOR SECRECY. `CLASH_RESPONSE_RECEIVED` announces THAT
 * a team responded without saying what with, and `MARKET_PURCHASE_RECORDED`
 * likewise. Both are broadcast; the content arrives only in the acting team's
 * own acknowledgement, and in the later reveal event.
 */
export const SHARED_EVENTS = {
  BACCHANAL_CARDS_DEALT: 'BACCHANAL_CARDS_DEALT',
  CARD_WINDOW_OPENED: 'CARD_WINDOW_OPENED',
  CARD_WINDOW_CLOSED: 'CARD_WINDOW_CLOSED',
  BACCHANAL_CARD_PLAYED: 'BACCHANAL_CARD_PLAYED',

  CLASH_OPENED: 'CLASH_OPENED',
  /** A team responded. Carries no card type — §42. */
  CLASH_RESPONSE_RECEIVED: 'CLASH_RESPONSE_RECEIVED',
  /** The window closed and everything is revealed. */
  CLASH_RESOLVED: 'CLASH_RESOLVED',
  /** Surviving categories tied. GAME_RULES_LOCKED.md §5. */
  PART_DAT_FIGHT: 'PART_DAT_FIGHT',
  /** A card effect took hold after surviving the Clash. */
  CARD_EFFECT_APPLIED: 'CARD_EFFECT_APPLIED',
  /** Bacchanal Immunity cancelled an attacking card. */
  BACCHANAL_IMMUNITY_TRIGGERED: 'BACCHANAL_IMMUNITY_TRIGGERED',

  MARKET_OPENED: 'MARKET_OPENED',
  /** A team bought something. Carries no item while hidden — §42. */
  MARKET_PURCHASE_RECORDED: 'MARKET_PURCHASE_RECORDED',
  MARKET_CLOSED: 'MARKET_CLOSED',
  MARKET_ITEMS_EXPIRED: 'MARKET_ITEMS_EXPIRED',

  MACO_MAIL_DRAWN: 'MACO_MAIL_DRAWN',
  MACO_MAIL_RESOLVED: 'MACO_MAIL_RESOLVED',

  ADVANTAGE_GRANTED: 'ADVANTAGE_GRANTED',
  ADVANTAGE_USED: 'ADVANTAGE_USED',
  ADVANTAGE_EXPIRED: 'ADVANTAGE_EXPIRED',
  HELD_EFFECT_PLACED: 'HELD_EFFECT_PLACED',
  HELD_EFFECT_CONSUMED: 'HELD_EFFECT_CONSUMED',

  HOST_DEAL_OFFERED: 'HOST_DEAL_OFFERED',
  HOST_DEAL_RESOLVED: 'HOST_DEAL_RESOLVED',

  WAGER_LOCKED: 'WAGER_LOCKED',
  WAGER_RESOLVED: 'WAGER_RESOLVED',
} as const;

export type SharedEventType = (typeof SHARED_EVENTS)[keyof typeof SHARED_EVENTS];

// ---------------------------------------------------------------------------
// The card-play window
// ---------------------------------------------------------------------------

/**
 * The window during which cards may be played into the current challenge.
 *
 * WHY A WINDOW AT ALL: several locked effects have timing requirements —
 * "activate before result" (Double It), "before that team answers" (Gimme Dat),
 * "target is chosen before reveal" (Gimme Dat), "after an incorrect answer"
 * (Forgive Meh). A round decides when to open and close it; the shared system
 * only enforces that a play arrives while it is open.
 *
 * `challengeKind` is what makes eligibility checkable: it maps this challenge
 * onto a row of the locked compatibility table without the engine deciding what
 * the round contains.
 */
export interface CardWindowView {
  readonly open: boolean;
  /** Which row of the locked eligibility table applies. */
  readonly challengeKind: CardChallengeKind | null;
  /** Teams that have already played a card here. GAME_RULES_LOCKED.md §2. */
  readonly teamsWhoPlayed: readonly TeamId[];
  /**
   * Card instances barred from this challenge after losing a Clash. §5 —
   * "Losing card returns but cannot be played again in that challenge."
   *
   * Tracked separately from the team-level bar because a Part Dat Fight returns
   * cards to teams that ALSO cannot play again; the two facts have different
   * lifetimes and Phase 6 spec §8 requires them represented explicitly.
   */
  readonly barredCardInstanceIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Snapshot views
// ---------------------------------------------------------------------------

/**
 * What the HOST sees of the shared systems.
 *
 * The Host runs the show and must be able to explain any state to the room, so
 * this is broad — every team's hand, every purchase, every advantage.
 *
 * TWO THINGS THE HOST STILL DOES NOT GET:
 *   - the Maco Mail deck ORDER (`MacoDeckView` is counts only). A Host display
 *     is usually pointed at a TV the players can see, and the next card is the
 *     most valuable secret in the game.
 *   - Clash responses while the window is open. The reveal is the theatre; a
 *     Host who could see early would have to act unaware.
 */
export interface HostSharedSystemsView {
  /** Every team's hand. The Host may need to adjudicate a card dispute. */
  readonly hands: Readonly<Record<string, readonly BacchanalCardInstance[]>>;
  readonly cardWindow: CardWindowView;
  /** The Clash in progress, if any. Responses stay hidden until resolved. */
  readonly clash: ClashView | null;
  readonly activeEffects: readonly ActiveCardEffectView[];
  readonly market: MarketView | null;
  /** Every purchase. Hidden ones are present — the Host needs to close cleanly. */
  readonly purchases: readonly MarketPurchaseView[];
  readonly advantages: readonly HeldAdvantageView[];
  readonly heldEffects: readonly HeldEffectView[];
  /** Counts only. Never the order. */
  readonly macoDeck: MacoDeckView;
  /** Draws so far, newest last. */
  readonly macoDraws: readonly MacoDrawView[];
  /** Deals offered this game. D-009 allows one per round. */
  readonly deals: readonly HostDealView[];
  readonly wagers: readonly WagerView[];
  /** Per-team advantage spending in the current challenge. */
  readonly usage: Readonly<Record<string, ChallengeAdvantageUsage>>;
}

/**
 * What a PLAYER sees of the shared systems.
 *
 * THE SECRECY-CRITICAL TYPE. Every field is either the player's own team's, or
 * deliberately summarised. Read the field list as a list of what a player is
 * entitled to know — anything absent is absent on purpose.
 */
export interface PlayerSharedSystemsView {
  /**
   * The player's own team's hand, with server-computed playability.
   *
   * `playable` and `unplayableReason` are decided by the server so a phone
   * never evaluates eligibility. Phase 6 spec §5 — "illegal cards should not be
   * selectable" — is satisfied by the UI, but enforced by the server.
   */
  readonly yourHand: readonly OwnCardView[];
  /** Opponents: counts only. No card types. Phase 6 spec §42. */
  readonly opponentHands: readonly OpponentHandView[];
  readonly cardWindow: CardWindowView;
  /**
   * The Clash in progress.
   *
   * While open this shows who has responded, never with what. `yourResponse`
   * below is the one exception: a team may see its own locked choice.
   */
  readonly clash: ClashView | null;
  /** This team's own locked Clash response, if it made one. */
  readonly yourClashResponse: string | null;
  /** Effects currently in force that this team may know about. */
  readonly activeEffects: readonly ActiveCardEffectView[];
  /** Market state, own purchases, and others' only after the reveal. */
  readonly market: TeamMarketView;
  /** This team's held advantages. Never another team's. */
  readonly yourAdvantages: readonly HeldAdvantageView[];
  /** Effects placed ON this team, and effects this team placed on others. */
  readonly heldEffects: readonly HeldEffectView[];
  /** Counts only. A player learns no more about the deck than the Host. */
  readonly macoDeck: MacoDeckView;
  /** This team's own draws. Another team's draw is revealed by its own event. */
  readonly yourMacoDraws: readonly MacoDrawView[];
  /** A deal offered to this team and awaiting its answer. */
  readonly yourDeal: HostDealView | null;
  /** This team's wagers. */
  readonly yourWagers: readonly WagerView[];
  /** This team's advantage spending in the current challenge. */
  readonly yourUsage: ChallengeAdvantageUsage;
}
