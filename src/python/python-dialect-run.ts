// python-dialect-run.ts — the Python a cell runs INSIDE the read-only dialect: the fork's gate, the readiness probe and the allow tables' load.

/**
 * The cell INSIDE the read-only dialect (docs/spec/PYTHON_DIALECT.md, "Membership replaces `mode`"): checked and run by
 * the fork's `restricted.run_cell` in a COPY of the namespace that holds none of the wrapper's names. A refusal (a node,
 * module, call or attribute outside the dialect, or the step budget or memory cap) sets `_ml_not_in_dialect` and leaves
 * the namespace as it was, and the host discards the run and asks the person. Only a finished run's bindings are copied
 * back, never one the wrapper itself reads (a builtin's name, or one starting with "_"), and only when each new binding
 * and the value are DATA (`_ml_not_inert`), exactly what the cell's own import bound (`_ml_imported`), or a function
 * the cell defined, whose code the fork enters only inside a run (#895). A class, module or captured builtin, at any
 * depth or under a new name, would run ungated or disguised in a later cell, so it puts the cell outside instead
 * (docs/spec/PYTHON_DIALECT.md, #892, #893, #895, #896). The try
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
def _ml_not_inert(_roots, _cap=2000000):
    # Why the first value reachable from _roots is not inert DATA, else None. Data is an allowlist matched on the EXACT
    # type (a subclass the cell made has methods the gate never ran): scalars, the builtin containers (walked), numpy
    # arrays and pandas frames, series and indexes (their object values walked). Nothing passes by identity: a value the
    # namespace already held, under a NEW name, would hide what it is from the card (a = ml), so it is walked like any
    # other (PYTHON_DIALECT.md #896).
    import sys as _sys, types as _t, datetime as _dt, decimal as _dc, fractions as _fr, collections as _co
    _scalar = {type(None), bool, int, float, complex, str, bytes, range, _dt.date, _dt.datetime, _dt.time, _dt.timedelta,
               _dt.timezone, _dc.Decimal, _fr.Fraction}
    _seq = {list, tuple, set, frozenset, _co.deque}
    _map = {dict, _co.OrderedDict, _co.Counter}
    _np, _pd = _sys.modules.get("numpy"), _sys.modules.get("pandas")
    _pdscalar = {_pd.Timestamp, _pd.Timedelta, type(_pd.NaT), type(_pd.NA), _pd.Period} if _pd else set()
    _pdobj = (_pd.DataFrame, _pd.Series) if _pd else ()
    # Exact types, from the modules' own attributes: numpy's scalar types but object_ and void (either can hold an object),
    # and pandas' public index classes.
    _npscalar = {_k for _k in set(_np.sctypeDict.values()) if _k not in (_np.object_, _np.void)} if _np else set()
    _pdindex = {_k for _k in (getattr(_pd, _n, None) for _n in ("Index", "RangeIndex", "MultiIndex", "DatetimeIndex",
                "TimedeltaIndex", "PeriodIndex", "CategoricalIndex", "IntervalIndex")) if isinstance(_k, type)} if _pd else set()
    for _name, _root in _roots:
        _stack, _seen, _n = [_root], set(), 0
        while _stack:
            _x = _stack.pop()
            if id(_x) in _seen:
                continue
            _seen.add(id(_x))
            _n += 1
            if _n > _cap:
                return "it leaves " + _ml_what(_name) + " too large to check for anything but data"
            _ty = type(_x)
            if _ty in _scalar or _ty in _pdscalar or _ty in _npscalar:
                continue
            if _ty in _seq:
                _stack.extend(_x)
            elif _ty in _map:
                _stack.extend(_x.keys()); _stack.extend(_x.values())
            elif _ty is _co.defaultdict:
                _stack.append(_x.default_factory); _stack.extend(_x.keys()); _stack.extend(_x.values())
            elif _ty is _t.FunctionType and _ml_restricted_code(_x.__code__):
                # The cell's own function: the fork enters its code only inside a run (#895), so it crosses back. What it
                # carries is walked like any other value: a default, a keyword default, a closed-over cell.
                _stack.extend(_x.__defaults__ or ()); _stack.extend((_x.__kwdefaults__ or {}).values())
                _stack.extend(_c.cell_contents for _c in (_x.__closure__ or ()) if _ml_cell_full(_c))
            elif _np is not None and _ty is _np.ndarray:
                if _x.dtype.hasobject:
                    _stack.extend(_x.ravel().tolist())
            elif _ty in _pdobj or _ty in _pdindex:
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
                _kind = ("a function or class" if isinstance(_x, (_t.FunctionType, type, _t.MethodType))
                         else "a builtin it captured (" + str(getattr(_x, "__name__", "?")) + ")" if isinstance(_x, _t.BuiltinFunctionType)
                         else "a " + _ty.__name__)
                return "it leaves " + _ml_what(_name) + " holding " + _kind + ", which the dialect cannot vouch for"
    return None
def _ml_restricted_code(_co):
    # Is this code, and every code object among its constants, the cell's own (CO_RESTRICTED)?
    import types as _t, restricted as _rs
    _todo = [_co]
    while _todo:
        _c = _todo.pop()
        if not _c.co_flags & _rs.CO_RESTRICTED:
            return False
        _todo.extend(_k for _k in _c.co_consts if type(_k) is _t.CodeType)
    return True
def _ml_cell_full(_c):
    try:
        _c.cell_contents
        return True
    except ValueError:
        return False
def _ml_imported(_src):
    # What the cell's own import statements bind, by name: the binding the gate admitted when it let the import run, so it
    # crosses back as itself (import numpy as np; from math import sqrt). Read from sys.modules after the run.
    import ast as _a, sys as _sys
    try:
        _tree = _a.parse("def _f():\\n" + _ml_indent(_src, "    "))
    except SyntaxError:
        return {}
    _out = {}
    for _n in _a.walk(_tree):
        if isinstance(_n, _a.Import):
            for _al in _n.names:
                _mod = _al.name if _al.asname else _al.name.split(".")[0]
                if _mod in _sys.modules:
                    _out[_al.asname or _mod] = _sys.modules[_mod]
        elif isinstance(_n, _a.ImportFrom) and not _n.level and _n.module in _sys.modules:
            for _al in _n.names:
                if _al.name != "*" and hasattr(_sys.modules[_n.module], _al.name):
                    _out[_al.asname or _al.name] = getattr(_sys.modules[_n.module], _al.name)
    return _out
def _ml_what(_name):
    return _name if _name.startswith("the ") else "'" + _name + "'"
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
        # A refusal AT CHECK time names the cell's line itself; one AT RUN TIME (a module, call or attribute) names none,
        # and the cell's own frame knows it.
        if "(line " not in _msg:
            _t, _ln = _e.__traceback__, None
            while _t is not None:
                if _t.tb_frame.f_code.co_filename == "<cell>":
                    _ln = _t.tb_lineno
                _t = _t.tb_next
            if _ln:
                _msg += " (line " + str(_ln) + ")"
        _ml_not_in_dialect = _msg
        return None
    # A finished run's new bindings, and its value, must be DATA: a function, class or generator it made carries a body
    # the gate never ran, and a builtin it captured (f = open) is a call the gate refused, either of which a later
    # full-path cell would run ungated. Anything not shown to be data puts the cell outside, so it asks. The one
    # exception is what the cell's own import statement bound, exactly: the gate admitted that import.
    _imp = _ml_imported(_src)
    _bad = _ml_not_inert([(_k, _x) for _k, _x in _ns.items() if _keep(_k) and (_k not in _g or _g[_k] is not _x)
                          and not (_k in _imp and _imp[_k] is _x)]
                         + [("the value it returns", _v)])
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
    # What the gate admitted, kept for a library's shape rule: it judges imports by exactly these tables.
    import sys, types
    sys.modules.setdefault("_ml_libraries", types.SimpleNamespace(pins={})).admitted = restricted.load_manifests(_dir)["modules"]
    return ""
_ml_dialect_setup(${JSON.stringify(files)})
`;

/** Why a library may not take `_name` as its import name, or None: one plain identifier, never one that already imports
 *  (a module loaded or findable, the standard library's, or one reserved). */
