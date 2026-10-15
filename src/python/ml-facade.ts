// ml-facade.ts — the Python `ml` object a cell calls the `ml` wire through (docs/spec/ML_WIRE.md;
// docs/plan/repl/LANE_1_PR2_DESIGN.md).

// The facade is Python source, built by a factory so the cell never holds what it is built from. `_ml_make(send, codec)`:
// - `send(request_json)` is the transport: one wire request out, the FINAL answer back, as JSON text. It is the harness's,
//   and how it reaches the worker's closure-held post is the channel's business, not the facade's. A call that needs the
//   person is the server's per-call suspension on the running step: the transport waits through it, so the facade has no
//   ask path of its own.
// - `codec` carries `loads`, `dumps`, `b64encode` and `b64decode`: the harness's own references, captured before any cell
//   ran, never the importable `json`/`base64`, which a cell may have patched.
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
        """An ml call the server refused or that failed: \`code\` is the wire's (Absent, Denied, BadRequest, TooLarge, …)."""
        def __init__(self, code, message):
            super().__init__(f"{code}: {message}")
            self.code, self.message = code, message

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

    async def _call(name, args, kwargs):
        _seq[0] += 1
        seq = _seq[0]
        wire_args = [_out(a) for a in args] + ([_out(kwargs)] if kwargs else [])
        raw = await _send(_dumps({"seq": seq, "call": name, "args": wire_args}))
        try:
            ans = _loads(raw)
        except Exception:
            raise MlError("Failed", "the answer was not readable") from None
        if not isinstance(ans, dict) or ans.get("seq") != seq:
            raise MlError("Failed", "the answer was for another call")
        if "error" in ans:
            e = ans["error"] if isinstance(ans["error"], dict) else {}
            raise MlError(str(e.get("code", "Failed")), str(e.get("message", "")))
        if "pointer" in ans:
            p = ans["pointer"] if isinstance(ans["pointer"], dict) else {}
            return MlPointer(str(p.get("token", "")), str(p.get("label", "")), int(p.get("size", 0) or 0))
        if "value" in ans:
            if ans.get("truncated"):
                size = ans.get("size")
                print(f"[ml.{name}: this is a preview{f' of {size:,} chars' if isinstance(size, int) else ''}, not the whole value]")
            return _in(ans["value"])
        raise MlError("Failed", "the answer carried no value, pointer or error")

    class _Member:
        __slots__ = ("_name",)
        def __init__(self, name): object.__setattr__(self, "_name", name)
        def __setattr__(self, k, v): raise AttributeError("ml is read-only")
        def __call__(self, *args, **kwargs): return _call(self._name, args, kwargs)
        def __repr__(self): return f"<ml.{self._name}: await it>"

    class _Ml:
        """window.ml, over the wire. Every member is awaited: \`rows = await ml.dereference("@tool:…", pipe=".rows")\`."""
        __slots__ = ()
        def __getattr__(self, name):
            if name.startswith("_"): raise AttributeError(name)
            return _Member(name)
        def __setattr__(self, k, v): raise AttributeError("ml is read-only")
        def __repr__(self): return "<ml: await ml.<member>(…)>"

    return _Ml(), MlError
`;
