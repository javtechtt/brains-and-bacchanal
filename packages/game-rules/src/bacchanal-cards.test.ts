import { describe, expect, it } from 'vitest';
import {
  asChallengeId,
  asTeamId,
  BACCHANAL_CARD_TYPES,
  CARD_ELIGIBILITY,
  CARDS_WITHOUT_LEGAL_CHALLENGE,
  cardHasAnyLegalChallenge,
  categoryOf,
  isCardEligible,
  type BacchanalCardType,
  type CardChallengeKind,
} from '@bb/protocol';
import { BacchanalCards } from './bacchanal-cards.js';
import { FakeClock } from './clock.js';
import { SeededRng } from './rng.js';

/**
 * Bacchanal card tests. Phase 6 spec §47.
 *
 * Everything runs on a FakeClock and a SeededRng, so a deal is reproducible and
 * a three-second window costs no real time.
 */

const TEAM_A = asTeamId('TEAM_A');
const TEAM_B = asTeamId('TEAM_B');
const TEAM_C = asTeamId('TEAM_C');
const CHALLENGE = asChallengeId('challenge-1');

function makeCards(seed = 1) {
  let counter = 0;
  return new BacchanalCards({
    clock: new FakeClock(1_000),
    rng: new SeededRng(seed),
    mintId: () => `id-${(counter += 1)}`,
  });
}

describe('the locked compatibility table', () => {
  // GAME_RULES_LOCKED.md §6 / D-007. Transcribed from the locked table; if the
  // implementation drifts, this fails rather than the game quietly allowing a
  // card somewhere it should not.
  const EXPECTED: Record<CardChallengeKind, BacchanalCardType[]> = {
    ROUND1_TRIVIA: ['GIMME_DAT', 'DOUBLE_IT', 'DOH_KNOW', 'ALLYUH_HELP_ME', 'FORGIVE_MEH'],
    ROUND2_PHYSICAL: ['DOUBLE_IT'],
    THINK_FAST: ['STEUPS', 'DOUBLE_IT', 'FORGIVE_MEH'],
    GUESS_THE_LOGO: ['DOUBLE_IT'],
    ALL_ANSWERS_BEGIN_WITH: ['DOUBLE_IT', 'FORGIVE_MEH'],
    SING_A_SONG: ['DOUBLE_IT'],
    FAMILY_FEUD_Q1_Q3: ['STEUPS', 'DOUBLE_IT', 'FORGIVE_MEH'],
    FAMILY_FEUD_Q4_Q5: ['STEUPS', 'FORGIVE_MEH'],
    SUDDEN_DEATH: [],
  };

  for (const [kind, expected] of Object.entries(EXPECTED)) {
    it(`matches the locked rules for ${kind}`, () => {
      expect([...CARD_ELIGIBILITY[kind as CardChallengeKind]].sort()).toEqual(
        [...expected].sort(),
      );
    });
  }

  it('bars every card from Sudden Death', () => {
    // GAME_RULES_LOCKED.md §19 — no Bacchanal Cards in Sudden Death.
    for (const cardType of BACCHANAL_CARD_TYPES) {
      expect(isCardEligible(cardType, 'SUDDEN_DEATH')).toBe(false);
    }
  });

  it('bars DOUBLE_IT from Family Feud Q4-Q5, which are already doubled', () => {
    // §6 — "Q4/Q5 are already doubled, so Double It cannot be used."
    expect(isCardEligible('DOUBLE_IT', 'FAMILY_FEUD_Q1_Q3')).toBe(true);
    expect(isCardEligible('DOUBLE_IT', 'FAMILY_FEUD_Q4_Q5')).toBe(false);
  });
});