const LIBRARY_NAME = /* python */ `
def _ml_library_name_refusal(_name, _reserved):
    import importlib.util, keyword, sys
    if not _name.isidentifier() or keyword.iskeyword(_name) or _name.startswith("_"):
        return "its name is not a plain module name (one identifier, not starting with _)"
    if (_name in sys.modules or _name in sys.stdlib_module_names or _name in _reserved
            or importlib.util.find_spec(_name) is not None):
        return "that name already imports something else"
    return None
`;

/** A pure-Python library the person approved for the dialect (READONLY_LIBRARY_MANIFEST.md, tier 3): its source, pinned
 *  to that source's sha256, and the names a cell may read off it. */
export interface DialectLibrary {
    /** The import name: one identifier, never one that already imports. */
    name: string;
    source: string;
    /** sha256 of `source` as UTF-8, hex. */
    sha256: string;
    names: string[];
}

/**
 * Load approved tier 3 libraries into the dialect, after `dialectSetup`. Each body is checked against the whitelist and
 * RUN inside the dialect (`mark`, `_restricted.run`), never imported by Python's own machinery, so a body that imports,
 * loops or opens anything is refused like a cell. What it leaves must carry no state from one run to the next: an object
 * made in the load run stays owned by every later run (measured on the pinned core, 2026-10-24), so a module-level list
 * or a mutable default would be written by later cells and remember. So every global must be a constant, a `def` of the
 * body with constant defaults, or exactly a module or name the gate admits an import of; `libraryShape` promised that. Only then is it registered (`sys.modules`,
 * `allow_module` with its listed names). A pin already loaded is skipped. The script's value is JSON, `[{name, why}]`,
 * `why` "" when loaded.
 * @param libs the libraries, each pinned
 * @param nodes the whitelist's AST node names
 * @param reserved import names a library may never take, though nothing has imported them yet: the dialect's modules and
 *   every package in the Pyodide lock, so a later `import scipy` on the full path is never handed a library instead
 */
