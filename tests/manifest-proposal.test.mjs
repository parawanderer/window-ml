// manifest-proposal.test.mjs — a manifest the MODEL drafts (`propose_manifest`, src/shell/manifest-proposal.ts): the
// arguments checked, the draft pinned to what the host resolved (B3, B4), this run's calls it would describe, and the
// card's DERIVED block (PROGRAM_MANIFEST.md, "The store, as built", the ruling of 2026-10-23).
import { test } from "node:test";
import assert from "node:assert/strict";

const P = await import("../src/shell/manifest-proposal.ts");
const { storeRefusal } = await import("../src/shell/stored-manifests.ts");
const { SHIPPED_MANIFESTS } = await import("../src/shell/sh-call.ts");

const ANY = { range: "*", args: [], pattern: "" };
const MYTOOL = { program: "mytool", version: ANY, command: { effects: ["read"], paths: "operands", flags: {} } };
const GEN = { program: "node", entrypoint: { path: "scripts/gen.mjs" }, command: { effects: ["read"], paths: "operands", flags: {} } };
const SHA = "c".repeat(64);
const ROOTS = ["/w/proj", "/w/other"];

/** The host's facts for `argv` in `cwd`, the program resolved as `program` says. */
const facts = ({ argv = ["mytool"], program = { path: "/opt/bin/mytool", inRoot: false, fingerprint: "1:2:3:4" }, cwd = "/w/proj", paths = [], sandboxed = true } = {}) => ({
    id: "c1", argv, program, cwd: { path: cwd, inRoot: true }, env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: false,
    paths, effects: "unknown", mode: "host", sandboxed, placement: sandboxed ? "host-sandbox" : "host-plain",
});
/** The facts of `node <root>/scripts/gen.mjs`, its script hashed by the host. */
const genFacts = (root, over = {}) => facts({
    argv: ["node", `${root}/scripts/gen.mjs`], program: { path: "/usr/bin/node", inRoot: false, fingerprint: "9:9:9:9" },
    paths: [{ arg: 1, given: `${root}/scripts/gen.mjs`, path: `${root}/scripts/gen.mjs`, inRoot: true, secret: false, exists: true, sha256: SHA, ...over }],
});

// --- the arguments ---

test("parseDraft takes a manifest object and a scope, and refuses a path for a program or an escaping entrypoint", () => {
    const ok = P.parseDraft({ manifest: MYTOOL, scope: "global" });
    assert.deepEqual(ok, { manifest: MYTOOL, scope: "global" });
    assert.notEqual(ok.manifest, MYTOOL, "a copy: the model's object is not kept");
    const bad = [
        [{ manifest: "mytool", scope: "global" }, /manifest is a program manifest object/],
        [{ manifest: [MYTOOL], scope: "global" }, /manifest is a program manifest object/],
        [{ manifest: { ...MYTOOL, program: "/opt/bin/mytool" }, scope: "global" }, /never a path/],
        [{ manifest: { ...MYTOOL, program: "" }, scope: "global" }, /never a path/],
        [{ manifest: { ...GEN, entrypoint: { path: "/w/proj/scripts/gen.mjs" } }, scope: "workspace" }, /relative to a workspace root/],
        [{ manifest: { ...GEN, entrypoint: { path: "../x/gen.mjs" } }, scope: "workspace" }, /relative to a workspace root/],
        [{ manifest: { ...GEN, entrypoint: { path: "a/../../gen.mjs" } }, scope: "workspace" }, /relative to a workspace root/],
        [{ manifest: { ...GEN, entrypoint: "scripts/gen.mjs" }, scope: "workspace" }, /relative to a workspace root/],
        [{ manifest: MYTOOL, scope: "everywhere" }, /scope is "global"/],
        [{ manifest: MYTOOL }, /scope is "global"/],
        [{ manifest: { ...MYTOOL, pad: "x".repeat(P.DRAFT_MAX_CHARS) }, scope: "global" }, /over 16384 characters/],
    ];
    for (const [args, re] of bad) assert.match(P.parseDraft(args).error, re, JSON.stringify(args).slice(0, 80));
});

