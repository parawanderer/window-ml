"""make-corpus-count.py — builds corpus-count.ipynb: which Python a read-only dialect must admit, measured on every real
`python_exec` cell models have written (docs/spec/PYTHON_DIALECT.md, "Step 0"; docs/plan/repl/LANE_3_RUNTIME.md, root B).

    node scripts/nb.mjs make notebooks/python-dialect/corpus-count.ipynb

The cells are written here; edit this file, not the notebook. The rows come from data/corpus-count/cells.json, extracted
by corpus.py (NB_REFRESH=1 walks every window-ml* clone's run artifacts and tmp/ again, and the bench store). The repo is
public and some sources are personal browsing, so the extract holds FEATURES of each cell (node counts, names), never its
text.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# The corpus count: which Python the dialect must admit

A read-only Python dialect admits a program by its AST node types (a whitelist, checked before anything runs) and then
gates every attribute, call and import at run time. Before writing either, this notebook counts what models actually
write: every `python_exec` cell found in the bench sweeps, the e2e artifacts, the run exports in `tmp/` and the bench
store, parsed the way the runtime parses it (as the body of a function, so a top-level `return` is legal).

The measure that matters is the fraction of cells a candidate whitelist admits WHOLE, since a cell with one excluded
node goes to a person. Every fraction is given over UNIQUE cells (the same text written twice counts once) and over
OCCURRENCES (how often a cell ran); the bench repeats the same tasks across models, so occurrences weight those tasks.
""")

code("""
import json
import pandas as pd
import wmlnb
import corpus

HERE = wmlnb.ROOT / "notebooks" / "python-dialect"
DATA = HERE / "data" / "corpus-count"
OUT = HERE / "data"
pd.set_option("display.width", 160, "display.max_colwidth", 80, "display.max_rows", 80)

SOURCE = {"reader": "notebooks/python-dialect/corpus.py collect()",
          "sources": "every ~/git/window-ml* clone: tests/e2e/artifacts/**/run.json and *.md, tmp/**/*.md and *.zip; the bench store's traces/**/run.json not already found locally",
          "privacy": "features only: no cell text, no string literals"}
rows = wmlnb.extract(DATA / "cells.json", corpus.collect, source=SOURCE)
stats = wmlnb.extract(DATA / "stats.json", lambda: [corpus.last_stats()], source={"reader": "corpus.last_stats() after the cells extract"})[0]
cells = pd.DataFrame(rows)
ok = cells[cells.parse == "ok"].copy()
import numpy as _np
print(f"parsed with CPython {__import__('sys').version.split()[0]}'s ast; methods attributed with pandas {pd.__version__} and numpy {_np.__version__} "
      "(Pyodide carries CPython 3.14.0, pandas 3.0.2, numpy 2.4.3: the same names for this purpose)")
pd.DataFrame(wmlnb.provenance(DATA / "cells.json", DATA / "stats.json"))
""")

md("""
## The corpus

Files read and cells found per source. A run seen in two places (a clone and the store, two clones) counts once: the
key is sweep/task/variant/repeat plus the run's session hash.
""")

code("""
src = pd.DataFrame({"files_scanned": pd.Series(stats["files_scanned"])})
print(src.to_string(), "\\n")
by_source = pd.DataFrame({
    "occurrences": pd.Series(stats["cells_after_dedupe"]),
    "unique_cells": pd.Series({s: int(cells.sources.map(lambda d: s in d).sum()) for s in stats["cells_after_dedupe"]}),
})
by_source.loc["all"] = [int(cells.n.sum()), len(cells)]
print(by_source.to_string(), "\\n")
print(f"store error: {stats['store_error']}; malformed files: {stats['malformed_files']}")
print(f"syntax errors: {int((cells.parse != 'ok').sum())} unique cells ({int(cells[cells.parse != 'ok'].n.sum())} occurrences), left out below")
models = pd.Series([c for d in cells.models for c in d.values()], index=[m for d in cells.models for m in d], dtype=int).groupby(level=0).sum().sort_values(ascending=False)
print(f"models: {len(models)}; top 10 by occurrences:")
models.head(10)
""")

