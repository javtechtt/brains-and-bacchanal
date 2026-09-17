import {
  ADVANTAGE_LIMITS_PER_CHALLENGE,
  asServerTimestamp,
  err,
  MAX_RETRIES_PER_CHALLENGE,
  ok,
  rejection,
  type AdvantageSource,
  type AdvantageType,
  type ChallengeAdvantageUsage,
  type HeldAdvantageView,
  type MarketItem,
  type Result,
  type TeamId,
} from '@bb/protocol';
import type { Clock } from './clock.js';

/**
 * Held advantages, and the one place stacking rules live.
 *
 * GAME_RULES_LOCKED.md §4 (the retry rule), §7 (held advantages stay out of the
 * deck), §10 ("No stacking: one Double, one clue, one time extension, one retry
 * maximum"). DECISION_LOG.md D-006.
 *
 * ================== ONE BUDGET, TWO SOURCES ==================
 * The retry rule is the reason this class exists in this shape. §4:
 *
 *   "Market Second Chance and FORGIVE MEH! cannot be chained. Maximum one retry
 *    on the same question. If both are available: team chooses which one to
 *    use, the other remains available for a later eligible question."
 *
 * A Market advantage and a Bacchanal card therefore draw on ONE per-challenge
 * budget. If each system tracked its own, a team holding both would get two
 * retries — which is precisely what §4 forbids. So the budget is here, and both
 * systems spend from it.
 *
 * Phase 6 spec §40 — "Future round code must query this shared system rather
 * than implementing its own stacking logic."
 * =============================================================
 */

interface AdvantageRecord extends HeldAdvantageView {
  used: boolean;
  usedAt: ReturnType<typeof asServerTimestamp> | null;
  expired: boolean;
}

/** Mutable per-challenge usage. */
interface Usage {
  clueUsed: boolean;
  doubleUsed: boolean;
  extraTimeUsed: boolean;
  retriesUsed: number;
  retrySource: 'second_chance' | 'forgive_meh' | null;
  bacchanalCardPlayed: boolean;
}

const EMPTY_USAGE: ChallengeAdvantageUsage = {
  clueUsed: false,
  doubleUsed: false,
  extraTimeUsed: false,
  retriesUsed: 0,
  retrySource: null,
  bacchanalCardPlayed: false,
};

/**
 * Which advantage a Market item grants.
 *
 * MACO_MAIL is absent because buying it grants a DRAW, not an advantage — §10,
 * "purchased Maco Mail opens after reveal". What that draw produces may then
 * become an advantage, through the normal Maco Mail path.
 */
const MARKET_ITEM_ADVANTAGE: Readonly<Partial<Record<MarketItem, AdvantageType>>> = {
  CLUE: 'CLUE',
  SECOND_CHANCE: 'SECOND_CHANCE',
  DOUBLE_BB: 'DOUBLE',
  EXTRA_TIME: 'EXTRA_TIME',
} as const;

export function advantageForMarketItem(item: MarketItem): AdvantageType | null {
  return MARKET_ITEM_ADVANTAGE[item] ?? null;
}

export interface AdvantagesOptions {
  readonly clock: Clock;
  readonly mintId: () => string;
}

export class Advantages {
  readonly #clock: Clock;
  readonly #mintId: () => string;

  readonly #held: AdvantageRecord[] = [];
  /** teamId -> what they have spent in the CURRENT challenge. */
  readonly #usage = new Map<string, Usage>();

  constructor(options: AdvantagesOptions) {
    this.#clock = options.clock;
    this.#mintId = options.mintId;
  }

  // -------------------------------------------------------------------------
  // Granting
  // -------------------------------------------------------------------------

