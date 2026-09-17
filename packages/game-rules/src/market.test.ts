import { describe, expect, it } from 'vitest';
import {
  asTeamId,
  listedPrice,
  MARKET_PRICES,
  PRICE_GONE_UP_SURCHARGE,
  type MarketItem,
  type MarketRound,
} from '@bb/protocol';
import { BbLedger } from './bb-ledger.js';
import { FakeClock } from './clock.js';
import { Market } from './market.js';

/**
 * Market tests. Phase 6 spec §49.
 *
 * GAME_RULES_LOCKED.md §10.
 */

const TEAM_A = asTeamId('TEAM_A');
const TEAM_B = asTeamId('TEAM_B');

function setup(startingBb = 1_000) {
  const clock = new FakeClock(1_000);
  let counter = 0;
  const mintId = () => `id-${(counter += 1)}`;
  const ledger = new BbLedger(clock, mintId);
  ledger.seed(TEAM_A, startingBb);
  ledger.seed(TEAM_B, startingBb);
  const market = new Market({ clock, ledger, mintId });
  return { clock, ledger, market };
}

describe('the locked price table', () => {
  // GAME_RULES_LOCKED.md §10. Transcribed from the locked table.
  const EXPECTED: Record<MarketItem, Record<MarketRound, number>> = {
    CLUE: { 2: 200, 3: 250, 4: 400 },
    SECOND_CHANCE: { 2: 250, 3: 300, 4: 500 },
    DOUBLE_BB: { 2: 250, 3: 300, 4: 750 },
    EXTRA_TIME: { 2: 200, 3: 250, 4: 400 },
    MACO_MAIL: { 2: 500, 3: 500, 4: 750 },
  };

  for (const [item, prices] of Object.entries(EXPECTED)) {
    for (const [round, price] of Object.entries(prices)) {
      it(`charges ${price} for ${item} before Round ${round}`, () => {
        expect(MARKET_PRICES[item as MarketItem][Number(round) as MarketRound]).toBe(price);
        expect(listedPrice(item as MarketItem, Number(round) as MarketRound)).toBe(price);
      });
    }
  }
});

describe('opening the Market', () => {
  it('refuses to open before Round 1', () => {
    // §10 — the Market opens before Rounds 2, 3 and 4 only.
    const { market } = setup();
    const opened = market.open_(1);

    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe('ILLEGAL_ACTION');
  });

  it('opens before Rounds 2, 3 and 4', () => {
    for (const round of [2, 3, 4]) {
      const { market } = setup();
      expect(market.open_(round).ok).toBe(true);
      expect(market.round).toBe(round);
    }
  });

  it('refuses to open twice', () => {
    const { market } = setup();
    market.open_(2);
    expect(market.open_(2).ok).toBe(false);
  });

  it('publishes this activation\'s prices', () => {
    const { market } = setup();
    const opened = market.open_(3);

    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.value.prices.CLUE).toBe(250);
      expect(opened.value.prices.DOUBLE_BB).toBe(300);
    }
  });
});