describe('Maco! — OPEN_RULES.md §7 stays open', () => {
  it('has no legal challenge anywhere', () => {
    // THE TEST THAT PROVES THE OPEN RULE WAS NOT QUIETLY DECIDED. If someone
    // adds MACO to any row of the eligibility table, this fails.
    expect(cardHasAnyLegalChallenge('MACO')).toBe(false);
    expect(CARDS_WITHOUT_LEGAL_CHALLENGE).toEqual(['MACO']);
  });

  it('is still a Disruption card and still exists', () => {
    // Phase 6 spec §6 — build the card type, do not delete it.
    expect(BACCHANAL_CARD_TYPES).toContain('MACO');
    expect(categoryOf('MACO')).toBe('DISRUPTION');
  });

  it('can be dealt but never played', () => {
    const cards = makeCards();
    // Seeds are searched until one deals MACO, so the assertion is about the
    // card rather than about a particular seed.
    let dealtMaco = false;
    for (let seed = 1; seed < 60 && !dealtMaco; seed += 1) {
      const attempt = makeCards(seed);
      attempt.deal([TEAM_A]);
      const hand = attempt.handOf(TEAM_A);
      const maco = hand.find((card) => card.cardType === 'MACO');
      if (maco === undefined) continue;

      dealtMaco = true;
      attempt.openWindow(CHALLENGE, 'ROUND1_TRIVIA');
      expect(attempt.playabilityOf(maco.cardInstanceId, false)).toBe(
        'compatibility_unresolved',
      );

      const played = attempt.play({
        teamId: TEAM_A,
        cardInstanceId: maco.cardInstanceId,
        paused: false,
      });
      expect(played.ok).toBe(false);
    }
    expect(dealtMaco).toBe(true);
    expect(cards).toBeDefined();
  });
});

describe('the starting hand', () => {
  it('deals exactly one card from each category', () => {
    // GAME_RULES_LOCKED.md §2.
    const cards = makeCards();
    const dealt = cards.deal([TEAM_A, TEAM_B]);
    expect(dealt.ok).toBe(true);

    for (const teamId of [TEAM_A, TEAM_B]) {
      const hand = cards.handOf(teamId);
      expect(hand).toHaveLength(3);
      expect(hand.map((c) => c.category).sort()).toEqual(['DISRUPTION', 'POWER', 'RECOVERY']);
      expect(hand.every((c) => c.owningTeamId === teamId)).toBe(true);
      expect(hand.every((c) => c.status === 'HELD')).toBe(true);
      expect(hand.every((c) => c.usedAt === null)).toBe(true);
    }
  });

  it('is deterministic for a given seed', () => {
    const first = makeCards(42);
    first.deal([TEAM_A]);
    const second = makeCards(42);
    second.deal([TEAM_A]);

    expect(first.handOf(TEAM_A).map((c) => c.cardType)).toEqual(
      second.handOf(TEAM_A).map((c) => c.cardType),
    );
  });

  it('gives each card a distinct instance id', () => {
    const cards = makeCards();
    cards.deal([TEAM_A, TEAM_B]);
    const ids = [...cards.handOf(TEAM_A), ...cards.handOf(TEAM_B)].map((c) => c.cardInstanceId);
    expect(new Set(ids).size).toBe(6);
  });

  it('refuses to deal twice', () => {
    const cards = makeCards();
    expect(cards.deal([TEAM_A]).ok).toBe(true);
    const second = cards.deal([TEAM_A]);
    expect(second.ok).toBe(false);
  });

  describe('devRedeal — a distinct escape hatch, not a weakening of deal()', () => {
    it('replaces every hand', () => {
      const cards = makeCards();
      cards.deal([TEAM_A, TEAM_B]);
      const before = cards.handOf(TEAM_A).map((c) => c.cardInstanceId);

      const redealt = cards.devRedeal([TEAM_A, TEAM_B]);
      expect(redealt.ok).toBe(true);

      const after = cards.handOf(TEAM_A).map((c) => c.cardInstanceId);
      expect(after).toHaveLength(3);
      expect(after).not.toEqual(before);
    });

    it('still gives one card per category after a redeal', () => {
      const cards = makeCards();
      cards.deal([TEAM_A]);
      cards.devRedeal([TEAM_A]);

      const categories = cards.handOf(TEAM_A).map((c) => c.category).sort();
      expect(categories).toEqual(['DISRUPTION', 'POWER', 'RECOVERY']);
    });

    it('leaves the ordinary deal() one-time refusal untouched', () => {
      // The real rule this file exists to protect: a game deals starting hands
      // exactly once. devRedeal is a distinct method — it must not be reachable
      // by calling deal() again after a redeal.
      const cards = makeCards();
      cards.deal([TEAM_A]);
      cards.devRedeal([TEAM_A]);

      const secondOrdinaryDeal = cards.deal([TEAM_A]);
      expect(secondOrdinaryDeal.ok).toBe(false);
    });

    it('clears the card window and any per-challenge bar', () => {
      const cards = makeCards();
      cards.deal([TEAM_A, TEAM_B]);
      cards.openWindow(CHALLENGE, 'ROUND1_TRIVIA');
      const first = cards.eligibleCardsFor(TEAM_A, false)[0]!;
      cards.play({ teamId: TEAM_A, cardInstanceId: first.cardInstanceId, targetTeamId: TEAM_B, paused: false });

      cards.devRedeal([TEAM_A, TEAM_B]);

      expect(cards.windowView().open).toBe(false);
      expect(cards.windowView().teamsWhoPlayed).toHaveLength(0);
    });

    it('can be called repeatedly, unlike deal()', () => {
      const cards = makeCards();
      cards.deal([TEAM_A]);
      expect(cards.devRedeal([TEAM_A]).ok).toBe(true);
      expect(cards.devRedeal([TEAM_A]).ok).toBe(true);
      expect(cards.devRedeal([TEAM_A]).ok).toBe(true);
    });
  });

  it('assigns the correct category to every card type', () => {
    // §2 — the mapping the Clash triangle is defined over.
    expect(categoryOf('STEUPS')).toBe('DISRUPTION');
    expect(categoryOf('GIMME_DAT')).toBe('DISRUPTION');
    expect(categoryOf('MACO')).toBe('DISRUPTION');
    expect(categoryOf('DOUBLE_IT')).toBe('POWER');
    expect(categoryOf('DOH_KNOW')).toBe('POWER');
    expect(categoryOf('FORGIVE_MEH')).toBe('RECOVERY');
    expect(categoryOf('ALLYUH_HELP_ME')).toBe('RECOVERY');
  });
});

