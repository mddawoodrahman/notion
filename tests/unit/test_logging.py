"""Unit tests for structured logging and sensitive data redaction."""

from __future__ import annotations

import json
import logging

from app.errors import sanitize_error_message
from app.logging_config import RedactingJsonFormatter, _redact_dict, parse_log_level


def test_sanitize_error_message_redacts_postgresql_credentials() -> None:
    raw = "Connection to postgresql://admin:supersecret123@db.example.com:5432/production failed"
    sanitized = sanitize_error_message(raw)
    assert "supersecret123" not in sanitized
    assert "admin" not in sanitized
    assert "postgresql://***:***@db.example.com" in sanitized


def test_sanitize_error_message_redacts_notion_keys_and_tokens() -> None:
    raw = "Error with key secret_topsecretkey12345678 and token vft_verifysecret987654"
    sanitized = sanitize_error_message(raw)
    assert "secret_topsecretkey12345678" not in sanitized
    assert "vft_verifysecret987654" not in sanitized
    assert "[REDACTED_NOTION_KEY]" in sanitized
    assert "[REDACTED_TOKEN]" in sanitized


def test_sanitize_error_message_redacts_ntn_keys() -> None:
    raw = "Authentication failed for ntn_abcdef1234567890abcdef"
    sanitized = sanitize_error_message(raw)
    assert "ntn_abcdef1234567890abcdef" not in sanitized
    assert "[REDACTED_NOTION_KEY]" in sanitized


def test_sanitize_error_message_redacts_bearer_tokens() -> None:
    raw = "Header Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.testsecret"
    sanitized = sanitize_error_message(raw)
    assert "eyJhbGciOiJIUzI1NiJ9" not in sanitized
    assert "Bearer [REDACTED]" in sanitized


def test_redact_dict_redacts_sensitive_keys() -> None:
    data = {
        "user_id": "123",
        "database_url": "postgresql://usr:pwd@host/db",
        "notion_api_key": "secret_abc123",
        "nested": {
            "password": "my_password",
            "safe_field": "hello",
        },
    }
    redacted = _redact_dict(data)
    assert redacted["database_url"] == "[REDACTED]"
    assert redacted["notion_api_key"] == "[REDACTED]"
    assert redacted["nested"]["password"] == "[REDACTED]"
    assert redacted["nested"]["safe_field"] == "hello"
    assert redacted["user_id"] == "123"


def test_redact_dict_handles_exception_instances_and_sanitizes_them() -> None:
    exc = ValueError("Failed connecting to postgresql://user:secretpass@host:5432/db")
    redacted = _redact_dict(exc)
    assert isinstance(redacted, str)
    assert "secretpass" not in redacted
    assert "postgresql://***:***@" in redacted


def test_redacting_json_formatter_serializes_exceptions_in_extra() -> None:
    formatter = RedactingJsonFormatter()
    record = logging.LogRecord(
        name="test_logger",
        level=logging.ERROR,
        pathname=__file__,
        lineno=10,
        msg="Operation failed",
        args=(),
        exc_info=None,
    )
    # Attach an exception object as an extra field
    record.err = RuntimeError("Connection error postgresql://bob:pass123@neon.tech/db")

    formatted = formatter.format(record)
    parsed = json.loads(formatted)

    assert parsed["level"] == "error"
    assert parsed["message"] == "Operation failed"
    assert "pass123" not in formatted
    assert "extra" in parsed
    assert "postgresql://***:***@" in parsed["extra"]["err"]


def test_parse_log_level() -> None:
    assert parse_log_level("trace") == logging.DEBUG
    assert parse_log_level("debug") == logging.DEBUG
    assert parse_log_level("info") == logging.INFO
    assert parse_log_level("warn") == logging.WARNING
    assert parse_log_level("warning") == logging.WARNING
    assert parse_log_level("error") == logging.ERROR
    assert parse_log_level("fatal") == logging.CRITICAL
    assert parse_log_level(None) == logging.INFO


def test_default_logger_identity() -> None:
    from app.logging_config import get_logger, logger, setup_logger

    assert logger.name == "taskbridge"
    assert setup_logger().name == "taskbridge"
    assert get_logger().name == "taskbridge"