md("""
## Node types

Each node type's share of cells: the fraction of unique cells containing it at least once. This is the raw material
for the whitelist; `data/node-counts.json` holds every type.
""")

code("""
def share(pred, frame=ok):
    m = frame.apply(pred, axis=1)
    return m.mean(), (frame.n * m).sum() / frame.n.sum()

node_cells = pd.Series({k: 0 for d in ok.nodes for k in d})
for d in ok.nodes:
    for k in d:
        node_cells[k] += 1
node_total = pd.Series({k: 0 for k in node_cells.index})
for d in ok.nodes:
    for k, v in d.items():
        node_total[k] += v
nodes = pd.DataFrame({"cells": node_cells, "share": (node_cells / len(ok)).round(4), "total": node_total}).sort_values("cells", ascending=False)
(OUT / "node-counts.json").write_text(json.dumps({"unique_cells": len(ok), "nodes": nodes.reset_index(names="node").to_dict("records")}, indent=2) + "\\n")
nodes.head(45)
""")

md("""
## Candidate whitelists

`STARLARK` is the halting set the spec names, as Python nodes: every statement and expression EXCEPT the ones listed in
`EXCLUDED`. Starlark proper also lacks `try`, generator expressions and `with`, so those start out excluded and the
tables below say what admitting each would buy. Recursion is not a node: the spec admits it to a bounded depth, so it
excludes nothing here.

`RULED` is the set as decided on 2026-10-15 (repl-specs; `docs/spec/PYTHON_DIALECT.md`): `STARLARK`, plus a generator
expression ONLY in consumer position, as the sole POSITIONAL argument (keyword arguments such as `key=` or
`default=` allowed: they never receive the generator) of a known consumer (`sum`, `any`, `all`, `min`, `max`,
`sorted`, `list`, `tuple`, `set`, `dict`, `enumerate`, `zip`, `str.join`), where the pre-pass rewrites it to a list
comprehension. A genexp anywhere else is refused. `while` and `class` stay refused statically: no cell in the corpus
uses either (the first line below), which confirms the refusal costs nothing, and the rungs that admitted them are
dropped.

A cell is admitted by a whitelist when it parses, every node it contains is listed, and (the `+gate` column) it would
also pass the static parts of the run-time gate: no dunder attribute or name, no call to a builtin the gate refuses
(one-argument `type(x)` is allowed, ruled the same day, and any other form is refused),
every import in `MODULES`, counting a module the prelude binds (`pd`, `np`, `io`, `sys`, …) that the cell uses without importing it. The `+gate` sets are a guess at the first allow lists, not the gate itself.
""")

