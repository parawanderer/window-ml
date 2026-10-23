// stored-manifests.test.mjs — the program manifests stored beside the shipped ones (PROGRAM_MANIFEST.md, "Registering a
// program", rulings B1 to B5 of 2026-10-23): what the store refuses, what a call's facts must bear out before a stored
// entry describes it, and the store itself over a mocked chrome.storage.local (load, save, an add before the load).
import { test } from "node:test";
import assert from "node:assert/strict";

// The store reads chrome.storage.local when its module loads: hold the read until the test that races it has added.
let stored = {
    ml_manifests_global: [
        { id: "man-old-g", scope: "global", manifest: { program: "fd", version: { range: "*", args: [], pattern: "" }, command: { effects: ["read"], paths: "operands", flags: {} } }, origin: "person", created: 1, pin: { path: "/opt/bin/fd", fingerprint: "1:2:3:4", inRoot: false } },
        { id: "man-broken", scope: "global", manifest: { program: "x" }, origin: "person", created: 2 },
    ],
    ml_manifests_workspace: { "/w": [{ id: "man-old-w", scope: "workspace", root: "/elsewhere", manifest: { program: "y", version: { range: "*", args: [], pattern: "" }, command: { effects: ["read"], flags: {} } }, origin: "person", created: 3, pin: { path: "/w/y", fingerprint: "f", inRoot: true } }] },
};
let release;
const gate = new Promise((r) => { release = r; });
globalThis.chrome = {
    storage: { local: {
        get: async () => { await gate; return structuredClone(stored); },
        set: async (o) => { stored = { ...stored, ...structuredClone(o) }; },
    } },
};
const S = await import("../src/shell/stored-manifests.ts");
const { shFacts, SHIPPED_MANIFESTS, manifestsFor } = await import("../src/shell/sh-call.ts");
const M = await import("../src/sw/sw-manifests.ts");

const ANY = { range: "*", args: [], pattern: "" };
/** A person's own tool on PATH, reading the files it is given. */
const MYTOOL = { program: "mytool", version: ANY, command: { effects: ["read"], paths: "operands", flags: {} } };
const PIN = { path: "/opt/bin/mytool", fingerprint: "16777234:99:4096:1760000000", inRoot: false };
const SHA = "b".repeat(64);
/** `node scripts/gen.mjs`, a workspace's own script. */
const GEN = { program: "node", entrypoint: { path: "scripts/gen.mjs", sha256: SHA }, command: { effects: ["read"], paths: "operands", flags: {} } };
const entry = (over) => ({ id: "man-1", scope: "global", manifest: MYTOOL, origin: "person", created: 1, pin: PIN, ...over });

/** The host's facts for `mytool a.txt` in /w, the program resolved and fingerprinted as `program` says. */
const facts = ({ program = { path: PIN.path, inRoot: false, fingerprint: PIN.fingerprint }, sandboxed = true, argv = ["mytool", "a.txt"], paths } = {}) => ({
    id: "c1", argv, program, cwd: { path: "/w", inRoot: true }, env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: false,
    paths: paths ?? [{ arg: 1, given: "a.txt", path: "/w/a.txt", inRoot: true, secret: false, exists: true }],
    effects: "unknown", mode: "host", sandboxed, placement: sandboxed ? "host-sandbox" : "host-plain",
});

// --- what the store refuses (B2, B3, B4) ---

