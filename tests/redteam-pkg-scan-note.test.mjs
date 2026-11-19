// redteam-pkg-scan-note.test.mjs — python_install's platform scan, at the boundary the MODEL reads: a package's own
// source words the note, so nothing a wheel can write may set how much of the worker's result it is
// (pkg-scan-note.ts readScan/scanNote; docs/plan/repl/PACKAGES_INSTALL.md, slice 4, item 7). The lane's rows
// (tests/pkg-scan-note.test.mjs) cast the INJECTION shapes — a name with a space, a semicolon, a bidi override — and
// drop them; these cast the shapes a wheel can still write: a name whose length it chooses, and where the answer's size
// does and does not reach the note. Pure: no interpreter, no Pyodide.
import { test } from "node:test";
import assert from "node:assert/strict";

const { readScan, scanNote, SCAN_BOUNDS } = await import("../src/python/pkg-scan-note.ts");

const F = (over = {}) => ({ kind: "call", what: "os.fork", in: "pkg.mod", chain: ["pkg", "pkg.mod"], ...over });
const scan = (...findings) => ({ findings, reached: 5 });

// --- the model's result is bounded by the WORKER, not by the package ---

// `in` is a module path the scan built, and its last part can be a name the package's SOURCE chose: pkg-scan.ts
// `call_name` answers `modname + "." + <function name>`, the name is an `ast` identifier with no length limit, and a
// file it will read may be SCAN_BOUNDS.fileBytes long. `NAME` checks the shape of a name, never its length, so the note
// can carry what the wheel wrote. Measured at 94b73b68: this row reds, and the note is as long as the name.
test("RED TEAM: a name the package wrote does not set the length of the note the model reads", () => {
    const big = "a".repeat(400_000);
    const kept = readScan(scan(F({ in: `pkg.${big}`, chain: ["pkg", `pkg.${big}`] })));
    assert.equal(kept.findings.length, 1, "the control: a very long dotted identifier IS a dotted identifier, so it is kept");
    const note = scanNote(kept);
    assert.ok(note.length < 4_000, `the note carried ${note.length} characters into the model's result, from a name one wheel's source chose`);
});

test("RED TEAM: three such names at once, which is every clause the note spells out", () => {
    const big = "b".repeat(400_000);
    const kept = readScan(scan(
        F({ in: `one.${big}`, chain: ["one", `one.${big}`] }),
        F({ kind: "missing", what: `two.${big}`, in: `two.${big}`, chain: ["two", `two.${big}`] }),
        F({ kind: "raise", what: "", in: `three.${big}`, chain: ["three", `three.${big}`] }),
    ));
    assert.equal(kept.findings.length, 3, "the control: all three are kept");
    const note = scanNote(kept);
    assert.ok(note.length < 4_000, `the note carried ${note.length} characters, three names a wheel chose`);
});

// --- where the answer's size does NOT reach the model ---

test("RED TEAM: a long import chain is copied but never shown, and neither count reaches the note", () => {
    const chain = Array.from({ length: 20_000 }, (_, i) => `pkg.m${i}`);
    const kept = readScan({ findings: [F({ chain, in: chain.at(-1) })], reached: 1e308, truncated: true });
    assert.equal(kept.findings.length, 1, "the control: a 20,000-long chain is a chain of names");
    assert.equal(kept.findings[0].chain.length, chain.length, "the chain was copied whole");
    const note = scanNote(kept);
    assert.ok(note.length < 4_000, `the note carried ${note.length} characters, and the chain is not what it spells`);
    assert.ok(!/\d{6,}|e\+?308/.test(note), `a count reached the note: ${note.slice(0, 200)}`);
    // The chain is bounded on the other side: the answer keeps SCAN_BOUNDS.findings of them, never the whole list.
    const many = readScan({ findings: Array.from({ length: 10_000 }, () => F()), reached: 1 });
    assert.equal(many.findings.length, SCAN_BOUNDS.findings, "the findings cap is the answer's own bound");
});
