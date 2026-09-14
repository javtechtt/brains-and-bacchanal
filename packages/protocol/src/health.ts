/**
 * Shape returned by the game server's GET /health endpoint.
 *
 * Shared so the web app and the server agree rather than duplicating it.
 */
export interface HealthResponse {
  readonly status: 'ok';
  /** Integer protocol version. See version.ts. */
  readonly protocolVersion: number;
  /** Milliseconds since the process started. */
  readonly uptimeMs: number;
  /** Server epoch milliseconds. The client must not substitute its own clock. */
  readonly serverTime: number;
}
