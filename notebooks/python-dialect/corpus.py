"""corpus.py: every real `python_exec` cell in the local run artifacts and the bench store, as FEATURE records.

Public repo, personal sources: the rows never carry source text, string literal values or file contents, only counts
of AST node classes, module/attribute/method/builtin NAMES and a few shape numbers. `collect()` returns the rows,
`last_stats()` says what was scanned, `last_codes()` holds the text for a local run only (never written to the repo),
`features(code)` is one cell's features.
"""

from __future__ import annotations

import ast
import builtins
import hashlib
import json
import os
import re
import textwrap
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any

MAX_MD_BYTES = 20 * 1024 * 1024
ACCESSORS = {"str", "dt", "cat", "plot", "sparse"}
# The calls a generator expression may be the sole argument of, where the pre-pass rewrites it to a list comprehension
# (repl-specs ruling 2026-10-15; docs/spec/PYTHON_DIALECT.md). `str.join` is any `.join` call.
# Leaves that resolve a method NAME from a string, or call what they are given back (repl-specs rulings, 2026-10-15:
# a closed vocabulary of strings, and only the program's own functions as callbacks).
NAME_LEAVES = {"agg", "aggregate", "apply", "transform", "map", "applymap", "pipe"}
IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,40}$")
CONSUMERS = {"sum", "any", "all", "min", "max", "sorted", "list", "tuple", "set", "dict", "enumerate", "zip"}
BUILTINS = set(dir(builtins))
STEP_RE = re.compile(r"^## Step [\d.]+ · python_exec\s*$", re.M)
MODEL_RE = re.compile(r"^model: (.+)$", re.M)
SUBKEYS = ("subSteps", "steps", "children")
# What the runtime's prelude binds before every cell (src/python/python-runtime.ts PRELUDE_BASE, python-env.ts
# PY_PACKAGES): a cell uses `pd` or `io` without importing it, so these resolve like an import unless the cell rebinds them.
PRELUDE = {"np": "numpy", "pd": "pandas", "Image": "PIL.Image", "io": "io", "base64": "base64", "sys": "sys",
           "contextlib": "contextlib"}

_stats: dict[str, Any] = {}
_codes: dict[str, str] = {}


# --- features ---

def _empty(parse: str, lines: int) -> dict:
    return {"parse": parse, "lines": lines, "nodes": {}, "imports": [], "chains": {}, "methods": {}, "builtins": {},
            "prelude": [], "dunder_attrs": [], "dunder_names": [], "recursion": [], "defs": 0, "lambdas": 0, "max_loop_depth": 0,
            "range_args": {"const": 0, "nonconst": 0}, "genexp": {"consumer": 0, "consumer_kw": 0, "other": 0},
            "type_calls": {"one": 0, "other": 0}, "leaf_args": {}}


def _chain(node: ast.AST) -> list[str] | None:
    """Names from the root Name outward through Attribute nodes only, or None when a call/subscript intervenes."""
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return parts[::-1]
    return None


def _is_const(n: ast.AST) -> bool:
    if isinstance(n, ast.Constant):
        return True
    if isinstance(n, ast.UnaryOp) and isinstance(n.operand, ast.Constant):
        return True
    return False


def _loop_depth(stmts: list[ast.stmt]) -> int:
    return max((_loop_depth_node(s, 0) for s in stmts), default=0)


def _loop_depth_node(node: ast.AST, depth: int) -> int:
    if isinstance(node, (ast.For, ast.AsyncFor, ast.While)):
        depth += 1
    best = depth
    for child in ast.iter_child_nodes(node):
        best = max(best, _loop_depth_node(child, depth))
    return best


