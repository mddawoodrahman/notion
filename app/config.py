from __future__ import annotations

import os
from typing import Any, Literal
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from pydantic import BaseModel, Field, ValidationError

from app.errors import ConfigurationError, sanitize_error_message

AppEnv = Literal["development", "test", "production"]
NodeEnv = AppEnv  # backward compatibility alias
LogLevel = Literal["trace", "debug", "info", "warn", "error", "fatal", "silent"]


class RawEnvModel(BaseModel):
    APP_ENV: AppEnv | None = None
    NODE_ENV: AppEnv | None = None
    PORT: int = Field(default=3000, ge=1, le=65535)

    NOTION_API_KEY: str | None = None
    NOTION_DATABASE_ID: str | None = None
    NOTION_DATA_SOURCE_ID: str | None = None
    NOTION_VERSION: str = "2026-03-11"
    NOTION_WEBHOOK_VERIFICATION_TOKEN: str | None = None
    ALLOW_UNSIGNED_WEBHOOKS: str | bool | None = None

    DATABASE_URL: str | None = None
    DIRECT_DATABASE_URL: str | None = None
    TEST_DATABASE_URL: str | None = None

    SYNC_TIMEZONE: str = "Asia/Kolkata"
    SYNC_RECONCILIATION_INTERVAL_MINUTES: int = Field(default=30, ge=1, le=1440)
    SYNC_MAX_ATTEMPTS: int = Field(default=8, ge=1, le=20)
    SYNC_PAGE_SIZE: int = Field(default=100, ge=1, le=100)
    SYNC_SYNC_BODY_CONTENT: bool = True
    SYNC_LEASE_SECONDS: int = Field(default=300, ge=30, le=3600)
    LOG_LEVEL: LogLevel = "info"


class AppConfig(BaseModel):
    APP_ENV: AppEnv
    NODE_ENV: AppEnv
    PORT: int
    NOTION_API_KEY: str
    NOTION_DATABASE_ID: str
    NOTION_DATA_SOURCE_ID: str | None = None
    NOTION_VERSION: Literal["2026-03-11"]
    NOTION_WEBHOOK_VERIFICATION_TOKEN: str | None = None
    ALLOW_UNSIGNED_WEBHOOKS: bool
    DATABASE_URL: str
    DIRECT_DATABASE_URL: str | None = None
    TEST_DATABASE_URL: str | None = None
    SYNC_TIMEZONE: str
    SYNC_RECONCILIATION_INTERVAL_MINUTES: int
    SYNC_MAX_ATTEMPTS: int
    SYNC_PAGE_SIZE: int
    SYNC_SYNC_BODY_CONTENT: bool
    SYNC_LEASE_SECONDS: int
    LOG_LEVEL: LogLevel


