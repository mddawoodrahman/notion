"""Unit tests for db:migrate CLI routing (BUG-005)."""

from pathlib import Path

from app.db.migrate import resolve_migration_operation


def test_routes_no_argument_to_running_migrations() -> None:
    assert resolve_migration_operation(["python", "app/db/migrate.py"]) == "run_migrations"
    assert resolve_migration_operation(["python", "app/db/migrate.py", "up"]) == "run_migrations"


def test_routes_status_to_status_inspection() -> None:
    assert resolve_migration_operation(["python", "app/db/migrate.py", "status"]) == "show_status"


def test_shows_that_hardcoded_up_shadows_command() -> None:
    assert (
        resolve_migration_operation(["python", "app/db/migrate.py", "up", "status"])
        == "run_migrations"
    )


def test_rejects_unknown_commands() -> None:
    assert resolve_migration_operation(["python", "app/db/migrate.py", "down"]) == "unknown"


def test_handles_standard_python_sys_argv() -> None:
    assert resolve_migration_operation(["app/db/migrate.py"]) == "run_migrations"
    assert resolve_migration_operation(["app/db/migrate.py", "up"]) == "run_migrations"
    assert resolve_migration_operation(["app/db/migrate.py", "status"]) == "show_status"
    assert resolve_migration_operation(["app/db/migrate.py", "unknown"]) == "unknown"


def test_pyproject_toml_scripts_define_notion_sync() -> None:
    pyproject_path = Path(__file__).resolve().parent.parent.parent / "pyproject.toml"
    assert pyproject_path.exists()
    content = pyproject_path.read_text(encoding="utf-8")
    assert 'notion-sync = "app.cli.main:app"' in content
