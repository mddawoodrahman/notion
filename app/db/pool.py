from __future__ import annotations

import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any, TypeVar, cast

from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from app.config import get_config
from app.errors import DatabaseError

T = TypeVar("T")

_default_pool: AsyncConnectionPool | None = None


def resolve_ssl_config(
    connection_string: str,
    allow_insecure: bool | None = None,
) -> bool | dict[str, bool] | None:
    """Resolves SSL config matching SEC-002: verified TLS by default, opt-out only when insecure."""
    if "sslmode=disable" in connection_string:
        return None

    if allow_insecure is None:
        allow_insecure = os.getenv("DB_SSL_INSECURE") == "true"

    is_ssl = "sslmode=require" in connection_string or (
        "localhost" not in connection_string and "127.0.0.1" not in connection_string
    )

    if not is_ssl:
        return None

    return {"rejectUnauthorized": False} if allow_insecure else True


def resolve_conninfo_ssl(
    connection_string: str,
    allow_insecure: bool | None = None,
) -> str:
    """Adjusts connection string for SSL configuration matching SEC-002."""
    if "sslmode=disable" in connection_string:
        return connection_string

    if allow_insecure is None:
        allow_insecure = os.getenv("DB_SSL_INSECURE") == "true"

    is_ssl = "sslmode=require" in connection_string or (
        "localhost" not in connection_string and "127.0.0.1" not in connection_string
    )

    if not is_ssl:
        return connection_string

    # SEC-002: verify TLS certificates by default. DB_SSL_INSECURE=true allows disabling cert verification.
    if allow_insecure:
        if "sslmode=" in connection_string:
            return connection_string
        sep = "&" if "?" in connection_string else "?"
        return f"{connection_string}{sep}sslmode=require"

    if "sslmode=" not in connection_string:
        sep = "&" if "?" in connection_string else "?"
        return f"{connection_string}{sep}sslmode=require"

    return connection_string


def create_pool(
    connection_string: str,
    min_size: int = 1,
    max_size: int = 10,
    open_pool: bool = True,
) -> AsyncConnectionPool:
    conninfo = resolve_conninfo_ssl(connection_string)
    pool = AsyncConnectionPool(
        conninfo=conninfo,
        min_size=min_size,
        max_size=max_size,
        timeout=5.0,
        max_idle=30.0,
        open=open_pool,
    )
    return pool


async def get_pool(connection_string: str | None = None) -> AsyncConnectionPool:
    global _default_pool
    if connection_string:
        pool = create_pool(connection_string, open_pool=False)
        await pool.open()
        return pool

    if _default_pool is None:
        config = get_config()
        _default_pool = create_pool(config.DATABASE_URL, open_pool=False)
        await _default_pool.open()

    return _default_pool


async def close_pool(pool: AsyncConnectionPool | None = None) -> None:
    global _default_pool
    if pool is not None:
        await pool.close()
    elif _default_pool is not None:
        await _default_pool.close()
        _default_pool = None


@asynccontextmanager
async def transaction_scope(
    pool_or_conn: AsyncConnectionPool | AsyncConnection,
) -> AsyncIterator[AsyncConnection]:
    """Yields an AsyncConnection within an active transaction block.

    Rolls back automatically on failure, returns connection to pool,
    and wraps errors in DatabaseError with sqlstate / pg_code.
    """
    if hasattr(pool_or_conn, "connection") and not hasattr(pool_or_conn, "cursor"):
        async with cast(AsyncConnectionPool, pool_or_conn).connection() as conn:
            try:
                async with conn.transaction():
                    yield conn
            except Exception as err:
                pg_code = getattr(err, "sqlstate", None) or getattr(err, "pgcode", None)
                msg = f"Transaction failed: {err}"
                raise DatabaseError(
                    msg, pg_code=str(pg_code) if pg_code else None, cause=err
                ) from err
    else:
        conn = cast(AsyncConnection, pool_or_conn)
        try:
            async with conn.transaction():
                yield conn
        except Exception as err:
            pg_code = getattr(err, "sqlstate", None) or getattr(err, "pgcode", None)
            msg = f"Transaction failed: {err}"
            raise DatabaseError(msg, pg_code=str(pg_code) if pg_code else None, cause=err) from err


async def with_transaction(
    pool_or_conn: AsyncConnectionPool | AsyncConnection,
    fn: Callable[[AsyncConnection], Any],
) -> Any:
    """Executes fn(conn) within a PostgreSQL transaction block."""
    async with transaction_scope(pool_or_conn) as conn:
        return await fn(conn)
