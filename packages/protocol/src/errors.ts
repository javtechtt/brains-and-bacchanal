/**
 * Structured rejections.
 *
 * A rejection must be understandable by a UI without parsing prose, so the
 * `code` carries the meaning and `message` is only for humans and logs.
 *
 * The code set is deliberately SMALL and GENERIC. There are no game-specific
 * codes here — no "CARD_NOT_LEGAL", no "INSUFFICIENT_BB". Those belong to the
 * phases that implement those systems, and several of them depend on rules
 * still open in docs/OPEN_RULES.md. `details` is the extension point until then.
 */

export const REJECTION_CODES = [
  /** Envelope was malformed, or a field failed validation. */
  'INVALID_REQUEST',
  /** Peer announced a protocol version this build cannot serve. */
  'UNSUPPORTED_PROTOCOL_VERSION',
  /** This intentId was already accepted. The original outcome stands. */
  'DUPLICATE_INTENT',
  /** Understood and well-formed, but not permitted by the rules right now. */
  'ILLEGAL_ACTION',
  /** Not valid from the current lifecycle state (e.g. acting while PAUSED). */
  'WRONG_STATE',
  /** The actor lacks the authority for this action (e.g. non-Host resume). */
  'UNAUTHORIZED_ACTOR',
  /** The referenced room, player, team or challenge does not exist. */
  'NOT_FOUND',
  /** Lost a race against another accepted change. */
  'CONFLICT',
  /** Unexpected server fault. Details are never sent to clients. */
  'INTERNAL_ERROR',
] as const;

export type RejectionCode = (typeof REJECTION_CODES)[number];

/**
 * A rejection.
 *
 * CONTENT_POLICY.md — `message` and `details` must never carry unrevealed
 * question text, accepted answers or board labels. A rejection explains why an
 * action failed, never what the right answer was.
 */
export interface Rejection {
  readonly code: RejectionCode;
  /** Safe to show a player. Never contains unrevealed content. */
  readonly message: string;
  /**
   * Optional machine-readable context — which field was invalid, which state
   * was expected. Extension point for later phases.
   */
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export function rejection(
  code: RejectionCode,
  message: string,
  details?: Readonly<Record<string, string | number | boolean>>,
): Rejection {
  return details === undefined ? { code, message } : { code, message, details };
}

/** Discriminated result of submitting an intent. */
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Rejection };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(error: Rejection): Result<T> => ({ ok: false, error });
