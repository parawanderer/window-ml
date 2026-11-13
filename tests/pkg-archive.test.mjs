// pkg-archive.test.mjs — the wheel archive check (src/python/pkg-archive.ts): every refusal has a fixture zip built here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { checkWheel, ARCHIVE_BOUNDS } = await import("../src/python/pkg-archive.ts");

// The zip writer and the wheel builder: tests/fixtures/wheel-zip.mjs.
import { zip, wheel } from "./fixtures/wheel-zip.mjs";

const FN = "pkg-1.0-py3-none-any.whl";
const none = new Set();
const refused = async (bytes, reason, re, taken = none, fn = FN) => {
    const r = await checkWheel(bytes, fn, taken);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.reason, reason, r.why);
    if (re) assert.match(r.why, re);
    return r;
};

// --- a good wheel ---

// Pyodide's unpackArchive leaves `<dist>.data/` where it is (measured on fonttools), so nothing in it is importable.
test("a plain wheel passes, and its .data directory takes no import name", async () => {
    const r = await checkWheel(wheel([["pkg/__init__.py", "x=1\n"], ["solo.py", "y=2\n"], ["ext.cpython-314-wasm32-emscripten.so", "bin"], ["fast.abi3.so", "bin"], ["pkg-1.0.data/purelib/viaPure/__init__.py", "z"], ["pkg-1.0.data/platlib/viaPlat.py", "z"], ["ns/mod.py", "z"]]), FN, none);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.topLevel, ["ext", "fast", "ns", "pkg", "solo"]);
    assert.deepEqual(r.modules, ["ext", "fast", "ns", "pkg", "solo"]);
    assert.equal(r.files, 9);
});

test("RECORD may be deflated, quoted and CRLF", async () => {
    const dist = "pkg-1.0.dist-info";
    const rec = `"pkg/__init__.py",sha256=x,1\r\n"${dist}/METADATA",,\r\n"${dist}/RECORD",,\r\n`;
    const r = await checkWheel(wheel([["pkg/__init__.py", "x"]], { record: rec, recordMethod: 8 }), FN, none);
    assert.equal(r.ok, true, JSON.stringify(r));
});

// --- the real wheels ---

const WHEELS = path.resolve(import.meta.dirname, "../pyodide-wheels");
const have = fs.existsSync(WHEELS);
const real = (prefix) => {
    const f = fs.readdirSync(WHEELS).find((n) => n.startsWith(prefix) && n.endsWith(".whl"));
    return { f, b: new Uint8Array(fs.readFileSync(path.join(WHEELS, f))) };
};
// Every wheel the extension ships, not a sample: a rule that would refuse a real package (fonttools' and sympy's
// `.data/data` man pages did) fails here.
test("every wheel in pyodide-wheels/ passes", { skip: have ? false : "pyodide-wheels/ is absent" }, async () => {
    const all = fs.readdirSync(WHEELS).filter((n) => n.endsWith(".whl"));
    assert.ok(all.length > 0);
    for (const f of all) {
        const r = await checkWheel(new Uint8Array(fs.readFileSync(path.join(WHEELS, f))), f, new Set());
        assert.equal(r.ok, true, `${f}: ${JSON.stringify(r)}`);
    }
});

test("the real native wheel kiwisolver passes", { skip: have ? false : "pyodide-wheels/ is absent" }, async () => {
    const { f, b } = real("kiwisolver-");
    const r = await checkWheel(b, f, none);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.modules.includes("kiwisolver"));
});
test("the real pure wheel cycler passes", { skip: have ? false : "pyodide-wheels/ is absent" }, async () => {
    const { f, b } = real("cycler-");
    const r = await checkWheel(b, f, none);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.modules, ["cycler"]);
});
test("the real matplotlib wheel names matplotlib, mpl_toolkits and pylab", { skip: have ? false : "pyodide-wheels/ is absent" }, async () => {
    const { f, b } = real("matplotlib-");
    const r = await checkWheel(b, f, none);
    assert.equal(r.ok, true, JSON.stringify(r));
    for (const m of ["matplotlib", "mpl_toolkits", "pylab"]) assert.ok(r.modules.includes(m), m);
});

