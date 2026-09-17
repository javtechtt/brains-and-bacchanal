import {
  asServerTimestamp,
  err,
  HOST_DEAL_TERMS,
  maxWagerFor,
  ok,
  rejection,
  type HostDealChoice,
  type HostDealTemplate,
  type HostDealView,
  type Result,
  type TeamId,
  type WagerStatus,
  type WagerView,
} from '@bb/protocol';
import type { BbLedger } from './bb-ledger.js';
import type { Clock } from './clock.js';

/**
 * Host Deals and the generic wager.
 *
 * GAME_RULES_LOCKED.md §9 (one deal per round, predefined templates) and §17
 * (the steal wager, up to 50% of current BB). DECISION_LOG.md D-009.
 *
 * ================== THE HOST CANNOT INVENT MATHS ==================
 * §9 — "Deal mathematics come from predefined templates and are not improvised."
 *
 * So no amount travels on a Host Deal intent. The Host names a template; every
 * number comes from `HOST_DEAL_TERMS`. A compromised or buggy Host client can
 * offer the wrong deal, but it cannot offer a deal worth 9,000 BB, because
 * there is no field to put that in.
 * ==================================================================
 */

interface DealRecord extends HostDealView {
  choice: HostDealChoice | null;
  resolvedAt: ReturnType<typeof asServerTimestamp> | null;
  bbApplied: Record<string, number>;
}

interface WagerRecord extends WagerView {
  status: WagerStatus;
  resolvedAt: ReturnType<typeof asServerTimestamp> | null;
  bbApplied: number;
}

export interface DealsOptions {
  readonly clock: Clock;
  readonly ledger: BbLedger;
  readonly mintId: () => string;
}

export class Deals {
  readonly #clock: Clock;
  readonly #ledger: BbLedger;
  readonly #mintId: () => string;

  readonly #deals: DealRecord[] = [];
  readonly #wagers: WagerRecord[] = [];

  constructor(options: DealsOptions) {
    this.#clock = options.clock;
    this.#ledger = options.ledger;
    this.#mintId = options.mintId;
  }

  // -------------------------------------------------------------------------
  // Host Deals
  // -------------------------------------------------------------------------

