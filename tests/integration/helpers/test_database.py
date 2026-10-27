"""Helper for starting an ephemeral PostgreSQL instance for integration testing."""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg


def get_free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port: int = int(s.getsockname()[1])
    s.close()
    return port


def find_postgres_binaries() -> tuple[Path, Path]:
    """Finds initdb and postgres binaries from system PATH or standard install locations."""
    # 1. System PATH
    initdb_path = shutil.which("initdb")
    postgres_path = shutil.which("postgres")
    if initdb_path and postgres_path:
        return Path(initdb_path), Path(postgres_path)

    # 2. Windows standard installation locations (e.g. C:\Program Files\PostgreSQL\<version>\bin)
    if sys.platform == "win32":
        for base in [
            Path("C:/Program Files/PostgreSQL"),
            Path("C:/Program Files (x86)/PostgreSQL"),
        ]:
            if base.exists():
                for version_dir in sorted(base.glob("*"), reverse=True):
                    pg_bin = version_dir / "bin" / "postgres.exe"
                    initdb_bin = version_dir / "bin" / "initdb.exe"
                    if pg_bin.exists() and initdb_bin.exists():
                        return initdb_bin, pg_bin

    # 3. Linux common PostgreSQL directories (/usr/lib/postgresql/*/bin)
    if sys.platform != "win32":
        for p in sorted(Path("/usr/lib/postgresql").glob("*/bin/postgres"), reverse=True):
            initdb = p.parent / "initdb"
            if initdb.exists():
                return initdb, p
        # macOS Homebrew
        for p in sorted(Path("/opt/homebrew/opt").glob("postgresql*/bin/postgres"), reverse=True):
            initdb = p.parent / "initdb"
            if initdb.exists():
                return initdb, p
        for p in sorted(Path("/usr/local/opt").glob("postgresql*/bin/postgres"), reverse=True):
            initdb = p.parent / "initdb"
            if initdb.exists():
                return initdb, p

    raise RuntimeError(
        "Could not find PostgreSQL binaries (initdb and postgres) in PATH or standard install directories"
    )


@dataclass
class TestDatabase:
    __test__ = False
    url: str
    temp_dir: str | None
    proc: subprocess.Popen[Any] | None

    async def stop(self) -> None:
        if self.proc is not None:
            try:
                if sys.platform == "win32":
                    subprocess.run(
                        ["taskkill", "/PID", str(self.proc.pid), "/F", "/T"],
                        capture_output=True,
                    )
                else:
                    self.proc.terminate()
                    try:
                        self.proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self.proc.kill()
                        self.proc.wait(timeout=2)
            except Exception:
                pass
            self.proc = None

        if self.temp_dir and os.path.exists(self.temp_dir):
            try:
                shutil.rmtree(self.temp_dir, ignore_errors=True)
            except Exception:
                pass


async def start_test_database() -> TestDatabase:
    """Starts an ephemeral PostgreSQL cluster or connects to TEST_DATABASE_URL."""
    override_url = os.getenv("TEST_DATABASE_URL")
    if override_url:
        return TestDatabase(url=override_url, temp_dir=None, proc=None)

    initdb_bin, postgres_bin = find_postgres_binaries()
    port = get_free_port()
    temp_dir = tempfile.mkdtemp(prefix="taskbridge-pg-")
    data_dir = os.path.join(temp_dir, "data")
    pw_file = os.path.join(temp_dir, "pw.txt")

    with open(pw_file, "w", encoding="utf-8") as f:
        f.write("postgres\n")

    # Run initdb
    init_cmd = [
        str(initdb_bin),
        f"--pgdata={data_dir}",
        "--auth=password",
        "--username=postgres",
        f"--pwfile={pw_file}",
        "--lc-messages=C",
        "--encoding=UTF8",
        "--locale=C",
    ]
    res = subprocess.run(init_cmd, capture_output=True, text=True)
    if res.returncode != 0:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise RuntimeError(f"initdb failed: {res.stderr}\n{res.stdout}")

    # Launch postgres server
    postgres_cmd = [
        str(postgres_bin),
        "-D",
        data_dir,
        "-p",
        str(port),
        "-h",
        "127.0.0.1",
        "-F",
    ]
    if sys.platform != "win32":
        postgres_cmd.extend(["-k", temp_dir])

    proc = subprocess.Popen(
        postgres_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    # Wait for postgres to be ready and create notion_test database
    ready = False
    for _ in range(50):
        if proc.poll() is not None:
            break
        try:
            with psycopg.connect(
                f"postgresql://postgres:postgres@127.0.0.1:{port}/postgres",
                autocommit=True,
                connect_timeout=2,
            ) as conn:
                with conn.cursor() as cur:
                    cur.execute("CREATE DATABASE notion_test;")
            ready = True
            break
        except Exception:
            time.sleep(0.1)

    if not ready:
        error_details = ""
        try:
            if proc.poll() is not None:
                stdout_data, stderr_data = proc.communicate(timeout=1)
                error_details = (
                    f"\nProcess exited early with return code {proc.returncode}."
                    f"\nSTDOUT:\n{stdout_data}\nSTDERR:\n{stderr_data}"
                )
            else:
                if sys.platform == "win32":
                    subprocess.run(
                        ["taskkill", "/PID", str(proc.pid), "/F", "/T"], capture_output=True
                    )
                else:
                    proc.terminate()
                    try:
                        proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=2)
                stdout_data, stderr_data = proc.communicate(timeout=2)
                error_details = (
                    f"\nProcess timed out without accepting connections."
                    f"\nSTDOUT:\n{stdout_data}\nSTDERR:\n{stderr_data}"
                )
        except Exception as ex:
            error_details = f"\nFailed capturing process diagnostics: {ex}"
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise RuntimeError(f"PostgreSQL server failed to start within timeout.{error_details}")

    url = f"postgresql://postgres:postgres@127.0.0.1:{port}/notion_test"
    return TestDatabase(url=url, temp_dir=temp_dir, proc=proc)