describe('purchasing', () => {
  it('deducts the price through the ledger', () => {
    const { market, ledger } = setup();
    market.open_(2);

    const bought = market.purchase({ teamId: TEAM_A, item: 'EXTRA_TIME' });

    expect(bought.ok).toBe(true);
    // 1,000 - 200 = 800. The Phase 6 exit scenario.
    expect(ledger.balanceOf(TEAM_A)).toBe(800);
    if (bought.ok) expect(bought.value.pricePaid).toBe(200);
  });

  it('records the purchase against a ledger entry', () => {
    const { market, ledger } = setup();
    market.open_(2);
    market.purchase({ teamId: TEAM_A, item: 'CLUE' });

    const entries = ledger.entriesFor(TEAM_A);
    const spend = entries.find((e) => e.reason === 'market_purchase');
    expect(spend).toBeDefined();
    expect(spend?.applied).toBe(-200);
  });

  it('allows multiple DIFFERENT items in one activation', () => {
    // §10 — "multiple different items may be purchased if affordable".
    const { market, ledger } = setup();
    market.open_(2);

    expect(market.purchase({ teamId: TEAM_A, item: 'CLUE' }).ok).toBe(true);
    expect(market.purchase({ teamId: TEAM_A, item: 'EXTRA_TIME' }).ok).toBe(true);
    expect(market.purchase({ teamId: TEAM_A, item: 'SECOND_CHANCE' }).ok).toBe(true);

    // 1,000 - 200 - 200 - 250 = 350.
    expect(ledger.balanceOf(TEAM_A)).toBe(350);
  });

  it('refuses a second copy of the same item in one activation', () => {
    // §10 — "max one copy of each item per Market visit".
    const { market } = setup();
    market.open_(2);

    expect(market.purchase({ teamId: TEAM_A, item: 'CLUE' }).ok).toBe(true);
    const second = market.purchase({ teamId: TEAM_A, item: 'CLUE' });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('ILLEGAL_ACTION');
  });

  it('allows the same item again in a LATER activation', () => {
    const { market } = setup(3_000);
    market.open_(2);
    market.purchase({ teamId: TEAM_A, item: 'CLUE' });
    market.close();

    market.open_(3);
    expect(market.purchase({ teamId: TEAM_A, item: 'CLUE' }).ok).toBe(true);
  });

  it('refuses a purchase the team cannot afford, without touching the balance', () => {
    // THE RULE THE FLOOR WOULD OTHERWISE BREAK. Phase 6 spec §20 — affordability
    // is checked BEFORE deduction, so a team holding 300 cannot buy a 500 item
    // and land at zero.
    const { market, ledger } = setup(300);
    market.open_(2);

    const bought = market.purchase({ teamId: TEAM_A, item: 'MACO_MAIL' });

    expect(bought.ok).toBe(false);
    expect(ledger.balanceOf(TEAM_A)).toBe(300);
  });

  it('refuses a purchase when the Market is closed', () => {
    const { market } = setup();
    market.open_(2);
    market.close();

    expect(market.purchase({ teamId: TEAM_A, item: 'CLUE' }).ok).toBe(false);
  });
});

describe('hidden shopping', () => {
  it('hides other teams\' purchases while the Market is open', () => {
    // §10 — "shopping is hidden". Phase 6 spec §42.
    const { market } = setup();
    market.open_(2);

    market.purchase({ teamId: TEAM_A, item: 'CLUE' });
    market.purchase({ teamId: TEAM_B, item: 'DOUBLE_BB' });

    const viewA = market.teamView(TEAM_A);
    expect(viewA.yourPurchases).toHaveLength(1);
    // Not even a count — a count would reveal how much they committed.
    expect(viewA.otherTeamPurchases).toHaveLength(0);

    // The item NAME appears in the public price list, which every team needs in
    // order to shop, so the secret is not the string — it is the link between an
    // item and a buyer. Nothing in the view may name TEAM_B at all.
    expect(JSON.stringify(viewA)).not.toContain(TEAM_B);
  });

  it('reveals every purchase once the Market closes', () => {
    // §10 — "purchases reveal when Market closes".
    const { market } = setup();
    market.open_(2);
    market.purchase({ teamId: TEAM_A, item: 'CLUE' });
    market.purchase({ teamId: TEAM_B, item: 'DOUBLE_BB' });

    market.close();

    const viewA = market.teamView(TEAM_A);
    expect(viewA.otherTeamPurchases).toHaveLength(1);
    expect(viewA.otherTeamPurchases[0]?.item).toBe('DOUBLE_BB');
    expect(viewA.market?.revealed).toBe(true);
  });

  it('shows a team its own purchases immediately', () => {
    const { market } = setup();
    market.open_(2);
    market.purchase({ teamId: TEAM_A, item: 'CLUE' });

    expect(market.teamView(TEAM_A).yourPurchases[0]?.item).toBe('CLUE');
  });

  it('drops a bought item from the available list', () => {
    const { market } = setup();
    market.open_(2);
    market.purchase({ teamId: TEAM_A, item: 'CLUE' });

    expect(market.teamView(TEAM_A).availableItems).not.toContain('CLUE');
    expect(market.teamView(TEAM_A).availableItems).toContain('EXTRA_TIME');
  });
});