// --- the zip's structure ---

test("bytes that are not a zip are refused", async () => {
    await refused(new Uint8Array(100).fill(7), "bad-archive", /not a zip/);
    await refused(new Uint8Array(0), "bad-archive", /not a zip/);
});
test("a zip64 end record is refused", async () => {
    await refused(zip([{ name: "a.py" }], { zip64: true }), "bad-archive", /zip64/);
});
test("a zip64 locator is refused", async () => {
    const z = Buffer.from(zip([{ name: "a.py" }]));
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    const end = z.length - 22;
    await refused(new Uint8Array(Buffer.concat([z.subarray(0, end), loc, z.subarray(end)])), "bad-archive", /zip64/);
});
test("more entries than the bound is refused", async () => {
    const z = Buffer.from(zip([{ name: "a.py" }]));
    z.writeUInt16LE(ARCHIVE_BOUNDS.entries + 1, z.length - 22 + 8);
    z.writeUInt16LE(ARCHIVE_BOUNDS.entries + 1, z.length - 22 + 10);
    await refused(new Uint8Array(z), "bad-archive", /entries/);
});
test("a central directory entry that runs past the buffer is refused", async () => {
    const z = Buffer.from(zip([{ name: "a.py" }]));
    const cd = z.length - 22 - 50;
    z.writeUInt16LE(60000, cd + 28);
    await refused(new Uint8Array(z), "bad-archive", /central directory|name/);
    const z2 = Buffer.from(zip([{ name: "a.py" }]));
    z2.writeUInt32LE(z2.readUInt32LE(z2.length - 22 + 12) + 500, z2.length - 22 + 12);
    await refused(new Uint8Array(z2), "bad-archive", /runs past/);
});
test("an entry name over the byte bound is refused", async () => {
    await refused(zip([{ name: "a".repeat(ARCHIVE_BOUNDS.name + 1) + ".py" }]), "bad-archive", /name of/);
});
test("an encrypted entry is refused", async () => {
    await refused(wheel([["pkg/__init__.py", "x"]], { extra: [{ name: "pkg/s.py", data: "x", flags: 1 }] }), "bad-archive", /encrypted/);
});
test("compression method 12 is refused, and 0 and 8 are not", async () => {
    await refused(wheel([["pkg/__init__.py", "x"]], { extra: [{ name: "pkg/b.py", data: "x", method: 12 }] }), "bad-archive", /method 12/);
    const ok = await checkWheel(wheel([["pkg/__init__.py", "x"], ["pkg/b.py", "bbbb", { method: 8 }]]), FN, none);
    assert.equal(ok.ok, true, JSON.stringify(ok));
});

// --- entry names ---

for (const [label, name, re] of [
    ["a parent segment", "../x.py", /"\.\."/],
    ["a nested parent segment", "pkg/../../x.py", /"\.\."/],
    ["an absolute path", "/abs.py", /absolute/],
    ["a backslash", "a\\b.py", /backslash/],
    ["an empty segment", "a//b.py", /empty/],
    ["a dot segment", "a/./b.py", /"\."/],
    ["a NUL", "a\u0000b.py", /control/],
    ["a newline", "a\nb.py", /control/],
]) {
    test(`a name with ${label} is refused`, async () => {
        await refused(wheel([["pkg/__init__.py", "x"]], { extra: [{ name, data: "x" }] }), "bad-archive", re);
    });
}
test("a duplicated name is refused, exact and case-insensitive", async () => {
    await refused(wheel([["pkg/__init__.py", "x"], ["pkg/a.py", "1"]], { extra: [{ name: "pkg/a.py", data: "2" }] }), "bad-archive", /twice/);
    await refused(wheel([["pkg/__init__.py", "x"], ["pkg/a.py", "1"]], { extra: [{ name: "pkg/A.py", data: "2" }] }), "bad-archive", /twice/);
});
test("a symlink entry is refused, a Windows-made one is not read for modes", async () => {
    await refused(wheel([["pkg/__init__.py", "x"]], { extra: [{ name: "pkg/link", data: "../../etc", mode: 0o120777 }] }), "bad-archive", /regular/);
    await refused(wheel([["pkg/__init__.py", "x"]], { extra: [{ name: "pkg/fifo", data: "", mode: 0o010644 }] }), "bad-archive", /regular/);
    const r = await checkWheel(wheel([["pkg/__init__.py", "x"]], { extra: [{ name: "pkg/w.py", data: "x", mode: 0o120777, madeBy: 0x0014 }] }), FN, none);
    assert.equal(r.ok, true, JSON.stringify(r));
});

