from __future__ import annotations

import hashlib
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.config import get_config
from app.db.pool import close_pool, get_pool
from app.errors import DatabaseError
from app.logging_config import logger

MigrationOperation = Literal["run_migrations", "show_status", "unknown"]


@dataclass(frozen=True)
class MigrationResult:
    version: str
    applied: bool
    checksum: str


@dataclass(frozen=True)
class MigrationStatusItem:
    version: str
    applied: bool
    applied_at: datetime | None = None


def resolve_migration_operation(argv: list[str] | None = None) -> MigrationOperation:
    """Maps CLI argv to a migration operation (BUG-005).

    Supports both standard Python sys.argv layout:
      ['app/db/migrate.py', 'status'] -> argv[1]
    and runner-style argv layout:
      ['python', 'app/db/migrate.py', 'status'] -> argv[2]
    """
    if argv is None:
        argv = sys.argv

    command = "up"
    if len(argv) > 2 and (
        argv[0] in ("python", "python3")
        or argv[0].endswith(("python", "python.exe", "python3", "python3.exe"))
        or "migrate" in argv[1]
    ):
        command = argv[2]
    elif len(argv) > 1 and argv[0] not in ("python", "python3"):
        command = argv[1]
    elif len(argv) > 2:
        command = argv[2]

    if command == "status":
        return "show_status"
    if command == "up":
        return "run_migrations"
    return "unknown"


def resolve_migrations_dir(explicit: str | Path | None = None) -> Path:
    """Resolves the directory containing SQL migrations.

    Checks:
    1. Explicit path if provided.
    2. Path relative to current working directory (e.g. /app/migrations or repo root).
    3. Upward directory hierarchy relative to this source file.
    4. Container root /app/migrations.
    5. Standard relative fallback: Path(__file__).resolve().parent.parent.parent / "migrations".
    """
    if explicit is not None:
        return Path(explicit)

    # 1. Working directory
    cwd_migrations = Path.cwd() / "migrations"
    if cwd_migrations.is_dir():
        return cwd_migrations

    # 2. Upward directory hierarchy from this file
    curr = Path(__file__).resolve().parent
    for _ in range(5):
        cand = curr / "migrations"
        if cand.is_dir():
            return cand
        curr = curr.parent

    # 3. Standard container location
    container_migrations = Path("/app/migrations")
    if container_migrations.is_dir():
        return container_migrations

    return Path(__file__).resolve().parent.parent.parent / "migrations"


async def run_migrations(
    pool: AsyncConnectionPool,
    migrations_dir: str | Path | None = None,
) -> list[MigrationResult]:
    migrations_dir = resolve_migrations_dir(migrations_dir)

    results: list[MigrationResult] = []

    async with pool.connection() as conn:
        # Acquire session-level advisory lock
        await conn.execute("SELECT pg_advisory_lock(hashtext('notion_sync_migrations'))")
        try:
            # Ensure schema and tracking table exist
            await conn.execute("CREATE SCHEMA IF NOT EXISTS notion_sync")
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS notion_sync.schema_migrations (
                    version     TEXT PRIMARY KEY,
                    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    checksum    TEXT NOT NULL
                )
                """
            )

            # Fetch applied migrations
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    "SELECT version, checksum FROM notion_sync.schema_migrations ORDER BY version ASC"
                )
                applied_rows = await cur.fetchall()

            applied_map = {r["version"]: r["checksum"] for r in applied_rows}

            # List and sort SQL files
            sql_files = sorted(
                [
                    f.name
                    for f in migrations_dir.iterdir()
                    if f.is_file() and f.name.endswith(".sql")
                ]
            )

            for filename in sql_files:
                file_path = migrations_dir / filename
                sql_content = file_path.read_text(encoding="utf-8")
                checksum = hashlib.sha256(sql_content.encode("utf-8")).hexdigest()

                existing_checksum = applied_map.get(filename)
                if existing_checksum:
                    if existing_checksum != checksum:
                        raise DatabaseError(
                            f"Migration checksum mismatch for {filename}: applied checksum "
                            f"{existing_checksum[:8]} does not match local file {checksum[:8]}"
                        )
                    results.append(
                        MigrationResult(version=filename, applied=False, checksum=checksum)
                    )
                    continue

                # Apply new migration in transaction
                try:
                    async with conn.transaction():
                        await conn.execute(sql_content)
                        await conn.execute(
                            "INSERT INTO notion_sync.schema_migrations (version, checksum) VALUES (%s, %s)",
                            (filename, checksum),
                        )
                    logger.info("Migration applied successfully", extra={"version": filename})
                    results.append(
                        MigrationResult(version=filename, applied=True, checksum=checksum)
                    )
                except Exception as err:
                    raise DatabaseError(
                        f"Failed to apply migration {filename}: {err}", cause=err
                    ) from err

            return results
        finally:
            try:
                await conn.execute("SELECT pg_advisory_unlock(hashtext('notion_sync_migrations'))")
            except Exception:
                pass


async def get_migration_status(
    pool: AsyncConnectionPool,
    migrations_dir: str | Path | None = None,
) -> list[MigrationStatusItem]:
    migrations_dir = resolve_migrations_dir(migrations_dir)

    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_schema = 'notion_sync'
                    AND table_name = 'schema_migrations'
                ) AS exists
                """
            )
            row = await cur.fetchone()
            table_exists = row["exists"] if row else False

            applied_map: dict[str, datetime] = {}
            if table_exists:
                await cur.execute("SELECT version, applied_at FROM notion_sync.schema_migrations")
                applied_rows = await cur.fetchall()
                for r in applied_rows:
                    applied_map[r["version"]] = r["applied_at"]

        sql_files = sorted(
            [f.name for f in migrations_dir.iterdir() if f.is_file() and f.name.endswith(".sql")]
        )

        return [
            MigrationStatusItem(
                version=f,
                applied=f in applied_map,
                applied_at=applied_map.get(f),
            )
            for f in sql_files
        ]


async def cli_main() -> None:
    operation = resolve_migration_operation()
    config = get_config()
    conn_string = config.DIRECT_DATABASE_URL or config.DATABASE_URL
    pool = await get_pool(conn_string)

    try:
        if operation == "show_status":
            status = await get_migration_status(pool)
            print("Migration status:")
            for item in status:
                applied_mark = "[X]" if item.applied else "[ ]"
                info = (
                    f"(applied at {item.applied_at.isoformat()})"
                    if item.applied_at
                    else "(pending)"
                )
                print(f"  {applied_mark} {item.version} {info}")
        elif operation == "run_migrations":
            results = await run_migrations(pool)
            applied_count = sum(1 for r in results if r.applied)
            print(f"Migrations complete. Applied {applied_count} new migrations.")
        else:
            arg = sys.argv[1] if len(sys.argv) > 1 else ""
            print(f"Unknown migration command: {arg}. Use 'up' or 'status'.", file=sys.stderr)
            sys.exit(1)
    finally:
        await close_pool(pool)


if __name__ == "__main__":
    import asyncio

    asyncio.run(cli_main())
