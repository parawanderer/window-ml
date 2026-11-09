"""scan.py — predicts, from a wheel's source alone, whether importing a package reaches something the python_exec core
lacks: a stdlib module it does not ship (`resource`, `pwd`, `_multiprocessing`, …) or a call that fails at import (a
process, a thread start, a multiprocessing lock, a named shared library).

Only IMPORT-TIME code counts: module bodies, class bodies, decorators and default arguments, not function bodies. An
import inside a `try` whose handler catches ImportError (or a parent of it) is guarded and does not count, nor does
an `if TYPE_CHECKING:` or `__main__` block; `sys.platform` / `os.name` tests are evaluated as the core sees them ("emscripten",
"posix"). Reachability follows import-time imports from the modules the probe imported, across every installed
package, so a failure in a dependency counts for the package that pulled it in.

For comparison the scan also records the naive signal, "the closure mentions a platform module anywhere".

Wheels are read as zip files and parsed with `ast`; nothing in them is executed.
"""

import ast
import json
import sys
import os
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from packaging.tags import Tag
from packaging.utils import canonicalize_name, parse_wheel_filename

# Modules the naive signal looks for, anywhere in the code.
NAIVE = {"subprocess", "multiprocessing", "threading", "_thread", "concurrent", "resource", "pty", "ctypes", "cffi",
         "socket", "pwd", "grp", "fcntl", "termios", "signal", "select"}

# Calls that fail in the core, by dotted name after alias resolution, each measured on the core (os.system,
# multiprocessing.get_context and Process() construction succeed, so they are not here).
FAILING_CALLS = {
    "subprocess.run", "subprocess.Popen", "subprocess.call", "subprocess.check_call", "subprocess.check_output",
    "subprocess.getoutput", "subprocess.getstatusoutput", "os.fork", "os.forkpty", "os.popen",
    "os.spawnv", "os.spawnl", "os.spawnlp", "os.spawnvp", "os.execv", "os.execvp", "os.posix_spawn",
    "multiprocessing.Lock", "multiprocessing.RLock", "multiprocessing.Queue", "multiprocessing.Pool",
    "multiprocessing.Process.start", "multiprocessing.Manager", "multiprocessing.Event", "multiprocessing.Semaphore",
    "multiprocessing.Value", "multiprocessing.Array", "threading.Thread.start", "threading.Timer.start",
}
# A named shared library is never there (the core has no system libraries); CDLL(None) works, and find_library
# returns None rather than raising.
DLOPEN_CALLS = {"ctypes.CDLL", "ctypes.cdll.LoadLibrary", "ctypes.PyDLL"}
# What a `try` handler catches, as the categories the hits below need: an import error, an OSError (processes, a
# missing library), a RuntimeError (a thread start). Exception and a bare except catch all three.
CATCHES = {"ImportError": {"import"}, "ModuleNotFoundError": {"import"}, "OSError": {"os"}, "IOError": {"os"},
           "EnvironmentError": {"os"}, "FileNotFoundError": {"os"}, "PermissionError": {"os"},
           "subprocess.CalledProcessError": {"os"}, "subprocess.SubprocessError": {"os"}, "RuntimeError": {"runtime"},
           "Exception": {"import", "os", "runtime", "raise"}, "BaseException": {"import", "os", "runtime", "raise"}}
CALL_ERROR = {c: "os" for c in FAILING_CALLS if c.startswith(("subprocess.", "os."))}
CALL_ERROR |= {c: "import" for c in FAILING_CALLS if c.startswith("multiprocessing.")}
CALL_ERROR |= {"threading.Thread.start": "runtime", "threading.Timer.start": "runtime"}
CALL_ERROR |= {c: "os" for c in DLOPEN_CALLS} | {"cffi.dlopen": "os"}

# The core as `sys.platform`, `os.name`, `platform.*()`, `sys.version_info` and `hasattr(<stdlib module>, …)` see it;
# set by `set_core` from a measured attribute table.
CORE = {"values": {"sys.platform": "emscripten", "os.name": "posix", "platform.system()": "Emscripten",
                   "platform.machine()": "wasm32"}, "version": (3, 14, 2), "attrs": {}, "missing": set()}


