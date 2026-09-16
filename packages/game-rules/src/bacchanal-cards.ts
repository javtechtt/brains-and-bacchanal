import {
  asServerTimestamp,
  categoryOf,
  cardHasAnyLegalChallenge,
  cardRequiresTarget,
  err,
  isCardEligible,
  ok,
  rejection,
  STARTING_HAND_POOLS,
  type BacchanalCardInstance,
  type BacchanalCardType,
  type CardChallengeKind,
  type CardStatus,
  type CardUnplayableReason,
  type CardWindowView,
  type ChallengeId,
  type OpponentHandView,
  type OwnCardView,
  type Result,
  type TeamId,
} from '@bb/protocol';
import type { Clock } from './clock.js';
import { pickOne, type Rng } from './rng.js';

/**
 * Bacchanal card ownership, dealing, eligibility and play validation.
 *
 * GAME_RULES_LOCKED.md §2, §3, §6. The Clash that a played card may trigger is
 * clash.ts; this file owns everything up to the moment a card is committed.
 *
 * WHAT THIS FILE DOES NOT DO: decide what a card's effect is worth. Doubling a
 * reward needs a reward, passing a question needs a question, and both belong to
 * a round — Phase 7. The shared system tracks ownership, legality, timing and
 * consumption, and hands the round a resolved, legal effect.
 *
 * Pure except for the injected Clock and Rng. No I/O, no transport.
 */

/** A team's hand plus the per-challenge facts the locked rules need. */
interface TeamCardState {
  readonly cards: Map<string, BacchanalCardInstance>;
}

/**
 * Per-challenge card facts.
 *
 * TWO SEPARATE BANS, DELIBERATELY (Phase 6 spec §8). A team that has played is
 * barred for the challenge; a specific card that lost a Clash is barred even
 * though its owner might otherwise still act. GAME_RULES_LOCKED.md §5 creates
 * exactly this pair, and inferring either from the other would get Part Dat
 * Fight wrong — there, cards return to hand AND their teams are done.
 */
interface ChallengeCardState {
  readonly teamsWhoPlayed: Set<string>;
  readonly barredCardInstanceIds: Set<string>;
}

export interface BacchanalCardsOptions {
  readonly clock: Clock;
  readonly rng: Rng;
  readonly mintId: () => string;
}

export class BacchanalCards {
  readonly #clock: Clock;
  readonly #rng: Rng;
  readonly #mintId: () => string;

  readonly #teams = new Map<string, TeamCardState>();

