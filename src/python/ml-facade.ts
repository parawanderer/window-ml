// ml-facade.ts — the Python `ml` object a cell calls the `ml` wire through (docs/spec/ML_WIRE.md;
// docs/plan/repl/LANE_1_PR2_DESIGN.md).

// The facade is Python source, built by a factory so the cell never holds what it is built from. `_ml_make(send, codec)`:
// - `send(request_json)` is the transport: one wire request out, the FINAL answer back, as JSON text. It is the harness's,
//   and how it reaches the worker's closure-held post is the channel's business, not the facade's. A call that needs the
//   person is the server's per-call suspension on the running step: the transport waits through it, so the facade has no
//   ask path of its own.
// - `codec` carries `loads`, `dumps`, `b64encode` and `b64decode`: the harness's own references, captured before any cell
//   ran, never the importable `json`/`base64`, which a cell may have patched. For the synchronous members (`ml.table`) it
//   also carries `run_sync` (Pyodide's, over JSPI; None where there is none), `charge(chars)`, which bills the dialect's
//   budget inside and does nothing outside, `frame(value)`, the DataFrame builder, and `asks`, the exception an inside
//   call raises when its source needs the person (None outside).
// The request is `{ seq, call, args }` only. Which client and run it is for is stamped outside, by the offscreen document,
// so the facade sends nothing it did not get from the harness. It holds no JsProxy, and no function the cell can reach
// gets to the transport except through a member call.

/** The Python names the facade's install defines in a cell's namespace (for PY_RESERVED_NAMES when it is wired). */
export const ML_FACADE_NAMES = ["ml", "MlError"] as const;

/**
 * The facade's Python source: defines `_ml_make(send, codec)`, returning `(ml, MlError)`.
 * - A member is any public attribute: `await ml.config()`, `await ml.dereference("@tool:a1b2c3", pipe=".rows")`. Which
 *   members a realm has is the SERVER's list, so nothing is copied here; an absent one is an `MlError` the cell can catch.
 * - Keyword arguments become one trailing options object, the wire's convention.
 * - Data shaped like a tag (one key starting with "$") crosses wrapped as `{"$": …}` both ways, unwrapped one level.
 * - An answer decodes to: a `value` as plain data (`{"$bytes": …}` as `bytes`, `{"$secret": …}` as an opaque handle); a
 *   `pointer` as an `MlPointer` naming its token, which reads back through `ml.dereference`; an `error` as a raised
 *   `MlError` with its `code`. A value marked `truncated` prints one line saying so, unasked.
 */