export const libraryLoad = (libs: DialectLibrary[], nodes: string[], reserved: string[]): string => /* python */ `${LIBRARY_NAME}
def _ml_library_load(_libs, _nodes, _reserved):
    import hashlib, json, sys, types, _restricted, restricted
    _state = sys.modules.setdefault("_ml_libraries", types.SimpleNamespace(pins={}))
    _loaded = _state.pins
    _admitted = getattr(_state, "admitted", {})
    def _imports():
        # What an admitted import may bind, read after the body ran its imports: the modules the gate admits, and
        # exactly the names it admits of each.
        _ids = {id(sys.modules[_m]) for _m in _admitted if _m in sys.modules}
        return _ids | {id(getattr(sys.modules[_m], _n)) for _m, _ns in _admitted.items() if _m in sys.modules
                       for _n in _ns if hasattr(sys.modules[_m], _n)}
    _const = (type(None), bool, int, float, complex, str, bytes)
    def _frozen(_x):
        if type(_x) in _const:
            return True
        if type(_x) in (tuple, frozenset):
            return all(_frozen(_y) for _y in _x)
        return False
    def _left(_k, _v, _imported):
        # Why the global _k cannot stay in the module, or None.
        if _frozen(_v) or id(_v) in _imported:
            return None
        if type(_v) is types.FunctionType and _v.__code__.co_flags & restricted.CO_RESTRICTED and _v.__closure__ is None:
            for _d in list(_v.__defaults__ or ()) + list((_v.__kwdefaults__ or {}).values()):
                if not _frozen(_d):
                    return "'" + _k + "' has a default that is not a constant, which would keep state from one run to the next"
            return None
        return "'" + _k + "' holds a " + type(_v).__name__ + ", which would keep state from one run to the next"
    def _one(_lib):
        _name, _src = _lib["name"], _lib["source"]
        if _loaded.get(_name) == _lib["sha256"]:
            return ""
        if _name in _loaded:
            return "a library of that name is already loaded at another pin; it changes when the sandbox restarts"
        _why = _ml_library_name_refusal(_name, _reserved)
        if _why:
            return _why
        if hashlib.sha256(_src.encode("utf-8")).hexdigest() != _lib["sha256"]:
            return "its source does not match its sha256 pin"
        try:
            restricted.check(_src, _nodes)
            _code = restricted.mark(compile(_src, "<library " + _name + ">", "exec"))
            _ns = {"__name__": _name}
            _restricted.run(_code, _ns, restricted.DEFAULT_BUDGET)
        except _restricted.NotInDialect as _e:
            return str(_e)
        except SyntaxError as _e:
            return "not in dialect: " + str(_e)
        except Exception as _e:
            return "its body raised " + type(_e).__name__ + ": " + str(_e)
        _imported = _imports()
        for _k, _v in _ns.items():
            if _k not in ("__name__", "__builtins__"):
                _why = _left(_k, _v, _imported)
                if _why:
                    return _why
        for _n in _lib["names"]:
            if not _n.isidentifier() or _n.startswith("__"):
                return "'" + _n + "' is not a name a cell may read"
            if _n not in _ns:
                return "it defines no '" + _n + "'"
            if not (_frozen(_ns[_n]) or type(_ns[_n]) is types.FunctionType):
                return "'" + _n + "' is not a function or a constant"
        _mod = types.ModuleType(_name)
        _mod.__dict__.update({_k: _v for _k, _v in _ns.items() if _k != "__builtins__"})
        sys.modules[_name] = _mod
        _restricted.allow_module(_name, list(_lib["names"]))
        _loaded[_name] = _lib["sha256"]
        return ""
    return json.dumps([{"name": _l["name"], "why": _one(_l)} for _l in _libs])
_ml_library_load(${JSON.stringify(libs)}, frozenset(${JSON.stringify(nodes)}), frozenset(${JSON.stringify(reserved)}))
`;

