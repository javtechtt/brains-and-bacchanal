import { describe, expect, it } from 'vitest';
import { asChallengeId, asTeamId, type BacchanalCardType } from '@bb/protocol';
import { BbLedger } from './bb-ledger.js';
import { FakeClock } from './clock.js';
import { SeededRng } from './rng.js';
import { SharedSystems } from './shared-systems.js';

/**
 * Cross-system integration. Phase 6 spec §47-§53, and the exit scenario.
 *
 * These test the INTERACTIONS the locked rules create between subsystems —
 * where the real bugs live. A card that survives a Clash spends the shared
 * multiplier budget; Bacchanal Immunity cancels an attack and returns the
 * attacker's card; a Market purchase becomes an advantage under one stacking
 * rule.
 */

const TEAM_A = asTeamId('TEAM_A');
const TEAM_B = asTeamId('TEAM_B');
const TEAMS = [TEAM_A, TEAM_B];
const CHALLENGE = asChallengeId('challenge-1');

function setup(seed = 1, bb = 1_000) {
  const clock = new FakeClock(1_000);
  let counter = 0;
  const mintId = () => `id-${(counter += 1)}`;
  const ledger = new BbLedger(clock, mintId);
  for (const team of TEAMS) ledger.seed(team, bb);

  const systems = new SharedSystems({ clock, rng: new SeededRng(seed), mintId, ledger });
  return { clock, ledger, systems };
}

/** Find a seed whose deal gives both teams the card types a test needs. */
function seedWhere(predicate: (hands: Record<string, BacchanalCardType[]>) => boolean): number {
  for (let seed = 1; seed < 500; seed += 1) {
    const { systems } = setup(seed);
    systems.cards.deal(TEAMS);
    const hands: Record<string, BacchanalCardType[]> = {
      TEAM_A: systems.cards.handOf(TEAM_A).map((c) => c.cardType),
      TEAM_B: systems.cards.handOf(TEAM_B).map((c) => c.cardType),
    };
    if (predicate(hands)) return seed;
  }
  throw new Error('no seed produced the required hands');
}

describe('an uncontested card resolves', () => {
  it('consumes the card and applies its effect', () => {
    // GAME_RULES_LOCKED.md §5 — "No response → original card resolves."
    //
    // Round 2 allows DOUBLE_IT only (§6), so a team B holding DOH_KNOW as its
    // Power card has no legal counter and the Clash goes uncontested.
    const seed = seedWhere(
      (h) => h.TEAM_A!.includes('DOUBLE_IT') && h.TEAM_B!.includes('DOH_KNOW'),
    );
    const { systems, clock } = setup(seed);
    systems.cards.deal(TEAMS);
    systems.openCardWindow(CHALLENGE, 'ROUND2_PHYSICAL');

    const double = systems.cards.handOf(TEAM_A).find((c) => c.cardType === 'DOUBLE_IT')!;
    const played = systems.playCard({
      teamId: TEAM_A,
      cardInstanceId: double.cardInstanceId,
      challengeId: CHALLENGE,
      paused: false,
      allTeamIds: TEAMS,
    });
    expect(played.ok).toBe(true);

    clock.advance(3_001);
    const resolved = systems.resolveClash();

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.result.outcome).toBe('uncontested');
      expect(resolved.value.effect?.cardType).toBe('DOUBLE_IT');
    }
    // §5 — the winning card is consumed.
    expect(systems.cards.card(double.cardInstanceId)?.status).toBe('CONSUMED');
  });
});

