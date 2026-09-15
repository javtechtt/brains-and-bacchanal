'use client';

/**
 * Where the browser should reach the game server.
 *
 * Phase 4 spec §4 — no hardcoded PC IP in game logic. A phone that scanned a QR
 * code reached this page over the LAN (or a tunnel), so the page's OWN hostname
 * is the address that demonstrably works from that device. Deriving the server
 * URL from it means the same build works on localhost, on any LAN address, and
 * through a tunnel, with no rebuild.
 *
 * NEXT_PUBLIC_GAME_SERVER_URL overrides this for deployments where the server
 * lives on a different host from the web app.
 */

/** Default game-server port. Matches GAME_SERVER_PORT in .env.example. */
const DEFAULT_SERVER_PORT = 4000;

export function serverUrl(): string {
  const configured = process.env['NEXT_PUBLIC_GAME_SERVER_URL'];
  if (configured !== undefined && configured !== '') return configured.replace(/\/+$/, '');

  if (typeof window === 'undefined') return `http://localhost:${DEFAULT_SERVER_PORT}`;

  const { protocol, hostname, port } = window.location;

  // Behind a tunnel or a reverse proxy the page is served over TLS on the
  // default port, and the server is expected on the SAME origin — a separate
  // port would not be exposed. Keeping the origin also keeps ws:// vs wss://
  // correct, which a browser enforces as mixed content.
  const isDefaultPort = port === '' || port === '80' || port === '443';
  if (protocol === 'https:' && isDefaultPort) return `${protocol}//${hostname}`;

  return `${protocol}//${hostname}:${DEFAULT_SERVER_PORT}`;
}
