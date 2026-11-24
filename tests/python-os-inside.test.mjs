// python-os-inside.test.mjs — the `os` subset of the read-only Python dialect (ruling 112): reads and scans of the file
// system, the working directory and the environment run inside, on the real fork core.
//
// docs/spec/PYTHON_DIALECT.md, "The os subset": os, os.path, glob and pathlib's reads and scans, os.chdir/os.getcwd and
// os.environ's reads and writes run unasked; anything that removes, renames or writes a file, os.system, os.exec*, and
// process and fd calls ask. A listing and a read are charged before the C work runs (rulings 105/106). Drives the
// worker's own wrapper as tests/python-dialect-inside.test.mjs does; self-SKIPS without the fork core in dist/pyodide.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserSetup, wrapUserScript } from "../src/python/python-runtime.ts";
import { dialectSetup, DIALECT_OS_READS, DIR_ENTRY_STEPS, FILE_BYTES_PER_STEP, FILE_READ_STEPS, listingSteps } from "../src/python/python-dialect-run.ts";
import { pyodideLoadOptions, PYTHON_ENV, pinEnvironment } from "../src/python/python-env.ts";
import { restrictedCharge, chargeMemfsListings } from "../src/python/listing-charge.ts";
import { makeFilesMount, DIR_PAGE, FILES_AT } from "../src/python/files-mount.ts";
import { DIR_PAGE_MAX } from "../src/session/ranged-reader.ts";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));

let py = null;
let skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";
/** The environment a fresh interpreter starts with, read before any test changes it. */
let freshEnviron = null;