code("""
import ast
# Concrete node classes only: no abstract bases (stmt, expr, …), no deprecated aliases (Num, Str, …), no top-level
# containers (Module, Expression, …), which a cell's body never contains.
DEPRECATED = {"Num", "Str", "Bytes", "NameConstant", "Ellipsis", "Index", "ExtSlice", "Suite", "Param", "AugLoad", "AugStore"}
CONTAINERS = {"Module", "Interactive", "Expression", "FunctionType"}
ABSTRACT = {"AST", "mod", "stmt", "expr", "expr_context", "boolop", "operator", "unaryop", "cmpop", "excepthandler",
            "type_ignore", "type_param", "pattern", "slice"}
ALL_NODES = {n for n in dir(ast) if not n.startswith("_") and isinstance(getattr(ast, n), type)
             and issubclass(getattr(ast, n), ast.AST) and n not in ABSTRACT | DEPRECATED | CONTAINERS}
EXCLUDED = {
    "While": "may not halt; the spec refuses it statically",
    "ClassDef": "a class builds a new type with its own dunders",
    "AsyncFunctionDef": "async", "AsyncFor": "async", "AsyncWith": "async", "Await": "async",
    "Yield": "a generator suspends a frame", "YieldFrom": "a generator suspends a frame",
    "GeneratorExp": "a lazy generator object (Starlark has none)",
    "Try": "Starlark has none; the spec leaves it open", "TryStar": "except*", "ExceptHandler": "part of Try",
    "With": "a context manager runs __enter__/__exit__", "withitem": "part of With",
    "Global": "writes a module-level name", "Nonlocal": "writes an enclosing frame's name",
    "NamedExpr": "the walrus: an assignment inside an expression",
    "Match": "structural pattern matching", "TypeAlias": "a type statement", "TypeIgnore": "a type comment",
    "TypeVar": "PEP 695 type parameters", "ParamSpec": "PEP 695 type parameters", "TypeVarTuple": "PEP 695 type parameters",
}
STARLARK = {n for n in ALL_NODES if n not in EXCLUDED and not n.startswith(("match_", "Match")) and n not in {"TemplateStr", "Interpolation"}}
MODULES = {"pandas", "numpy", "math", "statistics", "re", "json", "collections", "itertools", "functools", "datetime",
           "decimal", "fractions", "string", "textwrap", "operator", "random", "bisect", "heapq", "calendar",
           "io", "base64",  # io and base64 for their in-memory parts only (StringIO, BytesIO, b64encode); a guess
           "csv", "PIL"}    # ruled in 2026-10-15, as manifest LEAVES (both are C underneath), not a bare import allowance
REFUSED_BUILTINS = {"eval", "exec", "compile", "open", "__import__", "globals", "locals", "vars", "input", "breakpoint",
                    "help", "exit", "quit", "memoryview", "setattr", "delattr"}

def top(name):
    return name.split(".")[0]

def gate_ok(r):
    return (not r.dunder_attrs and not r.dunder_names and not (set(r.builtins) & REFUSED_BUILTINS)
            and not r.type_calls["other"] and all(top(m) in MODULES for m in [*r.imports, *r.prelude]))

def admitted(wl, gate=False, consumer_genexp=False):
    \"\"\"A predicate on a cell: inside `wl`, with a consumer-position genexp counted as rewritten when asked.\"\"\"
    def f(r):
        ns = set(r.nodes)
        if consumer_genexp and r.genexp["other"] == 0:
            ns.discard("GeneratorExp")
        return ns <= wl and (not gate or gate_ok(r))
    return f

RULED = (STARLARK, True)
LADDER = {
    "starlark": (STARLARK, False),
    "ruled: + genexp in consumer position": RULED,
    "(any genexp, for comparison)": (STARLARK | {"GeneratorExp"}, False),
}
def row(spec):
    wl, cg = spec
    u, o = share(admitted(wl, consumer_genexp=cg)); gu, go = share(admitted(wl, gate=True, consumer_genexp=cg))
    return {"unique": round(u, 4), "occurrences": round(o, 4), "unique +gate": round(gu, 4), "occurrences +gate": round(go, 4)}
ge = pd.DataFrame(list(ok.genexp))
print(f"while: {int(ok.nodes.map(lambda d: 'While' in d).sum())} cells, class: {int(ok.nodes.map(lambda d: 'ClassDef' in d).sum())} cells")
print(f"generator expressions: {int(ge.sum().sum())} in {int((ge.sum(axis=1) > 0).sum())} cells; in consumer position {int(ge.consumer.sum() + ge.consumer_kw.sum())} "
      f"({int(ge.consumer_kw.sum())} of them beside keyword arguments, counted as consumer); elsewhere {int(ge.other.sum())}, in {int((ge.other > 0).sum())} cells")
pd.DataFrame({k: row(v) for k, v in LADDER.items()}).T
""")

md("""
## What excludes the rest

For every cell `STARLARK` does not admit, the excluded nodes it contains. `only` counts cells whose ONE excluded node is
this one, so admitting it alone admits them; `gain` is the unique-cell share admitted by `STARLARK` plus this node.
""")

code("""
ok["excluded"] = ok.nodes.map(lambda d: sorted(set(d) - STARLARK))
out = ok[ok.excluded.map(len) > 0]
gain = {}
for node in sorted({x for e in out.excluded for x in e}):
    has = out.excluded.map(lambda e: node in e)
    only = out.excluded.map(lambda e: e == [node])
    gain[node] = {"cells": int(has.sum()), "occurrences": int(out.n[has].sum()), "only": int(only.sum()),
                  "gain": round(share(admitted(STARLARK | {node}))[0] - share(admitted(STARLARK))[0], 4),
                  "why excluded": EXCLUDED.get(node, "")}
excl = pd.DataFrame(gain).T.sort_values("cells", ascending=False)
print(f"{len(out)} of {len(ok)} unique cells are outside STARLARK")
excl
""")

