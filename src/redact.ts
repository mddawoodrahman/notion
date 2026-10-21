/**
 * Redaction helpers. Every string that can reach a log line, an HTTP body or
 * `sync_inbox.last_error` must pass through here first.
 */

const CONNECTION_STRING_PATTERN = /\bpostgres(?:ql)?:\/\/[^\s"'`]+/gi;
const NOTION_SECRET_PATTERN = /\b(?:secret|ntn)_[A-Za-z0-9_-]{8,}/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

const MAX_ERROR_LENGTH = 2000;

/** Remove credential-bearing substrings from arbitrary text. */
export function sanitizeText(input: string): string {
  return input
    .replace(CONNECTION_STRING_PATTERN, '[redacted-connection-string]')
    .replace(NOTION_SECRET_PATTERN, '[redacted-token]')
    .replace(BEARER_PATTERN, 'Bearer [redacted]');
}

/**
 * Turn an unknown thrown value into a bounded, sanitized one-line message
 * suitable for `last_error` and structured logs.
 */
export function sanitizeError(error: unknown): string {
  let message: string;
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    message = code === undefined ? error.message : `${code}: ${error.message}`;
    if (message.trim() === '') {
      message = error.name;
    }
  } else if (typeof error === 'string') {
    message = error;
  } else {
    try {
      message = JSON.stringify(error);
    } catch {
      message = 'non-serializable error';
    }
  }

  const sanitized = sanitizeText(message).replace(/\s+/g, ' ').trim();
  return sanitized.length > MAX_ERROR_LENGTH
    ? `${sanitized.slice(0, MAX_ERROR_LENGTH)}…`
    : sanitized;
}