def set_core(attrs_probe: dict, stdlib_missing: set[str]) -> None:
    CORE["missing"] = set(stdlib_missing)
    CORE["attrs"] = {m: set(a) for m, a in attrs_probe["attrs"].items() if a is not None}
    CORE["values"]["platform.machine()"] = attrs_probe["machine"]
    CORE["values"]["platform.system()"] = attrs_probe["system"]
    CORE["version"] = tuple(attrs_probe["version_info"])


def _dotted(node) -> str | None:
    """`a.b.c` for a Name/Attribute chain, `platform.system()` for a no-argument call of one."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value)
        return base + "." + node.attr if base else None
    if isinstance(node, ast.Call) and not node.args and not node.keywords:
        f = _dotted(node.func)
        return f + "()" if f else None
    return None


def _const(node):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)) and all(isinstance(e, ast.Constant) for e in node.elts):
        return tuple(e.value for e in node.elts)
    raise ValueError


def _decide(test, aliases, consts=None) -> bool | None:
    """The value of a platform, version or `hasattr(stdlib, name)` test as the core sees it, or of a module-level
    constant (`_in_development = False`), or None when the test is about something else."""
    consts = consts or {}
    full = lambda n: (lambda d: d and (aliases.get(d.split(".")[0], d.split(".")[0]) + d[len(d.split(".")[0]):]))(_dotted(n))

    def core_str(n):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ("lower", "upper") and not n.args:
            v = core_str(n.func.value)
            return None if v is None else getattr(v, n.func.attr)()
        d = full(n)
        return CORE["values"].get(d) if d else None

    if isinstance(test, ast.Constant):
        return bool(test.value)
    if isinstance(test, ast.Name) and test.id in consts:
        return bool(consts[test.id])
    if isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
        v = _decide(test.operand, aliases, consts)
        return None if v is None else not v
    if isinstance(test, ast.BoolOp):
        vals = [_decide(v, aliases, consts) for v in test.values]
        if isinstance(test.op, ast.And):
            return False if False in vals else (None if None in vals else True)
        return True if True in vals else (None if None in vals else False)
    if isinstance(test, ast.Name) and test.id == "TYPE_CHECKING" or full(test) == "typing.TYPE_CHECKING":
        return False
    if isinstance(test, ast.Call) and full(test.func) == "hasattr" and len(test.args) == 2:
        mod = full(test.args[0])
        if mod in CORE["attrs"] and isinstance(test.args[1], ast.Constant):
            return test.args[1].value in CORE["attrs"][mod]
        return None
    if isinstance(test, ast.Call) and isinstance(test.func, ast.Attribute) and test.func.attr in ("startswith", "endswith"):
        base = core_str(test.func.value)
        if base is not None and test.args:
            try:
                return getattr(base, test.func.attr)(_const(test.args[0]))
            except (ValueError, TypeError):
                return None
        return None
    if isinstance(test, ast.Compare) and len(test.ops) == 1:
        left, op = full(test.left), test.ops[0]
        if left == "__name__":  # a module being imported is never __main__
            try:
                right = _const(test.comparators[0])
            except ValueError:
                return None
            if right == "__main__" and isinstance(op, (ast.Eq, ast.NotEq)):
                return isinstance(op, ast.NotEq)
            return None
        if core_str(test.left) is not None:
            actual = core_str(test.left)
        elif left == "sys.version_info":
            actual = CORE["version"]
        elif isinstance(test.left, ast.Subscript) and full(test.left.value) == "sys.version_info":
            try:
                actual = CORE["version"][_const(test.left.slice)]
            except (ValueError, TypeError, IndexError):
                return None
        else:
            return None
        try:
            right = _const(test.comparators[0])
        except ValueError:
            return None
        try:
            return {ast.Eq: lambda: actual == right, ast.NotEq: lambda: actual != right, ast.In: lambda: actual in right,
                    ast.NotIn: lambda: actual not in right, ast.Lt: lambda: actual < right, ast.LtE: lambda: actual <= right,
                    ast.Gt: lambda: actual > right, ast.GtE: lambda: actual >= right}[type(op)]()
        except (KeyError, TypeError):
            return None
    return None


def _caught(handlers) -> set[str]:
    out = set()
    for h in handlers:
        if any(isinstance(b, ast.Raise) for b in h.body):  # re-raises (or raises another error): no guard
            continue
        if h.type is None:
            return {"import", "os", "runtime", "raise"}
        for n in ([h.type] if not isinstance(h.type, ast.Tuple) else h.type.elts):
            out |= CATCHES.get(_dotted(n) or "", set())
            out.add("raise")  # a raise inside a try is taken to be meant for its handler
    return out


def _may_fail(body) -> bool:
    """Whether a try body can raise in the core. A body of nothing but imports of stdlib modules the core has never
    does, so its handler (`except ImportError: import msvcrt`) never runs; any other body might."""
    for st in body:
        if isinstance(st, ast.Import):
            names = [a.name for a in st.names]
        elif isinstance(st, ast.ImportFrom) and not st.level and st.module:
            names = [st.module]
        else:
            return True
        for n in names:
            if n.split(".")[0] not in sys.stdlib_module_names or n in CORE["missing"] or n.split(".")[0] in CORE["missing"]:
                return True
    return False


def _resolve(modname: str, level: int, target: str | None, is_pkg: bool) -> str:
    """The absolute module a relative `from` import names."""
    if not level:
        return target or ""
    parts = modname.split(".")
    base = parts if is_pkg else parts[:-1]
    base = base[: len(base) - (level - 1)] if level > 1 else base
    return ".".join(base + ([target] if target else []))


def _own_library(arg, assigns: dict) -> bool | None:
    """Whether a dlopen argument is a file the package ships (a path built from __file__ or a package path) rather
    than a system library's name; None when it cannot tell."""
    if arg is None:
        return None
    if isinstance(arg, ast.Constant):
        return None if arg.value is None else ("/" in str(arg.value) and not str(arg.value).startswith("/usr"))
    if isinstance(arg, ast.Name) and arg.id in assigns:
        return _own_library(assigns[arg.id], {})
    text = ast.unparse(arg)
    if any(k in text for k in ("__file__", "__path__", "os.path", "Path(", "files(", "dirname", "_path", "path")):
        return True
    if "find_library" in text:
        return False
    if isinstance(arg, ast.BoolOp):  # find_library(x) or "libx.so"
        vals = [_own_library(v, assigns) for v in arg.values]
        return False if False in vals else None
    return None


