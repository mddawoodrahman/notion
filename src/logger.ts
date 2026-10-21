import { pino, type Logger } from 'pino';

import type { AppConfig } from './config.js';

export type { Logger };

export const SERVICE_NAME = 'notion-tasks-sync';

/**
 * Structured JSON logger with secret redaction. Log lines are operational
 * metadata only — never request bodies, tokens or full page content.
 */
export function createLogger(config: Pick<AppConfig, 'env' | 'logLevel'>): Logger {
  return pino({
    level: config.logLevel,
    base: { service: SERVICE_NAME, env: config.env },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-notion-signature"]',
        'headers.authorization',
        '*.authorization',
        '*.Authorization',
        '*.verification_token',
        '*.verificationToken',
        '*.apiKey',
        '*.api_key',
        '*.NOTION_API_KEY',
        '*.DATABASE_URL',
        '*.databaseUrl',
        '*.connectionString',
        '*.password',
        '*.cookie',
      ],
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
