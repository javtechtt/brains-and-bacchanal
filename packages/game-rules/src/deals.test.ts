import { describe, expect, it } from 'vitest';
import {
  asTeamId,
  HOST_DEAL_TEMPLATES,
  HOST_DEAL_TERMS,
  MAX_WAGER_FRACTION,
  maxWagerFor,
} from '@bb/protocol';
import { BbLedger } from './bb-ledger.js';
import { FakeClock } from './clock.js';
import { Deals } from './deals.js';

/**
 * Host Deal and wager tests. Phase 6 spec §52 and §53.
 *
 * GAME_RULES_LOCKED.md §9 (one deal per round, predefined templates) and §17
 * (the steal wager). D-009.
 */

const TEAM_A = asTeamId('TEAM_A');
const TEAM_B = asTeamId('TEAM_B');
const TEAMS = [TEAM_A, TEAM_B];

function setup(bb = 1_000) {
  const clock = new FakeClock(1_000);
  let counter = 0;
  const mintId = () => `id-${(counter += 1)}`;
  const ledger = new BbLedger(clock, mintId);
  ledger.seed(TEAM_A, bb);
  ledger.seed(TEAM_B, bb);
  const deals = new Deals({ clock, ledger, mintId });
  return { clock, ledger, deals };
}

describe('the locked deal templates', () => {
  it('has exactly the four templates the spec lists', () => {
    // Phase 6 spec §38 — "Do not invent additional Host Deal templates."
    expect([...HOST_DEAL_TEMPLATES].sort()).toEqual(
      ['KEEP_OR_RISK', 'DOUBLE_OR_NOTHING_ISH', 'MYSTERY_DEAL', 'OPPONENTS_DEAL'].sort(),
    );
  });

  it('KEEP OR RISK keeps 500 or gives it up for a Maco draw', () => {
    const terms = HOST_DEAL_TERMS.KEEP_OR_RISK;
    expect(terms.declineBb).toBe(500);
    expect(terms.acceptGrantsMacoDraw).toBe(true);
    // The team never receives the 500, so accepting costs nothing FROM the
    // balance — modelling it as a deduction would wrongly charge a team holding
    // under 500.
    expect(terms.acceptCostBb).toBe(0);
  });

  it('DOUBLE OR NOTHING-ISH risks 500 for 1,000 or nothing', () => {
    const terms = HOST_DEAL_TERMS.DOUBLE_OR_NOTHING_ISH;
    expect(terms.declineBb).toBe(500);
    expect(terms.acceptCreatesPendingBet).toBe(true);
    expect(terms.pendingBetWinBb).toBe(1_000);
    expect(terms.pendingBetLoseBb).toBe(0);
  });

  it('MYSTERY DEAL costs 300 for a Maco draw', () => {
    const terms = HOST_DEAL_TERMS.MYSTERY_DEAL;
    expect(terms.acceptCostBb).toBe(300);
    expect(terms.acceptGrantsMacoDraw).toBe(true);
    expect(terms.declineBb).toBe(0);
  });

  it("OPPONENT'S DEAL takes 500 or pays an opponent 250 for a Maco draw", () => {
    const terms = HOST_DEAL_TERMS.OPPONENTS_DEAL;
    expect(terms.declineBb).toBe(500);
    expect(terms.acceptPaysOpponentBb).toBe(250);
    expect(terms.acceptGrantsMacoDraw).toBe(true);
    expect(terms.requiresOpponent).toBe(true);
  });
});

describe('one deal per round — D-009', () => {
  it('allows one deal in a round', () => {
    const { deals } = setup();
    const offered = deals.offer({
      template: 'KEEP_OR_RISK',
      teamId: TEAM_A,
      roundIndex: 1,
      knownTeamIds: TEAMS,
    });
    expect(offered.ok).toBe(true);
  });

  it('refuses a SECOND deal in the same round', () => {
    // GAME_RULES_LOCKED.md §9 — "Maximum one Host Deal per round."
    const { deals } = setup();
    deals.offer({ template: 'KEEP_OR_RISK', teamId: TEAM_A, roundIndex: 1, knownTeamIds: TEAMS });

    const second = deals.offer({
      template: 'MYSTERY_DEAL',
      teamId: TEAM_B,
      roundIndex: 1,
      knownTeamIds: TEAMS,
    });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('ILLEGAL_ACTION');
  });

  it('counts an UNANSWERED deal against the round', () => {
    // Otherwise a Host could offer four deals and let the team pick the best.
    const { deals } = setup();
    deals.offer({ template: 'KEEP_OR_RISK', teamId: TEAM_A, roundIndex: 1, knownTeamIds: TEAMS });

    expect(
      deals.offer({ template: 'KEEP_OR_RISK', teamId: TEAM_A, roundIndex: 1, knownTeamIds: TEAMS })
        .ok,
    ).toBe(false);
  });

  it('allows a deal again in the NEXT round', () => {
    const { deals } = setup();
    deals.offer({ template: 'KEEP_OR_RISK', teamId: TEAM_A, roundIndex: 1, knownTeamIds: TEAMS });

    expect(
      deals.offer({ template: 'MYSTERY_DEAL', teamId: TEAM_A, roundIndex: 2, knownTeamIds: TEAMS })
        .ok,
    ).toBe(true);
  });
});