md("""
Greedy: the order in which admitting one more construct admits the most further cells. This is the ranking to read
against the spec's reasons for excluding each one; it is not a proposal to admit them in this order.
""")

code("""
wl, steps = set(STARLARK), []
base = share(admitted(wl))[0]
steps.append({"add": "(starlark)", "unique": round(base, 4)})
for _ in range(6):
    cand = {n: share(admitted(wl | {n}))[0] for n in sorted({x for e in out.excluded for x in e} - wl)}
    if not cand:
        break
    n, v = max(cand.items(), key=lambda kv: kv[1])
    if v <= steps[-1]["unique"]:
        break
    wl.add(n); steps.append({"add": n, "unique": round(v, 4)})
pd.DataFrame(steps)
""")

md("""
## The run-time gate's static half

What the `+gate` columns refuse, by reason, among cells `RULED` admits by node type: these are the cells the
whitelist lets through and the gate would still send to a person, so they are what the first allow lists must decide.
The last table ranks single refusers (one dunder, one builtin, one module) by the cells each sends to a person.
""")

code("""
inside = ok[ok.apply(admitted(STARLARK, consumer_genexp=True), axis=1)]
reasons = {
    "dunder attribute": inside.dunder_attrs.map(bool),
    "dunder name": inside.dunder_names.map(bool),
    "refused builtin": inside.builtins.map(lambda b: bool(set(b) & REFUSED_BUILTINS)),
    "type() not one-argument": inside.type_calls.map(lambda t: t["other"] > 0),
    "import not in MODULES": inside.apply(lambda r: any(top(m) not in MODULES for m in [*r.imports, *r.prelude]), axis=1),
}
print(pd.DataFrame({k: {"cells": int(v.sum()), "share of admitted": round(v.mean(), 4)} for k, v in reasons.items()}).T.to_string(), "\\n")
cnt = lambda col: pd.Series([x for xs in inside[col] for x in xs]).value_counts()
print("dunder attributes:", dict(cnt("dunder_attrs").head(10)))
print("dunder names:", dict(cnt("dunder_names").head(10)))
print("refused builtins:", dict(pd.Series([k for b in inside.builtins for k in b if k in REFUSED_BUILTINS]).value_counts()))
print("imports outside MODULES (with prelude names used):", dict(pd.Series([top(m) for _, r in inside.iterrows() for m in {*r.imports, *r.prelude} if top(m) not in MODULES]).value_counts().head(15)))
def refusers(r):
    out = {f"dunder .{a}" for a in r.dunder_attrs} | {f"dunder name {n}" for n in r.dunder_names}
    out |= {f"builtin {b}()" for b in r.builtins if b in REFUSED_BUILTINS}
    out |= {f"import {top(m)}" for m in [*r.imports, *r.prelude] if top(m) not in MODULES}
    if r.type_calls["other"]:
        out.add("type() not one-argument")
    return out
refused = pd.Series([x for _, r in inside.iterrows() for x in refusers(r)]).value_counts()
print(f"\\nadmitted by RULED nodes: {len(inside)} cells; refused by the static gate: {int(inside.apply(lambda r: bool(refusers(r)), axis=1).sum())}")
refused.head(10).rename_axis("refuser").rename("cells").reset_index()
""")

md("""
## Imports and builtins

Modules by the share of cells that use them (an import, or a name the prelude binds), and builtins by the share of cells that call them.
""")

code("""
imp = pd.Series([m for _, r in ok.iterrows() for m in {top(x) for x in [*r.imports, *r.prelude]}]).value_counts()
blt = pd.Series([k for b in ok.builtins for k in b]).value_counts()
pd.concat([(imp / len(ok)).round(4).head(25).rename_axis("module").rename("import share").reset_index(),
           (blt / len(ok)).round(4).head(25).rename_axis("builtin").rename("call share").reset_index()], axis=1)
""")

