"""pypi.py — reads PyPI for the pypi-compat notebook: the most-downloaded projects, each one's latest release (its files,
`requires_python`, `requires_dist`), and a STATIC verdict on whether python_exec's core could install it, from the wheel
tags and marker environment that core reports (probe.mjs env), its dependencies' verdicts included.

The verdict is about the latest release only, judged by tag, and ignores version constraints between packages:
micropip may still pick an older release or the lock's version. The empirical half (probe.mjs install) is the check.
"""

from __future__ import annotations

import json
import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from packaging.markers import InvalidMarker
from packaging.requirements import InvalidRequirement, Requirement
from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.utils import InvalidWheelFilename, canonicalize_name, parse_wheel_filename

TOP_URL = "https://hugovk.dev/top-pypi-packages/top-pypi-packages.min.json"
UA = {"User-Agent": "window-ml notebooks/python-packages (pypi-compat)"}


def _get_json(url: str):
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def top_projects(n: int) -> tuple[str, list[dict]]:
    """The `n` most-downloaded projects over the list's 30 days, with their rank and download count."""
    d = _get_json(TOP_URL)
    return d["last_update"], [{"rank": i + 1, "project": canonicalize_name(r["project"]), "downloads_30d": r["download_count"]}
                              for i, r in enumerate(d["rows"][:n])]


def project(name: str, cache: Path | None = None) -> dict | None:
    """One project's latest release, reduced to what the verdict needs. `cache` (a directory) keeps the reduced rows
    between runs while iterating; the notebook's pinned extract is the record."""
    if cache:
        f = cache / f"{name}.json"
        if f.exists():
            return json.loads(f.read_text())
    d = _get_json(f"https://pypi.org/pypi/{name}/json")
    if d is None:
        row = None
    else:
        info = d["info"]
        row = {
            "project": canonicalize_name(info["name"]),
            "version": info["version"],
            "requires_python": info.get("requires_python") or "",
            "requires_dist": info.get("requires_dist") or [],
            "summary": (info.get("summary") or "")[:160],
            "files": [{"filename": u["filename"], "size": u["size"], "packagetype": u["packagetype"], "yanked": u.get("yanked", False)}
                      for u in d["urls"]],
        }
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
        (cache / f"{name}.json").write_text(json.dumps(row))
    return row


def wheel_verdict(row: dict, tags: set[str], python: str) -> dict:
    """The latest release alone: does it have a wheel this core accepts, and of which kind."""
    wheels = [f for f in row["files"] if f["packagetype"] == "bdist_wheel" and not f["yanked"]]
    sdists = [f for f in row["files"] if f["packagetype"] == "sdist" and not f["yanked"]]
    ok_py = True
    if row["requires_python"]:
        try:
            ok_py = SpecifierSet(row["requires_python"]).contains(python, prereleases=True)
        except InvalidSpecifier:
            ok_py = True
    match, emscripten_any, n_compatible = None, False, 0
    for f in wheels:
        try:
            _, _, _, wtags = parse_wheel_filename(f["filename"])
        except InvalidWheelFilename:
            continue
        ws = {str(t) for t in wtags}
        if any("emscripten" in t or "pyodide" in t for t in ws):
            emscripten_any = True
        if ws & tags:
            n_compatible += 1
            pure = all(t.endswith("-none-any") for t in ws & tags)
            if match is None or (not pure and match["pure"]):
                match = {"filename": f["filename"], "size": f["size"], "pure": pure}
    if not ok_py:
        kind = "python-version"
    elif match:
        kind = "pure-wheel" if match["pure"] else "wasm-wheel"
    elif wheels:
        kind = "no-wasm-build"
    elif sdists:
        kind = "sdist-only"
    else:
        kind = "no-files"
    return {"kind": kind, "wheel": match, "emscripten_wheel_any_abi": emscripten_any, "n_wheels": len(wheels),
            "n_compatible_wheels": n_compatible, "host": host_verdict(row)}


def _host_tags() -> set[str]:
    """The tags a native CPython 3.14 on this laptop (macOS arm64) accepts: the PLACEMENT side of the spec, where a
    package Pyodide cannot run may still run at the host (docs/spec/PYTHON_DIALECT.md, "Placement"). An assumption
    about the host's interpreter, not read from it."""
    from packaging import tags as t
    plats = list(t.mac_platforms((15, 0), "arm64"))
    return {str(x) for x in [*t.cpython_tags((3, 14), platforms=plats), *t.compatible_tags((3, 14), "cp314", plats)]}


