/**
 * Server configuration, read from the environment once at startup.
 *
 * See .env.example for the documented variables.
 */

function readPort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return parsed;
}

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly logLevel: string;
  readonly nodeEnv: string;
  /**
   * CONTENT_POLICY.md — normal development uses TEST content only.
   * Phase 1 only records the setting; the content loader arrives later.
   */
  readonly contentSource: string;
  /**
   * Public base URL of the PLAYER WEB APP, used for join links and QR codes.
   *
   * Empty means "detect a LAN address at startup", which is what makes a local
   * party work with no configuration. Set PUBLIC_BASE_URL explicitly when the
   * game is reached through a tunnel or a real deployment, where the server
   * cannot infer how the outside world addresses it.
   */
  readonly publicBaseUrl: string;
  /** Maximum players per room. See docs/LOBBY.md for the default's reasoning. */
  readonly roomCapacity: number;
}

function readCapacity(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new Error(`Invalid room capacity: ${raw}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: readPort(env['GAME_SERVER_PORT'], 4000),
    host: env['GAME_SERVER_HOST'] ?? '0.0.0.0',
    logLevel: env['LOG_LEVEL'] ?? 'info',
    nodeEnv: env['NODE_ENV'] ?? 'development',
    contentSource: env['CONTENT_SOURCE'] ?? 'test-only',
    publicBaseUrl: (env['PUBLIC_BASE_URL'] ?? '').replace(/\/+$/, ''),
    roomCapacity: readCapacity(env['GAME_SERVER_ROOM_CAPACITY'], 24),
  };
}
