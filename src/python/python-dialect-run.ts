// python-dialect-run.ts — the Python a cell runs INSIDE the read-only dialect: the fork's gate, the readiness probe and the allow tables' load.

/**
 * The cell INSIDE the read-only dialect (docs/spec/PYTHON_DIALECT.md, "Membership replaces `mode`"): checked and run by
 * the fork's `restricted.run_cell` in a COPY of the namespace that holds none of the wrapper's names. A refusal (a node,
 * module, call or attribute outside the dialect, or the step budget or memory cap) sets `_ml_not_in_dialect` and leaves
 * the namespace as it was, and the host discards the run and asks the person. Only a finished run's bindings are copied
 * back, never one the wrapper itself reads (a builtin's name, or one starting with "_"), and only when each new binding
 * and the value are DATA (`_ml_not_inert`): a function, class, generator or captured builtin, at any depth, would run
 * ungated in a later cell, so it puts the cell outside instead (docs/spec/PYTHON_DIALECT.md, #892, #893). The try
 * streams nothing, and a refused one's output is dropped.
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
def _ml_not_inert(_roots, _before, _cap=2000000):
    # Why the first value reachable from _roots is not inert DATA, else None. A value the namespace held before the run
    # (by identity) was put there by approved code and passes unwalked. Data is an allowlist matched on the EXACT type (a
    # subclass the cell made has methods the gate never ran): scalars, the builtin containers (walked), numpy arrays and
    # pandas frames, series and indexes (their object values walked); a module is named wherever it is used.
    import sys as _sys, types as _t, datetime as _dt, decimal as _dc, fractions as _fr, collections as _co
    _scalar = {type(None), bool, int, float, complex, str, bytes, range, _dt.date, _dt.datetime, _dt.time, _dt.timedelta,
               _dt.timezone, _dc.Decimal, _fr.Fraction, _t.ModuleType}
    _seq = {list, tuple, set, frozenset, _co.deque}
    _map = {dict, _co.OrderedDict, _co.Counter}
    _np, _pd = _sys.modules.get("numpy"), _sys.modules.get("pandas")
    _pdscalar = {_pd.Timestamp, _pd.Timedelta, type(_pd.NaT), type(_pd.NA), _pd.Period} if _pd else set()
    _pdobj = (_pd.DataFrame, _pd.Series) if _pd else ()
    for _name, _root in _roots:
        _stack, _seen, _n = [_root], set(), 0
        while _stack:
            _x = _stack.pop()
            if id(_x) in _before or id(_x) in _seen:
                continue
            _seen.add(id(_x))
            _n += 1
            if _n > _cap:
                return "it leaves " + _ml_what(_name) + " too large to check for anything but data"
            _ty = type(_x)
            if _ty in _scalar or _ty in _pdscalar:
                continue
            if _ty in _seq:
                _stack.extend(_x)
            elif _ty in _map:
                _stack.extend(_x.keys()); _stack.extend(_x.values())
            elif _ty is _co.defaultdict:
                _stack.append(_x.default_factory); _stack.extend(_x.keys()); _stack.extend(_x.values())
            elif _np is not None and _ty is _np.ndarray:
                if _x.dtype.hasobject:
                    _stack.extend(_x.ravel().tolist())
            elif _np is not None and isinstance(_x, _np.generic) and _ty.__module__ == "numpy" and not _x.dtype.hasobject:
                continue
            elif _pd is not None and (_ty in _pdobj or (isinstance(_x, _pd.Index) and _ty.__module__ == "pandas")):
                if _ty in _pdobj:
                    _stack.append(dict(_x.attrs))
                if _ty is _pd.DataFrame:
                    _stack.extend([_x.index, _x.columns]); _stack.extend(_x.iloc[:, _i] for _i in range(_x.shape[1]))
                    continue
                _stack.extend([_x.index, _x.name] if _ty is _pd.Series else list(_x.names))
                _a = _x.to_numpy()
                if _a.dtype.hasobject:
                    _stack.extend(_a.tolist())
            else:
                _kind = ("a function or class it defined" if isinstance(_x, (_t.FunctionType, type, _t.MethodType))
                         else "a builtin it captured (" + str(getattr(_x, "__name__", "?")) + ")" if isinstance(_x, _t.BuiltinFunctionType)
                         else "a " + _ty.__name__)
                return "it leaves " + _ml_what(_name) + " holding " + _kind + ", which the dialect cannot vouch for"
    return None
def _ml_what(_name):
    return _name if _name.startswith("the ") else "'" + _name + "'"
def _ml_inside_run(_src, _g):
    global _ml_not_in_dialect
    import builtins as _bi, _restricted as _r, restricted as _rs
    _keep = lambda _k: not _k.startswith("_") and not hasattr(_bi, _k)
    _ns = {_k: _v for _k, _v in _g.items() if not _k.startswith("_")}
    _before = {id(_x) for _x in _ns.values()}
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
    # A finished run's new bindings, and its value, must be DATA: a function, class or generator it made carries a body
    # the gate never ran, and a builtin it captured (f = open) is a call the gate refused, either of which a later
    # full-path cell would run ungated. Anything not shown to be data puts the cell outside, so it asks.
    _bad = _ml_not_inert([(_k, _x) for _k, _x in _ns.items() if _keep(_k) and (_k not in _g or _g[_k] is not _x)]
                         + [("the value it returns", _v)], _before)
    if _bad:
        _ml_not_in_dialect = _bad
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
