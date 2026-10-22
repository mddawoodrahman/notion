export type ErrorCategory = "RETRYABLE" | "PERMANENT" | "EXHAUSTED";

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_ABORTED",
  // @notionhq/client RequestTimeoutError carries this code and no HTTP status
  "notionhq_client_request_timeout",
]);

const RETRYABLE_TIMEOUT_ERROR_NAMES = new Set(["RequestTimeoutError", "TimeoutError"]);

/**
 * Detects status-less transient network/timeout failures (BUG-003): the SDK's
 * RequestTimeoutError, undici/node fetch failures (ECONNRESET, ETIMEDOUT, ...) and
 * any transient error wrapped in a `cause` chain. These carry no HTTP status, so
 * they must be recognized before an error is classified as permanent.
 */
export function isTransientNetworkError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 5) return false;

  const err = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  const code = typeof err.code === "string" ? err.code : "";
  const name = typeof err.name === "string" ? err.name : "";

  if (RETRYABLE_NETWORK_CODES.has(code)) return true;
  if (RETRYABLE_TIMEOUT_ERROR_NAMES.has(name)) return true;
  if (name === "TypeError" && /fetch failed/i.test(String(err.message ?? ""))) return true;

  return isTransientNetworkError(err.cause, depth + 1);
}

export class SyncError extends Error {
  public readonly code: string;
  public readonly isRetryable: boolean;
  public readonly statusCode?: number;

  constructor(message: string, options?: { code?: string; isRetryable?: boolean; statusCode?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = this.constructor.name;
    this.code = options?.code ?? "SYNC_ERROR";
    this.isRetryable = options?.isRetryable ?? false;
    this.statusCode = options?.statusCode;
  }
}

export class ConfigurationError extends SyncError {
  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    super(message, { code: options?.code ?? "CONFIG_ERROR", isRetryable: false, statusCode: 500, cause: options?.cause });
  }
}

export class NotionApiError extends SyncError {
  public readonly status?: number;
  public readonly retryAfterSeconds?: number;

  constructor(message: string, options?: { code?: string; status?: number; retryAfterSeconds?: number; cause?: unknown }) {
    const isRetryable = options?.status === 429 ||
      options?.status === 500 ||
      options?.status === 502 ||
      options?.status === 503 ||
      options?.status === 504 ||
      options?.status === 529 ||
      isTransientNetworkError(options?.cause);

    super(message, {
      code: options?.code ?? "NOTION_API_ERROR",
      isRetryable,
      statusCode: options?.status,
      cause: options?.cause,
    });
    this.status = options?.status;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

export class DatabaseError extends SyncError {
  public readonly pgCode?: string;

  constructor(message: string, options?: { code?: string; pgCode?: string; isRetryable?: boolean; cause?: unknown }) {
    // Retryable Postgres error codes: 08006 (connection failure), 08003, 08001, 57P01 (admin shutdown), 40001 (serialization failure), 40P01 (deadlock)
    const retryablePgCodes = new Set(["08006", "08003", "08001", "57P01", "40001", "40P01"]);
    const isRetryable = options?.isRetryable ?? (options?.pgCode ? retryablePgCodes.has(options.pgCode) : false);

    super(message, {
      code: options?.code ?? "DATABASE_ERROR",
      isRetryable,
      statusCode: 503,
      cause: options?.cause,
    });
    this.pgCode = options?.pgCode;
  }
}

export class PayloadValidationError extends SyncError {
  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    super(message, { code: options?.code ?? "PAYLOAD_VALIDATION_ERROR", isRetryable: false, statusCode: 400, cause: options?.cause });
  }
}

export class SignatureVerificationError extends SyncError {
  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    super(message, { code: options?.code ?? "SIGNATURE_VERIFICATION_ERROR", isRetryable: false, statusCode: 401, cause: options?.cause });
  }
}

/**
 * Classifies an error into RETRYABLE, PERMANENT, or EXHAUSTED (if attempts exceed threshold).
 */
export function classifyError(error: unknown, attempts = 0, maxAttempts = 8): { category: ErrorCategory; message: string; retryAfterMs?: number } {
  const safeMessage = sanitizeErrorMessage(error);

  if (attempts >= maxAttempts) {
    return {
      category: "EXHAUSTED",
      message: `Exhausted after ${attempts} attempts: ${safeMessage}`,
    };
  }

  if (error instanceof NotionApiError) {
    if (error.isRetryable || isTransientNetworkError(error.cause)) {
      const retryAfterMs = error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : undefined;
      return { category: "RETRYABLE", message: safeMessage, retryAfterMs };
    }
    return { category: "PERMANENT", message: safeMessage };
  }

  if (error instanceof DatabaseError) {
    const isRetryable = error.isRetryable || isTransientNetworkError(error.cause);
    return {
      category: isRetryable ? "RETRYABLE" : "PERMANENT",
      message: safeMessage,
    };
  }

  if (error instanceof PayloadValidationError || error instanceof ConfigurationError || error instanceof SignatureVerificationError) {
    return { category: "PERMANENT", message: safeMessage };
  }

  // Check network/system errors (including status-less timeout/network failures)
  if (isTransientNetworkError(error)) {
    return { category: "RETRYABLE", message: safeMessage };
  }

  return { category: "PERMANENT", message: safeMessage };
}

/**
 * Strips potential secrets, tokens, connection strings from error messages.
 */
export function sanitizeErrorMessage(error: unknown): string {
  let message = "";
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    message = String(error);
  }

  // Redact postgres URLs with passwords
  message = message.replace(/postgres(?:ql)?:\/\/[^:]+:[^@]+@/gi, "postgresql://***:***@");
  // Redact Notion API keys
  message = message.replace(/(?:secret_|ntn_)[a-zA-Z0-9_-]+/gi, "[REDACTED_NOTION_KEY]");
  // Redact verification tokens
  message = message.replace(/(?:vft_|secret_)[a-zA-Z0-9_-]+/gi, "[REDACTED_TOKEN]");

  return message;
}
