from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

ErrorCategory = Literal["RETRYABLE", "PERMANENT", "EXHAUSTED"]

RETRYABLE_NETWORK_CODES = {
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
    "notionhq_client_request_timeout",
}

RETRYABLE_TIMEOUT_ERROR_NAMES = {
    "RequestTimeoutError",
    "TimeoutError",
    "TimeoutException",
    "ConnectTimeout",
    "ReadTimeout",
    "WriteTimeout",
    "PoolTimeout",
    "NetworkError",
    "ConnectError",
}


def is_transient_network_error(error: Any, depth: int = 0) -> bool:
    """
    Detects status-less transient network/timeout failures (BUG-003):
    httpx timeouts, connection errors, socket failures (ECONNRESET, ETIMEDOUT, ...)
    and any transient error wrapped in an exception cause chain.
    """
    if error is None or depth > 5:
        return False

    # Check for known httpx or socket exception types
    error_type_name = type(error).__name__
    if error_type_name in RETRYABLE_TIMEOUT_ERROR_NAMES:
        return True

    # Check string attributes commonly present on error objects
    code = getattr(error, "code", "")
    if isinstance(code, str) and code in RETRYABLE_NETWORK_CODES:
        return True

    name = getattr(error, "name", "")
    if isinstance(name, str) and (
        name in RETRYABLE_TIMEOUT_ERROR_NAMES or name in RETRYABLE_NETWORK_CODES
    ):
        return True

    msg = str(error).lower()
    if any(
        term in msg
        for term in [
            "fetch failed",
            "connection reset",
            "connection refused",
            "timed out",
            "timeout",
            "econnreset",
            "econnrefused",
            "etimedout",
            "socket hang up",
            "network unreachable",
        ]
    ):
        return True

    # Check cause or __cause__ / __context__
    cause = (
        getattr(error, "cause", None)
        or getattr(error, "__cause__", None)
        or getattr(error, "__context__", None)
    )
    if cause is not None and cause is not error:
        return is_transient_network_error(cause, depth + 1)

    return False


def sanitize_error_message(error: Any) -> str:
    """Strips potential secrets, tokens, connection strings from error messages."""
    if isinstance(error, Exception):
        message = str(error)
    elif isinstance(error, str):
        message = error
    else:
        message = str(error)

    # Redact postgres URLs with passwords
    message = re.sub(
        r"postgres(?:ql)?://[^:]*:[^@]+@", "postgresql://***:***@", message, flags=re.IGNORECASE
    )
    # Redact Notion API keys (secret_... or ntn_...)
    message = re.sub(r"(?:secret_|ntn_)[a-zA-Z0-9_-]+", "[REDACTED_NOTION_KEY]", message)
    # Redact verification tokens (vft_... or secret_...)
    message = re.sub(r"(?:vft_|secret_)[a-zA-Z0-9_-]+", "[REDACTED_TOKEN]", message)
    # Redact Bearer tokens
    message = re.sub(r"(?i)bearer\s+[a-zA-Z0-9_.-]+", "Bearer [REDACTED]", message)

    return message


class SyncError(Exception):
    def __init__(
        self,
        message: str,
        code: str = "SYNC_ERROR",
        is_retryable: bool = False,
        status_code: int | None = None,
        cause: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.is_retryable = is_retryable
        self.status_code = status_code
        self.cause = cause


class ConfigurationError(SyncError):
    def __init__(self, message: str, code: str = "CONFIG_ERROR", cause: Any = None) -> None:
        super().__init__(message, code=code, is_retryable=False, status_code=500, cause=cause)


class NotionApiError(SyncError):
    def __init__(
        self,
        message: str,
        code: str = "NOTION_API_ERROR",
        status: int | None = None,
        retry_after_seconds: float | None = None,
        cause: Any = None,
    ) -> None:
        is_retryable = status in (429, 500, 502, 503, 504, 529) or is_transient_network_error(cause)
        super().__init__(
            message, code=code, is_retryable=is_retryable, status_code=status, cause=cause
        )
        self.status = status
        self.retry_after_seconds = retry_after_seconds


class DatabaseError(SyncError):
    def __init__(
        self,
        message: str,
        code: str = "DATABASE_ERROR",
        pg_code: str | None = None,
        is_retryable: bool | None = None,
        cause: Any = None,
    ) -> None:
        # Retryable Postgres error codes:
        # 08006 (connection failure), 08003, 08001, 57P01 (admin shutdown), 40001 (serialization failure), 40P01 (deadlock)
        retryable_pg_codes = {"08006", "08003", "08001", "57P01", "40001", "40P01"}
        if is_retryable is None:
            is_retryable = (pg_code in retryable_pg_codes) if pg_code else False
        super().__init__(
            message, code=code, is_retryable=is_retryable, status_code=503, cause=cause
        )
        self.pg_code = pg_code


class PayloadValidationError(SyncError):
    def __init__(
        self, message: str, code: str = "PAYLOAD_VALIDATION_ERROR", cause: Any = None
    ) -> None:
        super().__init__(message, code=code, is_retryable=False, status_code=400, cause=cause)


class SignatureVerificationError(SyncError):
    def __init__(
        self, message: str, code: str = "SIGNATURE_VERIFICATION_ERROR", cause: Any = None
    ) -> None:
        super().__init__(message, code=code, is_retryable=False, status_code=401, cause=cause)


@dataclass(frozen=True)
class ClassificationResult:
    category: ErrorCategory
    message: str
    retry_after_ms: float | None = None


def classify_error(error: Any, attempts: int = 0, max_attempts: int = 8) -> ClassificationResult:
    """Classifies an error into RETRYABLE, PERMANENT, or EXHAUSTED."""
    safe_message = sanitize_error_message(error)

    if attempts >= max_attempts:
        return ClassificationResult(
            category="EXHAUSTED",
            message=f"Exhausted after {attempts} attempts: {safe_message}",
        )

    if isinstance(error, NotionApiError):
        if error.is_retryable or is_transient_network_error(error.cause):
            retry_after_ms = (
                (error.retry_after_seconds * 1000.0) if error.retry_after_seconds else None
            )
            return ClassificationResult(
                category="RETRYABLE", message=safe_message, retry_after_ms=retry_after_ms
            )
        return ClassificationResult(category="PERMANENT", message=safe_message)

    if isinstance(error, DatabaseError):
        is_retry = error.is_retryable or is_transient_network_error(error.cause)
        return ClassificationResult(
            category="RETRYABLE" if is_retry else "PERMANENT", message=safe_message
        )

    if isinstance(error, (PayloadValidationError, ConfigurationError, SignatureVerificationError)):
        return ClassificationResult(category="PERMANENT", message=safe_message)

    if is_transient_network_error(error):
        return ClassificationResult(category="RETRYABLE", message=safe_message)

    return ClassificationResult(category="PERMANENT", message=safe_message)
