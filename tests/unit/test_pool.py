"""Unit tests for database pool and SSL resolution (SEC-002)."""

from unittest.mock import MagicMock

import pytest

from app.db.pool import resolve_ssl_config, with_transaction
from app.errors import DatabaseError


def test_uses_certificate_verified_tls_for_remote_host_without_sslmode() -> None:
    assert (
        resolve_ssl_config("postgresql://user:pass@ep-pool.neon.tech/neondb", allow_insecure=False)
        is True
    )


def test_uses_certificate_verified_tls_when_connection_string_requires_ssl() -> None:
    assert (
        resolve_ssl_config(
            "postgresql://user:pass@localhost:5432/db?sslmode=require", allow_insecure=False
        )
        is True
    )


def test_does_not_enable_tls_for_localhost_without_sslmode() -> None:
    assert (
        resolve_ssl_config("postgresql://user:pass@localhost:5432/db", allow_insecure=False) is None
    )


def test_does_not_enable_tls_for_127_0_0_1_without_sslmode() -> None:
    assert (
        resolve_ssl_config("postgresql://user:pass@127.0.0.1:5432/db", allow_insecure=False) is None
    )


def test_disables_certificate_verification_only_with_explicit_insecure_opt_in() -> None:
    assert resolve_ssl_config(
        "postgresql://user:pass@db.internal:5432/db", allow_insecure=True
    ) == {"rejectUnauthorized": False}


def test_keeps_insecure_opt_in_scoped_to_tls_connections() -> None:
    assert (
        resolve_ssl_config("postgresql://user:pass@localhost:5432/db", allow_insecure=True) is None
    )


@pytest.mark.asyncio
async def test_with_transaction_rolls_back_and_wraps_database_error() -> None:
    mock_conn = MagicMock()
    mock_conn.transaction.side_effect = Exception("boom")

    async def fail_fn(conn):
        pass

    with pytest.raises(DatabaseError) as exc_info:
        await with_transaction(mock_conn, fail_fn)

    assert "Transaction failed" in str(exc_info.value)
