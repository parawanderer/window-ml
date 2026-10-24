// propose-library.test.mjs — `propose_manifest` with `library`: a tier 3 library for the read-only Python dialect, proposed in a run the worker built with ml.sh set up.
//
// READONLY_LIBRARY_MANIFEST.md, "The runtime import loop", ruled 2026-10-24: the file is resolved with nothing run and
// refused outside the roots before any card; the card's source is read by ONE recorded ml.sh call of cat and must hash
// to what the host resolved; the card's verdict is the sandbox's shape rule, nothing of the library run; the load
// (the enforce layer) runs only after the yes, and only a load that agrees is stored. The sandbox is faked here
// (`onPyRun`): the shape rule and the load themselves are measured on the fork core in python-dialect-library.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runOn } from "./isolated-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";

const T = { timeout: Number(process.env.ML_SH_T) || 60000 };
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };
const NO_FETCH = { fetches: [] };
const SOURCE = `"""Stats."""\ndef total(xs, start=0):\n    return sum(xs) + start\nSCALE = 2\n`;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const FILE = "/w/proj/lib/stats.py";
const proposeLib = (library = { path: "lib/stats.py", module: "stats_lib" }, extra = { scope: "global" }) => ({ name: "propose_manifest", args: { library, ...extra } });
const ADMITTED = { why: "", defs: [{ name: "total", signature: "xs, start=0" }], constants: ["SCALE"] };

/**
 * A run of `steps` against a fake host whose root holds `files` (path to text) and whose `cat` prints the file (or
 * `catOut`), and a fake sandbox answering library ops with `shape` (or `shape(lib)`, which also answers the name probe) and `load`. The card is answered `decision`.
 */
async function libraryRun(steps, { decision = true, files = { [FILE]: SOURCE }, catOut, shape = ADMITTED, load = { why: "" }, pyInside } = {}) {
    const host = fakeNativeHost({
        landlockAbi: null,
        fs: Object.fromEntries(Object.entries(files).map(([p, t]) => [p, sha(t)])),
        done: (_id, spawned) => spawned?.argv?.[0] === "cat" ? { out: catOut ?? files[`${spawned.cwd}/${spawned.argv[1]}`] ?? files[spawned.argv[1]] ?? "", err: "", code: 0 } : { out: "", err: "", code: 0 },
    });
    const ops = [];
    const onPyRun = (msg) => {
        if (!msg.library) return { ok: true, value: null, stdout: "" };
        // The precheck's probe of the name alone (a shape op over an empty source) is logged as "name".
        const probe = msg.library.op === "shape" && msg.library.lib.source === "";
        ops.push(JSON.parse(JSON.stringify({ op: probe ? "name" : msg.library.op, lib: msg.library.lib, principal: msg.principal })));
        const answer = typeof shape === "function" ? shape(msg.library.lib) : probe ? { why: "" } : shape;
        return { ok: true, stdout: "", library: msg.library.op === "shape" ? answer : load };
    };
    const cards = [];
    const onStep = async (bg, ev) => {
        for (const a of ev.asks ?? []) if (a.state === "pending") void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, ask: a.id, decision: true } });
    };
    const onApproval = (ev) => {
        if (ev.tool !== "propose_manifest") return true;
        cards.push({ renderIn: JSON.parse(JSON.stringify(ev.renderIn ?? null)), sent: host.names(), ops: ops.map((o) => o.op) });
        return decision;
    };
    let bg;
    const r = await runOn("userScripts", steps, { ...NO_FETCH, onNative: host.onNative, onPyRun, ...(pyInside ? { pyInside } : {}), configExtra: ON, onStep, onApproval, onBg: (b) => { bg = b; } });
    return { ...r, host, cards, ops, stored: () => bg.localStore.ml_libraries_global ?? [], bg };
}

const starts = (names) => names.filter((n) => n === "start").length;

// --- nothing of the library runs before the person's word ---