test("draftArgvs resolves a binary once, at the first root, and a script under every root", () => {
    assert.deepEqual(P.draftArgvs({ manifest: MYTOOL, scope: "global" }, ROOTS), [{ root: "/w/proj", argv: ["mytool"] }]);
    assert.deepEqual(P.draftArgvs({ manifest: GEN, scope: "workspace" }, ["/w/proj/", "/w/other"]), [
        { root: "/w/proj/", argv: ["node", "/w/proj/scripts/gen.mjs"] },
        { root: "/w/other", argv: ["node", "/w/other/scripts/gen.mjs"] },
    ]);
    assert.deepEqual(P.draftArgvs({ manifest: MYTOOL, scope: "global" }, []), []);
});

// --- pinned to what the host resolved (B3, B4) ---

test("a binary's draft is pinned to the host's path and fingerprint, stored as proposed, and the store would keep it", () => {
    const r = P.draftRequest({ manifest: MYTOOL, scope: "global" }, facts(), "/w/proj", ROOTS);
    assert.deepEqual(r, { request: { scope: "global", manifest: MYTOOL, origin: "proposed", pin: { path: "/opt/bin/mytool", fingerprint: "1:2:3:4", inRoot: false } } });
    assert.equal(storeRefusal(r.request, [], SHIPPED_MANIFESTS), undefined);
    const w = P.draftRequest({ manifest: MYTOOL, scope: "workspace" }, facts(), "/w/proj", ROOTS);
    assert.equal(w.request.root, "/w/proj");
    assert.equal(w.forced, undefined, "asked for workspace: nothing forced");
});

test("B3: a binary inside a root, or a script, is forced to its workspace and the card is told why", () => {
    const inRoot = facts({ program: { path: "/w/other/bin/mytool", inRoot: true, fingerprint: "5:5:5:5" } });
    const r = P.draftRequest({ manifest: MYTOOL, scope: "global" }, inRoot, "/w/proj", ROOTS);
    assert.equal(r.request.scope, "workspace");
    assert.equal(r.request.root, "/w/other", "the root the program is inside, not the one it was resolved from");
    assert.match(r.forced, /inside the workspace \/w\/other/);
    assert.equal(storeRefusal(r.request, [], SHIPPED_MANIFESTS), undefined);
    const s = P.draftRequest({ manifest: GEN, scope: "global" }, genFacts("/w/proj"), "/w/proj", ROOTS);
    assert.equal(s.request.scope, "workspace");
    assert.match(s.forced, /arrived with the repository/);
});

test("a script's draft takes the sha256 the host read, never the model's, and needs the script where the draft says", () => {
    const d = { manifest: { ...GEN, entrypoint: { path: "scripts/gen.mjs", sha256: "a".repeat(64) } }, scope: "workspace" };
    const r = P.draftRequest(d, genFacts("/w/proj"), "/w/proj", ROOTS);
    assert.deepEqual(r.request.manifest.entrypoint, { path: "scripts/gen.mjs", sha256: SHA });
    assert.equal(r.request.pin, undefined);
    assert.equal(storeRefusal(r.request, [], SHIPPED_MANIFESTS), undefined);
    assert.match(P.draftRequest(d, genFacts("/w/proj", { exists: false }), "/w/proj", ROOTS).error, /not a file under \/w\/proj or \/w\/other/);
    assert.match(P.draftRequest(d, genFacts("/w/proj", { path: "/etc/gen.mjs" }), "/w/proj", ROOTS).error, /resolves to \/etc\/gen.mjs, outside \/w\/proj/);
    assert.match(P.draftRequest(d, genFacts("/w/proj", { sha256: undefined }), "/w/proj", ROOTS).error, /could not read/);
    assert.match(P.draftRequest(d, facts({ argv: ["node", "/w/proj/scripts/gen.mjs"] }), "/w/proj", ROOTS).error, /not a file/, "no facts for arg 1");
});

test("a binary with no fingerprint has nothing to pin to, and an invalid manifest is refused once pinned", () => {
    assert.match(P.draftRequest({ manifest: MYTOOL, scope: "global" }, facts({ program: { path: "/opt/bin/mytool", inRoot: false } }), "/w/proj", ROOTS).error, /no fingerprint/);
    assert.match(P.draftRequest({ manifest: { program: "mytool" }, scope: "global" }, facts(), "/w/proj", ROOTS).error, /not a valid program manifest/);
});