  /** The current card-play window. Closed until a challenge opens one. */
  #windowOpen = false;
  #challengeKind: CardChallengeKind | null = null;
  #challengeId: ChallengeId | null = null;
  #challengeState: ChallengeCardState = {
    teamsWhoPlayed: new Set(),
    barredCardInstanceIds: new Set(),
  };

  #dealt = false;

  constructor(options: BacchanalCardsOptions) {
    this.#clock = options.clock;
    this.#rng = options.rng;
    this.#mintId = options.mintId;
  }

  get dealt(): boolean {
    return this.#dealt;
  }

  get windowOpen(): boolean {
    return this.#windowOpen;
  }

  get challengeKind(): CardChallengeKind | null {
    return this.#challengeKind;
  }

  // -------------------------------------------------------------------------
  // Dealing
  // -------------------------------------------------------------------------

  /**
   * Deal every team its starting hand.
   *
   * GAME_RULES_LOCKED.md §2 — one random Disruption, one random Power/Strategy,
   * one random Recovery/Social. Exactly three cards, one from each pool.
   *
   * MACO IS IN THE DISRUPTION POOL and may be dealt. Phase 6 spec §6: "it may
   * exist in starting hands... Do NOT remove Maco! from the starting hand unless
   * the owner explicitly changes the rule." A team that draws it holds a card
   * with no legal challenge — a consequence of OPEN_RULES.md §7 being open, not
   * a bug. `playabilityOf` reports it as `compatibility_unresolved`.
   *
   * Dealing twice is refused: it would either double a hand or silently replace
   * one a team has already seen.
   */
  deal(teamIds: readonly TeamId[]): Result<Readonly<Record<string, readonly BacchanalCardInstance[]>>> {
    if (this.#dealt) {
      return err(rejection('WRONG_STATE', 'Bacchanal cards have already been dealt.'));
    }
    if (teamIds.length === 0) {
      return err(rejection('ILLEGAL_ACTION', 'No teams to deal to.'));
    }

    const dealtAt = asServerTimestamp(this.#clock.now());
    const result: Record<string, readonly BacchanalCardInstance[]> = {};

    for (const teamId of teamIds) {
      const cards = new Map<string, BacchanalCardInstance>();

      for (const pool of STARTING_HAND_POOLS) {
        const cardType = pickOne(this.#rng, pool);
        // A pool is a non-empty compile-time constant, so this cannot happen —
        // but pickOne's contract allows null and silently skipping would deal a
        // short hand, which is worse than refusing.
        if (cardType === null) {
          return err(rejection('INTERNAL_ERROR', 'Card pool was empty.'));
        }

        const instance: BacchanalCardInstance = {
          cardInstanceId: this.#mintId(),
          cardType,
          category: categoryOf(cardType),
          owningTeamId: teamId,
          status: 'HELD',
          dealtAt,
          usedAt: null,
          challengeId: null,
        };
        cards.set(instance.cardInstanceId, instance);
      }

      this.#teams.set(teamId, { cards });
      result[teamId] = [...cards.values()];
    }

    this.#dealt = true;
    return ok(result);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Every card a team holds, in any status. */
  handOf(teamId: TeamId): readonly BacchanalCardInstance[] {
    const team = this.#teams.get(teamId);
    return team === undefined ? [] : [...team.cards.values()];
  }

  /** Every team's hand. HOST VIEW ONLY — never build a player payload from this. */
  allHands(): Readonly<Record<string, readonly BacchanalCardInstance[]>> {
    const out: Record<string, readonly BacchanalCardInstance[]> = {};
    for (const [teamId, team] of this.#teams) {
      out[teamId] = [...team.cards.values()];
    }
    return out;
  }

  card(cardInstanceId: string): BacchanalCardInstance | undefined {
    for (const team of this.#teams.values()) {
      const found = team.cards.get(cardInstanceId);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /**
   * A team's hand as its OWN members may see it, with playability decided by
   * the server.
   *
   * Phase 6 spec §45 wants the test UI to show eligible/disabled state; §7
   * insists the server still rejects an illegal play. Both are satisfied by
   * computing playability here and enforcing the same rules in `validatePlay`.
   */
  ownHandView(teamId: TeamId, paused: boolean): readonly OwnCardView[] {
    return this.handOf(teamId).map((card) => {
      const reason = this.#unplayableReason(card, paused);
      return { ...card, playable: reason === null, unplayableReason: reason };
    });
  }

  /**
   * What other teams may know about a team's hand.
   *
   * COUNTS ONLY. Phase 6 spec §42 — opponent unrevealed Bacchanal cards must
   * not reach a player client. `OpponentHandView` has no field for a card type,
   * so this cannot leak one even by mistake.
   */
  opponentHandViews(exceptTeamId: TeamId): readonly OpponentHandView[] {
    const views: OpponentHandView[] = [];
    for (const [teamId, team] of this.#teams) {
      if (teamId === exceptTeamId) continue;
      const held = [...team.cards.values()].filter((card) => card.status !== 'CONSUMED');
      views.push({
        teamId: teamId as TeamId,
        cardCount: held.length,
        playedThisChallenge: this.#challengeState.teamsWhoPlayed.has(teamId),
      });
    }
    return views;
  }

  windowView(): CardWindowView {
    return {
      open: this.#windowOpen,
      challengeKind: this.#challengeKind,
      teamsWhoPlayed: [...this.#challengeState.teamsWhoPlayed] as TeamId[],
      barredCardInstanceIds: [...this.#challengeState.barredCardInstanceIds],
    };
  }

  // -------------------------------------------------------------------------
  // The card-play window
  // -------------------------------------------------------------------------

  /**
   * Open the window for a challenge.
   *
   * `challengeKind` maps this challenge onto a row of the locked compatibility
   * table (GAME_RULES_LOCKED.md §6). The engine learns nothing about what the
   * round contains — only which row of an approved table applies, which is a
   * fact the locked rules already state.
   *
   * A NEW CHALLENGE STARTS CLEAN. The per-challenge bans reset, because
   * "one card per question/challenge" (§2) is scoped to the challenge, and a
   * stale ban would silently stop a team playing in the next one.
   */
  openWindow(challengeId: ChallengeId, kind: CardChallengeKind): Result<CardWindowView> {
    if (!this.#dealt) {
      return err(rejection('WRONG_STATE', 'Deal the Bacchanal cards first.'));
    }

    // A different challenge resets the per-challenge state; reopening the SAME
    // challenge preserves it, so a Host who closes and reopens a window cannot
    // hand a team a second card play.
    if (this.#challengeId !== challengeId) {
      this.#challengeState = { teamsWhoPlayed: new Set(), barredCardInstanceIds: new Set() };
      this.#challengeId = challengeId;
    }

    this.#windowOpen = true;
    this.#challengeKind = kind;
    return ok(this.windowView());
  }

  /** Close the window. Played cards and bans survive; only new plays stop. */
  closeWindow(): CardWindowView {
    this.#windowOpen = false;
    return this.windowView();
  }

  /**
   * Forget everything scoped to a challenge.
   *
   * Called when a challenge resolves. The hand persists — cards are a
   * game-long resource — but the per-challenge bans and the window do not.
   */
  endChallenge(): void {
    this.#windowOpen = false;
    this.#challengeKind = null;
    this.#challengeId = null;
    this.#challengeState = { teamsWhoPlayed: new Set(), barredCardInstanceIds: new Set() };
  }

  // -------------------------------------------------------------------------
  // Playability
  // -------------------------------------------------------------------------

  /**
   * Why a card cannot be played right now, or null if it can.
   *
   * The single implementation of the locked legality rules. `validatePlay` calls
   * it, and so does the view a phone renders, so a disabled button and a server
   * rejection can never disagree.
   */
  #unplayableReason(card: BacchanalCardInstance, paused: boolean): CardUnplayableReason | null {
    if (paused) return 'paused';
    if (card.status !== 'HELD') return 'not_held';

    // OPEN_RULES.md §7. Reported before the eligibility check so the message is
    // "not decided yet" rather than "wrong challenge" — the latter would imply
    // a right challenge exists somewhere, and none does.
    if (!cardHasAnyLegalChallenge(card.cardType)) return 'compatibility_unresolved';

    if (!this.#windowOpen || this.#challengeKind === null) return 'no_challenge';

    // GAME_RULES_LOCKED.md §2 — "A team may play a maximum of one Bacchanal Card
    // per question/challenge." Checked before eligibility so a team that has
    // already played sees the real reason.
    if (this.#challengeState.teamsWhoPlayed.has(card.owningTeamId)) {
      return 'already_played_this_challenge';
    }

    // §5 — a card that lost a Clash "cannot be played again in that challenge".
    if (this.#challengeState.barredCardInstanceIds.has(card.cardInstanceId)) {
      return 'lost_clash_this_challenge';
    }

    if (!isCardEligible(card.cardType, this.#challengeKind)) return 'not_eligible';

    return null;
  }

  /** Public playability check, for callers that hold a card id. */
  playabilityOf(cardInstanceId: string, paused: boolean): CardUnplayableReason | null | 'unknown' {
    const card = this.card(cardInstanceId);
    if (card === undefined) return 'unknown';
    return this.#unplayableReason(card, paused);
  }

  // -------------------------------------------------------------------------
  // Playing a card
  // -------------------------------------------------------------------------

  /**
   * Validate and commit a card play.
   *
   * Phase 6 spec §7 lists what the server must check, and every item is here:
   * correct team, card owned, still held, challenge exists, eligible, timing
   * window valid, team has not already played, target valid where required,
   * session not paused. Actor authority is the room's, checked before this is
   * reached — the same split as every Phase 5 intent.
   *
   * The card becomes PENDING, not CONSUMED. GAME_RULES_LOCKED.md §5 gives
   * opponents a 3-second window to counter, and a card that loses returns to
   * hand — so consumption waits for the Clash to resolve.
   */
  play(input: {
    readonly teamId: TeamId;
    readonly cardInstanceId: string;
    readonly targetTeamId?: TeamId | null;
    readonly paused: boolean;
  }): Result<BacchanalCardInstance> {
    const card = this.card(input.cardInstanceId);
    if (card === undefined) {
      return err(rejection('NOT_FOUND', 'No such card.', { cardInstanceId: input.cardInstanceId }));
    }

    // Ownership before everything else: a team asking about someone else's card
    // should not learn its status from the rejection it gets back.
    if (card.owningTeamId !== input.teamId) {
      return err(rejection('UNAUTHORIZED_ACTOR', 'That card belongs to another team.'));
    }

    const reason = this.#unplayableReason(card, input.paused);
    if (reason !== null) {
      return err(cardRejection(reason, card.cardType));
    }

    // Target validation. GAME_RULES_LOCKED.md §3 — Gimme Dat, Doh Know, Allyuh
    // Help Me and Steups all act on "another team", so a target is required and
    // must not be the player's own.
    if (cardRequiresTarget(card.cardType)) {
      const target = input.targetTeamId ?? null;
      if (target === null) {
        return err(
          rejection('INVALID_REQUEST', 'This card needs a target team.', {
            cardType: card.cardType,
          }),
        );
      }
      if (target === input.teamId) {
        return err(rejection('ILLEGAL_ACTION', 'This card must target another team.'));
      }
      if (!this.#teams.has(target)) {
        return err(rejection('NOT_FOUND', 'Unknown target team.', { teamId: target }));
      }
    }

    const committed: BacchanalCardInstance = {
      ...card,
      status: 'PENDING',
      challengeId: this.#challengeId,
    };
    this.#setCard(committed);

    // The team is barred from playing again the moment the card is committed —
    // not when it resolves. GAME_RULES_LOCKED.md §5 keeps the bar in place even
    // when the card comes back from a lost Clash, and Phase 6 spec §8 says so
    // explicitly: "the first card loses a Clash and returns" does not restore
    // the team's play.
    this.#challengeState.teamsWhoPlayed.add(input.teamId);

    return ok(committed);
  }

  /**
   * Move a card to RESOLVING — it survived the Clash and its effect applies.
   */
  markResolving(cardInstanceId: string): void {
    const card = this.card(cardInstanceId);
    if (card === undefined) return;
    this.#setCard({ ...card, status: 'RESOLVING' });
  }

  /**
   * Consume a card. GAME_RULES_LOCKED.md §5 — "Winning card resolves and is
   * consumed."
   */
  consume(cardInstanceId: string): void {
    const card = this.card(cardInstanceId);
    if (card === undefined) return;
    this.#setCard({
      ...card,
      status: 'CONSUMED',
      usedAt: asServerTimestamp(this.#clock.now()),
    });
  }

  /**
   * Return a card to its owner's hand after losing a Clash or a Part Dat Fight.
   *
   * GAME_RULES_LOCKED.md §5 — "Losing card returns but cannot be played again in
   * that challenge." Both halves happen here: the status goes back to HELD, and
   * the instance is barred for this challenge. The TEAM-level bar set in `play`
   * is untouched and still stands.
   */
  returnToHand(cardInstanceId: string): void {
    const card = this.card(cardInstanceId);
    if (card === undefined) return;
    this.#setCard({ ...card, status: 'HELD', challengeId: null });
    this.#challengeState.barredCardInstanceIds.add(cardInstanceId);
  }

  /**
   * Transfer a card between teams. Maco Mail's Card Confiscation.
   *
   * GAME_RULES_LOCKED.md §8 — "randomly take one unused opponent Bacchanal
   * card". The randomness and the choice of victim are the caller's; this only
   * performs the move once a legal card has been chosen.
   */
  transfer(cardInstanceId: string, toTeamId: TeamId): Result<BacchanalCardInstance> {
    const card = this.card(cardInstanceId);
    if (card === undefined) {
      return err(rejection('NOT_FOUND', 'No such card.'));
    }
    if (card.status === 'CONSUMED') {
      return err(rejection('ILLEGAL_ACTION', 'That card is already spent.'));
    }
    if (!this.#teams.has(toTeamId)) {
      return err(rejection('NOT_FOUND', 'Unknown receiving team.', { teamId: toTeamId }));
    }

    const from = this.#teams.get(card.owningTeamId);
    from?.cards.delete(cardInstanceId);

    const moved: BacchanalCardInstance = { ...card, owningTeamId: toTeamId, status: 'HELD' };
    this.#teams.get(toTeamId)?.cards.set(cardInstanceId, moved);
    return ok(moved);
  }

  /**
   * Cards a team holds that could legally be confiscated.
   *
   * GAME_RULES_LOCKED.md §8 / Phase 6 spec §32 — "Only legal unused cards may be
   * selected." An unused card is one still HELD; a card committed to a live
   * Clash or already spent is not available to take.
   */
  confiscatableCards(teamId: TeamId): readonly BacchanalCardInstance[] {
    return this.handOf(teamId).filter((card) => card.status === 'HELD');
  }

  #setCard(card: BacchanalCardInstance): void {
    this.#teams.get(card.owningTeamId)?.cards.set(card.cardInstanceId, card);
  }

  /** Register a team with an empty hand. For a team that joins the model late. */
  ensureTeam(teamId: TeamId): void {
    if (!this.#teams.has(teamId)) {
      this.#teams.set(teamId, { cards: new Map() });
    }
  }

  /** Teams that hold at least one card in the given status. */
  teamsWithStatus(status: CardStatus): readonly TeamId[] {
    const out: TeamId[] = [];
    for (const [teamId, team] of this.#teams) {
      if ([...team.cards.values()].some((card) => card.status === status)) {
        out.push(teamId as TeamId);
      }
    }
    return out;
  }

  /**
   * Cards a team could legally play into the CURRENT window.
   *
   * Used by the Clash to decide who may counter — GAME_RULES_LOCKED.md §5,
   * "responding teams secretly choose one eligible card", and Phase 6 spec §9,
   * "illegal counter must not be selectable".
   */
  eligibleCardsFor(teamId: TeamId, paused: boolean): readonly BacchanalCardInstance[] {
    return this.handOf(teamId).filter((card) => this.#unplayableReason(card, paused) === null);
  }
}

/**
 * Turn an unplayable reason into a structured rejection.
 *
 * The codes come from the existing generic set (PROTOCOL.md deliberately has no
 * game-specific codes); the reason travels in `details` so a UI can react
 * without parsing prose.
 */
function cardRejection(reason: CardUnplayableReason, cardType: BacchanalCardType) {
  const messages: Readonly<Record<CardUnplayableReason, string>> = {
    no_challenge: 'No challenge is accepting Bacchanal cards right now.',
    not_eligible: 'That card cannot be used in this challenge.',
    compatibility_unresolved:
      'This card has no approved challenge yet. Its rule is still being decided.',
    already_played_this_challenge: 'Your team has already played a Bacchanal card here.',
    lost_clash_this_challenge: 'That card already lost a Clash in this challenge.',
    not_held: 'That card is not available to play.',
    window_closed: 'The window for playing a card has closed.',
    paused: 'The game is paused.',
  };

  const code =
    reason === 'no_challenge' || reason === 'window_closed' || reason === 'paused'
      ? 'WRONG_STATE'
      : 'ILLEGAL_ACTION';

  return rejection(code, messages[reason], { reason, cardType });
}
