import { describe, expect, it } from 'vitest';
import {
  asChallengeId,
  asServerTimestamp,
  asTeamId,
  categoryBeats,
  CLASH_RESPONSE_WINDOW_MS,
  type BacchanalCardType,
  type TeamId,
} from '@bb/protocol';
import { ClashEngine, resolveClashEntries, type ClashEntry } from './clash.js';
import { FakeClock } from './clock.js';

/**
 * Bacchanal Clash and Part Dat Fight. Phase 6 spec §48.
 *
 * GAME_RULES_LOCKED.md §5. The triangle cases are tested against the pure
 * resolver, which needs no clock and no card system; the window and the hidden
 * responses are tested against the stateful engine on a FakeClock.
 */

const TEAM_A = asTeamId('TEAM_A');
const TEAM_B = asTeamId('TEAM_B');
const TEAM_C = asTeamId('TEAM_C');
const CHALLENGE = asChallengeId('challenge-1');
const AT = asServerTimestamp(5_000);

/** A card of a known category, so a test can name the triangle directly. */
const DISRUPTION: BacchanalCardType = 'STEUPS';
const POWER: BacchanalCardType = 'DOUBLE_IT';
const RECOVERY: BacchanalCardType = 'FORGIVE_MEH';

function entry(
  teamId: TeamId,
  cardType: BacchanalCardType,
  initiator = false,
  targetTeamId: TeamId | null = null,
): ClashEntry {
  const category =
    cardType === DISRUPTION ? 'DISRUPTION' : cardType === POWER ? 'POWER' : 'RECOVERY';
  return {
    teamId,
    cardInstanceId: `card-${teamId}`,
    cardType,
    category,
    initiator,
    targetTeamId,
  };
}

describe('the category triangle', () => {
  // GAME_RULES_LOCKED.md §5.
  it('has Disruption beat Power', () => {
    expect(categoryBeats('DISRUPTION', 'POWER')).toBe(true);
    expect(categoryBeats('POWER', 'DISRUPTION')).toBe(false);
  });

  it('has Power beat Recovery', () => {
    expect(categoryBeats('POWER', 'RECOVERY')).toBe(true);
    expect(categoryBeats('RECOVERY', 'POWER')).toBe(false);
  });

  it('has Recovery beat Disruption', () => {
    expect(categoryBeats('RECOVERY', 'DISRUPTION')).toBe(true);
    expect(categoryBeats('DISRUPTION', 'RECOVERY')).toBe(false);
  });

  it('is a closed cycle with no strongest category', () => {
    // The reason a tie needs its own outcome rather than a tiebreak.
    expect(categoryBeats('DISRUPTION', 'DISRUPTION')).toBe(false);
    expect(categoryBeats('POWER', 'POWER')).toBe(false);
    expect(categoryBeats('RECOVERY', 'RECOVERY')).toBe(false);
  });
});

