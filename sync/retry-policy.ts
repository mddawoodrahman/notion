/**
 * Central retry policy. Classification is deliberately structural: provider
 * errors surface as `SyncError`, Notion SDK errors carry `status`, and pg /
 * node errors carry `code`. Unknown failures are treated as permanent so a
 * poisoned event cannot loop forever.
 */

import { setTimeout as delay } from 'node:timers/promises';

import { isSyncError, SyncError, type ErrorClass } from '../src/errors.js';
import { sanitizeError } from '../src/redact.js';

const BASE_MS = 2_000;
const MAX_MS = 15 * 60_000;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

const RETRYABLE_DATABASE_CODES = new Set([
  '08006',
  '08003',
  '08001',
  '57P01',
  '40001',
  '40P01',
  '57014',
]);

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
]);

export interface ErrorClassification {
  readonly errorClass: ErrorClass;
  readonly code?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
}

export interface RetryInfo {
  readonly attempt: number;
  readonly delayMs: number;
  readonly classification: ErrorClassification;
  readonly error: unknown;
}

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly onRetry?: (info: RetryInfo) => void;
}

/**
 * Full-jitter exponential backoff, floored by the provider's Retry-After.
 * `random` is injectable so the policy is testable without mocking globals.
 */
export function backoffMs(
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const capped = Math.min(BASE_MS * 2 ** (safeAttempt - 1), MAX_MS);
  const jittered = Math.floor(random() * capped);
  return Math.max(jittered, retryAfterMs ?? 0);
}

/**
 * Parse `Retry-After` as delta-seconds or HTTP-date. If several values exist,
 * the largest wins; invalid or past values are ignored.
 */
export function parseRetryAfter(
  value: string | readonly string[] | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const candidates = (typeof value === 'string' ? [value] : value)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate !== '');

  let best: number | undefined;
  for (const candidate of candidates) {
    let milliseconds: number | undefined;
    if (/^\d+$/.test(candidate)) {
      milliseconds = Number(candidate) * 1_000;
      if (!Number.isFinite(milliseconds)) {
        milliseconds = undefined;
      }
    } else {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) {
        const delta = parsed - now;
        milliseconds = delta > 0 ? delta : undefined;
      }
    }

    if (milliseconds !== undefined && (best === undefined || milliseconds > best)) {
      best = milliseconds;
    }
  }

  return best;
}

export function classifyError(error: unknown): ErrorClassification {
  if (isSyncError(error)) {
    return {
      errorClass: error.errorClass,
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      status?: unknown;
      code?: unknown;
      headers?: unknown;
      message?: unknown;
    };

    if (typeof candidate.status === 'number') {
      const status = candidate.status;
      const retryAfterMs = parseRetryAfter(readHeader(candidate.headers, 'retry-after'));
      return {
        errorClass: RETRYABLE_STATUSES.has(status) ? 'RETRYABLE' : 'PERMANENT',
        ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
        status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }

    if (typeof candidate.code === 'string') {
      const code = candidate.code;
      if (RETRYABLE_DATABASE_CODES.has(code) || RETRYABLE_NETWORK_CODES.has(code)) {
        return { errorClass: 'RETRYABLE', code };
      }
      return { errorClass: 'PERMANENT', code };
    }
  }

  return { errorClass: 'PERMANENT' };
}

/**
 * Run an operation under the shared retry policy. Expected failures leave as
 * `SyncError` with a sanitized message; exhausted retries become `exhausted`.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const random = options.random ?? Math.random;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const classification = classifyError(error);

      if (classification.errorClass === 'PERMANENT') {
        throw toSyncError(error, classification);
      }

      if (attempt >= maxAttempts) {
        throw new SyncError(
          `exhausted after ${attempt} attempts: ${sanitizeError(error)}`,
          {
            errorClass: 'PERMANENT',
            code: 'exhausted',
            ...(classification.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: classification.retryAfterMs }),
            ...(classification.status === undefined ? {} : { status: classification.status }),
            cause: error,
          },
        );
      }

      const delayMs = backoffMs(attempt, classification.retryAfterMs, random);
      options.onRetry?.({ attempt, delayMs, classification, error });
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws.
  throw new SyncError('retry loop exited unexpectedly', {
    errorClass: 'PERMANENT',
    code: 'retry_loop_exit',
  });
}

function toSyncError(error: unknown, classification: ErrorClassification): SyncError {
  if (isSyncError(error)) {
    return error;
  }
  return new SyncError(sanitizeError(error), {
    errorClass: classification.errorClass,
    ...(classification.code === undefined ? {} : { code: classification.code }),
    ...(classification.status === undefined ? {} : { status: classification.status }),
    ...(classification.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: classification.retryAfterMs }),
    cause: error,
  });
}

function readHeader(headers: unknown, name: string): string | string[] | undefined {
  if (headers === null || headers === undefined) {
    return undefined;
  }

  if (typeof headers === 'object') {
    const candidate = headers as {
      get?: (key: string) => string | null;
      [key: string]: unknown;
    };

    if (typeof candidate.get === 'function') {
      const value = candidate.get(name);
      return typeof value === 'string' ? value : undefined;
    }

    for (const [key, value] of Object.entries(candidate)) {
      if (key.toLowerCase() !== name.toLowerCase()) {
        continue;
      }
      if (typeof value === 'string') {
        return value;
      }
      if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
        return value as string[];
      }
    }
  }

  return undefined;
}
