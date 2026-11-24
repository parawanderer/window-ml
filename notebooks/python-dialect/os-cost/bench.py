"""bench.py — times directory listings and file reads against the interpreter's step, inside Pyodide, for os-cost.ipynb.

Run through one.mjs (`node one.mjs > out.json`); `run()` returns ONE dict { meta, step_rate, listing, reads }. Pyodide's own
`restricted` module (the fork core's) is used as is: `run_cell` and `_restricted.steps()` give the step rate; the
listing and read timings run OUTSIDE the gate, in plain Python on MEMFS, since the gate only charges a step count and
the question is how much wall time one charged unit must be worth.
"""

import glob
import os
import statistics
import time
from pathlib import Path

LIST_SIZES = (1, 10, 100, 1000, 10000)           # plus the empty directory, N = 0, always timed
READ_SIZES = (0, 16, 256, 1 << 10, 64 << 10, 1 << 20, 8 << 20)


def step_rate(reps):
    """ns per step: CPU-bound cells through restricted.run_cell, wall time over _restricted.steps() of the run."""
    import _restricted
    import restricted
    _restricted.allow_call(range, False, restricted._range_cost)
    cells = {
        "pass_loop": "for i in range(1000):\n    for j in range(3000):\n        pass\nreturn 1",
        "if_pass": "for i in range(1000):\n    for j in range(3000):\n        if j < 0:\n            pass\nreturn 1",
        "for_add": "x = 0\nfor i in range(1000000):\n    x = x + i\nreturn x",
        "branch": "x = 0\nfor i in range(1000000):\n    if i > 500000:\n        x = x + 1\n    else:\n        x = x - 1\nreturn x",
        "def_call": "def f(a):\n    return a + 1\nx = 0\nfor i in range(300000):\n    x = f(x)\nreturn x",
    }
    out = {}
    for name, src in cells.items():
        ns, steps = [], None
        restricted.run_cell(src, {}, budget=50_000_000)  # warm
        for _ in range(reps):
            t = time.perf_counter()
            restricted.run_cell(src, {}, budget=50_000_000)
            dt = time.perf_counter() - t
            steps = _restricted.steps()
            ns.append(dt * 1e9 / steps)
        out[name] = {"steps": steps, "ns_per_step": ns}
    out["default_budget"] = _restricted.DEFAULT_BUDGET
    _restricted.reset()
    return out


def _best(fn, reps):
    """Median over reps of one call's wall ns."""
    ts = []
    for _ in range(reps):
        t = time.perf_counter_ns()
        fn()
        ts.append(time.perf_counter_ns() - t)
    return statistics.median(ts), min(ts), max(ts)


def listing(reps_for):
    calls = {
        "os.listdir": lambda d: os.listdir(d),
        "os.scandir": lambda d: [e.name for e in os.scandir(d)],
        "glob.glob": lambda d: glob.glob(d + "/*"),
        "os.walk": lambda d: list(os.walk(d)),
        "Path.iterdir": lambda d: list(Path(d).iterdir()),
    }
    rows = []
    sizes = (0,) + LIST_SIZES
    for n in sizes:
        d = f"/lst{n}"
        os.makedirs(d, exist_ok=True)
        for i in range(n):
            open(f"{d}/f{i:06d}", "w").close()
    for name, fn in calls.items():
        base = None
        for n in sizes:
            d = f"/lst{n}"
            reps = reps_for(n)
            fn(d)  # warm
            med, lo, hi = _best(lambda: fn(d), reps)
            if n == 0:
                base = (med, lo)
            rows.append({"call": name, "n": n, "reps": reps, "ns_median": med, "ns_min": lo, "ns_max": hi,
                         "base_ns_median": base[0], "ns_per_entry": (med - base[0]) / n if n else None,
                         "ns_per_entry_min": (lo - base[1]) / n if n else None})
    return rows


def reads(reps_for):
    rows = []
    for size in READ_SIZES:
        p = f"/rd{size}"
        with open(p, "wb") as f:
            f.write(b"a" * size)
        for name, fn in (("Path.read_bytes", lambda: Path(p).read_bytes()), ("Path.read_text", lambda: Path(p).read_text())):
            fn()
            reps = reps_for(size)
            med, lo, hi = _best(fn, reps)
            rows.append({"call": name, "size": size, "reps": reps, "ns_median": med, "ns_min": lo, "ns_max": hi,
                         "ns_per_byte": med / size if size else None, "ns_per_byte_min": lo / size if size else None})
    return rows


def run(step_reps=9):
    import platform
    import sys
    t0 = time.time()
    out = {"meta": {"python": sys.version, "platform": sys.platform}}
    out["step_rate"] = step_rate(step_reps)
    out["listing"] = listing(lambda n: max(15, min(2000, 200000 // max(n, 1))))
    out["reads"] = reads(lambda s: max(9, min(2000, max(1 << 20, 64 << 20 if s > 1 << 20 else 1 << 20) // max(s, 1024))))
    out["meta"]["seconds"] = round(time.time() - t0, 1)
    return out
