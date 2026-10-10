"""wmlnb — what every notebook in notebooks/ shares: where the repo is, a read-only SQLite handle, and `extract`, which
pins a notebook's inputs by keeping the rows it used in a committed file (docs/dev/notebooks.md)."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[3]
"""The repository root."""


def open_ro(path: str | Path) -> sqlite3.Connection:
    """A SQLite database opened read-only, safe while a sweep is writing it."""
    return sqlite3.connect(f"file:{Path(path)}?mode=ro", uri=True)


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
