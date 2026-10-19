// python-matplotlib.test.mjs — matplotlib in the python_exec sandbox: a figure a cell leaves open, or returns, comes back
// as an image; every figure is closed after the cell; and `verify: true` hands the image to the model (or a reader).
//
// The sandbox tests run the REAL readonly path: Pyodide in its own realm (python-principal-worker.mjs), the start-up
// packages and their `prepare`, then `lockdownReadonly`, then the wrapper — the worker's own order. They self-skip
// without `dist/pyodide/` or without the matplotlib wheel (`npm run fetch-pyodide`). The tool tests need neither.
import { test, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { Worker } from "node:worker_threads";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const hasMpl = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs")) && fs.readdirSync(PYODIDE_DIR).some((f) => f.startsWith("matplotlib-"));
const skip = hasMpl ? false : "no matplotlib wheel in dist/pyodide — run `npm run fetch-pyodide` and build to enable";

/** One locked-down interpreter, booted on first use, with the start-up packages the worker loads. */
let runner = null;
let worker = null;
async function sandbox() {
    if (runner) return runner;
    const { PY_PACKAGE_LOADS, PY_STARTUP_PREPARE } = await import("../src/python/python-env.ts");
    worker = new Worker(new URL("./python-principal-worker.mjs", import.meta.url), {
        workerData: {
            pyodideDir: PYODIDE_DIR,
            lockdownUrl: new URL("../src/python/lockdown.ts", import.meta.url).href,
            runtimeUrl: new URL("../src/python/python-runtime.ts", import.meta.url).href,
            packages: PY_PACKAGE_LOADS,
            prepare: PY_STARTUP_PREPARE,
        },
    });
    let n = 0;
    runner = await new Promise((resolve, reject) => {
        worker.once("message", (m) => {
            if (!m?.ready) { reject(new Error(m?.error || "sandbox failed to boot")); return; }
            worker.unref();
            resolve({
                cell: (code) => new Promise((res) => {
                    const id = ++n;
                    const on = (msg) => { if (msg.id === id) { worker.off("message", on); res(msg.out); } };
                    worker.on("message", on);
                    worker.postMessage({ id, code });
                }),
            });
        });
        worker.once("error", reject);
    });
    return runner;
}
after(async () => { await worker?.terminate().catch(() => {}); });

const PNG = /^data:image\/png;base64,/;
/** A PNG data URL's width and height, from its IHDR chunk. */
const pngSize = (url) => {
    const b = Buffer.from(url.replace(PNG, ""), "base64");
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};
const T = { skip, timeout: 240000 };

// --- a figure the cell leaves open, or returns, comes back as an image ---

test("a cell that plots and returns nothing comes back as one PNG of its figure, hinted 'figure'", T, async () => {
    const { cell } = await sandbox();
    const r = await cell("import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([1, 2, 3], [3, 1, 2])\nax.set_title('t')");
    assert.equal(r.error, null, r.error);
    assert.match(String(r.value), PNG, "the open figure is drawn");
    assert.equal(r.render, "figure");
    const { w, h } = pngSize(r.value);
    assert.ok(w > 100 && h > 100, `a real chart, got ${w}x${h}`);
});

test("a returned Figure, and a returned Axes, each draw that figure, hinted 'img'", T, async () => {
    const { cell } = await sandbox();
    const fig = await cell("import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.bar(['a', 'b'], [1, 2])\nfig");
    assert.match(String(fig.value), PNG);
    assert.equal(fig.render, "img");
    const ax = await cell("import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([0, 1])\nreturn ax");
    assert.match(String(ax.value), PNG);
    assert.equal(ax.render, "img");
});

test("a trailing plt.plot(...) shows the figure rather than the repr of its Line2D list", T, async () => {
    const { cell } = await sandbox();
    const r = await cell("import matplotlib.pyplot as plt\nplt.plot([1, 4, 9])");
    assert.match(String(r.value), PNG, `got ${String(r.value).slice(0, 80)}`);
    assert.equal(r.render, "figure");
    // Control: a value that is NOT made of artists stays the value, though a figure is open.
    const kept = await cell("import matplotlib.pyplot as plt\nplt.plot([1, 2])\nreturn 42");
    assert.equal(kept.value, 42);
    assert.equal(kept.render, null);
});

test("two open figures come back as one image, stacked, taller than either", T, async () => {
    const { cell } = await sandbox();
    const one = await cell("import matplotlib.pyplot as plt\nplt.figure()\nplt.plot([1, 2])");
    const two = await cell("import matplotlib.pyplot as plt\nplt.figure()\nplt.plot([1, 2])\nplt.figure()\nplt.plot([2, 1])");
    assert.match(String(two.value), PNG);
    assert.ok(pngSize(two.value).h > pngSize(one.value).h * 1.5, `stacked: ${pngSize(two.value).h} vs ${pngSize(one.value).h}`);
});

test("plt.show() is quiet: no 'non-interactive' warning reaches stdout, and the figure still comes back", T, async () => {
    const { cell } = await sandbox();
    const r = await cell("import matplotlib.pyplot as plt\nplt.plot([1, 2])\nplt.show()");
    assert.doesNotMatch(r.stdout, /non-interactive|cannot be shown/i, r.stdout);
    assert.match(String(r.value), PNG);
});

test("a huge figsize is drawn at a lower dpi, not as gigapixels", T, async () => {
    const { cell } = await sandbox();
    const r = await cell("import matplotlib.pyplot as plt\nfig = plt.figure(figsize=(400, 300))\nplt.plot([1, 2])");
    assert.match(String(r.value), PNG);
    const { w, h } = pngSize(r.value);
    assert.ok(w * h <= 4.5e6, `capped near 4 megapixels, got ${w}x${h}`);
    assert.ok(w > h, "the proportions are kept");
});

// --- every figure is closed after the cell, so none reaches the next ---

test("figures are closed after each cell, a failing one included: the next cell starts with none", T, async () => {
    const { cell } = await sandbox();
    await cell("import matplotlib.pyplot as plt\nplt.plot([1, 2])");
    const after1 = await cell("import matplotlib.pyplot as plt\nplt.get_fignums()");
    assert.deepEqual(after1.value, [], "closed after a cell that drew");
    assert.equal(after1.render, null, "and a cell that plots nothing draws nothing");
    const failed = await cell("import matplotlib.pyplot as plt\nplt.plot([1, 2])\nraise ValueError('boom')");
    assert.match(failed.error, /boom/);
    assert.equal(failed.value, null, "a failed cell shows no figure");
    const after2 = await cell("import matplotlib.pyplot as plt\nplt.get_fignums()");
    assert.deepEqual(after2.value, [], "closed after a cell that failed");
});

test("a cell that never imports pyplot pays nothing: its result is untouched", T, async () => {
    const { cell } = await sandbox();
    const r = await cell("1 + 1");
    assert.equal(r.value, 2);
    assert.equal(r.render, null);
});

// --- matplotlib under the lockdown ---

test("after importing pyplot, no module matplotlib brought in holds the JavaScript bridge", T, async () => {
    const { cell } = await sandbox();
    // The strip itself is not re-tested here: this harness strips a stand-in scope, as the red-team suite does
    // (redteam-python-sandbox.test.mjs, "the strip"), so `import js` here is Node's unstripped global. What a new
    // package can ADD is a module that keeps a handle to the bridge, as pyarrow's timezone helper did; that is this scan.
    // Every module matplotlib and its dependencies brought in, and every value on it: none may be the `js` module or a
    // JsProxy, which would hand a readonly cell the global scope the strip removed (the check python-sandbox.md asks of a new package).
    const r = await cell(`import matplotlib, matplotlib.pyplot as plt, sys
fig, ax = plt.subplots(); ax.plot([1, 2]); fig.savefig(__import__('io').BytesIO(), format='png')
bad = []
ours = ('matplotlib', 'mpl_toolkits', 'fontTools', 'kiwisolver', 'contourpy', 'cycler', 'pyparsing', 'packaging')
for name, mod in list(sys.modules.items()):
    if mod is None or not name.startswith(ours): continue
    for k, v in list(getattr(mod, '__dict__', {}).items()):
        if isinstance(v, type): continue   # a class is not a handle to anything
        t = type(v)
        if (getattr(v, '__name__', None) == 'js' and t.__name__ == 'module') or t.__name__.startswith('Js') or str(getattr(t, '__module__', '')).startswith('pyodide.ffi'):
            bad.append(name + '.' + k)
{'bad': bad[:10], 'backend': matplotlib.get_backend(), 'mods': sum(1 for n in sys.modules if n.startswith('matplotlib'))}`);
    assert.equal(r.error, null, r.error);
    assert.ok(r.value.mods > 10, "positive control: matplotlib's modules are loaded and were scanned");
    assert.deepEqual(r.value.bad, [], "no module attribute is the js bridge");
    assert.equal(r.value.backend.toLowerCase(), "agg", "the headless backend the prepare chose");
});

// --- verify: true hands the image to the model, or to a reader ---

const IMG = "data:image/png;base64,iVBORw0KGgo=";
/** python_exec over a fake `ml` whose sandbox returns `out`; `asked` records every reader call. */
async function pyTool(out, asked = []) {
    const { buildPythonTool } = await import("../src/python/python-tool.ts");
    const { defineTool } = await import("../src/ml/ml-tool-factories.ts");
    return buildPythonTool({
        defineTool, _queryAll: () => [],
        pythonExec: async () => ({ ok: true, stdout: "", ...out }),
        chat: async (prompt, o) => { asked.push({ prompt, o }); return "A line chart of y against x, rising."; },
    });
}

test("an image result without verify carries no image for the model and asks no reader", async () => {
    const asked = [];
    const r = await (await pyTool({ value: IMG, render: "figure" }, asked)).run({ code: "x" }, { driverSees: true, visionModel: "vl" });
    assert.equal(r.image, undefined, "never automatic");
    assert.deepEqual(asked, []);
    assert.match(r.content, /open matplotlib figure\(s\) came back as an image/, "the model is told where the image came from");
    assert.equal(r.render.image, IMG, "the person still sees it");
});

test("verify with a driver that sees attaches the image; with a text-only driver the reader describes it; with neither it says so", async () => {
    const seeing = await (await pyTool({ value: IMG, render: "img" })).run({ code: "x", verify: true }, { driverSees: true });
    assert.equal(seeing.image, IMG);
    assert.match(seeing.content, /^Returned an image\.\n\nYou set verify: true/);
    assert.equal(seeing.feedback.via, "image");

    const asked = [];
    const blind = await (await pyTool({ value: IMG, render: "figure" }, asked)).run({ code: "x", verify: true }, { driverSees: false, visionModel: "reader-vl" });
    assert.equal(blind.image, undefined, "a text-only driver is not sent pixels");
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].o.images, [IMG], "the reader is shown the image");
    assert.equal(asked[0].o.model, "reader-vl");
    assert.match(blind.content, /reader-vl's description of it:\nA line chart/);
    assert.equal(blind.feedback.via, "text");

    const none = await (await pyTool({ value: IMG })).run({ code: "x", verify: true }, { driverSees: false, visionModel: null });
    assert.match(none.content, /no vision model is available/);
    assert.equal(none.image, undefined);
});

