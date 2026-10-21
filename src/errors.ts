/** Error taxonomy shared by the Notion client, repositories and worker. */

export type ErrorClass = 'RETRYABLE' | 'PERMANENT';

export interface SyncErrorOptions {
  readonly errorClass: ErrorClass;
  readonly code?: string;
  /** Wait time requested by the provider (e.g. Retry-After), in milliseconds. */
  readonly retryAfterMs?: number;
  /** HTTP status when the failure originated from an API response. */
  readonly status?: number;
  readonly cause?: unknown;
}

/**
 * The only error type thrown across module boundaries for expected failures.
 * Plain errors are still classified defensively at the settle boundary, but
 * code should not rely on that.
 */
export class SyncError extends Error {
  override readonly name = 'SyncError';
  readonly errorClass: ErrorClass;
  readonly code: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;

  constructor(message: string, options: SyncErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.errorClass = options.errorClass;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
  }
}

export function isSyncError(error: unknown): error is SyncError {
  return error instanceof SyncError;
}
