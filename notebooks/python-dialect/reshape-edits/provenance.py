"""provenance.py — for each python_exec cell of a reshape sweep's runs, whether it finished inside the read-only dialect,
why it was refused, and for a refused MUTATION, who made the value it wrote to: the injected table, an earlier inside
cell, an earlier full-path (asked) cell, or the cell itself from a value it did not make (an alias).

    python3 provenance.py <out.json> <run.json>...

A run.json sits at `<sweep>/<task id>/<combo>/<rep>/run.json`; the task id is `reshape-<arm>`: `neutral-hint`,
`staged-hint` or `neutral` (no hint). Each run is also classified by the ROUTE its first python_exec cell took to the
files: `tables-url` (a `tables` source that is a full URL), `tables-path` (one that is not: a site path, a selector),
`read_csv-fetched` (no `tables`; a read_csv of a URL or path fetch_url read earlier in the run), `read_csv-unfetched`
(one it did not), `other` (neither), `no-python`. Edits are counted only within `tables-url` and `tables-path` runs, the
two routes the notebook counts: on any other route the first refusal is the file's, not an edit's. The cells are the run's python_exec steps in order; one is INSIDE when its approval is "sandbox" (the worker's
inside try finished it) and refused when its result carries the sentence `pythonOutsideWhy` writes ("This cell asked
because it is outside the read-only Python dialect (<reason>)"). A mutation refusal is one of the fork's three:

    item assignment to a value the cell does not own: on <type>
    a method that writes a value the cell does not own: '<m>' of <type>
    an in-place operator on a value the cell does not own

The value is found from the source with `ast`, never run: the root name (the base of an attribute and subscript chain)
of the store on the refusal's line, or of the first such store when the refusal names no line. Its maker is `injected`
when the name is one the cell was handed (`df`, `tables`, a key of its `tables` map), `alias` when this cell bound it
before that line (a name for a value the cell did not make: `y = df`), else the latest earlier cell that bound it at its
top level, `inside` or `full` by that cell's outcome, and `unknown` when none did. Syntactic, so a binding in a branch
that never ran counts. An `alias` is followed to what it names (`alias_of`): the root of the right-hand side of the cell's
last plain assignment to it before the line, read the same way (`injected`, `inside`, `full`, `unknown`), so `y = df` is an
alias of the injected table and `y = kept` one of an earlier cell's value. An earlier cell whose last plain assignment to
the name is a bare name (`y = df` in one cell, `y['a'] = 1` in the next) is followed the same way across cells, so that edit
is an `alias` of `injected`, not `inside`; any other right-hand side (`y = df.copy()`) is a value that cell made.

Writes features only (run hash, model, arm, route, cell index, outcome, refusal kind, maker, alias_of), never a cell's code.
"""

import ast
import json
import re
import sys
from pathlib import Path

WHY = re.compile(r"outside the read-only Python dialect \((.*?)\)\. A cell inside it runs without asking")
LINE = re.compile(r"\(line (\d+)\)\s*$")
MUTATION = (("item", "item assignment to a value the cell does not own"),
            ("method", "a method that writes a value the cell does not own"),
            ("inplace", "an in-place operator on a value the cell does not own"))
METHOD = re.compile(r"a method that writes a value the cell does not own: '([^']+)'")


def parse(code):
    """The cell's tree, or None when it does not parse (a bare `return` is retried as a function body)."""
    for src in (code, "def _cell():\n" + "\n".join("    " + l for l in code.split("\n"))):
        try:
            return ast.parse(src)
        except SyntaxError:
            pass
    return None


def root(node):
    """The base Name of an attribute, subscript and call chain (`df["a"].fillna` → df), or None."""
    while True:
        if isinstance(node, (ast.Attribute, ast.Subscript)): node = node.value
        elif isinstance(node, ast.Call): node = node.func
        else: return node.id if isinstance(node, ast.Name) else None


