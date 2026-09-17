import {
  asServerTimestamp,
  err,
  MACO_DECK_COMPOSITION,
  MACO_MONEY_DELTAS,
  MACO_RESOLUTION,
  ok,
  PARTNER_I_SORRY_AMOUNT,
  rejection,
  type HeldEffectType,
  type HeldEffectView,
  type MacoDeckView,
  type MacoDrawResult,
  type MacoDrawView,
  type MacoOutcome,
  type Result,
  type TeamId,
} from '@bb/protocol';
import type { Advantages } from './advantages.js';
import type { BbLedger } from './bb-ledger.js';
import type { Clock } from './clock.js';
import type { Market } from './market.js';
import { pickOne, shuffle, type Rng } from './rng.js';
import type { BacchanalCards } from './bacchanal-cards.js';

/**
 * Maco Mail — the deck, the draw and the outcomes.
 *
 * GAME_RULES_LOCKED.md §7 and §8, DECISION_LOG.md D-010.
 *
 * ================== THE DUD DISTINCTION ==================
 * §7 draws a line that is easy to blur and important to keep (Phase 6 spec §35):
 *
 *   STRUCTURALLY IMPOSSIBLE — the effect could never apply again for the rest
 *   of the game. Filtered out BEFORE the draw, so it is never drawn. §7:
 *   "structurally impossible future effects are removed before drawing."
 *
 *   CURRENTLY NO VALID TARGET — the card was a fair candidate and was drawn
 *   honestly; it simply has nothing to hit at this moment. It resolves as a DUD.
 *   §7: "eligible effect with no target = dud / lose-out", and "no
 *   redraw/refund/compensation for dud."
 *
 * The difference is permanence. Cancel Market Purchase with no opponent
 * purchases *right now* is a dud — the situation may change next round. Hands
 * Tied when no eligible challenge remains at all is impossible — it never
 * becomes playable again, so leaving it in the deck would waste draws.
 * =========================================================
 */

/** What the world looks like to a card deciding whether it has a target. */
export interface MacoContext {
  /** Every participating team. */
  readonly teamIds: readonly TeamId[];
  /**
   * Whether any eligible individual-answerer challenge remains this game.
   *
   * SUPPLIED BY THE CALLER, never decided here. Phase 6 spec §34 — "Do not
   * invent which future rounds/challenges count beyond existing challenge
   * metadata. Future round implementation supplies the eligibility." Until a
   * round says otherwise the engine assumes one does, because assuming
   * otherwise would silently remove Hands Tied from the deck.
   */
  readonly eligibleAnswererChallengeRemains: boolean;
  /** Whether any Market activation is still to come. */
  readonly futureMarketRemains: boolean;
}

interface DeckCard {
  readonly cardId: string;
  readonly outcome: MacoOutcome;
}

interface HeldEffectRecord extends HeldEffectView {
  consumed: boolean;
  consumedAt: ReturnType<typeof asServerTimestamp> | null;
}

export interface MacoMailOptions {
  readonly clock: Clock;
  readonly rng: Rng;
  readonly mintId: () => string;
  readonly ledger: BbLedger;
  readonly advantages: Advantages;
  readonly market: Market;
  readonly cards: BacchanalCards;
}

export class MacoMail {
  readonly #clock: Clock;
  readonly #rng: Rng;
  readonly #mintId: () => string;
  readonly #ledger: BbLedger;
  readonly #advantages: Advantages;
  readonly #market: Market;
  readonly #cards: BacchanalCards;

  #drawPile: DeckCard[] = [];
  #discard: DeckCard[] = [];
  #removedImpossible: DeckCard[] = [];
  readonly #draws: MacoDrawView[] = [];
  readonly #heldEffects: HeldEffectRecord[] = [];
  #built = false;

  constructor(options: MacoMailOptions) {
    this.#clock = options.clock;
    this.#rng = options.rng;
    this.#mintId = options.mintId;
    this.#ledger = options.ledger;
    this.#advantages = options.advantages;
    this.#market = options.market;
    this.#cards = options.cards;
  }

  get built(): boolean {
    return this.#built;
  }

  // -------------------------------------------------------------------------
  // Building the deck
  // -------------------------------------------------------------------------