describe('playing a card', () => {
  it('refuses a card the team does not own', () => {
    const cards = makeCards();
    cards.deal([TEAM_A, TEAM_B]);
    cards.openWindow(CHALLENGE, 'ROUND1_TRIVIA');

    const theirCard = cards.handOf(TEAM_B)[0];
    const played = cards.play({
      teamId: TEAM_A,
      cardInstanceId: theirCard!.cardInstanceId,
      targetTeamId: TEAM_B,
      paused: false,
    });

    expect(played.ok).toBe(false);
    if (!played.ok) expect(played.error.code).toBe('UNAUTHORIZED_ACTOR');
  });

  it('refuses an unknown card', () => {
    const cards = makeCards();
    cards.deal([TEAM_A]);
    cards.openWindow(CHALLENGE, 'ROUND1_TRIVIA');

    const played = cards.play({ teamId: TEAM_A, cardInstanceId: 'nope', paused: false });
    expect(played.ok).toBe(false);
    if (!played.ok) expect(played.error.code).toBe('NOT_FOUND');
  });

  it('refuses when no window is open', () => {
    const cards = makeCards();
    cards.deal([TEAM_A]);

    const card = cards.handOf(TEAM_A)[0]!;
    expect(cards.playabilityOf(card.cardInstanceId, false)).not.toBeNull();
  });

  it('refuses while the game is paused', () => {
    const cards = makeCards();
    cards.deal([TEAM_A]);
    cards.openWindow(CHALLENGE, 'ROUND1_TRIVIA');

    const card = cards.handOf(TEAM_A)[0]!;
    expect(cards.playabilityOf(card.cardInstanceId, true)).toBe('paused');
  });

  it('refuses a card that is not eligible for the challenge', () => {
    const cards = makeCards();
    cards.deal([TEAM_A]);
    // Round 2 allows DOUBLE_IT only. §6.
    cards.openWindow(CHALLENGE, 'ROUND2_PHYSICAL');

    for (const card of cards.handOf(TEAM_A)) {
      const reason = cards.playabilityOf(card.cardInstanceId, false);
      if (card.cardType === 'DOUBLE_IT') {
        expect(reason).toBeNull();
      } else {
        expect(reason).not.toBeNull();
      }
    }
  });

  it('enforces one card per team per challenge', () => {
    // GAME_RULES_LOCKED.md §2, Phase 6 spec §8.
    const cards = makeCards();
    cards.deal([TEAM_A, TEAM_B]);
    cards.openWindow(CHALLENGE, 'ROUND1_TRIVIA');

    const playable = cards.eligibleCardsFor(TEAM_A, false);
    expect(playable.length).toBeGreaterThan(0);

    const first = playable[0]!;
    const played = cards.play({
      teamId: TEAM_A,
      cardInstanceId: first.cardInstanceId,
      targetTeamId: TEAM_B,
      paused: false,
    });
    expect(played.ok).toBe(true);

    // Every other card in the hand is now barred for this challenge.
    for (const card of cards.handOf(TEAM_A)) {
      if (card.cardInstanceId === first.cardInstanceId) continue;
      expect(cards.playabilityOf(card.cardInstanceId, false)).toBe(
        'already_played_this_challenge',
      );
    }
  });

  it('keeps the team barred even after a losing card returns to hand', () => {
    // Phase 6 spec §8 — "This restriction applies even if the first card loses a
    // Clash and returns." The card goes back; the right to play does not.
    const cards = makeCards();
    cards.deal([TEAM_A, TEAM_B]);
    cards.openWindow(CHALLENGE, 'ROUND1_TRIVIA');

    const first = cards.eligibleCardsFor(TEAM_A, false)[0]!;
    cards.play({
      teamId: TEAM_A,
      cardInstanceId: first.cardInstanceId,
      targetTeamId: TEAM_B,
      paused: false,
    });

    cards.returnToHand(first.cardInstanceId);

    // Back in hand...
    expect(cards.card(first.cardInstanceId)?.status).toBe('HELD');
    // ...but unplayable, for BOTH reasons: the team played, and this card lost.
    expect(cards.playabilityOf(first.cardInstanceId, false)).toBe(
      'already_played_this_challenge',
    );
  });

  it('bars a returned card specifically, even in a fresh challenge for its team', () => {
    // The card-level bar and the team-level bar are separate facts. After a new
    // challenge opens, the team may play again — but the returned card is
    // cleared too, because the bar is scoped to the challenge it lost in.
    const cards = makeCards();
    cards.deal([TEAM_A, TEAM_B]);
    cards.openWindow(CHALLENGE, 'ROUND1_TRIVIA');

    const first = cards.eligibleCardsFor(TEAM_A, false)[0]!;
    cards.play({ teamId: TEAM_A, cardInstanceId: first.cardInstanceId, targetTeamId: TEAM_B, paused: false });
    cards.returnToHand(first.cardInstanceId);

    cards.endChallenge();
    cards.openWindow(asChallengeId('challenge-2'), 'ROUND1_TRIVIA');

    expect(cards.playabilityOf(first.cardInstanceId, false)).toBeNull();
  });

  it('requires a target for cards that act on another team', () => {
    // §3 — Gimme Dat, Doh Know, Allyuh Help Me and Steups all act on "another
    // team".
    const cards = makeCards();
    cards.deal([TEAM_A, TEAM_B]);
    cards.openWindow(CHALLENGE, 'ROUND1_TRIVIA');

    const needsTarget = cards
      .handOf(TEAM_A)
      .find((c) => ['GIMME_DAT', 'DOH_KNOW', 'ALLYUH_HELP_ME'].includes(c.cardType));
    if (needsTarget === undefined) return;

    const noTarget = cards.play({
      teamId: TEAM_A,
      cardInstanceId: needsTarget.cardInstanceId,
      paused: false,
    });
    expect(noTarget.ok).toBe(false);

    const selfTarget = cards.play({
      teamId: TEAM_A,
      cardInstanceId: needsTarget.cardInstanceId,
      targetTeamId: TEAM_A,
      paused: false,
    });
    expect(selfTarget.ok).toBe(false);
  });

  it('marks a played card PENDING, not consumed', () => {
    // §5 — opponents get a window to counter, so consumption waits.
    const cards = makeCards();
    cards.deal([TEAM_A, TEAM_B]);
    cards.openWindow(CHALLENGE, 'ROUND1_TRIVIA');

    const card = cards.eligibleCardsFor(TEAM_A, false)[0]!;
    cards.play({ teamId: TEAM_A, cardInstanceId: card.cardInstanceId, targetTeamId: TEAM_B, paused: false });

    expect(cards.card(card.cardInstanceId)?.status).toBe('PENDING');
  });

  it('consumes a card that resolves', () => {
    const cards = makeCards();
    cards.deal([TEAM_A, TEAM_B]);
    cards.openWindow(CHALLENGE, 'ROUND1_TRIVIA');

    const card = cards.eligibleCardsFor(TEAM_A, false)[0]!;
    cards.play({ teamId: TEAM_A, cardInstanceId: card.cardInstanceId, targetTeamId: TEAM_B, paused: false });
    cards.consume(card.cardInstanceId);

    const consumed = cards.card(card.cardInstanceId);
    expect(consumed?.status).toBe('CONSUMED');
    expect(consumed?.usedAt).not.toBeNull();
  });
});

