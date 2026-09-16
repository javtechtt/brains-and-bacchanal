import {
  asServerTimestamp,
  categoryOf,
  err,
  ok,
  rejection,
  SHARED_EVENTS,
  type ActiveCardEffectView,
  type BacchanalCardType,
  type CardChallengeKind,
  type ChallengeId,
  type ClashResult,
  type HostSharedSystemsView,
  type MarketItem,
  type PlayerSharedSystemsView,
  type Result,
  type TeamId,
} from '@bb/protocol';
import { advantageForMarketItem, Advantages } from './advantages.js';
import { BacchanalCards } from './bacchanal-cards.js';
import type { BbLedger } from './bb-ledger.js';
import { ClashEngine } from './clash.js';
import type { Clock } from './clock.js';
import { Deals } from './deals.js';
import { MacoMail, type MacoContext } from './maco-mail.js';
import { Market } from './market.js';
import type { Rng } from './rng.js';

/**
 * The Phase 6 shared systems, coordinated.
 *
 * Owns the seven subsystems and the interactions BETWEEN them, which is where
 * the locked rules actually bind:
 *
 *   - a played card opens a Clash, and the Clash decides whether its effect
 *     applies (GAME_RULES_LOCKED.md §5),
 *   - Bacchanal Immunity cancels an attacking card before it resolves (§8),
 *   - a Market purchase becomes a held advantage, sharing one stacking budget
 *     with Bacchanal cards (§4, §10),
 *   - a Maco Mail draw may confiscate a card, cancel a purchase, or surcharge a
 *     future one (§8).
 *
 * It also builds the two secrecy-aware views. Phase 6 spec §42 — "Build explicit
 * safe views rather than serializing full server state blindly." That is exactly
 * what `hostView` and `playerView` are, and no other route to a client exists.
 *
 * NO ROUND LIVES HERE EITHER. No reward amount, no question, no board. A round
 * supplies the base BB and asks what multiplier applies; this answers.
 */

export interface SharedSystemsOptions {
  readonly clock: Clock;
  readonly rng: Rng;
  readonly mintId: () => string;
  readonly ledger: BbLedger;
}

/** An effect that survived its Clash and is in force for the challenge. */
interface EffectRecord extends ActiveCardEffectView {
  active: boolean;
}

export class SharedSystems {
  readonly cards: BacchanalCards;
  readonly clash: ClashEngine;
  readonly market: Market;
  readonly advantages: Advantages;
  readonly macoMail: MacoMail;
  readonly deals: Deals;

  readonly #clock: Clock;
  readonly #mintId: () => string;
  readonly #effects: EffectRecord[] = [];

  constructor(options: SharedSystemsOptions) {
    this.#clock = options.clock;
    this.#mintId = options.mintId;

    this.cards = new BacchanalCards({
      clock: options.clock,
      rng: options.rng,
      mintId: options.mintId,
    });
    this.clash = new ClashEngine({ clock: options.clock, mintId: options.mintId });
    this.market = new Market({
      clock: options.clock,
      ledger: options.ledger,
      mintId: options.mintId,
    });
    this.advantages = new Advantages({ clock: options.clock, mintId: options.mintId });
    this.macoMail = new MacoMail({
      clock: options.clock,
      rng: options.rng,
      mintId: options.mintId,
      ledger: options.ledger,
      advantages: this.advantages,
      market: this.market,
      cards: this.cards,
    });
    this.deals = new Deals({
      clock: options.clock,
      ledger: options.ledger,
      mintId: options.mintId,
    });
  }

  // -------------------------------------------------------------------------
  // Card play → Clash
  // -------------------------------------------------------------------------

