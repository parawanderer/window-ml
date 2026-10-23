// propose-manifest.test.mjs — `propose_manifest` in a run the worker built, with ml.sh set up (sw-manifest-proposal.ts,
// the ruling of 2026-10-23 in PROGRAM_MANIFEST.md, "The store, as built"): nothing runs before the person's word; the
// card is derived from the host's resolve-and-discard facts and this run's calls; an approved draft is stored as
// proposed, and its evidence run re-runs this run's free calls of it under the sandbox with writes refused. The pure
// parts are tests/manifest-proposal.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runOn } from "./isolated-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";

const T = { timeout: Number(process.env.ML_SH_T) || 60000 };
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };
const NO_FETCH = { fetches: [] };
// The harness's server is named `host`, a word the model-facing scrub rewrites: model-facing patterns skip it.
const MYTOOL = { program: "mytool", version: { range: "*", args: [], pattern: "" }, command: { effects: ["read"], paths: "operands", flags: {} } };
const ENVELOPE = { write: "none", exec: "program-only" };

/** A script that runs `argv` through ml.sh and returns what it got, or what it threw. */
const runs = (argv) => () => `(async () => { try { return JSON.stringify(await ml.sh.run(${JSON.stringify(argv)})); } catch (e) { return JSON.stringify({ threw: e.message, code: e.code }); } })()`;
const propose = (manifest = MYTOOL, scope = "global") => ({ name: "propose_manifest", args: { manifest, scope } });

/**
 * A run of `steps` against a fake host. Every nested ask is allowed; `propose_manifest`'s card is answered `decision`,
 * and what the host had been sent by then is recorded with the card.
 */
async function proposalRun(steps, { decision = true, hostOpts = {} } = {}) {
    const host = fakeNativeHost({ landlockAbi: null, ...hostOpts });
    const cards = [];
    const onStep = async (bg, ev) => {
        for (const a of ev.asks ?? []) if (a.state === "pending") void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, ask: a.id, decision: true } });
    };
    const onApproval = (ev) => {
        if (ev.tool !== "propose_manifest") return true;
        cards.push({ renderIn: JSON.parse(JSON.stringify(ev.renderIn ?? null)), sent: host.names() });
        return decision;
    };
    let bg;
    const r = await runOn("userScripts", steps, { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep, onApproval, onBg: (b) => { bg = b; } });
    return { ...r, host, cards, stored: () => bg.localStore.ml_manifests_global ?? [] };
}

const starts = (names) => names.filter((n) => n === "start").length;

// --- nothing runs before the person's word ---

