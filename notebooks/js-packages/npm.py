"""npm.py — reads the npm registry for the js-packages notebook: the most-downloaded packages, each one's latest
manifest, and FACTS about what its code asks of the host (Node built-ins it references, native addons, eval), so a later
step can decide which could run in a browser extension's sandboxed JS runtime (a Worker or sandboxed page: no Node
built-ins, no native addons, no filesystem, fetch only if granted). No verdicts here beyond the derived columns of
`collect`.

The ranking is `npmTopDownloads` of wooorm's `npm-high-impact` package (its latest tarball, read from the registry).

`scan_tarball` is a REGEX scan, not a JS parser: `require('x')`, `import('x')`, `import ... from 'x'`, `import 'x'` and
`export ... from 'x'` are matched as text, so a reference inside a comment or a string counts, a computed
`require(name)` does not, and dead branches (`if (typeof window === 'undefined') require('fs')`) count as references.
A specifier that is also one of the package's own dependencies (`events`, `buffer`, `util`... as userland packages) is
not a built-in unless written `node:x`. Tarballs are untrusted: nothing from them is executed, members are extracted
by hand with a path-traversal guard, only .js/.mjs/.cjs/.json files are written, and a `.node` file is only noted.

Everything is cached as JSON (and extracted sources) under `NPMPKG_CACHE`; delete a file to refresh it. `/latest`
manifests are cached forever, so a cached run is a snapshot.
"""

from __future__ import annotations

import io
import json
import os
import posixpath
import re
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

REGISTRY = "https://registry.npmjs.org"
UA = {"User-Agent": "window-ml notebooks/js-packages (npm facts)"}
DEFAULT_CACHE = Path(tempfile.gettempdir()) / "window-ml-npm-cache"

NATIVE_DEPS = {"node-gyp-build", "prebuild-install", "bindings", "node-addon-api", "nan", "node-pre-gyp",
               "@mapbox/node-pre-gyp"}
INSTALL_SCRIPTS = ("install", "preinstall", "postinstall")
ENTRY_CONDITIONS = ("import", "require", "default", "browser")  # the conditions followed to find the entry file(s)
SKIP_DIRS = {"test", "tests", "__tests__", "__mocks__", "spec", "specs", "example", "examples", "demo", "demos",
             "bench", "benchmark", "benchmarks", "fixtures", "node_modules"}
JS_EXT = (".js", ".mjs", ".cjs")
RESOLVE_EXT = (".js", ".mjs", ".cjs", ".json")
MAX_TARBALL = 150 * 1024 * 1024
MAX_FILE = 20 * 1024 * 1024
CLOSURE_CAP = 500   # packages in one root's dependency closure
FETCH_CAP = 6000    # manifests fetched in one `collect`

_SPEC_RES = [re.compile(p) for p in (
    r"""\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)""",
    r"""\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)""",
    r"""\bfrom\s*['"]([^'"\n]+)['"]""",       # import ... from 'x' and export ... from 'x'
    r"""\bimport\s*['"]([^'"\n]+)['"]""",      # import 'x'
)]
_EVAL_RE = re.compile(r"(?<![\w$.])eval\s*\(")
_NEWFN_RE = re.compile(r"\bnew\s+Function\s*\(")


def _get(url: str, timeout: int = 120, retries: int = 8) -> bytes | None:
    """GET with retries on 429/5xx and network errors (honouring Retry-After, else backing off exponentially); None on 404."""
    for i in range(retries):
        wait = min(60.0, 2.0 ** i)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read(MAX_TARBALL + 1)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code not in (429, 500, 502, 503, 504) or i == retries - 1:
                raise
            ra = e.headers.get("Retry-After", "")
            wait = float(ra) if ra.isdigit() else wait
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if i == retries - 1:
                raise
        time.sleep(wait)


def _get_json(url: str):
    b = _get(url)
    return None if b is None else json.loads(b)


def _cache_dir(cache: Path | None) -> Path:
    return cache if cache else Path(os.environ.get("NPMPKG_CACHE") or DEFAULT_CACHE)


def _fname(name: str) -> str:
    return name.replace("/", "__")