def analyze_module(src: str, modname: str, is_pkg: bool) -> dict:
    """Import-time facts of one module, and the same facts for each of its top-level functions so a module-level
    call into one can be followed:

    - imports: (absolute name, what a surrounding try catches)
    - calls: (failing call, error category, what is caught)
    - called: (resolved dotted name of a plain call, what is caught), for calls into the package's own functions
    - raises: module-level raise reached on branches the core decides (functions' raises are value tests, not counted)
    - anywhere: every top-level module mentioned anywhere (the naive signal)
    """
    try:
        tree = ast.parse(src)
    except (SyntaxError, ValueError):
        return {"imports": [], "calls": [], "called": [], "raises": [], "funcs": {}, "anywhere": [], "unparsed": True}
    aliases: dict[str, str] = {}
    anywhere: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            anywhere.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
            anywhere.add(node.module.split(".")[0])
    local_funcs = {st.name for st in tree.body if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef))}
    local_classes = {st.name for st in tree.body if isinstance(st, ast.ClassDef)}
    current_class: list = [None]
    assigned: dict[str, list] = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            for t in (node.targets if isinstance(node, ast.Assign) else [node.target]):
                if isinstance(t, ast.Name):
                    assigned.setdefault(t.id, []).append(node)
    consts = {n: a[0].value.value for n, a in assigned.items()
              if len(a) == 1 and a[0] in tree.body and isinstance(a[0], ast.Assign)
              and isinstance(a[0].value, ast.Constant) and isinstance(a[0].value.value, (bool, int, type(None)))}

    def call_name(call: ast.Call) -> str | None:
        f = call.func
        if isinstance(f, ast.Attribute) and f.attr == "start" and isinstance(f.value, ast.Call):
            inner = call_name(f.value)
            return inner + ".start" if inner else None
        name = _dotted(f)
        if not name:
            return None
        head, _, rest = name.partition(".")
        if head in local_funcs and not rest:
            return modname + "." + head
        if head in ("self", "cls") and current_class[0] and rest and "." not in rest:
            return modname + "." + current_class[0] + "." + rest
        if head in local_classes and rest:
            return modname + "." + name
        return aliases.get(head, head) + ("." + rest if rest else "")

    def new_facts():
        return {"imports": [], "calls": [], "called": [], "raises": []}

    def scan_expr(node, caught, facts, assigns):
        for sub in ast.walk(node):
            if not isinstance(sub, ast.Call):
                continue
            n = call_name(sub)
            if not n:
                continue
            if n.endswith(".dlopen") and n not in DLOPEN_CALLS:
                n = "cffi.dlopen"
            if n in DLOPEN_CALLS or n == "cffi.dlopen":
                arg = sub.args[-1] if n == "cffi.dlopen" and sub.args else (sub.args[0] if sub.args else None)
                own = _own_library(arg, assigns)
                if own is True or (isinstance(arg, ast.Constant) and arg.value is None):
                    continue
                facts["calls"].append(("dlopen-system" if own is False or isinstance(arg, ast.Constant) else "dlopen-unknown",
                                       "os", frozenset(caught)))
            elif n in CALL_ERROR:
                facts["calls"].append((n, CALL_ERROR[n], frozenset(caught)))
            else:
                facts["called"].append((n, frozenset(caught)))

    def visit(body, caught, facts, decided, module_level, assigns, thread_vars):
        for st in body:
            if isinstance(st, ast.Import):
                for a in st.names:
                    facts["imports"].append((a.name, frozenset(caught)))
                    if module_level:
                        aliases[(a.asname or a.name).split(".")[0]] = a.name if a.asname else a.name.split(".")[0]
            elif isinstance(st, ast.ImportFrom):
                base = _resolve(modname, st.level, st.module, is_pkg)
                if base == "__future__":
                    continue
                facts["imports"].append((base, frozenset(caught)))
                for a in st.names:
                    if a.name != "*":
                        facts["imports"].append((base + "." + a.name, frozenset(caught | {"maybe-attr"})))
                        if module_level:
                            aliases[a.asname or a.name] = base + "." + a.name
            elif isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for d in st.decorator_list + st.args.defaults + [d for d in st.args.kw_defaults if d is not None]:
                    scan_expr(d, caught, facts, assigns)
            elif isinstance(st, ast.ClassDef):
                for d in st.decorator_list + st.bases:
                    scan_expr(d, caught, facts, assigns)
                if module_level:
                    visit(st.body, caught, facts, decided, module_level, assigns, thread_vars)
            elif isinstance(st, ast.If):
                v = _decide(st.test, aliases, consts if module_level else {})
                scan_expr(st.test, caught, facts, assigns)
                if v is not False:
                    visit(st.body, caught, facts, decided and v is True, module_level, assigns, thread_vars)
                if v is not True:
                    visit(st.orelse, caught, facts, decided and v is False, module_level, assigns, thread_vars)
            elif isinstance(st, ast.Try) or type(st).__name__ == "TryStar":
                c = caught | _caught(st.handlers)
                visit(st.body, c, facts, decided, module_level, assigns, thread_vars)
                if _may_fail(st.body):
                    for h in st.handlers:
                        visit(h.body, caught, facts, False, module_level, assigns, thread_vars)
                visit(st.orelse, c, facts, decided, module_level, assigns, thread_vars)
                visit(st.finalbody, caught, facts, decided, module_level, assigns, thread_vars)
            elif isinstance(st, (ast.With, ast.AsyncWith)):
                for it in st.items:
                    scan_expr(it.context_expr, caught, facts, assigns)
                visit(st.body, caught, facts, decided, module_level, assigns, thread_vars)
            elif isinstance(st, (ast.For, ast.AsyncFor, ast.While)):
                scan_expr(st.iter if not isinstance(st, ast.While) else st.test, caught, facts, assigns)
                if not isinstance(st, ast.While) and isinstance(st.target, ast.Name):
                    assigns[st.target.id] = st.iter
                visit(st.body, caught, facts, False, module_level, assigns, thread_vars)
                visit(st.orelse, caught, facts, False, module_level, assigns, thread_vars)
            elif isinstance(st, ast.Match):
                for c in st.cases:
                    visit(c.body, caught, facts, False, module_level, assigns, thread_vars)
            elif isinstance(st, ast.Raise):
                if module_level and decided and "raise" not in caught:
                    facts["raises"].append(ast.unparse(st)[:120])
            else:
                if isinstance(st, ast.Assign):
                    for t in st.targets:
                        if isinstance(t, ast.Name):
                            assigns[t.id] = st.value
                    if isinstance(st.value, ast.Call) and call_name(st.value) in ("threading.Thread", "threading.Timer"):
                        thread_vars.update(t.id for t in st.targets if isinstance(t, ast.Name))
                if (isinstance(st, ast.Expr) and isinstance(st.value, ast.Call) and isinstance(st.value.func, ast.Attribute)
                        and st.value.func.attr == "start" and isinstance(st.value.func.value, ast.Name)
                        and st.value.func.value.id in thread_vars):
                    st_kind = "threading.Thread.start"
                    facts["calls"].append((st_kind, "runtime", frozenset(caught)))
                scan_expr(st, caught, facts, assigns)

    top = new_facts()
    visit(tree.body, set(), top, True, True, {}, set())
    funcs = {}
    for st in tree.body:
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
            f = new_facts()
            visit(st.body, set(), f, False, False, {}, set())
            funcs[st.name] = f
        elif isinstance(st, ast.ClassDef):
            for m in st.body:
                if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    f = new_facts()
                    current_class[0] = st.name
                    visit(m.body, set(), f, False, False, {}, set())
                    current_class[0] = None
                    funcs[st.name + "." + m.name] = f
    return top | {"funcs": funcs, "anywhere": sorted(anywhere)}