  /**
   * Play a card and open a Clash around it.
   *
   * GAME_RULES_LOCKED.md §5 — "When a Bacchanal Card is played: opponents get a
   * 3-second hidden response window." Every play opens one; a Clash with no
   * responses resolves as `uncontested` and the card simply works, which is the
   * same rule with an empty response set rather than a separate path.
   */
  playCard(input: {
    readonly teamId: TeamId;
    readonly cardInstanceId: string;
    readonly targetTeamId?: TeamId | null;
    readonly challengeId: ChallengeId;
    readonly paused: boolean;
    readonly allTeamIds: readonly TeamId[];
  }): Result<{ readonly cardType: BacchanalCardType; readonly clashOpened: boolean }> {
    const played = this.cards.play({
      teamId: input.teamId,
      cardInstanceId: input.cardInstanceId,
      targetTeamId: input.targetTeamId ?? null,
      paused: input.paused,
    });
    if (!played.ok) return err(played.error);

    // The one-card-per-challenge fact is recorded in BOTH places on purpose:
    // the card system enforces it for card plays, and the advantage usage record
    // is what a round queries when deciding what a team may still do.
    this.advantages.recordBacchanalCardPlayed(input.teamId);

    // Only teams with a legal counter may respond. §5 — "responding teams
    // secretly choose one eligible card" — and Phase 6 spec §9, "illegal counter
    // must not be selectable".
    const eligible = input.allTeamIds.filter(
      (teamId) =>
        teamId !== input.teamId && this.cards.eligibleCardsFor(teamId, input.paused).length > 0,
    );

    const opened = this.clash.open({
      challengeId: input.challengeId,
      initiatingTeamId: input.teamId,
      cardInstanceId: input.cardInstanceId,
      cardType: played.value.cardType,
      targetTeamId: input.targetTeamId ?? null,
      eligibleTeamIds: eligible,
    });
    if (!opened.ok) return err(opened.error);

    return ok({ cardType: played.value.cardType, clashOpened: true });
  }

  /**
   * Record a secret counter in the open Clash.
   *
   * Validates the card through the CARD system first — ownership, held status,
   * eligibility for this challenge — then through the CLASH system for the
   * window, eligibility to respond and one-response-per-team.
   */
  respondToClash(input: {
    readonly teamId: TeamId;
    readonly cardInstanceId: string;
    readonly targetTeamId?: TeamId | null;
    readonly paused: boolean;
  }): Result<{ readonly respondedTeamIds: readonly TeamId[] }> {
    const card = this.cards.card(input.cardInstanceId);
    if (card === undefined) {
      return err(rejection('NOT_FOUND', 'No such card.'));
    }
    if (card.owningTeamId !== input.teamId) {
      return err(rejection('UNAUTHORIZED_ACTOR', 'That card belongs to another team.'));
    }

    // The counter must itself be a legal play — same rules, same code.
    const played = this.cards.play({
      teamId: input.teamId,
      cardInstanceId: input.cardInstanceId,
      targetTeamId: input.targetTeamId ?? null,
      paused: input.paused,
    });
    if (!played.ok) return err(played.error);

    const responded = this.clash.respond({
      teamId: input.teamId,
      cardInstanceId: input.cardInstanceId,
      cardType: played.value.cardType,
      targetTeamId: input.targetTeamId ?? null,
    });
    if (!responded.ok) {
      // The Clash refused, so un-commit the card: it must go back to the hand,
      // or a rejected response would silently spend it. The team-level bar is
      // NOT lifted — the team did attempt a play.
      this.cards.returnToHand(input.cardInstanceId);
      return err(responded.error);
    }

    this.advantages.recordBacchanalCardPlayed(input.teamId);

    return ok({ respondedTeamIds: responded.value.respondedTeamIds });
  }

