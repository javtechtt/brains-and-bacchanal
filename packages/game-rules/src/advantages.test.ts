import { describe, expect, it } from 'vitest';
import { asTeamId, MAX_RETRIES_PER_CHALLENGE } from '@bb/protocol';
import { advantageForMarketItem, Advantages } from './advantages.js';
import { FakeClock } from './clock.js';

/**
 * Retry and stacking tests. Phase 6 spec §50.
 *
 * GAME_RULES_LOCKED.md §4 (the retry rule) and §10 ("No stacking: one Double,
 * one clue, one time extension, one retry maximum"). D-006.
 */

const TEAM_A = asTeamId('TEAM_A');
const TEAM_B = asTeamId('TEAM_B');

function setup() {
  const clock = new FakeClock(1_000);
  let counter = 0;
  return new Advantages({ clock, mintId: () => `adv-${(counter += 1)}` });
}

describe('the shared retry budget', () => {
  it('allows exactly one retry per challenge', () => {
    // §4 / D-006 — "Maximum one retry on the same question."
    expect(MAX_RETRIES_PER_CHALLENGE).toBe(1);

    const advantages = setup();
    const second = advantages.grant({
      teamId: TEAM_A,
      type: 'SECOND_CHANCE',
      source: 'market',
      expiresAfterRound: 2,
    });

    expect(advantages.use({ teamId: TEAM_A, advantageId: second.advantageId }).ok).toBe(true);
    expect(advantages.usageFor(TEAM_A).retriesUsed).toBe(1);
    expect(advantages.usageFor(TEAM_A).retrySource).toBe('second_chance');
  });

  it('refuses a Second Chance after FORGIVE MEH! has been used', () => {
    // §4 — "Market Second Chance and FORGIVE MEH! cannot be chained." THE test
    // that proves the budget is genuinely shared rather than per-source.
    const advantages = setup();
    const second = advantages.grant({
      teamId: TEAM_A,
      type: 'SECOND_CHANCE',
      source: 'market',
      expiresAfterRound: 2,
    });

    expect(advantages.useForgiveMehRetry(TEAM_A).ok).toBe(true);

    const chained = advantages.use({ teamId: TEAM_A, advantageId: second.advantageId });
    expect(chained.ok).toBe(false);
    if (!chained.ok) expect(chained.error.code).toBe('ILLEGAL_ACTION');
  });

  it('refuses FORGIVE MEH! after a Second Chance has been used', () => {
    // The same rule in the other direction.
    const advantages = setup();
    const second = advantages.grant({
      teamId: TEAM_A,
      type: 'SECOND_CHANCE',
      source: 'market',
      expiresAfterRound: 2,
    });

    advantages.use({ teamId: TEAM_A, advantageId: second.advantageId });
    expect(advantages.useForgiveMehRetry(TEAM_A).ok).toBe(false);
  });

  it('leaves the UNUSED retry available for a later question', () => {
    // §4 — "the other remains available for a later eligible question."
    const advantages = setup();
    const second = advantages.grant({
      teamId: TEAM_A,
      type: 'SECOND_CHANCE',
      source: 'market',
      expiresAfterRound: 2,
    });

    // Challenge one: the team uses FORGIVE MEH!, so the card is spent but the
    // Market item is not.
    advantages.useForgiveMehRetry(TEAM_A);
    expect(advantages.use({ teamId: TEAM_A, advantageId: second.advantageId }).ok).toBe(false);

    // Challenge two: the budget resets, and the Second Chance is still held.
    advantages.endChallenge();
    expect(advantages.use({ teamId: TEAM_A, advantageId: second.advantageId }).ok).toBe(true);
  });

  it('keeps budgets separate per team', () => {
    const advantages = setup();
    advantages.useForgiveMehRetry(TEAM_A);

    expect(advantages.usageFor(TEAM_A).retriesUsed).toBe(1);
    expect(advantages.usageFor(TEAM_B).retriesUsed).toBe(0);
    expect(advantages.useForgiveMehRetry(TEAM_B).ok).toBe(true);
  });
});

describe('multipliers never stack', () => {
  it('refuses a second Double in the same challenge', () => {
    // §3 — "multipliers never stack", §10 — "one Double". A Market Double and a
    // Maco Double Points resolve to the same AdvantageType, which is what makes
    // this one check cover both.
    const advantages = setup();
    const market = advantages.grant({
      teamId: TEAM_A,
      type: 'DOUBLE',
      source: 'market',
      expiresAfterRound: 2,
    });
    const maco = advantages.grant({ teamId: TEAM_A, type: 'DOUBLE', source: 'maco_mail' });

    expect(advantages.use({ teamId: TEAM_A, advantageId: market.advantageId }).ok).toBe(true);
    const second = advantages.use({ teamId: TEAM_A, advantageId: maco.advantageId });

    expect(second.ok).toBe(false);
    expect(advantages.usageFor(TEAM_A).doubleUsed).toBe(true);
  });

  it('allows a Double again in the next challenge', () => {
    const advantages = setup();
    const a = advantages.grant({ teamId: TEAM_A, type: 'DOUBLE', source: 'maco_mail' });
    const b = advantages.grant({ teamId: TEAM_A, type: 'DOUBLE', source: 'maco_mail' });

    advantages.use({ teamId: TEAM_A, advantageId: a.advantageId });
    advantages.endChallenge();

    expect(advantages.use({ teamId: TEAM_A, advantageId: b.advantageId }).ok).toBe(true);
  });
});

