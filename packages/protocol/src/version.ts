/**
 * Protocol version.
 *
 * ARCHITECTURE.md §3 — "Protocol versioning should be explicit."
 *
 * A single integer, deliberately. The web client, the game server and the
 * future Unity host must all agree on one number, and an integer survives the
 * TypeScript -> C# boundary without parsing rules.
 *
 * Bump this whenever a change would break an older client: a removed field, a
 * changed field meaning, or a changed envelope shape. Additive, optional fields
 * do not require a bump.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Whether this build can talk to a peer announcing `version`.
 *
 * Phase 2 keeps this deliberately strict and simple: exact match only. There is
 * no negotiation, no range and no compatibility window, because the roadmap
 * does not call for one and a speculative negotiation scheme would be an
 * abstraction built for an imagined future.
 *
 * The point is that the check exists in one place, so a future phase can widen
 * the policy here rather than hunting for scattered comparisons.
 */
export function isSupportedProtocolVersion(version: number): boolean {
  return version === PROTOCOL_VERSION;
}
