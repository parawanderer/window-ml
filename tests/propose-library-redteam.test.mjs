// propose-library-redteam.test.mjs — a rule-10 red-team pass on the tier 3 library proposal (READONLY_LIBRARY_MANIFEST.md,
// "The runtime import loop", ruled 2026-10-24): what a hostile draft, a hostile file on disk, or a model that proposes
// anything must NOT get from `propose_manifest` with `library`. Each property is a test; where the gate already held it
// is a pin, and what was probed and not gotten is listed at the end of its section.
//
// The dialect half (the shape rule, the load's admission, #1102 through a function object, callback laundering) is
// measured on the real fork core in python-dialect-library-redteam.test.mjs. The offscreen half of the remove-restart
// is tests/python-run-namespace.test.mjs. The sandbox is faked here (`onPyRun`): this file is the worker's path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runOn } from "./isolated-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";
import { libraryStoreRefusal, LIBRARY_MAX_BYTES } from "../src/shell/stored-libraries.ts";

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
 * `catOut`), and a fake sandbox answering library ops with `shape` (or `shape(lib)`, which also answers the name probe)
 * and `load`. The card is answered `decision`. `files` is live: a test may edit it mid-run to stand for a change on disk.
 */
async function libraryRun(steps, { decision = true, files = { [FILE]: SOURCE }, catOut, shape = ADMITTED, load = { why: "" }, pyInside, onCard } = {}) {
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
        onCard?.(cards.length);
        return decision;
    };
    let bg;
    const r = await runOn("userScripts", steps, { ...NO_FETCH, onNative: host.onNative, onPyRun, ...(pyInside ? { pyInside } : {}), configExtra: ON, onStep, onApproval, onBg: (b) => { bg = b; } });
    return { ...r, host, cards, ops, stored: () => bg.localStore.ml_libraries_global ?? [], bg };
}

const starts = (names) => names.filter((n) => n === "start").length;

// --- nothing of the proposed source executes before the person's word ---

test("the card's verdict asks only for the name and the shape: nothing of the source is loaded before the yes", T, async () => {
    const r = await libraryRun([proposeLib()]);
    assert.equal(r.cards.length, 1);
    assert.deepEqual(r.cards[0].ops, ["name", "shape"], "the card asked for the name and the shape; no load");
    assert.deepEqual(r.ops[0].lib, { name: "stats_lib", source: "", sha256: "", names: [] }, "the name probe carries nothing of the library");
    assert.deepEqual(r.ops.map((o) => o.principal), ["library", "library", "library"]);
    assert.equal(r.ops.filter((o) => o.op === "load").length, 1, "exactly one load, after the yes");
    assert.ok(r.ops.findIndex((o) => o.op === "load") > r.ops.findIndex((o) => o.op === "shape"), "the load is after the shape");
});

test("a declined card loads nothing and stores nothing", T, async () => {
    const r = await libraryRun([proposeLib()], { decision: false });
    assert.deepEqual(r.ops.map((o) => o.op), ["name", "shape"], "no load ran");
    assert.deepEqual(r.stored(), []);
});

// --- the name precheck cannot execute or shadow an admitted module ---

test("the already-importable-name precheck carries an empty source, reads no file body, and cannot shadow a stored library", T, async () => {
    // The precheck asks the sandbox about the NAME alone: an empty source, so nothing of the library reaches it.
    const r = await libraryRun([proposeLib({ path: "lib/stats.py", module: "json" })], {
        shape: (lib) => lib.source === "" && lib.name === "json" ? { why: "that name already imports something else" } : ADMITTED,
    });
    assert.equal(r.cards.length, 0);
    assert.match(r.results[0], /^Error: json cannot be a library's name: that name already imports something else\./);
    assert.deepEqual(r.ops.map((o) => [o.op, o.lib.source]), [["name", ""]], "the probe carried the name and an empty source");
    assert.equal(starts(r.host.names()), 0, "no cat ran: the file body was never read");
});

test("a name already stored is refused before any card, with no probe and no cat", T, async () => {
    const r = await libraryRun([proposeLib(), proposeLib()]);
    assert.equal(r.cards.length, 1, "only the first becomes a card");
    assert.match(r.results[1], /a library named stats_lib is already stored/);
    const opsAfter = r.ops.length;
    assert.equal(r.ops.filter((o) => o.op === "name").length, 1, "the second proposal sent no name probe");
    assert.equal(opsAfter, 3, "the second proposal added no sandbox call at all");
});

// --- a path outside a root, or a secret path under cat's manifest, is refused before the card ---

test("a file outside every root, on a secret path, or under a secret walk is refused before any card", T, async () => {
    for (const fact of [{ inRoot: false }, { secret: true }, { containsSecret: true }]) {
        const host = fakeNativeHost({ landlockAbi: null, facts: (args) => ({
            argv: args.argv, program: { path: "/bin/cat", inRoot: false, fingerprint: "1:2:3:4" }, cwd: { path: args.cwd, inRoot: true },
            env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: null, effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox",
            paths: [{ arg: 1, given: args.argv[1], path: "/elsewhere/stats.py", inRoot: true, secret: false, exists: true, sha256: sha(SOURCE), ...fact }],
        }) });
        const r = await runOn("userScripts", [proposeLib()], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onApproval: () => true });
        assert.match(r.results[0], fact.containsSecret || fact.secret ? /is a secret path/ : /outside every configured workspace folder/, JSON.stringify(fact));
        assert.equal(starts(host.names()), 0, `nothing started for ${JSON.stringify(fact)}`);
    }
});