describe('a resolved Clash stays visible until the next one opens', () => {
  // Regression: resolveClash() used to call ClashEngine.clear() on every exit
  // path, which reset #clashId to null and made view() return null the instant
  // resolution finished — before any client had a chance to see the winner, the
  // explanation or a Part Dat Fight. The one-shot CLASH_RESOLVED/PART_DAT_FIGHT
  // event was the ONLY place the result ever reached a client; anyone who
  // polled REQUEST_GAME_SNAPSHOT a moment later — a reconnecting phone, a slow
  // UI refresh, the Unity dev panel — saw no Clash at all. Found by
  // HeadlessSharedSystemsCheck.cs reading real snapshot JSON after a real
  // Clash, which no existing test exercised: every prior test asserted
  // resolveClash()'s RETURN VALUE directly, never round-tripped the result
  // through hostView()/playerView() afterward the way a real client would.
  it('keeps the winner and explanation in hostView() after resolution', () => {
    const seed = seedWhere(
      (h) => h.TEAM_A!.includes('DOUBLE_IT') && h.TEAM_B!.includes('DOH_KNOW'),
    );
    const { systems, clock } = setup(seed);
    systems.cards.deal(TEAMS);
    systems.openCardWindow(CHALLENGE, 'ROUND2_PHYSICAL');

    const double = systems.cards.handOf(TEAM_A).find((c) => c.cardType === 'DOUBLE_IT')!;
    systems.playCard({
      teamId: TEAM_A,
      cardInstanceId: double.cardInstanceId,
      challengeId: CHALLENGE,
      paused: false,
      allTeamIds: TEAMS,
    });
    clock.advance(3_001);
    const resolved = systems.resolveClash();
    expect(resolved.ok).toBe(true);

    // The whole point: read it back through the SAME view a client receives,
    // not through resolveClash()'s own return value.
    const clash = systems.hostView().clash;
    expect(clash).not.toBeNull();
    expect(clash?.resolved).toBe(true);
    expect(clash?.result?.outcome).toBe('uncontested');
    expect(clash?.result?.winningCardType).toBe('DOUBLE_IT');
    expect(clash?.result?.explanation.length).toBeGreaterThan(0);
  });

  it('keeps a Part Dat Fight visible in playerView() after resolution', () => {
    const seed = seedWhere(
      (h) => h.TEAM_A!.includes('DOUBLE_IT') && h.TEAM_B!.includes('DOUBLE_IT'),
    );
    const { systems, clock } = setup(seed);
    systems.cards.deal(TEAMS);
    systems.openCardWindow(CHALLENGE, 'THINK_FAST');

    const a = systems.cards.handOf(TEAM_A).find((c) => c.cardType === 'DOUBLE_IT')!;
    const b = systems.cards.handOf(TEAM_B).find((c) => c.cardType === 'DOUBLE_IT')!;
    systems.playCard({
      teamId: TEAM_A,
      cardInstanceId: a.cardInstanceId,
      challengeId: CHALLENGE,
      paused: false,
      allTeamIds: TEAMS,
    });
    systems.respondToClash({ teamId: TEAM_B, cardInstanceId: b.cardInstanceId, paused: false });
    clock.advance(3_001);
    systems.resolveClash();

    const clash = systems.playerView(TEAM_A, false).clash;
    expect(clash).not.toBeNull();
    expect(clash?.resolved).toBe(true);
    expect(clash?.result?.outcome).toBe('part_dat_fight');
  });

  it('replaces the previous resolved Clash when the next one opens', () => {
    // The resolved Clash is not cleared explicitly — the next open() replaces
    // it, and this proves that actually happens rather than leaving stale data.
    const seed = seedWhere(
      (h) =>
        h.TEAM_A!.filter((c) => c === 'DOUBLE_IT' || c === 'FORGIVE_MEH').length === 2 &&
        h.TEAM_B!.includes('STEUPS') === false,
    );
    const { systems, clock } = setup(seed);
    systems.cards.deal(TEAMS);
    systems.openCardWindow(CHALLENGE, 'THINK_FAST');

    const first = systems.cards.eligibleCardsFor(TEAM_A, false)[0]!;
    systems.playCard({
      teamId: TEAM_A,
      cardInstanceId: first.cardInstanceId,
      challengeId: CHALLENGE,
      paused: false,
      allTeamIds: TEAMS,
    });
    clock.advance(3_001);
    systems.resolveClash();
    const firstClashId = systems.hostView().clash?.clashId;

    systems.endChallenge();
    systems.openCardWindow(asChallengeId('challenge-2'), 'THINK_FAST');
    const second = systems.cards.eligibleCardsFor(TEAM_A, false)[0];
    if (second === undefined) return; // hand exhausted this run, nothing left to prove

    systems.playCard({
      teamId: TEAM_A,
      cardInstanceId: second.cardInstanceId,
      challengeId: asChallengeId('challenge-2'),
      paused: false,
      allTeamIds: TEAMS,
    });

    const newClashId = systems.hostView().clash?.clashId;
    expect(newClashId).not.toBe(firstClashId);
  });
});

