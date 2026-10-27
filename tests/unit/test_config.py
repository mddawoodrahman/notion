"""Unit tests for configuration and environment validation."""

import pytest

from app.config import validate_config
from app.errors import ConfigurationError


def test_loads_safely_in_test_environment_without_live_credentials() -> None:
    config = validate_config(
        {
            "NODE_ENV": "test",
            "PORT": "4000",
            "NOTION_VERSION": "2026-03-11",
        }
    )

    assert config.NODE_ENV == "test"
    assert config.APP_ENV == "test"
    assert config.PORT == 4000
    assert config.NOTION_VERSION == "2026-03-11"
    assert config.SYNC_TIMEZONE == "Asia/Kolkata"


def test_loads_safely_with_app_env_test() -> None:
    config = validate_config(
        {
            "APP_ENV": "test",
            "PORT": "4000",
            "NOTION_VERSION": "2026-03-11",
        }
    )

    assert config.APP_ENV == "test"
    assert config.NODE_ENV == "test"
    assert config.PORT == 4000


def test_fails_fast_in_production_if_notion_api_key_is_missing() -> None:
    with pytest.raises(ConfigurationError):
        validate_config(
            {
                "NODE_ENV": "production",
                "NOTION_DATABASE_ID": "12345678-1234-1234-1234-123456789abc",
                "DATABASE_URL": "postgresql://user:pass@localhost:5432/db",
                "NOTION_WEBHOOK_VERIFICATION_TOKEN": "token123456789012345678901234567890",
            }
        )


def test_fails_fast_in_production_if_database_url_is_missing() -> None:
    with pytest.raises(ConfigurationError):
        validate_config(
            {
                "NODE_ENV": "production",
                "NOTION_API_KEY": "secret_1234567890",
                "NOTION_DATABASE_ID": "12345678-1234-1234-1234-123456789abc",
                "NOTION_WEBHOOK_VERIFICATION_TOKEN": "token123456789012345678901234567890",
            }
        )


def test_fails_fast_in_production_if_notion_webhook_verification_token_is_missing() -> None:
    with pytest.raises(ConfigurationError):
        validate_config(
            {
                "NODE_ENV": "production",
                "NOTION_API_KEY": "secret_1234567890",
                "NOTION_DATABASE_ID": "12345678-1234-1234-1234-123456789abc",
                "DATABASE_URL": "postgresql://user:pass@localhost:5432/db",
            }
        )


def test_rejects_non_pinned_notion_version() -> None:
    with pytest.raises(ConfigurationError):
        validate_config(
            {
                "NODE_ENV": "test",
                "NOTION_VERSION": "2022-06-28",
            }
        )


def test_rejects_invalid_timezone() -> None:
    with pytest.raises(ConfigurationError):
        validate_config(
            {
                "NODE_ENV": "test",
                "SYNC_TIMEZONE": "Invalid/Not_A_Timezone",
            }
        )


def test_rejects_invalid_database_url_protocol() -> None:
    with pytest.raises(ConfigurationError):
        validate_config(
            {
                "NODE_ENV": "test",
                "DATABASE_URL": "mysql://user:pass@localhost/db",
            }
        )


def test_does_not_expose_secret_values_in_error_messages() -> None:
    sensitive_secret = "secret_topsecretvalue12345678"
    try:
        validate_config(
            {
                "NODE_ENV": "production",
                "NOTION_API_KEY": sensitive_secret,
                # intentionally missing DATABASE_URL
            }
        )
        pytest.fail("Expected ConfigurationError")
    except ConfigurationError as err:
        assert sensitive_secret not in str(err)


def test_requires_database_url_notion_api_key_and_database_id_outside_test() -> None:
    message = ""
    try:
        validate_config({"NODE_ENV": "development", "PORT": "3000"})
    except ConfigurationError as err:
        message = str(err)

    assert "DATABASE_URL" in message
    assert "NOTION_API_KEY" in message
    assert "NOTION_DATABASE_ID" in message

    # A fully specified development config is still accepted
    development = validate_config(
        {
            "NODE_ENV": "development",
            "NOTION_API_KEY": "secret_dev_placeholder_1234567890",
            "NOTION_DATABASE_ID": "12345678-1234-1234-1234-123456789abc",
            "DATABASE_URL": "postgresql://user:pass@localhost:5432/db",
        }
    )
    assert development.NODE_ENV == "development"
    assert development.NOTION_WEBHOOK_VERIFICATION_TOKEN is None


def test_keeps_offline_test_configs_working_and_marks_unsigned_webhooks_disallowed_by_default() -> (
    None
):
    config = validate_config({"NODE_ENV": "test", "PORT": "3000"})

    assert "postgresql://" in config.DATABASE_URL
    assert config.NOTION_API_KEY != ""
    assert config.NOTION_DATABASE_ID != ""
    assert config.ALLOW_UNSIGNED_WEBHOOKS is False


def test_forbids_allow_unsigned_webhooks_true_in_production() -> None:
    with pytest.raises(ConfigurationError, match=r"ALLOW_UNSIGNED_WEBHOOKS"):
        validate_config(
            {
                "NODE_ENV": "production",
                "NOTION_API_KEY": "secret_1234567890",
                "NOTION_DATABASE_ID": "12345678-1234-1234-1234-123456789abc",
                "DATABASE_URL": "postgresql://user:pass@localhost:5432/db",
                "NOTION_WEBHOOK_VERIFICATION_TOKEN": "token123456789012345678901234567890",
                "ALLOW_UNSIGNED_WEBHOOKS": "true",
            }
        )


def test_validate_config_with_none_loads_from_environment() -> None:
    # In test environment, raw=None should safely load test defaults
    config = validate_config(None)
    assert config.NODE_ENV == "test"
    assert config.NOTION_VERSION == "2026-03-11"


def test_create_app_fails_fast_when_configuration_is_invalid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.config import clear_config_cache_for_testing, reset_config_for_testing
    from app.main import create_app

    clear_config_cache_for_testing()
    # Set NODE_ENV to production and clear required keys
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.delenv("NOTION_API_KEY", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)

    try:
        with pytest.raises(ConfigurationError):
            create_app()
    finally:
        # Reset back to test config
        monkeypatch.setenv("NODE_ENV", "test")
        reset_config_for_testing({"NODE_ENV": "test"})


def test_create_app_fails_fast_when_app_env_production_and_invalid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.config import clear_config_cache_for_testing, reset_config_for_testing
    from app.main import create_app

    clear_config_cache_for_testing()
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("NOTION_API_KEY", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)

    try:
        with pytest.raises(ConfigurationError):
            create_app()
    finally:
        monkeypatch.setenv("APP_ENV", "test")
        reset_config_for_testing({"APP_ENV": "test"})