def features(code: str) -> dict:
    """One cell's features. Top-level `return` is legal (the runtime wraps the cell in a function)."""
    lines = len(code.splitlines())
    try:
        tree = ast.parse("def _user():\n" + textwrap.indent(code, "    "))
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return _empty("syntax_error", lines)
    body = tree.body[0].body  # type: ignore[attr-defined]
    nodes_all = [n for s in body for n in ast.walk(s)]

    nodes: Counter = Counter()
    imports: set[str] = set()
    aliases: dict[str, str] = {}
    bound: set[str] = set()
    for n in nodes_all:
        c = type(n).__name__
        if c not in ("Load", "Store", "Del"):
            nodes[c] += 1
        if isinstance(n, ast.Import):
            for a in n.names:
                imports.add(a.name)
                name = a.asname or a.name.split(".")[0]
                aliases[name] = a.name if a.asname else a.name.split(".")[0]
                bound.add(name)
        elif isinstance(n, ast.ImportFrom):
            imports.add((n.module or "") if n.level == 0 else ".")
            for a in n.names:
                name = a.asname or a.name
                bound.add(name)
                if n.level == 0 and n.module and a.name != "*":
                    aliases[name] = n.module + "." + a.name
        elif isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
            bound.add(n.id)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(n.name)
        elif isinstance(n, ast.arg):
            bound.add(n.arg)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            bound.add(n.name)

    rebound = {n for n in bound if n in PRELUDE and n not in aliases}
    prelude_used = sorted({PRELUDE[n.id] for n in nodes_all if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)
                           and n.id in PRELUDE and n.id not in aliases and n.id not in rebound})
    for n, mod in PRELUDE.items():
        if n not in aliases and n not in rebound:
            aliases[n] = mod
    chains: Counter = Counter()
    inner_attr_ids = {id(n.value) for n in nodes_all if isinstance(n, ast.Attribute)}
    methods: Counter = Counter()
    blt: Counter = Counter()
    dattrs: set[str] = set()
    dnames: set[str] = set()
    rng = {"const": 0, "nonconst": 0}
    genexp = {"consumer": 0, "consumer_kw": 0, "other": 0}
    types = {"one": 0, "other": 0}
    consumed: set[int] = set()
    for n in nodes_all:
        if isinstance(n, ast.Call) and len(n.args) == 1 and isinstance(n.args[0], ast.GeneratorExp):
            f = n.func
            if (isinstance(f, ast.Name) and f.id in CONSUMERS and f.id not in bound) or (isinstance(f, ast.Attribute) and f.attr == "join"):
                consumed.add(id(n.args[0]))
                genexp["consumer_kw" if n.keywords else "consumer"] += 1
    genexp["other"] = sum(1 for n in nodes_all if isinstance(n, ast.GeneratorExp) and id(n) not in consumed)

    # What a name-resolving or callback-taking leaf is handed: the string's NAME (identifiers only, else "<other>"),
    # or the kind of callable. Never a literal's value beyond an identifier.
    leaf_args: dict[str, Counter] = {}

    def kind_of(a: ast.AST) -> list[str]:
        if isinstance(a, ast.Constant) and isinstance(a.value, str):
            return ["str:" + (a.value if IDENT.match(a.value) else "<other>")]
        if isinstance(a, (ast.List, ast.Tuple, ast.Set)):
            return [k for e in a.elts for k in kind_of(e)]
        if isinstance(a, ast.Dict):
            return [k for v in a.values for k in kind_of(v)]
        if isinstance(a, ast.Lambda):
            return ["lambda"]
        if isinstance(a, ast.Name):
            if a.id in BUILTINS and a.id not in bound:
                return ["builtin:" + a.id]
            return ["module-fn:" + aliases[a.id]] if a.id in aliases else ["name"]
        if isinstance(a, ast.Attribute):
            ch = _chain(a)
            if ch and ch[0] in aliases:
                return ["module-fn:" + ".".join(aliases[ch[0]].split(".") + ch[1:])]
            return ["method"]
        return []

    for n in nodes_all:
        if not isinstance(n, ast.Call):
            continue
        f = n.func
        if isinstance(f, ast.Attribute) and f.attr in NAME_LEAVES:
            given = n.args[:1] + [k.value for k in n.keywords if k.arg in ("func", "arg")]
            for g in given:
                for k in kind_of(g):
                    leaf_args.setdefault("." + f.attr, Counter())[k] += 1
        for k in n.keywords:
            if k.arg == "key":
                callee = ("." + f.attr) if isinstance(f, ast.Attribute) else (f.id if isinstance(f, ast.Name) else "?")
                for kk in kind_of(k.value):
                    leaf_args.setdefault("key=@" + callee, Counter())[kk] += 1
    defs = lambdas = 0
    dunder = re.compile(r"^__.+__$")

    for n in nodes_all:
        if isinstance(n, ast.Attribute):
            if dunder.match(n.attr):
                dattrs.add(n.attr)
            if id(n) not in inner_attr_ids:
                ch = _chain(n)
                if ch:
                    if ch[0] in aliases:
                        ch = aliases[ch[0]].split(".") + ch[1:]
                    chains[".".join(ch)] += 1
        elif isinstance(n, ast.Name):
            if dunder.match(n.id):
                dnames.add(n.id)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            defs += 1
        elif isinstance(n, ast.Lambda):
            lambdas += 1
        elif isinstance(n, ast.Call):
            f = n.func
            if isinstance(f, ast.Name):
                if f.id in aliases:
                    chains[aliases[f.id]] += 1
                if f.id in BUILTINS and f.id not in bound:
                    blt[f.id] += 1
                    if f.id == "type":
                        types["one" if len(n.args) == 1 and not n.keywords else "other"] += 1
                    if f.id == "range":
                        ok = bool(n.args) and not n.keywords and all(_is_const(a) for a in n.args)
                        rng["const" if ok else "nonconst"] += 1
            elif isinstance(f, ast.Attribute):
                recv = f.value
                ch = _chain(recv)
                if ch and ch[0] in aliases:
                    continue
                if isinstance(recv, ast.Attribute) and recv.attr in ACCESSORS:
                    methods[f".{recv.attr}.{f.attr}"] += 1
                else:
                    methods["." + f.attr] += 1

    recursion = set()
    for n in nodes_all:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for m in (x for s in n.body for x in ast.walk(s)):
                if isinstance(m, ast.Call) and isinstance(m.func, ast.Name) and m.func.id == n.name:
                    recursion.add(n.name)
                    break

    return {"parse": "ok", "lines": lines, "nodes": dict(sorted(nodes.items())), "imports": sorted(imports),
            "chains": dict(sorted(chains.items())), "methods": dict(sorted(methods.items())),
            "builtins": dict(sorted(blt.items())), "prelude": prelude_used, "dunder_attrs": sorted(dattrs), "dunder_names": sorted(dnames),
            "recursion": sorted(recursion), "defs": defs, "lambdas": lambdas,
            "max_loop_depth": _loop_depth(body), "range_args": rng,
            "genexp": genexp, "type_calls": types,
            "leaf_args": {m: dict(sorted(c.items())) for m, c in sorted(leaf_args.items())}}