def wheel_modules(path: Path) -> dict[str, dict]:
    """Every Python module in a wheel, by dotted name, with its import-time facts; `.so` modules marked native."""
    out = {}
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            parts = name.split("/")
            if parts[0].endswith((".dist-info", ".data")):
                continue
            if name.endswith(".py"):
                is_pkg = parts[-1] == "__init__.py"
                mod = ".".join(parts[:-1] if is_pkg else parts[:-1] + [parts[-1][:-3]])
                if not mod:
                    continue
                try:
                    src = z.read(name).decode("utf-8", "replace")
                except Exception:
                    continue
                out[mod] = analyze_module(src, mod, is_pkg) | {"pkg": is_pkg}
            elif name.endswith(".so"):
                mod = ".".join(parts[:-1] + [parts[-1].split(".")[0]])
                out.setdefault(mod, {"imports": [], "calls": [], "called": [], "raises": [], "funcs": {}, "anywhere": [],
                                     "native": True})
    return out


def wheel_url(name: str, version: str, source: str, env: dict, cache: Path) -> tuple[str, str] | None:
    """(url, file name) of the wheel micropip would have fetched for `name==version`."""
    lock = env["lock"].get(canonicalize_name(name)) or env["lock"].get(name)
    if source != "pypi" and lock and lock["version"] == version:
        return env["cdn"] + lock["file_name"], lock["file_name"]
    f = cache / f"{canonicalize_name(name)}-{version}.json"
    if not f.exists():
        req = urllib.request.Request(f"https://pypi.org/pypi/{name}/{version}/json", headers={"User-Agent": "window-ml-notebook"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                f.write_bytes(r.read())
        except Exception:
            return None
    files = json.loads(f.read_text())["urls"]
    order = {t: i for i, t in enumerate(env["tags"])}
    best = None
    for u in files:
        if not u["filename"].endswith(".whl"):
            continue
        try:
            tags = parse_wheel_filename(u["filename"])[3]
        except Exception:
            continue
        rank = min((order[str(t)] for t in tags if str(t) in order), default=None)
        if rank is not None and (best is None or rank < best[0]):
            best = (rank, u["url"], u["filename"])
    return (best[1], best[2]) if best else None


def fetch(url: str, fname: str, cache: Path) -> Path | None:
    p = cache / "wheels" / fname
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "window-ml-notebook"})
            with urllib.request.urlopen(req, timeout=120) as r:
                p.with_suffix(".part").write_bytes(r.read())
            p.with_suffix(".part").rename(p)
        except Exception:
            return None
    return p


