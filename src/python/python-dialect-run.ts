// python-dialect-run.ts — the Python a cell runs INSIDE the read-only dialect: the fork's gate, the readiness probe and the allow tables' load.

/**
 * The cell INSIDE the read-only dialect (docs/spec/PYTHON_DIALECT.md, "Membership replaces `mode`"): checked and run by
 * the fork's `restricted.run_cell` in a COPY of the namespace that holds none of the wrapper's names. A refusal (a node,
 * module, call or attribute outside the dialect, or the step budget or memory cap) sets `_ml_not_in_dialect` and leaves
 * the namespace as it was, and the host discards the run and asks the person. Only a finished run's bindings are copied
 * back, never one the wrapper itself reads (a builtin's name, or one starting with "_"): a function the cell defined runs
 * ungated when unrestricted code calls it.
 */
export const INSIDE_CELL = /* python */ `
        _ret = _ml_inside_run(_ml_src, globals())
`;

/**
 * What `INSIDE_CELL` calls, defined in the wrapper only for a cell run inside.
 * @param nodes the whitelist's AST node names (whitelist.json "nodes")
 */
export const insideDefs = (nodes: string[]): string => /* python */ `
_ml_not_in_dialect = None
def _ml_trailing_return(_src):
    # The full path returns a bare trailing expression (Jupyter-style); run_cell takes source, so the same cell gets the same
    # value by "return " spliced in front of that expression, at its own line and column, so line numbers stay true.
    import ast as _a
    try:
        _body = _a.parse("def _f():\\n" + _ml_indent(_src, "    ")).body[0].body
    except SyntaxError:
        return _src
    if not _body or not isinstance(_body[-1], _a.Expr):
        return _src
    _lines = _src.split("\\n")
    _i, _c = _body[-1].lineno - 2, _body[-1].col_offset - 4
    _b = _lines[_i].encode()
    _lines[_i] = (_b[:_c] + b"return " + _b[_c:]).decode()
    return "\\n".join(_lines)
def _ml_inside_run(_src, _g):
    global _ml_not_in_dialect
    import builtins as _bi, _restricted as _r, restricted as _rs
    _keep = lambda _k: not _k.startswith("_") and not hasattr(_bi, _k)
    _ns = {_k: _v for _k, _v in _g.items() if not _k.startswith("_")}
    try:
        _v = _rs.run_cell(_ml_trailing_return(_src), _ns, frozenset(${JSON.stringify(nodes)}))
    except (_r.NotInDialect, SystemError) as _e:
        # SystemError: the undo log did not replay cleanly, so nothing about the run is trusted.
        _msg = str(_e) or type(_e).__name__
        # Lines are one past the cell's for the "def _user():" the fork parses and compiles the cell under. A refusal AT
        # CHECK time names that line (corrected here); one AT RUN TIME (a module, call or attribute) names none, and the
        # cell's own frame knows it.
        import re as _re
        _m = _re.search(r"\\(line (\\d+)\\)", _msg)
        if _m:
            _msg = _msg[:_m.start()] + "(line " + str(max(1, int(_m.group(1)) - 1)) + ")" + _msg[_m.end():]
        else:
            _t, _ln = _e.__traceback__, None
            while _t is not None:
                if _t.tb_frame.f_code.co_filename == "<cell>":
                    _ln = _t.tb_lineno - 1
                _t = _t.tb_next
            if _ln:
                _msg += " (line " + str(_ln) + ")"
        _ml_not_in_dialect = _msg
        return None
    for _k, _x in _ns.items():
        if _keep(_k) and (_k not in _g or _g[_k] is not _x):
            _g[_k] = _x
    for _k in [_k for _k in _g if _keep(_k) and _k not in _ns]:
        del _g[_k]
    return _v
`;

/**
 * Make the interpreter ready to run cells inside the dialect, once per worker: the fork's modules present, its build
 * gate off (no specialization, tier 2 or JIT), the whitelist and manifests written where `load_manifests` reads them,
 * and the allow tables loaded. The script's value is "" when ready, else the reason it is not, so a stock or old core
 * leaves every cell outside (it asks).
 * @param files the dialect's data files by name (whitelist.json, manifest-*.json)
 */
export const dialectSetup = (files: Record<string, string>): string => /* python */ `
def _ml_dialect_setup(_files):
    import importlib.util, os
    if importlib.util.find_spec("_restricted") is None or importlib.util.find_spec("restricted") is None:
        return "this Pyodide build has no membership predicate (the stock core, not the restricted-mode fork)"
    import _restricted, restricted
    if any(_restricted.build().values()):
        return "this Pyodide build specializes or has a JIT, so the dialect's gate cannot be trusted"
    _dir = "/tmp/ml-dialect"
    os.makedirs(_dir, exist_ok=True)
    for _name, _text in _files.items():
        with open(os.path.join(_dir, _name), "w") as _f:
            _f.write(_text)
    _restricted.reset()
    restricted.load_manifests(_dir)
    return ""
_ml_dialect_setup(${JSON.stringify(files)})
`;