describe('frozen opponent balances while the Market is open', () => {
  // GAME_RULES_LOCKED.md §10 — "shopping is hidden" — and Phase 5's balances
  // being a visible scoreboard otherwise defeat each other: a live BB drop
  // during an open Market reveals "they bought something" even though WHAT
  // stays hidden until reveal. Market itself only RECORDS the frozen figure —
  // the actual substitution into a player's view is room.ts's job, since that
  // is where "who is asking" and the secrecy boundary both live. These tests
  // cover the recording; shared-network.test.ts covers the substitution
  // against a real player snapshot.
  it('records every named team\'s balance at the moment the Market opens', () => {
    const { market, ledger } = setup(1_000);
    market.open_(2, [TEAM_A, TEAM_B]);

    expect(market.frozenBalanceFor(TEAM_A)).toBe(1_000);
    expect(market.frozenBalanceFor(TEAM_B)).toBe(1_000);

    // A purchase afterward changes the LEDGER but not the frozen snapshot.
    market.purchase({ teamId: TEAM_A, item: 'CLUE' });
    expect(ledger.balanceOf(TEAM_A)).toBe(800);
    expect(market.frozenBalanceFor(TEAM_A)).toBe(1_000);
  });

  it('returns null for a team never named at open time', () => {
    const { market } = setup();
    market.open_(2, [TEAM_A]);

    expect(market.frozenBalanceFor(TEAM_B)).toBeNull();
  });

  it('returns null before any Market has ever opened', () => {
    const { market } = setup();
    expect(market.frozenBalanceFor(TEAM_A)).toBeNull();
  });

  it('captures a NEW frozen figure for the next activation', () => {
    // A team that ended Round 2's Market at 800 should freeze at 800 for
    // Round 3's Market, not at whatever it held when Round 2's Market opened.
    const { market } = setup(1_000);
    market.open_(2, [TEAM_A]);
    market.purchase({ teamId: TEAM_A, item: 'CLUE' });
    market.close();

    market.open_(3, [TEAM_A]);
    expect(market.frozenBalanceFor(TEAM_A)).toBe(800);
  });

  it('still opens correctly when called without team ids', () => {
    // Existing callers (and any that never learn about this feature) must not
    // break — open_() keeps working with the same one-argument call it always
    // took, and frozenBalanceFor simply has nothing to report.
    const { market } = setup();
    const opened = market.open_(2);
    expect(opened.ok).toBe(true);
    expect(market.frozenBalanceFor(TEAM_A)).toBeNull();
  });
});

describe('the Price Gone Up! surcharge', () => {
  it('adds 500 to the next purchase', () => {
    // GAME_RULES_LOCKED.md §8, Phase 6 spec §33.
    const { market, ledger } = setup();
    market.addSurcharge(TEAM_A);
    market.open_(2);

    const bought = market.purchase({ teamId: TEAM_A, item: 'CLUE' });

    expect(bought.ok).toBe(true);
    if (bought.ok) {
      expect(bought.value.listedPrice).toBe(200);
      expect(bought.value.surcharge).toBe(PRICE_GONE_UP_SURCHARGE);
      expect(bought.value.pricePaid).toBe(700);
    }
    expect(ledger.balanceOf(TEAM_A)).toBe(300);
  });

  it('affects ONE purchase only', () => {
    // §8 — "affects one purchase only".
    const { market, ledger } = setup(2_000);
    market.addSurcharge(TEAM_A);
    market.open_(2);

    market.purchase({ teamId: TEAM_A, item: 'CLUE' }); // 200 + 500 = 700
    const second = market.purchase({ teamId: TEAM_A, item: 'EXTRA_TIME' }); // 200

    if (second.ok) expect(second.value.surcharge).toBe(0);
    expect(ledger.balanceOf(TEAM_A)).toBe(2_000 - 700 - 200);
  });

  it('refuses to stack two surcharges', () => {
    const { market } = setup();
    expect(market.addSurcharge(TEAM_A).ok).toBe(true);
    expect(market.addSurcharge(TEAM_A).ok).toBe(false);
  });

  it('blocks a purchase the team cannot afford WITH the surcharge', () => {
    const { market, ledger } = setup(500);
    market.addSurcharge(TEAM_A);
    market.open_(2);

    // 200 listed, but 700 with the surcharge, and they hold 500.
    expect(market.purchase({ teamId: TEAM_A, item: 'CLUE' }).ok).toBe(false);
    expect(ledger.balanceOf(TEAM_A)).toBe(500);
  });
});