# --- reading sources ---

def _cells_json(text: str) -> tuple[list[str], str | None, str | None]:
    """(codes, model, session hash) of a run.json text; raises ValueError on malformed JSON."""
    try:
        d = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError("bad json") from e
    s = d.get("session") if isinstance(d, dict) else None
    if not isinstance(s, dict):
        return [], None, None
    codes: list[str] = []

    def visit(steps: Any) -> None:
        if not isinstance(steps, list):
            return
        for st in steps:
            if not isinstance(st, dict):
                continue
            if st.get("tool") == "python_exec":
                a = st.get("arguments")
                if isinstance(a, str):
                    try:
                        a = json.loads(a)
                    except json.JSONDecodeError:
                        a = None
                if isinstance(a, dict) and isinstance(a.get("code"), str):
                    codes.append(a["code"])
            for k in SUBKEYS:
                visit(st.get(k))

    visit(s.get("steps"))
    return codes, s.get("model") if isinstance(s.get("model"), str) else None, s.get("hash") if isinstance(s.get("hash"), str) else None


def _cells_md(text: str) -> tuple[list[str], str | None]:
    m = MODEL_RE.search(text)
    model = m.group(1).strip() if m else None
    codes = []
    for h in STEP_RE.finditer(text):
        end = text.find("\n## Step ", h.end())
        seg = text[h.end(): end if end >= 0 else len(text)]
        b = re.search(r"```python[^\n]*\n(.*?)\n```[ \t]*(?:\n|$)", seg, re.S)
        if b:
            codes.append(b.group(1))
    return codes, model


def _bench_parts(parts: list[str]) -> tuple[str, str, str, str] | None:
    """(sweep, task, variant, r) from path segments below bench/, bench-pool/ or traces/: anchored on the `r<N>` segment."""
    for i in range(len(parts) - 1, 2, -1):
        if re.fullmatch(r"r\d+", parts[i]) and i >= 3:
            return "/".join(parts[: i - 2]), parts[i - 2], parts[i - 1], parts[i]
    return None


