from __future__ import annotations

import json
import logging
import os
from typing import Any

from app.errors import sanitize_error_message

REDACT_KEYS = {
    "notion_api_key",
    "notion_webhook_verification_token",
    "database_url",
    "direct_database_url",
    "test_database_url",
    "authorization",
    "x-notion-signature",
    "password",
    "token",
    "verification_token",
}


def _redact_dict(data: Any) -> Any:
    if isinstance(data, dict):
        cleaned: dict[str, Any] = {}
        for k, v in data.items():
            k_lower = str(k).lower().replace("_", "").replace("-", "")
            if any(rk.replace("_", "").replace("-", "") in k_lower for rk in REDACT_KEYS):
                cleaned[k] = "[REDACTED]"
            else:
                cleaned[k] = _redact_dict(v)
        return cleaned
    if isinstance(data, list):
        return [_redact_dict(item) for item in data]
    if isinstance(data, str):
        return sanitize_error_message(data)
    if isinstance(data, BaseException):
        return sanitize_error_message(str(data))
    return data


class RedactingJsonFormatter(logging.Formatter):
    """Formats log records as JSON with all sensitive tokens and keys redacted."""

    def format(self, record: logging.LogRecord) -> str:
        log_entry: dict[str, Any] = {
            "level": record.levelname.lower(),
            "time": self.formatTime(record, self.datefmt),
            "name": record.name,
            "message": sanitize_error_message(record.getMessage()),
        }

        # Include custom extra fields if attached
        standard_attrs = {
            "name",
            "msg",
            "args",
            "levelname",
            "levelno",
            "pathname",
            "filename",
            "module",
            "exc_info",
            "exc_text",
            "stack_info",
            "lineno",
            "funcName",
            "created",
            "msecs",
            "relativeCreated",
            "thread",
            "threadName",
            "processName",
            "process",
            "message",
            "asctime",
        }
        extras = {
            k: v
            for k, v in record.__dict__.items()
            if k not in standard_attrs and not k.startswith("_")
        }
        if extras:
            log_entry["extra"] = _redact_dict(extras)

        if record.exc_info and record.exc_info[1] is not None:
            log_entry["exception"] = sanitize_error_message(self.formatException(record.exc_info))

        return json.dumps(log_entry, default=str)


def parse_log_level(level_str: str | None) -> int:
    if not level_str:
        return logging.INFO
    lvl = level_str.lower().strip()
    if lvl in ("trace", "debug"):
        return logging.DEBUG
    if lvl in ("info",):
        return logging.INFO
    if lvl in ("warn", "warning"):
        return logging.WARNING
    if lvl in ("error",):
        return logging.ERROR
    if lvl in ("fatal", "critical"):
        return logging.CRITICAL
    if lvl in ("silent", "none"):
        return logging.CRITICAL + 10
    return logging.INFO


def setup_logger(name: str = "notion_sync") -> logging.Logger:
    logger = logging.getLogger(name)
    level_str = os.getenv("LOG_LEVEL")
    if (os.getenv("APP_ENV") == "test" or os.getenv("NODE_ENV") == "test") and not level_str:
        level_str = "silent"

    logger.setLevel(parse_log_level(level_str))

    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(RedactingJsonFormatter())
        logger.addHandler(handler)
        logger.propagate = False

    return logger


def get_logger(name: str = "notion_sync") -> logging.Logger:
    return setup_logger(name)


def configure_logging(level_str: str | None = None, pretty: bool = False) -> None:
    root = setup_logger("notion_sync")
    if level_str:
        root.setLevel(parse_log_level(level_str))


logger = setup_logger()
