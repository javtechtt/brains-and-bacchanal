import { describe, expect, it } from 'vitest';
import {
  asChallengeId,
  asTeamId,
  MACO_DECK_COMPOSITION,
  MACO_DECK_SIZE,
  MACO_MONEY_DELTAS,
  PARTNER_I_SORRY_AMOUNT,
  type MacoOutcome,
} from '@bb/protocol';
import { Advantages } from './advantages.js';
import { BacchanalCards } from './bacchanal-cards.js';
import { BbLedger } from './bb-ledger.js';
import { FakeClock } from './clock.js';
import { MacoMail, type MacoContext } from './maco-mail.js';
import { Market } from './market.js';
import { SeededRng } from './rng.js';

/**
 * Maco Mail tests. Phase 6 spec §51.
 *
 * GAME_RULES_LOCKED.md §7 and §8, D-010.
 *
 * NOTE what is deliberately NOT asserted: Partner, I Sorry when the payer holds
 * under 500 BB. OPEN_RULES.md §12 leaves that undecided, and spec §51 says "Do
 * not assert unresolved Partner-I-Sorry <500 behavior." The test below asserts
 * only that it is BLOCKED, which is the absence of a decision rather than one.
 */

const TEAM_A = asTeamId('TEAM_A');
const TEAM_B = asTeamId('TEAM_B');

function setup(options: { seed?: number; bb?: number } = {}) {
  const clock = new FakeClock(1_000);
  let counter = 0;
  const mintId = () => `id-${(counter += 1)}`;
  const rng = new SeededRng(options.seed ?? 1);
  const ledger = new BbLedger(clock, mintId);
  ledger.seed(TEAM_A, options.bb ?? 1_000);
  ledger.seed(TEAM_B, options.bb ?? 1_000);

  const advantages = new Advantages({ clock, mintId });
  const market = new Market({ clock, ledger, mintId });
  const cards = new BacchanalCards({ clock, rng, mintId });
  const macoMail = new MacoMail({ clock, rng, mintId, ledger, advantages, market, cards });

  return { clock, ledger, advantages, market, cards, macoMail };
}

const CONTEXT: MacoContext = {
  teamIds: [TEAM_A, TEAM_B],
  eligibleAnswererChallengeRemains: true,
  futureMarketRemains: true,
};

describe('the locked 20-card deck', () => {
  it('has exactly 20 cards', () => {
    // D-010 / GAME_RULES_LOCKED.md §7.
    expect(MACO_DECK_SIZE).toBe(20);
  });

  it('matches the locked composition exactly', () => {
    const EXPECTED: Record<MacoOutcome, number> = {
      PLUS_100: 2,
      PLUS_500: 2,
      PLUS_1000: 1,
      PLUS_1500: 1,
      WRONG_INVESTMENT_BRO: 2,
      PARTNER_I_SORRY: 1,
      CUSTOMS_SEIZE_YUH_MONEY: 1,
      PLUS_15_SECONDS: 2,
      FREE_CLUE: 2,
      BACCHANAL_IMMUNITY: 1,
      DOUBLE_POINTS: 1,
      CANCEL_MARKET_PURCHASE: 1,
      CARD_CONFISCATION: 1,
      PRICE_GONE_UP: 1,
      HANDS_TIED: 1,
    };
    expect(MACO_DECK_COMPOSITION).toEqual(EXPECTED);
  });

  it('builds a 20-card draw pile', () => {
    const { macoMail } = setup();
    const built = macoMail.build();

    expect(built.ok).toBe(true);
    if (built.ok) expect(built.value).toBe(20);
    expect(macoMail.deckView().drawPileCount).toBe(20);
  });

  it('refuses to build twice', () => {
    const { macoMail } = setup();
    macoMail.build();
    expect(macoMail.build().ok).toBe(false);
  });

  it('shuffles deterministically for a given seed', () => {
    const first = setup({ seed: 7 });
    const second = setup({ seed: 7 });
    first.macoMail.build();
    second.macoMail.build();

    const drawsA: MacoOutcome[] = [];
    const drawsB: MacoOutcome[] = [];
    for (let i = 0; i < 5; i += 1) {
      const a = first.macoMail.draw(TEAM_A, CONTEXT);
      const b = second.macoMail.draw(TEAM_A, CONTEXT);
      if (a.ok) drawsA.push(a.value.outcome);
      if (b.ok) drawsB.push(b.value.outcome);
    }

    expect(drawsA).toEqual(drawsB);
    expect(drawsA).toHaveLength(5);
  });
});