md("""
## Library methods: the first manifests' name lists

Module-level names reached through an import (`pandas.DataFrame`, `numpy.where`) and methods called on values
(`.groupby`, `.str.contains`). A method name is attributed to every receiver kind whose class has it in the notebook
environment's pandas and numpy, so `.sum` lands on DataFrame, Series, GroupBy and ndarray alike: the AST cannot tell
receivers apart, and a names-only list does not need to. A name is proposed when at least `MIN_CELLS` unique cells use
it; every observed name is kept with its count.
""")

code("""
import numpy as np
from pandas.core.groupby import DataFrameGroupBy, SeriesGroupBy
from pandas.core.strings.accessor import StringMethods
from pandas.core.indexes.accessors import CombinedDatetimelikeProperties
MIN_CELLS = 2

def cell_counts(col):
    c = {}
    for d in ok[col]:
        for k in d:
            c[k] = c.get(k, 0) + 1
    return pd.Series(c, dtype=int).sort_values(ascending=False)

chains, methods = cell_counts("chains"), cell_counts("methods")
public = lambda cls: {n for n in dir(cls) if not n.startswith("_")}
KINDS = {
    "pandas": {"DataFrame": public(pd.DataFrame), "Series": public(pd.Series), "Index": public(pd.Index),
               "GroupBy": public(DataFrameGroupBy) | public(SeriesGroupBy), "str": public(StringMethods),
               "dt": public(CombinedDatetimelikeProperties)},
    "numpy": {"ndarray": public(np.ndarray)},
}
BUILTIN_KINDS = {"str": public(str), "list": public(list), "dict": public(dict), "set": public(set),
                 "tuple": public(tuple), "int": public(int), "float": public(float)}

def module_names(mod):
    s = chains[[k.split(".")[0] == mod and "." in k for k in chains.index]]
    return {k[len(mod) + 1:]: int(v) for k, v in s.items()}

def kind_methods(kinds):
    out = {}
    for kind, names in kinds.items():
        acc = kind if kind in ("str", "dt") and kinds is KINDS["pandas"] else None
        got = {}
        for m, v in methods.items():
            parts = m.lstrip(".").split(".")
            if acc:
                if len(parts) == 2 and parts[0] == acc and parts[1] in names:
                    got[parts[1]] = int(v)
            elif len(parts) == 1 and parts[0] in names:
                got[parts[0]] = int(v)
        out[kind] = got
    return out

def manifest(mod):
    fns = module_names(mod)
    kinds = kind_methods(KINDS[mod])
    pick = lambda d: sorted(k for k, v in d.items() if v >= MIN_CELLS)
    return {"module": mod, "version_counted_against": (pd if mod == "pandas" else np).__version__, "min_cells": MIN_CELLS,
            "functions": pick(fns), "kinds": {k: pick(v) for k, v in kinds.items()},
            "observed": {"functions": dict(sorted(fns.items())), "kinds": {k: dict(sorted(v.items())) for k, v in kinds.items()}},
            "note": "names only; effects, return marking (fresh/alias/internal) and cost shapes are the second pass, after the CPython restricted mode"}

import decimal
import PIL.Image
KINDS["stdlib"] = {"Decimal": public(decimal.Decimal)}
KINDS["PIL"] = {"Image": public(PIL.Image.Image)}
def stdlib_manifest():
    mods = sorted(MODULES - {"pandas", "numpy"})
    fns = {m: module_names(m) for m in mods}
    kinds = kind_methods(KINDS["stdlib"])
    pick = lambda d: sorted(k for k, v in d.items() if v >= MIN_CELLS)
    return {"modules": {m: pick(f) for m, f in fns.items() if f}, "kinds": {k: pick(v) for k, v in kinds.items()},
            "leaves": {"decimal.Decimal": {"effects": "pure", "returns": "fresh", "cost": "digits",
                                           "why": "a C type used by 10% of cells; ruled a day-one entry (repl-specs 2026-10-15)"},
                       **{f"csv.{n}": {"effects": "pure", "returns": "fresh", "cost": "input length",
                                       "over": "an in-memory iterable (a StringIO or a list of lines), never a file",
                                       "why": "_csv is C; ruled in as a leaf 2026-10-15"} for n in ("reader", "writer", "DictReader")}},
            "observed": {"modules": {m: dict(sorted(f.items())) for m, f in fns.items() if f}, "kinds": kinds}, "min_cells": MIN_CELLS,
            "note": "names only, except the ruled leaf; effects, return marking and cost shapes are the second pass"}
for mod in ("pandas", "numpy"):
    m = manifest(mod)
    if mod == "pandas":
        m["dynamic"] = {"DataFrame": {"rule": "columns", "predicate": "name in obj.columns, ours, registered from the manifest, run with the depth lifted (never the object's __getattr__)",
                                      "returns": "alias(0)", "never": ["a dunder", "a name in the kind's static method set"],
                                      "why": "column attribute access (df.Region) is common; ruled 2026-10-15"}}
    (OUT / f"manifest-{mod}.json").write_text(json.dumps(m, indent=2) + "\\n")
(OUT / "manifest-stdlib.json").write_text(json.dumps(stdlib_manifest(), indent=2) + "\\n")
def pil_manifest():
    fns = module_names("PIL")
    # Attributed only within cells that reach PIL (an import, or the prelude's `Image`): by name alone, every
    # `str.split` in the corpus would count as `Image.split`.
    pil_cells = ok[ok.apply(lambda r: any(top(m) == "PIL" for m in [*r.imports, *r.prelude]), axis=1)]
    names = public(PIL.Image.Image)
    meths = {}
    for d in pil_cells.methods:
        for m in d:
            if m.lstrip(".") in names:
                meths[m.lstrip(".")] = meths.get(m.lstrip("."), 0) + 1
    return {"module": "PIL", "version_counted_against": PIL.__version__, "functions": sorted(fns), "kinds": {"Image": sorted(meths)},
            "leaves": {**{f"PIL.{n}": {"cost": "pixels", "returns": "fresh",
                                       **({"effects": "read(buffer arg)", "why": "open reads the path or buffer it is given: allowed only over an owned BytesIO, never a path"} if n == "Image.open" else {})}
                          for n in sorted(fns)},
                       **{f"Image.{n}": {"cost": "pixels", **({"effects": "write(buffer arg)", "why": "save writes to the file or buffer it is given: allowed only into an owned BytesIO"} if n == "save" else {})} for n in sorted(meths)}},
            "cells": len(pil_cells),
            "observed": {"functions": fns, "kinds": {"Image": meths}},
            "note": "every name the corpus calls, however rare (MIN_CELLS does not apply: the list is short); the prelude binds Image; "
                    "effects and return marking per method are the second pass, cost is in pixels (ruled 2026-10-15)"}
import PIL
(OUT / "manifest-pil.json").write_text(json.dumps(pil_manifest(), indent=2) + "\\n")
print("PIL:", pil_manifest()["functions"], pil_manifest()["kinds"])
(OUT / "method-counts.json").write_text(json.dumps({"unique_cells": len(ok), "min_cells": MIN_CELLS,
    "chains": chains.to_dict(), "methods": methods.to_dict()}, indent=2) + "\\n")
for mod in ("pandas", "numpy"):
    m = manifest(mod)
    print(f"{mod}: {len(m['functions'])} module names, " + ", ".join(f"{k} {len(v)}" for k, v in m["kinds"].items()))
pd.concat([chains.head(30).rename_axis("chain").rename("cells").reset_index(), methods.head(30).rename_axis("method").rename("cells").reset_index()], axis=1)
""")