def _read_json(f: Path):
    return json.loads(f.read_text()) if f.exists() else ...


def _write_json(f: Path, obj) -> None:
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_name(f.name + f".{os.getpid()}.{id(obj)}.tmp")
    tmp.write_text(json.dumps(obj))
    tmp.replace(f)


def _safe_extract(data: bytes, dest: Path) -> list[str]:
    """Extract the .js/.mjs/.cjs/.json members of a gzip tarball into `dest`, dropping the top directory. Refuses
    anything that is not a regular file, any absolute or `..` path, and any file over MAX_FILE. Returns the paths (inside
    the package) of every `.node` file seen, which are NOT written. Nothing is executed."""
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    node_files: list[str] = []
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
        for m in tf:
            if not m.isfile():
                continue
            parts = m.name.replace("\\", "/").split("/")[1:]
            if not parts or any(p in ("", ".", "..") for p in parts) or m.name.startswith("/"):
                continue
            rel = "/".join(parts)
            if rel.endswith(".node"):
                node_files.append(rel)
                continue
            if not rel.endswith(JS_EXT + (".json",)) or m.size > MAX_FILE:
                continue
            target = (root / rel).resolve()
            if root not in target.parents:
                continue
            f = tf.extractfile(m)
            if f is None:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(f.read())
    return node_files


@lru_cache(maxsize=1)
def builtin_modules() -> frozenset[str]:
    """Node's own list, `require('module').builtinModules`, asked of the local `node` once."""
    out = subprocess.run(["node", "-p", "require('module').builtinModules.join('\\n')"], capture_output=True,
                         text=True, check=True).stdout
    return frozenset(x.strip() for x in out.splitlines() if x.strip())


def top_packages(n: int, cache: Path | None = None) -> tuple[str, list[dict]]:
    """The `n` most-downloaded packages in rank order, from `npmTopDownloads` of `npm-high-impact` (latest tarball,
    extracted into the cache; the names are parsed out of lib/top-download.js, a JS array of strings). Returns a
    description of the source (version, publish date) and `[{rank, name}]`."""
    cache = _cache_dir(cache)
    latest = _get_json(f"{REGISTRY}/npm-high-impact/latest")
    version = latest["version"]
    src = cache / "src" / f"npm-high-impact@{version}"
    if not (src / "lib" / "top-download.js").exists():
        data = _get(latest["dist"]["tarball"])
        if data is None:
            raise RuntimeError("npm-high-impact tarball not found")
        _safe_extract(data, src)
    text = (src / "lib" / "top-download.js").read_text()
    if not re.search(r"\bexport\s+const\s+topDownload\b", text):
        raise RuntimeError("npm-high-impact no longer carries lib/top-download.js `topDownload`; files: "
                           + ", ".join(sorted(str(p.relative_to(src)) for p in src.rglob("*.js"))))
    names = re.findall(r"""^\s*['"]([^'"]+)['"]\s*,?\s*$""", text, re.M)
    date = None
    try:
        full = _read_json(cache / "npm-high-impact.packument.json")
        if full is ...:
            full = _get_json(f"{REGISTRY}/npm-high-impact")
            _write_json(cache / "npm-high-impact.packument.json", {"time": full.get("time", {})})
        date = (full.get("time") or {}).get(version)
    except Exception:
        pass
    desc = f"npm-high-impact@{version} npmTopDownloads ({len(names)} names, published {date or 'unknown'})"
    return desc, [{"rank": i + 1, "name": nm} for i, nm in enumerate(names[:n])]


def _condition_names(exp) -> set[str]:
    """Every condition name (a key that does not start with '.') found anywhere in an `exports` value."""
    out: set[str] = set()
    if isinstance(exp, dict):
        for k, v in exp.items():
            if not k.startswith("."):
                out.add(k)
            out |= _condition_names(v)
    elif isinstance(exp, list):
        for v in exp:
            out |= _condition_names(v)
    return out