// --- the layout ---

test(".pth files are refused at the root and nested", async () => {
    await refused(wheel([["pkg/__init__.py", "x"], ["evil.pth", "import os"]]), "bad-archive", /\.pth/);
    await refused(wheel([["pkg/__init__.py", "x"], ["pkg/deep/evil.pth", "import os"]]), "bad-archive", /\.pth/);
});
test("sitecustomize and usercustomize are refused as module or package", async () => {
    await refused(wheel([["sitecustomize.py", "x"]]), "bad-archive", /site hook/);
    await refused(wheel([["usercustomize/__init__.py", "x"]]), "bad-archive", /site hook/);
});
test("every .data subdir is kept inert, and a .pth inside it is still refused", async () => {
    for (const sub of ["scripts/run", "data/share/man/man1/x.1", "headers/h.h", "purelib/sitecustomize.py"]) {
        const r = await checkWheel(wheel([["pkg/__init__.py", "x"], [`pkg-1.0.data/${sub}`, "x"]]), FN, none);
        assert.equal(r.ok, true, `${sub}: ${JSON.stringify(r)}`);
        assert.deepEqual(r.modules, ["pkg"]);
    }
    await refused(wheel([["pkg/__init__.py", "x"], ["pkg-1.0.data/purelib/evil.pth", "import os"]]), "bad-archive", /\.pth/);
});
test("a .data directory of another distribution is refused", async () => {
    await refused(wheel([["pkg/__init__.py", "x"], ["other-2.0.data/purelib/o.py", "x"]]), "bad-archive", /does not belong/);
});
test("a root file that is not a module is refused", async () => {
    await refused(wheel([["pkg/__init__.py", "x"], ["README.txt", "x"]]), "bad-archive", /not a module/);
});
test("two dist-info directories are refused, and none", async () => {
    await refused(wheel([["pkg/__init__.py", "x"], ["other-1.0.dist-info/METADATA", "x"]]), "bad-archive", /more than one/);
    await refused(zip([{ name: "pkg/__init__.py" }]), "bad-archive", /no \.dist-info/);
});
test("a dist-info that does not match the filename is refused", async () => {
    await refused(wheel([["pkg/__init__.py", "x"]], { dist: "pkg-2.0.dist-info" }), "bad-archive", /does not match/);
    await refused(wheel([["pkg/__init__.py", "x"]], { dist: "other-1.0.dist-info" }), "bad-archive", /does not match/);
    await refused(wheel([["pkg/__init__.py", "x"]]), "bad-archive", /wheel filename/, none, "pkg.whl");
});
test("name matching is PEP 503 normalised, and the dist-info uses underscores", async () => {
    const r = await checkWheel(wheel([["my_pkg/__init__.py", "x"]], { dist: "My_Pkg-1.0.dist-info" }), "my.pkg-1.0-1-py3-none-any.whl", none);
    assert.equal(r.ok, true, JSON.stringify(r));
});

// --- RECORD ---

