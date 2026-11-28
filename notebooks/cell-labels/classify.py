"""classify.py — the offline cell classifier (docs/spec/CELL_FACTS.md, Half 2): what each `exec` and `python_exec` cell of
a run is FOR, as labels read from its syntax tree, never stored in an export and never shown to a model.

    python3 notebooks/cell-labels/classify.py <run.json>...          # print one row per cell
    python3 notebooks/cell-labels/classify.py --write <run.json>...  # write <run>.cell-labels.json beside each export

A Python cell is read with `ast`; a JS cell by classify-js.mjs (the dialect's parser, then acorn). The rules are
labels.json, and every row names its `taxonomy`. Rows hold labels, flags and module names, never the cell's code.
"""

from __future__ import annotations

import ast
import fnmatch
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
RULES = json.loads((HERE / "labels.json").read_text())
TAXONOMY = RULES["taxonomy"]
TOOLS = {"python_exec": "python", "exec": "js"}


# --- names ---

def matches(name: str | None, globs) -> bool:
    """Whether a dotted name matches one of a list of globs (`*` matches anything, dots included)."""
    return bool(name) and any(fnmatch.fnmatchcase(name, g) for g in globs or ())


def _parse(code: str) -> list[ast.stmt] | None:
    """The cell's statements. A top-level `return` or `await` is legal (the runtime wraps the cell in a function)."""
    try:
        return compile(code, "<cell>", "exec", flags=ast.PyCF_ONLY_AST | ast.PyCF_ALLOW_TOP_LEVEL_AWAIT).body
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        pass
    try:
        wrapped = "async def _cell():\n" + "\n".join("    " + l for l in code.split("\n"))
        return ast.parse(wrapped).body[0].body  # type: ignore[attr-defined]
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return None


def _aliases(body: list[ast.stmt], rules: dict) -> dict[str, str]:
    """Each name the cell binds by import, to the dotted name it stands for; the rules' defaults first."""
    out = dict(rules["aliases"])
    for n in (x for s in body for x in ast.walk(s)):
        if isinstance(n, ast.Import):
            for a in n.names:
                if a.asname:
                    out[a.asname] = a.name
                else:
                    out[a.name.split(".")[0]] = a.name.split(".")[0]
        elif isinstance(n, ast.ImportFrom) and n.module and n.level == 0:
            for a in n.names:
                if a.name != "*":
                    out[a.asname or a.name] = f"{n.module}.{a.name}"
    return out


# --- the labels ---

