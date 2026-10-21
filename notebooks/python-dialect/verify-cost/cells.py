"""cells.py — times every real python_exec cell inside the dialect, in one interpreter (run by one-cells.mjs).

Each cell goes the way src/python/python-dialect-run.ts runs one: the whitelist and manifests loaded by
`restricted.load_manifests`, `_ml_trailing_return` applied, and `restricted.run_cell` on a COPY of a namespace holding
what the runtime's prelude binds (python-runtime.ts PRELUDE_BASE and PRELUDE_DATA's empty inputs). The copy-back walk
after a finished run is left out: it is the same Python on every core and touches no allocator wrapper. A cell's
outcome is `ok`, `refused` (NotInDialect) or `error:<type>`; only the outcome's kind leaves this file, never a message,
since a refusal's text quotes the cell.
"""
import ast
import contextlib
import io
import json
import textwrap
import time


def _trailing_return(src):
    # python-dialect-run.ts _ml_trailing_return: "return " spliced before a bare trailing expression, at its own column.
    try:
        body = ast.parse("def _f():\n" + textwrap.indent(src, "    ")).body[0].body
    except SyntaxError:
        return src
    if not body or not isinstance(body[-1], ast.Expr):
        return src
    lines = src.split("\n")
    i, c = body[-1].lineno - 2, body[-1].col_offset - 4
    b = lines[i].encode()
    lines[i] = (b[:c] + b"return " + b[c:]).decode()
    return "\n".join(lines)


def _prelude():
    import base64, sys
    import numpy as np, pandas as pd
    from PIL import Image
    return {"np": np, "pd": pd, "Image": Image, "io": io, "base64": base64, "sys": sys, "contextlib": contextlib,
            "img": None, "img_np": None, "H": 0, "W": 0, "df": None, "tables": {}}


def measure(cells_json, data_dir, reps):
    """{cell_id: {"outcome": str, "ns": [per rep]}}; a cell that is not `ok` on its first rep is not repeated."""
    import _restricted, restricted
    _restricted.reset()
    restricted.load_manifests(data_dir)
    nodes = frozenset(json.load(open(data_dir + "/whitelist.json"))["nodes"])
    base = _prelude()
    out = {}
    for cid, src in json.loads(cells_json).items():
        src = _trailing_return(src)
        ns_list, outcome = [], "ok"
        for _ in range(reps):
            ns = dict(base)
            t = time.perf_counter()
            try:
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    restricted.run_cell(src, ns, nodes)
            except _restricted.NotInDialect:
                outcome = "refused"
            except BaseException as e:  # noqa: BLE001 (a cell's own error, SystemExit included, is an outcome)
                outcome = "error:" + type(e).__name__
            ns_list.append(round((time.perf_counter() - t) * 1e9))
            if outcome != "ok":
                break
        out[cid] = {"outcome": outcome, "ns": ns_list}
    return out
