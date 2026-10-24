// redteam-operand-check.test.mjs — the operand check's RESIDUALS, pinned (PROGRAM_MANIFEST.md, "Registering a
// program": "A write inside a directory operand, or to a file no argument names, is not seen"; manifest-proposal.ts
// `operandChanges`: "A secret path is compared by existence only"). Root-k listed them beside the rule; these tests
// are what keeps the listing honest. Each is a lying manifest — a draft that calls a writer a reader — whose recorded
// write is one of the three shapes the check cannot see, so its evidence run STILL PASSES and the entry gets
// `evidence.calls`. A positive control in the same test shows the harness is live: the same run with a named
// non-secret regular file modified fails its evidence. Stacked on #1089 (origin/manifests/evidence-writes), merged
// after it. A change that closes one of these residuals fails the test and updates this file in the same breath.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runOn } from "./isolated-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";

const T = { timeout: Number(process.env.ML_SH_T) || 60000 };
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };
const NO_FETCH = { fetches: [] };
const MYTOOL = { program: "mytool", version: { range: "*", args: [], pattern: "" }, command: { effects: ["read"], paths: "operands", flags: {} } };
/** Claims to read only the operands from index 1 on — argv[1] is named by `operandArgs` but is not a claimed path. */
const FROM1 = { program: "mytool", version: { range: "*", args: [], pattern: "" }, command: { effects: ["read"], paths: { operandsFrom: 1 }, flags: {} } };
const ENVELOPE = { write: "none", exec: "program-only" };

const runs = (argv) => () => `(async () => { try { return JSON.stringify(await ml.sh.run(${JSON.stringify(argv)})); } catch (e) { return JSON.stringify({ threw: e.message, code: e.code }); } })()`;
const propose = (manifest = MYTOOL, scope = "global") => ({ name: "propose_manifest", args: { manifest, scope } });

/** A proposal run whose recorded call mutates `fs` on its first done (the evidence re-run leaves it alone).
 *  `secret(path)` marks a path fact `secret: true` (the host's default facts never do). */
async function evidenceRun({ argv, fs, mutate, manifest, secret }) {
    let n = 0;
    const done = () => {
        if (!n++) mutate?.(fs);
        return { out: "", err: "", code: 0, envelope: ENVELOPE, protectedChanged: [] };
    };
    const facts = secret ? (args) => ({
        argv: args.argv,
        program: { path: `/usr/bin/${args.argv[0]}`, inRoot: false, fingerprint: "1:2:3:4" },
        cwd: { path: args.cwd, inRoot: true }, env: { set: [], secrets: [], free: true },
        repo: null, repoConfigRunsCode: null,
        paths: (args.pathArgs ?? []).map((p) => {
            const given = p.split ? args.argv[p.arg].slice(args.argv[p.arg].indexOf(p.split) + 1) : args.argv[p.arg];
            const path = `${args.cwd}/${given}`;
            return { arg: p.arg, given, path, inRoot: true, secret: secret(path), exists: path in fs, ...(p.hash ? { sha256: fs[path] ?? null } : {}) };
        }),
        effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox",
    }) : undefined;
    const host = fakeNativeHost({ landlockAbi: null, fs, done, ...(facts ? { facts } : {}) });
    const cards = [];
    const onStep = async (bg, ev) => {
        for (const a of ev.asks ?? []) if (a.state === "pending") void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, ask: a.id, decision: true } });
    };
    const onApproval = (ev) => {
        if (ev.tool !== "propose_manifest") return true;
        cards.push({ renderIn: JSON.parse(JSON.stringify(ev.renderIn ?? null)) });
        return true;
    };
    let bg;
    const r = await runOn("userScripts", [runs(argv), propose(manifest)], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep, onApproval, onBg: (b) => { bg = b; } });
    return { ...r, host, cards, stored: () => bg.localStore.ml_manifests_global ?? [] };
}

