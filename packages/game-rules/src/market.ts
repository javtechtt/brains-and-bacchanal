import {
  asServerTimestamp,
  err,
  listedPrice,
  MARKET_ITEMS,
  MARKET_PRICES,
  ok,
  PRICE_GONE_UP_SURCHARGE,
  rejection,
  type MarketItem,
  type MarketPurchaseView,
  type MarketRound,
  type MarketView,
  type Result,
  type TeamId,
  type TeamMarketView,
} from '@bb/protocol';
import type { BbLedger } from './bb-ledger.js';
import type { Clock } from './clock.js';

/**
 * The Market.
 *
 * GAME_RULES_LOCKED.md §10. Opens before Rounds 2, 3 and 4 — never Round 1.
 * Multiple different items per visit, one copy of each. Shopping is hidden;
 * purchases reveal when the Market closes. Items expire after the round that
 * follows the purchase.
 *
 * ================== TWO RULES THAT INTERACT BADLY IF SLOPPY ==================
 * 1. BB floors at 0 (§1), and the ledger enforces that centrally.
 * 2. A team must not be able to buy what it cannot afford.
 *
 * Those are not the same rule, and relying on the first to deliver the second
 * would be a real bug: deducting 500 from a team holding 300 would leave them at
 * 0 and hand them the item for 300. Phase 6 spec §20 calls this out explicitly —
 * "Purchase affordability must be checked before deduction." So affordability is
 * checked here, BEFORE the ledger is touched.
 * =============================================================================
 */

interface MarketActivation {
  readonly marketId: string;
  readonly round: MarketRound;
  open: boolean;
  readonly openedAt: ReturnType<typeof asServerTimestamp>;
  closedAt: ReturnType<typeof asServerTimestamp> | null;
  revealed: boolean;
}

interface PurchaseRecord extends MarketPurchaseView {
  used: boolean;
  cancelled: boolean;
  expired: boolean;
}

export interface MarketOptions {
  readonly clock: Clock;
  readonly ledger: BbLedger;
  readonly mintId: () => string;
}

export class Market {
  readonly #clock: Clock;
  readonly #ledger: BbLedger;
  readonly #mintId: () => string;

  #activation: MarketActivation | null = null;
  readonly #purchases: PurchaseRecord[] = [];
  /** teamId -> pending surcharge from Price Gone Up!. */
  readonly #surcharges = new Map<string, number>();

  constructor(options: MarketOptions) {
    this.#clock = options.clock;
    this.#ledger = options.ledger;
    this.#mintId = options.mintId;
  }

  get open(): boolean {
    return this.#activation?.open ?? false;
  }

  get round(): MarketRound | null {
    return this.#activation?.round ?? null;
  }

  // -------------------------------------------------------------------------
  // Opening and closing
  // -------------------------------------------------------------------------

  /**
   * Open the Market before a round.
   *
   * `round` is typed `MarketRound` (2 | 3 | 4), so "Market before Round 1" is
   * not expressible — GAME_RULES_LOCKED.md §10 opens it before Rounds 2, 3 and
   * 4 only. The runtime check below catches a value that arrived off the wire
   * and bypassed the type.
   */
  open_(round: number): Result<MarketView> {
    if (this.#activation?.open === true) {
      return err(rejection('WRONG_STATE', 'The Market is already open.'));
    }
    if (round !== 2 && round !== 3 && round !== 4) {
      return err(
        rejection('ILLEGAL_ACTION', 'The Market opens before Rounds 2, 3 and 4 only.', { round }),
      );
    }

    this.#activation = {
      marketId: this.#mintId(),
      round,
      open: true,
      openedAt: asServerTimestamp(this.#clock.now()),
      closedAt: null,
      revealed: false,
    };

    return ok(this.view() as MarketView);
  }