  /**
   * Offer a deal to a team.
   *
   * D-009 / §9 — "Maximum one Host Deal per round." Counted per round index,
   * and an offered-but-unanswered deal still counts: a Host must not be able to
   * offer four deals and let the team pick the best, which is what allowing
   * repeats until one resolves would permit.
   */
  offer(input: {
    readonly template: HostDealTemplate;
    readonly teamId: TeamId;
    readonly opponentTeamId?: TeamId | null;
    readonly roundIndex: number;
    readonly knownTeamIds: readonly TeamId[];
  }): Result<HostDealView> {
    const terms = HOST_DEAL_TERMS[input.template];
    if (terms === undefined) {
      return err(rejection('NOT_FOUND', 'No such Host Deal template.', { template: input.template }));
    }

    if (!input.knownTeamIds.includes(input.teamId)) {
      return err(rejection('NOT_FOUND', 'Unknown team.', { teamId: input.teamId }));
    }

    // D-009. One per round, offered or resolved.
    const existing = this.#deals.find((deal) => deal.roundIndex === input.roundIndex);
    if (existing !== undefined) {
      return err(
        rejection('ILLEGAL_ACTION', 'A Host Deal has already been offered this round.', {
          roundIndex: input.roundIndex,
          dealId: existing.dealId,
        }),
      );
    }

    const opponent = input.opponentTeamId ?? null;
    if (terms.requiresOpponent) {
      if (opponent === null) {
        return err(
          rejection('INVALID_REQUEST', 'This deal needs an opposing team.', {
            template: input.template,
          }),
        );
      }
      if (opponent === input.teamId) {
        return err(rejection('ILLEGAL_ACTION', 'The opposing team must be a different team.'));
      }
      if (!input.knownTeamIds.includes(opponent)) {
        return err(rejection('NOT_FOUND', 'Unknown opposing team.', { teamId: opponent }));
      }
    }

    // Affordability where the deal costs BB. Phase 6 spec §38. Only
    // MYSTERY_DEAL charges the team's own balance; the others pay out or cost
    // an amount the team never receives in the first place.
    if (terms.acceptCostBb > 0 && this.#ledger.balanceOf(input.teamId) < terms.acceptCostBb) {
      return err(
        rejection('ILLEGAL_ACTION', 'That team cannot afford this deal.', {
          required: terms.acceptCostBb,
          balance: this.#ledger.balanceOf(input.teamId),
        }),
      );
    }

    const record: DealRecord = {
      dealId: this.#mintId(),
      template: input.template,
      teamId: input.teamId,
      opponentTeamId: opponent,
      roundIndex: input.roundIndex,
      offeredAt: asServerTimestamp(this.#clock.now()),
      choice: null,
      resolvedAt: null,
      bbApplied: {},
      terms,
    };
    this.#deals.push(record);

    return ok({ ...record, bbApplied: { ...record.bbApplied } });
  }

  /**
   * Record the team's choice and apply it.
   *
   * EVERY AMOUNT COMES FROM THE TEMPLATE. The intent carries `accept` or
   * `decline` and nothing else.
   *
   * Resolving twice is refused: the idempotency registry catches a retried
   * intent, and this catches a second genuine attempt — otherwise a team could
   * take both sides of the same deal.
   */
  respond(input: {
    readonly dealId: string;
    readonly teamId: TeamId;
    readonly choice: HostDealChoice;
  }): Result<{ readonly deal: HostDealView; readonly grantsMacoDraw: boolean }> {
    const record = this.#deals.find((deal) => deal.dealId === input.dealId);
    if (record === undefined) {
      return err(rejection('NOT_FOUND', 'No such deal.', { dealId: input.dealId }));
    }
    if (record.teamId !== input.teamId) {
      return err(rejection('UNAUTHORIZED_ACTOR', 'That deal was offered to another team.'));
    }
    if (record.choice !== null) {
      return err(
        rejection('ILLEGAL_ACTION', 'That deal has already been answered.', {
          choice: record.choice,
        }),
      );
    }

    const terms = record.terms;
    const applied: Record<string, number> = {};

    if (input.choice === 'decline') {
      // The safe side. Every template but MYSTERY_DEAL pays something here.
      if (terms.declineBb > 0) {
        const outcome = this.#ledger.apply({
          teamId: record.teamId,
          delta: terms.declineBb,
          reason: 'host_deal',
          note: `${record.template} (declined)`,
        });
        applied[record.teamId] = outcome.entry.applied;
      }
    } else {
      // Accepting. Re-checked at resolution time because the balance may have
      // moved since the offer.
      if (terms.acceptCostBb > 0) {
        const balance = this.#ledger.balanceOf(record.teamId);
        if (balance < terms.acceptCostBb) {
          return err(
            rejection('ILLEGAL_ACTION', 'Your team can no longer afford this deal.', {
              required: terms.acceptCostBb,
              balance,
            }),
          );
        }
        const outcome = this.#ledger.apply({
          teamId: record.teamId,
          delta: -terms.acceptCostBb,
          reason: 'host_deal',
          note: `${record.template} (accepted)`,
        });
        applied[record.teamId] = outcome.entry.applied;
      }

      // OPPONENT'S DEAL — "give opposing team 250 and receive Maco". The payer
      // never holds the 500, so this is a payment to the opponent rather than a
      // transfer out of a balance the team was given.
      if (terms.acceptPaysOpponentBb > 0 && record.opponentTeamId !== null) {
        const outcome = this.#ledger.apply({
          teamId: record.opponentTeamId,
          delta: terms.acceptPaysOpponentBb,
          reason: 'host_deal',
          note: `${record.template} (opponent's share)`,
        });
        applied[record.opponentTeamId] = outcome.entry.applied;
      }
    }

    record.choice = input.choice;
    record.resolvedAt = asServerTimestamp(this.#clock.now());
    record.bbApplied = applied;

    return ok({
      deal: { ...record, bbApplied: { ...applied } },
      grantsMacoDraw: input.choice === 'accept' && terms.acceptGrantsMacoDraw,
    });
  }

  /**
   * Settle a DOUBLE_OR_NOTHING_ISH bet once the next answer is judged.
   *
   * Kept separate from `respond` because the outcome is not known when the deal
   * is taken — "correct next = 1000, wrong = 0" settles on a later answer, which
   * is a round's business. The deal records the stake and stops; this pays it.
   */
  settlePendingBet(input: {
    readonly dealId: string;
    readonly won: boolean;
  }): Result<HostDealView> {
    const record = this.#deals.find((deal) => deal.dealId === input.dealId);
    if (record === undefined) {
      return err(rejection('NOT_FOUND', 'No such deal.', { dealId: input.dealId }));
    }
    if (!record.terms.acceptCreatesPendingBet) {
      return err(rejection('ILLEGAL_ACTION', 'That deal has no pending bet.'));
    }
    if (record.choice !== 'accept') {
      return err(rejection('WRONG_STATE', 'That deal was not accepted.'));
    }
    if (record.bbApplied[record.teamId] !== undefined) {
      return err(rejection('ILLEGAL_ACTION', 'That bet has already been settled.'));
    }

    const payout = input.won ? record.terms.pendingBetWinBb : record.terms.pendingBetLoseBb;
    const applied: Record<string, number> = { ...record.bbApplied };

    if (payout > 0) {
      const outcome = this.#ledger.apply({
        teamId: record.teamId,
        delta: payout,
        reason: 'host_deal',
        note: `${record.template} (${input.won ? 'won' : 'lost'})`,
      });
      applied[record.teamId] = outcome.entry.applied;
    } else {
      // A lost bet pays zero — "wrong = 0". The team keeps what it had; it gave
      // up the 500 it would have kept by declining, and that 500 was never paid.
      applied[record.teamId] = 0;
    }

    record.bbApplied = applied;
    return ok({ ...record, bbApplied: { ...applied } });
  }

  deals(): readonly HostDealView[] {
    return this.#deals.map((d) => ({ ...d, bbApplied: { ...d.bbApplied } }));
  }

  /** A deal offered to this team and still awaiting an answer. */
  pendingDealFor(teamId: TeamId): HostDealView | null {
    const record = this.#deals.find((deal) => deal.teamId === teamId && deal.choice === null);
    return record === undefined ? null : { ...record, bbApplied: { ...record.bbApplied } };
  }

  dealsInRound(roundIndex: number): readonly HostDealView[] {
    return this.#deals
      .filter((deal) => deal.roundIndex === roundIndex)
      .map((d) => ({ ...d, bbApplied: { ...d.bbApplied } }));
  }

  // -------------------------------------------------------------------------
  // Generic wagers
  // -------------------------------------------------------------------------

  /**
   * Propose and lock a wager.
   *
   * GAME_RULES_LOCKED.md §19 — up to 50% of CURRENT BB, placed before
   * answering. Phase 6 builds the primitive only; it is not attached to a
   * Family Feud board, and no board exists.
   *
   * THE BALANCE IS CAPTURED AT LOCK TIME. A wager validated against 1,000 BB
   * stays valid even if the team's balance later falls — re-checking at
   * resolution would let an unrelated Maco Mail penalty silently void a bet the
   * team legitimately placed.
   */
  proposeWager(input: {
    readonly teamId: TeamId;
    readonly amount: number;
    readonly contextRef?: string | null;
  }): Result<WagerView> {
    if (!Number.isInteger(input.amount) || input.amount < 0) {
      return err(rejection('INVALID_REQUEST', 'A wager must be a whole, non-negative number.'));
    }

    // One live wager at a time. Two concurrent wagers would need a rule for
    // resolving them together, and no locked rule provides one.
    const live = this.#wagers.find((w) => w.teamId === input.teamId && w.status === 'locked');
    if (live !== undefined) {
      return err(
        rejection('ILLEGAL_ACTION', 'Your team already has a wager locked.', {
          wagerId: live.wagerId,
        }),
      );
    }

    const balance = this.#ledger.balanceOf(input.teamId);
    const maxAllowed = maxWagerFor(balance);

    if (input.amount > maxAllowed) {
      return err(
        rejection('ILLEGAL_ACTION', 'That wager is above the 50% limit.', {
          amount: input.amount,
          maxAllowed,
          balance,
        }),
      );
    }

    const record: WagerRecord = {
      wagerId: this.#mintId(),
      teamId: input.teamId,
      amount: input.amount,
      balanceAtLock: balance,
      maxAllowed,
      status: 'locked',
      lockedAt: asServerTimestamp(this.#clock.now()),
      resolvedAt: null,
      bbApplied: 0,
      contextRef: input.contextRef ?? null,
    };
    this.#wagers.push(record);

    return ok({ ...record });
  }

  /**
   * Resolve a locked wager, exactly once.
   *
   * §17 — correct: the team gains the wager; wrong: it loses the wager, and "BB
   * floor is 0". The floor is the ledger's, as always, so a team wagering more
   * than it now holds cannot go negative.
   *
   * Board BB is NOT paid here. §17 also awards the board to one side or the
   * other, but a board is Family Feud's and does not exist — the round applies
   * that through a challenge result.
   */
  resolveWager(input: {
    readonly wagerId: string;
    readonly won: boolean;
  }): Result<WagerView> {
    const record = this.#wagers.find((w) => w.wagerId === input.wagerId);
    if (record === undefined) {
      return err(rejection('NOT_FOUND', 'No such wager.', { wagerId: input.wagerId }));
    }
    if (record.status !== 'locked') {
      return err(
        rejection('ILLEGAL_ACTION', 'That wager has already been resolved.', {
          status: record.status,
        }),
      );
    }

    const delta = input.won ? record.amount : -record.amount;
    const outcome = this.#ledger.apply({
      teamId: record.teamId,
      delta,
      reason: 'wager',
      note: input.won ? 'Wager won' : 'Wager lost',
    });

    record.status = input.won ? 'won' : 'lost';
    record.resolvedAt = asServerTimestamp(this.#clock.now());
    record.bbApplied = outcome.entry.applied;

    return ok({ ...record });
  }

  /** Cancel a locked wager without moving BB. */
  cancelWager(wagerId: string): Result<WagerView> {
    const record = this.#wagers.find((w) => w.wagerId === wagerId);
    if (record === undefined) {
      return err(rejection('NOT_FOUND', 'No such wager.', { wagerId }));
    }
    if (record.status !== 'locked') {
      return err(rejection('ILLEGAL_ACTION', 'That wager is not open.'));
    }
    record.status = 'cancelled';
    record.resolvedAt = asServerTimestamp(this.#clock.now());
    return ok({ ...record });
  }

  wagers(): readonly WagerView[] {
    return this.#wagers.map((w) => ({ ...w }));
  }

  wagersFor(teamId: TeamId): readonly WagerView[] {
    return this.#wagers.filter((w) => w.teamId === teamId).map((w) => ({ ...w }));
  }

  /** The largest wager a team could legally place right now. */
  maxWagerFor(teamId: TeamId): number {
    return maxWagerFor(this.#ledger.balanceOf(teamId));
  }
}