class _Cell(ast.NodeVisitor):
    """One walk over a Python cell, collecting labels and flags as it goes."""

    def __init__(self, rules: dict, aliases: dict[str, str]):
        self.R, self.al = rules, aliases
        self.labels: set[str] = set()
        self.flags: set[str] = set()
        self.imports: set[str] = set()
        self.outputs: list[ast.expr] = []
        self.loop = 0
        self.fn = 0
        self.callees: set[int] = set()

    def dn(self, x) -> str:
        if isinstance(x, ast.Name):
            return self.al.get(x.id, x.id)
        if isinstance(x, ast.Attribute):
            return self.dn(x.value) + "." + x.attr
        return "*"

    def is_call(self, n, globs) -> bool:
        return isinstance(n, ast.Call) and matches(self.dn(n.func), globs)

    def sep_split(self, n) -> bool:
        if not (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "split"):
            return False
        sep = n.args[0] if n.args else next((k.value for k in n.keywords if k.arg == "sep"), None)
        return isinstance(sep, ast.Constant) and sep.value in self.R["parse"]["split_separators"]

    # structure

    def _loop(self, n):
        self.flags.add("loop")
        self.loop += 1
        self.generic_visit(n)
        self.loop -= 1

    visit_For = visit_AsyncFor = visit_While = _loop

    def _comp(self, n):
        self.flags.add("loop")
        if any(g.ifs for g in n.generators):
            self.labels.add("select")
        self.generic_visit(n)

    visit_ListComp = visit_SetComp = visit_DictComp = visit_GeneratorExp = _comp

    def visit_Try(self, n):
        self.flags.add("try")
        self.generic_visit(n)

    visit_TryStar = visit_Try

    def visit_Import(self, n):
        self.flags.add("import")
        self.imports.update(a.name for a in n.names)

    def visit_ImportFrom(self, n):
        self.flags.add("import")
        self.imports.add(n.module if n.level == 0 and n.module else ".")

    def _def(self, n):
        if self.R["define"]["def"]:
            self.labels.add("define")
        self.fn += 1
        self.generic_visit(n)
        self.fn -= 1

    visit_FunctionDef = visit_AsyncFunctionDef = _def

    def visit_ClassDef(self, n):
        if self.R["define"]["class"]:
            self.labels.add("define")
        self.fn += 1
        self.generic_visit(n)
        self.fn -= 1

    def visit_Lambda(self, n):
        self.fn += 1
        self.generic_visit(n)
        self.fn -= 1

    # statements a cell hands back

    def visit_Expr(self, n):
        if self.fn == 0 and not self.is_call(n.value, self.R["output_calls"]):
            self.outputs.append(n.value)
        self.generic_visit(n)

    def visit_Return(self, n):
        if self.fn == 0 and n.value is not None:
            self.outputs.append(n.value)
        self.generic_visit(n)

    # assignment

    def visit_Assign(self, n):
        if self.R["transform"]["assign_subscript"] and any(isinstance(t, ast.Subscript) for t in n.targets):
            self.labels.add("transform")
        if self.R["define"]["lambda_assigned"] and isinstance(n.value, ast.Lambda) and any(isinstance(t, ast.Name) for t in n.targets):
            self.labels.add("define")
        self.generic_visit(n)

    def visit_AnnAssign(self, n):
        if self.R["transform"]["assign_subscript"] and isinstance(n.target, ast.Subscript):
            self.labels.add("transform")
        self.generic_visit(n)

    def visit_AugAssign(self, n):
        if self.loop and self.R["aggregate"]["accumulate_in_loop"]:
            self.labels.add("aggregate")
        self.generic_visit(n)

    # reads and calls

    def visit_Subscript(self, n):
        s = n.slice
        if isinstance(s, (ast.Compare, ast.BoolOp)) or (isinstance(s, ast.UnaryOp) and isinstance(s.op, (ast.Invert, ast.Not))) \
                or (isinstance(s, ast.BinOp) and isinstance(s.op, (ast.BitAnd, ast.BitOr))) or self.is_call(s, self.R["select"]["mask_calls"]):
            self.labels.add("select")
        self.generic_visit(n)

    def visit_Attribute(self, n):
        if id(n) not in self.callees:
            name = self.dn(n)
            for lab in ("probe", "select", "transform"):
                if matches(name, self.R[lab].get("reads")):
                    self.labels.add(lab)
        self.generic_visit(n)

    def visit_Call(self, n):
        R, name = self.R, self.dn(n.func)
        self.callees.add(id(n.func))
        if matches(name, R["output_calls"]):
            self.outputs.extend(n.args)
            if R["report"]["formatted_print"] and any(self._formatted(a) for a in n.args):
                self.labels.add("report")
        for lab in ("ingest", "parse", "list", "probe", "select", "aggregate", "report", "shell", "plot"):
            if matches(name, R[lab]["calls"]):
                self.labels.add(lab)
        if matches(name, R["write"]["calls"]):
            # `df.to_csv()` with no path returns the text: it renders, it writes nothing.
            no_target = not n.args and not any(k.arg in ("path_or_buf", "excel_writer") for k in n.keywords)
            self.labels.add("report" if no_target and matches(name, R["write"]["text_without_target"]) else "write")
        if matches(name, R["transform"]["calls"]) and not (name == "map" and any(self.sep_split(a) for a in n.args)):
            self.labels.add("transform")
        if self.sep_split(n):
            self.labels.add("parse")
        if not n.args and not n.keywords and matches(name, R["probe"]["bare_calls"]):
            self.labels.add("probe")
        if name == "open" or name.endswith(".open"):
            mode = n.args[1 if name == "open" else 0] if len(n.args) > (1 if name == "open" else 0) else \
                next((k.value for k in n.keywords if k.arg == "mode"), None)
            if mode is None:
                written = False
            elif isinstance(mode, ast.Constant) and isinstance(mode.value, str):
                written = any(c in mode.value for c in "wax+")
            else:
                written = None
            if written is False and R["ingest"]["open_read"]:
                self.labels.add("ingest")
            elif written and R["write"]["open_write"]:
                self.labels.add("write")
        self.generic_visit(n)

    @staticmethod
    def _formatted(a) -> bool:
        """A formatted string of a computed value: an f-string with a field, `"…".format(…)`, or `"…" % …`."""
        if isinstance(a, ast.JoinedStr):
            return any(isinstance(v, ast.FormattedValue) for v in a.values)
        if isinstance(a, ast.Call) and isinstance(a.func, ast.Attribute) and a.func.attr == "format":
            return isinstance(a.func.value, ast.Constant) and isinstance(a.func.value.value, str)
        return isinstance(a, ast.BinOp) and isinstance(a.op, ast.Mod) and isinstance(a.left, ast.Constant) and isinstance(a.left.value, str)

    # what an output is

    def expand(self, v, out: list) -> list:
        """An output value and the values it shows directly: an unwrapped `list(x)`, a container's items, an f-string's fields."""
        if v is None:
            return out
        out.append(v)
        U = self.R["inspect"]["unwrap"]
        if isinstance(v, ast.Await):
            self.expand(v.value, out)
        elif isinstance(v, ast.Call) and matches(self.dn(v.func), U):
            if isinstance(v.func, ast.Attribute):
                self.expand(v.func.value, out)
            elif v.args:
                self.expand(v.args[0], out)
        elif isinstance(v, ast.IfExp):
            self.expand(v.body, out)
            self.expand(v.orelse, out)
        elif isinstance(v, (ast.Tuple, ast.List, ast.Set)):
            for e in v.elts:
                self.expand(e, out)
        elif isinstance(v, ast.Dict):
            for e in v.values:
                self.expand(e, out)
        elif isinstance(v, ast.JoinedStr):
            for e in v.values:
                if isinstance(e, ast.FormattedValue):
                    self.expand(e.value, out)
        return out

    def is_inspect(self, c) -> bool:
        I = self.R["inspect"]
        if isinstance(c, ast.Attribute):
            return matches(self.dn(c), I["output_reads"])
        if isinstance(c, ast.Call):
            name = self.dn(c.func)
            return matches(name, I["output_calls"]) and not (name == "dir" and not c.args)
        return False