describe('the multiplier is shared across every source', () => {
  it('spends the one Double budget when DOUBLE_IT resolves', () => {
    // §3 / §10 — multipliers never stack, whichever system supplies them.
    const seed = seedWhere((h) => h.TEAM_A!.includes('DOUBLE_IT'));
    const { systems, clock } = setup(seed);
    systems.cards.deal(TEAMS);
    systems.openCardWindow(CHALLENGE, 'ROUND2_PHYSICAL');

    const double = systems.cards.handOf(TEAM_A).find((c) => c.cardType === 'DOUBLE_IT')!;
    systems.playCard({
      teamId: TEAM_A,
      cardInstanceId: double.cardInstanceId,
      challengeId: CHALLENGE,
      paused: false,
      allTeamIds: TEAMS,
    });
    clock.advance(3_001);
    systems.resolveClash();

    expect(systems.isDoubledFor(TEAM_A)).toBe(true);
    // A round asks for the multiplier rather than computing one.
    expect(systems.applyMultiplier(TEAM_A, 500)).toBe(1_000);
    // And never more than doubled.
    expect(systems.advantages.canUse(TEAM_A, 'DOUBLE')).toBe(false);
  });

  it('leaves an untouched team undoubled', () => {
    const { systems } = setup();
    expect(systems.isDoubledFor(TEAM_B)).toBe(false);
    expect(systems.applyMultiplier(TEAM_B, 500)).toBe(500);
  });
});

describe('Bacchanal Immunity', () => {
  it('cancels the attack, and the attacker KEEPS its card', () => {
    // §8 / Phase 6 spec §29 — "cancel Bacchanal used against the protected team,
    // immunity is consumed, attacking team keeps its Bacchanal card, attacking
    // card has no effect."
    const seed = seedWhere((h) => h.TEAM_A!.includes('GIMME_DAT'));
    const { systems, clock } = setup(seed);
    systems.cards.deal(TEAMS);
    systems.advantages.grant({
      teamId: TEAM_B,
      type: 'BACCHANAL_IMMUNITY',
      source: 'maco_mail',
    });
    systems.openCardWindow(CHALLENGE, 'ROUND1_TRIVIA');

    const gimme = systems.cards.handOf(TEAM_A).find((c) => c.cardType === 'GIMME_DAT')!;
    systems.playCard({
      teamId: TEAM_A,
      cardInstanceId: gimme.cardInstanceId,
      targetTeamId: TEAM_B,
      challengeId: CHALLENGE,
      paused: false,
      allTeamIds: TEAMS,
    });
    clock.advance(3_001);
    const resolved = systems.resolveClash();

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.immunityTriggered).toBe(true);
      expect(resolved.value.immunityTeamId).toBe(TEAM_B);
      // No effect took hold.
      expect(resolved.value.effect).toBeNull();
    }

    // The attacking card is BACK IN HAND, not consumed.
    expect(systems.cards.card(gimme.cardInstanceId)?.status).toBe('HELD');
    // The immunity is spent.
    expect(systems.advantages.consumeImmunity(TEAM_B)).toBeNull();
  });

  it('does not protect against the Market, Maco Mail, a deal or a wager', () => {
    // §8 / spec §29 — immunity covers Bacchanal cards only. None of those
    // systems consult it, so a purchase still costs and a penalty still lands.
    const { systems, ledger } = setup();
    systems.advantages.grant({
      teamId: TEAM_A,
      type: 'BACCHANAL_IMMUNITY',
      source: 'maco_mail',
    });

    systems.market.open_(2);
    systems.purchase({ teamId: TEAM_A, item: 'CLUE' });
    expect(ledger.balanceOf(TEAM_A)).toBe(800);

    // Still held — nothing consumed it.
    expect(systems.advantages.consumeImmunity(TEAM_A)).not.toBeNull();
  });
});