// --- this run's calls it would describe ---

test("callsOfDraft keeps this run's calls of the same program file, or of the same script under its own root, latest first", () => {
    const bin = P.draftRequest({ manifest: MYTOOL, scope: "global" }, facts(), "/w/proj", ROOTS).request;
    const a = facts({ argv: ["mytool", "a"] }), b = facts({ argv: ["mytool", "b"] });
    const other = facts({ argv: ["mytool", "c"], program: { path: "/usr/local/bin/mytool", inRoot: false, fingerprint: "1:2:3:4" } });
    assert.deepEqual(P.callsOfDraft(bin, [a, other, b], ROOTS).map((c) => c.argv[1]), ["b", "a"]);
    const many = Array.from({ length: 12 }, (_, i) => facts({ argv: ["mytool", String(i)] }));
    assert.deepEqual(P.callsOfDraft(bin, many, ROOTS).map((c) => c.argv[1]), ["11", "10", "9", "8", "7", "6", "5", "4"]);

    const gen = P.draftRequest({ manifest: GEN, scope: "workspace" }, genFacts("/w/proj"), "/w/proj", ROOTS).request;
    const here = genFacts("/w/proj"), there = genFacts("/w/other");
    const elsewhere = facts({ argv: ["node", "/w/proj/scripts/other.mjs"], program: { path: "/usr/bin/node", inRoot: false, fingerprint: "9:9:9:9" } });
    assert.deepEqual(P.callsOfDraft(gen, [here, there, elsewhere], ROOTS), [here], "the same script under another root is that workspace's");
});

// --- the card's DERIVED block ---

test("the card's note says it is derived, what was pinned, and what approval does on a sandboxed host", () => {
    const r = P.draftRequest({ manifest: MYTOOL, scope: "global" }, facts(), "/w/proj", ROOTS).request;
    const f = { effects: [{ op: "read", res: { kind: "fs", path: "/w/proj/a b", inRoot: true } }] };
    const n = P.draftNote(r, undefined, [{ argv: ["mytool", "a b"], facts: f, free: true }, { argv: ["mytool", "-w"], facts: { effects: "unknown" }, free: false }], true);
    assert.match(n, /^Proposed by the model: a manifest for mytool, stored for every workspace, pinned to \/opt\/bin\/mytool as it is now \(fingerprint 1:2:3:4\)/);
    assert.match(n, /DERIVED, nothing run: the host resolved this run's 2 calls/);
    assert.match(n, /mytool "a b": read \/w\/proj\/a b, free; mytool -w: unknown, asks/);
    assert.match(n, /Then the 1 free call is re-run under the sandbox with writes refused/);
    assert.doesNotMatch(n, /measured|passed|exited/, "nothing measured is mixed into the derived block");

    const none = P.draftNote(r, undefined, [], true);
    assert.match(none, /DERIVED, nothing run: this run has made no call of it that ran, so there is nothing to re-run as evidence/);
    assert.match(none, /with no free call to re-run, it stays that way/);
    assert.match(P.draftNote(r, undefined, [], false), /runs calls without the OS sandbox, so a model's manifest describes none of them/);

    const skipped = P.draftNote(r, "forced because", [{ argv: ["mytool"], skipped: "it set environment variables" }], true);
    assert.match(skipped, /\(forced because\)/);
    assert.match(skipped, /mytool: not read \(it set environment variables\)/);
    const seven = Array.from({ length: 7 }, (_, i) => ({ argv: ["mytool", String(i)], facts: f, free: true }));
    assert.match(P.draftNote(r, undefined, seven, true), /; and 2 more\./);
});

test("a script's card names its hash and its workspace", () => {
    const r = P.draftRequest({ manifest: GEN, scope: "workspace" }, genFacts("/w/proj"), "/w/proj", ROOTS).request;
    assert.match(P.draftNote(r, undefined, [], true), /a manifest for node scripts\/gen.mjs, stored for the workspace \/w\/proj, pinned to the script's sha256 cccccccccccc/);
});