def scan_installs(installs: list[dict], env: dict, stdlib_bad: set[str], cache: Path, depths=(0, 1, 2, 3),
                  workers: int = 16) -> list[dict]:
    """For each probed project that installed: the platform hits reachable at import time from the modules it
    imported, once per call depth (0: module bodies only; 1: also the package functions they call; …), and the naive
    signal. One row per project and depth."""
    cache.mkdir(parents=True, exist_ok=True)
    wanted = {(i["name"], i["version"], i["source"]) for r in installs for i in r.get("installed") or []}

    def one(key):
        name, version, source = key
        u = wheel_url(name, version, source, env, cache)
        p = fetch(*u, cache) if u else None
        return key, (wheel_modules(p) if p else None)

    with ThreadPoolExecutor(workers) as ex:
        per_wheel = dict(ex.map(one, sorted(wanted)))

    rows = []
    for r, depth_cap in ((r, d) for r in installs for d in depths):
        if not r.get("installed"):
            continue
        mods: dict[str, dict] = {}
        missing_wheels = []
        for i in r["installed"]:
            m = per_wheel.get((i["name"], i["version"], i["source"]))
            if m is None:
                missing_wheels.append(i["name"])
            else:
                mods.update(m)
        naive = sorted({x for m in mods.values() for x in m["anywhere"]} & NAIVE)
        hits, seen, seen_funcs = [], set(), set()

        def take(facts, where, chain, caught, depth):
            """Hits in one body (a module's, or a function's it calls at import), following imports and calls."""
            for c, cat, g in facts["calls"]:
                if cat not in (g | caught):
                    hits.append({"kind": "call", "what": c, "in": where, "chain": chain})
            for msg in facts.get("raises", []):
                hits.append({"kind": "raise", "what": msg, "in": where, "chain": chain})
            for target, g in facts["imports"]:
                if "import" in (g | caught):
                    continue
                if target in mods:
                    todo.append((target, chain + [target]))
                elif "maybe-attr" not in g and (target in stdlib_bad or target.split(".")[0] in stdlib_bad):
                    hits.append({"kind": "missing", "what": target, "in": where, "chain": chain})
            if depth >= depth_cap:
                return
            for n, g in facts["called"]:
                modpart, _, fname = n.rpartition(".")
                f = mods.get(modpart, {}).get("funcs", {}).get(fname)
                if f is None and "." in modpart:
                    m2, _, cls = modpart.rpartition(".")
                    f = mods.get(m2, {}).get("funcs", {}).get(cls + "." + fname)
                if f is not None and (n, depth) not in seen_funcs:
                    seen_funcs.add((n, depth))
                    take(f, n, chain + [n + "()"], caught | g, depth + 1)

        todo = [(i["module"], [i["module"]]) for i in r.get("imports") or []]
        while todo:
            mod, chain = todo.pop()
            if mod in seen:
                continue
            seen.add(mod)
            parts = mod.split(".")  # importing a.b.c runs a and a.b first
            for k in range(1, len(parts)):
                parent = ".".join(parts[:k])
                if parent not in seen and parent in mods:
                    todo.append((parent, chain))
            if mod in mods:
                take(mods[mod], mod, chain, frozenset(), 0)
            elif mod in stdlib_bad:
                hits.append({"kind": "missing", "what": mod, "in": chain[-2] if len(chain) > 1 else mod, "chain": chain})
        rows.append({"project": r["project"], "depth": depth_cap, "stage": r.get("stage"), "naive": naive, "hits": hits[:20],
                     "n_hits": len(hits), "reached": len(seen), "missing_wheels": missing_wheels})
    return rows


if __name__ == "__main__":
    import sys
    here = Path(__file__).parent
    data = here / "data" / "pypi-compat"
    env = json.loads((data / "env.json").read_text())["rows"][0]
    dist = json.loads((here.parents[1] / "tools" / "pyodide-dist.json").read_text())
    env["cdn"] = f"https://cdn.jsdelivr.net/pyodide/v{dist['pyodide']}/full/"
    installs = json.loads((data / "installs.json").read_text())["rows"]
    stdlib_bad = set(json.loads(Path(sys.argv[1]).read_text())["bad"])
    set_core(json.loads(Path(os.environ["PYPKG_CORE_ATTRS"]).read_text()), stdlib_bad)
    cache = Path(os.environ.get("PYPKG_SCAN_CACHE", "scan-cache"))
    n = int(sys.argv[2]) if len(sys.argv) > 2 else len(installs)
    rows = scan_installs(installs[:n], env, stdlib_bad, cache, depths=(int(os.environ.get("PYPKG_SCAN_DEPTH", 1)),))
    print(json.dumps(rows))
