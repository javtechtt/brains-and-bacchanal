import { describe, expect, it } from 'vitest';
import { asPlayerId, asSessionId, type Actor } from '@bb/protocol';
import { applyTransition, initialPhaseState, type PhaseState } from './transitions.js';

const HOST: Actor = { kind: 'host', sessionId: asSessionId('s-host') };
const PLAYER: Actor = {
  kind: 'player',
  sessionId: asSessionId('s-p1'),
  playerId: asPlayerId('p1'),
};
const ADMIN: Actor = { kind: 'admin', sessionId: asSessionId('s-admin') };
const SERVER: Actor = { kind: 'server' };

/** Walk a sequence of legal advances, failing loudly if any is rejected. */
function advanceThrough(from: PhaseState, phases: readonly Parameters<typeof applyTransition>[1][]) {
  let state = from;
  for (const action of phases) {
    const outcome = applyTransition(state, action, SERVER);
    if (!outcome.ok) throw new Error(`unexpected rejection: ${outcome.error.code}`);
    state = outcome.state;
  }
  return state;
}

describe('legal transitions', () => {
  it('starts at BOOT', () => {
    expect(initialPhaseState().phase).toBe('BOOT');
  });

  it('advances BOOT -> LOBBY -> TEAM_LOCK', () => {
    const state = advanceThrough(initialPhaseState(), [
      { kind: 'advance', to: 'LOBBY' },
      { kind: 'advance', to: 'TEAM_LOCK' },
    ]);
    expect(state.phase).toBe('TEAM_LOCK');
  });

  it('reaches ACTIVE_PLAY through the documented flow', () => {
    const state = advanceThrough(initialPhaseState(), [
      { kind: 'advance', to: 'LOBBY' },
      { kind: 'advance', to: 'TEAM_LOCK' },
      { kind: 'advance', to: 'ROUND_INTRO' },
      { kind: 'advance', to: 'CHALLENGE_INTRO' },
      { kind: 'advance', to: 'ACTIVE_PLAY' },
    ]);
    expect(state.phase).toBe('ACTIVE_PLAY');
  });
});

describe('illegal transitions', () => {
  it('rejects skipping from LOBBY straight to ACTIVE_PLAY', () => {
    const outcome = applyTransition(
      { phase: 'LOBBY', resumePhase: null, pauseReason: null },
      { kind: 'advance', to: 'ACTIVE_PLAY' },
      SERVER,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('ILLEGAL_ACTION');
  });

  it('rejects GAME_OVER -> ACTIVE_PLAY', () => {
    const outcome = applyTransition(
      { phase: 'GAME_OVER', resumePhase: null, pauseReason: null },
      { kind: 'advance', to: 'ACTIVE_PLAY' },
      SERVER,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('WRONG_STATE');
  });

  it('leaves state unchanged when an advance is rejected', () => {
    const before: PhaseState = { phase: 'LOBBY', resumePhase: null, pauseReason: null };
    const outcome = applyTransition(before, { kind: 'advance', to: 'GAME_OVER' }, SERVER);
    expect(outcome.ok).toBe(false);
    // Pure function: the caller's state object is untouched.
    expect(before.phase).toBe('LOBBY');
  });
});

// GAME_RULES_LOCKED.md §22, DECISION_LOG.md D-011
describe('pause', () => {
  it('records the phase to return to', () => {
    const outcome = applyTransition(
      { phase: 'ACTIVE_PLAY', resumePhase: null, pauseReason: null },
      { kind: 'pause', reason: 'player_disconnect' },
      SERVER,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.state.phase).toBe('PAUSED');
      expect(outcome.state.resumePhase).toBe('ACTIVE_PLAY');
      expect(outcome.state.pauseReason).toBe('player_disconnect');
    }
  });

  it('rejects pausing twice', () => {
    const outcome = applyTransition(
      { phase: 'PAUSED', resumePhase: 'ACTIVE_PLAY', pauseReason: 'host_requested' },
      { kind: 'pause', reason: 'host_requested' },
      SERVER,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('WRONG_STATE');
  });

  it('rejects pausing a finished game', () => {
    const outcome = applyTransition(
      { phase: 'GAME_OVER', resumePhase: null, pauseReason: null },
      { kind: 'pause', reason: 'host_requested' },
      SERVER,
    );
    expect(outcome.ok).toBe(false);
  });

  it('does not allow gameplay to advance past a pause', () => {
    const outcome = applyTransition(
      { phase: 'PAUSED', resumePhase: 'ACTIVE_PLAY', pauseReason: 'player_disconnect' },
      { kind: 'advance', to: 'RESULT' },
      SERVER,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('WRONG_STATE');
  });
});

// "only the Host can resume" — GAME_RULES_LOCKED.md §22
describe('resume authority', () => {
  const paused: PhaseState = {
    phase: 'PAUSED',
    resumePhase: 'ACTIVE_PLAY',
    pauseReason: 'player_disconnect',
  };

  it('lets the Host resume to the previous phase', () => {
    const outcome = applyTransition(paused, { kind: 'resume' }, HOST);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.state.phase).toBe('ACTIVE_PLAY');
      expect(outcome.state.resumePhase).toBeNull();
    }
  });

  it('rejects a player resuming', () => {
    const outcome = applyTransition(paused, { kind: 'resume' }, PLAYER);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('UNAUTHORIZED_ACTOR');
  });

  it('rejects an admin resuming', () => {
    // Admin is not Host. CLAUDE.md assigns resume authority to the Host.
    const outcome = applyTransition(paused, { kind: 'resume' }, ADMIN);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('UNAUTHORIZED_ACTOR');
  });

  it('rejects the server resuming on its own', () => {
    // A reconnect is a server-side event. It must never auto-resume:
    // "reconnecting does not automatically resume gameplay".
    const outcome = applyTransition(paused, { kind: 'resume' }, SERVER);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('UNAUTHORIZED_ACTOR');
  });

  it('rejects resuming a game that is not paused', () => {
    const outcome = applyTransition(
      { phase: 'ACTIVE_PLAY', resumePhase: null, pauseReason: null },
      { kind: 'resume' },
      HOST,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('WRONG_STATE');
  });

  it('returns to the exact phase play was suspended from', () => {
    // The Host may pause during the Market or a Host review, not only play.
    for (const phase of ['MARKET', 'HOST_REVIEW', 'SUDDEN_DEATH'] as const) {
      const p = applyTransition(
        { phase, resumePhase: null, pauseReason: null },
        { kind: 'pause', reason: 'host_requested' },
        HOST,
      );
      expect(p.ok).toBe(true);
      if (!p.ok) continue;

      const r = applyTransition(p.state, { kind: 'resume' }, HOST);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.state.phase).toBe(phase);
    }
  });
});