def binds(tree):
    """Each name the cell binds anywhere → the first line it is bound on."""
    out = {}
    for n in ast.walk(tree):
        targets = []
        if isinstance(n, ast.Assign): targets = n.targets
        elif isinstance(n, (ast.AnnAssign, ast.AugAssign, ast.For, ast.AsyncFor, ast.comprehension, ast.NamedExpr)): targets = [n.target]
        elif isinstance(n, (ast.With, ast.AsyncWith)): targets = [i.optional_vars for i in n.items if i.optional_vars]
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)): out.setdefault(n.name, n.lineno)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names: out.setdefault((a.asname or a.name).split(".")[0], n.lineno)
        for t in targets:
            for m in ast.walk(t):
                if isinstance(m, ast.Name) and isinstance(m.ctx, ast.Store): out.setdefault(m.id, getattr(n, "lineno", 0))
    return out


def stored_roots(tree, kind, method=None):
    """(line, root name) of each store of the refusal's kind, in source order."""
    out = []
    for n in ast.walk(tree):
        if kind == "item" and isinstance(n, (ast.Assign, ast.AnnAssign)):
            out += [(n.lineno, root(t)) for t in (n.targets if isinstance(n, ast.Assign) else [n.target]) if isinstance(t, ast.Subscript)]
        elif kind == "item" and isinstance(n, ast.Delete):
            out += [(n.lineno, root(t)) for t in n.targets if isinstance(t, ast.Subscript)]
        elif kind == "inplace" and isinstance(n, ast.AugAssign):
            out.append((n.lineno, root(n.target) if not isinstance(n.target, ast.Name) else n.target.id))
        elif kind == "method" and isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and (method is None or n.func.attr == method):
            out.append((n.lineno, root(n.func.value)))
    return sorted((l, r) for l, r in out if r is not None)


def mutation(reason):
    """The refusal's mutation kind, or None when it is not a mutation."""
    return next((k for k, text in MUTATION if reason and text in reason), None)


def alias_rhs(tree, name, line):
    """The root name of the right-hand side of the cell's last plain `name = <x>` before `line` (any line when None)."""
    best = None
    for n in ast.walk(tree):
        if isinstance(n, ast.Assign) and (line is None or n.lineno < line) and any(isinstance(t, ast.Name) and t.id == name for t in n.targets):
            if best is None or n.lineno > best.lineno: best = n
    return (root(best.value), best.lineno) if best is not None else (None, None)


def origin(cells, i, name, line, tree, depth=0):
    """Who made the value `name` holds on cell i's `line`: (maker, alias_of) as the module's docstring reads them."""
    own = binds(tree)
    if name in own and (line is None or own[name] < line):
        if depth > 8: return "alias", "unknown"
        src, at = alias_rhs(tree, name, line)
        if src is None: return "alias", "unknown"
        m, a = origin(cells, i, src, at, tree, depth + 1)
        return "alias", a if m == "alias" else m
    if name in cells[i]["injected"]: return "injected", None
    for j in range(i - 1, -1, -1):
        t = parse(cells[j]["code"])
        if t is None or name not in binds(t): continue
        made = "inside" if cells[j]["inside"] else "full"
        src, at = alias_rhs(t, name, None)
        rhs = next((a.value for a in ast.walk(t) if isinstance(a, ast.Assign) and a.lineno == at), None)
        if depth > 8 or src is None or not isinstance(rhs, ast.Name): return made, None
        m, a = origin(cells, j, src, at, t, depth + 1)
        return "alias", a if m == "alias" else m
    return "unknown", None


def maker(cells, i, kind, reason):
    """Who made the value cell i's refused mutation wrote to, and what an alias names: (maker, alias_of)."""
    tree = parse(cells[i]["code"])
    if tree is None: return "unknown", None
    m = METHOD.search(reason or "")
    found = stored_roots(tree, kind, m.group(1) if m else None)
    line = int(LINE.search(reason).group(1)) if LINE.search(reason or "") else None
    on_line = [r for l, r in found if l == line] if line else []
    name = (on_line or [r for _, r in found] or [None])[0]
    if name is None: return "unknown", None
    return origin(cells, i, name, line, tree)