def classify_python(code: str, tables=None, rules: dict = RULES) -> dict:
    """One `python_exec` cell's labels and flags; `tables` is the step's argument, which earns `ingest` by itself."""
    R = rules["python"]
    lines = len((code or "").split("\n"))
    body = _parse(code or "")
    by_arg = tables not in (None, [], {}, "")
    if body is None:
        return {"labels": ["unparsed"], "flags": ["by-argument"] if by_arg else [], "imports": [], "lines": lines, "parser": None}
    w = _Cell(R, _aliases(body, R))
    for s in body:
        w.visit(s)
    if any(w.is_inspect(c) for v in w.outputs for c in w.expand(v, [])):
        w.labels.add("inspect")
    last = body[-1] if body else None
    if isinstance(last, ast.Return) or (isinstance(last, ast.Expr) and not w.is_call(last.value, R["output_calls"])):
        w.flags.add("returns")
    if by_arg:
        w.labels.add("ingest")
        w.flags.add("by-argument")
    if not w.labels:
        w.labels.add("other")
    return {"labels": sorted(w.labels), "flags": sorted(w.flags), "imports": sorted(w.imports), "lines": lines, "parser": "ast"}


def classify_js_many(sources: list[str], rules_file: Path | None = None) -> list[dict]:
    """Many `exec` cells' labels and flags, through one run of classify-js.mjs (under `rules_file`, labels.json if none)."""
    if not sources:
        return []
    feed = "".join(json.dumps({"id": i, "js": s or ""}) + "\n" for i, s in enumerate(sources))
    args = ["--rules", str(rules_file)] if rules_file else []
    p = subprocess.run(["node", "--import", "tsx", str(HERE / "classify-js.mjs"), *args], input=feed, capture_output=True,
                       text=True, cwd=ROOT, check=True)
    rows = sorted((json.loads(l) for l in p.stdout.splitlines() if l.strip()), key=lambda r: r["id"])
    return [{k: v for k, v in r.items() if k != "id"} for r in rows]


def classify_cells(cells: list[dict]) -> list[dict]:
    """Each cell's row, in order. A cell is `{"lang": "python"|"js", "code": …, "tables": …}`; every row names the taxonomy."""
    out: list[dict | None] = [None] * len(cells)
    js = [i for i, c in enumerate(cells) if c["lang"] == "js"]
    for i, r in zip(js, classify_js_many([cells[i]["code"] for i in js])):
        out[i] = r
    for i, c in enumerate(cells):
        if c["lang"] == "python":
            out[i] = classify_python(c["code"], c.get("tables"))
    return [{"taxonomy": TAXONOMY, "lang": c["lang"], **r} for c, r in zip(cells, out)]  # type: ignore[arg-type]


# --- the JSON export ---

def export_cells(run: dict) -> list[dict]:
    """The `exec` and `python_exec` steps of one parsed JSON export, as cells with where they sit in the run."""
    out = []
    for st in run["session"].get("steps") or []:
        lang = TOOLS.get(st.get("tool"))
        if not lang:
            continue
        a = st.get("arguments") or {}
        out.append({"step": st.get("step"), "seq": st.get("seq"), "tool": st["tool"], "lang": lang,
                    "code": a.get("code") if lang == "python" else a.get("js"), "tables": a.get("tables")})
    return out


def classify_export(path) -> dict:
    """One export's table: the run, the taxonomy, and a row per cell (labels, flags, module names; never code)."""
    run = json.loads(Path(path).read_text())
    cells = export_cells(run)
    rows = classify_cells(cells)
    return {"taxonomy": TAXONOMY, "run": run["session"].get("hash"),
            "cells": [{"step": c["step"], "seq": c["seq"], "tool": c["tool"], **r} for c, r in zip(cells, rows)]}


def main(argv: list[str]) -> None:
    write = "--write" in argv
    for p in (a for a in argv if a != "--write"):
        table = classify_export(p)
        if write:
            dest = Path(p).with_name(Path(p).stem + ".cell-labels.json")
            dest.write_text(json.dumps(table, indent=1) + "\n")
            print(dest)
        else:
            for r in table["cells"]:
                print(json.dumps({"run": table["run"], **r}))


if __name__ == "__main__":
    main(sys.argv[1:])