describe('deal validation', () => {
  it('refuses an unknown team', () => {
    const { deals } = setup();
    const offered = deals.offer({
      template: 'KEEP_OR_RISK',
      teamId: asTeamId('TEAM_Z'),
      roundIndex: 1,
      knownTeamIds: TEAMS,
    });
    expect(offered.ok).toBe(false);
  });

  it("requires an opponent for OPPONENT'S DEAL", () => {
    const { deals } = setup();
    const offered = deals.offer({
      template: 'OPPONENTS_DEAL',
      teamId: TEAM_A,
      roundIndex: 1,
      knownTeamIds: TEAMS,
    });
    expect(offered.ok).toBe(false);
  });

  it('refuses a team as its own opponent', () => {
    const { deals } = setup();
    const offered = deals.offer({
      template: 'OPPONENTS_DEAL',
      teamId: TEAM_A,
      opponentTeamId: TEAM_A,
      roundIndex: 1,
      knownTeamIds: TEAMS,
    });
    expect(offered.ok).toBe(false);
  });

  it('refuses MYSTERY DEAL a team cannot afford', () => {
    // Phase 6 spec §38 — affordability where payment is required.
    const { deals } = setup(200);
    const offered = deals.offer({
      template: 'MYSTERY_DEAL',
      teamId: TEAM_A,
      roundIndex: 1,
      knownTeamIds: TEAMS,
    });
    expect(offered.ok).toBe(false);
  });
});