def _reduce(d: dict) -> dict:
    """The fields of a `/latest` manifest the facts need."""
    scripts = d.get("scripts") or {}
    deps = d.get("dependencies") or {}
    opt = d.get("optionalDependencies") or {}
    dist = d.get("dist") or {}
    exp = d.get("exports")
    signals = sorted((set(deps) | set(opt)) & NATIVE_DEPS)
    if d.get("gypfile"):
        signals.append("gypfile")
    if d.get("binary"):
        signals.append("binary")
    return {
        "name": d["name"], "version": d.get("version"), "type": d.get("type"), "main": d.get("main"),
        "module": d.get("module"), "browser": d.get("browser"), "exports": exp,
        "export_conditions": sorted(_condition_names(exp)), "engines": d.get("engines"), "os": d.get("os"),
        "cpu": d.get("cpu"), "dependencies": deps, "optionalDependencies": opt,
        "peerDependencies": d.get("peerDependencies") or {},
        "has_install_script": any(s in scripts for s in INSTALL_SCRIPTS), "gypfile": bool(d.get("gypfile")),
        "native_signals": signals, "native_manifest": bool(signals), "has_bin": bool(d.get("bin")),
        "unpacked_size": dist.get("unpackedSize"), "tarball": dist.get("tarball"),
        "deprecated": d.get("deprecated"),
    }


def manifest(name: str, cache: Path | None = None) -> dict | None:
    """One package's latest manifest, reduced (see `_reduce`); None when the registry has no such package. Cached."""
    cache = _cache_dir(cache)
    f = cache / "manifest" / f"{_fname(name)}.json"
    row = _read_json(f)
    if row is not ...:
        return row
    d = _get_json(f"{REGISTRY}/{urllib.parse.quote(name, safe='@').replace('/', '%2F')}/latest")
    row = None if d is None or "name" not in d else _reduce(d)
    _write_json(f, row)
    return row


def _targets(v, out: list[str]) -> None:
    """The string targets under an exports value, following ENTRY_CONDITIONS keys (nested) and arrays."""
    if isinstance(v, str):
        out.append(v)
    elif isinstance(v, list):
        for x in v:
            _targets(x, out)
    elif isinstance(v, dict):
        for k in ENTRY_CONDITIONS:
            if k in v:
                _targets(v[k], out)


def _entry_candidates(row: dict) -> tuple[list[str], str]:
    """Entry paths (relative, './' stripped) by the order exports['.'], module, main, index.js, and how they were found."""
    exp = row.get("exports")
    if exp is not None:
        sub = exp["."] if isinstance(exp, dict) and any(k.startswith(".") for k in exp) and "." in exp else (
            None if isinstance(exp, dict) and any(k.startswith(".") for k in exp) else exp)
        if sub is not None:
            t: list[str] = []
            _targets(sub, t)
            t = [x for x in t if "*" not in x and x.startswith(".")]
            if t:
                return list(dict.fromkeys(posixpath.normpath(x) for x in t)), "exports"
    for k in ("module", "main"):
        if isinstance(row.get(k), str) and row[k]:
            return [posixpath.normpath(row[k])], k
    return ["index.js"], "index"


def _resolve(files: dict, base: str) -> str | None:
    """A scanned file path for a path inside the package: exact, + an extension, or a directory's index."""
    base = posixpath.normpath(base)
    if base.startswith("..") or base.startswith("/"):
        return None
    for c in [base, *(base + e for e in RESOLVE_EXT), *(posixpath.join(base, "index" + e) for e in RESOLVE_EXT)]:
        if c in files:
            return c
    return None


def _specs(text: str) -> list[str]:
    return [m.group(1) for rx in _SPEC_RES for m in rx.finditer(text)]


def _builtin(spec: str, deps: set[str]) -> str | None:
    """The built-in a specifier names (without 'node:'), else None; an own dependency shadows a bare name."""
    if spec.startswith("node:"):
        return spec[5:]
    if spec in builtin_modules() and spec not in deps:
        return spec
    return None