  /**
   * Close the Clash window, reveal, and apply the outcome.
   *
   * GAME_RULES_LOCKED.md §5:
   *   winning card  → resolves and is CONSUMED
   *   losing card   → RETURNS to its owner, barred for this challenge
   *   Part Dat Fight → no effect, every card returns, teams still barred
   *
   * Bacchanal Immunity is checked here (§8): if the surviving card targets a
   * protected team, the immunity is consumed, the attacking card has NO effect,
   * and — per Phase 6 spec §29 — "attacking team keeps its Bacchanal card".
   */
  resolveClash(): Result<{
    readonly result: ClashResult;
    readonly effect: ActiveCardEffectView | null;
    readonly immunityTriggered: boolean;
    readonly immunityTeamId: TeamId | null;
  }> {
    const resolved = this.clash.resolve();
    if (!resolved.ok) return err(resolved.error);

    const result = resolved.value;
    const entries = this.clash.entries();

    // Losing and tied cards return to hand, barred for this challenge. §5.
    for (const entry of entries) {
      const survived = result.entries.find(
        (view) => view.cardInstanceId === entry.cardInstanceId,
      )?.survived;
      if (survived !== true) {
        this.cards.returnToHand(entry.cardInstanceId);
      }
    }

    // Part Dat Fight, or nothing played: no effect resolves at all.
    if (result.outcome === 'part_dat_fight' || result.winningTeamId === null) {
      this.clash.clear();
      return ok({ result, effect: null, immunityTriggered: false, immunityTeamId: null });
    }

    const winner = entries.find((entry) => entry.teamId === result.winningTeamId);
    if (winner === undefined) {
      this.clash.clear();
      return ok({ result, effect: null, immunityTriggered: false, immunityTeamId: null });
    }

    // Bacchanal Immunity. §8 / Phase 6 spec §29 — it cancels a Bacchanal card
    // used AGAINST the protected team, and only a Bacchanal card: it does not
    // protect against the Market, Maco Mail, a Host Deal or a wager, and none of
    // those call this.
    if (winner.targetTeamId !== null) {
      const immunity = this.advantages.consumeImmunity(winner.targetTeamId);
      if (immunity !== null) {
        // The attacking team KEEPS its card — it returns to hand rather than
        // being consumed. It is still barred for this challenge, because the
        // team did play it.
        this.cards.returnToHand(winner.cardInstanceId);
        this.clash.clear();
        return ok({
          result,
          effect: null,
          immunityTriggered: true,
          immunityTeamId: winner.targetTeamId,
        });
      }
    }

    // The card resolves and is consumed. §5.
    this.cards.markResolving(winner.cardInstanceId);
    const effect = this.#applyEffect({
      cardType: winner.cardType,
      owningTeamId: winner.teamId,
      challengeId: this.clash.challengeId,
      targetTeamId: winner.targetTeamId,
    });
    this.cards.consume(winner.cardInstanceId);

    this.clash.clear();
    return ok({ result, effect, immunityTriggered: false, immunityTeamId: null });
  }

  /**
   * Record that a card's effect is now in force.
   *
   * WHAT THE EFFECT DOES IS NOT DECIDED HERE — that is the whole design. A round
   * asks "is Team A's reward doubled?" and gets an answer; what Team A's reward
   * IS remains the round's, and for several challenges is still open.
   *
   * The one effect with an immediate shared consequence is DOUBLE_IT, which
   * spends the shared multiplier budget so nothing else can double the same
   * reward (§3, §10 — multipliers never stack).
   */
  #applyEffect(input: {
    readonly cardType: BacchanalCardType;
    readonly owningTeamId: TeamId;
    readonly challengeId: ChallengeId | null;
    readonly targetTeamId: TeamId | null;
  }): ActiveCardEffectView | null {
    if (input.challengeId === null) return null;

    const detail: Record<string, string | number | boolean | null> = {};

    if (input.cardType === 'DOUBLE_IT') {
      // Spend the shared multiplier budget. If a Market Double or Maco Double
      // Points already applied, this refuses — and the card is still consumed,
      // because it was legally played and won its Clash. §3: "already doubled
      // challenges cannot be doubled again."
      const allowed = this.advantages.canUse(input.owningTeamId, 'DOUBLE');
      detail['multiplierApplied'] = allowed;
      if (allowed) {
        this.advantages.grant({
          teamId: input.owningTeamId,
          type: 'DOUBLE',
          source: 'maco_mail',
        });
        const granted = this.advantages
          .usableFor(input.owningTeamId)
          .find((a) => a.type === 'DOUBLE');
        if (granted !== undefined) {
          this.advantages.use({ teamId: input.owningTeamId, advantageId: granted.advantageId });
        }
      }
    }

    if (input.cardType === 'FORGIVE_MEH') {
      // §4 — spends the SHARED retry budget, so a team cannot chain this with a
      // Market Second Chance.
      const retry = this.advantages.useForgiveMehRetry(input.owningTeamId);
      detail['retryGranted'] = retry.ok;
    }

    const record: EffectRecord = {
      effectId: this.#mintId(),
      cardType: input.cardType,
      owningTeamId: input.owningTeamId,
      challengeId: input.challengeId,
      targetTeamId: input.targetTeamId,
      appliedAt: this.#now(),
      active: true,
      detail,
    };
    this.#effects.push(record);
    return { ...record, detail: { ...detail } };
  }

  #now() {
    return asServerTimestamp(this.#clock.now());
  }

  /** Effects currently in force. */
  activeEffects(): readonly ActiveCardEffectView[] {
    return this.#effects.filter((e) => e.active).map((e) => ({ ...e, detail: { ...e.detail } }));
  }

  /** Whether a team's reward for the current challenge is doubled. */
  isDoubledFor(teamId: TeamId): boolean {
    return this.advantages.usageFor(teamId).doubleUsed;
  }

  /**
   * Apply the allowed multiplier to a base reward.
   *
   * THE ROUND SUPPLIES THE BASE. Phase 6 spec §13 — "Do not hardcode round
   * reward amounts. The eventual round provides a base reward. The shared system
   * applies the allowed multiplier."
   *
   * Multipliers never stack (§3), so this is ×2 or ×1 and never more, whatever
   * combination of Double It!, Market Double and Double Points a team has.
   */
  applyMultiplier(teamId: TeamId, baseReward: number): number {
    return this.isDoubledFor(teamId) ? baseReward * 2 : baseReward;
  }

  // -------------------------------------------------------------------------
  // Challenge lifecycle
  // -------------------------------------------------------------------------

  /** Open the card window for a challenge. */
  openCardWindow(challengeId: ChallengeId, kind: CardChallengeKind): Result<true> {
    const opened = this.cards.openWindow(challengeId, kind);
    if (!opened.ok) return err(opened.error);
    return ok(true);
  }

  /**
   * End a challenge: clear per-challenge state.
   *
   * The per-challenge budgets reset (§4, §10 are per-question rules) and the
   * card window closes. Hands, advantages, Market purchases and held effects all
   * survive — they are game-long resources.
   */
  endChallenge(): void {
    this.cards.endChallenge();
    this.advantages.endChallenge();
    this.clash.clear();
    for (const effect of this.#effects) effect.active = false;
  }

  /**
   * End a round: expire what the locked rules expire.
   *
   * §10 — Market items expire after the immediately following round. Maco Mail
   * held advantages do NOT (§7), and `Advantages.expireAfterRound` skips them.
   */
  endRound(completedRoundIndex: number): {
    readonly purchases: readonly { purchaseId: string }[];
    readonly advantages: readonly { advantageId: string }[];
  } {
    const purchases = this.market.expireAfterRound(completedRoundIndex);
    const advantages = this.advantages.expireAfterRound(completedRoundIndex);
    return { purchases, advantages };
  }

  // -------------------------------------------------------------------------
  // Market
  // -------------------------------------------------------------------------

  /**
   * Buy an item, and grant the advantage it carries.
   *
   * A Market purchase and the advantage it grants are one action from a team's
   * point of view but two records, because Cancel Market Purchase destroys the
   * PURCHASE and refunds its price — so the purchase must be addressable
   * separately from the advantage.
   *
   * MACO_MAIL grants no advantage: §10 — "purchased Maco Mail opens after
   * reveal", so the draw happens when the Market closes.
   */
  purchase(input: {
    readonly teamId: TeamId;
    readonly item: MarketItem;
  }): Result<{ readonly purchaseId: string; readonly pricePaid: number }> {
    const bought = this.market.purchase(input);
    if (!bought.ok) return err(bought.error);

    const advantageType = advantageForMarketItem(input.item);
    if (advantageType !== null) {
      this.advantages.grant({
        teamId: input.teamId,
        type: advantageType,
        source: 'market',
        purchaseId: bought.value.purchaseId,
        // §10 — usable during the round that follows, then gone.
        expiresAfterRound: bought.value.expiresAfterRound,
      });
    }

    return ok({ purchaseId: bought.value.purchaseId, pricePaid: bought.value.pricePaid });
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  /** The Host's view. Broad, but still no deck order and no open Clash responses. */
  hostView(): HostSharedSystemsView {
    return {
      hands: this.cards.allHands(),
      cardWindow: this.cards.windowView(),
      clash: this.clash.view(),
      activeEffects: this.activeEffects(),
      market: this.market.view(),
      purchases: this.market.allPurchases(),
      advantages: this.advantages.all(),
      heldEffects: this.macoMail.heldEffects(),
      macoDeck: this.macoMail.deckView(),
      macoDraws: this.macoMail.draws(),
      deals: this.deals.deals(),
      wagers: this.deals.wagers(),
      usage: this.advantages.allUsage(),
    };
  }

  /**
   * One team's view.
   *
   * THE SECRECY BOUNDARY IN CODE. Every field is either this team's own or a
   * deliberate summary. Phase 6 spec §42 — a player must never receive opponent
   * card hands, hidden Market purchases, unrevealed Maco draws, hidden Clash
   * responses or deck order, and none of those has a route into this object.
   */
  playerView(teamId: TeamId, paused: boolean): PlayerSharedSystemsView {
    return {
      yourHand: this.cards.ownHandView(teamId, paused),
      // Counts only — OpponentHandView has no field for a card type.
      opponentHands: this.cards.opponentHandViews(teamId),
      cardWindow: this.cards.windowView(),
      // Responses stay hidden inside this view until the Clash resolves.
      clash: this.clash.view(),
      // The one exception: a team may see its OWN locked response.
      yourClashResponse: this.clash.responseOf(teamId),
      activeEffects: this.activeEffects(),
      // Other teams' purchases appear only after the Market reveals.
      market: this.market.teamView(teamId),
      yourAdvantages: this.advantages.forTeam(teamId),
      heldEffects: this.macoMail.heldEffectsFor(teamId),
      // Counts only. No player learns the deck order.
      macoDeck: this.macoMail.deckView(),
      yourMacoDraws: this.macoMail.drawsFor(teamId),
      yourDeal: this.deals.pendingDealFor(teamId),
      yourWagers: this.deals.wagersFor(teamId),
      yourUsage: this.advantages.usageFor(teamId),
    };
  }

  /** Build the Maco Mail context from what the caller knows. */
  macoContext(input: {
    readonly teamIds: readonly TeamId[];
    readonly eligibleAnswererChallengeRemains?: boolean;
    readonly futureMarketRemains?: boolean;
  }): MacoContext {
    return {
      teamIds: input.teamIds,
      // Defaults are permissive on purpose: assuming NO future challenge would
      // silently remove Hands Tied from the deck, which is a rule decision
      // (Phase 6 spec §34) that belongs to a round, not to a default.
      eligibleAnswererChallengeRemains: input.eligibleAnswererChallengeRemains ?? true,
      futureMarketRemains: input.futureMarketRemains ?? true,
    };
  }
}

export { SHARED_EVENTS, categoryOf };