// A small tree in MEMFS the rows read, and a helper that runs a cell under the fork's gate with a given budget, so a
// row can read what a run was charged (`_restricted.steps()`) and refuse one a step short.
const TREE = `
import os
for d in ("/data/t/a", "/data/t/b", "/data/many"):
    os.makedirs(d, exist_ok=True)
for p, s in (("/data/t/x.csv", "a,b\\n1,2\\n"), ("/data/t/a/y.txt", "hello"), ("/data/t/b/z.txt", "z" * 1000)):
    with open(p, "w") as f:
        f.write(s)
for i in range(100):
    open("/data/many/f%03d" % i, "w").close()

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
    pinEnvironment(py);   // as the worker does, right after the load
    freshEnviron = py.runPython("import os, json; json.dumps(dict(os.environ))");
    await py.loadPackage(["numpy", "pandas", "pillow"], { messageCallback: () => {} });
    assert.strictEqual(await py.runPythonAsync(dialectSetup(FILES)), "");
    // As the worker does at boot (python-worker.ts): every MEMFS listing is charged to the cell running inside.
    chargeMemfsListings(py.FS, py.ERRNO_CODES, restrictedCharge(py._module), listingSteps);
    py.runPython(TREE);
}, { timeout: 240000 });

/** One cell as the worker runs it, inside the dialect (or on the full path): its refusal, error or value. */
async function cell(code, inside = true, ns = py.globals.get("dict")()) {
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
    await py.runPythonAsync(wrapUserScript(code, "run", inside ? { nodes: NODES } : null), { globals: ns });
    const refused = inside ? ns.get("_ml_not_in_dialect") : undefined;
    if (refused) return { refused: String(refused) };
    const err = ns.get("_err");
    if (err) return { error: String(err) };
    const jr = ns.get("_json_result");
    let value; try { value = JSON.parse(jr); } catch { value = jr; }
    return { value };
}

/** A cell run under the gate with `budget` steps: [refusal or null, steps used]. */
const budgeted = (src, budget) => py.globals.get("_ml_test_budgeted")(src, budget).toJs().map((x) => x ?? null);

/** Assert a cell runs inside and returns `want`. */
async function inside(code, want) {
    const out = await cell(code);
    assert.strictEqual(out.refused, undefined, `${code}\nwas refused: ${out.refused}`);
    assert.strictEqual(out.error, undefined, `${code}\nraised: ${out.error}`);
    if (want !== undefined) assert.deepStrictEqual(out.value, want, code);
}

/** Assert a cell is outside the dialect (it asks). */
async function asks(code, re) {
    const out = await cell(code);
    assert.ok(out.refused, `${code}\nran inside: ${JSON.stringify(out)}`);
    if (re) assert.match(out.refused, re, code);
}

// --- each admitted read and scan runs inside ---

test("os: listdir, scandir, walk, stat and the path helpers run inside", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    await inside("import os\nreturn sorted(os.listdir('/data/t'))", ["a", "b", "x.csv"]);
    await inside("import os\nreturn sorted(e.name for e in os.scandir('/data/t') if e.is_dir())", ["a", "b"]);
    await inside("import os\nreturn sorted(f for r, d, fs in os.walk('/data/t') for f in fs)", ["x.csv", "y.txt", "z.txt"]);
    await inside("import os\nreturn os.stat('/data/t/b/z.txt').st_size", 1000);
    await inside("import os\nreturn [os.path.exists('/data/t/x.csv'), os.path.isdir('/data/t/a'), os.path.isfile('/nope')]", [true, true, false]);
    await inside("import os\nreturn [os.path.join('/data', 't'), os.path.basename('/data/t/x.csv'), os.path.splitext('x.csv')[1], os.path.getsize('/data/t/a/y.txt')]", ["/data/t", "x.csv", ".csv", 5]);
});

test("glob and pathlib: glob, iglob, Path, iterdir and the Path properties run inside", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    await inside("import glob\nreturn sorted(glob.glob('/data/t/**/*.txt', recursive=True))", ["/data/t/a/y.txt", "/data/t/b/z.txt"]);
    await inside("import glob\nreturn sorted(glob.iglob('/data/t/*.csv'))", ["/data/t/x.csv"]);
    await inside("from pathlib import Path\nreturn sorted(p.name for p in Path('/data/t').iterdir())", ["a", "b", "x.csv"]);
    await inside("from pathlib import Path\np = Path('/data/t') / 'x.csv'\nreturn [p.name, p.suffix, p.stem, str(p.parent), p.exists(), p.is_file()]", ["x.csv", ".csv", "x", "/data/t", true, true]);
});

test("Path.glob and rglob ask: each maps a Path method that sets an attribute, from C, under the gate", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    await asks("from pathlib import Path\nreturn sorted(str(p) for p in Path('/data/t').rglob('*.txt'))", /rglob/);
    await asks("from pathlib import Path\nreturn sorted(str(p) for p in Path('/data/t').glob('*'))", /glob/);
});

test("a Path the cell binds is data: it crosses back, and a later cell reads it", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = py.globals.get("dict")();
    const first = await cell("from pathlib import Path\np = Path('/data/t/x.csv')", true, ns);
    assert.strictEqual(first.refused, undefined, first.refused);
    assert.deepStrictEqual((await cell("return p.name", true, ns)).value, "x.csv");
});

test("reads: Path.read_text and read_bytes run inside on a regular file", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    await inside("from pathlib import Path\nreturn Path('/data/t/a/y.txt').read_text()", "hello");
    await inside("from pathlib import Path\nreturn len(Path('/data/t/b/z.txt').read_bytes())", 1000);
});

test("builtin open asks: a file the cell drops is finalized under the gate, and one it keeps is not data", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    await asks("return open('/data/t/a/y.txt').read()");
    await asks("return open('/data/t/a/y.txt', 'rb').read().decode()");
    await asks("f = open('/data/t/a/y.txt')\nx = f.read()\nf.close()\nreturn x");
});

test("reads: a write, or a read of a file that is not regular, asks", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of [
        "open('/data/t/x.csv', 'w')",
        "open('/data/t/x.csv', 'a')",
        "open('/data/t/x.csv', 'r+')",
        "open('/data/t/x.csv', mode='w')",
        "open('/data/t/x.csv', 'r', opener=lambda p, f: 0)",
        "open(3)",
        "return open('/dev/urandom', 'rb').read(10)",
        "from pathlib import Path\nPath('/data/t/x.csv').write_text('no')",
        "from pathlib import Path\nPath('/data/t/x.csv').open('w')",
        "from pathlib import Path\nreturn Path('/dev/urandom').read_bytes()",
    ]) await asks(code);
    assert.strictEqual(py.runPython("open('/data/t/x.csv').read()"), "a,b\n1,2\n", "nothing was written");
});

// --- the working directory and the environment ---

test("os.chdir and os.getcwd run inside, and a finished cell's working directory stays", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    py.runPython("import os; os.chdir('/home/pyodide')");
    await inside("import os\nos.chdir('/data/t')\nreturn sorted(os.listdir('.'))", ["a", "b", "x.csv"]);
    assert.strictEqual(py.runPython("import os; os.getcwd()"), "/data/t", "a finished cell's chdir is kept");
    await inside("import os\nreturn os.getcwd()", "/data/t");
    py.runPython("import os; os.chdir('/home/pyodide')");
});

test("os.environ: get, [], items, update, setdefault and pop run inside, and a finished cell's writes stay", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    await inside("import os\nreturn [os.environ.get('HOME'), os.environ['USER'], os.getenv('NOPE', 'd')]", ["/home/pyodide", "web_user", "d"]);
    await inside("import os\nreturn sorted(k for k, v in os.environ.items())[:1]", ["HOME"]);
    await inside("import os\nos.environ.update({'ML_A': '1'})\nos.environ.update({'ML_B': '2'})\nos.environ.setdefault('ML_C', '3')\nreturn os.environ.pop('ML_C')", "3");
    assert.deepStrictEqual(JSON.parse(py.runPython("import os, json; json.dumps([os.environ.get('ML_A'), os.environ.get('ML_B'), os.environ.get('ML_C')])")), ["1", "2", null]);
    await inside("import os\nreturn os.environ.copy()['ML_A']", "1");
    await asks("import os\nreturn dict(os.environ)['ML_A']", /ABCMeta/);   // dict() calls the mapping's Python keys() from C, unlifted
    py.runPython("import os; os.environ.pop('ML_A'); os.environ.pop('ML_B')");
});

test("os.environ[k] = v and del os.environ[k] ask: the fork writes an item only of a value the cell owns, and the environment is not one", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    await asks("import os\nos.environ['ML_A'] = '1'", /item assignment/);
    await asks("import os\ndel os.environ['HOME']");
    assert.ok(py.runPython("import os; 'ML_A' not in os.environ and 'HOME' in os.environ"));
});

test("a REFUSED cell's chdir and environ writes are put back, and the approved rerun starts from what was there", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    py.runPython("import os; os.chdir('/home/pyodide'); os.environ['ML_KEEP'] = 'before'");
    const code = "import os\nos.chdir('/data/t')\nos.environ.update({'ML_KEEP': 'during', 'ML_NEW': 'x'})\nimport subprocess\nreturn [os.getcwd(), os.environ['ML_KEEP'], os.environ.get('ML_NEW')]";
    await asks(code, /subprocess/);
    assert.deepStrictEqual(JSON.parse(py.runPython("import os, json; json.dumps([os.getcwd(), os.environ.get('ML_KEEP'), os.environ.get('ML_NEW')])")),
        ["/home/pyodide", "before", null], "the refused try left the working directory and the environment as they were");
    const approved = await cell(code.replace("import subprocess\n", ""), false);
    assert.deepStrictEqual(approved.value, ["/data/t", "during", "x"]);
    py.runPython("import os; os.chdir('/home/pyodide'); os.environ.pop('ML_KEEP'); os.environ.pop('ML_NEW', None)");
});

test("a refusal by the step budget puts the working directory back too", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    py.runPython("import os; os.chdir('/home/pyodide')");
    await asks("import os\nos.chdir('/data/t')\nxs = [i for i in range(10**9)]", /step budget|range of more/);
    assert.strictEqual(py.runPython("import os; os.getcwd()"), "/home/pyodide");
});

test("the environment at a fresh start is the pinned list, and nothing of the host's", (t) => {
    if (skip) return t.skip(skip);
    const env = JSON.parse(freshEnviron);
    assert.deepStrictEqual(Object.keys(env).sort(), Object.keys(PYTHON_ENV).sort(), "every name a cell can read at a fresh start");
    for (const [k, v] of Object.entries(PYTHON_ENV)) assert.strictEqual(env[k], v, k);
});

// --- what stays outside: writes, removals, renames, processes, fds ---

test("every name of os that is not listed asks, enumerated from this Python's own os", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const names = JSON.parse(py.runPython("import os, json; json.dumps(sorted(n for n in dir(os) if not n.startswith('_')))"));
    const listed = new Set(DIALECT_OS_READS.os);
    const unlisted = names.filter((n) => !listed.has(n));
    assert.ok(unlisted.includes("remove") && unlisted.includes("system") && unlisted.includes("open"), "the enumeration reaches the writes");
    for (const n of unlisted) {
        const out = await cell(`import os\nreturn repr(os.${n})`);
        assert.ok(out.refused, `os.${n} was readable inside: ${JSON.stringify(out)}`);
    }
});

test("each listed name of os is one this Python has, and none of them writes, removes, renames or runs a process", (t) => {
    if (skip) return t.skip(skip);
    const have = new Set(JSON.parse(py.runPython("import os, json; json.dumps(dir(os))")));
    for (const n of DIALECT_OS_READS.os) assert.ok(have.has(n), `os.${n} is listed but this Python has no such name`);
    const WRITES = /^(remove|unlink|rmdir|removedirs|rename|renames|replace|mkdir|makedirs|mkfifo|mknod|link|symlink|truncate|ftruncate|chmod|chown|lchown|utime|write|pwrite|writev|open|close|dup|dup2|pipe|fork|kill|system|popen|exec|spawn|putenv|unsetenv|setenv|umask|_exit|abort|nice|set)/;
    for (const n of DIALECT_OS_READS.os) assert.doesNotMatch(n, WRITES, `os.${n} is listed`);
});

test("writes, removals, renames, os.system, os.exec* and fd calls ask", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of [
        "import os\nos.remove('/data/t/x.csv')",
        "import os\nos.unlink('/data/t/x.csv')",
        "import os\nos.rename('/data/t/x.csv', '/data/t/w.csv')",
        "import os\nos.replace('/data/t/x.csv', '/data/t/w.csv')",
        "import os\nos.mkdir('/data/t/new')",
        "import os\nos.makedirs('/data/t/new/deep')",
        "import os\nos.rmdir('/data/t/a')",
        "import os\nos.system('true')",
        "import os\nos.execv('/bin/sh', ['sh'])",
        "import os\nos.open('/data/t/x.csv', os.O_RDONLY)",
        "import os\nos.close(0)",
        "import os\nos.putenv('X', '1')",
        "import os\nos.unsetenv('HOME')",
        "import os\nos.chmod('/data/t/x.csv', 0o777)",
        "import os\nos.utime('/data/t/x.csv')",
        "import os\nos.truncate('/data/t/x.csv', 0)",
        "import os\nos.symlink('/data/t/x.csv', '/data/t/l')",
        "from pathlib import Path\nPath('/data/t/x.csv').unlink()",
        "from pathlib import Path\nPath('/data/t/a').rename('/data/t/c')",
        "from pathlib import Path\nPath('/data/t/new').mkdir()",
        "from pathlib import Path\nPath('/data/t/new').touch()",
        "import shutil\nshutil.rmtree('/data/t')",
        "import os\nfor e in os.scandir('/data/t'):\n    e.stat().__class__.st_size = 0",
    ]) await asks(code);
    assert.deepStrictEqual(JSON.parse(py.runPython("import os, json; json.dumps(sorted(os.listdir('/data/t')))")), ["a", "b", "x.csv"], "the tree is as it was");
    assert.ok(py.runPython("import os; 'HOME' in os.environ"));
});

test("walk's directory list is the library's: pruning it asks", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    await asks("import os\nout = []\nfor r, d, fs in os.walk('/data/t'):\n    d[:] = []\n    out.append(r)\nreturn out");
});

// --- the charge: a listing and a read are paid for before the C work runs ---

test("a listing is charged DIR_LISTING_STEPS plus DIR_ENTRY_STEPS a name before it runs, and a budget one step short asks", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const [none, base] = budgeted("import os\nx = os.listdir('/data/t')", 10_000_000);
    assert.strictEqual(none, null);
    const [n2, many] = budgeted("import os\nx = os.listdir('/data/many')", 10_000_000);
    assert.strictEqual(n2, null);
    assert.ok(many - base >= 97 * DIR_ENTRY_STEPS, `100 names cost ${many - base} more steps than 3`);
    const [short] = budgeted("import os\nx = os.listdir('/data/many')", many - 1);
    assert.ok(short, "a budget one step short asks");
    for (const call of ["[e.name for e in os.scandir('/data/many')]", "list(os.walk('/data/many'))"]) {
        const [ok, used] = budgeted(`import os\nx = ${call}`, 10_000_000);
        assert.strictEqual(ok, null, call);
        assert.ok(used >= listingSteps(100), `${call} used ${used}`);
        assert.ok(budgeted(`import os\nx = ${call}`, used - 1)[0], call);
    }
});

test("a MEMFS directory grown past the shipped tree is charged by its own count: 10,000 names, listingSteps(10,000)", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    py.runPython("import os\nos.makedirs('/data/big', exist_ok=True)\nfor i in range(10_000):\n    open('/data/big/f%05d' % i, 'w').close()");
    try {
        const [ok, used] = budgeted("import os\nx = os.listdir('/data/big')", 10_000_000);
        assert.strictEqual(ok, null);
        assert.ok(used >= listingSteps(10_000), `10,000 names cost ${used}`);
        assert.ok(budgeted("import os\nx = os.listdir('/data/big')", listingSteps(10_000))[0], "a budget the count does not cover asks before the list is built");
    } finally { py.runPython("import shutil\nshutil.rmtree('/data/big')"); }
});

test("a read is charged FILE_READ_STEPS plus one step per FILE_BYTES_PER_STEP bytes before it reads, and a budget one step short asks", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const read = (f) => `from pathlib import Path\nx = Path('${f}').read_bytes()`;
    budgeted(read("/data/t/a/y.txt"), 10_000_000);   // warm: the first run fills caches the second does not pay for
    const [none, small] = budgeted(read("/data/t/a/y.txt"), 10_000_000);
    assert.strictEqual(none, null);
    const [n2, big] = budgeted(read("/data/t/b/z.txt"), 10_000_000);
    assert.strictEqual(n2, null);
    const more = Math.ceil(1000 / FILE_BYTES_PER_STEP) - Math.ceil(5 / FILE_BYTES_PER_STEP);
    assert.ok(big - small >= more, `1000 bytes cost ${big - small} more steps than 5, not ${more}`);
    assert.ok(small >= FILE_READ_STEPS + Math.ceil(5 / FILE_BYTES_PER_STEP), `a 5-byte read cost ${small}, under the fixed charge`);
    assert.match(String(budgeted(read("/data/t/b/z.txt"), big - 1)[0]), /step budget/);
});

test("a charge cannot be turned into a value: a library's except around an exhausted listing still asks", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    budgeted("import glob\nx = glob.glob('/data/many/*')", 10_000_000);   // warm: fnmatch's pattern cache
    const [ok, used] = budgeted("import glob\nx = glob.glob('/data/many/*')", 10_000_000);
    assert.strictEqual(ok, null);
    assert.ok(used >= listingSteps(100), `glob over 100 names used ${used}`);
    assert.ok(budgeted("import glob\nx = glob.glob('/data/many/*')", used - 1)[0], "glob swallows OSError from its scandir; the run is tripped anyway");
});

// --- /files: the mount charges a page before each request it makes (files-mount.ts `chargeListing`) ---

test("the page the mount asks for is the reader's own page cap, so the charge is for a page the reader can send", () => {
    assert.strictEqual(DIR_PAGE, DIR_PAGE_MAX);
});

test("a /files listing inside is charged a full page before it is asked for; with the hook unset, nothing is", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const entries = ["a.csv", "b.csv", "c.csv"].map((name) => ({ name, kind: "file", size: 1, mtimeMs: 0, hidden: false, readonly: true }));
    const call = (op) => {
        if (op === "stat") return { kind: "dir", size: 0, mtimeMs: 0, hidden: false, readonly: true };
        if (op === "opendir") return { entries };
        throw new Error("not served: " + op);
    };
    const steps = (chargeListing) => {
        makeFilesMount({ FS: py.FS, ERRNO_CODES: py.ERRNO_CODES, call, data: new Uint8Array(16), Interrupted: class extends Error {}, chargeListing }).remount();
        try {
            const [refused, used] = budgeted(`import os\nx = os.listdir('${FILES_AT}')`, 10_000_000);
            assert.strictEqual(refused, null);
            return used;
        } finally { py.FS.unmount(FILES_AT); }
    };
    const charge = restrictedCharge(py._module);
    const unset = steps(undefined);
    const set = steps((names) => charge(listingSteps(names)));
    assert.ok(unset < DIR_ENTRY_STEPS * 3, `unset, three names cost ${unset} steps`);
    assert.ok(set - unset >= listingSteps(DIR_PAGE), `a page of ${DIR_PAGE} is charged whatever it holds: ${set - unset} more`);
});

test("a charge refused on a later page fails the listing with EIO and caches nothing, so the next listing asks again", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const file = (name) => ({ name, kind: "file", size: 1, mtimeMs: 0, hidden: false, readonly: true });
    let asked = 0;
    const call = (op, [, o]) => {
        if (op === "stat") return { kind: "dir", size: 0, mtimeMs: 0, hidden: false, readonly: true };
        if (op === "opendir") { asked++; return o.cursor ? { entries: [file("b.csv")] } : { entries: [file("a.csv")], next: "p2" }; }
        throw new Error("not served: " + op);
    };
    let charges = 0, refuseSecond = true;
    const chargeListing = () => !(refuseSecond && ++charges === 2);
    makeFilesMount({ FS: py.FS, ERRNO_CODES: py.ERRNO_CODES, call, data: new Uint8Array(16), Interrupted: class extends Error {}, chargeListing }).remount();
    try {
        assert.throws(() => py.FS.readdir(FILES_AT), (e) => e.errno === py.ERRNO_CODES.EIO);
        assert.strictEqual(asked, 1, "the second page is never asked for");
        assert.strictEqual(py.FS.lookupPath(FILES_AT).node.kids ?? null, null, "no half-filled list is cached");
        refuseSecond = false;
        assert.deepStrictEqual(py.FS.readdir(FILES_AT).filter((n) => !n.startsWith(".")), ["a.csv", "b.csv"]);
        assert.strictEqual(asked, 3, "the next listing asks from the first page again");
    } finally { py.FS.unmount(FILES_AT); }
});