test("a missing RECORD is refused", async () => {
    await refused(zip([{ name: "pkg/__init__.py" }, { name: "pkg-1.0.dist-info/METADATA" }]), "bad-archive", /RECORD is missing/);
});
test("a RECORD naming a file the archive lacks is refused", async () => {
    const dist = "pkg-1.0.dist-info";
    await refused(wheel([["pkg/__init__.py", "x"]], { record: `pkg/__init__.py,,\n${dist}/METADATA,,\n${dist}/RECORD,,\nghost.py,,\n` }), "bad-archive", /ghost\.py is in RECORD/);
});
test("a RECORD that omits a file of the archive is refused", async () => {
    const dist = "pkg-1.0.dist-info";
    await refused(wheel([["pkg/__init__.py", "x"], ["pkg/hidden.py", "x"]], { record: `pkg/__init__.py,,\n${dist}/METADATA,,\n${dist}/RECORD,,\n` }), "bad-archive", /hidden\.py is in the archive/);
});
test("a RECORD listing a path twice is refused", async () => {
    const dist = "pkg-1.0.dist-info";
    await refused(wheel([["pkg/__init__.py", "x"]], { record: `pkg/__init__.py,,\npkg/__init__.py,,\n${dist}/METADATA,,\n${dist}/RECORD,,\n` }), "bad-archive", /twice/);
});
test("a RECORD that is a deflate bomb is refused as too large", async () => {
    const bomb = "a".repeat(20 * 1024 * 1024);
    await refused(wheel([["pkg/__init__.py", "x"]], { record: bomb, recordMethod: 8 }), "too-large", /RECORD/);
});
test("a RECORD that inflates past its declared size is refused", async () => {
    const dist = "pkg-1.0.dist-info";
    const rec = `pkg/__init__.py,,\n${dist}/METADATA,,\n${dist}/RECORD,,\n` + "#".repeat(5000);
    const z = Buffer.from(wheel([["pkg/__init__.py", "x"]], { record: rec, recordMethod: 8 }));
    // lie in the central directory: shrink RECORD's declared uncompressed size
    const cdOff = z.readUInt32LE(z.length - 22 + 16);
    let p = cdOff;
    for (let i = 0; i < 2; i++) p += 46 + z.readUInt16LE(p + 28);
    z.writeUInt32LE(100, p + 24);
    await refused(new Uint8Array(z), "too-large", /past its declared/);
});
test("a RECORD with corrupt deflate data is refused", async () => {
    const z = Buffer.from(wheel([["pkg/__init__.py", "x"]], { recordMethod: 8 }));
    const cdOff = z.readUInt32LE(z.length - 22 + 16);
    let p = cdOff;
    for (let i = 0; i < 2; i++) p += 46 + z.readUInt16LE(p + 28);
    const lho = z.readUInt32LE(p + 42);
    z.fill(0xff, lho + 30 + z.readUInt16LE(lho + 26), lho + 30 + z.readUInt16LE(lho + 26) + 6);
    const r = await checkWheel(new Uint8Array(z), FN, none);
    assert.equal(r.ok, false);
});
test("a local header that does not match the central directory is refused", async () => {
    const z = Buffer.from(wheel([["pkg/__init__.py", "x"]]));
    z.writeUInt32LE(0, 0); // first entry's local signature
    await refused(new Uint8Array(z), "bad-archive", /local header/);
});
test("RECORD's data is found by its local header, not the central directory's extra length", async () => {
    // a local extra field the central entry does not mention
    const parts = zip([{ name: "x" }]);
    assert.ok(parts.length > 0);
    const dist = "pkg-1.0.dist-info";
    const rec = Buffer.from(`pkg/__init__.py,,\n${dist}/METADATA,,\n${dist}/RECORD,,\n`);
    const items = [["pkg/__init__.py", "x"], [`${dist}/METADATA`, "m"]];
    const z = Buffer.from(zip([...items.map(([name, data]) => ({ name, data })), { name: `${dist}/RECORD`, data: rec }]));
    // splice 4 extra bytes into RECORD's local header and fix the offsets after it
    const cdOff = z.readUInt32LE(z.length - 22 + 16);
    let p = cdOff;
    for (let i = 0; i < 2; i++) p += 46 + z.readUInt16LE(p + 28);
    const lho = z.readUInt32LE(p + 42);
    const nameLen = z.readUInt16LE(lho + 26);
    const at = lho + 30 + nameLen;
    const out = Buffer.concat([z.subarray(0, at), Buffer.alloc(4, 0x58), z.subarray(at)]);
    out.writeUInt16LE(4, lho + 28);
    out.writeUInt32LE(cdOff + 4, out.length - 22 + 16);
    const r = await checkWheel(new Uint8Array(out), FN, none);
    assert.equal(r.ok, true, JSON.stringify(r));
});