describe('cancelling a purchase', () => {
  it('refunds the ACTUAL price paid, surcharge included', () => {
    // Phase 6 spec §31 — "refund includes any surcharge paid", and "Do not
    // recalculate refund from current listed price."
    const { market, ledger } = setup();
    market.addSurcharge(TEAM_A);
    market.open_(2);

    const bought = market.purchase({ teamId: TEAM_A, item: 'CLUE' });
    expect(ledger.balanceOf(TEAM_A)).toBe(300);

    if (!bought.ok) throw new Error('purchase failed');
    const cancelled = market.cancelPurchase(bought.value.purchaseId);

    expect(cancelled.ok).toBe(true);
    // 700 back, not the 200 listed price.
    if (cancelled.ok) expect(cancelled.value.refunded).toBe(700);
    expect(ledger.balanceOf(TEAM_A)).toBe(1_000);
  });

  it('refuses to cancel a used item', () => {
    // §31 — "destroy one UNUSED opponent Market item".
    const { market } = setup();
    market.open_(2);
    const bought = market.purchase({ teamId: TEAM_A, item: 'CLUE' });
    if (!bought.ok) throw new Error('purchase failed');

    market.markUsed(bought.value.purchaseId);
    expect(market.cancelPurchase(bought.value.purchaseId).ok).toBe(false);
  });

  it('refuses to cancel twice', () => {
    const { market } = setup();
    market.open_(2);
    const bought = market.purchase({ teamId: TEAM_A, item: 'CLUE' });
    if (!bought.ok) throw new Error('purchase failed');

    expect(market.cancelPurchase(bought.value.purchaseId).ok).toBe(true);
    expect(market.cancelPurchase(bought.value.purchaseId).ok).toBe(false);
  });

  it('offers only unused, uncancelled purchases as candidates', () => {
    const { market } = setup(3_000);
    market.open_(2);
    const a = market.purchase({ teamId: TEAM_A, item: 'CLUE' });
    market.purchase({ teamId: TEAM_A, item: 'EXTRA_TIME' });
    if (!a.ok) throw new Error('purchase failed');

    expect(market.cancellablePurchases(TEAM_A)).toHaveLength(2);
    market.markUsed(a.value.purchaseId);
    expect(market.cancellablePurchases(TEAM_A)).toHaveLength(1);
  });
});

describe('expiry', () => {
  it('expires an item after the round that follows its purchase', () => {
    // §10 — "items expire after the immediately following round". Bought before
    // Round 2, usable during Round 2, gone after Round 2.
    const { market } = setup();
    market.open_(2);
    market.purchase({ teamId: TEAM_A, item: 'CLUE' });
    market.close();

    // Round 2 has not finished yet.
    expect(market.expireAfterRound(1)).toHaveLength(0);
    expect(market.allPurchases()[0]?.expired).toBe(false);

    // Round 2 is over.
    const expired = market.expireAfterRound(2);
    expect(expired).toHaveLength(1);
    expect(market.allPurchases()[0]?.expired).toBe(true);
  });

  it('does not expire a Round 3 purchase when Round 2 ends', () => {
    const { market } = setup(3_000);
    market.open_(3);
    market.purchase({ teamId: TEAM_A, item: 'CLUE' });

    expect(market.expireAfterRound(2)).toHaveLength(0);
    expect(market.expireAfterRound(3)).toHaveLength(1);
  });

  it('leaves used and cancelled purchases alone', () => {
    const { market } = setup(3_000);
    market.open_(2);
    const a = market.purchase({ teamId: TEAM_A, item: 'CLUE' });
    const b = market.purchase({ teamId: TEAM_A, item: 'EXTRA_TIME' });
    if (!a.ok || !b.ok) throw new Error('purchase failed');

    market.markUsed(a.value.purchaseId);
    market.cancelPurchase(b.value.purchaseId);

    expect(market.expireAfterRound(2)).toHaveLength(0);
  });
});
