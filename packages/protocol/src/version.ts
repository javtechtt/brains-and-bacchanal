/**
 * Protocol version.
 *
 * ARCHITECTURE.md §3 — "Protocol versioning should be explicit."
 *
 * Bump MAJOR when a change breaks existing clients (removed field, changed
 * meaning, changed envelope shape). Bump MINOR for backwards-compatible
 * additions. Unity C# DTOs and the web client both assert against this.
 */
export const PROTOCOL_VERSION = '0.1.0' as const;

/** Numeric form for fast compatibility checks across language boundaries. */
export const PROTOCOL_MAJOR = 0 as const;
export const PROTOCOL_MINOR = 1 as const;
export const PROTOCOL_PATCH = 0 as const;