def injected_names(tables):
    """The names a cell was handed: `df` and `tables` always, and each key of a `tables` map."""
    names = {"df", "tables"}
    if isinstance(tables, str):
        try: tables = json.loads(tables)
        except ValueError: tables = None
    if isinstance(tables, dict): names |= set(tables)
    return names


def cells_of(session):
    """The run's python_exec cells in order: code, outcome, refusal reason, injected names."""
    out = []
    for st in session.get("steps") or []:
        if st.get("tool") != "python_exec": continue
        args = st.get("arguments") or {}
        why = WHY.search(json.dumps(st.get("result"), ensure_ascii=False))
        out.append({"code": str(args.get("code") or ""), "inside": st.get("approval") == "sandbox",
                    "reason": why.group(1) if why else None, "injected": injected_names(args.get("tables"))})
    return out


def rows_of(cells):
    """Features per cell: index, outcome, refusal reason, mutation kind, maker and alias_of. No code."""
    rows = []
    for i, c in enumerate(cells):
        kind = mutation(c["reason"])
        mk, of = maker(cells, i, kind, c["reason"]) if kind else (None, None)
        rows.append({"cell": i, "inside": c["inside"], "refused": c["reason"], "mutation": kind, "maker": mk, "alias_of": of})
    return rows


def read_csv_arg(code):
    """The first string-literal argument of the cell's first `<x>.read_csv(...)` call, or None."""
    tree = parse(code)
    if tree is None: return None
    calls = sorted((n.lineno, n.col_offset, n) for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "read_csv")
    for _, _, n in calls:
        for a in n.args[:1] + [k.value for k in n.keywords if k.arg == "filepath_or_buffer"]:
            if isinstance(a, ast.Constant) and isinstance(a.value, str): return a.value
        return ""
    return None


def route(session):
    """How the run's first python_exec cell reached the files (see the module's docstring)."""
    fetched = set()
    for st in session.get("steps") or []:
        args = st.get("arguments") or {}
        if st.get("tool") == "fetch_url" and isinstance(args.get("url"), str): fetched.add(args["url"])
        if st.get("tool") != "python_exec": continue
        tables = args.get("tables")
        if isinstance(tables, str) and tables.strip().startswith("{"):
            try: tables = json.loads(tables)
            except ValueError: pass
        srcs = list(tables.values()) if isinstance(tables, dict) else [tables] if tables not in (None, "") else []
        if srcs:
            return "tables-url" if all(isinstance(x, str) and re.match(r"https?://", x) for x in srcs) else "tables-path"
        arg = read_csv_arg(str(args.get("code") or ""))
        if arg is None: return "other"
        hit = arg in fetched or (arg and not re.match(r"https?://", arg) and any(f.endswith("/" + arg.lstrip("./")) for f in fetched))
        return "read_csv-fetched" if hit else "read_csv-unfetched"
    return "no-python"


def wording(path):
    """The task id's arm from `<sweep>/<task id>/<combo>/<rep>/run.json`."""
    task = Path(path).parts[-4]
    return task.removeprefix("reshape-")


def main(out, paths):
    rows = []
    for p in paths:
        s = json.loads(Path(p).read_text())["session"]
        for r in rows_of(cells_of(s)):
            rows.append({"run": s.get("hash"), "model": s.get("model"), "arm": wording(p), "route": route(s), **r})
    Path(out).write_text(json.dumps(rows, indent=1) + "\n")


if __name__ == "__main__":
    if len(sys.argv) < 3: sys.exit("usage: python3 provenance.py <out.json> <run.json>...")
    main(sys.argv[1], sys.argv[2:])