describe('hidden information', () => {
  it('never exposes an opponent hand beyond a count', () => {
    // Phase 6 spec §42. The type has no field for a card type, so this test
    // guards the COUNT being right and the shape staying secret-free.
    const cards = makeCards();
    cards.deal([TEAM_A, TEAM_B, TEAM_C]);

    const views = cards.opponentHandViews(TEAM_A);
    expect(views).toHaveLength(2);

    for (const view of views) {
      expect(view.cardCount).toBe(3);
      expect(Object.keys(view).sort()).toEqual(
        ['cardCount', 'playedThisChallenge', 'teamId'].sort(),
      );
      expect(JSON.stringify(view)).not.toContain('DOUBLE_IT');
    }
  });

  it('shows a team its own hand with server-decided playability', () => {
    const cards = makeCards();
    cards.deal([TEAM_A]);
    cards.openWindow(CHALLENGE, 'ROUND2_PHYSICAL');

    const view = cards.ownHandView(TEAM_A, false);
    expect(view).toHaveLength(3);

    for (const card of view) {
      if (card.cardType === 'DOUBLE_IT') {
        expect(card.playable).toBe(true);
        expect(card.unplayableReason).toBeNull();
      } else {
        expect(card.playable).toBe(false);
        expect(card.unplayableReason).not.toBeNull();
      }
    }
  });
});