  /**
   * Give a team an advantage.
   *
   * EXPIRY DIFFERS BY SOURCE, and both rules are locked:
   *   - Market: "items expire after the immediately following round" (§10), so
   *     `expiresAfterRound` is the round it was bought before.
   *   - Maco Mail: "held advantages stay out until used or game ends" (§7), so
   *     there is no expiry round at all — null.
   *
   * Passing the wrong one would either delete a Maco advantage early or let a
   * Market item live forever, so the source decides it rather than the caller.
   */
  grant(input: {
    readonly teamId: TeamId;
    readonly type: AdvantageType;
    readonly source: AdvantageSource;
    readonly purchaseId?: string | null;
    /** Required for a Market advantage; ignored for Maco Mail. */
    readonly expiresAfterRound?: number | null;
  }): HeldAdvantageView {
    const record: AdvantageRecord = {
      advantageId: this.#mintId(),
      type: input.type,
      teamId: input.teamId,
      source: input.source,
      purchaseId: input.purchaseId ?? null,
      acquiredAt: asServerTimestamp(this.#clock.now()),
      expiresAfterRound:
        input.source === 'maco_mail' ? null : (input.expiresAfterRound ?? null),
      used: false,
      usedAt: null,
      expired: false,
    };
    this.#held.push(record);
    return { ...record };
  }

  // -------------------------------------------------------------------------
  // Using — where the stacking rules are enforced
  // -------------------------------------------------------------------------

  /**
   * Use a held advantage in the current challenge.
   *
   * THE STACKING GATE. Every locked restriction in §10 and §4 is checked here
   * and nowhere else, so a future round cannot grant itself a second clue by
   * forgetting a rule it never knew about.
   */
  use(input: {
    readonly teamId: TeamId;
    readonly advantageId: string;
  }): Result<HeldAdvantageView> {
    const record = this.#held.find((a) => a.advantageId === input.advantageId);
    if (record === undefined) {
      return err(rejection('NOT_FOUND', 'No such advantage.', { advantageId: input.advantageId }));
    }
    if (record.teamId !== input.teamId) {
      return err(rejection('UNAUTHORIZED_ACTOR', 'That advantage belongs to another team.'));
    }
    if (record.used) {
      return err(rejection('ILLEGAL_ACTION', 'That advantage has already been used.'));
    }
    if (record.expired) {
      return err(rejection('ILLEGAL_ACTION', 'That advantage has expired.'));
    }

    const gate = this.#checkStacking(input.teamId, record.type);
    if (gate !== null) return err(gate);

    record.used = true;
    record.usedAt = asServerTimestamp(this.#clock.now());
    this.#recordUse(input.teamId, record.type, record.source);

    return ok({ ...record });
  }

  /**
   * Whether a team may use an advantage of this type right now.
   *
   * Exposed separately so a UI can disable a button for the same reason the
   * server would refuse it — and so a round can ask before offering a choice.
   */
  canUse(teamId: TeamId, type: AdvantageType): boolean {
    return this.#checkStacking(teamId, type) === null;
  }

  #checkStacking(teamId: TeamId, type: AdvantageType): ReturnType<typeof rejection> | null {
    const usage = this.#usageFor(teamId);

    switch (type) {
      case 'CLUE':
        // §10 — "one clue".
        return usage.clueUsed
          ? rejection('ILLEGAL_ACTION', 'Your team has already used a clue on this question.', {
              limit: ADVANTAGE_LIMITS_PER_CHALLENGE.CLUE,
            })
          : null;

      case 'DOUBLE':
        // §3 — "multipliers never stack", and §10 — "one Double". The same rule
        // covers Double It!, Market Double BB and Maco Mail Double Points, which
        // is why they all resolve to one AdvantageType.
        return usage.doubleUsed
          ? rejection('ILLEGAL_ACTION', 'This reward is already doubled. Multipliers do not stack.')
          : null;

      case 'EXTRA_TIME':
        // §10 — "one time extension".
        return usage.extraTimeUsed
          ? rejection('ILLEGAL_ACTION', 'Your team has already extended the time.')
          : null;

      case 'SECOND_CHANCE':
        // §4 / D-006 — ONE retry per question, shared with FORGIVE MEH!.
        return usage.retriesUsed >= MAX_RETRIES_PER_CHALLENGE
          ? rejection('ILLEGAL_ACTION', 'Your team has already taken its one retry.', {
              retrySource: usage.retrySource ?? '',
            })
          : null;

      case 'BACCHANAL_IMMUNITY':
        // Not a per-challenge budget — it is consumed when it triggers, and a
        // team may hold it across challenges until something attacks them.
        return null;
    }
  }

  /**
   * Spend the shared retry budget from a FORGIVE MEH! card.
   *
   * §4 is the reason this is not a card-system concern: FORGIVE MEH! and Market
   * Second Chance draw on the same budget, so the card asks this class rather
   * than tracking its own retry flag.
   */
  useForgiveMehRetry(teamId: TeamId): Result<true> {
    const usage = this.#usageFor(teamId);
    if (usage.retriesUsed >= MAX_RETRIES_PER_CHALLENGE) {
      return err(
        rejection('ILLEGAL_ACTION', 'Your team has already taken its one retry.', {
          retrySource: usage.retrySource ?? '',
        }),
      );
    }
    usage.retriesUsed += 1;
    usage.retrySource = 'forgive_meh';
    return ok(true);
  }

  /** Record that a Bacchanal card was played. GAME_RULES_LOCKED.md §2. */
  recordBacchanalCardPlayed(teamId: TeamId): void {
    this.#usageFor(teamId).bacchanalCardPlayed = true;
  }

  #recordUse(teamId: TeamId, type: AdvantageType, _source: AdvantageSource): void {
    const usage = this.#usageFor(teamId);
    switch (type) {
      case 'CLUE':
        usage.clueUsed = true;
        break;
      case 'DOUBLE':
        usage.doubleUsed = true;
        break;
      case 'EXTRA_TIME':
        usage.extraTimeUsed = true;
        break;
      case 'SECOND_CHANCE':
        usage.retriesUsed += 1;
        usage.retrySource = 'second_chance';
        break;
      case 'BACCHANAL_IMMUNITY':
        break;
    }
  }

