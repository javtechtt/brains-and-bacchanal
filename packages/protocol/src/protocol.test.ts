import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, isSupportedProtocolVersion } from './version.js';
import { isActor, isEventEnvelope, isHostActor, isIntentEnvelope } from './envelope.js';
import { isLegalTransition, isTerminalPhase, legalNextPhases, GAME_PHASES } from './lifecycle.js';
import { asPlayerId, asSessionId } from './ids.js';
import { rejection } from './errors.js';

describe('protocol version', () => {
  it('is an integer', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
  });

  it('accepts its own version', () => {
    expect(isSupportedProtocolVersion(PROTOCOL_VERSION)).toBe(true);
  });

  it('rejects other versions cleanly', () => {
    expect(isSupportedProtocolVersion(PROTOCOL_VERSION + 1)).toBe(false);
    expect(isSupportedProtocolVersion(PROTOCOL_VERSION - 1)).toBe(false);
  });
});

describe('isIntentEnvelope', () => {
  const valid = {
    protocolVersion: PROTOCOL_VERSION,
    intentId: 'i-1',
    roomId: 'r-1',
    type: 'ADVANCE_PHASE',
    payload: { to: 'LOBBY' },
  };

  it('accepts a well-formed intent', () => {
    expect(isIntentEnvelope(valid)).toBe(true);
  });

  it('accepts an optional sessionId', () => {
    expect(isIntentEnvelope({ ...valid, sessionId: 's-1' })).toBe(true);
  });

  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      expect(isIntentEnvelope(bad)).toBe(false);
    }
  });

  it('rejects missing required fields', () => {
    for (const field of ['intentId', 'roomId', 'type', 'payload']) {
      const copy: Record<string, unknown> = { ...valid };
      delete copy[field];
      expect(isIntentEnvelope(copy)).toBe(false);
    }
  });

  it('rejects empty string identifiers', () => {
    expect(isIntentEnvelope({ ...valid, intentId: '' })).toBe(false);
    expect(isIntentEnvelope({ ...valid, roomId: '' })).toBe(false);
  });

  it('rejects a non-integer protocol version', () => {
    expect(isIntentEnvelope({ ...valid, protocolVersion: '1' })).toBe(false);
    expect(isIntentEnvelope({ ...valid, protocolVersion: 1.5 })).toBe(false);
  });

  it('rejects a malformed sessionId when present', () => {
    expect(isIntentEnvelope({ ...valid, sessionId: '' })).toBe(false);
    expect(isIntentEnvelope({ ...valid, sessionId: 7 })).toBe(false);
  });
});

describe('isActor', () => {
  it('accepts each valid actor kind', () => {
    expect(isActor({ kind: 'server' })).toBe(true);
    expect(isActor({ kind: 'host', sessionId: 's-1' })).toBe(true);
    expect(isActor({ kind: 'admin', sessionId: 's-1' })).toBe(true);
    expect(isActor({ kind: 'player', sessionId: 's-1', playerId: 'p-1' })).toBe(true);
  });

  it('rejects incomplete actors', () => {
    expect(isActor({ kind: 'host' })).toBe(false);
    expect(isActor({ kind: 'player', sessionId: 's-1' })).toBe(false);
    expect(isActor({ kind: 'nobody' })).toBe(false);
  });
});

describe('isHostActor', () => {
  it('recognises only the Host', () => {
    expect(isHostActor({ kind: 'host', sessionId: asSessionId('s-1') })).toBe(true);
    expect(isHostActor({ kind: 'server' })).toBe(false);
    // Admin is deliberately not Host: CLAUDE.md gives Host authority to the Host.
    expect(isHostActor({ kind: 'admin', sessionId: asSessionId('s-1') })).toBe(false);
    expect(
      isHostActor({ kind: 'player', sessionId: asSessionId('s-1'), playerId: asPlayerId('p-1') }),
    ).toBe(false);
  });
});

describe('isEventEnvelope', () => {
  const valid = {
    protocolVersion: PROTOCOL_VERSION,
    seq: 1,
    serverTime: 1_700_000_000_000,
    roomId: 'r-1',
    actor: { kind: 'server' },
    type: 'PHASE_ADVANCED',
    payload: { phase: 'LOBBY' },
  };

  it('accepts a well-formed event', () => {
    expect(isEventEnvelope(valid)).toBe(true);
  });

  it('rejects a non-integer sequence number', () => {
    expect(isEventEnvelope({ ...valid, seq: 1.5 })).toBe(false);
  });

  it('rejects a malformed actor', () => {
    expect(isEventEnvelope({ ...valid, actor: { kind: 'wat' } })).toBe(false);
  });
});

describe('lifecycle transitions', () => {
  it('allows LOBBY -> TEAM_LOCK', () => {
    expect(isLegalTransition('LOBBY', 'TEAM_LOCK')).toBe(true);
  });

  it('forbids GAME_OVER -> ACTIVE_PLAY', () => {
    expect(isLegalTransition('GAME_OVER', 'ACTIVE_PLAY')).toBe(false);
  });

  it('treats GAME_OVER as terminal', () => {
    expect(isTerminalPhase('GAME_OVER')).toBe(true);
    expect(legalNextPhases('GAME_OVER')).toHaveLength(0);
  });

  it('forbids skipping the lobby', () => {
    expect(isLegalTransition('BOOT', 'ACTIVE_PLAY')).toBe(false);
    expect(isLegalTransition('LOBBY', 'ACTIVE_PLAY')).toBe(false);
  });

  it('never lists PAUSED as an ordinary destination', () => {
    // Pausing is not an ordinary transition; it is handled by the pause model
    // so that the Host-only resume rule has a single implementation.
    for (const phase of GAME_PHASES) {
      expect(legalNextPhases(phase)).not.toContain('PAUSED');
    }
  });

  it('has no outgoing transitions from PAUSED', () => {
    expect(legalNextPhases('PAUSED')).toHaveLength(0);
  });

  it('only names known phases as destinations', () => {
    const known = new Set<string>(GAME_PHASES);
    for (const phase of GAME_PHASES) {
      for (const next of legalNextPhases(phase)) {
        expect(known.has(next)).toBe(true);
      }
    }
  });
});

describe('rejection', () => {
  it('carries a machine-readable code', () => {
    const r = rejection('ILLEGAL_ACTION', 'nope');
    expect(r.code).toBe('ILLEGAL_ACTION');
    expect(r).not.toHaveProperty('details');
  });

  it('carries optional details', () => {
    const r = rejection('WRONG_STATE', 'nope', { phase: 'PAUSED' });
    expect(r.details).toEqual({ phase: 'PAUSED' });
  });
});