test("ACCEPTANCE: the source is read by one recorded cat, judged by the shape rule for the card, and loaded and stored only after the yes", T, async () => {
    const r = await libraryRun([proposeLib()]);
    assert.equal(r.cards.length, 1);
    const [card] = r.cards;
    assert.equal(starts(card.sent), 1, "only cat had started when the card was shown");
    const cat = r.host.calls.filter((c) => c.call === "spawn").map((c) => c.args.argv);
    assert.deepEqual(cat.at(-1), ["cat", FILE], "the read is cat on the one resolved file");
    assert.deepEqual(card.ops, ["name", "shape"], "the card's verdict asked only for the name and the shape: nothing loaded before the yes");
    assert.deepEqual([card.renderIn.type, card.renderIn.lang, card.renderIn.text], ["code", "python", SOURCE]);
    assert.match(card.renderIn.note, /`import stats_lib`.*reading total\(xs, start=0\), SCALE\./);
    assert.match(card.renderIn.note, new RegExp(`Read from ${FILE} \\(${Buffer.byteLength(SOURCE)} bytes, at most 65536; sha256 ${sha(SOURCE)}\\) by a recorded ml\\.sh call of cat\\.`));
    assert.match(card.renderIn.note, /with nothing of it run/);
    assert.match(card.renderIn.note, /a later change to the file needs a new proposal\.$/);

    assert.deepEqual(r.ops.map((o) => [o.op, o.principal]), [["name", "library"], ["shape", "library"], ["load", "library"]]);
    assert.deepEqual(r.ops[0].lib, { name: "stats_lib", source: "", sha256: "", names: [] }, "the name probe carries nothing of the library");
    assert.deepEqual(r.ops[2].lib, { name: "stats_lib", source: SOURCE, sha256: sha(SOURCE), names: ["total", "SCALE"] });
    assert.match(r.results[0], /^Stored for every workspace: a cell inside the read-only Python dialect may now `import stats_lib` and use total, SCALE\./);
    const [s] = r.stored();
    assert.deepEqual([s.module, s.path, s.root, s.sha256, s.source, s.origin], ["stats_lib", FILE, "/w/proj", sha(SOURCE), SOURCE, "proposed"]);
    assert.deepEqual(s.names, [{ name: "total", kind: "def", signature: "xs, start=0" }, { name: "SCALE", kind: "constant", signature: "" }]);
});

test("declined: nothing is loaded and nothing stored", T, async () => {
    const r = await libraryRun([proposeLib()], { decision: false });
    assert.equal(r.cards.length, 1);
    assert.match(r.results[0], /^Denied by the user\./);
    assert.deepEqual(r.ops.map((o) => o.op), ["name", "shape"]);
    assert.deepEqual(r.stored(), []);
});

test("the load disagreeing with the card's shape stores nothing, says so, and logs it at warn", T, async () => {
    const r = await libraryRun([proposeLib()], { load: { why: "'X' holds a list, which would keep state from one run to the next" } });
    assert.match(r.results[0], /^Not stored: loading stats_lib under the dialect's gate refused it \('X' holds a list/);
    assert.deepEqual(r.stored(), []);
    const recs = (await r.bg.context.__mlRunLog.all()).filter((x) => x.subsystem === "python" && x.kind === "library-disagreed");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].level, "warn");
    assert.equal(recs[0].detail.module, "stats_lib");
});

test("names asked for are admitted alone, with their signatures; one the module does not bind shows on the card", T, async () => {
    const one = await libraryRun([proposeLib({ path: "lib/stats.py", module: "stats_lib", names: ["total"] })]);
    assert.deepEqual(one.stored()[0].names, [{ name: "total", kind: "def", signature: "xs, start=0" }]);
    const missing = await libraryRun([proposeLib({ path: "lib/stats.py", module: "stats_lib", names: ["mean"] })]);
    assert.match(missing.cards[0].renderIn.note, /^This library cannot be stored: stats_lib defines no 'mean' at its top level\./);
    assert.deepEqual(missing.stored(), []);
});

// --- refused before any card, or shown as a card that cannot be stored ---