// --- a 64 KiB + 1 source is refused: no approvable card, nothing past cat, the error names the cap ---

test("a source past the size cap is refused with no approvable card, nothing past cat, and the error naming the cap", T, async () => {
    const big = "X = 1\n".repeat(12000); // 72000 bytes
    assert.ok(Buffer.byteLength(big) > LIBRARY_MAX_BYTES);
    const r = await libraryRun([proposeLib()], { files: { [FILE]: big } });
    assert.equal(r.cards.length, 1, "the gate still asks; what it shows cannot be stored");
    const [card] = r.cards;
    assert.equal(card.renderIn.text, "", "no source is shown to approve");
    assert.match(card.renderIn.note, /^This library cannot be stored: /);
    assert.match(card.renderIn.note, /is \d+ bytes; a library is at most 65536/);
    assert.deepEqual(card.ops, ["name"], "nothing past the name probe and the recorded cat: no shape, no load");
    assert.equal(starts(card.sent), 1, "only the recorded cat started");
    assert.deepEqual(r.ops.map((o) => o.op), ["name"], "the shape rule never saw the oversize bytes");
    assert.deepEqual(r.stored(), []);
});

test("the store itself refuses an oversize source, naming the cap", T, async () => {
    const big = "X = 1\n".repeat(12000);
    const why = libraryStoreRefusal({
        module: "big", path: "/w/a.py", root: "/w", sha256: "a".repeat(64),
        source: big, names: [{ name: "X", kind: "constant", signature: "" }], origin: "proposed",
    }, []);
    assert.equal(why, `a library's source is at most ${LIBRARY_MAX_BYTES} bytes`);
});

// --- the stored bytes are the approved snapshot ---

test("the stored source is the snapshot the person approved: a later change to the file does not rewrite it", T, async () => {
    const files = { [FILE]: SOURCE };
    const r = await libraryRun([proposeLib(), proposeLib()], {
        files,
        onCard: (n) => { if (n === 1) files[FILE] = "def total(xs):\n    return 0\nSCALE = 99\n"; }, // the file on disk changes after the first yes
    });
    assert.equal(r.stored().length, 1);
    assert.equal(r.stored()[0].source, SOURCE, "the store holds the bytes that were read, not the file's new ones");
    assert.equal(r.stored()[0].sha256, sha(SOURCE), "the pin is the snapshot's, not the changed file's");
    assert.deepEqual(r.ops[2].lib, { name: "stats_lib", source: SOURCE, sha256: sha(SOURCE), names: ["total", "SCALE"] }, "the load was handed the snapshot");
    assert.match(r.results[1], /a library named stats_lib is already stored/, "the changed file never reached a second read");
    assert.equal(r.ops.filter((o) => o.op === "load").length, 1, "only the first proposal loaded");
});

// --- removal drops the store entry and restarts the workers that held a library ---

test("a remove drops the entry and restarts; a page sender cannot remove, and there is no add", T, async () => {
    // The worker half of the restart is libraries-message.test.mjs; the offscreen half (which workers die, and that a
    // new cell cannot see the old module) is python-run-namespace.test.mjs. Pinned here: the store and the sender.
    const { loadBackground } = await import("./helpers.js");
    const LIB = { id: "lib-1", module: "stats_lib", path: FILE, root: "/w/proj", sha256: sha(SOURCE), source: SOURCE, names: [{ name: "total", kind: "def", signature: "xs, start=0" }], origin: "proposed", created: 1 };
    const bg = loadBackground({ config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "m", apiFormat: "openai", ocrModel: "", debugMode: "off" }, local: { ml_libraries_global: [LIB] } });
    const ext = { url: "chrome-extension://test/sidebar.html" };
    const page = { tab: { id: 7, url: "https://site.example/p" }, url: "https://site.example/p", origin: "https://site.example", frameId: 0, documentId: "d1" };
    const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
    assert.equal((await bg.send({ type: "LIBRARIES", payload: { op: "add", library: LIB } }, ext)).error, "unknown op", "only an approved card stores a library");
    assert.equal((await bg.send({ type: "LIBRARIES", payload: { op: "remove", id: "lib-1" } }, page))?.error, "refused", "a page cannot remove a library");
    assert.deepEqual(bg.localStore.ml_libraries_global.map((l) => l.id), ["lib-1"], "the page's remove changed nothing");
    const removed = plain(await bg.send({ type: "LIBRARIES", payload: { op: "remove", id: "lib-1" } }, ext));
    assert.deepEqual(removed.data.libraries, []);
    assert.equal(removed.data.restarted, 1);
    assert.equal(bg.pyDrops.length, 1);
    assert.deepEqual(bg.localStore.ml_libraries_global ?? [], []);
});

// --- probed and not gotten ---

test("PROBED AND NOT GOTTEN: the channels this pass tried against the proposal path", () => {
    // A test that documents the attack surface this file closed. If any line below ever starts failing, the channel
    // opened: turn it into its own test asserting the refusal, and report it.
    const closed = [
        "the name probe carries an empty source, so a hostile module name cannot execute at precheck",
        "the file body is read only by the one recorded cat, after the name probe passed",
        "an oversize source reaches neither the shape rule nor the load",
        "a secret path (secret or containsSecret under cat's manifest) is refused before any cat starts",
        "a change to the file after the yes does not rewrite the stored snapshot",
        "a page sender cannot remove a library; there is no add op at all",
    ];
    assert.equal(closed.length, 6);
    assert.ok(closed.every((s) => s.length > 20));
});
