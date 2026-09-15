/**
 * Join URL construction.
 *
 * Phase 4 spec §4 — "no hardcoded current PC IP in game logic; use
 * runtime/environment configuration". A QR code printed with a baked-in address
 * stops working the moment the laptop gets a different DHCP lease, which is the
 * kind of failure that happens in front of guests.
 *
 * So the base URL is supplied at runtime (PUBLIC_BASE_URL, or a detected LAN
 * address at startup) and this module only assembles the path.
 */

/** Path players land on. Mirrors apps/web/src/app/join/[code]/page.tsx. */
export const JOIN_PATH = '/join';

/**
 * Build the URL a QR code encodes.
 *
 * The code goes in the PATH rather than a query string because it survives
 * copy-paste and link preview mangling better, and reads more clearly when a
 * Host reads it aloud as a fallback: "go to example.com slash join slash BX7K".
 */
export function buildJoinUrl(baseUrl: string, roomCode: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}${JOIN_PATH}/${roomCode}`;
}

/**
 * Derive the WebSocket URL for a given HTTP base.
 *
 * http -> ws and https -> wss. Getting this wrong on a TLS page is a silent
 * failure: browsers block an insecure ws:// from an https:// origin as mixed
 * content, which the Phase 3 cloud test exercised for real.
 */
export function websocketUrlFor(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}${path}`;
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}${path}`;
  return `ws://${trimmed}${path}`;
}