  /**
   * Build and shuffle the 20-card playtest deck.
   *
   * D-010 / GAME_RULES_LOCKED.md §7. The composition comes entirely from
   * `MACO_DECK_COMPOSITION`, so changing the playtest mix is a change to that
   * table and nothing else — Phase 6 spec §23.
   */
  build(): Result<number> {
    if (this.#built) {
      return err(rejection('WRONG_STATE', 'The Maco Mail deck has already been built.'));
    }

    const cards: DeckCard[] = [];
    for (const [outcome, count] of Object.entries(MACO_DECK_COMPOSITION)) {
      for (let i = 0; i < count; i += 1) {
        cards.push({ cardId: this.#mintId(), outcome: outcome as MacoOutcome });
      }
    }

    this.#drawPile = shuffle(this.#rng, cards);
    this.#built = true;
    return ok(this.#drawPile.length);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /**
   * Draw one card for a team and resolve it.
   *
   * WITHOUT REPLACEMENT (§7). The card leaves the draw pile and goes to the
   * discard — or, if it becomes a held advantage, out of circulation entirely
   * until used or the game ends (§7: "held advantages stay out until used or
   * game ends"). Phase 6 spec §36: "Do not accidentally reshuffle held cards
   * into the deck."
   */
  draw(teamId: TeamId, context: MacoContext): Result<MacoDrawView> {
    if (!this.#built) {
      return err(rejection('WRONG_STATE', 'The Maco Mail deck has not been built.'));
    }

    // Structurally impossible effects leave the pool BEFORE the draw, so they
    // never consume a draw. §7.
    this.#filterImpossible(context);

    if (this.#drawPile.length === 0) {
      // §7 — "empty draw pile reshuffles discard". Held advantages are NOT in
      // the discard, so they cannot come back this way.
      if (this.#discard.length === 0) {
        return err(rejection('ILLEGAL_ACTION', 'There are no Maco Mail cards left to draw.'));
      }
      this.#drawPile = shuffle(this.#rng, this.#discard);
      this.#discard = [];
    }

    const card = this.#drawPile.shift();
    if (card === undefined) {
      return err(rejection('INTERNAL_ERROR', 'Draw pile was unexpectedly empty.'));
    }

    return ok(this.#resolve(card, teamId, context));
  }

  /**
   * Remove effects that can never apply again.
   *
   * ONLY PERMANENT IMPOSSIBILITY BELONGS HERE. A card whose target merely
   * happens to be absent right now is a dud after the draw, not a removal
   * before it — see the header comment.
   */
  #filterImpossible(context: MacoContext): void {
    const stillPossible: DeckCard[] = [];
    for (const card of this.#drawPile) {
      if (this.#isStructurallyImpossible(card.outcome, context)) {
        this.#removedImpossible.push(card);
      } else {
        stillPossible.push(card);
      }
    }
    this.#drawPile = stillPossible;
  }

  #isStructurallyImpossible(outcome: MacoOutcome, context: MacoContext): boolean {
    switch (outcome) {
      case 'HANDS_TIED':
        // Phase 6 spec §34 — "if there is no eligible future challenge, this
        // card should not be drawable". The caller decides what counts.
        return !context.eligibleAnswererChallengeRemains;
      case 'PRICE_GONE_UP':
        // A surcharge on a Market that will never open again can never be paid.
        return !context.futureMarketRemains;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Resolving an outcome
  // -------------------------------------------------------------------------

  #resolve(card: DeckCard, teamId: TeamId, context: MacoContext): MacoDrawView {
    const kind = MACO_RESOLUTION[card.outcome];
    const drawnAt = asServerTimestamp(this.#clock.now());

    const base = {
      drawId: this.#mintId(),
      teamId,
      outcome: card.outcome,
      drawnAt,
    };

    let view: MacoDrawView;

    switch (kind) {
      case 'immediate_money':
        view = { ...base, ...this.#resolveMoney(card.outcome, teamId) };
        break;
      case 'held_advantage':
        view = { ...base, ...this.#resolveAdvantage(card.outcome, teamId) };
        break;
      case 'targeted':
        view = { ...base, ...this.#resolveTargeted(card.outcome, teamId, context) };
        break;
      case 'held_effect':
        view = { ...base, ...this.#resolveHeldEffect(card.outcome, teamId, context) };
        break;
    }

    // A card that became a HELD ADVANTAGE stays out of the deck entirely (§7).
    // Everything else — resolved, applied, dud — goes to the discard, so it can
    // return on a reshuffle.
    if (view.result !== 'held') {
      this.#discard.push(card);
    }

    this.#draws.push(view);
    return view;
  }

  /**
   * Money outcomes. GAME_RULES_LOCKED.md §8.
   *
   * ALWAYS THROUGH THE LEDGER (Phase 6 spec §25 — "Never mutate balances
   * outside the ledger"), so the floor at zero and the audit trail apply. §8
   * says Customs Seize Yuh Money floors at 0, and it does — because everything
   * does.
   */
  #resolveMoney(
    outcome: MacoOutcome,
    teamId: TeamId,
  ): Pick<MacoDrawView, 'result' | 'bbApplied' | 'targetTeamId' | 'advantageId' | 'explanation'> {
    const delta = MACO_MONEY_DELTAS[outcome];
    if (delta === undefined) {
      return {
        result: 'dud',
        bbApplied: 0,
        targetTeamId: null,
        advantageId: null,
        explanation: 'No money amount is defined for this outcome.',
      };
    }

    const applied = this.#ledger.apply({
      teamId,
      delta,
      reason: 'maco_mail',
      note: outcome,
    });

    return {
      result: 'resolved',
      bbApplied: applied.entry.applied,
      targetTeamId: null,
      advantageId: null,
      explanation: applied.clamped
        ? `${outcome}: only ${Math.abs(applied.entry.applied)} BB could be taken — the balance hit zero.`
        : `${outcome}: ${delta > 0 ? '+' : ''}${delta} BB.`,
    };
  }

  /**
   * Advantage outcomes become held advantages. §8 "Advantages".
   *
   * They stay OUT of the deck until used or the game ends (§7), which is why
   * the caller does not push the card to the discard.
   */
  #resolveAdvantage(
    outcome: MacoOutcome,
    teamId: TeamId,
  ): Pick<MacoDrawView, 'result' | 'bbApplied' | 'targetTeamId' | 'advantageId' | 'explanation'> {
    const type =
      outcome === 'PLUS_15_SECONDS'
        ? 'EXTRA_TIME'
        : outcome === 'FREE_CLUE'
          ? 'CLUE'
          : outcome === 'BACCHANAL_IMMUNITY'
            ? 'BACCHANAL_IMMUNITY'
            : 'DOUBLE';

    const advantage = this.#advantages.grant({
      teamId,
      type,
      source: 'maco_mail',
    });

    return {
      result: 'held',
      bbApplied: 0,
      targetTeamId: null,
      advantageId: advantage.advantageId,
      explanation: `${outcome}: held until used or the game ends.`,
    };
  }

  /**
   * Outcomes that need a valid opposing target.
   *
   * THE DUD PATH LIVES HERE. Each of these is a legitimate draw that may have
   * nothing to hit right now — §7's "eligible effect with no target".
   */
  #resolveTargeted(
    outcome: MacoOutcome,
    teamId: TeamId,
    context: MacoContext,
  ): Pick<MacoDrawView, 'result' | 'bbApplied' | 'targetTeamId' | 'advantageId' | 'explanation'> {
    const opponents = context.teamIds.filter((id) => id !== teamId);

    if (opponents.length === 0) {
      return dud('There is no opposing team to target.');
    }

    switch (outcome) {
      case 'PARTNER_I_SORRY': {
        // OPEN_RULES.md §12 — what happens when the payer holds under 500 is
        // UNDECIDED. Phase 6 spec §26: "Do NOT decide this... keep activation
        // blocked when this open case matters."
        //
        // The payer here is the DRAWING team: §8 — "give 500 BB to an opposing
        // team". At 500 or more the locked rule is complete and resolves
        // normally. Below 500 the rule runs out, so the card is blocked rather
        // than resolved, and deliberately NOT called a dud — a dud is a locked
        // outcome with consequences, and this is an absence of a rule.
        const balance = this.#ledger.balanceOf(teamId);
        if (balance < PARTNER_I_SORRY_AMOUNT) {
          return {
            result: 'blocked_open_rule',
            bbApplied: 0,
            targetTeamId: null,
            advantageId: null,
            explanation:
              `Partner, I Sorry cannot resolve: this team holds ${balance} BB, ` +
              `less than the ${PARTNER_I_SORRY_AMOUNT} BB the card transfers. ` +
              'That case is still being decided (OPEN_RULES.md §12).',
          };
        }

        const target = pickOne(this.#rng, opponents);
        if (target === null) return dud('There is no opposing team to target.');

        // A transfer, not a delta: both sides move, both through the ledger.
        const paid = this.#ledger.apply({
          teamId,
          delta: -PARTNER_I_SORRY_AMOUNT,
          reason: 'maco_mail',
          note: 'PARTNER_I_SORRY (paid)',
        });
        this.#ledger.apply({
          teamId: target,
          delta: PARTNER_I_SORRY_AMOUNT,
          reason: 'maco_mail',
          note: 'PARTNER_I_SORRY (received)',
        });

        return {
          result: 'applied',
          bbApplied: paid.entry.applied,
          targetTeamId: target,
          advantageId: null,
          explanation: `Partner, I Sorry: ${PARTNER_I_SORRY_AMOUNT} BB transferred.`,
        };
      }

      case 'CANCEL_MARKET_PURCHASE': {
        // §8 — destroy one UNUSED opponent Market item and refund what was paid.
        const candidates = opponents.flatMap((id) => this.#market.cancellablePurchases(id));
        if (candidates.length === 0) {
          // A DUD, not an impossibility: an opponent may buy something next
          // Market. §7 — no redraw, no refund.
          return dud('No opposing team has an unused Market item. Dud — no redraw, no refund.');
        }

        const chosen = pickOne(this.#rng, candidates);
        if (chosen === null) return dud('No opposing Market item could be chosen.');

        const cancelled = this.#market.cancelPurchase(chosen.purchaseId);
        if (!cancelled.ok) return dud('That Market item could not be cancelled.');

        // The purchase and the advantage it granted are two records the
        // moment the purchase can stop existing — destroying only the
        // purchase would leave its owner holding a Clue, an Extra Time or a
        // Double whose Market slip no longer exists. Silently a no-op when
        // the destroyed item never granted an advantage (Maco Mail, say).
        this.#advantages.revokeForPurchase(chosen.purchaseId);

        return {
          result: 'applied',
          bbApplied: 0,
          targetTeamId: chosen.teamId,
          advantageId: null,
          explanation:
            `Cancel Market Purchase: ${chosen.item} destroyed, ` +
            `${cancelled.value.refunded} BB refunded to its owner.`,
        };
      }

      case 'CARD_CONFISCATION': {
        // §8 — "randomly take one unused opponent Bacchanal card". Only HELD
        // cards are candidates (Phase 6 spec §32, "only legal unused cards").
        const candidates = opponents.flatMap((id) => this.#cards.confiscatableCards(id));
        if (candidates.length === 0) {
          return dud('No opposing team holds an unused Bacchanal card. Dud — no redraw.');
        }

        const chosen = pickOne(this.#rng, candidates);
        if (chosen === null) return dud('No opposing card could be chosen.');

        const moved = this.#cards.transfer(chosen.cardInstanceId, teamId);
        if (!moved.ok) return dud('That card could not be taken.');

        return {
          result: 'applied',
          bbApplied: 0,
          targetTeamId: chosen.owningTeamId,
          advantageId: null,
          // The card type IS revealed — it has changed hands, and its new owner
          // must know what they hold.
          explanation: `Card Confiscation: took ${chosen.cardType}.`,
        };
      }

      default:
        return dud('This outcome has no defined target behaviour.');
    }
  }

  /**
   * Outcomes that place a lasting burden on another team. §8 "Game-changing".
   */
  #resolveHeldEffect(
    outcome: MacoOutcome,
    teamId: TeamId,
    context: MacoContext,
  ): Pick<MacoDrawView, 'result' | 'bbApplied' | 'targetTeamId' | 'advantageId' | 'explanation'> {
    const opponents = context.teamIds.filter((id) => id !== teamId);
    if (opponents.length === 0) {
      return dud('There is no opposing team to target.');
    }

    const target = pickOne(this.#rng, opponents);
    if (target === null) return dud('There is no opposing team to target.');

    if (outcome === 'PRICE_GONE_UP') {
      const added = this.#market.addSurcharge(target);
      if (!added.ok) {
        return dud('That team already has a pending surcharge. Dud — no redraw.');
      }
      this.#placeEffect('PRICE_GONE_UP', target, teamId);
      return {
        result: 'applied',
        bbApplied: 0,
        targetTeamId: target,
        advantageId: null,
        explanation: `Price Gone Up!: their next Market purchase costs +${added.value} BB.`,
      };
    }

    // HANDS_TIED. The held state is created here; WHICH challenge it applies to
    // is Phase 7's, per spec §34.
    if (!context.eligibleAnswererChallengeRemains) {
      return dud('No eligible challenge remains for Hands Tied. Dud — no redraw.');
    }
    this.#placeEffect('HANDS_TIED', target, teamId);
    return {
      result: 'applied',
      bbApplied: 0,
      targetTeamId: target,
      advantageId: null,
      explanation: 'Hands Tied: you choose their next individual answerer.',
    };
  }

  #placeEffect(type: HeldEffectType, targetTeamId: TeamId, placedByTeamId: TeamId): HeldEffectView {
    const record: HeldEffectRecord = {
      effectId: this.#mintId(),
      type,
      targetTeamId,
      placedByTeamId,
      placedAt: asServerTimestamp(this.#clock.now()),
      consumed: false,
      consumedAt: null,
    };
    this.#heldEffects.push(record);
    return { ...record };
  }

  /** Mark a held effect as spent. */
  consumeHeldEffect(effectId: string): Result<HeldEffectView> {
    const record = this.#heldEffects.find((e) => e.effectId === effectId);
    if (record === undefined) {
      return err(rejection('NOT_FOUND', 'No such held effect.', { effectId }));
    }
    if (record.consumed) {
      return err(rejection('ILLEGAL_ACTION', 'That effect has already been used.'));
    }
    record.consumed = true;
    record.consumedAt = asServerTimestamp(this.#clock.now());
    return ok({ ...record });
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  /**
   * The deck as clients see it.
   *
   * COUNTS ONLY, NEVER ORDER — for the Host as well as players. Phase 6 spec
   * §42 lists "future deck order" as hidden, and a Host display is usually
   * pointed at a TV the whole room can see.
   */
  deckView(): MacoDeckView {
    return {
      drawPileCount: this.#drawPile.length,
      discardCount: this.#discard.length,
      heldOutOfDeckCount: this.#advantages.heldFromMacoMail().length,
      removedImpossibleCount: this.#removedImpossible.length,
    };
  }

  draws(): readonly MacoDrawView[] {
    return [...this.#draws];
  }

  drawsFor(teamId: TeamId): readonly MacoDrawView[] {
    return this.#draws.filter((draw) => draw.teamId === teamId);
  }

  heldEffects(): readonly HeldEffectView[] {
    return this.#heldEffects.map((e) => ({ ...e }));
  }

  /** Held effects a team is subject to, or placed on others. */
  heldEffectsFor(teamId: TeamId): readonly HeldEffectView[] {
    return this.#heldEffects
      .filter((e) => e.targetTeamId === teamId || e.placedByTeamId === teamId)
      .map((e) => ({ ...e }));
  }
}

/**
 * A dud outcome. GAME_RULES_LOCKED.md §7 — no redraw, no refund, no
 * compensation.
 *
 * The card is still spent and still goes to the discard. That is the whole
 * point of the rule: a dud costs the team its draw.
 */
function dud(
  explanation: string,
): Pick<MacoDrawView, 'result' | 'bbApplied' | 'targetTeamId' | 'advantageId' | 'explanation'> {
  return {
    result: 'dud' as MacoDrawResult,
    bbApplied: 0,
    targetTeamId: null,
    advantageId: null,
    explanation,
  };
}