test("the store keeps a pinned person's tool, global or for a workspace, and refuses what is malformed", () => {
    assert.equal(S.storeRefusal({ scope: "global", manifest: MYTOOL, origin: "person", pin: PIN }, [], SHIPPED_MANIFESTS), undefined);
    assert.equal(S.storeRefusal({ scope: "workspace", root: "/w", manifest: MYTOOL, origin: "proposed", pin: PIN }, [], SHIPPED_MANIFESTS), undefined);
    assert.equal(S.storeRefusal({ scope: "workspace", root: "/w", manifest: GEN, origin: "person" }, [], SHIPPED_MANIFESTS), undefined);
    const bad = [
        [{ scope: "global", manifest: { program: "mytool" }, origin: "person", pin: PIN }, /not a valid program manifest/],
        [{ scope: "global", manifest: MYTOOL, origin: "page", pin: PIN }, /origin/],
        [{ scope: "global", root: "/w", manifest: MYTOOL, origin: "person", pin: PIN }, /global one names none/],
        [{ scope: "workspace", manifest: MYTOOL, origin: "person", pin: PIN }, /names its root/],
        [{ scope: "workspace", root: "w", manifest: MYTOOL, origin: "person", pin: PIN }, /names its root/],
        [{ scope: "global", manifest: MYTOOL, origin: "person" }, /pinned to the program the host resolved/],
        [{ scope: "global", manifest: MYTOOL, origin: "person", pin: { ...PIN, fingerprint: "" } }, /pinned/],
        [{ scope: "workspace", root: "/w", manifest: GEN, origin: "person", pin: PIN }, /entrypoint's sha256/],
        [{ scope: "global", manifest: MYTOOL, origin: "person", pin: { ...PIN, version: "1.4.0" } }, /reads no version/],
    ];
    const READS = { ...MYTOOL, version: { range: ">=1 <2", args: ["--version"], pattern: "(\\d+\\.\\d+\\.\\d+)" } };
    assert.equal(S.storeRefusal({ scope: "global", manifest: READS, origin: "person", pin: { ...PIN, version: "1.4.0" } }, [], SHIPPED_MANIFESTS), undefined, "a manifest that reads its version may pin one");
    for (const [r, why] of bad) assert.match(S.storeRefusal(r, [], SHIPPED_MANIFESTS) ?? "kept", why, JSON.stringify(r).slice(0, 120));
});

test("B2: a key a shipped manifest describes is refused at store time, naming the shipped file, on both scopes and both origins", () => {
    for (const program of Object.keys(SHIPPED_MANIFESTS)) for (const scope of ["global", "workspace"]) for (const origin of ["person", "proposed"]) {
        const m = { ...SHIPPED_MANIFESTS[program], effects: undefined };
        const why = S.storeRefusal({ scope, ...(scope === "workspace" ? { root: "/w" } : {}), manifest: { ...SHIPPED_MANIFESTS[program] }, origin, pin: { ...PIN, path: `/usr/bin/${program}` } }, [], SHIPPED_MANIFESTS);
        assert.match(why ?? "kept", new RegExp(`src/shell/manifests/${program}\\.json`), `${program} ${scope} ${origin}`);
        void m;
    }
});

test("B3: a program inside a root is describable by that workspace only; a global entry or another workspace's is refused", () => {
    const inRoot = { ...PIN, path: "/w/bin/mytool", inRoot: true };
    assert.equal(S.storeRefusal({ scope: "workspace", root: "/w", manifest: MYTOOL, origin: "person", pin: inRoot }, [], SHIPPED_MANIFESTS), undefined);
    assert.match(S.storeRefusal({ scope: "global", manifest: MYTOOL, origin: "person", pin: inRoot }, [], SHIPPED_MANIFESTS), /only that workspace/);
    assert.match(S.storeRefusal({ scope: "workspace", root: "/other", manifest: MYTOOL, origin: "person", pin: inRoot }, [], SHIPPED_MANIFESTS), /not inside the workspace/);
    assert.match(S.storeRefusal({ scope: "workspace", root: "/w/b", manifest: MYTOOL, origin: "person", pin: { ...inRoot, path: "/w/bin2/mytool" } }, [], SHIPPED_MANIFESTS), /not inside/, "a prefix that is not a parent");
    assert.match(S.storeRefusal({ scope: "global", manifest: GEN, origin: "person" }, [], SHIPPED_MANIFESTS), /belongs to that workspace/, "a script's manifest is a workspace's");
});

test("one entry per key per scope and root: a second is refused, the same key in another scope or root is not", () => {
    const have = [entry({ id: "man-a" })];
    assert.match(S.storeRefusal({ scope: "global", manifest: MYTOOL, origin: "person", pin: PIN }, have, SHIPPED_MANIFESTS), /already registered here \(man-a\)/);
    assert.equal(S.storeRefusal({ scope: "workspace", root: "/w", manifest: MYTOOL, origin: "person", pin: PIN }, have, SHIPPED_MANIFESTS), undefined);
});

// --- what a call's facts must bear out (B3, B4, B5) ---

test("B4: a stored tool describes its call only while the host reports the pinned program, fingerprint and version", () => {
    const place = (s = [entry()]) => ({ roots: ["/w"], stored: s });
    const ok = shFacts(facts(), null, place());
    assert.equal(ok.described, true, ok.why.join("; "));
    assert.notEqual(ok.effects, "unknown");
    for (const program of [{ path: PIN.path, inRoot: false, fingerprint: "16777234:99:4097:1760000001" }, { path: "/usr/local/bin/mytool", inRoot: false, fingerprint: PIN.fingerprint }]) {
        const f = shFacts(facts({ program }), null, place());
        assert.equal(f.effects, "unknown", JSON.stringify(program));
        assert.match(f.why.join("; "), /not the program its manifest was registered for/);
    }
    const versioned = [entry({ pin: { ...PIN, version: "1.4.0" } })];
    assert.equal(shFacts(facts(), "1.4.0", place(versioned)).described, true);
    assert.match(shFacts(facts(), "1.5.0", place(versioned)).why.join("; "), /reported 1\.5\.0, not 1\.4\.0/);
    assert.match(shFacts(facts(), null, place(versioned)).why.join("; "), /reported no version/);
    assert.equal(shFacts(facts(), null, { roots: ["/w"] }).effects, "unknown", "with nothing stored the tool is unknown, as before");
});

test("B5: a proposed manifest describes a call only under the sandbox; the person's on both placements", () => {
    const run = (origin, sandboxed) => shFacts(facts({ sandboxed }), null, { roots: ["/w"], stored: [entry({ origin })] });
    assert.equal(run("proposed", true).described, true);
    const plain = run("proposed", false);
    assert.equal(plain.effects, "unknown");
    assert.match(plain.why.join("; "), /proposed by the model/);
    assert.equal(run("person", false).described, true);
});

test("B3 at call time: an in-root program is described by its workspace's entry and by nothing else", () => {
    const program = { path: "/w/bin/mytool", inRoot: true, fingerprint: PIN.fingerprint };
    const pin = { ...PIN, path: "/w/bin/mytool", inRoot: true };
    const ws = entry({ scope: "workspace", root: "/w", pin });
    assert.equal(shFacts(facts({ program }), null, { roots: ["/w"], stored: [ws] }).described, true);
    // A global entry stored before the refusal existed, or forged into storage, still describes nothing in a root.
    const g = shFacts(facts({ program }), null, { roots: ["/w"], stored: [entry({ pin })] });
    assert.equal(g.effects, "unknown");
    assert.match(g.why.join("; "), /inside a workspace root/);
    // The workspace entry applies only while its root is configured.
    assert.equal(shFacts(facts({ program }), null, { roots: ["/v"], stored: [ws] }).effects, "unknown");
});

test("B1: the workspace's own entry is chosen over a global one for the same key, and a script's entry matches only under its own root", () => {
    const ws = entry({ id: "man-ws", scope: "workspace", root: "/w", manifest: { ...MYTOOL, command: { effects: ["read"], paths: "operands", flags: {} } } });
    const g = entry({ id: "man-g", manifest: { ...MYTOOL, command: { effects: ["write"], paths: "operands", flags: {} } } });
    const { list, entryOf } = manifestsFor([g, ws], ["/w"]);
    assert.equal(entryOf(list[0])?.id, "man-ws");
    assert.equal(shFacts(facts(), null, { roots: ["/w"], stored: [g, ws] }).effects[0]?.op, "read");
    const gen = entry({ scope: "workspace", root: "/w", manifest: GEN, pin: undefined });
    const script = (path) => facts({ argv: ["node", "scripts/gen.mjs"], program: { path: "/usr/local/bin/node", inRoot: false, fingerprint: "n" },
        paths: [{ arg: 1, given: "scripts/gen.mjs", path, inRoot: true, secret: false, exists: true, sha256: SHA }] });
    assert.equal(shFacts(script("/w/scripts/gen.mjs"), null, { roots: ["/w", "/v"], stored: [gen] }).described, true);
    assert.equal(shFacts({ ...script("/v/scripts/gen.mjs"), cwd: { path: "/v", inRoot: true } }, null, { roots: ["/w", "/v"], stored: [gen] }).effects, "unknown", "the same script in another root is not the registered one");
});

// --- the store over chrome.storage.local ---

test("an add sent before the first read waits for it: neither the add nor what was stored is lost", async () => {
    const adding = M.addManifest({ scope: "global", manifest: MYTOOL, origin: "person", pin: PIN });
    assert.equal(M.manifestsLoaded(), false);
    release();
    const r = await adding;
    assert.ok(!("refused" in r), JSON.stringify(r));
    const ids = M.storedManifests().map((s) => s.id);
    assert.ok(ids.includes("man-old-g") && ids.includes(r.id), JSON.stringify(ids));
    await new Promise((res) => setTimeout(res, 0));
    assert.deepEqual(stored.ml_manifests_global.map((s) => s.id), ["man-old-g", r.id], "both reach storage");
});

test("the previous store loads its well-formed entries and drops the rest, never repairing them", async () => {
    await M.manifestsReady;
    const view = await M.manifestView();
    assert.ok(!view.global.some((s) => s.id === "man-broken"), "a malformed entry is dropped");
    assert.deepEqual(view.workspace, [], "an entry filed under another root than its own is dropped");
    assert.ok(view.shipped.includes("git") && view.shipped.includes("rm"));
});

test("remove takes an entry out of memory and storage; a removed or unknown id is false", async () => {
    const r = await M.addManifest({ scope: "workspace", root: "/w", manifest: GEN, origin: "proposed" });
    assert.ok(!("refused" in r));
    assert.equal((await M.manifestView()).workspace[0].manifests[0].id, r.id);
    assert.equal(await M.removeManifest(r.id), true);
    assert.equal(await M.removeManifest(r.id), false);
    await new Promise((res) => setTimeout(res, 0));
    assert.deepEqual(stored.ml_manifests_workspace, {}, "an emptied root leaves no key");
    assert.match((await M.addManifest({ scope: "global", manifest: SHIPPED_MANIFESTS.rm, origin: "person", pin: { ...PIN, path: "/bin/rm" } })).refused, /shipped/);
});