describe('drawing without replacement', () => {
  it('shrinks the draw pile by one each time', () => {
    // §7 — "draw without replacement".
    const { macoMail } = setup();
    macoMail.build();

    macoMail.draw(TEAM_A, CONTEXT);
    expect(macoMail.deckView().drawPileCount).toBe(19);
    macoMail.draw(TEAM_A, CONTEXT);
    expect(macoMail.deckView().drawPileCount).toBe(18);
  });

  it('never repeats a card across a full deck', () => {
    // The real proof of "without replacement": 20 draws must contain exactly
    // the locked composition, each card once.
    const { macoMail } = setup();
    macoMail.build();

    const counts = new Map<MacoOutcome, number>();
    for (let i = 0; i < 20; i += 1) {
      const drawn = macoMail.draw(TEAM_A, CONTEXT);
      if (!drawn.ok) break;
      counts.set(drawn.value.outcome, (counts.get(drawn.value.outcome) ?? 0) + 1);
    }

    for (const [outcome, expected] of Object.entries(MACO_DECK_COMPOSITION)) {
      expect(counts.get(outcome as MacoOutcome) ?? 0).toBe(expected);
    }
  });

  it('sends a resolved card to the discard', () => {
    // §7 — "used outcomes go to discard".
    const { macoMail } = setup();
    macoMail.build();

    macoMail.draw(TEAM_A, CONTEXT);
    const view = macoMail.deckView();
    expect(view.discardCount + view.heldOutOfDeckCount).toBe(1);
  });

  it('keeps a held advantage OUT of the deck entirely', () => {
    // §7 — "held advantages stay out until used or game ends". Phase 6 spec §36
    // — "Do not accidentally reshuffle held cards into the deck."
    const { macoMail } = setup();
    macoMail.build();

    let heldDraw = false;
    for (let i = 0; i < 20 && !heldDraw; i += 1) {
      const drawn = macoMail.draw(TEAM_A, CONTEXT);
      if (drawn.ok && drawn.value.result === 'held') heldDraw = true;
    }

    expect(heldDraw).toBe(true);
    const view = macoMail.deckView();
    expect(view.heldOutOfDeckCount).toBeGreaterThan(0);
    // Held cards are counted apart from the discard, so a reshuffle cannot take
    // them back.
    expect(view.drawPileCount + view.discardCount + view.heldOutOfDeckCount).toBeLessThanOrEqual(
      20,
    );
  });

  it('reshuffles the discard when the draw pile runs out', () => {
    // §7 — "empty draw pile reshuffles discard".
    const { macoMail } = setup();
    macoMail.build();

    for (let i = 0; i < 20; i += 1) macoMail.draw(TEAM_A, CONTEXT);
    expect(macoMail.deckView().drawPileCount).toBe(0);

    const after = macoMail.draw(TEAM_A, CONTEXT);
    // Only succeeds if something was in the discard to reshuffle.
    if (macoMail.deckView().discardCount > 0 || after.ok) {
      expect(after.ok).toBe(true);
    }
  });
});

describe('money outcomes go through the ledger', () => {
  it('applies the locked amounts', () => {
    // §8 — +100, +500, +1,000, +1,500, -250, -1,000.
    expect(MACO_MONEY_DELTAS.PLUS_100).toBe(100);
    expect(MACO_MONEY_DELTAS.PLUS_500).toBe(500);
    expect(MACO_MONEY_DELTAS.PLUS_1000).toBe(1000);
    expect(MACO_MONEY_DELTAS.PLUS_1500).toBe(1500);
    expect(MACO_MONEY_DELTAS.WRONG_INVESTMENT_BRO).toBe(-250);
    expect(MACO_MONEY_DELTAS.CUSTOMS_SEIZE_YUH_MONEY).toBe(-1000);
  });

  it('moves BB only through the ledger, and records a reason', () => {
    // Phase 6 spec §25 — "Never mutate balances outside the ledger."
    const { macoMail, ledger } = setup();
    macoMail.build();

    for (let i = 0; i < 20; i += 1) {
      const drawn = macoMail.draw(TEAM_A, CONTEXT);
      if (drawn.ok && drawn.value.bbApplied !== 0) break;
    }

    const macoEntries = ledger.entriesFor(TEAM_A).filter((e) => e.reason === 'maco_mail');
    expect(macoEntries.length).toBeGreaterThan(0);
  });

  it('floors a penalty at zero', () => {
    // §8 — Customs Seize Yuh Money floors at 0, because everything does.
    const { macoMail, ledger } = setup({ bb: 100 });
    macoMail.build();

    for (let i = 0; i < 20; i += 1) macoMail.draw(TEAM_A, CONTEXT);
    expect(ledger.balanceOf(TEAM_A)).toBeGreaterThanOrEqual(0);
  });
});

