// python-dialect-freeze.test.mjs — an inside cell runs with every older numpy array read-only, and its undo copies are bounded.
//
// The ownership check sees only the interpreter's own stores (b[0] = 1, b += 1, a listed mutator), never a C callee
// writing into an array it was handed: `np.sum(m, axis=0, out=b)` and `a.round(**{"out": b})` wrote an injected array
// unasked. `_ml_freeze` sets every writeable array the namespace reaches read-only before the cell and `_ml_thaw` puts
// each flag back after it, however the cell ends; an array the cell owns is thawed by its undo copy on its first logged
// write. numpy's data allocator is outside the memory cap's count, so the undo copies (`_ml_snapshots`) are totalled in
// bytes against the cap, and a write whose copy would pass it is refused before the copy. Self-SKIPS without the fork
// core in dist/pyodide, as python-dialect-inside.test.mjs does.
import { test } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { wrapUserSetup, wrapUserScript } from "../src/python/python-runtime.ts";
import { dialectSetup } from "../src/python/python-dialect-run.js";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));

let py = null;
let skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

// Loaded before any test is defined, so no row's time includes the boot (a file-level before() is charged to the first).
await (async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    if (py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`)) { skip = "dist/pyodide is the stock core, not the restricted-mode fork"; return; }
    await py.loadPackage(["numpy", "pandas", "pillow"]);
    assert.strictEqual(String(await py.runPythonAsync(dialectSetup(FILES))), "");
})();

/** A run's namespace, kept across its cells as the worker keeps it, holding `b` (an ndarray) the cells did NOT make. */
function namespace() {
    const ns = py.globals.get("dict")();
    py.runPython(`import numpy as np, pandas as pd\nb = np.array([9., 9.])`, { globals: ns });
    return ns;
}

/** One cell in `ns`, inside the dialect or (`full`) on the full path: refused, an error, or its value, and then `show`
 *  evaluated in `ns` outside any cell. */
async function cell(ns, code, { full = false, show = "None" } = {}) {
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
    await py.runPythonAsync(wrapUserScript(code, "run", full ? null : { nodes: NODES }), { globals: ns });
    const after = String(py.runPython(`repr(${show})`, { globals: ns }));
    const refused = full ? null : ns.get("_ml_not_in_dialect");
    if (refused) return { refused: String(refused), after };
    const err = ns.get("_err");
    if (err) return { error: String(err), after };
    return { value: String(ns.get("_json_result")), after };
}

const RO = /ValueError: output array is read-only/;
const M = `np.array([[1., 2.], [3., 4.]])`;
/** An OWNED array of `mib` MiB: np.array is a fresh leaf (a product or a slice is not), and a range over 1,000,000 is refused. */
const big = (name, mib) => `import numpy as np\n${name} = np.array(np.array(range(1024), dtype="f8") * np.array([[1.]] * (${mib} * 128)))`;

// --- an array the cell did not make: every C write errors with numpy's own text, and its flag comes back ---

const UNOWNED_ROWS = [
    ["np.sum(out=b)", `import numpy as np\nnp.sum(${M}, axis=0, out=b)`],
    ["np.mean(out=b)", `import numpy as np\nnp.mean(${M}, axis=0, out=b)`],
    ["np.abs(x, b), out positional", `import numpy as np\nnp.abs(np.array([-1., -2.]), b)`],
    ["np.abs(out=(b,)), a ufunc's tuple", `import numpy as np\nnp.abs(np.array([-1., -2.]), out=(b,))`],
    ["a.round(out=b)", `import numpy as np\nnp.array([1.4, 2.6]).round(out=b)`],
    ["a.round(**{\"out\": b}), the spread form no checker sees", `import numpy as np\nnp.array([1.4, 2.6]).round(**{"out": b})`],
    ["a.round(*[0, b])", `import numpy as np\nnp.array([1.4, 2.6]).round(*[0, b])`],
];

for (const [label, code] of UNOWNED_ROWS) {
    test(`an array the cell did not make is read-only to a C write: ${label}`, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        const ns = namespace();
        const r = await cell(ns, code, { show: "(b.tolist(), b.flags.writeable)" });
        assert.match(r.error ?? "", RO, JSON.stringify(r));
        assert.strictEqual(r.after, "([9.0, 9.0], True)");
    });
}

test("a full cell right after an inside cell writes the array as before", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = namespace();
    assert.match((await cell(ns, `import numpy as np\nnp.sum(${M}, axis=0, out=b)`)).error ?? "", RO);
    const r = await cell(ns, `b[0] = 1`, { full: true, show: "(b.tolist(), b.flags.writeable)" });
    assert.strictEqual(r.after, "([1.0, 9.0], True)", JSON.stringify(r));
});

test("an array reachable several times is frozen and restored once, to writeable", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = namespace();
    await cell(ns, `L = [b, b, {"k": b}, (b,)]`, { full: true });
    const r = await cell(ns, `import numpy as np\nnp.abs(np.array([-1., -2.]), out=L[2]["k"])`, { show: "(b.tolist(), b.flags.writeable)" });
    assert.match(r.error ?? "", RO, JSON.stringify(r));
    assert.strictEqual(r.after, "([9.0, 9.0], True)");
});

test("an array read-only before the cell stays read-only after it", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = namespace();
    await cell(ns, `r = np.array([1., 2.]); r.flags.writeable = False`, { full: true });
    const r = await cell(ns, `import numpy as np\nnp.abs(np.array([-3., -4.]), out=r)`, { show: "(r.tolist(), r.flags.writeable, b.flags.writeable)" });
    assert.match(r.error ?? "", RO, JSON.stringify(r));
    assert.strictEqual(r.after, "([1.0, 2.0], False, True)");
});

test("a writeable view of a frozen base, held elsewhere: both frozen, both restored", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = namespace();
    await cell(ns, `base = np.zeros(4); v = base[1:3]; held = {"v": v}`, { full: true });
    const r = await cell(ns, `import numpy as np\nnp.abs(np.array([-3., -4.]), out=held["v"])`,
        { show: "(base.tolist(), v.flags.writeable, base.flags.writeable)" });
    assert.match(r.error ?? "", RO, JSON.stringify(r));
    assert.strictEqual(r.after, "([0.0, 0.0, 0.0, 0.0], True, True)");
    const w = await cell(ns, `v[0] = 1`, { full: true, show: "base.tolist()" });
    assert.strictEqual(w.after, "[0.0, 1.0, 0.0, 0.0]", JSON.stringify(w));
});

test("a writeable view over a base read-only by other means: the cell asks, since the view could not be thawed again", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = namespace();
    await cell(ns, `base = np.zeros(4); v = base[1:3]; base.flags.writeable = False`, { full: true });
    const r = await cell(ns, `1`, { show: "(v.flags.writeable, b.flags.writeable)" });
    assert.match(r.refused ?? "", /a writeable view of a read-only array/, JSON.stringify(r));
    assert.strictEqual(r.after, "(True, True)");
});

test("a view the cell makes of a frozen array is read-only, and stays so after the cell", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    // numpy gives a view of a read-only base a read-only flag, and cannot tell that from a view read-only by design
    // (np.broadcast_to), so it is not thawed: a later full cell writing it errors, where before this change it wrote b.
    const ns = namespace();
    assert.strictEqual((await cell(ns, `w = b[:]`)).value, "null");
    const r = await cell(ns, `w[0] = 1`, { full: true, show: "(b.tolist(), w.flags.writeable, b.flags.writeable)" });
    assert.match(r.error ?? "", /assignment destination is read-only/, JSON.stringify(r));
    assert.strictEqual(r.after, "([9.0, 9.0], False, True)");
    const c = await cell(ns, `w = w.copy()\nw[0] = 1`, { full: true, show: "(w.tolist(), b.tolist())" });
    assert.strictEqual(c.after, "([1.0, 9.0], [9.0, 9.0])", JSON.stringify(c));
});

// --- however the cell ends, every flag comes back ---

const ENDINGS = [
    ["an error in the cell's own logic", `import numpy as np\nnp.abs(np.array([-1., -2.]), out=b)`, "error"],
    ["a ZeroDivisionError", `1 / 0`, "error"],
    ["a refusal at check time", `class C:\n    pass`, "refused"],
    ["a refusal at run time", `import numpy as np\nnp.array([1.]).sort()`, "refused"],
    ["the step budget", `n = 0\nwhile True:\n    n += 1`, "refused"],
];

for (const [label, code, how] of ENDINGS) {
    test(`flags are restored after ${label}`, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        const ns = namespace();
        await cell(ns, `held = [np.array([1., 2.]), {"x": np.array([3.])}]`, { full: true });
        const r = await cell(ns, code, { show: `(b.flags.writeable, held[0].flags.writeable, held[1]["x"].flags.writeable)` });
        assert.ok(r[how], JSON.stringify(r));
        assert.strictEqual(r.after, "(True, True, True)");
    });
}

test("flags are restored after a Stop (the interrupt buffer), and the next inside cell freezes again", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    // A wall-clock kill terminates the worker (offscreen.ts, killWorker): its namespace dies with it, and a new worker
    // gets fresh copies of what the harness passes. A Stop interrupts in place, so the same namespace runs on.
    const ns = namespace();
    const flag = new Int32Array(new SharedArrayBuffer(4));
    py.setInterruptBuffer(flag);
    // The Stop lands mid-cell: a thread writes it while the cell's loop runs (this thread is busy in Python until then).
    const stopper = new Worker(`const { workerData: f } = require("node:worker_threads"); Atomics.wait(f, 0, 0, 300); Atomics.store(f, 0, 2);`,
        { eval: true, workerData: flag });
    try {
        const r = await cell(ns, `n = 0\nfor i in range(1000000):\n    for j in range(1000000):\n        n += 1`, { show: "b.flags.writeable" });
        assert.match(r.error ?? "", /KeyboardInterrupt/, JSON.stringify(r));
        assert.strictEqual(r.after, "True");
    } finally {
        await stopper.terminate();
        Atomics.store(flag, 0, 0);
        py.setInterruptBuffer(undefined);
    }
    const again = await cell(ns, `import numpy as np\nnp.abs(np.array([-1., -2.]), out=b)`, { show: "(b.tolist(), b.flags.writeable)" });
    assert.match(again.error ?? "", RO, JSON.stringify(again));
    assert.strictEqual(again.after, "([9.0, 9.0], True)");
});

// --- an array the cell owns: a logged write thaws it, and the undo log restores it ---

test("an owned older array: a[0] = 5 runs, and a C write with no logged write first errors", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = namespace();
    await cell(ns, `import numpy as np\na = np.array([1., 2.])`);
    const w = await cell(ns, `a[0] = 5`, { show: "(a.tolist(), a.flags.writeable)" });
    assert.strictEqual(w.after, "([5.0, 2.0], True)", JSON.stringify(w));
    const c = await cell(ns, `import numpy as np\nnp.abs(np.array([-3., -4.]), out=a)`, { show: "(a.tolist(), a.flags.writeable)" });
    assert.match(c.error ?? "", RO, JSON.stringify(c));
    assert.strictEqual(c.after, "([5.0, 2.0], True)");
    const i = await cell(ns, `a += 1`, { show: "(a.tolist(), a.flags.writeable)" });
    assert.strictEqual(i.after, "([6.0, 3.0], True)", JSON.stringify(i));
});

test("an owned older array: a[0] = 7 and then a refusal rolls it back, flag restored", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = namespace();
    await cell(ns, `import numpy as np\na = np.array([1., 2.])`);
    const r = await cell(ns, `a[0] = 7\nimport numpy as np\nnp.array([1.]).sort()`, { show: "(a.tolist(), a.flags.writeable)" });
    assert.match(r.refused ?? "", /attribute 'sort'/, JSON.stringify(r));
    assert.strictEqual(r.after, "([1.0, 2.0], True)");
});

test("a view of an owned older array is not the cell's own: its write is refused, the base untouched", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    // A slice (or a product) is not a fresh leaf, so the dialect makes no owned view of an owned array; the undo copy's
    // handling of one (its frozen base logged first, and refused unless owned) has no route to it today.
    const ns = namespace();
    await cell(ns, `import numpy as np\nx = np.array([0., 1., 2., 3.])\nz = x[1:3]`);
    const r = await cell(ns, `z[0] = 9`, { show: "(x.tolist(), x.flags.writeable, z.flags.writeable)" });
    assert.match(r.refused ?? "", /item assignment to a value the cell does not own/, JSON.stringify(r));
    assert.strictEqual(r.after, "([0.0, 1.0, 2.0, 3.0], True, True)");
});

// --- the undo copies are bounded by the cell's memory cap (256 MiB), refused before the copy is made ---

test("an undo copy just under the cap runs; just over it, the write is refused, the array untouched and writeable", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = namespace();
    await cell(ns, big("big", 255));
    const under = await cell(ns, `big[0, 0] = 1`, { show: "(float(big[0, 0]), big.flags.writeable)" });
    assert.strictEqual(under.after, "(1.0, True)", JSON.stringify(under));
    await cell(ns, `del big`, { full: true });
    await cell(ns, big("big", 257));
    for (const code of [`big[0, 0] = 1`, `big += 1`]) {
        const over = await cell(ns, code, { show: "(float(big[0, 0]), big.flags.writeable)" });
        assert.strictEqual(over.refused, "not in dialect: a write whose undo copy (257 MiB) would exceed the read-only cell's memory limit (256 MiB) (line 1)", JSON.stringify(over));
        assert.strictEqual(over.after, "(0.0, True)");
    }
    await cell(ns, `del big`, { full: true });
});

test("two undo copies that cross the cap together: the second is refused and the first rolls back", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = namespace();
    await cell(ns, big("p", 150));
    await cell(ns, big("q", 150));
    const r = await cell(ns, `p[0, 0] = 1\nq[0, 0] = 1`, { show: "(float(p[0, 0]), float(q[0, 0]), p.flags.writeable, q.flags.writeable)" });
    assert.strictEqual(r.refused, "not in dialect: a write whose undo copy (150 MiB, 300 MiB with the cell's earlier ones) would exceed the read-only cell's memory limit (256 MiB) (line 2)", JSON.stringify(r));
    assert.strictEqual(r.after, "(0.0, 0.0, True, True)");
    const one = await cell(ns, `p[0, 0] = 1`, { show: "float(p[0, 0])" });
    assert.strictEqual(one.after, "1.0", JSON.stringify(one));
    await cell(ns, `del p, q`, { full: true });
});

test("a frame's undo copy is counted too (its values and index): over the cap, refused", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = namespace();
    await cell(ns, `import numpy as np, pandas as pd\nfr = pd.DataFrame(np.array(range(1024), dtype="f8") * np.array([[1.]] * (257 * 128)))`);
    const r = await cell(ns, `fr[0] = 1`, { show: "float(fr[0][0])" });
    assert.match(r.refused ?? "", /^not in dialect: a write whose undo copy \(257\.0 MiB\) would exceed the read-only cell's memory limit \(256 MiB\)/, JSON.stringify(r));
    assert.strictEqual(r.after, "0.0");
    await cell(ns, `del fr`, { full: true });
    await cell(ns, `import pandas as pd\nfs = pd.DataFrame({"c": [1., 2.]})`);
    assert.strictEqual((await cell(ns, `fs["c"] = 5`, { show: `fs["c"].tolist()` })).after, "[5, 5]");
});

test("a view of a large array the cell does not own: no copy is taken, the view is read-only to a C write", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = namespace();
    await cell(ns, `bigu = np.zeros((257 * 128, 1024)); bu = bigu[:1]`, { full: true });
    const r = await cell(ns, `import numpy as np\nnp.abs(np.array([[-1.] * 1024]), out=bu)`,
        { show: "(float(bigu[0, 0]), bigu.flags.writeable, bu.flags.writeable)" });
    assert.match(r.error ?? "", RO, JSON.stringify(r));
    assert.strictEqual(r.after, "(0.0, True, True)");
    await cell(ns, `del bigu, bu`, { full: true });
});

test("an object array's undo copy is shallow: the elements are shared, so nbytes (a pointer each, 4 bytes in wasm32) is what it allocates", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = namespace();
    await cell(ns, `import numpy as np\noa = np.array([[1], [2, 3]], dtype=object)`);
    const r = await cell(ns, `oa[0] = 5\nimport numpy as np\nnp.array([1.]).sort()`, { show: "(oa.tolist(), oa.nbytes, oa.itemsize)" });
    assert.ok(r.refused, JSON.stringify(r));
    assert.strictEqual(r.after, "([[1], [2, 3]], 8, 4)");
    const shared = await cell(ns, `c = oa.copy()\nshared = c[0] is oa[0]`, { full: true, show: "shared" });
    assert.strictEqual(shared.after, "True");
});

// --- what the freeze walk does not enter, each with how it stays unwritten ---

const RESIDUALS = [
    ["an attribute of a plain object", `class O:\n    pass\no = O(); o.arr = np.zeros(2)`, `out=o.arr`, "o.arr.tolist()", /not in dialect: attribute 'arr' of O/],
    ["a function's default, read directly", `def f(a=np.zeros(2)):\n    return a`, `out=f.__defaults__[0]`, "f().tolist()", /not in dialect: the attribute __defaults__/],
    ["a function's default, returned by calling it (the walk enters defaults)", `def f(a=np.zeros(2)):\n    return a`, `out=f()`, "f().tolist()", RO],
    ["a closed-over array, returned by calling it (the walk enters closures)", `def g(c=None):\n    c = np.zeros(2)\n    def h():\n        return c\n    return h\nh = g()`, `out=h()`, "h().tolist()", RO],
    ["an imported module's global", `np.held = np.zeros(2)`, `out=np.held`, "np.held.tolist()", /not in dialect: attribute 'held' of module/],
    ["an element of a pandas object column (the walk enters it)", `dfo = pd.DataFrame({"c": [np.zeros(2), 1]})`, `out=dfo["c"][0]`, `dfo["c"][0].tolist()`, RO],
    ["a pandas block, through .values", `s = pd.Series([0., 0.])`, `out=s.values`, "s.tolist()", /not in dialect: attribute '_mgr' of Series/],
    ["a pandas block, through to_numpy() (read-only under copy on write)", `s = pd.Series([0., 0.])`, `out=s.to_numpy()`, "s.tolist()", RO],
];

for (const [label, setup, out, show, want] of RESIDUALS) {
    test(`not walked or walked, never written: ${label}`, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        const ns = namespace();
        await cell(ns, setup, { full: true });
        const r = await cell(ns, `import numpy as np\nnp.abs(np.array([-3., -4.]), ${out})`, { show });
        assert.match(r.refused ?? r.error ?? "", want, JSON.stringify(r));
        assert.strictEqual(r.after, "[0.0, 0.0]");
    });
}

test("a namespace past the walk's cap: the cell asks, and nothing is left frozen", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = namespace();
    await cell(ns, `wide = [[0] * 1000 for _ in range(2001)]`, { full: true });
    const r = await cell(ns, `1`, { show: "b.flags.writeable" });
    assert.match(r.refused ?? "", /too large to set its arrays read-only/, JSON.stringify(r));
    assert.strictEqual(r.after, "True");
    await cell(ns, `del wide`, { full: true });
});
