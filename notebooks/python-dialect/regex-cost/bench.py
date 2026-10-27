"""bench.py — times sre searches against regex_work's bound, inside Pyodide, for regex-cost.ipynb.

Run through one.mjs (`node one.mjs <coreDir> <restrictedPy> > out.json`); `run(restricted_path)` returns ONE dict
{ meta, step_rate, rows }. regex_work lives in the fork's Lib/restricted.py, which the Pyodide core's own (older)
`restricted` module lacks, so the file's text is exec'd into a fresh module dict here; it imports `_restricted`, which
the core has.

Groups mirror notebooks/readonly/regex-bench.mjs: worst (the worst-case shapes), counted (counted repeats at up to 2M
characters), ordinary (what a real survey runs), fuzz (seeded random patterns that pass BOTH risky_regex and risky_parse,
on six adversarial inputs; a search whose bound predicts over ~2 s is skipped, and only rows of 1 ms or more are kept).
Methods are re.search and re.findall, the only two the dialect admits on an input (data/manifest-stdlib.json).

Dropped from the JS list, as JS-only or not expressible in Python's re: the \\p{L} row (no property escapes in re), the
lookbehind row (?<=a+)b (re needs a fixed-width lookbehind), so "worst" has eighteen rows, not twenty. The `u` and `g`
flags go too (str patterns are Unicode already; findall is the global form). The JS methods split/replace/matchAll/match all become findall (one pass over every start), and a
JS single `match` becomes search.
"""

import math
import re
import statistics
import sys
import time
import types

PROVISIONAL_NS_PER_UNIT = 1.0     # fuzz: skip a search whose bound x this predicts over ~2 s
FLAG_NAMES = ((re.I, "I"), (re.M, "M"), (re.S, "S"))


def load_restricted(path):
    mod = types.ModuleType("restricted_fork")
    with open(path, encoding="utf8") as f:
        src = f.read()
    exec(compile(src, path, "exec"), mod.__dict__)
    return mod


def flag_str(flags):
    return "|".join(n for f, n in FLAG_NAMES if flags & f) or "0"


def step_rate(rp, reps):
    """Steps per second of the dialect's interpreter on this core: CPU-bound cells through run_cell, steps from
    _restricted.steps() (the steps the last finished run used)."""
    import _restricted
    _restricted.allow_call(range, False, rp._range_cost)
    cells = {
        "for_add": "x = 0\nfor i in range(1000000):\n    x = x + i\nreturn x",
        "branch": "x = 0\nfor i in range(1000000):\n    if i > 500000:\n        x = x + 1\n    else:\n        x = x - 1\nreturn x",
        "def_call": "def f(a):\n    return a + 1\nx = 0\nfor i in range(300000):\n    x = f(x)\nreturn x",
        "list_append": "xs = []\nfor i in range(500000):\n    xs.append(i)\nreturn len(xs)",
    }
    out = {}
    try:
        _restricted.allow_kind(list, ["append", "[]", "[]="])
        _restricted.allow_call(len, False)
    except Exception as e:
        out["setup_note"] = repr(e)[:120]
    for name, src in cells.items():
        rates, steps = [], None
        try:
            rp.run_cell(src, {}, budget=50_000_000)           # warm
            for _ in range(reps):
                t = time.perf_counter()
                rp.run_cell(src, {}, budget=50_000_000)
                dt = time.perf_counter() - t
                steps = _restricted.steps()
                rates.append(steps / dt)
            out[name] = {"steps": steps, "rates": rates}
        except Exception as e:
            out[name] = {"error": repr(e)[:200]}
    allrates = [r for v in out.values() if isinstance(v, dict) and "rates" in v for r in v["rates"]]
    out["median_steps_per_s"] = statistics.median(allrates) if allrates else None
    out["default_budget"] = _restricted.DEFAULT_BUDGET
    _restricted.reset()
    return out


