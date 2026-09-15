/**
 * Benchmark access token — DEVELOPMENT ONLY.
 *
 * ================== NOT THE PRODUCTION AUTH SYSTEM ==================
 *
 * This exists for exactly one reason: Phase 3 cloud testing requires the
 * benchmark server to be reachable over the public internet, and the benchmark
 * session has no authentication of its own — any connected client may claim
 * `isHost: true` and then pause the session, open the buzzer or resume play.
 * On a LAN that is fine; on a public URL it is not.
 *
 * So this is a single shared secret checked at the WebSocket upgrade, before a
 * socket is accepted. It is a door lock on a development instrument, nothing
 * more:
 *
 *   - it is NOT part of the game protocol (no intent, no envelope field),
 *   - it does NOT identify or authorise anyone — every accepted client still
 *     has exactly the same powers as before,
 *   - it must NOT be mistaken for the real session/auth model. ARCHITECTURE.md
 *     §10 calls for secure host/player session tokens, and Phase 4 builds the
 *     actual join flow. This is deliberately not that.
 *
 * When BENCHMARK_ACCESS_TOKEN is unset the server is open, which keeps local
 * LAN testing exactly as it was.
 * ====================================================================
 */

/** The configured token, or null when the server is deliberately open. */
export function configuredToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env['BENCHMARK_ACCESS_TOKEN'];
  return token === undefined || token === '' ? null : token;
}

/**
 * Whether a request carrying `url` may open a connection.
 *
 * The token travels as a query parameter (`?token=…`) rather than a header,
 * because the browser WebSocket API cannot set custom headers on the handshake
 * — a real constraint, not a shortcut. That does mean the token can appear in
 * proxy and server access logs, which is acceptable for a short-lived
 * development secret and would not be for a production credential.
 */
export function isAuthorized(url: string | undefined, token: string | null): boolean {
  if (token === null) return true;
  if (url === undefined) return false;

  // `url` on an upgrade request is path + query only, so a dummy base is needed
  // to parse it. The base is never used for anything else.
  let provided: string | null;
  try {
    provided = new URL(url, 'http://localhost').searchParams.get('token');
  } catch {
    return false;
  }

  if (provided === null) return false;
  return timingSafeEquals(provided, token);
}

/**
 * Constant-time string comparison.
 *
 * A plain `===` on a secret leaks length and prefix information through timing.
 * The exposure here is small, but comparing secrets in constant time is the
 * kind of habit that should not have exceptions.
 */
function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
