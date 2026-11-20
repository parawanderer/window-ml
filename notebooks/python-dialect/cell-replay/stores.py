"""stores.py — a SYNTACTIC count of the stores in each recorded python_exec cell that the gate would judge as a mutation
of a value the cell does not own, read from the source with `ast` and never run.

    python3 stores.py <out.json> <run.json>...

Cells are indexed as replay.mjs indexes them (each run's python_exec steps that asked and carry code, in order), so the
two extracts join on (run, cell). A store counts when its target's ROOT name (the base of an attribute and subscript
chain) is not bound by the cell before that line: an assignment, a for/with/except target, a def, a walrus, a
comprehension variable. An import binds a module, which the cell did not make, so it does not count as binding. Kinds:
`item` (x[...] = ...), `attr` (x.a = ...), `aug` (x[...] += ..., x.a += ...), `aug_name` (x += ... on a name the cell
did not bind: an in-place operator on its value), `del` (del x[...], del x.a), `inplace` (a call with inplace=True),
`method` (a listed mutating method of list, dict, set or bytearray). Syntactic: a store in a branch that never runs
counts, one reached through an alias (y = df; y[...] = ...) counts as y's (bound by the cell), so it is missed.

Writes features only (run hash, model, cell index, counts per kind), never the cell's code. Also `recorded_none`: whether
the cell's recorded result is a TypeError on None (the injected table was loaded under another name).
"""

import ast
import json
import sys

MUTATORS = {"append", "extend", "insert", "pop", "remove", "clear", "sort", "reverse", "update", "setdefault", "popitem",
            "add", "discard", "difference_update", "intersection_update", "symmetric_difference_update"}


def root(node):
    """The base Name of an attribute, subscript and call chain (`df["a"].fillna` → df), or None."""
    while True:
        if isinstance(node, (ast.Attribute, ast.Subscript)): node = node.value
        elif isinstance(node, ast.Call): node = node.func
        else: return node.id if isinstance(node, ast.Name) else None


def bound_lines(tree):
    """Each name the cell binds → the first line it is bound on."""
    out = {}
    def bind(name, line):
        out.setdefault(name, line)
    for n in ast.walk(tree):
        targets = []
        if isinstance(n, (ast.Assign,)): targets = n.targets
        elif isinstance(n, (ast.AnnAssign, ast.For, ast.AsyncFor, ast.comprehension, ast.NamedExpr)): targets = [n.target]
        elif isinstance(n, (ast.With, ast.AsyncWith)): targets = [i.optional_vars for i in n.items if i.optional_vars]
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)): bind(n.name, n.lineno)
        elif isinstance(n, ast.ExceptHandler) and n.name: bind(n.name, n.lineno)
        for t in targets:
            for m in ast.walk(t):
                if isinstance(m, ast.Name) and isinstance(m.ctx, ast.Store): bind(m.id, getattr(n, "lineno", getattr(t, "lineno", 0)))
    return out


def stores(code):
    """Counts per kind of store on a name the cell did not bind, or None when the source does not parse."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        try:  # a cell may end on a bare `return`, which the wrapper turns into a function body
            tree = ast.parse("def _cell():\n" + "\n".join("    " + l for l in code.split("\n")))
        except SyntaxError:
            return None
    bound = bound_lines(tree)
    unbound = lambda name, line: name is not None and not (name in bound and bound[name] < line)
    k = dict(item=0, attr=0, aug=0, aug_name=0, **{"del": 0}, inplace=0, method=0)
    for n in ast.walk(tree):
        line = getattr(n, "lineno", 0)
        if isinstance(n, (ast.Assign, ast.AnnAssign)):
            for t in (n.targets if isinstance(n, ast.Assign) else [n.target]):
                if isinstance(t, ast.Subscript) and unbound(root(t), line): k["item"] += 1
                elif isinstance(t, ast.Attribute) and unbound(root(t), line): k["attr"] += 1
        elif isinstance(n, ast.AugAssign):
            if isinstance(n.target, (ast.Subscript, ast.Attribute)) and unbound(root(n.target), line): k["aug"] += 1
            elif isinstance(n.target, ast.Name) and unbound(n.target.id, line): k["aug_name"] += 1
        elif isinstance(n, ast.Delete):
            k["del"] += sum(1 for t in n.targets if isinstance(t, (ast.Subscript, ast.Attribute)) and unbound(root(t), line))
        elif isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute):
            r = root(n.func.value)
            if any(kw.arg == "inplace" and isinstance(kw.value, ast.Constant) and kw.value.value is True for kw in n.keywords):
                if unbound(r, line): k["inplace"] += 1
            elif n.func.attr in MUTATORS and unbound(r, line):
                k["method"] += 1
    return k


def main(out, files):
    rows = []
    for f in files:
        s = json.load(open(f))["session"]
        i = 0
        for st in s.get("steps", []):
            code = (st.get("arguments") or {}).get("code")
            if st.get("tool") != "python_exec" or st.get("approval") != "user" or not code:
                continue
            res = st.get("result") or ""
            rows.append({"run": s["hash"], "model": s.get("model"), "cell": i, "stores": stores(str(code)),
                         "recorded_none": "'NoneType' object is not subscriptable" in res})
            i += 1
    json.dump({"rows": rows}, open(out, "w"), indent=1)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