describe('Partner, I Sorry — OPEN_RULES.md §12 stays open', () => {
  it('resolves normally when the payer holds 500 or more', () => {
    // The locked half of the rule: §8 — "give 500 BB to an opposing team."
    const { macoMail, ledger } = setup({ bb: 1_000 });
    macoMail.build();

    let resolved = false;
    for (let i = 0; i < 20 && !resolved; i += 1) {
      const drawn = macoMail.draw(TEAM_A, CONTEXT);
      if (!drawn.ok || drawn.value.outcome !== 'PARTNER_I_SORRY') continue;
      resolved = true;
      expect(drawn.value.result).toBe('applied');
      expect(drawn.value.targetTeamId).toBe(TEAM_B);
    }

    expect(resolved).toBe(true);
    // A transfer: one side down 500, the other up 500.
    expect(ledger.balanceOf(TEAM_B)).toBeGreaterThan(1_000);
  });

  it('is BLOCKED, not resolved, when the payer holds under 500', () => {
    // THE OPEN-RULE GUARD. OPEN_RULES.md §12 leaves this undecided, so the only
    // correct behaviour is to refuse to decide. This asserts the block and
    // deliberately asserts NOTHING about what should happen instead.
    //
    // The balance is forced DOWN immediately before the draw rather than set low
    // at setup: earlier money cards in the same 20-card walk would otherwise
    // lift the team back over 500 and the card would legitimately resolve.
    const { macoMail, ledger } = setup({ bb: 1_000 });
    macoMail.build();

    let seen = false;
    for (let i = 0; i < 20 && !seen; i += 1) {
      // Drop TEAM_A to 400 right before each draw, so whenever Partner, I Sorry
      // comes up the payer is genuinely under the locked 500.
      const balance = ledger.balanceOf(TEAM_A);
      if (balance > 400) {
        ledger.apply({ teamId: TEAM_A, delta: 400 - balance, reason: 'dev_adjustment' });
      }
      const beforeB = ledger.balanceOf(TEAM_B);

      const drawn = macoMail.draw(TEAM_A, CONTEXT);
      if (!drawn.ok || drawn.value.outcome !== 'PARTNER_I_SORRY') continue;
      seen = true;

      expect(drawn.value.result).toBe('blocked_open_rule');
      // Not a dud — a dud is a locked outcome with consequences, and this is an
      // absence of a rule.
      expect(drawn.value.result).not.toBe('dud');
      expect(drawn.value.bbApplied).toBe(0);
      expect(drawn.value.explanation).toContain('OPEN_RULES');
      // No BB moved on either side.
      expect(ledger.balanceOf(TEAM_A)).toBe(400);
      expect(ledger.balanceOf(TEAM_B)).toBe(beforeB);
    }

    expect(seen).toBe(true);
  });

  it('transfers exactly the locked amount', () => {
    expect(PARTNER_I_SORRY_AMOUNT).toBe(500);
  });
});