describe('answering a deal', () => {
  it('pays the safe side on decline', () => {
    const { deals, ledger } = setup();
    const offered = deals.offer({
      template: 'KEEP_OR_RISK',
      teamId: TEAM_A,
      roundIndex: 1,
      knownTeamIds: TEAMS,
    });
    if (!offered.ok) throw new Error('offer failed');

    const answered = deals.respond({
      dealId: offered.value.dealId,
      teamId: TEAM_A,
      choice: 'decline',
    });

    expect(answered.ok).toBe(true);
    expect(ledger.balanceOf(TEAM_A)).toBe(1_500);
    if (answered.ok) expect(answered.value.grantsMacoDraw).toBe(false);
  });

  it('grants a Maco draw on accept, and pays nothing', () => {
    const { deals, ledger } = setup();
    const offered = deals.offer({
      template: 'KEEP_OR_RISK',
      teamId: TEAM_A,
      roundIndex: 1,
      knownTeamIds: TEAMS,
    });
    if (!offered.ok) throw new Error('offer failed');

    const answered = deals.respond({
      dealId: offered.value.dealId,
      teamId: TEAM_A,
      choice: 'accept',
    });

    expect(answered.ok).toBe(true);
    if (answered.ok) expect(answered.value.grantsMacoDraw).toBe(true);
    // The 500 was never received, so the balance is untouched.
    expect(ledger.balanceOf(TEAM_A)).toBe(1_000);
  });

  it('charges MYSTERY DEAL through the ledger', () => {
    const { deals, ledger } = setup();
    const offered = deals.offer({
      template: 'MYSTERY_DEAL',
      teamId: TEAM_A,
      roundIndex: 1,
      knownTeamIds: TEAMS,
    });
    if (!offered.ok) throw new Error('offer failed');

    deals.respond({ dealId: offered.value.dealId, teamId: TEAM_A, choice: 'accept' });

    expect(ledger.balanceOf(TEAM_A)).toBe(700);
    expect(ledger.entriesFor(TEAM_A).some((e) => e.reason === 'host_deal')).toBe(true);
  });

  it("pays the opponent on OPPONENT'S DEAL", () => {
    const { deals, ledger } = setup();
    const offered = deals.offer({
      template: 'OPPONENTS_DEAL',
      teamId: TEAM_A,
      opponentTeamId: TEAM_B,
      roundIndex: 1,
      knownTeamIds: TEAMS,
    });
    if (!offered.ok) throw new Error('offer failed');

    deals.respond({ dealId: offered.value.dealId, teamId: TEAM_A, choice: 'accept' });

    expect(ledger.balanceOf(TEAM_B)).toBe(1_250);
    expect(ledger.balanceOf(TEAM_A)).toBe(1_000);
  });

  it('refuses a second answer to the same deal', () => {
    // Otherwise a team could take both sides.
    const { deals } = setup();
    const offered = deals.offer({
      template: 'KEEP_OR_RISK',
      teamId: TEAM_A,
      roundIndex: 1,
      knownTeamIds: TEAMS,
    });
    if (!offered.ok) throw new Error('offer failed');

    expect(
      deals.respond({ dealId: offered.value.dealId, teamId: TEAM_A, choice: 'decline' }).ok,
    ).toBe(true);
    expect(
      deals.respond({ dealId: offered.value.dealId, teamId: TEAM_A, choice: 'accept' }).ok,
    ).toBe(false);
  });

  it('refuses an answer from the wrong team', () => {
    const { deals } = setup();
    const offered = deals.offer({
      template: 'KEEP_OR_RISK',
      teamId: TEAM_A,
      roundIndex: 1,
      knownTeamIds: TEAMS,
    });
    if (!offered.ok) throw new Error('offer failed');

    const answered = deals.respond({
      dealId: offered.value.dealId,
      teamId: TEAM_B,
      choice: 'decline',
    });

    expect(answered.ok).toBe(false);
    if (!answered.ok) expect(answered.error.code).toBe('UNAUTHORIZED_ACTOR');
  });

  it('settles a DOUBLE OR NOTHING-ISH bet exactly once', () => {
    const { deals, ledger } = setup();
    const offered = deals.offer({
      template: 'DOUBLE_OR_NOTHING_ISH',
      teamId: TEAM_A,
      roundIndex: 1,
      knownTeamIds: TEAMS,
    });
    if (!offered.ok) throw new Error('offer failed');

    deals.respond({ dealId: offered.value.dealId, teamId: TEAM_A, choice: 'accept' });
    // Nothing moves until the next answer is judged.
    expect(ledger.balanceOf(TEAM_A)).toBe(1_000);

    expect(deals.settlePendingBet({ dealId: offered.value.dealId, won: true }).ok).toBe(true);
    expect(ledger.balanceOf(TEAM_A)).toBe(2_000);

    // Settling twice would pay twice.
    expect(deals.settlePendingBet({ dealId: offered.value.dealId, won: true }).ok).toBe(false);
  });

  it('pays nothing for a lost bet', () => {
    // "wrong = 0" — the team keeps what it had and forgoes the 500 it declined.
    const { deals, ledger } = setup();
    const offered = deals.offer({
      template: 'DOUBLE_OR_NOTHING_ISH',
      teamId: TEAM_A,
      roundIndex: 1,
      knownTeamIds: TEAMS,
    });
    if (!offered.ok) throw new Error('offer failed');

    deals.respond({ dealId: offered.value.dealId, teamId: TEAM_A, choice: 'accept' });
    deals.settlePendingBet({ dealId: offered.value.dealId, won: false });

    expect(ledger.balanceOf(TEAM_A)).toBe(1_000);
  });
});