def validate_config(raw: dict[str, Any] | None = None) -> AppConfig:
    if raw is None:
        if os.getenv("APP_ENV") != "test" and os.getenv("NODE_ENV") != "test":
            load_dotenv(override=False)
        raw = dict(os.environ)

    # Coerce sync_sync_body_content if string
    raw_copy = dict(raw)
    if "SYNC_SYNC_BODY_CONTENT" in raw_copy:
        val = raw_copy["SYNC_SYNC_BODY_CONTENT"]
        if isinstance(val, str):
            raw_copy["SYNC_SYNC_BODY_CONTENT"] = val.lower() in ("true", "1")

    try:
        parsed = RawEnvModel(**raw_copy)
    except ValidationError as e:
        error_issues = ", ".join(
            f"{'.'.join(str(loc) for loc in err['loc'])}: {err['msg']}" for err in e.errors()
        )
        safe_msg = sanitize_error_message(f"Environment validation failed: {error_issues}")
        raise ConfigurationError(safe_msg) from e

    app_env: AppEnv
    if parsed.APP_ENV == "production" or parsed.NODE_ENV == "production":
        app_env = "production"
    elif parsed.APP_ENV == "test" or parsed.NODE_ENV == "test":
        app_env = "test"
    else:
        app_env = "development"
    is_production = app_env == "production"
    is_test = app_env == "test"

    allow_unsigned = False
    if parsed.ALLOW_UNSIGNED_WEBHOOKS is not None:
        if isinstance(parsed.ALLOW_UNSIGNED_WEBHOOKS, bool):
            allow_unsigned = parsed.ALLOW_UNSIGNED_WEBHOOKS
        elif isinstance(parsed.ALLOW_UNSIGNED_WEBHOOKS, str):
            allow_unsigned = parsed.ALLOW_UNSIGNED_WEBHOOKS.lower() in ("true", "1")

    # Notion version pinning check
    if parsed.NOTION_VERSION != "2026-03-11":
        raise ConfigurationError(
            f"Invalid NOTION_VERSION: '{parsed.NOTION_VERSION}'. The service requires pinned version '2026-03-11'."
        )

    # Validate timezone
    try:
        ZoneInfo(parsed.SYNC_TIMEZONE)
    except Exception as tz_err:
        raise ConfigurationError(f"Invalid IANA time zone: {parsed.SYNC_TIMEZONE}") from tz_err

    # SEC-001: unsigned webhook ingestion must never be enabled in production
    if is_production and allow_unsigned:
        raise ConfigurationError(
            "ALLOW_UNSIGNED_WEBHOOKS=true is forbidden in production; configure NOTION_WEBHOOK_VERIFICATION_TOKEN instead"
        )

    # Missing mandatory variables outside test
    missing: list[str] = []
    if not is_test:
        if not parsed.NOTION_API_KEY:
            missing.append("NOTION_API_KEY")
        if not parsed.NOTION_DATABASE_ID:
            missing.append("NOTION_DATABASE_ID")
        if not parsed.DATABASE_URL:
            missing.append("DATABASE_URL")
        if is_production and not parsed.NOTION_WEBHOOK_VERIFICATION_TOKEN:
            missing.append("NOTION_WEBHOOK_VERIFICATION_TOKEN")

    if missing:
        msg = (
            f"Missing mandatory production environment variables: {', '.join(missing)}"
            if is_production
            else f"Missing required environment variables (set APP_ENV=test to use offline placeholders): {', '.join(missing)}"
        )
        raise ConfigurationError(msg)

    # Token format check
    if parsed.NOTION_API_KEY:
        if not (
            parsed.NOTION_API_KEY.startswith("secret_") or parsed.NOTION_API_KEY.startswith("ntn_")
        ):
            if is_production:
                raise ConfigurationError("NOTION_API_KEY must start with 'secret_' or 'ntn_'")

    # DATABASE_URL protocol check
    if parsed.DATABASE_URL:
        if not (
            parsed.DATABASE_URL.startswith("postgresql://")
            or parsed.DATABASE_URL.startswith("postgres://")
        ):
            raise ConfigurationError(
                "DATABASE_URL must be a valid postgresql:// or postgres:// URI"
            )

    return AppConfig(
        APP_ENV=app_env,
        NODE_ENV=app_env,
        PORT=parsed.PORT,
        NOTION_API_KEY=parsed.NOTION_API_KEY
        or ("secret_mock_test_key_placeholder" if is_test else ""),
        NOTION_DATABASE_ID=parsed.NOTION_DATABASE_ID
        or ("00000000-0000-0000-0000-000000000000" if is_test else ""),
        NOTION_DATA_SOURCE_ID=parsed.NOTION_DATA_SOURCE_ID,
        NOTION_VERSION="2026-03-11",
        NOTION_WEBHOOK_VERIFICATION_TOKEN=parsed.NOTION_WEBHOOK_VERIFICATION_TOKEN,
        ALLOW_UNSIGNED_WEBHOOKS=allow_unsigned,
        DATABASE_URL=parsed.DATABASE_URL
        or ("postgresql://mock:mock@localhost:5432/mock" if is_test else ""),
        DIRECT_DATABASE_URL=parsed.DIRECT_DATABASE_URL,
        TEST_DATABASE_URL=parsed.TEST_DATABASE_URL,
        SYNC_TIMEZONE=parsed.SYNC_TIMEZONE,
        SYNC_RECONCILIATION_INTERVAL_MINUTES=parsed.SYNC_RECONCILIATION_INTERVAL_MINUTES,
        SYNC_MAX_ATTEMPTS=parsed.SYNC_MAX_ATTEMPTS,
        SYNC_PAGE_SIZE=parsed.SYNC_PAGE_SIZE,
        SYNC_SYNC_BODY_CONTENT=parsed.SYNC_SYNC_BODY_CONTENT,
        SYNC_LEASE_SECONDS=parsed.SYNC_LEASE_SECONDS,
        LOG_LEVEL=parsed.LOG_LEVEL,
    )


_cached_config: AppConfig | None = None


def get_config() -> AppConfig:
    global _cached_config
    if _cached_config is None:
        _cached_config = validate_config()
    return _cached_config


def reset_config_for_testing(overrides: dict[str, Any] | None = None) -> AppConfig:
    global _cached_config
    _cached_config = validate_config(overrides if overrides is not None else dict(os.environ))
    return _cached_config


def clear_config_cache_for_testing() -> None:
    global _cached_config
    _cached_config = None