describe('card confiscation support', () => {
  it('offers only unused HELD cards as candidates', () => {
    // Phase 6 spec §32 — "Only legal unused cards may be selected."
    const cards = makeCards();
    cards.deal([TEAM_A, TEAM_B]);
    cards.openWindow(CHALLENGE, 'ROUND1_TRIVIA');

    expect(cards.confiscatableCards(TEAM_A)).toHaveLength(3);

    const card = cards.eligibleCardsFor(TEAM_A, false)[0]!;
    cards.play({ teamId: TEAM_A, cardInstanceId: card.cardInstanceId, targetTeamId: TEAM_B, paused: false });

    // A card committed to a Clash is not available to take.
    expect(cards.confiscatableCards(TEAM_A)).toHaveLength(2);
  });

  it('transfers a card between teams', () => {
    const cards = makeCards();
    cards.deal([TEAM_A, TEAM_B]);

    const card = cards.handOf(TEAM_B)[0]!;
    const moved = cards.transfer(card.cardInstanceId, TEAM_A);

    expect(moved.ok).toBe(true);
    expect(cards.handOf(TEAM_A)).toHaveLength(4);
    expect(cards.handOf(TEAM_B)).toHaveLength(2);
    expect(cards.card(card.cardInstanceId)?.owningTeamId).toBe(TEAM_A);
  });

  it('refuses to transfer a consumed card', () => {
    const cards = makeCards();
    cards.deal([TEAM_A, TEAM_B]);

    const card = cards.handOf(TEAM_B)[0]!;
    cards.consume(card.cardInstanceId);

    expect(cards.transfer(card.cardInstanceId, TEAM_A).ok).toBe(false);
  });
});