test("verify gives the reader look's 512-token budget, and an empty description is said, not quoted as nothing", async () => {
    // A thinking reader (qwen3-vl) spent all 256 tokens reasoning and answered "" on the 2026-10-19 panel.
    const { buildPythonTool } = await import("../src/python/python-tool.ts");
    const { defineTool } = await import("../src/ml/ml-tool-factories.ts");
    const asked = [];
    const tool = buildPythonTool({ defineTool, _queryAll: () => [], pythonExec: async () => ({ ok: true, stdout: "", value: IMG }),
        chat: async (prompt, o) => { asked.push(o); return "  "; } });
    const r = await tool.run({ code: "x", verify: true }, { driverSees: false, visionModel: "reader-vl" });
    assert.equal(asked[0].maxTokens, 512);
    assert.match(r.content, /reader-vl returned an empty description/);
    assert.match(r.content, /look\(\{ selector: "@tool:python_exec"/, "it says how to ask again");
    assert.doesNotMatch(r.content, /description of it:\n$/, "never an empty quote");
});

test("verify on a result that is not an image changes nothing", async () => {
    const asked = [];
    const r = await (await pyTool({ value: 42 }, asked)).run({ code: "x", verify: true }, { driverSees: true, visionModel: "vl" });
    const text = typeof r === "string" ? r : r.content;
    assert.match(text, /42/);
    assert.equal(r.image, undefined);
    assert.deepEqual(asked, []);
});

test("the schema offers verify as an optional boolean, and its text has no padding", async () => {
    const tool = await pyTool({});
    assert.equal(tool.parameters.properties.verify.type, "boolean");
    assert.ok(!tool.parameters.required.includes("verify"));
    assert.doesNotMatch(tool.parameters.properties.verify.description + tool.description, / {2}/);
    assert.match(tool.description, /matplotlib/, "the model is told it can plot");
});

// --- red team: what a hostile cell or page must not get ---
// A readonly cell is code the model may have been tricked into running, auto-approved. The epilogue runs cell-made
// objects (a Figure's methods, pyplot's close) AFTER the cell's own try, so whatever they do must not undo the wrapper's
// guarantees. The harness's `import js` is Node's unstripped global (see the scan above), so a JsProxy this section
// plants with `to_js` is the positive control, never a finding.

/** Python: every object reachable from a module matplotlib or its dependencies brought in, walked through
 *  `gc.get_referents` and stopping at any other package's module, and which of them is the JS bridge. */
const DEEP_SCAN = `
import sys, gc, types
_ours = ('matplotlib', 'mpl_toolkits', 'fontTools', 'kiwisolver', 'contourpy', 'cycler', 'pyparsing', 'packaging', 'dateutil', 'six', 'pytz')
_mine = lambda n: n.split('.')[0] in _ours
_mods = [(n, m) for n, m in list(sys.modules.items()) if m is not None]
_stop = {id(m) for n, m in _mods if not _mine(n)} | {id(getattr(m, '__dict__', None)) for n, m in _mods if not _mine(n)}
def _isjs(o):
    t = type(o)
    return t.__name__.startswith('Js') or str(getattr(t, '__module__', '')).startswith('pyodide.ffi') or (isinstance(o, types.ModuleType) and o.__name__ in ('js', 'pyodide_js'))
def deep_scan():
    seen, stack, bad, n = set(), [m for nm, m in _mods if _mine(nm)], [], 0
    while stack and n < 3_000_000:
        o = stack.pop()
        if id(o) in seen: continue
        seen.add(id(o)); n += 1
        # Checked before the stop: the bridge is itself in sys.modules ('js'), so it is one of the modules the walk stops at.
        if _isjs(o):
            bad.append(type(o).__name__); continue
        if id(o) in _stop: continue
        try: stack.extend(gc.get_referents(o))
        except Exception: pass
    return {'visited': n, 'bad': bad[:10]}
`;

test("nothing REACHABLE from a module matplotlib brought in is the JS bridge, after a cell tried every backend", T, async () => {
    const { cell } = await sandbox();
    // The module-attribute scan above misses a handle kept one level down (a class attribute, a dict, a closure). This
    // walks everything those modules reach, after the cell switched to each backend matplotlib knows (pyodide and
    // webagg included) and called show(), which is what a cell hunting for a bridge would do.
    const r = await cell(`import matplotlib, matplotlib.pyplot as plt, io
from matplotlib.backends import registry
tried = []
for _b in sorted(registry.backend_registry.list_builtin()) + ['module://matplotlib.backends.backend_pyodide']:
    try:
        plt.switch_backend(_b); tried.append(_b)
        plt.plot([1, 2]); plt.show()
    except BaseException:
        pass
    plt.close('all')
plt.switch_backend('agg')
fig, ax = plt.subplots(); ax.plot([1, 2]); fig.savefig(io.BytesIO(), format='png')
${DEEP_SCAN}
clean = deep_scan()
# Positive control: a JsProxy kept on a CLASS, where the module scan would not look, is found.
from pyodide.ffi import to_js
import matplotlib.colors as _mc
_mc.Colormap._ml_probe = to_js([1])
planted = deep_scan()
del _mc.Colormap._ml_probe
{'tried': tried, 'clean': clean, 'planted': planted}`);
    assert.equal(r.error, null, r.error);
    assert.ok(r.value.tried.includes("module://matplotlib.backends.backend_pyodide") && r.value.tried.includes("webagg"), `the cell got the browser backends: ${r.value.tried}`);
    assert.ok(r.value.clean.visited > 50000, `the walk covered matplotlib's object graph, visited ${r.value.clean.visited}`);
    assert.ok(r.value.planted.bad.length >= 1, `positive control: a planted JsProxy on a class is found, got ${JSON.stringify(r.value.planted)}`);
    assert.deepEqual(r.value.clean.bad, [], "nothing matplotlib or its dependencies keep reaches the JS bridge");
});

test("a cell whose figure epilogue raises a BaseException still has everything it scheduled cancelled", T, async () => {
    const { cell } = await sandbox();
    // PYODIDE_LOCKDOWN step 5: a task the cell scheduled must not run once its result is returned (it would run during
    // the next cell and see its inputs). The cancel sits at the END of the wrapper; the figure epilogue runs cell-made
    // code (here a patched plt.close) before it, outside the cell's own try, so an escape there would skip the cancel.
    const plant = (tag, patch) => cell(`import asyncio, sys, types, matplotlib.pyplot as plt
_m = types.ModuleType('${tag}'); _m.woke = []; sys.modules['${tag}'] = _m
async def _spy():
    await asyncio.sleep(0.01)
    _m.woke.append('ran')
asyncio.ensure_future(_spy())
${patch}
plt.figure(); plt.plot([1, 2])`);
    const woke = async (tag) => (await cell(`import sys, asyncio\nawait asyncio.sleep(0.2)\nsys.modules['${tag}'].woke`)).value;
    // Positive control: the same plant with an honest close is cancelled, so the probe can tell the two apart.
    await plant("_rt_mpl_ok", "");
    assert.deepEqual(await woke("_rt_mpl_ok"), [], "control: an honest cell's scheduled task is cancelled");
    const r = await plant("_rt_mpl_be", `class _B(BaseException): pass
_real_close = plt.close
def _close(*a, **k):
    plt.close = _real_close   # once, so the cells after this one are not broken too
    raise _B()
plt.close = _close`);
    assert.deepEqual(await woke("_rt_mpl_be"), [], "a raise from the figure epilogue must not skip the cancel");
    assert.ok(r.error === null || !/_B/.test(r.error), `the epilogue's escape does not abort the wrapper, got ${r.error}`);
    assert.deepEqual((await cell("import matplotlib.pyplot as plt\nplt.get_fignums()")).value, [], "and its figure is gone");
});

test("the 4-megapixel cap holds for a figure whose artists reach far outside it", T, async () => {
    const { cell } = await sandbox();
    // bbox_inches='tight' grows the image to every artist: a text at figure coordinates (20, 20), a label placed in data
    // coordinates far off the axis (an honest mistake), or a padded rcParams each made the image tens of megapixels at
    // the dpi the figsize alone allowed, which the panel and the exports then decode.
    const cases = {
        "fig.text far outside": "import matplotlib.pyplot as plt\nfig = plt.figure()\nplt.plot([1, 2])\nfig.text(20, 20, 'x')",
        "ax.text far along x": "import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([0, 3])\nax.text(60, 0, 'far')",
        "savefig.pad_inches 50": "import matplotlib as mpl, matplotlib.pyplot as plt\nmpl.rcParams['savefig.pad_inches'] = 50\nplt.plot([1, 2])",
    };
    for (const [name, code] of Object.entries(cases)) {
        const r = await cell(code);
        assert.match(String(r.value), PNG, `${name}: still drawn, got ${String(r.value).slice(0, 120)} ${r.error ?? ""}`);
        const { w, h } = pngSize(r.value);
        assert.ok(w * h <= 4.5e6, `${name}: capped near 4 megapixels, got ${w}x${h}`);
    }
    await cell("import matplotlib as mpl\nmpl.rcdefaults()");
    // Control: an ordinary figure is untouched by the cap (the default 100 dpi).
    const plain = await cell("import matplotlib.pyplot as plt\nplt.plot([1, 2])");
    assert.ok(pngSize(plain.value).w > 400, "an ordinary figure keeps its dpi");
});

test("a figure that cannot be drawn is still closed, and a returned Figure closes the others too", T, async () => {
    const { cell } = await sandbox();
    // A figure from one cell must never be drawn into a later cell's result. Two honest paths that skip the success path:
    // a figure whose drawing FAILS (a broken mathtext title), and a returned Figure while other figures are open.
    const broken = await cell("import matplotlib.pyplot as plt\nplt.plot([1, 2])\nplt.title(r'$\\\\frac{$')");
    assert.equal(broken.error, null, "the cell itself did not fail");
    assert.doesNotMatch(String(broken.value), PNG, "control: the drawing really failed");
    assert.deepEqual((await cell("import matplotlib.pyplot as plt\nplt.get_fignums()")).value, [], "the undrawable figure is closed");
    const ret = await cell("import matplotlib.pyplot as plt\nplt.figure(); plt.plot([1])\nplt.figure(); plt.plot([2])\nfig = plt.figure(); plt.plot([3])\nfig");
    assert.match(String(ret.value), PNG);
    assert.deepEqual((await cell("import matplotlib.pyplot as plt\nplt.get_fignums()")).value, [], "the figures it did not return are closed too");
});
