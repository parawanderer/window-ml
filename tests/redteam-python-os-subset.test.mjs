// redteam-python-os-subset.test.mjs — RED TEAM: what a hostile CELL must not reach AROUND the os subset (#2154,
// ruling 112; docs/spec/PYTHON_DIALECT.md, "The os subset"). The builder's rows (python-os-inside.test.mjs) enumerate
// `os`'s own names and the listing/read charges. These probe the neighbours: a module object that still holds an
// unlisted function, an `open`-shaped call that would read (or write) without a charge, and a charge that a detached
// method could skip. Each row asserts the DEFENDED outcome and carries a positive control in the same cell.
//
// Drives the worker's own wrapper as python-os-inside.test.mjs does; self-SKIPS without the fork core in dist/pyodide.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserSetup, wrapUserScript } from "../src/python/python-runtime.ts";
import { dialectSetup } from "../src/python/python-dialect-run.ts";
import { pyodideLoadOptions, pinEnvironment } from "../src/python/python-env.ts";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));

let py = null;
let skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

const TREE = `
import os
for d in ("/data/t/a", "/data/t/b"):
    os.makedirs(d, exist_ok=True)
for p, s in (("/data/t/x.csv", "a,b\\n1,2\\n"), ("/data/t/b/z.txt", "z" * 1000)):
    with open(p, "w") as f:
        f.write(s)

def _ml_test_budgeted(src, budget):
    import _restricted, restricted
    ns = {}
    try:
        restricted.run_cell(src, ns, frozenset(${JSON.stringify(NODES)}), budget=budget)
        return [None, _restricted.steps()]
    except restricted.NotInDialect as e:
        return [str(e), _restricted.steps()]
`;

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ ...pyodideLoadOptions(PYODIDE_DIR), stdout: () => {}, stderr: () => {} });
    if (py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`)) { skip = "dist/pyodide is the stock core, not the restricted-mode fork"; return; }
    pinEnvironment(py);
    await py.loadPackage(["numpy", "pandas", "pillow"], { messageCallback: () => {} });
    assert.strictEqual(await py.runPythonAsync(dialectSetup(FILES)), "");
    py.runPython(TREE);
}, { timeout: 240000 });

/** One cell as the worker runs it, inside the dialect: its refusal, error or value. */
async function cell(code) {
    const ns = py.globals.get("dict")();
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
    await py.runPythonAsync(wrapUserScript(code, "run", { nodes: NODES }), { globals: ns });
    const refused = ns.get("_ml_not_in_dialect");
    if (refused) return { refused: String(refused) };
    const err = ns.get("_err");
    if (err) return { error: String(err) };
    const jr = ns.get("_json_result");
    let value; try { value = JSON.parse(jr); } catch { value = jr; }
    return { value };
}
const budgeted = (src, budget) => py.globals.get("_ml_test_budgeted")(src, budget).toJs().map((x) => x ?? null);

/** Assert a cell is outside the dialect (it asks). */
async function asks(code, re) {
    const out = await cell(code);
    assert.ok(out.refused, `${code}\nran inside: ${JSON.stringify(out)}`);
    if (re) assert.match(out.refused, re, code);
}
/** Assert a cell runs inside. */
async function inside(code) {
    const out = await cell(code);
    assert.strictEqual(out.refused, undefined, `${code}\nwas refused: ${out.refused}`);
    assert.strictEqual(out.error, undefined, `${code}\nraised: ${out.error}`);
    return out.value;
}

// --- a module object around os must not hand back a name os's own list took away ---------------------

// `allow_module` replaces the NAMES of os, os.path, glob and pathlib. The neighbours that import them keep a reference
// to the SAME module object (posixpath.os, glob.os), so a replaced namespace is not a door — but only if those
// neighbours are replaced too, and if the module objects' dunders (`__dict__`, a computed `getattr`) are not. The
// backend module (`posix`) and `sys.modules` are the same door one level further down. Positive control: the admitted
// names of those very modules run inside, so a refusal is about the unlisted name, not the import.
//
// Each door is probed by CONSUMING an admitted name through it, never by `repr(<module>)`: repr inside the gate
// refuses a module object whether or not its names are admitted, so a repr probe is green whether the door is shut or
// open. `posixpath.os.listdir('/data/t')` is the shape that returns 3 the moment `os` is admitted on os.path.
test("RED TEAM (os subset): the module objects around os hold no door to a name the subset took away", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ok = await inside("import os, glob\nreturn len(os.listdir('/data/t')) + len(glob.glob('/data/t/*.csv'))");
    assert.strictEqual(ok, 4, "positive control: the admitted names of those modules run inside (3 names, 1 csv)");
    for (const [code, door] of [
        ["import posixpath\nreturn len(posixpath.os.listdir('/data/t'))", /attribute 'os' of module/],
        ["import glob\nreturn len(glob.os.listdir('/data/t'))", /attribute 'os' of module/],
        ["import pathlib\nreturn len(pathlib.os.listdir('/data/t'))", /attribute 'os' of module/],
        ["import glob\nimport posixpath\nreturn len(posixpath.os.listdir('/data/t'))", /attribute 'os' of module/],
        ["import posixpath\nreturn len(posixpath.listdir('/data/t'))", /attribute 'listdir' of module/],
        ["import glob\nreturn len(glob.listdir('/data/t'))", /attribute 'listdir' of module/],
        // The backend module is not importable, so `posix` is not a door even one level down.
        ["import posix\nreturn len(posix.listdir('/data/t'))", /import 'posix'/],
        // os's own replaced namespace: no dunder, no computed name.
        ["import os\nreturn repr(os.__dict__.get('remove'))", /attribute __dict__/],
        ["import os\nreturn repr(getattr(os, 're' + 'move'))", /call on builtin_function_or_method/],
        ["import os\nreturn repr(vars(os)['system'])", /call on builtin_function_or_method/],
        // `sys` itself is outside the dialect, so `sys.modules` is not even a door to try the deeper one through.
        ["import sys\nreturn len(sys.modules['posix'].listdir('/data/t'))", /import 'sys'/],
    ]) await asks(code, door);
});

// --- no uncharged open: a read or a write through a constructor that is not the charged Path read ----------

// A listing and a read are charged where every listing and read reaches the file system. `io.open`, `_io.open`,
// `codecs.open`, `os.fdopen`, `Path.open` and `builtins.open` would each be a read (or a write) the charge never sees,
// and `builtins.open` is refused outright by the builder's row. This row pins the rest of the family, with the admitted
// Path read as the control that the same file is readable the charged way.
test("RED TEAM (os subset): every open-shaped call but the charged Path read asks", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const value = await inside("from pathlib import Path\nreturn len(Path('/data/t/b/z.txt').read_text())");
    assert.strictEqual(value, 1000, "positive control: the admitted read returns the file");
    // Each probe asserts the refusal lands ON THE DOOR (`open`, `fdopen`, `write_text`), not merely somewhere after
    // it: an open that ran and then refused at `.read` or `.write` has already opened what it named.
    for (const [code, door] of [
        ["import io\nreturn len(io.open('/data/t/b/z.txt').read())", /attribute 'open' of module/],
        ["import _io\nreturn len(_io.open('/data/t/b/z.txt').read())", /import '_io'/],
        ["import codecs\nreturn len(codecs.open('/data/t/b/z.txt').read())", /import 'codecs'/],
        ["import os\nreturn len(os.fdopen(3).read())", /attribute 'fdopen' of module/],
        ["from pathlib import Path\nreturn len(Path('/data/t/b/z.txt').open().read())", /attribute 'open' of PosixPath/],
        ["from pathlib import Path\nreturn repr(Path.open)", /attribute 'open' of type/],
        ["from pathlib import Path\nreturn repr(Path.read_text)", /attribute 'read_text' of type/],
        ["import builtins\nreturn len(builtins.open('/data/t/b/z.txt').read())", /import 'builtins'/],
    ]) await asks(code, door);
    // And nothing the cell did made a file: the write side of the same family asks too. The `open` probes name a NEW
    // path, so a write that ran leaves a name the listing below sees (truncating a file that already exists leaves the
    // listing identical, and the row green); the last one names z.txt so a run of it is caught by the size check.
    for (const [code, door] of [
        ["import io\nf = io.open('/data/t/w.txt', 'w')\nf.write('x')\nf.close()\nreturn 1", /attribute 'open' of module/],
        ["from pathlib import Path\nPath('/data/t/w.txt').write_text('x')\nreturn 1", /attribute 'write_text' of PosixPath/],
        ["from pathlib import Path\nPath('/data/t/w.txt').open('w')\nreturn 1", /attribute 'open' of PosixPath/],
        ["from pathlib import Path\nPath('/data/t/b/z.txt').open('w').write('x')\nreturn 1", /attribute 'open' of PosixPath/],
    ]) await asks(code, door);
    assert.deepStrictEqual(JSON.parse(py.runPython("import os, json; json.dumps(sorted(os.listdir('/data/t')))")), ["a", "b", "x.csv"], "no file was made");
    assert.strictEqual(Number(py.runPython("import os; os.path.getsize('/data/t/b/z.txt')")), 1000, "a refused open truncated the file it named");
});

// --- the charge follows the read, not the name it is called through -------------------------------------

// `_ml_os_reads` registers `Path.read_text`'s function with a charge check, so a call of it is paid whether it is
// spelled `p.read_text()` or through a bound method the cell detached first. A detached method is the cheapest way to
// call a registered function the gate did not see made; this row pins that the charge still happens, and that a
// budget one step short of what the direct call costs asks.
test("RED TEAM (os subset): a detached read_text is charged the same as the direct call", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const direct = "from pathlib import Path\nx = Path('/data/t/b/z.txt').read_text()";
    const detached = "from pathlib import Path\nf = Path('/data/t/b/z.txt').read_text\nx = f()\ndel f";
    budgeted(direct, 10_000_000);   // warm: the first run fills caches the second does not pay for
    const [d0, dUsed] = budgeted(direct, 10_000_000);
    assert.strictEqual(d0, null, "the direct read must run inside");
    const [t0, tUsed] = budgeted(detached, 10_000_000);
    assert.strictEqual(t0, null, `the detached read must run inside (it is the same registered call): ${t0}`);
    assert.ok(tUsed > 1000, `a detached read cost ${tUsed} steps against the direct call's ${dUsed}: the charge was skipped`);
    const [short] = budgeted(detached, dUsed - 1);
    assert.match(String(short), /step budget/, "a budget one step short of the direct read must ask for the detached one too");
});