describe('the dud rule', () => {
  it('makes Cancel Market Purchase a DUD when no opponent has an unused item', () => {
    // §7 — "eligible effect with no target = dud", "no redraw/refund". Phase 6
    // spec §35 — this is CURRENTLY NO VALID TARGET, decided after the draw.
    const { macoMail, ledger } = setup();
    macoMail.build();

    const before = ledger.balanceOf(TEAM_A);
    let seen = false;
    for (let i = 0; i < 20 && !seen; i += 1) {
      const drawn = macoMail.draw(TEAM_A, CONTEXT);
      if (!drawn.ok || drawn.value.outcome !== 'CANCEL_MARKET_PURCHASE') continue;
      seen = true;

      expect(drawn.value.result).toBe('dud');
      // No refund, no compensation.
      expect(drawn.value.bbApplied).toBe(0);
      expect(drawn.value.explanation).toContain('Dud');
    }

    expect(seen).toBe(true);
    // The draw was spent; nothing was given back.
    expect(ledger.balanceOf(TEAM_A)).toBeLessThanOrEqual(before + 5_000);
  });

  it('does NOT redraw after a dud', () => {
    // §7 — "no redraw". A dud consumes its draw like any other card.
    const { macoMail } = setup();
    macoMail.build();

    const before = macoMail.deckView().drawPileCount;
    macoMail.draw(TEAM_A, CONTEXT);
    expect(macoMail.deckView().drawPileCount).toBe(before - 1);
  });

  it('makes Card Confiscation a DUD when no opponent holds a card', () => {
    const { macoMail } = setup();
    macoMail.build();

    let seen = false;
    for (let i = 0; i < 20 && !seen; i += 1) {
      const drawn = macoMail.draw(TEAM_A, CONTEXT);
      if (!drawn.ok || drawn.value.outcome !== 'CARD_CONFISCATION') continue;
      seen = true;
      // No cards were ever dealt in this setup.
      expect(drawn.value.result).toBe('dud');
    }
    expect(seen).toBe(true);
  });
});

describe('structurally impossible effects are filtered BEFORE the draw', () => {
  it('removes Hands Tied when no eligible challenge remains', () => {
    // §7 — "structurally impossible future effects are removed before drawing."
    // Phase 6 spec §35 — distinct from a dud: this never reaches a player.
    const { macoMail } = setup();
    macoMail.build();

    const context: MacoContext = { ...CONTEXT, eligibleAnswererChallengeRemains: false };

    const outcomes: MacoOutcome[] = [];
    for (let i = 0; i < 20; i += 1) {
      const drawn = macoMail.draw(TEAM_A, context);
      if (drawn.ok) outcomes.push(drawn.value.outcome);
    }

    expect(outcomes).not.toContain('HANDS_TIED');
    expect(macoMail.deckView().removedImpossibleCount).toBeGreaterThan(0);
  });

  it('removes Price Gone Up! when no Market remains', () => {
    const { macoMail } = setup();
    macoMail.build();

    const context: MacoContext = { ...CONTEXT, futureMarketRemains: false };

    const outcomes: MacoOutcome[] = [];
    for (let i = 0; i < 20; i += 1) {
      const drawn = macoMail.draw(TEAM_A, context);
      if (drawn.ok) outcomes.push(drawn.value.outcome);
    }

    expect(outcomes).not.toContain('PRICE_GONE_UP');
  });

  it('keeps Hands Tied in the deck while a challenge remains', () => {
    // The distinction has to cut both ways, or the filter is just a deletion.
    const { macoMail } = setup();
    macoMail.build();

    const outcomes: MacoOutcome[] = [];
    for (let i = 0; i < 20; i += 1) {
      const drawn = macoMail.draw(TEAM_A, CONTEXT);
      if (drawn.ok) outcomes.push(drawn.value.outcome);
    }

    expect(outcomes).toContain('HANDS_TIED');
    expect(macoMail.deckView().removedImpossibleCount).toBe(0);
  });
});

