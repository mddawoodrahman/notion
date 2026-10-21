import { describe, expect, it, vi } from 'vitest';

import { SyncError } from '../../src/errors.js';
import {
  backoffMs,
  classifyError,
  parseRetryAfter,
  withRetry,
} from '../../sync/retry-policy.js';

describe('backoffMs', () => {
  it('uses full jitter within the exponential cap (U-22)', () => {
    expect(backoffMs(1, undefined, () => 0)).toBe(0);
    expect(backoffMs(1, undefined, () => 0.5)).toBe(1_000);
    expect(backoffMs(1, undefined, () => 1)).toBe(2_000);
    expect(backoffMs(4, undefined, () => 0.5)).toBe(8_000);
  });

  it('caps the exponential growth at 15 minutes', () => {
    expect(backoffMs(100, undefined, () => 1)).toBe(15 * 60_000);
    expect(backoffMs(20, undefined, () => 0.5)).toBe(7.5 * 60_000);
  });

  it('never returns less than the provider Retry-After floor (U-24)', () => {
    expect(backoffMs(1, 5_000, () => 0)).toBe(5_000);
    expect(backoffMs(10, 5_000, () => 1)).toBe(15 * 60_000);
  });
});

describe('parseRetryAfter', () => {
  it('parses delta seconds', () => {
    expect(parseRetryAfter('2', 0)).toBe(2_000);
    expect(parseRetryAfter('0', 0)).toBe(0);
  });

  it('parses an HTTP-date', () => {
    const now = Date.parse('2026-10-21T10:00:00.000Z');
    expect(parseRetryAfter('Wed, 21 Oct 2026 10:00:03 GMT', now)).toBe(3_000);
  });

  it('ignores invalid and past values', () => {
    expect(parseRetryAfter('soon', 0)).toBeUndefined();
    expect(parseRetryAfter('Wed, 21 Oct 2026 09:59:00 GMT', Date.parse('2026-10-21T10:00:00.000Z'))).toBeUndefined();
    expect(parseRetryAfter(undefined, 0)).toBeUndefined();
  });

  it('takes the larger value when several header values are present', () => {
    const now = Date.parse('2026-10-21T10:00:00.000Z');
    expect(parseRetryAfter(['2', 'Wed, 21 Oct 2026 10:00:05 GMT'], now)).toBe(5_000);
  });
});

describe('classifyError', () => {
  it('classifies Notion 429 as retryable and keeps Retry-After (U-25)', () => {
    const classification = classifyError({
      name: 'APIResponseError',
      status: 429,
      headers: { 'retry-after': '3' },
      message: 'rate limited',
    });

    expect(classification.errorClass).toBe('RETRYABLE');
    expect(classification.status).toBe(429);
    expect(classification.retryAfterMs).toBe(3_000);
  });

  it('classifies 403 as permanent (U-26)', () => {
    expect(classifyError({ status: 403, message: 'forbidden' }).errorClass).toBe('PERMANENT');
    expect(classifyError({ status: 401, message: 'unauthorized' }).errorClass).toBe('PERMANENT');
    expect(classifyError({ status: 404, message: 'missing' }).errorClass).toBe('PERMANENT');
  });

  it('classifies transient Notion statuses as retryable', () => {
    for (const status of [500, 502, 503, 504, 529]) {
      expect(classifyError({ status, message: 'boom' }).errorClass).toBe('RETRYABLE');
    }
  });

  it('classifies PostgreSQL connection and serialization failures as retryable (U-27)', () => {
    for (const code of ['08006', '08003', '08001', '57P01', '40001', '40P01', '57014']) {
      const classification = classifyError(Object.assign(new Error('database'), { code }));
      expect(classification.errorClass, code).toBe('RETRYABLE');
      expect(classification.code).toBe(code);
    }
  });

  it('classifies node network errors as retryable', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE']) {
      expect(classifyError(Object.assign(new Error('net'), { code })).errorClass).toBe('RETRYABLE');
    }
  });

  it('classifies unknown failures as permanent', () => {
    expect(classifyError(new Error('nope')).errorClass).toBe('PERMANENT');
    expect(classifyError('nope').errorClass).toBe('PERMANENT');
  });

  it('passes through SyncError classification', () => {
    const error = new SyncError('rate limited', {
      errorClass: 'RETRYABLE',
      retryAfterMs: 1_500,
      status: 429,
    });

    expect(classifyError(error)).toMatchObject({
      errorClass: 'RETRYABLE',
      retryAfterMs: 1_500,
      status: 429,
    });
  });
});

describe('withRetry', () => {
  it('retries retryable failures and returns the eventual success', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ status: 503, message: 'unavailable' })
      .mockRejectedValueOnce({ status: 429, headers: { 'retry-after': '2' }, message: 'slow down' })
      .mockResolvedValueOnce('ok');

    const result = await withRetry(operation, {
      maxAttempts: 5,
      sleep,
      random: () => 0,
    });

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[1]?.[0]).toBe(2_000);
  });

  it('does not retry permanent errors', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue({ status: 403, message: 'forbidden' });

    await expect(withRetry(operation, { maxAttempts: 5, sleep })).rejects.toMatchObject({
      errorClass: 'PERMANENT',
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails as exhausted after maxAttempts', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue({ status: 500, message: 'boom' });

    await expect(withRetry(operation, { maxAttempts: 3, sleep, random: () => 0 })).rejects.toMatchObject({
      name: 'SyncError',
      errorClass: 'PERMANENT',
      code: 'exhausted',
    });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('sanitizes secrets out of the surfaced error message', async () => {
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('failed for secret_abcdef123456789 while calling postgresql://u:p@h/db'));

    await expect(withRetry(operation, { maxAttempts: 1 })).rejects.toMatchObject({
      errorClass: 'PERMANENT',
      message: expect.not.stringContaining('secret_abcdef123456789'),
    });

    try {
      await withRetry(operation, { maxAttempts: 1 });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('secret_abcdef123456789');
      expect(message).not.toContain('postgresql://');
    }
  });
});