md("""
## Name-resolving leaves and callbacks

Ruled 2026-10-15 (repl-specs): a pandas leaf that resolves a method NAME from a string (`df.agg("sum")`) admits only a
closed vocabulary of strings, checked before the call; `query` and `eval` are out of the manifest; and a lifted leaf
admits as a callable argument only the program's own function, so `df.a.apply(str)` or `key=len` would be refused. This
counts each of those in the corpus: the vocabulary is what the cells actually pass, and the callback idiom's frequency
decides whether the manifest needs a listed set of callback-safe C callables.
""")

code("""
from collections import Counter
leaf = {}
for d in ok.leaf_args:
    for m, kinds in d.items():
        c = leaf.setdefault(m, Counter())
        for k in kinds:
            c[k] += 1                      # unique cells passing this kind to this leaf
vocab = {m: {k[4:]: v for k, v in c.items() if k.startswith("str:")} for m, c in leaf.items()}
vocab = {m: dict(sorted(v.items(), key=lambda kv: -kv[1])) for m, v in vocab.items() if v}
c_callbacks = Counter()
for m, c in leaf.items():
    for k, v in c.items():
        if k.startswith("builtin:") or k == "method":
            c_callbacks[(m, k)] += v
cells_with_c_callback = int(ok.leaf_args.map(lambda d: any(k.startswith("builtin:") or k == "method"
                                                           for kinds in d.values() for k in kinds)).sum())
query_eval = {m: int(ok.methods.map(lambda d: m in d).sum()) for m in (".query", ".eval")}
(OUT / "leaf-vocabulary.json").write_text(json.dumps({
    "unique_cells": len(ok),
    "vocabulary": vocab,
    "c_callables_as_callbacks": {f"{m} {k}": v for (m, k), v in sorted(c_callbacks.items(), key=lambda kv: -kv[1])},
    "cells_with_a_c_callable_callback": cells_with_c_callback,
    "query_eval_cells": query_eval,
    "all_kinds": {m: dict(sorted(c.items(), key=lambda kv: -kv[1])) for m, c in sorted(leaf.items())},
}, indent=2) + "\\n")
print("strings passed, by leaf (unique cells):")
for m, v in vocab.items():
    print(f"  {m}: {v}")
print(f"\\ncells passing a C callable as a callback: {cells_with_c_callback} of {len(ok)}")
for (m, k), v in sorted(c_callbacks.items(), key=lambda kv: -kv[1])[:15]:
    print(f"  {m} {k}: {v}")
print(f"\\nquery / eval: {query_eval}")
pd.DataFrame({m: dict(c) for m, c in leaf.items()}).fillna(0).astype(int).T
""")