def _walk_files(root: Path, suffixes: tuple[str, ...]):
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if d not in ("node_modules", ".git")]
        for f in fn:
            if f.endswith(suffixes):
                yield Path(dp) / f


def last_stats() -> dict:
    return _stats


def last_codes() -> dict[str, str]:
    """The last `collect()`'s cell text by `cell_id`, for a local run (verify-cost's corpus timing). Never written to the repo."""
    return _codes


def collect(include_store: bool = True, clones: list[Path] | None = None) -> list[dict]:
    """The rows (one per unique cell), ready for wmlnb.extract. `clones` overrides the sibling-clone search (tests). See `last_stats()` for what was scanned."""
    st: dict[str, Any] = {"files_scanned": Counter(), "malformed_files": 0, "cells_before_dedupe": Counter(),
                          "cells_after_dedupe": Counter(), "store_error": None, "key_agreement": None}
    # (runkey, cell_id) -> {origin: count}; meta per runkey/cell
    occ: dict[tuple[str, str], dict[str, int]] = {}
    meta: dict[tuple[str, str], tuple[str, str | None, str | None]] = {}  # label, model, sweep
    codes_by_id: dict[str, str] = {}
    local_keys: set[str] = set()
    local_nohash: set[str] = set()  # sweep/task/variant/r of local bench runs, for the fallback comparison

    def add(codes: list[str], label: str, runkey: str, origin: str, model: str | None, sweep: str | None) -> None:
        for code in codes:
            cid = hashlib.sha256(code.strip().encode("utf-8", "replace")).hexdigest()[:16]
            codes_by_id.setdefault(cid, code)
            d = occ.setdefault((runkey, cid), {})
            d[origin] = d.get(origin, 0) + 1
            meta.setdefault((runkey, cid), (label, model, sweep))
            st["cells_before_dedupe"][label] += 1

    def label_of(rel: str) -> str:
        if "/artifacts/bench-pool/" in "/" + rel:
            return "bench-pool"
        if "/artifacts/bench/" in "/" + rel:
            return "bench"
        if rel.startswith("tmp/"):
            return "tmp"
        return "e2e"

    def local_json(text: str, rel: str, clone: Path, origin: str) -> None:
        label = label_of(rel)
        try:
            codes, model, h = _cells_json(text)
        except ValueError:
            st["malformed_files"] += 1
            return
        sweep = None
        runkey = rel
        if label in ("bench", "bench-pool"):
            seg = rel.split("/artifacts/" + label + "/", 1)[1].split("/")[:-1]
            bp = _bench_parts(seg)
            if bp:
                sweep = bp[0]
                base = "/".join(bp)
                local_nohash.add(base)
                runkey = base + "/" + (h or "nohash:" + rel)
        add(codes, label, runkey, origin, model, sweep)
        if label in ("bench", "bench-pool") and sweep is not None:
            local_keys.add(runkey)

    def local_md(text: str, rel: str, origin: str) -> None:
        codes, model = _cells_md(text)
        add(codes, label_of(rel), rel, origin, model, None)

    if clones is None:
        clones = [p for p in sorted(Path.home().joinpath("git").glob("window-ml*")) if p.is_dir()]
    for C in clones:
        art = C / "tests" / "e2e" / "artifacts"
        if art.is_dir():
            for f in _walk_files(art, ("run.json",)):
                if f.name != "run.json":
                    continue
                st["files_scanned"]["run.json"] += 1
                try:
                    text = f.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    st["malformed_files"] += 1
                    continue
                local_json(text, str(f.relative_to(C)), C, str(f))
        for base in (art, C / "tmp"):
            if not base.is_dir():
                continue
            for f in _walk_files(base, (".md",)):
                try:
                    if f.stat().st_size > MAX_MD_BYTES:
                        continue
                    if f.name == "run.md" and (f.parent / "run.json").exists():
                        continue
                    text = f.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                st["files_scanned"]["run.md"] += 1
                local_md(text, str(f.relative_to(C)), str(f))
        tmp = C / "tmp"
        if tmp.is_dir():
            for f in _walk_files(tmp, (".zip",)):
                try:
                    zf = zipfile.ZipFile(f)
                except (zipfile.BadZipFile, OSError):
                    st["malformed_files"] += 1
                    continue
                with zf:
                    st["files_scanned"]["zip"] += 1
                    for info in zf.infolist():
                        nm = info.filename
                        if os.path.basename(nm) not in ("run.md", "run.json") or info.file_size > MAX_MD_BYTES:
                            continue
                        rel = str(f.relative_to(C)) + "!" + nm
                        try:
                            text = zf.read(info).decode("utf-8", "replace")
                        except Exception:
                            st["malformed_files"] += 1
                            continue
                        if nm.endswith("run.json"):
                            local_json(text, rel, C, str(f) + "!" + nm)
                        else:
                            local_md(text, rel, str(f) + "!" + nm)

    if include_store:
        _from_store(st, add, local_keys, local_nohash)

    rows_by_id: dict[str, dict] = {}
    for (runkey, cid), origins in occ.items():
        label, model, sweep = meta[(runkey, cid)]
        k = max(origins.values())
        r = rows_by_id.setdefault(cid, {"cell_id": cid, "n": 0, "sources": Counter(), "sweeps": Counter(), "models": Counter()})
        r["n"] += k
        r["sources"][label] += k
        if sweep and label in ("bench", "bench-pool", "store"):
            r["sweeps"][sweep] += k
        if model:
            r["models"][model] += k
        st["cells_after_dedupe"][label] += k
    rows = []
    for cid in sorted(rows_by_id):
        r = rows_by_id[cid]
        rows.append({"cell_id": cid, "n": r["n"], "sources": dict(sorted(r["sources"].items())),
                     "sweeps": dict(sorted(r["sweeps"].items())), "models": dict(sorted(r["models"].items())),
                     **features(codes_by_id[cid])})
    for k in ("files_scanned", "cells_before_dedupe", "cells_after_dedupe"):
        st[k] = dict(st[k])
    st["clones"] = [c.name for c in clones]
    _stats.clear()
    _stats.update(st)
    _codes.clear()
    _codes.update(codes_by_id)
    return rows