test("a draft that cannot be proposed is told to the model before any card, and nothing is read", T, async () => {
    const r = await libraryRun([
        proposeLib({ path: "lib/none.py", module: "stats_lib" }),
        proposeLib({ path: "lib/stats.py", module: "a.b" }),
        proposeLib({ path: "lib/stats.py", module: "_hidden" }),
        proposeLib({ path: "lib/stats.py", module: "stats_lib" }, { scope: "workspace" }),
        { name: "propose_manifest", args: { library: { path: "lib/stats.py", module: "stats_lib" }, manifest: { program: "x" }, scope: "global" } },
    ]);
    assert.equal(r.cards.length, 0);
    assert.match(r.results[0], /lib\/none\.py does not exist/);
    assert.match(r.results[1], /one identifier, no dots/);
    assert.match(r.results[2], /not starting with _/);
    assert.match(r.results[3], /scope "global"/);
    assert.match(r.results[4], /not both/);
    assert.equal(starts(r.host.names()), 0, "no cat ran");
    assert.deepEqual(r.ops, []);
});

test("a module name that already imports something (the standard library's, a whitelist module's) is refused before any card, and nothing is read", T, async () => {
    // The precheck asks the sandbox about the NAME alone: an empty source, so nothing of the library reaches it.
    const r = await libraryRun([proposeLib({ path: "lib/stats.py", module: "json" })], { shape: (lib) => lib.source === "" && lib.name === "json" ? { why: "that name already imports something else" } : ADMITTED });
    assert.equal(r.cards.length, 0);
    assert.match(r.results[0], /^Error: json cannot be a library's name: that name already imports something else\./);
    assert.deepEqual(r.ops.map((o) => [o.op, o.lib.source]), [["name", ""]]);
    assert.equal(starts(r.host.names()), 0, "no cat ran");
});

test("a file outside every root, or on a secret path, is refused before any card", T, async () => {
    for (const fact of [{ inRoot: false }, { secret: true }]) {
        const host = fakeNativeHost({ landlockAbi: null, facts: (args) => ({
            argv: args.argv, program: { path: "/bin/cat", inRoot: false, fingerprint: "1:2:3:4" }, cwd: { path: args.cwd, inRoot: true },
            env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: null, effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox",
            paths: [{ arg: 1, given: args.argv[1], path: "/elsewhere/stats.py", inRoot: true, secret: false, exists: true, sha256: sha(SOURCE), ...fact }],
        }) });
        const r = await runOn("userScripts", [proposeLib()], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onApproval: () => true });
        assert.match(r.results[0], fact.secret ? /is a secret path/ : /outside every configured workspace folder/);
        assert.equal(starts(host.names()), 0);
    }
});

test("a source the shape rule refuses is a card that cannot be stored, naming the line; approving it stores nothing", T, async () => {
    const r = await libraryRun([proposeLib()], { shape: { why: "line 4: an assignment that is not one name bound to an immutable literal (a scalar, str, bytes, or a tuple of such)", defs: [], constants: [] } });
    assert.match(r.cards[0].renderIn.note, /^This library cannot be stored: stats_lib is not a library the dialect can admit: line 4: an assignment/);
    assert.deepEqual(r.ops.map((o) => o.op), ["name", "shape"]);
    assert.deepEqual(r.stored(), []);
});

test("bytes that do not hash to the file the host resolved are refused: changed while read", T, async () => {
    const r = await libraryRun([proposeLib()], { catOut: SOURCE + "X = 1\n" });
    assert.match(r.cards[0].renderIn.note, /changed while it was read/);
    assert.deepEqual(r.ops.map((o) => o.op), ["name"], "the shape rule never saw bytes the host did not resolve");
    assert.deepEqual(r.stored(), []);
});

test("a source past the size cap is refused", T, async () => {
    const big = "X = 1\n".repeat(12000);
    const r = await libraryRun([proposeLib()], { files: { [FILE]: big } });
    assert.match(r.cards[0].renderIn.note, /a library is at most 65536/);
    assert.deepEqual(r.stored(), []);
});

test("a second proposal of a stored name is told to the model before any card", T, async () => {
    const r = await libraryRun([proposeLib(), proposeLib()]);
    assert.equal(r.cards.length, 1);
    assert.match(r.results[1], /a library named stats_lib is already stored/);
});
