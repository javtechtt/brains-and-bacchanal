/**
 * Shape returned by the game server's GET /health endpoint.
 *
 * DEVELOPMENT_ROADMAP.md Phase 1 — "game-server /health" and "simple web
 * health check". Shared here so the web app and the server agree on the shape
 * rather than duplicating it.
 */
export interface HealthResponse {
  readonly status: 'ok';
  readonly protocolVersion: string;
  /** Milliseconds since the process started. */
  readonly uptimeMs: number;
  /** Server epoch milliseconds. The client must not substitute its own clock. */
  readonly serverTime: number;
}