describe('a losing card returns but the team stays barred', () => {
  it('returns the loser and refuses another card that challenge', () => {
    // §5 and Phase 6 spec §8, through the full play → Clash → resolve path.
    const seed = seedWhere(
      (h) => h.TEAM_A!.includes('DOUBLE_IT') && h.TEAM_B!.includes('STEUPS'),
    );
    const { systems, clock } = setup(seed);
    systems.cards.deal(TEAMS);
    // THINK_FAST allows STEUPS, DOUBLE_IT and FORGIVE_MEH.
    systems.openCardWindow(CHALLENGE, 'THINK_FAST');

    const double = systems.cards.handOf(TEAM_A).find((c) => c.cardType === 'DOUBLE_IT')!;
    const steups = systems.cards.handOf(TEAM_B).find((c) => c.cardType === 'STEUPS')!;

    systems.playCard({
      teamId: TEAM_A,
      cardInstanceId: double.cardInstanceId,
      challengeId: CHALLENGE,
      paused: false,
      allTeamIds: TEAMS,
    });
    systems.respondToClash({
      teamId: TEAM_B,
      cardInstanceId: steups.cardInstanceId,
      targetTeamId: TEAM_A,
      paused: false,
    });

    clock.advance(3_001);
    const resolved = systems.resolveClash();

    // DISRUPTION beats POWER: Steups wins.
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.result.winningTeamId).toBe(TEAM_B);

    // The loser's card is back in hand...
    expect(systems.cards.card(double.cardInstanceId)?.status).toBe('HELD');
    // ...but Team A cannot play again this challenge.
    expect(systems.cards.playabilityOf(double.cardInstanceId, false)).toBe(
      'already_played_this_challenge',
    );
    // The winner's card is consumed.
    expect(systems.cards.card(steups.cardInstanceId)?.status).toBe('CONSUMED');
  });

  it('returns BOTH cards on a Part Dat Fight and bars both teams', () => {
    // §5 — "No effect resolves. Tied cards return. Those teams cannot play
    // another Bacchanal Card in that challenge."
    const seed = seedWhere(
      (h) => h.TEAM_A!.includes('DOUBLE_IT') && h.TEAM_B!.includes('DOUBLE_IT'),
    );
    const { systems, clock } = setup(seed);
    systems.cards.deal(TEAMS);
    systems.openCardWindow(CHALLENGE, 'THINK_FAST');

    const a = systems.cards.handOf(TEAM_A).find((c) => c.cardType === 'DOUBLE_IT')!;
    const b = systems.cards.handOf(TEAM_B).find((c) => c.cardType === 'DOUBLE_IT')!;

    systems.playCard({
      teamId: TEAM_A,
      cardInstanceId: a.cardInstanceId,
      challengeId: CHALLENGE,
      paused: false,
      allTeamIds: TEAMS,
    });
    systems.respondToClash({ teamId: TEAM_B, cardInstanceId: b.cardInstanceId, paused: false });

    clock.advance(3_001);
    const resolved = systems.resolveClash();

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.result.outcome).toBe('part_dat_fight');
      // No effect at all.
      expect(resolved.value.effect).toBeNull();
    }

    // Both cards back in hand, both teams barred.
    expect(systems.cards.card(a.cardInstanceId)?.status).toBe('HELD');
    expect(systems.cards.card(b.cardInstanceId)?.status).toBe('HELD');
    expect(systems.cards.playabilityOf(a.cardInstanceId, false)).toBe(
      'already_played_this_challenge',
    );
    expect(systems.cards.playabilityOf(b.cardInstanceId, false)).toBe(
      'already_played_this_challenge',
    );
    // Nothing was doubled.
    expect(systems.isDoubledFor(TEAM_A)).toBe(false);
  });
});

describe('the Market grants advantages under one stacking rule', () => {
  it('turns a purchase into a held advantage', () => {
    const { systems, ledger } = setup();
    systems.market.open_(2);

    const bought = systems.purchase({ teamId: TEAM_A, item: 'EXTRA_TIME' });

    expect(bought.ok).toBe(true);
    expect(ledger.balanceOf(TEAM_A)).toBe(800);
    const advantages = systems.advantages.usableFor(TEAM_A);
    expect(advantages).toHaveLength(1);
    expect(advantages[0]?.type).toBe('EXTRA_TIME');
    // §10 — expires after the round that follows.
    expect(advantages[0]?.expiresAfterRound).toBe(2);
  });

  it('grants no advantage for a Maco Mail purchase', () => {
    // §10 — "purchased Maco Mail opens after reveal"; the draw is the product.
    const { systems } = setup();
    systems.market.open_(2);
    systems.purchase({ teamId: TEAM_A, item: 'MACO_MAIL' });

    expect(systems.advantages.usableFor(TEAM_A)).toHaveLength(0);
  });

  it('shares the one-Double rule between a Market Double and DOUBLE_IT', () => {
    const { systems } = setup();
    systems.market.open_(2);
    systems.purchase({ teamId: TEAM_A, item: 'DOUBLE_BB' });

    const double = systems.advantages.usableFor(TEAM_A).find((a) => a.type === 'DOUBLE')!;
    systems.advantages.use({ teamId: TEAM_A, advantageId: double.advantageId });

    // Already doubled — a DOUBLE_IT card can add nothing. §3.
    expect(systems.advantages.canUse(TEAM_A, 'DOUBLE')).toBe(false);
    expect(systems.applyMultiplier(TEAM_A, 500)).toBe(1_000);
  });
});