def _from_store(st: dict, add, local_keys: set[str], local_nohash: set[str]) -> None:
    try:
        import wmlnb

        con = wmlnb.store()
        bucket = con.sql("SELECT getvariable('wml_bucket')").fetchone()[0]
        files = [r[0] for r in con.execute(f"SELECT file FROM glob('s3://{bucket}/traces/**/run.json')").fetchall()]
    except Exception as e:  # message is already scrubbed by wmlnb
        st["store_error"] = str(e)[:300]
        return
    st["files_scanned"]["store_listed"] = len(files)
    parsed = []
    for f in files:
        parts = f.split("/traces/", 1)[1].split("/")[:-1]
        if len(parts) < 5:
            continue
        # parts: sweep.., task, variant, r, hash
        sweep = "/".join(parts[:-4])
        task, variant, r, h = parts[-4], parts[-3], parts[-2], parts[-1]
        parsed.append((f, f"{sweep}/{task}/{variant}/{r}", sweep, h))
    full = {f"{base}/{h}" for _, base, _, h in parsed}
    agree = len(full & local_keys)
    both_base = len({b for _, b, _, _ in parsed} & local_nohash)
    use_hash = not (both_base and agree == 0)
    st["key_agreement"] = (f"{agree} runs match on sweep/task/variant/r/session-hash; {both_base} match on sweep/task/variant/r "
                           f"-> {'session hash agrees, full key used' if use_hash else 'hash DISAGREES, fell back to sweep/task/variant/r'}")
    fetched = 0
    for f, base, sweep, h in parsed:
        key = f"{base}/{h}" if use_hash else base
        if (use_hash and key in local_keys) or (not use_hash and base in local_nohash):
            continue
        try:
            text = con.execute("SELECT content FROM read_text(?)", [f]).fetchone()[0]
        except Exception as e:
            st["store_error"] = (st["store_error"] or "") + f" fetch: {str(e)[:120]}"
            continue
        st["files_scanned"]["store_fetched"] = st["files_scanned"].get("store_fetched", 0) + 1
        try:
            codes, model, _ = _cells_json(text)
        except ValueError:
            st["malformed_files"] += 1
            continue
        add(codes, "store", key, f, model, sweep)
        fetched += 1