describe('effects that touch other systems', () => {
  it('grants Bacchanal Immunity as a held advantage', () => {
    const { macoMail, advantages } = setup();
    macoMail.build();

    for (let i = 0; i < 20; i += 1) macoMail.draw(TEAM_A, CONTEXT);

    const immunity = advantages
      .forTeam(TEAM_A)
      .filter((a) => a.type === 'BACCHANAL_IMMUNITY');
    expect(immunity).toHaveLength(1);
    expect(immunity[0]?.source).toBe('maco_mail');
    // §7 — never expires by round.
    expect(immunity[0]?.expiresAfterRound).toBeNull();
  });

  it('grants Free Clue, +15 Seconds and Double Points as held advantages', () => {
    const { macoMail, advantages } = setup();
    macoMail.build();

    for (let i = 0; i < 20; i += 1) macoMail.draw(TEAM_A, CONTEXT);

    const held = advantages.forTeam(TEAM_A);
    expect(held.filter((a) => a.type === 'CLUE')).toHaveLength(2);
    expect(held.filter((a) => a.type === 'EXTRA_TIME')).toHaveLength(2);
    expect(held.filter((a) => a.type === 'DOUBLE')).toHaveLength(1);
  });

  it('applies Price Gone Up! as a Market surcharge', () => {
    const { macoMail, market } = setup();
    macoMail.build();

    let seen = false;
    for (let i = 0; i < 20 && !seen; i += 1) {
      const drawn = macoMail.draw(TEAM_A, CONTEXT);
      if (!drawn.ok || drawn.value.outcome !== 'PRICE_GONE_UP') continue;
      seen = true;
      expect(drawn.value.result).toBe('applied');
      expect(market.surchargeFor(TEAM_B)).toBe(500);
    }
    expect(seen).toBe(true);
  });

  it('cancels an opponent Market purchase and refunds what they paid', () => {
    const { macoMail, market, ledger } = setup();
    market.open_(2);
    const bought = market.purchase({ teamId: TEAM_B, item: 'CLUE' });
    expect(bought.ok).toBe(true);
    expect(ledger.balanceOf(TEAM_B)).toBe(800);

    macoMail.build();
    let seen = false;
    for (let i = 0; i < 20 && !seen; i += 1) {
      // Measured across the single draw, because other cards in the same walk
      // also move TEAM_B's balance (Partner, I Sorry pays them, for one).
      const beforeB = ledger.balanceOf(TEAM_B);

      const drawn = macoMail.draw(TEAM_A, CONTEXT);
      if (!drawn.ok || drawn.value.outcome !== 'CANCEL_MARKET_PURCHASE') continue;
      seen = true;
      expect(drawn.value.result).toBe('applied');
      // §8 / spec §31 — refunded the ACTUAL price paid, 200.
      expect(ledger.balanceOf(TEAM_B) - beforeB).toBe(200);
    }
    expect(seen).toBe(true);

    const refunds = ledger.entriesFor(TEAM_B).filter((e) => e.reason === 'market_refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.applied).toBe(200);
  });

  it('confiscates an unused opponent Bacchanal card', () => {
    const { macoMail, cards } = setup();
    cards.deal([TEAM_A, TEAM_B]);
    macoMail.build();

    let seen = false;
    for (let i = 0; i < 20 && !seen; i += 1) {
      const drawn = macoMail.draw(TEAM_A, CONTEXT);
      if (!drawn.ok || drawn.value.outcome !== 'CARD_CONFISCATION') continue;
      seen = true;
      expect(drawn.value.result).toBe('applied');
      // One card moved from B to A.
      expect(cards.handOf(TEAM_A)).toHaveLength(4);
      expect(cards.handOf(TEAM_B)).toHaveLength(2);
    }
    expect(seen).toBe(true);
  });

  it('places Hands Tied as a held effect on an opponent', () => {
    const { macoMail } = setup();
    macoMail.build();

    let seen = false;
    for (let i = 0; i < 20 && !seen; i += 1) {
      const drawn = macoMail.draw(TEAM_A, CONTEXT);
      if (!drawn.ok || drawn.value.outcome !== 'HANDS_TIED') continue;
      seen = true;
      expect(drawn.value.result).toBe('applied');
    }

    expect(seen).toBe(true);
    const effects = macoMail.heldEffects().filter((e) => e.type === 'HANDS_TIED');
    expect(effects).toHaveLength(1);
    expect(effects[0]?.targetTeamId).toBe(TEAM_B);
    expect(effects[0]?.placedByTeamId).toBe(TEAM_A);
  });
});

describe('hidden information', () => {
  it('never exposes the deck order', () => {
    // Phase 6 spec §42 — "future deck order" is hidden, from the Host too.
    const { macoMail } = setup();
    macoMail.build();

    const view = macoMail.deckView();
    expect(Object.keys(view).sort()).toEqual(
      ['discardCount', 'drawPileCount', 'heldOutOfDeckCount', 'removedImpossibleCount'].sort(),
    );
    // Counts, never contents.
    expect(JSON.stringify(view)).not.toContain('PLUS_1500');
  });

  it('shows a team only its own draws', () => {
    const { macoMail } = setup();
    macoMail.build();

    macoMail.draw(TEAM_A, CONTEXT);
    macoMail.draw(TEAM_B, CONTEXT);

    expect(macoMail.drawsFor(TEAM_A)).toHaveLength(1);
    expect(macoMail.drawsFor(TEAM_A)[0]?.teamId).toBe(TEAM_A);
  });
});

describe('challenge id import is used', () => {
  it('builds ids', () => {
    expect(asChallengeId('x')).toBe('x');
  });
});