HOST_TAGS = _host_tags()


def host_verdict(row: dict) -> str:
    """Whether the latest release installs on the host from a wheel: `pure`, `native` (a macOS arm64 wheel), or the
    same `sdist-only` / `none` as the browser verdict."""
    kinds = set()
    for f in row["files"]:
        if f["packagetype"] != "bdist_wheel" or f["yanked"]:
            continue
        try:
            ws = {str(x) for x in parse_wheel_filename(f["filename"])[3]}
        except InvalidWheelFilename:
            continue
        if ws & HOST_TAGS:
            kinds.add("pure" if all(x.endswith("-none-any") for x in ws & HOST_TAGS) else "native")
    if kinds:
        return "native" if "native" in kinds else "pure"
    return "sdist-only" if any(f["packagetype"] == "sdist" for f in row["files"]) else "none"


def deps(row: dict, env: dict) -> list[str]:
    """The release's unconditional dependencies (no extras) whose markers hold on the core."""
    return sorted(dep_specs(row, env))


def dep_specs(row: dict, env: dict) -> dict[str, str]:
    """The same dependencies, each with the version range it asks for (the ranges of a name listed twice joined)."""
    out: dict[str, list[str]] = {}
    for spec in row["requires_dist"]:
        try:
            r = Requirement(spec)
        except InvalidRequirement:
            continue
        try:
            if r.marker and not r.marker.evaluate({**env, "extra": ""}):
                continue
        except InvalidMarker:
            continue
        out.setdefault(canonicalize_name(r.name), []).append(str(r.specifier))
    return {k: ",".join(x for x in v if x) for k, v in out.items()}