test("an entry whose data runs past the archive is refused", async () => {
    const z = Buffer.from(wheel([["pkg/__init__.py", "x"]]));
    const cdOff = z.readUInt32LE(z.length - 22 + 16);
    z.writeUInt32LE(3000, cdOff + 20);
    z.writeUInt32LE(3000, cdOff + 24);
    await refused(new Uint8Array(z), "bad-archive", /runs past/);
});

// --- sizes ---

test("a wheel that declares more than the inflation bound is refused", async () => {
    const big = Buffer.alloc(50_000);
    const z = zip([{ name: "pkg/__init__.py", data: "x" }, { name: "pkg/big.py", data: big, method: 8 }, { name: "pkg-1.0.dist-info/RECORD", data: "pkg/__init__.py,,\npkg/big.py,,\npkg-1.0.dist-info/RECORD,,\n" }]);
    assert.ok(z.length * ARCHIVE_BOUNDS.inflation < 50_000, "fixture must compress well");
    await refused(z, "too-large", /times/);
});
test("one budget is shared across calls and refuses past perCall", async () => {
    const w = wheel([["pkg/__init__.py", "x".repeat(100)]]);
    const budget = { used: ARCHIVE_BOUNDS.perCall - 400 };
    const a = await checkWheel(w, FN, none, budget);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.ok(budget.used > ARCHIVE_BOUNDS.perCall - 400);
    const b = await checkWheel(w, FN, none, budget);
    assert.equal(b.ok, false);
    assert.equal(b.reason, "too-large");
    const c = await checkWheel(w, FN, none);
    assert.equal(c.ok, true, "without a budget the same wheel passes");
});

// --- name collisions ---

test("a top-level name in taken is refused, exactly and by case", async () => {
    const w = wheel([["numpy/__init__.py", "x"]]);
    await refused(w, "name-collision", /numpy/, new Set(["numpy"]));
    await refused(wheel([["NumPy/__init__.py", "x"]]), "name-collision", /NumPy/, new Set(["numpy"]));
    await refused(w, "name-collision", /numpy/, new Set(["NUMPY"]));
});
test("_ml_ names and the always-taken names are refused whatever taken says", async () => {
    await refused(wheel([["_ml_harness.py", "x"]]), "name-collision", /_ml_harness/);
    await refused(wheel([["_ML_x/__init__.py", "x"]]), "name-collision", /_ML_x/);
    for (const n of ["js", "pyodide", "pyodide_js", "micropip", "_pyodide"]) await refused(wheel([[`${n}/__init__.py`, "x"]]), "name-collision", new RegExp(n));
});
test("a name under .data/purelib takes no import name, so it collides with nothing", async () => {
    const r = await checkWheel(wheel([["pkg/__init__.py", "x"], ["pkg-1.0.data/purelib/numpy/__init__.py", "x"]]), FN, new Set(["numpy"]));
    assert.equal(r.ok, true, JSON.stringify(r));
});
test("structure is refused before a collision, and collision is the last check", async () => {
    await refused(wheel([["numpy/__init__.py", "x"], ["evil.pth", "x"]]), "bad-archive", /\.pth/, new Set(["numpy"]));
});