describe('two-team Clash', () => {
  it('resolves the original card when nobody counters', () => {
    // §5 — "No response → original card resolves."
    const result = resolveClashEntries([entry(TEAM_A, POWER, true)], AT);

    expect(result.outcome).toBe('uncontested');
    expect(result.winningTeamId).toBe(TEAM_A);
    expect(result.returnedTeamIds).toEqual([]);
  });

  it('lets Disruption beat Power', () => {
    const result = resolveClashEntries(
      [entry(TEAM_A, POWER, true), entry(TEAM_B, DISRUPTION)],
      AT,
    );

    expect(result.outcome).toBe('winner');
    expect(result.winningTeamId).toBe(TEAM_B);
    expect(result.winningCardType).toBe(DISRUPTION);
    // §5 — "Losing card returns."
    expect(result.returnedTeamIds).toEqual([TEAM_A]);
  });

  it('lets Power beat Recovery', () => {
    const result = resolveClashEntries(
      [entry(TEAM_A, RECOVERY, true), entry(TEAM_B, POWER)],
      AT,
    );

    expect(result.outcome).toBe('winner');
    expect(result.winningTeamId).toBe(TEAM_B);
    expect(result.returnedTeamIds).toEqual([TEAM_A]);
  });

  it('lets Recovery beat Disruption', () => {
    const result = resolveClashEntries(
      [entry(TEAM_A, DISRUPTION, true), entry(TEAM_B, RECOVERY)],
      AT,
    );

    expect(result.outcome).toBe('winner');
    expect(result.winningTeamId).toBe(TEAM_B);
    expect(result.returnedTeamIds).toEqual([TEAM_A]);
  });

  it('lets the INITIATOR win when its category is stronger', () => {
    // Nothing privileges the initiator; the triangle decides both ways.
    const result = resolveClashEntries(
      [entry(TEAM_A, DISRUPTION, true), entry(TEAM_B, POWER)],
      AT,
    );

    expect(result.winningTeamId).toBe(TEAM_A);
    expect(result.returnedTeamIds).toEqual([TEAM_B]);
  });

  it('calls a same-category tie PART DAT FIGHT', () => {
    // §5 — "If surviving categories tie → PART DAT FIGHT! No effect resolves.
    // Tied cards return."
    const result = resolveClashEntries(
      [entry(TEAM_A, POWER, true), entry(TEAM_B, POWER)],
      AT,
    );

    expect(result.outcome).toBe('part_dat_fight');
    expect(result.winningTeamId).toBeNull();
    expect(result.winningCardType).toBeNull();
    expect(result.returnedTeamIds.sort()).toEqual([TEAM_A, TEAM_B].sort());
    expect(result.entries.every((e) => !e.survived)).toBe(true);
  });
});

describe('three-team Clash', () => {
  it('is PART DAT FIGHT when all three categories are represented', () => {
    // §5 — "all three categories → Part Dat Fight". A closed cycle: every card
    // beats one and loses to another, so nothing is unbeaten.
    const result = resolveClashEntries(
      [entry(TEAM_A, DISRUPTION, true), entry(TEAM_B, POWER), entry(TEAM_C, RECOVERY)],
      AT,
    );

    expect(result.outcome).toBe('part_dat_fight');
    expect(result.returnedTeamIds.sort()).toEqual([TEAM_A, TEAM_B, TEAM_C].sort());
  });

  it('is PART DAT FIGHT when all three are the same category', () => {
    // §5 — "all three same category → Part Dat Fight".
    const result = resolveClashEntries(
      [entry(TEAM_A, POWER, true), entry(TEAM_B, POWER), entry(TEAM_C, POWER)],
      AT,
    );

    expect(result.outcome).toBe('part_dat_fight');
    expect(result.returnedTeamIds).toHaveLength(3);
  });

  it('lets a single card win when its category beats the pair', () => {
    // §5 — "if single category wins, single card wins."
    // Two POWER, one DISRUPTION. Disruption beats Power.
    const result = resolveClashEntries(
      [entry(TEAM_A, POWER, true), entry(TEAM_B, POWER), entry(TEAM_C, DISRUPTION)],
      AT,
    );

    expect(result.outcome).toBe('winner');
    expect(result.winningTeamId).toBe(TEAM_C);
    expect(result.winningCardType).toBe(DISRUPTION);
    // Both losers return.
    expect(result.returnedTeamIds.sort()).toEqual([TEAM_A, TEAM_B].sort());
  });

  it('eliminates the single card then PART DAT FIGHTs the surviving pair', () => {
    // §5 — "if paired category wins, single card is eliminated and surviving
    // pair causes Part Dat Fight." Two DISRUPTION, one POWER. Disruption beats
    // Power, so the pair survives — and then ties with itself.
    const result = resolveClashEntries(
      [entry(TEAM_A, POWER, true), entry(TEAM_B, DISRUPTION), entry(TEAM_C, DISRUPTION)],
      AT,
    );

    expect(result.outcome).toBe('part_dat_fight');
    expect(result.winningTeamId).toBeNull();
    // No effect resolves at all — not even for the surviving pair.
    expect(result.entries.every((e) => !e.survived)).toBe(true);
    // Every card returns, the eliminated single included.
    expect(result.returnedTeamIds.sort()).toEqual([TEAM_A, TEAM_B, TEAM_C].sort());
  });
});