export const ML_FACADE = /* python */ `
def _ml_make(_send, _codec):
    _loads, _dumps, _b64e, _b64d = _codec.loads, _codec.dumps, _codec.b64encode, _codec.b64decode

    class MlError(Exception):
        """An ml call the server refused or that failed: \`code\` is the wire's (Absent, Denied, BadRequest, TooLarge, …).
        \`Detached\`: the call runs on as task \`task\`, and its result arrives later."""
        def __init__(self, code, message, task=None):
            super().__init__(f"{code}: {message}")
            self.code, self.message, self.task = code, message, task

    class MlSecret:
        """A secret handle: names a grant, carries no value. Passed back as it came; it has nothing to read."""
        __slots__ = ("_name",)
        def __init__(self, name): object.__setattr__(self, "_name", name)
        def __setattr__(self, k, v): raise AttributeError("a secret handle is read-only")
        def __repr__(self): return f"<secret {self._name!r}>"

    class MlPointer:
        """A value too large to cross: it stays where it is. Read part of it with \`await ml.dereference(p, pipe=…)\`."""
        __slots__ = ("token", "label", "size")
        def __init__(self, token, label, size): self.token, self.label, self.size = token, label, size
        def __str__(self): return self.token
        def __repr__(self): return f"<pointer {self.token} ({self.label}, {self.size:,} chars): read it with a pipe>"

    # A TAG is an object with one key starting with "$". Data shaped like one (a cell's {"$secret": …}, a fetched JSON
    # {"$bytes": …}) crosses wrapped as {"$": <object>} both ways, and the receiver unwraps one level, so data is never
    # read as a tag (ML_WIRE.md, "What crosses").
    def _tagshaped(d): return len(d) == 1 and str(next(iter(d))).startswith("$")

    def _out(x):
        if isinstance(x, (bytes, bytearray, memoryview)): return {"$bytes": _b64e(bytes(x)).decode("ascii")}
        if isinstance(x, MlSecret): return {"$secret": x._name}
        if isinstance(x, MlPointer): return x.token
        if isinstance(x, dict):
            d = {str(k): _out(v) for k, v in x.items()}
            return {"$": d} if _tagshaped(d) else d
        if isinstance(x, (list, tuple)): return [_out(v) for v in x]
        return x

    def _in(x):
        if isinstance(x, dict):
            if len(x) == 1 and "$" in x:
                d = x["$"]
                return {k: _in(v) for k, v in d.items()} if isinstance(d, dict) else _in(d)
            if len(x) == 1 and "$bytes" in x and isinstance(x["$bytes"], str): return _b64d(x["$bytes"])
            if len(x) == 1 and "$secret" in x and isinstance(x["$secret"], str): return MlSecret(x["$secret"])
            return {k: _in(v) for k, v in x.items()}
        if isinstance(x, list): return [_in(v) for v in x]
        return x

    _seq = [0]
    _run_sync, _charge, _frame, _asks = (getattr(_codec, _k, None) for _k in ("run_sync", "charge", "frame", "asks"))

    async def _ask(name, args, kwargs):
        _seq[0] += 1
        seq = _seq[0]
        wire_args = [_out(a) for a in args] + ([_out(kwargs)] if kwargs else [])
        return seq, await _send(_dumps({"seq": seq, "call": name, "args": wire_args}))

    async def _call(name, args, kwargs):
        seq, raw = await _ask(name, args, kwargs)
        return _answer(name, seq, raw)

    def _answer(name, seq, raw):
        try:
            ans = _loads(raw)
        except Exception:
            raise MlError("Failed", "the answer was not readable") from None
        if not isinstance(ans, dict) or ans.get("seq") != seq:
            raise MlError("Failed", "the answer was for another call")
        if "error" in ans:
            e = ans["error"] if isinstance(ans["error"], dict) else {}
            if e.get("code") == "Asks" and _asks is not None: raise _asks("not in dialect: ml." + name + ": " + str(e.get("message", "")))
            raise MlError(str(e.get("code", "Failed")), str(e.get("message", "")), e.get("task") if isinstance(e.get("task"), str) else None)
        if "pointer" in ans:
            p = ans["pointer"] if isinstance(ans["pointer"], dict) else {}
            return MlPointer(str(p.get("token", "")), str(p.get("label", "")), int(p.get("size", 0) or 0))
        if "value" in ans:
            if ans.get("truncated"):
                size = ans.get("size")
                print(f"[ml.{name}: this is a preview{f' of {size:,} chars' if isinstance(size, int) else ''}, not the whole value]")
            return _in(ans["value"])
        raise MlError("Failed", "the answer carried no value, pointer or error")

    def _call_sync(name, args, kwargs):
        # One call, waited on in place over JSPI: the cell's stack suspends until the answer, and nothing else runs
        # Python on its namespace meanwhile (docs/plan/repl/ML_TABLE.md, "The requirement of the JSPI route").
        if _run_sync is None: raise MlError("Absent", "ml." + name + " needs a sandbox that can wait in place, which this one cannot")
        seq, raw = _run_sync(_ask(name, args, kwargs))
        # The answer's size is charged HERE, on the cell's own stack, before it is decoded: inside run_sync the
        # awaited chain runs on the event loop, where the dialect's budget counts nothing (python-table-charge.test.mjs).
        if _charge is not None: _charge(len(raw))
        return _answer(name, seq, raw)

    def _table(src, raw=False, delimiter=None, header=None):
        """A table as a pandas DataFrame you own: \`df = ml.table("current")\`. \`src\` is a CSS selector, "current", a URL
        this run fetched, a Google Sheets URL, "@tool:<id>", "@file:<id>" or a /files/ path. \`raw\` keeps every cell a
        string; \`delimiter\` and \`header\` override discovery for delimited text. Where it came from is in \`df.attrs\`."""
        if type(src) is not str: raise TypeError("ml.table takes a source string (a CSS selector, 'current', a URL, '@tool:<id>', '@file:<id>' or a /files/ path), got " + type(src).__name__)
        if type(raw) is not bool: raise TypeError("ml.table: raw is True or False")
        if delimiter is not None and type(delimiter) is not str: raise TypeError("ml.table: delimiter is a string")
        if header is not None and type(header) is not bool: raise TypeError("ml.table: header is True, False or None")
        if _frame is None: raise MlError("Absent", "ml.table needs pandas, which this sandbox has not loaded")
        opts = {}
        if raw: opts["raw"] = True
        if delimiter is not None: opts["delimiter"] = delimiter
        if header is not None: opts["header"] = header
        return _frame(_call_sync("table", (src,), opts))
    _table.__name__ = _table.__qualname__ = "table"

    class _Member:
        __slots__ = ("_name",)
        def __init__(self, name): object.__setattr__(self, "_name", name)
        def __setattr__(self, k, v): raise AttributeError("ml is read-only")
        def __call__(self, *args, **kwargs): return _call(self._name, args, kwargs)
        # A namespace member (ml.sh.run) is one call named by its dotted path: the server decides whether it exists.
        def __getattr__(self, name):
            if name.startswith("_") or "." in self._name: raise AttributeError(name)
            return _Member(self._name + "." + name)
        def __repr__(self): return f"<ml.{self._name}: await it>"

    class _Ml:
        """window.ml, over the wire. Every member is awaited (\`rows = await ml.dereference("@tool:…", pipe=".rows")\`) but
        \`ml.table\`, which returns its DataFrame in place: \`df = ml.table("current")\`."""
        __slots__ = ()
        # \`_table\`, not \`table\`: a class body that assigns a name looks it up in the class and the module only, never in
        # this enclosing function, so \`table = staticmethod(table)\` is a NameError.
        table = staticmethod(_table)
        def __getattr__(self, name):
            if name.startswith("_"): raise AttributeError(name)
            return _Member(name)
        def __setattr__(self, k, v): raise AttributeError("ml is read-only")
        def __repr__(self): return "<ml: await ml.<member>(…)>"

    return _Ml(), MlError
`;