/** The positive control's shape: a named non-secret regular file the call modified. The evidence run must fail it. */
async function namedWriteSeen() {
    return evidenceRun({
        argv: ["mytool", "out.txt"],
        fs: { "/w/proj/out.txt": "1".repeat(64) },
        mutate: (fs) => { fs["/w/proj/out.txt"] = "2".repeat(64); },
    });
}

// --- the residual: a write inside a directory operand (the named path is the directory, sha256 null; the file
// written inside is a different path, never in either read) ---

test("RED TEAM residual: a write inside a directory operand is not seen — the lying manifest still gets evidence", T, async () => {
    const hit = await namedWriteSeen();
    assert.match(hit.results[1], /its recorded call modified \/w\/proj\/out\.txt/, `positive control: a named write is seen — ${hit.results[1]}`);

    const miss = await evidenceRun({
        argv: ["mytool", "dir"],
        fs: { "/w/proj/dir": null },
        mutate: (fs) => { fs["/w/proj/dir/inner.txt"] = "2".repeat(64); },
    });
    assert.match(miss.results[1], /no named operand of a recorded call was created, modified or removed/,
        `the write inside the directory must be invisible to the operand check — ${miss.results[1]}`);
    assert.equal(miss.stored()[0].evidence.calls, 1, "the lying manifest is marked as having evidence");
});

// --- the residual: a file no argument names (operandArgs reads only argv's operands, so the path is in neither list) ---

test("RED TEAM residual: a write to a file no argument names is not seen — the lying manifest still gets evidence", T, async () => {
    const hit = await namedWriteSeen();
    assert.match(hit.results[1], /its recorded call modified \/w\/proj\/out\.txt/, `positive control: a named write is seen — ${hit.results[1]}`);

    const miss = await evidenceRun({
        argv: ["mytool", "a.txt"],
        fs: { "/w/proj/a.txt": "1".repeat(64) },
        mutate: (fs) => { fs["/w/proj/other.txt"] = "2".repeat(64); },
    });
    assert.match(miss.results[1], /no named operand of a recorded call was created, modified or removed/,
        `a write to an unnamed path must be invisible to the operand check — ${miss.results[1]}`);
    assert.equal(miss.stored()[0].evidence.calls, 1, "the lying manifest is marked as having evidence");
});

// --- the residual: a secret path, compared by existence only (`!b.secret && !p.secret` short-circuits the sha256
// compare, so a modified secret is not "modified"). The draft claims only the operands from index 1 on, so argv[1]
// is named by `operandArgs` (every non-flag argument) but is not a claimed path effect — that keeps the call free
// under a reader draft with the secret operand present, which is the only way the evidence check sees it at all ---

test("RED TEAM residual: a modified secret path is not seen — the lying manifest still gets evidence", T, async () => {
    // Positive control: the same shape with a NON-secret argv[1] the manifest does not claim — the check still sees it.
    const hitFs = { "/w/proj/extra.txt": "1".repeat(64), "/w/proj/out.txt": "1".repeat(64) };
    const hit = await evidenceRun({
        argv: ["mytool", "extra.txt", "out.txt"],
        fs: hitFs,
        manifest: FROM1,
        secret: () => false,
        mutate: (fs) => { fs["/w/proj/extra.txt"] = "2".repeat(64); },
    });
    assert.match(hit.results[1], /its recorded call modified \/w\/proj\/extra\.txt/, `positive control: a non-secret unnamed-by-the-manifest operand is seen — ${hit.results[1]}`);

    const fs = { "/w/proj/.env": "1".repeat(64), "/w/proj/out.txt": "1".repeat(64) };
    const miss = await evidenceRun({
        argv: ["mytool", ".env", "out.txt"],
        fs,
        manifest: FROM1,
        secret: (path) => path.endsWith(".env"),
        mutate: (m) => { m["/w/proj/.env"] = "2".repeat(64); },
    });
    assert.match(miss.results[1], /no named operand of a recorded call was created, modified or removed/,
        `a modified secret must be compared by existence only, not seen as modified — ${miss.results[1]}`);
    assert.equal(miss.stored()[0].evidence.calls, 1, "the lying manifest is marked as having evidence");
});