  /**
   * Consume a team's Bacchanal Immunity, if they hold one.
   *
   * GAME_RULES_LOCKED.md §8 / Phase 6 spec §29 — immunity cancels a Bacchanal
   * card used against the protected team, and is consumed doing so. It does NOT
   * protect against the Market, Maco Mail, a Host Deal or a wager; those callers
   * simply never ask.
   *
   * Returns the consumed advantage, or null when the team had none — so the
   * caller can tell "protected" from "not protected" without a second lookup.
   */
  consumeImmunity(teamId: TeamId): HeldAdvantageView | null {
    const record = this.#held.find(
      (a) => a.teamId === teamId && a.type === 'BACCHANAL_IMMUNITY' && !a.used && !a.expired,
    );
    if (record === undefined) return null;

    record.used = true;
    record.usedAt = asServerTimestamp(this.#clock.now());
    return { ...record };
  }

  /**
   * Remove the advantage a Market purchase granted, because that purchase no
   * longer stands.
   *
   * A GAP THIS CLOSES: a Market purchase and its advantage were two separate
   * records the moment a purchase could stop existing — first from the Maco
   * Mail Cancel Market Purchase card, and now from a team withdrawing its own
   * unrevealed item before the Market closes (the grocery-cart reading of
   * §10: "purchases are final" describes checkout, not every click before it).
   * Neither path ever revoked the advantage, so a team could lose the item on
   * the receipt and keep the Clue anyway.
   *
   * Only removes an UNUSED advantage — if the team already spent it (already
   * asked for the clue, already doubled a reward), it is too late to take
   * back, exactly as Cancel Market Purchase already refuses to destroy a USED
   * purchase. Returns null when there is nothing to revoke, which the caller
   * treats as "nothing to undo" rather than an error — a purchase that never
   * granted an advantage (Maco Mail, say) legitimately has none.
   */
  revokeForPurchase(purchaseId: string): HeldAdvantageView | null {
    const index = this.#held.findIndex((a) => a.purchaseId === purchaseId && !a.used);
    if (index === -1) return null;

    const [record] = this.#held.splice(index, 1);
    return record === undefined ? null : { ...record };
  }

  // -------------------------------------------------------------------------
  // Challenge and round boundaries
  // -------------------------------------------------------------------------

  /**
   * Clear per-challenge usage.
   *
   * The budgets in §4 and §10 are per QUESTION, not per game — "maximum one
   * retry on the same question", "one clue". A new challenge restores every
   * budget, while the advantages themselves persist until used or expired.
   */
  endChallenge(): void {
    this.#usage.clear();
  }

  /**
   * Expire Market advantages whose round has passed.
   *
   * §10 for Market items. Maco Mail advantages have a null expiry and are
   * skipped, per §7 — "held advantages stay out until used or game ends".
   */
  expireAfterRound(completedRoundIndex: number): readonly HeldAdvantageView[] {
    const expired: HeldAdvantageView[] = [];
    for (const record of this.#held) {
      if (record.used || record.expired) continue;
      if (record.expiresAfterRound === null) continue;
      if (record.expiresAfterRound > completedRoundIndex) continue;
      record.expired = true;
      expired.push({ ...record });
    }
    return expired;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Every advantage, for the Host view. */
  all(): readonly HeldAdvantageView[] {
    return this.#held.map((a) => ({ ...a }));
  }

  /** One team's advantages. */
  forTeam(teamId: TeamId): readonly HeldAdvantageView[] {
    return this.#held.filter((a) => a.teamId === teamId).map((a) => ({ ...a }));
  }

  /** One team's usable advantages — not used, not expired. */
  usableFor(teamId: TeamId): readonly HeldAdvantageView[] {
    return this.#held
      .filter((a) => a.teamId === teamId && !a.used && !a.expired)
      .map((a) => ({ ...a }));
  }

  /**
   * Held advantages that are currently OUT of the Maco Mail deck.
   *
   * §7 — "held advantages stay out until used or game ends". The deck asks this
   * so it never reshuffles a card a team is still holding.
   */
  heldFromMacoMail(): readonly HeldAdvantageView[] {
    return this.#held
      .filter((a) => a.source === 'maco_mail' && !a.used && !a.expired)
      .map((a) => ({ ...a }));
  }

  usageFor(teamId: TeamId): ChallengeAdvantageUsage {
    const usage = this.#usage.get(teamId);
    return usage === undefined ? EMPTY_USAGE : { ...usage };
  }

  allUsage(): Readonly<Record<string, ChallengeAdvantageUsage>> {
    const out: Record<string, ChallengeAdvantageUsage> = {};
    for (const [teamId, usage] of this.#usage) out[teamId] = { ...usage };
    return out;
  }

  #usageFor(teamId: TeamId): Usage {
    let usage = this.#usage.get(teamId);
    if (usage === undefined) {
      usage = {
        clueUsed: false,
        doubleUsed: false,
        extraTimeUsed: false,
        retriesUsed: 0,
        retrySource: null,
        bacchanalCardPlayed: false,
      };
      this.#usage.set(teamId, usage);
    }
    return usage;
  }
}