describe('the three-second response window', () => {
  function makeClash(clock: FakeClock) {
    let counter = 0;
    return new ClashEngine({ clock, mintId: () => `clash-${(counter += 1)}` });
  }

  function open(engine: ClashEngine, eligible: TeamId[] = [TEAM_B]) {
    return engine.open({
      challengeId: CHALLENGE,
      initiatingTeamId: TEAM_A,
      cardInstanceId: 'card-a',
      cardType: POWER,
      targetTeamId: null,
      eligibleTeamIds: eligible,
    });
  }

  it('is exactly three seconds', () => {
    // GAME_RULES_LOCKED.md §5 — one of the few locked durations in the game.
    expect(CLASH_RESPONSE_WINDOW_MS).toBe(3_000);
  });

  it('accepts a response inside the window', () => {
    const clock = new FakeClock(1_000);
    const engine = makeClash(clock);
    open(engine);

    clock.advance(2_999);
    const responded = engine.respond({
      teamId: TEAM_B,
      cardInstanceId: 'card-b',
      cardType: DISRUPTION,
      targetTeamId: null,
    });

    expect(responded.ok).toBe(true);
  });

  it('refuses a response after the window closes', () => {
    const clock = new FakeClock(1_000);
    const engine = makeClash(clock);
    open(engine);

    clock.advance(3_001);
    const responded = engine.respond({
      teamId: TEAM_B,
      cardInstanceId: 'card-b',
      cardType: DISRUPTION,
      targetTeamId: null,
    });

    expect(responded.ok).toBe(false);
    if (!responded.ok) expect(responded.error.code).toBe('WRONG_STATE');
  });

  it('refuses a second response from the same team', () => {
    // Locked before reveal — a team cannot probe and revise.
    const clock = new FakeClock(1_000);
    const engine = makeClash(clock);
    open(engine);

    engine.respond({ teamId: TEAM_B, cardInstanceId: 'card-b', cardType: DISRUPTION, targetTeamId: null });
    const second = engine.respond({
      teamId: TEAM_B,
      cardInstanceId: 'card-b2',
      cardType: RECOVERY,
      targetTeamId: null,
    });

    expect(second.ok).toBe(false);
  });

  it('refuses a response from a team with no eligible card', () => {
    // Phase 6 spec §9 — "illegal counter must not be selectable", and the server
    // refuses it even so.
    const clock = new FakeClock(1_000);
    const engine = makeClash(clock);
    open(engine, [TEAM_B]);

    const responded = engine.respond({
      teamId: TEAM_C,
      cardInstanceId: 'card-c',
      cardType: DISRUPTION,
      targetTeamId: null,
    });

    expect(responded.ok).toBe(false);
  });

  it('refuses the initiator responding to its own card', () => {
    const clock = new FakeClock(1_000);
    const engine = makeClash(clock);
    open(engine, [TEAM_A, TEAM_B]);

    const responded = engine.respond({
      teamId: TEAM_A,
      cardInstanceId: 'card-a2',
      cardType: DISRUPTION,
      targetTeamId: null,
    });

    expect(responded.ok).toBe(false);
  });

  it('refuses to resolve while the window is still running', () => {
    const clock = new FakeClock(1_000);
    const engine = makeClash(clock);
    open(engine);

    clock.advance(1_000);
    expect(engine.resolve().ok).toBe(false);
  });

  it('resolves early once every eligible team has responded', () => {
    // Nothing is left to wait for; making the room sit out the clock serves
    // nobody.
    const clock = new FakeClock(1_000);
    const engine = makeClash(clock);
    open(engine, [TEAM_B]);

    engine.respond({ teamId: TEAM_B, cardInstanceId: 'card-b', cardType: DISRUPTION, targetTeamId: null });
    const resolved = engine.resolve();

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.winningTeamId).toBe(TEAM_B);
  });

  it('resolves the same way twice', () => {
    // A tick and an intent can close the window in the same instant.
    const clock = new FakeClock(1_000);
    const engine = makeClash(clock);
    open(engine);
    clock.advance(3_001);

    const first = engine.resolve();
    const second = engine.resolve();

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.outcome).toBe(first.value.outcome);
      expect(second.value.resolvedAt).toBe(first.value.resolvedAt);
    }
  });

  it('freezes the window while the game is paused', () => {
    // D-011 — a paused game's timers do not run down.
    const clock = new FakeClock(1_000);
    const engine = makeClash(clock);
    open(engine);

    clock.advance(1_000);
    engine.pause();
    clock.advance(60_000);
    engine.resume();

    expect(engine.windowExpired()).toBe(false);
    const responded = engine.respond({
      teamId: TEAM_B,
      cardInstanceId: 'card-b',
      cardType: DISRUPTION,
      targetTeamId: null,
    });
    expect(responded.ok).toBe(true);
  });
});

