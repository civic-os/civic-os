/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Unit tests for structured JSON Lines logging.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { configureLogging, getLogger } from '../logger.js';

describe('configureLogging', () => {
  afterEach(async () => {
    await configureLogging('silent');
    vi.restoreAllMocks();
  });

  it('outputs JSON Lines to stderr at info level', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await configureLogging('info');
    const logger = getLogger(['mcp', 'test']);
    logger.info('test_message', { key: 'value' });

    expect(writeSpy).toHaveBeenCalledOnce();
    const output = writeSpy.mock.calls[0][0] as string;
    expect(output.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      level: 'INFO',
      logger: 'mcp.test',
      msg: 'test_message',
      key: 'value',
    });
    expect(parsed['@timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('silences all output with "silent" level', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await configureLogging('silent');
    const logger = getLogger(['mcp', 'test']);
    logger.info('should_not_appear');
    logger.error('also_should_not_appear');

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('filters messages below configured level', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await configureLogging('warning');
    const logger = getLogger(['mcp', 'test']);
    logger.debug('no');
    logger.info('no');
    logger.warn('yes');

    expect(writeSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(parsed.level).toBe('WARNING');
    expect(parsed.msg).toBe('yes');
  });

  it('defaults to info for invalid level strings', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await configureLogging('banana');
    const logger = getLogger(['mcp', 'test']);
    logger.debug('should_not_appear');
    logger.info('should_appear');

    expect(writeSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(parsed.msg).toBe('should_appear');
  });

  it('defaults to info when no level is provided', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await configureLogging();
    const logger = getLogger(['mcp', 'test']);
    logger.info('should_appear');
    logger.debug('should_not_appear');

    expect(writeSpy).toHaveBeenCalledOnce();
  });

  it('spreads properties as top-level JSON fields', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await configureLogging('info');
    const logger = getLogger(['mcp', 'tool']);
    logger.info('tool_call', { tool: 'list_records', duration_ms: 42, entity: 'clients' });

    const parsed = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(parsed.tool).toBe('list_records');
    expect(parsed.duration_ms).toBe(42);
    expect(parsed.entity).toBe('clients');
    expect(parsed.logger).toBe('mcp.tool');
  });

  it('supports debug level', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await configureLogging('debug');
    const logger = getLogger(['mcp', 'test']);
    logger.debug('verbose_output');

    expect(writeSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(writeSpy.mock.calls[0][0] as string);
    expect(parsed.level).toBe('DEBUG');
  });
});
