// pkg-scan.ts — python_install's platform scan: what a candidate's new packages reach at import time that the core lacks, read from their unpacked sources with ast and never imported.

// docs/plan/repl/PACKAGES_INSTALL.md, slice 4, item 7 (slice 4b). A port of notebooks/python-packages/scan.py: the
// analysis is the same, the wheel fetching and zip reading are dropped, and modules are found in site-packages instead.
// It is run as its own hardened cell in the candidate (offscreen.ts `installTest`), after the wheels are unpacked and
// before the import cell, so no package code has run when it reads them. Its two core tables (the stdlib modules the
// core lacks, the attributes its stdlib modules expose) come from pkg-core.gen.ts. A finding is a NOTE, never a
// refusal: the import test decides. Only names it built itself, or identifiers, reach the model (`scanNote`).

import { PKG_CORE_ATTRS, PKG_CORE_MISSING, PKG_CORE_PLATFORM } from "./pkg-core.gen";
import { SCAN_BOUNDS } from "./pkg-scan-note";

// The analysis, from scan.py (lines 28-385 and the walk at 486-528), as it is there except: no backticks (it sits in a
// template), modules come from `_load` (site-packages, only the scanned packages' top-level names), and call depth is 1,
// the notebook's default.
const SCAN_PY = String.raw`
import ast, json, os, sys

FAILING_CALLS = {
    "subprocess.run", "subprocess.Popen", "subprocess.call", "subprocess.check_call", "subprocess.check_output",
    "subprocess.getoutput", "subprocess.getstatusoutput", "os.fork", "os.forkpty", "os.popen",
    "os.spawnv", "os.spawnl", "os.spawnlp", "os.spawnvp", "os.execv", "os.execvp", "os.posix_spawn",
    "multiprocessing.Lock", "multiprocessing.RLock", "multiprocessing.Queue", "multiprocessing.Pool",
    "multiprocessing.Process.start", "multiprocessing.Manager", "multiprocessing.Event", "multiprocessing.Semaphore",
    "multiprocessing.Value", "multiprocessing.Array", "threading.Thread.start", "threading.Timer.start",
}
DLOPEN_CALLS = {"ctypes.CDLL", "ctypes.cdll.LoadLibrary", "ctypes.PyDLL"}
CATCHES = {"ImportError": {"import"}, "ModuleNotFoundError": {"import"}, "OSError": {"os"}, "IOError": {"os"},
           "EnvironmentError": {"os"}, "FileNotFoundError": {"os"}, "PermissionError": {"os"},
           "subprocess.CalledProcessError": {"os"}, "subprocess.SubprocessError": {"os"}, "RuntimeError": {"runtime"},
           "Exception": {"import", "os", "runtime", "raise"}, "BaseException": {"import", "os", "runtime", "raise"}}
CALL_ERROR = {c: "os" for c in FAILING_CALLS if c.startswith(("subprocess.", "os."))}
CALL_ERROR |= {c: "import" for c in FAILING_CALLS if c.startswith("multiprocessing.")}
CALL_ERROR |= {"threading.Thread.start": "runtime", "threading.Timer.start": "runtime"}
CALL_ERROR |= {c: "os" for c in DLOPEN_CALLS} | {"cffi.dlopen": "os"}

CORE = {"values": {"sys.platform": "emscripten", "os.name": "posix", "platform.system()": _cfg["system"],
                   "platform.machine()": _cfg["machine"]}, "version": tuple(_cfg["version"]),
        "attrs": {m: set(a) for m, a in _cfg["attrs"].items()}, "missing": set(_cfg["missing"])}


def _dotted(node):
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


def _decide(test, aliases, consts=None):
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
        if left == "__name__":
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


def _caught(handlers):
    out = set()
    for h in handlers:
        if any(isinstance(b, ast.Raise) for b in h.body):
            continue
        if h.type is None:
            return {"import", "os", "runtime", "raise"}
        for n in ([h.type] if not isinstance(h.type, ast.Tuple) else h.type.elts):
            out |= CATCHES.get(_dotted(n) or "", set())
            out.add("raise")
    return out


def _may_fail(body):
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


def _resolve(modname, level, target, is_pkg):
    if not level:
        return target or ""
    parts = modname.split(".")
    base = parts if is_pkg else parts[:-1]
    base = base[: len(base) - (level - 1)] if level > 1 else base
    return ".".join(base + ([target] if target else []))


def _own_library(arg, assigns):
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
    if isinstance(arg, ast.BoolOp):
        vals = [_own_library(v, assigns) for v in arg.values]
        return False if False in vals else None
    return None


def analyze_module(src, modname, is_pkg):
    try:
        tree = ast.parse(src)
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return {"imports": [], "calls": [], "called": [], "raises": [], "funcs": {}, "unparsed": True}
    aliases = {}
    local_funcs = {st.name for st in tree.body if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef))}
    local_classes = {st.name for st in tree.body if isinstance(st, ast.ClassDef)}
    current_class = [None]
    assigned = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            for t in (node.targets if isinstance(node, ast.Assign) else [node.target]):
                if isinstance(t, ast.Name):
                    assigned.setdefault(t.id, []).append(node)
    consts = {n: a[0].value.value for n, a in assigned.items()
              if len(a) == 1 and a[0] in tree.body and isinstance(a[0], ast.Assign)
              and isinstance(a[0].value, ast.Constant) and isinstance(a[0].value.value, (bool, int, type(None)))}

    def call_name(call):
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
                    facts["raises"].append("")
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
                    facts["calls"].append(("threading.Thread.start", "runtime", frozenset(caught)))
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
    return top | {"funcs": funcs}


# Modules found in site-packages, read once each, only under the scanned packages' own top-level names: a lock package
# or the core's is not this scan's (Pyodide built and tests those).
_sp = _cfg["site"]
_scope = set(_cfg["scope"])
_mods = {}
_budget = {"modules": 0, "bytes": 0, "truncated": False}
_B = _cfg["bounds"]


def _load(mod):
    if mod in _mods:
        return _mods[mod]
    _mods[mod] = None
    parts = mod.split(".")
    if parts[0] not in _scope or not all(p.isidentifier() for p in parts):
        return None
    base = os.path.join(_sp, *parts)
    for path, is_pkg in ((os.path.join(base, "__init__.py"), True), (base + ".py", False)):
        if os.path.isfile(path):
            break
    else:
        d, leaf = os.path.split(base)
        try:
            native = any(f.startswith(leaf + ".") and f.endswith(".so") for f in os.listdir(d))
        except OSError:
            native = False
        if native:
            _mods[mod] = {"imports": [], "calls": [], "called": [], "raises": [], "funcs": {}, "native": True}
        return _mods[mod]
    if _budget["modules"] >= _B["modules"]:
        _budget["truncated"] = True
        return None
    size = os.path.getsize(path)
    if size > _B["fileBytes"] or _budget["bytes"] + size > _B["totalBytes"]:
        _budget["truncated"] = True
        return None
    _budget["modules"] += 1
    _budget["bytes"] += size
    with open(path, "rb") as fh:
        src = fh.read().decode("utf-8", "replace")
    _mods[mod] = analyze_module(src, mod, is_pkg)
    return _mods[mod]


def _scan(roots, depth_cap=1):
    stdlib_bad = CORE["missing"]
    hits, seen, seen_funcs = [], set(), set()
    todo = [(r, [r]) for r in reversed(roots)]

    def take(facts, where, chain, caught, depth):
        for c, cat, g in facts["calls"]:
            if cat not in (g | caught):
                hits.append({"kind": "call", "what": c, "in": where, "chain": chain})
        for _ in facts.get("raises", []):
            hits.append({"kind": "raise", "what": "", "in": where, "chain": chain})
        for target, g in facts["imports"]:
            if "import" in (g | caught):
                continue
            if _load(target) is not None:
                todo.append((target, chain + [target]))
            elif "maybe-attr" not in g and (target in stdlib_bad or target.split(".")[0] in stdlib_bad):
                hits.append({"kind": "missing", "what": target, "in": where, "chain": chain})
        if depth >= depth_cap:
            return
        for n, g in facts["called"]:
            modpart, _, fname = n.rpartition(".")
            m = _load(modpart) if modpart else None
            f = (m or {}).get("funcs", {}).get(fname)
            if f is None and "." in modpart:
                m2, _, cls = modpart.rpartition(".")
                f = (_load(m2) or {}).get("funcs", {}).get(cls + "." + fname)
            if f is not None and (n, depth) not in seen_funcs:
                seen_funcs.add((n, depth))
                take(f, n + "()", chain + [n + "()"], caught | g, depth + 1)

    while todo:
        mod, chain = todo.pop()
        if mod in seen:
            continue
        seen.add(mod)
        parts = mod.split(".")
        for k in range(1, len(parts)):
            parent = ".".join(parts[:k])
            if parent not in seen and _load(parent) is not None:
                todo.append((parent, chain))
        facts = _load(mod)
        if facts is not None:
            take(facts, mod, chain, frozenset(), 0)
        elif mod in stdlib_bad:
            hits.append({"kind": "missing", "what": mod, "in": chain[-2] if len(chain) > 1 else mod, "chain": chain})
    out = []
    for h in hits:
        if h not in out:
            out.append(h)
    return {"findings": out[: _B["findings"]], "reached": _budget["modules"], "truncated": _budget["truncated"] or len(out) > _B["findings"]}
`;

/**
 * The candidate's scan cell: the analysis over `roots`' import-time closure within `scope`, answered as JSON (`ScanResult`).
 * @param roots the top-level modules the import cell will test, in its order
 * @param scope every top-level name the scanned wheels provide (this call's and the run's earlier installs')
 * @param site the candidate's site-packages directory; the worker's own when omitted
 */
export function scanCode(roots: string[], scope: string[], site?: string): string {
    const cfg = { roots, scope, site: site ?? null, missing: PKG_CORE_MISSING, attrs: PKG_CORE_ATTRS, ...PKG_CORE_PLATFORM, bounds: SCAN_BOUNDS };
    // The config is JSON read by json.loads, so nothing in it is Python source; the roots and scope are identifiers.
    return `import json as _json, site as _site
_cfg = _json.loads(${JSON.stringify(JSON.stringify(cfg))})
_cfg["site"] = _cfg["site"] or _site.getsitepackages()[0]
${SCAN_PY}
_json.dumps(_scan(_cfg["roots"]))`;
}
