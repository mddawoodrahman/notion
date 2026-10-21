export type ErrorCategory = "RETRYABLE" | "PERMANENT" | "EXHAUSTED";

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
      options?.status === 529;

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
    if (error.isRetryable) {
      const retryAfterMs = error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : undefined;
      return { category: "RETRYABLE", message: safeMessage, retryAfterMs };
    }
    return { category: "PERMANENT", message: safeMessage };
  }

  if (error instanceof DatabaseError) {
    return {
      category: error.isRetryable ? "RETRYABLE" : "PERMANENT",
      message: safeMessage,
    };
  }

  if (error instanceof PayloadValidationError || error instanceof ConfigurationError || error instanceof SignatureVerificationError) {
    return { category: "PERMANENT", message: safeMessage };
  }

  // Check network/system errors
  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;
    const code = String(err.code || "");
    const retryableCodes = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"];
    if (retryableCodes.includes(code)) {
      return { category: "RETRYABLE", message: safeMessage };
    }
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
  message = message.replace(/(?:secret_|ntn_)[a-zA-Z0-9_\-]+/gi, "[REDACTED_NOTION_KEY]");
  // Redact verification tokens
  message = message.replace(/(?:vft_|secret_)[a-zA-Z0-9_\-]+/gi, "[REDACTED_TOKEN]");

  return message;
}
