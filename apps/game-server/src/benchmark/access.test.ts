import { describe, expect, it } from 'vitest';
import { configuredToken, isAuthorized } from './access.js';

/**
 * Tests for the development-only benchmark access gate.
 *
 * This is NOT the production auth model — see access.ts. It exists so the
 * benchmark server can be exposed for Phase 3 cloud testing without leaving a
 * public, unauthenticated session that anyone could pause or buzz.
 */

describe('configuredToken', () => {
  it('is null when unset, so LAN testing stays open', () => {
    expect(configuredToken({})).toBeNull();
  });

  it('is null when set to an empty string', () => {
    // An empty env var is how a misconfigured deploy usually manifests. Treating
    // it as "no token" rather than as a token nobody can guess keeps behaviour
    // predictable, and the startup banner reports OPEN so it is visible.
    expect(configuredToken({ BENCHMARK_ACCESS_TOKEN: '' })).toBeNull();
  });

  it('returns the configured value', () => {
    expect(configuredToken({ BENCHMARK_ACCESS_TOKEN: 's3cret' })).toBe('s3cret');
  });
});

describe('isAuthorized', () => {
  it('allows everything when no token is configured', () => {
    expect(isAuthorized('/benchmark/ws', null)).toBe(true);
    expect(isAuthorized(undefined, null)).toBe(true);
  });

  it('accepts a matching token', () => {
    expect(isAuthorized('/benchmark/ws?token=s3cret', 's3cret')).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(isAuthorized('/benchmark/ws?token=nope', 's3cret')).toBe(false);
  });

  it('rejects a missing token', () => {
    expect(isAuthorized('/benchmark/ws', 's3cret')).toBe(false);
  });

  it('rejects an undefined url', () => {
    expect(isAuthorized(undefined, 's3cret')).toBe(false);
  });

  it('rejects a token that is merely a prefix', () => {
    expect(isAuthorized('/benchmark/ws?token=s3c', 's3cret')).toBe(false);
  });

  it('rejects a token with extra trailing characters', () => {
    expect(isAuthorized('/benchmark/ws?token=s3cretXY', 's3cret')).toBe(false);
  });

  it('handles url-encoded tokens', () => {
    expect(isAuthorized('/benchmark/ws?token=a%2Fb%2Bc', 'a/b+c')).toBe(true);
  });

  it('works alongside other query parameters', () => {
    expect(isAuthorized('/benchmark/ws?foo=1&token=s3cret&bar=2', 's3cret')).toBe(true);
  });

  it('does not treat a token-like path segment as authorisation', () => {
    // Guards against a sloppier implementation that searched the raw string
    // for the token instead of parsing the query.
    expect(isAuthorized('/benchmark/s3cret/ws', 's3cret')).toBe(false);
  });
});