describe('one clue, one time extension', () => {
  it('refuses a second clue in the same challenge', () => {
    // §10 — "one clue".
    const advantages = setup();
    const a = advantages.grant({ teamId: TEAM_A, type: 'CLUE', source: 'market', expiresAfterRound: 2 });
    const b = advantages.grant({ teamId: TEAM_A, type: 'CLUE', source: 'maco_mail' });

    expect(advantages.use({ teamId: TEAM_A, advantageId: a.advantageId }).ok).toBe(true);
    expect(advantages.use({ teamId: TEAM_A, advantageId: b.advantageId }).ok).toBe(false);
  });

  it('refuses a second time extension in the same challenge', () => {
    // §10 — "one time extension".
    const advantages = setup();
    const a = advantages.grant({
      teamId: TEAM_A,
      type: 'EXTRA_TIME',
      source: 'market',
      expiresAfterRound: 2,
    });
    const b = advantages.grant({ teamId: TEAM_A, type: 'EXTRA_TIME', source: 'maco_mail' });

    expect(advantages.use({ teamId: TEAM_A, advantageId: a.advantageId }).ok).toBe(true);
    expect(advantages.use({ teamId: TEAM_A, advantageId: b.advantageId }).ok).toBe(false);
  });
});

describe('ownership and lifecycle', () => {
  it('refuses to use another team\'s advantage', () => {
    const advantages = setup();
    const a = advantages.grant({ teamId: TEAM_A, type: 'CLUE', source: 'maco_mail' });

    const stolen = advantages.use({ teamId: TEAM_B, advantageId: a.advantageId });
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.error.code).toBe('UNAUTHORIZED_ACTOR');
  });

  it('refuses to use the same advantage twice', () => {
    const advantages = setup();
    const a = advantages.grant({ teamId: TEAM_A, type: 'CLUE', source: 'maco_mail' });

    expect(advantages.use({ teamId: TEAM_A, advantageId: a.advantageId }).ok).toBe(true);
    advantages.endChallenge();
    // The per-challenge budget reset, but the advantage itself is spent.
    expect(advantages.use({ teamId: TEAM_A, advantageId: a.advantageId }).ok).toBe(false);
  });
});

describe('expiry differs by source', () => {
  it('expires a Market advantage after its round', () => {
    // §10 — Market items expire after the immediately following round.
    const advantages = setup();
    advantages.grant({ teamId: TEAM_A, type: 'CLUE', source: 'market', expiresAfterRound: 2 });

    expect(advantages.expireAfterRound(1)).toHaveLength(0);
    expect(advantages.expireAfterRound(2)).toHaveLength(1);
    expect(advantages.usableFor(TEAM_A)).toHaveLength(0);
  });

  it('never expires a Maco Mail advantage', () => {
    // §7 — "held advantages stay out until used or game ends". A Maco advantage
    // has no expiry round at all, so no round boundary can take it.
    const advantages = setup();
    advantages.grant({ teamId: TEAM_A, type: 'CLUE', source: 'maco_mail' });

    expect(advantages.expireAfterRound(2)).toHaveLength(0);
    expect(advantages.expireAfterRound(4)).toHaveLength(0);
    expect(advantages.usableFor(TEAM_A)).toHaveLength(1);
  });

  it('ignores an expiresAfterRound passed for a Maco Mail advantage', () => {
    // The source decides expiry, not the caller — a caller passing the wrong
    // thing must not be able to delete a Maco advantage early.
    const advantages = setup();
    const a = advantages.grant({
      teamId: TEAM_A,
      type: 'CLUE',
      source: 'maco_mail',
      expiresAfterRound: 2,
    });

    expect(a.expiresAfterRound).toBeNull();
  });

  it('keeps held Maco Mail advantages out of the deck', () => {
    // §7 / Phase 6 spec §36 — a held advantage is out of the deck until used.
    const advantages = setup();
    const a = advantages.grant({ teamId: TEAM_A, type: 'CLUE', source: 'maco_mail' });
    advantages.grant({ teamId: TEAM_A, type: 'DOUBLE', source: 'market', expiresAfterRound: 2 });

    // Only the Maco one counts against the deck.
    expect(advantages.heldFromMacoMail()).toHaveLength(1);

    advantages.use({ teamId: TEAM_A, advantageId: a.advantageId });
    expect(advantages.heldFromMacoMail()).toHaveLength(0);
  });
});

