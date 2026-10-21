"""shapes.py — the four shapes fork #9's verify-on-return is measured on, shared by the native and the wasm32 bench.

trivial      run_cell("return 1"): the entry cost (the control the fix should not move).
unlifted_c   200k len() calls from a cell loop: an unlifted C callable, checked on each return.
lifted_leaf  200k calls of a lifted host leaf (a Python function registered allow_call(f, True)), checked on return.
py_func      200k calls of the cell's own def: not checked (the control for the call path).
"""
import time

N = 200_000
SHAPES = {
    "trivial": ("return 1", 1),
    "unlifted_c": (f"s = 0\nt = (1, 2)\nfor i in range({N}):\n    s += len(t)\nreturn s", N),
    "lifted_leaf": (f"s = 0\nfor i in range({N}):\n    s += leaf(1)\nreturn s", N),
    "py_func": (f"def g(x):\n    return x\ns = 0\nfor i in range({N}):\n    s += g(1)\nreturn s", N),
}


def leaf(x):
    return x


def measure(reps):
    """{shape: [ns per call, one per rep]}; a trivial run is repeated 200x as often, being 200k times shorter."""
    import _restricted, restricted
    for f in (len, list, range, sum):
        _restricted.allow_call(f, False, restricted._range_cost if f is range else None)
    _restricted.allow_call(leaf, True)
    out = {}
    for name, (src, calls) in SHAPES.items():
        ns = []
        for _ in range(reps * (200 if calls == 1 else 1)):
            t = time.perf_counter()
            restricted.run_cell(src, {"leaf": leaf})
            ns.append((time.perf_counter() - t) / calls * 1e9)
        out[name] = ns
    return out