def run(restricted_path, step_reps=5):
    import pyodide_js
    rp = load_restricted(restricted_path)
    t_start = time.time()
    meta = {"pyodide": pyodide_js.version, "python": sys.version, "platform": sys.platform,
            "restricted_py": restricted_path, "REGEX_UNITS_PER_STEP": rp.REGEX_UNITS_PER_STEP,
            "COUNTED_LOOP_WEIGHT": rp._COUNTED_LOOP_WEIGHT, "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    rate = step_rate(rp, step_reps)
    rows = []
    timed = []                         # (row, bound method, input) of each timed row, for the retime pass
    A = lambda n, c="a": c * n

    def time_it(fn, inp):
        fn(inp[:50])
        times = []
        for _ in range(3):
            t = time.perf_counter()
            fn(inp)
            times.append((time.perf_counter() - t) * 1e3)
            if times[0] > 500:
                break
        times.sort()
        return times[len(times) // 2], times[0]

    def measure(group, src, flags, inp, how, keep=lambda ms: True):
        base = {"group": group, "pattern": src, "flags": flag_str(flags), "method": how, "n": len(inp), "input": repr(inp[:14])}
        try:
            units = rp.regex_work(src, flags, inp)
            if units == math.inf:
                rows.append({**base, "ms": None, "units": None, "ns_per_unit": None, "steps": None, "note": "unbounded (inf)"})
                return
            if group == "fuzz" and units * PROVISIONAL_NS_PER_UNIT > 2e9:
                return
            p = re.compile(src, flags)
            fn = p.search if how == "search" else p.findall
            ms, ms_min = time_it(fn, inp)
            if not keep(ms):
                return
            rows.append({**base, "ms": ms, "ms_min": ms_min, "units": units, "ns_per_unit": ms * 1e6 / units,
                         "steps": -(-units // rp.REGEX_UNITS_PER_STEP)})
            if how == "findall" and ms < 1000:
                rows[-1]["results"] = len(fn(inp))        # findall builds one object per match; the bound does not price that
            timed.append((rows[-1], fn, inp))
        except Exception as e:
            rows.append({**base, "ms": None, "units": None, "ns_per_unit": None, "steps": None, "note": repr(e)[:120]})

    # --- worst: the shapes (eighteen: the JS-only \p{L} and variable-width lookbehind rows are dropped, see the module doc) ---
    I, M = re.I, re.M
    worst = [
        ("a+b", 0, A(30000), "search"), ("a*a*b", 0, A(1500), "search"), (".*b.*c", 0, A(1500, "b"), "search"),
        ("a?" * 18 + "a" * 18, 0, A(17), "search"), ("a{1,5000}b", 0, A(30000), "search"), ("(?=a+b)", 0, A(30000), "search"),
        ("(a*)\\1b", 0, A(1500), "search"), ("(?:a+b|a+c)", 0, A(20000), "search"), ("A+b", I, A(30000), "search"),
        ("\\s*x", 0, A(30000, " "), "findall"), ("a+b", 0, A(30000), "findall"),
        ("^.*b.*c$", M, (A(300, "b") + "\n") * 50, "findall"), ("\\w+@", 0, "word " * 200000, "search"),
        ("[a-z]+\\d", 0, A(30000), "search"),
        ("\\b\\w+\\s+\\w+\\s+x", 0, "aa " * 20000, "search"), ("(?:ab)+c", 0, "ab" * 15000, "search"),
        ("a+" + "a" * 200 + "x", 0, A(5000), "search"), ('[^"]*"[^"]*x', 0, A(1500), "search"),
    ]
    for s, f, i, h in worst:
        measure("worst", s, f, i, h)

    # --- counted: counted repeats at up to 2M characters (findall) ---
    counted = [
        ("\\w{0,50}b", 0, A(2_000_000)), ("(?:\\d{0,50}|[ab]{3})?\\s*b+", 0, "1" * 2_000_000),
        ("\\s{0,50}\\w+?(a)?", M, " " * 2_000_000), ("a{1,5000}b", 0, A(60000)), ("a{0,500}a{0,500}b", 0, A(20000)),
        ("[ab]{2,300}c", I, "ab" * 500000),
    ]
    for s, f, i in counted:
        measure("counted", s, f, i, "findall")

    # --- ordinary: what a real survey runs (findall) ---
    log = "\n".join(f"2026-10-22T10:{k % 60:02d} INFO worker {k} handled request /api/v1/items/{k} in {k % 97}ms status=200 {'x' * (k % 120)}" for k in range(10000))
    prose = "The quick brown fox jumps over the lazy dog, 42 times; e-mail me at a.b@c.de. " * 13000
    quoted = '["' + '","'.join(log.split("\n")) + '"]'
    ordinary = [
        ("^.*error.*$", M, log), ("error.*$", M, log), ("\\w+@\\w+\\.\\w+", 0, prose), ("\\d+", 0, prose), ("\\s*,\\s*", 0, prose),
        ("(\\w+)\\s+\\1", 0, prose[:50000]), ("status=(\\d+)", 0, log), ("[A-Z][a-z]+", 0, prose), ("^\\s+|\\s+$", 0, prose),
        ('"([^"]*)"', 0, quoted),
    ]
    for s, f, i in ordinary:
        measure("ordinary", s, f, i, "findall")

    # --- fuzz: seeded random patterns passing both shape checks, six adversarial inputs (findall) ---
    atoms = ["a", "b", ".", "\\w", "\\s", "[ab]", "[^b]", "\\d", "(?:ab)", "(a)", "\\b", "(?=a)", "(?!b)", "\\1"]
    quants = ["", "", "*", "+", "?", "{2,}", "{0,50}", "{3}", "*?", "+?"]
    for seed_start in (1, 2, 3):
        seed = seed_start

        def rnd():
            nonlocal seed
            seed = (seed * 1103515245 + 12345) % 2147483648
            return seed / 2147483648

        pick = lambda a: a[int(rnd() * len(a))]

        def gen(d=0):
            s = ""
            for _ in range(1 + int(rnd() * 4)):
                s += (f"(?:{gen(d + 1)}|{gen(d + 1)})" if d < 1 and rnd() < 0.15 else pick(atoms)) + pick(quants)
            return s

        n = 3000
        inputs = [A(n), "ab" * (n // 2), A(n, " "), A(n - 1) + "c", (A(50) + " ") * (n // 51), A(n, "1")]
        for _ in range(400):
            src = gen()
            flags = pick([0, I, M, 0, re.S])
            try:
                re.compile(src, flags)
            except re.error:
                continue
            if rp.risky_regex(src) is not None or rp.risky_parse(src, flags) is not None:
                continue
            for inp in inputs:
                measure("fuzz", src, flags, inp, "findall", lambda ms: ms >= 1)

    # --- retime: the 15 slowest-per-unit rows that ran under 100 ms, 21 runs each, MIN kept (a stall only ever adds) ---
    for row, fn, inp in sorted((t for t in timed if t[0]["ms"] < 100), key=lambda t: -t[0]["ns_per_unit"])[:15]:
        best = math.inf
        for _ in range(21):
            t = time.perf_counter()
            fn(inp)
            best = min(best, (time.perf_counter() - t) * 1e3)
        row["ms_retimed_min"] = best

    meta["seconds"] = round(time.time() - t_start)
    return {"meta": meta, "step_rate": rate, "rows": rows}