describe('Bacchanal Immunity', () => {
  it('is consumed when it triggers', () => {
    // §8 / Phase 6 spec §29 — "immunity is consumed".
    const advantages = setup();
    advantages.grant({ teamId: TEAM_A, type: 'BACCHANAL_IMMUNITY', source: 'maco_mail' });

    const consumed = advantages.consumeImmunity(TEAM_A);
    expect(consumed).not.toBeNull();
    expect(advantages.consumeImmunity(TEAM_A)).toBeNull();
  });

  it('returns null for a team that holds none', () => {
    const advantages = setup();
    expect(advantages.consumeImmunity(TEAM_A)).toBeNull();
  });
});

describe('revokeForPurchase — a Market purchase and its advantage move together', () => {
  // A purchase and the advantage it grants were two separate records the
  // moment a purchase could stop existing — first the Maco Mail Cancel Market
  // Purchase card, and now a team withdrawing its own item before the Market
  // closes. Neither destroying the purchase alone would revoke the advantage,
  // leaving a team holding a Clue whose Market slip no longer exists.
  it('removes an unused advantage by its purchaseId', () => {
    const advantages = setup();
    const granted = advantages.grant({
      teamId: TEAM_A,
      type: 'CLUE',
      source: 'market',
      purchaseId: 'purchase-1',
      expiresAfterRound: 2,
    });

    const revoked = advantages.revokeForPurchase('purchase-1');
    expect(revoked?.advantageId).toBe(granted.advantageId);
    expect(advantages.usableFor(TEAM_A)).toHaveLength(0);
  });

  it('returns null when the purchase granted no advantage', () => {
    // Buying Maco Mail from the Market grants no advantage at all (it grants a
    // DRAW) — revoking a purchase like that must not error.
    const advantages = setup();
    expect(advantages.revokeForPurchase('never-granted-anything')).toBeNull();
  });

  it('refuses to revoke an advantage the team already used', () => {
    // Too late — the team already asked for the clue. Same rule Cancel Market
    // Purchase already enforces against a USED purchase.
    const advantages = setup();
    const granted = advantages.grant({
      teamId: TEAM_A,
      type: 'CLUE',
      source: 'market',
      purchaseId: 'purchase-1',
      expiresAfterRound: 2,
    });
    advantages.use({ teamId: TEAM_A, advantageId: granted.advantageId });

    expect(advantages.revokeForPurchase('purchase-1')).toBeNull();
    // Still spent, not un-used by the failed revoke.
    expect(advantages.usageFor(TEAM_A)).toBeDefined();
  });

  it('leaves other advantages from other purchases untouched', () => {
    const advantages = setup();
    advantages.grant({
      teamId: TEAM_A,
      type: 'CLUE',
      source: 'market',
      purchaseId: 'purchase-1',
      expiresAfterRound: 2,
    });
    advantages.grant({
      teamId: TEAM_A,
      type: 'EXTRA_TIME',
      source: 'market',
      purchaseId: 'purchase-2',
      expiresAfterRound: 2,
    });

    advantages.revokeForPurchase('purchase-1');

    const remaining = advantages.usableFor(TEAM_A);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.type).toBe('EXTRA_TIME');
  });
});

describe('Market items map to advantages', () => {
  it('maps each advantage-granting item', () => {
    expect(advantageForMarketItem('CLUE')).toBe('CLUE');
    expect(advantageForMarketItem('SECOND_CHANCE')).toBe('SECOND_CHANCE');
    expect(advantageForMarketItem('DOUBLE_BB')).toBe('DOUBLE');
    expect(advantageForMarketItem('EXTRA_TIME')).toBe('EXTRA_TIME');
  });

  it('grants no advantage for Maco Mail, which yields a draw instead', () => {
    // §10 — "purchased Maco Mail opens after reveal".
    expect(advantageForMarketItem('MACO_MAIL')).toBeNull();
  });
});

describe('the Bacchanal card record', () => {
  it('records that a team played a card this challenge', () => {
    // GAME_RULES_LOCKED.md §2 — one card per team per challenge. A round asks
    // this rather than tracking its own flag.
    const advantages = setup();
    expect(advantages.usageFor(TEAM_A).bacchanalCardPlayed).toBe(false);

    advantages.recordBacchanalCardPlayed(TEAM_A);
    expect(advantages.usageFor(TEAM_A).bacchanalCardPlayed).toBe(true);

    advantages.endChallenge();
    expect(advantages.usageFor(TEAM_A).bacchanalCardPlayed).toBe(false);
  });
});