describe('hidden responses', () => {
  function makeClash(clock: FakeClock) {
    let counter = 0;
    return new ClashEngine({ clock, mintId: () => `clash-${(counter += 1)}` });
  }

  it('never reveals a response card type before the reveal', () => {
    // Phase 6 spec §42 — "hidden Clash responses before reveal".
    const clock = new FakeClock(1_000);
    const engine = makeClash(clock);
    engine.open({
      challengeId: CHALLENGE,
      initiatingTeamId: TEAM_A,
      cardInstanceId: 'card-a',
      cardType: POWER,
      targetTeamId: null,
      eligibleTeamIds: [TEAM_B],
    });

    engine.respond({
      teamId: TEAM_B,
      cardInstanceId: 'card-b',
      cardType: DISRUPTION,
      targetTeamId: null,
    });

    const view = engine.view();
    expect(view).not.toBeNull();
    // WHO responded is public — it is part of the theatre.
    expect(view?.respondedTeamIds).toEqual([TEAM_B]);
    // WHAT they responded with is not, anywhere in the serialised view.
    expect(view?.result).toBeNull();
    expect(JSON.stringify(view)).not.toContain(DISRUPTION);
    expect(JSON.stringify(view)).not.toContain('card-b');
  });

  it('reveals every card once resolved', () => {
    const clock = new FakeClock(1_000);
    const engine = makeClash(clock);
    engine.open({
      challengeId: CHALLENGE,
      initiatingTeamId: TEAM_A,
      cardInstanceId: 'card-a',
      cardType: POWER,
      targetTeamId: null,
      eligibleTeamIds: [TEAM_B],
    });
    engine.respond({ teamId: TEAM_B, cardInstanceId: 'card-b', cardType: DISRUPTION, targetTeamId: null });
    engine.resolve();

    const view = engine.view();
    expect(view?.result).not.toBeNull();
    expect(JSON.stringify(view)).toContain(DISRUPTION);
  });

  it('shows a team only its OWN locked response', () => {
    const clock = new FakeClock(1_000);
    const engine = makeClash(clock);
    engine.open({
      challengeId: CHALLENGE,
      initiatingTeamId: TEAM_A,
      cardInstanceId: 'card-a',
      cardType: POWER,
      targetTeamId: null,
      eligibleTeamIds: [TEAM_B, TEAM_C],
    });
    engine.respond({ teamId: TEAM_B, cardInstanceId: 'card-b', cardType: DISRUPTION, targetTeamId: null });

    expect(engine.responseOf(TEAM_B)).toBe('card-b');
    // TEAM_C has not responded, and cannot see TEAM_B's.
    expect(engine.responseOf(TEAM_C)).toBeNull();
  });
});
