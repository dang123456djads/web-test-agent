import pino from 'pino';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// Logger – web-test-agent / src/logger.ts
// Provides structured logging via pino with module + event fields
// ============================================================

function buildLogger(): pino.Logger {
  const level = process.env['LOG_LEVEL'] ?? 'info';

  // Use pino-pretty in development when pretty=true
  const isPretty = process.env['LOG_PRETTY'] === 'true';

  const options: pino.LoggerOptions = {
    level,
    base: {
      pid: process.pid,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };

  if (isPretty) {
    return pino(
      options,
      pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      })
    );
  }

  return pino(options);
}

const rootLogger = buildLogger();

/**
 * Get a child logger scoped to a specific module.
 *
 * Usage:
 *   const log = getLogger('executor');
 *   log.info({ event: 'action_start', action_id: '...' }, 'Starting action');
 */
export function getLogger(module: string): pino.Logger {
  return rootLogger.child({ module });
}

export default rootLogger;