describe('the generic wager', () => {
  it('caps a wager at 50% of current BB', () => {
    // GAME_RULES_LOCKED.md §17 — "up to 50% of current BB".
    expect(MAX_WAGER_FRACTION).toBe(0.5);
    expect(maxWagerFor(1_000)).toBe(500);
    expect(maxWagerFor(999)).toBe(499); // floored, never over the ceiling
    expect(maxWagerFor(0)).toBe(0);
  });

  it('accepts a wager at exactly the maximum', () => {
    const { deals } = setup();
    const locked = deals.proposeWager({ teamId: TEAM_A, amount: 500 });

    expect(locked.ok).toBe(true);
    if (locked.ok) {
      expect(locked.value.status).toBe('locked');
      expect(locked.value.maxAllowed).toBe(500);
      expect(locked.value.balanceAtLock).toBe(1_000);
    }
  });

  it('refuses a wager above the maximum', () => {
    const { deals } = setup();
    const locked = deals.proposeWager({ teamId: TEAM_A, amount: 501 });

    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.error.code).toBe('ILLEGAL_ACTION');
  });

  it('refuses a negative or fractional wager', () => {
    const { deals } = setup();
    expect(deals.proposeWager({ teamId: TEAM_A, amount: -100 }).ok).toBe(false);
    expect(deals.proposeWager({ teamId: TEAM_A, amount: 12.5 }).ok).toBe(false);
  });

  it('refuses a second live wager for the same team', () => {
    const { deals } = setup();
    expect(deals.proposeWager({ teamId: TEAM_A, amount: 100 }).ok).toBe(true);
    expect(deals.proposeWager({ teamId: TEAM_A, amount: 100 }).ok).toBe(false);
  });

  it('pays a won wager through the ledger', () => {
    const { deals, ledger } = setup();
    const locked = deals.proposeWager({ teamId: TEAM_A, amount: 400 });
    if (!locked.ok) throw new Error('wager failed');

    const resolved = deals.resolveWager({ wagerId: locked.value.wagerId, won: true });

    expect(resolved.ok).toBe(true);
    expect(ledger.balanceOf(TEAM_A)).toBe(1_400);
    if (resolved.ok) expect(resolved.value.status).toBe('won');
    expect(ledger.entriesFor(TEAM_A).some((e) => e.reason === 'wager')).toBe(true);
  });

  it('deducts a lost wager through the ledger', () => {
    const { deals, ledger } = setup();
    const locked = deals.proposeWager({ teamId: TEAM_A, amount: 400 });
    if (!locked.ok) throw new Error('wager failed');

    deals.resolveWager({ wagerId: locked.value.wagerId, won: false });

    expect(ledger.balanceOf(TEAM_A)).toBe(600);
  });

  it('resolves exactly once', () => {
    const { deals, ledger } = setup();
    const locked = deals.proposeWager({ teamId: TEAM_A, amount: 400 });
    if (!locked.ok) throw new Error('wager failed');

    expect(deals.resolveWager({ wagerId: locked.value.wagerId, won: true }).ok).toBe(true);
    expect(deals.resolveWager({ wagerId: locked.value.wagerId, won: true }).ok).toBe(false);
    // Paid once, not twice.
    expect(ledger.balanceOf(TEAM_A)).toBe(1_400);
  });

  it('floors at zero when the balance fell after locking', () => {
    // §17 — "BB floor is 0". The wager stays valid at the amount that was legal
    // when locked; the floor catches the rest.
    const { deals, ledger } = setup();
    const locked = deals.proposeWager({ teamId: TEAM_A, amount: 500 });
    if (!locked.ok) throw new Error('wager failed');

    // Something else takes their money before the wager resolves.
    ledger.apply({ teamId: TEAM_A, delta: -800, reason: 'maco_mail' });
    expect(ledger.balanceOf(TEAM_A)).toBe(200);

    deals.resolveWager({ wagerId: locked.value.wagerId, won: false });

    expect(ledger.balanceOf(TEAM_A)).toBe(0);
  });

  it('keeps a locked wager valid even if the balance falls', () => {
    // Re-checking the 50% rule at resolution would let an unrelated event void
    // a legitimately placed bet.
    const { deals, ledger } = setup();
    const locked = deals.proposeWager({ teamId: TEAM_A, amount: 500 });
    if (!locked.ok) throw new Error('wager failed');

    ledger.apply({ teamId: TEAM_A, delta: -600, reason: 'maco_mail' });
    const resolved = deals.resolveWager({ wagerId: locked.value.wagerId, won: true });

    expect(resolved.ok).toBe(true);
  });

  it('cancels a wager without moving BB', () => {
    const { deals, ledger } = setup();
    const locked = deals.proposeWager({ teamId: TEAM_A, amount: 400 });
    if (!locked.ok) throw new Error('wager failed');

    expect(deals.cancelWager(locked.value.wagerId).ok).toBe(true);
    expect(ledger.balanceOf(TEAM_A)).toBe(1_000);
    expect(deals.resolveWager({ wagerId: locked.value.wagerId, won: true }).ok).toBe(false);
  });

  it('reports the current maximum for a team', () => {
    const { deals, ledger } = setup();
    expect(deals.maxWagerFor(TEAM_A)).toBe(500);

    ledger.apply({ teamId: TEAM_A, delta: -500, reason: 'maco_mail' });
    expect(deals.maxWagerFor(TEAM_A)).toBe(250);
  });
});