md("""
## The proposed whitelist

`data/whitelist.json`: the node set (`STARLARK`, the one ratchet), what stays excluded and why with the share of cells
each costs, the modules and builtins the first allow lists start from, and the methods on builtin types cells call.
Builtins are proposed when observed in at least `MIN_CELLS` cells and not in `REFUSED_BUILTINS`.
""")

code("""
builtin_methods = kind_methods(BUILTIN_KINDS)
proposed = {
    "nodes": sorted(STARLARK),
    "conditional": {"GeneratorExp": "only as the sole positional argument (keywords allowed) of " + ", ".join(sorted(corpus.CONSUMERS | {"str.join"})) + "; rewritten to a ListComp by the pre-pass; refused anywhere else"},
    "type": "one-argument type(x) only: a receiver kind with no attributes, not callable, is/== and repr only; any other form refused",
    "excluded": {n: {"why": w, "cells": int(excl.loc[n, "cells"]) if n in excl.index else 0,
                     "gain_if_admitted": float(excl.loc[n, "gain"]) if n in excl.index else 0.0} for n, w in sorted(EXCLUDED.items())},
    "modules": sorted(MODULES),
    "builtins": sorted({k for k, v in blt.items() if v >= MIN_CELLS and k not in REFUSED_BUILTINS} | {"isinstance", "type"}),
    "refused_builtins": sorted(REFUSED_BUILTINS),
    "builtin_kinds": {k: sorted(n for n, v in d.items() if v >= MIN_CELLS) for k, d in builtin_methods.items()},
    "admitted": {k: row(v) for k, v in LADDER.items()},
    "decided": "2026-10-15, repl-specs rulings 1-4 (session-mail 20261015-1201Z-repl-specs-to-repl-lane3-genexp-type-columns-rulings.md)",
    "parsed_with": f"CPython {__import__('sys').version.split()[0]} ast (Pyodide carries 3.14.0; 3.14 adds only TemplateStr/Interpolation)",
}
(OUT / "whitelist.json").write_text(json.dumps(proposed, indent=2) + "\\n")
{k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in proposed.items()}
""")

nb = nbf.v4.new_notebook()
nb.cells = cells
nb.metadata["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
nbf.write(nb, HERE / "corpus-count.ipynb")