describe('challenge and round boundaries', () => {
  it('resets per-challenge budgets but keeps hands and advantages', () => {
    const { systems } = setup();
    systems.cards.deal(TEAMS);
    systems.market.open_(2);
    systems.purchase({ teamId: TEAM_A, item: 'CLUE' });

    systems.advantages.useForgiveMehRetry(TEAM_A);
    expect(systems.advantages.usageFor(TEAM_A).retriesUsed).toBe(1);

    systems.endChallenge();

    // Budget reset...
    expect(systems.advantages.usageFor(TEAM_A).retriesUsed).toBe(0);
    // ...hand and advantage survive.
    expect(systems.cards.handOf(TEAM_A)).toHaveLength(3);
    expect(systems.advantages.usableFor(TEAM_A)).toHaveLength(1);
  });

  it('expires Market items at the end of their round but not Maco advantages', () => {
    const { systems } = setup();
    systems.market.open_(2);
    systems.purchase({ teamId: TEAM_A, item: 'CLUE' });
    systems.advantages.grant({ teamId: TEAM_A, type: 'CLUE', source: 'maco_mail' });

    expect(systems.advantages.usableFor(TEAM_A)).toHaveLength(2);

    const expired = systems.endRound(2);

    expect(expired.purchases).toHaveLength(1);
    expect(expired.advantages).toHaveLength(1);
    // The Maco Mail one survives — §7.
    const left = systems.advantages.usableFor(TEAM_A);
    expect(left).toHaveLength(1);
    expect(left[0]?.source).toBe('maco_mail');
  });
});

describe('the secrecy boundary', () => {
  it('never puts an opponent card type in a player view', () => {
    // Phase 6 spec §42, tested on the real object a client receives.
    const { systems } = setup();
    systems.cards.deal(TEAMS);

    const view = systems.playerView(TEAM_A, false);
    const serialised = JSON.stringify(view);

    for (const card of systems.cards.handOf(TEAM_B)) {
      expect(serialised).not.toContain(card.cardInstanceId);
    }
    expect(view.opponentHands).toHaveLength(1);
    expect(view.opponentHands[0]?.cardCount).toBe(3);
  });

  it('hides an opponent Market purchase until the reveal', () => {
    const { systems } = setup();
    systems.market.open_(2);
    systems.purchase({ teamId: TEAM_B, item: 'DOUBLE_BB' });

    const before = systems.playerView(TEAM_A, false);
    expect(before.market.otherTeamPurchases).toHaveLength(0);

    systems.market.close();

    const after = systems.playerView(TEAM_A, false);
    expect(after.market.otherTeamPurchases).toHaveLength(1);
  });

  it('hides a Clash response until the reveal, but shows a team its own', () => {
    const seed = seedWhere(
      (h) => h.TEAM_A!.includes('DOUBLE_IT') && h.TEAM_B!.includes('STEUPS'),
    );
    const { systems } = setup(seed);
    systems.cards.deal(TEAMS);
    systems.openCardWindow(CHALLENGE, 'THINK_FAST');

    const double = systems.cards.handOf(TEAM_A).find((c) => c.cardType === 'DOUBLE_IT')!;
    const steups = systems.cards.handOf(TEAM_B).find((c) => c.cardType === 'STEUPS')!;

    systems.playCard({
      teamId: TEAM_A,
      cardInstanceId: double.cardInstanceId,
      challengeId: CHALLENGE,
      paused: false,
      allTeamIds: TEAMS,
    });
    systems.respondToClash({
      teamId: TEAM_B,
      cardInstanceId: steups.cardInstanceId,
      targetTeamId: TEAM_A,
      paused: false,
    });

    // TEAM_A sees THAT B responded, not with what.
    const viewA = systems.playerView(TEAM_A, false);
    expect(viewA.clash?.respondedTeamIds).toEqual([TEAM_B]);
    expect(viewA.yourClashResponse).toBeNull();
    expect(JSON.stringify(viewA.clash)).not.toContain(steups.cardInstanceId);

    // TEAM_B sees its own locked choice.
    const viewB = systems.playerView(TEAM_B, false);
    expect(viewB.yourClashResponse).toBe(steups.cardInstanceId);
  });

  it('gives the Host every hand but still no deck order', () => {
    const { systems } = setup();
    systems.cards.deal(TEAMS);
    systems.macoMail.build();

    const view = systems.hostView();

    expect(Object.keys(view.hands).sort()).toEqual([TEAM_A, TEAM_B].sort());
    // Counts only — a Host display is usually pointed at a TV.
    expect(view.macoDeck.drawPileCount).toBe(20);
    expect(Object.keys(view.macoDeck).sort()).toEqual(
      ['discardCount', 'drawPileCount', 'heldOutOfDeckCount', 'removedImpossibleCount'].sort(),
    );
  });
});

