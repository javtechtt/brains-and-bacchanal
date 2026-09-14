import pino, { type Logger } from 'pino';
import type { ServerConfig } from './config.js';

/**
 * Structured logging.
 *
 * CLAUDE.md — production questions, accepted answers, Family Feud boards and
 * unrevealed challenge secrets must never appear in logs.
 * CONTENT_POLICY.md — sealed answers must not leak to spoiler-safe roles.
 *
 * The redaction list below is a defence-in-depth backstop, not a licence to
 * pass content into the logger. Rule number one is still: do not log content.
 */
const REDACTED_PATHS = [
  'answer',
  'answers',
  '*.answer',
  '*.answers',
  'acceptedAnswers',
  '*.acceptedAnswers',
  'question',
  '*.question',
  'questionText',
  '*.questionText',
  'board',
  '*.board',
  'boardAnswers',
  '*.boardAnswers',
  'clue',
  '*.clue',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'sessionToken',
  '*.sessionToken',
];

export function createLogger(config: ServerConfig): Logger {
  const isDev = config.nodeEnv === 'development';

  return pino({
    level: config.logLevel,
    redact: {
      paths: REDACTED_PATHS,
      censor: '[REDACTED]',
    },
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}