def scan_tarball(row: dict, cache: Path | None = None) -> dict | None:
    """Download and extract `row`'s tarball (untrusted: see the module docstring) and scan its JS by regex. Records the
    Node built-ins referenced per file (outside test/example dirs) and for the entry file(s) alone (the entry resolved
    from exports['.'] conditions import/require/default/browser, else module, else main, else index.js, then only the
    entry's own relative imports followed transitively), whether any .node file ships, whether `eval(` or `new Function(`
    appears, and the bytes of JS. None when there is no tarball."""
    cache = _cache_dir(cache)
    key = f"{_fname(row['name'])}@{row['version']}"
    f = cache / "scan" / f"{key}.json"
    got = _read_json(f)
    if got is not ...:
        return got
    if not row.get("tarball"):
        return None
    data = _get(row["tarball"])
    if data is None or len(data) > MAX_TARBALL:
        res = {"error": "tarball missing" if data is None else "tarball over cap"}
        _write_json(f, res)
        return res
    src = cache / "src" / key
    try:
        node_files = _safe_extract(data, src)
    except (tarfile.TarError, OSError, EOFError) as e:
        res = {"error": f"extract failed: {e}"}
        _write_json(f, res)
        return res
    deps = set(row.get("dependencies") or {}) | set(row.get("optionalDependencies") or {})
    files: dict[str, dict] = {}
    for p in src.rglob("*"):
        if not p.is_file() or not p.name.endswith(JS_EXT):
            continue
        rel = p.relative_to(src).as_posix()
        text = p.read_text(errors="replace")
        specs = _specs(text)
        files[rel] = {
            "size": p.stat().st_size,
            "skip": any(part in SKIP_DIRS for part in rel.split("/")[:-1]),
            "builtins": sorted({b for s in specs if (b := _builtin(s, deps))}),
            "rels": [s for s in specs if s.startswith(("./", "../")) or s in (".", "..")],
            "eval": bool(_EVAL_RE.search(text)), "new_function": bool(_NEWFN_RE.search(text)),
        }
    live = {k: v for k, v in files.items() if not v["skip"]}
    by_file = {k: v["builtins"] for k, v in live.items() if v["builtins"]}
    cands, via = _entry_candidates(row)
    entries = [e for c in cands if (e := _resolve(files, c))]
    seen, queue = set(entries), deque(entries)
    while queue:
        cur = queue.popleft()
        for s in files[cur]["rels"]:
            nxt = _resolve(files, posixpath.join(posixpath.dirname(cur), s))
            if nxt and nxt not in seen:
                seen.add(nxt)
                queue.append(nxt)
    res = {
        "builtins_all": sorted({b for v in by_file.values() for b in v}),
        "builtins_by_file": by_file,
        "builtins_entry": sorted({b for k in seen for b in files[k]["builtins"]}),
        "entry_files": entries, "entry_via": via, "entry_resolved": bool(entries), "entry_reach_files": len(seen),
        "has_node_file": bool(node_files), "node_files": node_files[:10],
        "uses_eval": any(v["eval"] for v in live.values()),
        "uses_new_function": any(v["new_function"] for v in live.values()),
        "eval_files": sorted(k for k, v in live.items() if v["eval"] or v["new_function"])[:10],
        "js_bytes": sum(v["size"] for v in live.values()), "n_js_files": len(live),
    }
    _write_json(f, res)
    return res


def _closure(name: str, mans: dict[str, dict | None], cap: int = CLOSURE_CAP) -> tuple[list[str], bool, list[str]]:
    """Breadth-first runtime-dependency closure of `name` (excluding itself) over the fetched manifests. Returns the
    names, whether `cap` cut the walk short, and the dependencies the registry has no manifest for."""
    seen, order, missing, capped = {name}, [], [], False
    queue = deque([name])
    while queue:
        cur = queue.popleft()
        for d in (mans.get(cur) or {}).get("dependencies") or {}:
            if d in seen:
                continue
            if len(order) >= cap:
                capped = True
                continue
            seen.add(d)
            if mans.get(d) is None:
                missing.append(d)
            order.append(d)
            queue.append(d)
    return order, capped, missing