test("ACCEPTANCE: a draft is resolved and discarded for the card, stored as proposed on approval, and its evidence run passes", T, async () => {
    const r = await proposalRun([runs(["mytool", "a.txt"]), propose()], { hostOpts: { done: () => ({ out: "ok\n", err: "", code: 0, envelope: ENVELOPE, protectedChanged: [] }) } });
    assert.equal(r.cards.length, 1);
    assert.equal(starts(r.cards[0].sent), 1, "only the exec's own call had started when the card was shown");
    assert.ok(r.cards[0].sent.slice(r.cards[0].sent.lastIndexOf("start") + 1).includes("discard"), "the draft's resolves were discarded");
    const card = r.cards[0].renderIn;
    assert.equal(card.type, "code");
    assert.equal(card.lang, "json");
    assert.deepEqual(JSON.parse(card.text).program, "mytool");
    assert.match(card.note, /^Proposed by the model: a manifest for mytool, stored for every workspace, pinned to \/usr\/bin\/mytool as it is now \(fingerprint 1:2:3:4\)/);
    assert.match(card.note, /DERIVED, nothing run: the host resolved this run's 1 call of it again and the draft reads it as: mytool a\.txt: read \/w\/proj\/a\.txt, free/);
    assert.match(card.note, /Then the 1 free call is re-run under the sandbox with writes refused/);

    assert.match(r.results[1], /^Stored for every workspace: mytool now describes its calls under the OS sandbox\. Its evidence run re-ran 1 call under the sandbox, all as the manifest says, so it describes calls without the sandbox too\.$/);
    assert.equal(starts(r.host.names()), 2, "the evidence run started the one call again");
    const rerun = r.host.calls.filter((c) => c.call === "spawn").at(-1).args;
    assert.deepEqual([rerun.argv, rerun.timeoutMs], [["mytool", "a.txt"], 2000]);
    assert.deepEqual(r.host.calls.filter((c) => c.call === "start").at(-1).args.envelope, ENVELOPE);
    const [s] = r.stored();
    assert.deepEqual([s.origin, s.scope, s.pin, s.evidence.calls, s.evidenceFailure], ["proposed", "global", { path: "/usr/bin/mytool", fingerprint: "1:2:3:4", inRoot: false }, 1, undefined]);
});

test("declined, nothing is stored and nothing more starts", T, async () => {
    const r = await proposalRun([runs(["mytool", "a.txt"]), propose()], { decision: false });
    assert.equal(r.cards.length, 1);
    assert.match(r.results[1], /^Denied by the user\./);
    assert.equal(starts(r.host.names()), 1);
    assert.deepEqual(r.stored(), []);
});

test("a draft that cannot be stored is told to the model and never shown to the person", T, async () => {
    const shipped = { ...MYTOOL, program: "git" };
    const r = await proposalRun([propose({ ...MYTOOL, program: "/usr/bin/mytool" }), propose(shipped), propose({ program: "mytool" })]);
    assert.equal(r.cards.length, 0);
    assert.match(r.results[0], /never a path/);
    assert.match(r.results[1], /shipped manifest src\/shell\/manifests\/git\.json/);
    assert.match(r.results[2], /not a valid program manifest/);
    assert.equal(starts(r.host.names()), 0);
    assert.deepEqual(r.stored(), []);
});

// --- the evidence run's other outcomes ---

test("an evidence call that exits outside okCodes is kept on the entry, which stays sandbox-only", T, async () => {
    let n = 0;
    const r = await proposalRun([runs(["mytool", "a.txt"]), propose()], { hostOpts: { done: () => ({ out: "", err: "", code: n++ ? 2 : 0, envelope: ENVELOPE, protectedChanged: [] }) } });
    assert.match(r.results[1], /Its evidence run failed on \["mytool","a\.txt"\]: it exited 2, not one of 0\. It describes calls only under the sandbox\./);
    const [s] = r.stored();
    assert.equal(s.evidence, undefined);
    assert.deepEqual([s.evidenceFailure.argv, s.evidenceFailure.why], [["mytool", "a.txt"], "it exited 2, not one of 0"]);
});

test("an evidence call whose envelope or protected names do not hold fails, each for its own reason", T, async () => {
    const cases = [
        [{ envelope: { write: "today", exec: "any" }, protectedChanged: [] }, /applied write today, exec any, not what was asked/],
        [{ protectedChanged: [] }, /did not report the envelope it applied/],
        [{ envelope: ENVELOPE }, /did not report the protected names/],
        [{ envelope: ENVELOPE, protectedChanged: [{ root: "/w/proj", name: ".git/config", change: "modified" }] }, /it changed \.git\/config/],
    ];
    for (const [extra, re] of cases) {
        let n = 0;
        const r = await proposalRun([runs(["mytool", "a.txt"]), propose()], { hostOpts: { done: () => (n++ ? { out: "", err: "", code: 0, ...extra } : { out: "", err: "", code: 0, envelope: ENVELOPE, protectedChanged: [] }) } });
        assert.match(r.results[1], re, JSON.stringify(extra));
        assert.equal(r.stored()[0].evidence, undefined);
    }
});

test("with no call of the program in the run, the card says so and the entry is stored with no evidence, never a synthetic call", T, async () => {
    const r = await proposalRun([propose()]);
    assert.match(r.cards[0].renderIn.note, /DERIVED, nothing run: this run has made no call of it that ran, so there is nothing to re-run as evidence\./);
    assert.match(r.results[0], /None of this run's calls of it is free to re-run, so it has no evidence/);
    assert.equal(starts(r.host.names()), 0, "nothing ran, before or after");
    const [s] = r.stored();
    assert.deepEqual([s.origin, s.evidence], ["proposed", undefined]);
});

test("on a host without the OS sandbox the card says the manifest describes nothing there, and no evidence run is made", T, async () => {
    const r = await proposalRun([runs(["mytool", "a.txt"]), propose()], { hostOpts: { sandbox: false } });
    assert.match(r.cards[0].renderIn.note, /runs calls without the OS sandbox, so a model's manifest describes none of them/);
    assert.match(r.results[1], /does not run calls under the OS sandbox, so no evidence run was made/);
    assert.equal(starts(r.host.names()), 1);
    assert.equal(r.stored()[0].evidence, undefined);
});