def classify(top: list[dict], env_probe: dict, cache: Path | None = None, workers: int = 24) -> list[dict]:
    """Every project in `top` and every dependency reachable from one, each with its own verdict, its source (the lock
    wins, as micropip prefers it) and the first dependency that blocks it."""
    tags, env, python = set(env_probe["tags"]), env_probe["env"], env_probe["python"]
    lock = {canonicalize_name(k): v for k, v in env_probe["lock"].items()}
    # A lock package too old for a range is fatal only when micropip cannot replace it from PyPI: it is already
    # loaded (micropip and what it needs; in the extension, the start-up set too), or PyPI's latest release has no
    # wheel this core accepts inside that range.
    preloaded = {canonicalize_name(p) for p in env_probe.get("preloaded", [])}
    replaceable_memo: dict[tuple[str, str], bool] = {}

    def replaceable(d: str, spec: str) -> bool:
        if d in preloaded:
            return False
        if (d, spec) not in replaceable_memo:
            row = rows.get(d) or project(d, cache)
            ok = bool(row) and wheel_verdict(row, tags, python)["kind"] in ("pure-wheel", "wasm-wheel")
            try:
                ok = ok and SpecifierSet(spec).contains(row["version"], prereleases=True)
            except InvalidSpecifier:
                pass
            replaceable_memo[(d, spec)] = ok
        return replaceable_memo[(d, spec)]
    rows: dict[str, dict | None] = {}
    frontier = [t["project"] for t in top]
    with ThreadPoolExecutor(workers) as ex:
        while frontier:
            todo = [p for p in dict.fromkeys(frontier) if p not in rows]
            frontier = []
            for name, row in zip(todo, ex.map(lambda p: project(p, cache), todo)):
                rows[name] = row
                if row is not None and name not in lock:
                    frontier += deps(row, env)
    verdict: dict[str, dict] = {}
    # A lock entry's own dependencies are lock entries, never read from PyPI: seed them all.
    for name in lock:
        rows.setdefault(name, None)
    for name, row in rows.items():
        if name in lock:
            v = {"kind": "lock", "wheel": None, "deps": [canonicalize_name(d) for d in lock[name]["depends"]],
                 "lock_version": lock[name]["version"]}
        elif row is None:
            v = {"kind": "not-on-pypi", "wheel": None, "deps": []}
        else:
            specs = dep_specs(row, env)
            v = {**wheel_verdict(row, tags, python), "deps": sorted(specs), "specs": specs}
        v["direct_ok"] = v["kind"] in ("lock", "pure-wheel", "wasm-wheel")
        verdict[name] = v

    def closure(name: str, seen: set[str], versions: bool = True) -> tuple[str, str] | None:
        """The first dependency (depth-first) that cannot be installed, and why: `no-build` (it has no wheel or lock
        entry for this core) or `lock-too-old` (a lock package whose pinned version is outside the range asked for, and
        which micropip cannot replace from PyPI: see `replaceable`)."""
        specs = verdict.get(name, {}).get("specs", {})
        for d in verdict.get(name, {}).get("deps", []):
            if versions and d in lock and specs.get(d):
                try:
                    if not SpecifierSet(specs[d]).contains(lock[d]["version"], prereleases=True) and not replaceable(d, specs[d]):
                        return d, "lock-too-old"
                except InvalidSpecifier:
                    pass
            if d in seen:
                continue
            seen.add(d)
            if d not in verdict or not verdict[d]["direct_ok"]:
                return d, "no-build"
            b = closure(d, seen, versions)
            if b:
                return b
        return None

    ranks = {t["project"]: t for t in top}
    out = []
    for name, v in verdict.items():
        row = rows.get(name) or {}
        blocked = closure(name, {name}) if v["direct_ok"] else None
        blocker, blocked_why = blocked if blocked else (None, None)
        by_tags = v["direct_ok"] and closure(name, {name}, versions=False) is None
        seen: set[str] = {name}
        stack, size = list(v["deps"]), (v["wheel"] or {}).get("size") or 0
        while stack:
            d = stack.pop()
            if d in seen or d not in verdict:
                continue
            seen.add(d)
            size += (verdict[d]["wheel"] or {}).get("size") or 0
            stack += verdict[d]["deps"]
        out.append({
            "project": name, "in_top": name in ranks, **({k: ranks[name][k] for k in ("rank", "downloads_30d")} if name in ranks else {}),
            "version": row.get("version"), "summary": row.get("summary", ""), "requires_python": row.get("requires_python", ""),
            "kind": v["kind"], "lock_version": v.get("lock_version"), "wheel": v["wheel"],
            "emscripten_wheel_any_abi": v.get("emscripten_wheel_any_abi", False), "deps": v["deps"],
            "n_compatible_wheels": v.get("n_compatible_wheels"), "host": host_verdict(row) if row else None,
            "blocked_by": blocker, "blocked_why": blocked_why, "installable": v["direct_ok"] and blocker is None,
            "installable_by_tags": by_tags, "closure_size": len(seen),
            "pypi_wheel_bytes": size,
        })
    return sorted(out, key=lambda r: (not r["in_top"], r.get("rank") or 0, r["project"]))


def probe_installs(names: list[str], root: Path, workers: int = 6, timeout: int = 180) -> list[dict]:
    """`probe.mjs install` for each project, `workers` interpreters at once, one fresh interpreter per project. A
    timeout or a crash is a result too (`stage` "timeout" / "crash")."""
    import subprocess

    def one(name: str) -> dict:
        try:
            p = subprocess.run(["node", "notebooks/python-packages/probe.mjs", "install", name], cwd=root,
                               capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return {"project": name, "stage": "timeout"}
        line = (p.stdout.strip().splitlines() or [""])[-1]
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            return {"project": name, "stage": "crash", "error": (p.stderr or p.stdout)[-600:]}

    with ThreadPoolExecutor(workers) as ex:
        return list(ex.map(one, names))


if __name__ == "__main__":
    import subprocess, sys
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 50
    root = Path(__file__).resolve().parents[2]
    env_probe = json.loads(subprocess.run(["node", "notebooks/python-packages/probe.mjs", "env"], cwd=root, capture_output=True, text=True, check=True).stdout)
    _, top = top_projects(n)
    cache = Path(os.environ["PYPKG_CACHE"]) if os.environ.get("PYPKG_CACHE") else None
    for r in classify(top, env_probe, cache)[:n]:
        print(r["rank"], r["project"], r["kind"], r["installable"], r["blocked_by"])
