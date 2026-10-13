"""wmlnb — what every notebook in notebooks/ shares: where the repo is, a read-only SQLite handle, `find_sweep`, `store`
(the bench store on mlbox as DuckDB), and `extract`, which pins a notebook's inputs by keeping the rows it used in a
committed file (docs/dev/notebooks.md)."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[3]
"""The repository root."""


def open_ro(path: str | Path) -> sqlite3.Connection:
    """A SQLite database opened read-only, safe while a sweep is writing it."""
    return sqlite3.connect(f"file:{Path(path)}?mode=ro", uri=True)


def find_sweep(name: str) -> Path:
    """A bench sweep's folder by name, wherever it sits: this checkout's `tests/e2e/artifacts/bench/`, what
    `sync.mjs pull --traces` fetched into `bench-pool/traces/`, then the same in every sibling `window-ml*` clone (sweeps
    move into the main clone when their branch merges). `SWEEP_ROOT` in the environment, when set, is tried first."""
    roots = [Path(os.environ["SWEEP_ROOT"])] if os.environ.get("SWEEP_ROOT") else []
    for clone in [ROOT, *sorted(p for p in ROOT.parent.glob("window-ml*") if p != ROOT)]:
        roots += [clone / "tests/e2e/artifacts/bench", clone / "tests/e2e/artifacts/bench-pool/traces"]
    for r in roots:
        if (r / name).is_dir():
            return r / name
    raise FileNotFoundError(f"no sweep {name!r} in any of: {', '.join(str(r) for r in roots)}")


def _dotenv() -> dict[str, str]:
    """The repo's `.env` as a dict (the first `=` splits; one layer of quotes stripped), {} when there is none.
    The same reading as scripts/dotenv.mjs; a real environment variable wins over it."""
    try:
        text = (ROOT / ".env").read_text()
    except OSError:
        return {}
    out = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        out[k.strip()] = v
    return out


def _sql_str(v: str) -> str:
    return "'" + v.replace("'", "''") + "'"


def store():
    """The bench store (Garage on mlbox, tests/e2e/bench/sync.mjs) as a DuckDB connection, with the store's own
    `views.sql` loaded: `scores`, `calls`, `price_snapshots` and `box_frames`, one row per key. Query the views, never
    `read_parquet` over the objects: the store is at-least-once, so a row can sit in two objects. Trace files are under
    `s3://<bucket>/traces/<sweep>/…` (the bucket's name is the SQL variable `getvariable('wml_bucket')`).

    Settings from the environment or `.env`: BENCH_STORE_URL, BENCH_STORE_KEY_ID, BENCH_STORE_SECRET, and optionally
    BENCH_STORE_BUCKET and BENCH_STORE_REGION, as sync.mjs reads them. The URL and key never appear in a returned
    value or in an error raised here; a notebook still must not print the connection's settings. The store changes with
    every push, so a notebook prose will cite reads it inside `extract`."""
    import duckdb

    env = {**_dotenv(), **os.environ}
    url, key_id, secret = env.get("BENCH_STORE_URL", ""), env.get("BENCH_STORE_KEY_ID", ""), env.get("BENCH_STORE_SECRET", "")
    if not (url and key_id and secret):
        raise RuntimeError("the bench store is not configured (BENCH_STORE_URL, BENCH_STORE_KEY_ID, BENCH_STORE_SECRET in .env)")
    bucket, region = env.get("BENCH_STORE_BUCKET") or "wml-bench", env.get("BENCH_STORE_REGION") or "garage"
    u = urlparse(url)
    secrets = [s for s in (url, u.netloc, u.hostname or "", key_id, secret) if s]

    def scrub(e: Exception) -> RuntimeError:
        msg = str(e)
        for s in secrets:
            msg = msg.replace(s, "<store>")
        return RuntimeError(f"bench store: {msg[:300]}")

    con = duckdb.connect()
    try:
        con.execute("INSTALL httpfs")
        con.execute("LOAD httpfs")
        con.execute(f"""CREATE SECRET wml_bench_store (TYPE s3, KEY_ID {_sql_str(key_id)}, SECRET {_sql_str(secret)},
            ENDPOINT {_sql_str(u.netloc)}, URL_STYLE 'path', USE_SSL {str(u.scheme == "https").lower()}, REGION {_sql_str(region)})""")
        views = con.execute("SELECT content FROM read_text(?)", [f"s3://{bucket}/views.sql"]).fetchone()[0]
        con.execute(views)
        con.execute(f"SET VARIABLE wml_bucket = {_sql_str(bucket)}")
    except Exception as e:
        con.close()
        raise scrub(e) from None
    return con


def _commit() -> str | None:
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return None


def sha256_file(path: str | Path) -> str:
    """Lowercase hex sha256 of a file's bytes."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def extract(path: str | Path, fn: Callable[[], Any], *, source: dict[str, Any], refresh_env: str = "NB_REFRESH") -> Any:
    """The rows a notebook analyses, pinned: `fn()` reads them from wherever they live (a sweep's folders, a live
    database) and the result is written to `path` (a committed JSON file beside the notebook) with `source` (what was
    read: sweep names, database paths, query), the commit and the time. Every later run reads the file instead, so the
    notebook does not depend on the live data still holding those rows. Set the environment variable `refresh_env` to
    1 to read the source again; delete the file to do the same.
    """
    path = Path(path)
    if path.exists() and os.environ.get(refresh_env) != "1":
        return json.loads(path.read_text())["rows"]
    rows = fn()
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {"source": source, "commit": _commit(), "extracted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "rows": rows}
    path.write_text(json.dumps(body, indent=2, sort_keys=True) + "\n")
    return rows


def provenance(*paths: str | Path) -> list[dict[str, Any]]:
    """What each pinned extract says it was read from, with its own hash: the first cell prints this, so the notebook
    states which data its numbers come from."""
    out = []
    for p in paths:
        p = Path(p)
        body = json.loads(p.read_text())
        out.append({"extract": str(p.relative_to(ROOT)), "sha256": sha256_file(p)[:16], "rows": len(body["rows"]),
                    "extracted_at": body.get("extracted_at"), "commit": (body.get("commit") or "")[:12], **body.get("source", {})})
    return out