  /**
   * Close the Market and reveal every purchase.
   *
   * §10 — "purchases reveal when Market closes". The reveal is recorded as an
   * explicit flag rather than inferred from `open === false`, so a client cannot
   * get the timing wrong and show purchases a moment early.
   */
  close(): Result<{ readonly market: MarketView; readonly purchases: readonly MarketPurchaseView[] }> {
    const activation = this.#activation;
    if (activation === null || !activation.open) {
      return err(rejection('WRONG_STATE', 'The Market is not open.'));
    }

    activation.open = false;
    activation.closedAt = asServerTimestamp(this.#clock.now());
    activation.revealed = true;

    return ok({
      market: this.view() as MarketView,
      purchases: this.purchasesForRound(activation.round),
    });
  }

  // -------------------------------------------------------------------------
  // Purchasing
  // -------------------------------------------------------------------------

  /**
   * The price a specific team would actually pay, surcharge included.
   *
   * GAME_RULES_LOCKED.md §10 for the listed price; Price Gone Up! (§8) adds 500
   * to the target team's NEXT purchase. The surcharge applies to ONE purchase,
   * so it is consumed by the first buy rather than charged on every item.
   */
  priceFor(teamId: TeamId, item: MarketItem): { listed: number; surcharge: number; total: number } {
    const round = this.#activation?.round;
    const listed = round === undefined ? 0 : listedPrice(item, round);
    const surcharge = this.#surcharges.get(teamId) ?? 0;
    return { listed, surcharge, total: listed + surcharge };
  }

  /**
   * Buy one item.
   *
   * Phase 6 spec §20 lists what the server validates, and each is here in order:
   * Market open, correct round (implied by the activation), item exists, not
   * already bought this activation, team can afford the ACTUAL price including
   * surcharge. Duplicate network retries are caught by the room's idempotency
   * registry before this is reached — the same mechanism every other intent
   * uses.
   *
   * SPENDING GOES THROUGH THE LEDGER (Phase 5). Nothing here assigns a balance.
   */
  purchase(input: {
    readonly teamId: TeamId;
    readonly item: MarketItem;
  }): Result<MarketPurchaseView> {
    const activation = this.#activation;
    if (activation === null || !activation.open) {
      return err(rejection('WRONG_STATE', 'The Market is not open.'));
    }

    if (!MARKET_ITEMS.includes(input.item)) {
      return err(rejection('NOT_FOUND', 'No such Market item.', { item: input.item }));
    }

    // §10 — "max one copy of each item per Market visit". Scoped to this
    // activation, so the same item may be bought again before the next round.
    const alreadyBought = this.#purchases.some(
      (purchase) =>
        purchase.teamId === input.teamId &&
        purchase.item === input.item &&
        purchase.round === activation.round &&
        !purchase.cancelled,
    );
    if (alreadyBought) {
      return err(
        rejection('ILLEGAL_ACTION', 'Your team already bought that item this Market.', {
          item: input.item,
        }),
      );
    }

    const { listed, surcharge, total } = this.priceFor(input.teamId, input.item);
    const balance = this.#ledger.balanceOf(input.teamId);

    // AFFORDABILITY BEFORE DEDUCTION. See the header comment: the ledger's floor
    // would otherwise sell a 500 BB item to a team holding 300.
    if (balance < total) {
      return err(
        rejection('ILLEGAL_ACTION', 'Your team cannot afford that.', {
          item: input.item,
          price: total,
          balance,
        }),
      );
    }

    this.#ledger.apply({
      teamId: input.teamId,
      delta: -total,
      reason: 'market_purchase',
      note: `${input.item}${surcharge > 0 ? ' (surcharge)' : ''}`,
    });

    // The surcharge is spent on this one purchase. §8 — "affects one purchase
    // only".
    if (surcharge > 0) this.#surcharges.delete(input.teamId);

    const purchase: PurchaseRecord = {
      purchaseId: this.#mintId(),
      teamId: input.teamId,
      item: input.item,
      round: activation.round,
      listedPrice: listed,
      surcharge,
      // WHAT ACTUALLY LEFT THE LEDGER. Phase 6 spec §31 refunds this exact
      // number, never a recomputed listed price.
      pricePaid: total,
      purchasedAt: asServerTimestamp(this.#clock.now()),
      used: false,
      cancelled: false,
      // §10 — "items expire after the immediately following round". Bought
      // before Round N, usable during Round N, gone after it.
      expiresAfterRound: activation.round,
      expired: false,
    };
    this.#purchases.push(purchase);

    return ok({ ...purchase });
  }

  // -------------------------------------------------------------------------
  // Cancellation and refunds
  // -------------------------------------------------------------------------

  /**
   * Destroy an unused purchase and refund what was actually paid.
   *
   * Maco Mail's Cancel Market Purchase. GAME_RULES_LOCKED.md §8 / Phase 6 spec
   * §31 — "destroy one UNUSED opponent Market item, refund the actual amount
   * paid, refund includes any surcharge paid."
   *
   * The refund reads `pricePaid`, which was stored at purchase time. Deriving it
   * from the current listed price would short-change any team that was
   * surcharged, and would break entirely across a round boundary where prices
   * change.
   */
  cancelPurchase(purchaseId: string): Result<{ readonly purchase: MarketPurchaseView; readonly refunded: number }> {
    const purchase = this.#purchases.find((p) => p.purchaseId === purchaseId);
    if (purchase === undefined) {
      return err(rejection('NOT_FOUND', 'No such purchase.', { purchaseId }));
    }
    if (purchase.cancelled) {
      return err(rejection('ILLEGAL_ACTION', 'That purchase was already cancelled.'));
    }
    if (purchase.used) {
      return err(rejection('ILLEGAL_ACTION', 'That item has already been used.'));
    }

    purchase.cancelled = true;

    const outcome = this.#ledger.apply({
      teamId: purchase.teamId,
      delta: purchase.pricePaid,
      reason: 'market_refund',
      note: `Cancelled ${purchase.item}`,
    });

    return ok({ purchase: { ...purchase }, refunded: outcome.entry.applied });
  }

  /** Mark a purchase used, so it can no longer be cancelled. */
  markUsed(purchaseId: string): void {
    const purchase = this.#purchases.find((p) => p.purchaseId === purchaseId);
    if (purchase !== undefined) purchase.used = true;
  }

  /** Purchases a team holds that an opponent could legally cancel. */
  cancellablePurchases(teamId: TeamId): readonly MarketPurchaseView[] {
    return this.#purchases
      .filter((p) => p.teamId === teamId && !p.used && !p.cancelled && !p.expired)
      .map((p) => ({ ...p }));
  }

  // -------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------

  /**
   * Expire items whose round has ended.
   *
   * GAME_RULES_LOCKED.md §10 — "items expire after the immediately following
   * round". An item bought before Round 2 is usable during Round 2 and expires
   * once Round 2 is over, so it expires when the completed round index is at
   * least its `expiresAfterRound`.
   *
   * Phase 6 spec §21 — "Do not allow items to persist indefinitely."
   */
  expireAfterRound(completedRoundIndex: number): readonly MarketPurchaseView[] {
    const expired: MarketPurchaseView[] = [];
    for (const purchase of this.#purchases) {
      if (purchase.expired || purchase.cancelled || purchase.used) continue;
      if (purchase.expiresAfterRound > completedRoundIndex) continue;
      purchase.expired = true;
      expired.push({ ...purchase });
    }
    return expired;
  }

  // -------------------------------------------------------------------------
  // Surcharges
  // -------------------------------------------------------------------------

  /**
   * Place a Price Gone Up! surcharge on a team.
   *
   * §8 — the target's NEXT Market purchase costs +500, one purchase only.
   * Stacking two surcharges is refused: the locked rule says "+500", and adding
   * them would invent "+1,000".
   */
  addSurcharge(teamId: TeamId): Result<number> {
    if ((this.#surcharges.get(teamId) ?? 0) > 0) {
      return err(rejection('ILLEGAL_ACTION', 'That team already has a pending surcharge.'));
    }
    this.#surcharges.set(teamId, PRICE_GONE_UP_SURCHARGE);
    return ok(PRICE_GONE_UP_SURCHARGE);
  }

  surchargeFor(teamId: TeamId): number {
    return this.#surcharges.get(teamId) ?? 0;
  }

  /**
   * Drop unused surcharges once the last Market has passed.
   *
   * Phase 6 spec §33 — "removed after final Market if unused". Round 4 is the
   * last Market, so a surcharge that survives it can never be charged.
   */
  clearSurchargesAfterFinalMarket(): void {
    this.#surcharges.clear();
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  view(): MarketView | null {
    const activation = this.#activation;
    if (activation === null) return null;

    const prices = {} as Record<MarketItem, number>;
    for (const item of MARKET_ITEMS) {
      prices[item] = MARKET_PRICES[item][activation.round];
    }

    return {
      marketId: activation.marketId,
      round: activation.round,
      open: activation.open,
      openedAt: activation.openedAt,
      closedAt: activation.closedAt,
      revealed: activation.revealed,
      prices,
    };
  }

  /** Every purchase, for the Host view and for expiry. */
  allPurchases(): readonly MarketPurchaseView[] {
    return this.#purchases.map((p) => ({ ...p }));
  }

  purchasesForRound(round: MarketRound): readonly MarketPurchaseView[] {
    return this.#purchases.filter((p) => p.round === round).map((p) => ({ ...p }));
  }

  purchasesFor(teamId: TeamId): readonly MarketPurchaseView[] {
    return this.#purchases.filter((p) => p.teamId === teamId).map((p) => ({ ...p }));
  }

  /**
   * One team's view of the Market.
   *
   * THE SECRECY RULE IS ENFORCED HERE. §10 — "shopping is hidden", "purchases
   * reveal when Market closes". While the Market is open, `otherTeamPurchases`
   * is empty — not filtered down to counts, empty. A count would itself reveal
   * how much an opponent has committed, which is information the hidden-shopping
   * rule exists to protect.
   */
  teamView(teamId: TeamId): TeamMarketView {
    const activation = this.#activation;
    const revealed = activation?.revealed ?? false;

    const yourPurchases = this.#purchases
      .filter((p) => p.teamId === teamId && (activation === null || p.round === activation.round))
      .map((p) => ({ ...p }));

    const otherTeamPurchases = revealed
      ? this.#purchases
          .filter((p) => p.teamId !== teamId && p.round === activation?.round)
          .map((p) => ({ ...p }))
      : [];

    const bought = new Set(yourPurchases.filter((p) => !p.cancelled).map((p) => p.item));
    const availableItems =
      activation?.open === true ? MARKET_ITEMS.filter((item) => !bought.has(item)) : [];

    return {
      market: this.view(),
      yourPurchases,
      otherTeamPurchases,
      pendingSurcharge: this.surchargeFor(teamId),
      availableItems,
    };
  }
}
