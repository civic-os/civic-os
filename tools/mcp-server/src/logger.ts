/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Structured JSON Lines logging to stderr (Loki-compatible).
 * Controlled via MCP_LOG_LEVEL env var or --log-level CLI flag.
 */

import { configure, type LogRecord } from '@logtape/logtape';

const LOG_LEVELS = ['debug', 'info', 'warning', 'error', 'fatal'] as const;
type ValidLogLevel = typeof LOG_LEVELS[number];

function renderMessage(parts: readonly (string | unknown)[]): string {
  return parts.map(p => typeof p === 'string' ? p : String(p)).join('');
}

function jsonLinesSink(record: LogRecord): void {
  const entry: Record<string, unknown> = {
    '@timestamp': new Date(record.timestamp).toISOString(),
    level: record.level.toUpperCase(),
    logger: record.category.join('.'),
    msg: renderMessage(record.message),
    ...record.properties,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export async function configureLogging(level?: string): Promise<void> {
  const effectiveLevel = level ?? 'info';

  if (effectiveLevel === 'silent') {
    await configure({
      sinks: {},
      loggers: [{ category: ['logtape', 'meta'], lowestLevel: 'fatal' }],
      reset: true,
    });
    return;
  }

  const lowestLevel: ValidLogLevel = LOG_LEVELS.includes(effectiveLevel as ValidLogLevel)
    ? effectiveLevel as ValidLogLevel
    : 'info';

  await configure({
    sinks: { stderr: jsonLinesSink },
    loggers: [
      { category: ['logtape', 'meta'], lowestLevel: 'warning' },
      { category: ['mcp'], sinks: ['stderr'], lowestLevel },
    ],
    reset: true,
  });
}

export { getLogger } from '@logtape/logtape';
