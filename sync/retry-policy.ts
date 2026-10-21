const BASE_MS = 2_000;
const MAX_MS = 15 * 60_000; // 15 minutes

/**
 * Calculates exponential backoff with full jitter and honors Retry-After.
 */
export function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (attempt <= 0) return retryAfterMs ?? 0;
  const capped = Math.min(BASE_MS * Math.pow(2, attempt - 1), MAX_MS);
  const jittered = Math.random() * capped; // full jitter
  return Math.max(jittered, retryAfterMs ?? 0);
}

/**
 * Parses HTTP Retry-After header (either delta-seconds or HTTP-date).
 * Returns delay in milliseconds.
 */
export function parseRetryAfter(header?: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : 0;
  }

  return undefined;
}