/**
 * The card's verdict on a library's source, DERIVED, nothing run (the coordinator's ruling B, 2026-10-24): the whitelist
 * check, then the MODULE SHAPE. The body may hold a docstring, imports of the dialect's own modules, `def`s (no decorator)
 * whose every default is an immutable literal, and assignments of an immutable literal (a scalar, str, bytes, or a tuple
 * of such) to one name. Anything else at the top level (a call, a list or dict, a loop, a comprehension, a class) is
 * refused by line: it would run code at load or leave state a later run could write. `libraryLoad`'s check after the
 * load enforces the same, so the two must agree. The script's value is JSON, `{why, defs: [{name, signature}],
 * constants}`, `why` "" when it is admitted.
 * @param name the import name asked for
 * @param source the module's source
 * @param nodes the whitelist's AST node names
 * @param reserved import names no library may take (as `libraryLoad`'s)
 */
export const libraryShape = (name: string, source: string, nodes: string[], reserved: string[]): string => /* python */ `${LIBRARY_NAME}
def _ml_library_shape(_name, _src, _nodes, _reserved):
    import ast, json, sys, _restricted, restricted
    # The gate's own import tables, as dialectSetup's load_manifests registered them: module -> the names it admits.
    _modules = getattr(sys.modules.get("_ml_libraries"), "admitted", None)
    if _modules is None:
        return json.dumps({"why": "the dialect is not loaded in this sandbox", "defs": [], "constants": []})
    def _out(_why, _defs=(), _consts=()):
        return json.dumps({"why": _why, "defs": list(_defs), "constants": list(_consts)})
    _why = _ml_library_name_refusal(_name, _reserved)
    if _why:
        return _out(_why)
    try:
        restricted.check(_src, _nodes)
        _tree = ast.parse(_src)
    except _restricted.NotInDialect as _e:
        return _out(str(_e))
    except SyntaxError as _e:
        return _out("not in dialect: " + str(_e))
    def _literal(_v):
        if isinstance(_v, ast.Constant):
            return True
        if isinstance(_v, ast.UnaryOp) and isinstance(_v.op, (ast.USub, ast.UAdd)) and isinstance(_v.operand, ast.Constant) \
                and type(_v.operand.value) in (int, float, complex):
            return True
        return isinstance(_v, ast.Tuple) and all(_literal(_x) for _x in _v.elts)
    _defs, _consts = [], []
    for _i, _st in enumerate(_tree.body):
        _at = "line " + str(_st.lineno) + ": "
        if _i == 0 and isinstance(_st, ast.Expr) and isinstance(_st.value, ast.Constant) and isinstance(_st.value.value, str):
            continue
        if isinstance(_st, ast.Import):
            for _al in _st.names:
                if _al.name not in _modules:
                    return _out(_at + "an import of " + _al.name + ", which the dialect does not admit")
        elif isinstance(_st, ast.ImportFrom):
            if _st.level or _st.module not in _modules:
                return _out(_at + "an import from " + ("." * _st.level) + str(_st.module or "") + ", which the dialect does not admit")
            for _al in _st.names:
                if _al.name not in _modules[_st.module]:
                    return _out(_at + "an import of " + _st.module + "." + _al.name + ", which the dialect does not admit")
        elif isinstance(_st, ast.FunctionDef):
            if _st.decorator_list:
                return _out("line " + str(_st.decorator_list[0].lineno) + ": a decorated def, which would run the decorator at load")
            for _d in _st.args.defaults + [_d for _d in _st.args.kw_defaults if _d is not None]:
                if not _literal(_d):
                    return _out(_at + "a default of " + _st.name + " that is not an immutable literal, which would keep state from one run to the next")
            _defs.append({"name": _st.name, "signature": ast.unparse(_st.args)})
        elif isinstance(_st, ast.Assign):
            # Not an annotated one: under 3.14 a module-level annotation leaves a set (__conditional_annotations__).
            _targets = _st.targets
            if len(_targets) != 1 or not isinstance(_targets[0], ast.Name) or not _literal(_st.value):
                return _out(_at + "an assignment that is not one name bound to an immutable literal (a scalar, str, bytes, or a tuple of such)")
            _consts.append(_targets[0].id)
        else:
            return _out(_at + "a " + type(_st).__name__ + " at the top level, which would run code at load")
    return _out("", _defs, _consts)
_ml_library_shape(${JSON.stringify(name)}, ${JSON.stringify(source)}, frozenset(${JSON.stringify(nodes)}), frozenset(${JSON.stringify(reserved)}))
`;