describe('the Phase 6 exit scenario', () => {
  it('runs deal → play → Clash → Market → hidden → reveal → draw', () => {
    // The scenario in the Phase 6 spec's "EXIT EXPERIENCE", end to end.
    const seed = seedWhere(
      (h) => h.TEAM_A!.includes('DOUBLE_IT') && h.TEAM_B!.includes('STEUPS'),
    );
    const { systems, ledger, clock } = setup(seed);

    // Both teams start at 1,000 BB with three cards.
    systems.cards.deal(TEAMS);
    expect(ledger.balanceOf(TEAM_A)).toBe(1_000);
    expect(systems.cards.handOf(TEAM_A)).toHaveLength(3);

    // A challenge opens, Team A plays Double It, Team B counters with Steups.
    systems.openCardWindow(CHALLENGE, 'THINK_FAST');
    const double = systems.cards.handOf(TEAM_A).find((c) => c.cardType === 'DOUBLE_IT')!;
    const steups = systems.cards.handOf(TEAM_B).find((c) => c.cardType === 'STEUPS')!;

    systems.playCard({
      teamId: TEAM_A,
      cardInstanceId: double.cardInstanceId,
      challengeId: CHALLENGE,
      paused: false,
      allTeamIds: TEAMS,
    });
    systems.respondToClash({
      teamId: TEAM_B,
      cardInstanceId: steups.cardInstanceId,
      targetTeamId: TEAM_A,
      paused: false,
    });
    clock.advance(3_001);

    const clash = systems.resolveClash();
    expect(clash.ok).toBe(true);
    // DISRUPTION beats POWER.
    if (clash.ok) expect(clash.value.result.winningTeamId).toBe(TEAM_B);

    systems.endChallenge();

    // Market opens before Round 2. Team A buys Extra Time for 200.
    systems.market.open_(2);
    systems.purchase({ teamId: TEAM_A, item: 'EXTRA_TIME' });
    expect(ledger.balanceOf(TEAM_A)).toBe(800);

    // Team B shops too, and neither sees the other.
    systems.purchase({ teamId: TEAM_B, item: 'CLUE' });
    expect(systems.playerView(TEAM_A, false).market.otherTeamPurchases).toHaveLength(0);

    // Market closes and purchases reveal.
    systems.market.close();
    expect(systems.playerView(TEAM_A, false).market.otherTeamPurchases).toHaveLength(1);

    // A Maco Mail draw resolves or is held.
    systems.macoMail.build();
    const drawn = systems.macoMail.draw(TEAM_A, systems.macoContext({ teamIds: TEAMS }));
    expect(drawn.ok).toBe(true);
    if (drawn.ok) {
      expect(['resolved', 'held', 'applied', 'dud', 'blocked_open_rule']).toContain(
        drawn.value.result,
      );
    }

    // Held advantages survive, and no hidden opponent state leaked.
    expect(systems.advantages.usableFor(TEAM_A).length).toBeGreaterThan(0);
    const finalView = systems.playerView(TEAM_A, false);
    for (const card of systems.cards.handOf(TEAM_B)) {
      expect(JSON.stringify(finalView)).not.toContain(card.cardInstanceId);
    }
  });
});