def collect(n: int, cache: Path | None = None, workers: int = 8) -> list[dict]:
    """A row for each of the top `n` packages: the manifest, the tarball scan, and the derived columns.

    - `deps_closure`: the transitive closure of runtime `dependencies`, each dependency taken at its LATEST manifest.
      This approximates semver resolution with latest: the version an install would pick may differ, and so may its
      dependencies. Walked breadth-first, at most CLOSURE_CAP packages per root (`deps_closure_capped` says it was hit);
      `deps_closure_missing` lists dependencies with no manifest.
    - `closure_builtins_entry`: the union, over the package itself and its closure, of the built-ins reachable from each
      entry file. `closure_unscanned` counts members with no scan.
    - `closure_native`: any native signal (manifest signal or a shipped .node file) in the package or its closure.
    - `has_browser_condition`: a `browser` field, or a `browser` or `worker` condition anywhere in exports.
    """
    cache = _cache_dir(cache)
    source, top = top_packages(n, cache)
    mans: dict[str, dict | None] = {}
    frontier = [t["name"] for t in top]
    with ThreadPoolExecutor(workers) as ex:
        while frontier and len(mans) < FETCH_CAP:
            todo = [p for p in dict.fromkeys(frontier) if p not in mans][:FETCH_CAP - len(mans)]
            frontier = []
            for name, row in zip(todo, ex.map(lambda p: manifest(p, cache), todo)):
                mans[name] = row
                if row:
                    frontier += list(row["dependencies"])
        closures = {t["name"]: _closure(t["name"], mans) for t in top}
        need = sorted({x for t in top for x in [t["name"], *closures[t["name"]][0]] if mans.get(x)})

        def scan(p: str):
            try:
                return p, scan_tarball(mans[p], cache)
            except Exception as e:  # a network or parse failure is a fact about this run, not a crash
                return p, {"error": f"{type(e).__name__}: {e}"}
        scans = dict(ex.map(scan, need))
    out = []
    for t in top:
        name = t["name"]
        row = mans.get(name)
        order, capped, missing = closures[name]
        if row is None:
            out.append({**t, "found": False})
            continue
        members = [name, *order]
        ok = {m: s for m in members if (s := scans.get(m)) and "error" not in s}
        s = scans.get(name) or {}
        exp = row.get("exports")
        out.append({
            **t, "found": True, **row, **{f"scan_{k}": v for k, v in s.items()},
            "deps_closure": order, "deps_closure_size": len(order), "deps_closure_capped": capped,
            "deps_closure_missing": missing,
            "closure_builtins_entry": sorted({b for v in ok.values() for b in v["builtins_entry"]}),
            "closure_unscanned": sum(1 for m in members if m not in ok),
            "closure_native": any((mans.get(m) or {}).get("native_manifest") or (scans.get(m) or {}).get("has_node_file")
                                  for m in members),
            "has_browser_condition": row.get("browser") is not None
                                     or bool({"browser", "worker"} & set(row["export_conditions"])),
            "ranking_source": source,
        })
    return out


if __name__ == "__main__":
    import sys
    from collections import Counter
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 50
    t0 = time.time()
    rows = collect(n, _cache_dir(None))
    print(f"collected {len(rows)} rows in {time.time() - t0:.1f}s; source: {rows[0]['ranking_source'] if rows else '-'}")
    for r in rows[:50]:
        if not r["found"]:
            print(r["rank"], r["name"], "NOT FOUND")
            continue
        print(r["rank"], r["name"], r["version"], "browser" if r["has_browser_condition"] else "-",
              "native" if r["closure_native"] else "-", "closure", r["deps_closure_size"] + 1,
              "entry-builtins", ",".join(r["scan_builtins_entry"]) or "-",
              "closure-builtins", ",".join(r["closure_builtins_entry"]) or "-")
    f = [r for r in rows if r["found"]]
    print("with browser condition:", sum(r["has_browser_condition"] for r in f))
    print("zero entry-reachable built-ins in closure:", sum(not r["closure_builtins_entry"] for r in f))
    print("native signals in closure:", sum(r["closure_native"] for r in f))
    print("closure capped:", sum(r["deps_closure_capped"] for r in f), "| unscanned members:", sum(r["closure_unscanned"] > 0 for r in f))
    print("most common built-ins (closure, entry-reachable):",
          Counter(b for r in f for b in r["closure_builtins_entry"]).most_common(10))
    print("most common built-ins (own entry):", Counter(b for r in f for b in r.get("scan_builtins_entry", [])).most_common(10))
