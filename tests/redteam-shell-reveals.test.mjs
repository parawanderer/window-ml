// redteam-shell-reveals.test.mjs — the red-team pass for the gate on programs that show other processes (ruling 31,
// `shellRevealsAllow`): what a MODEL-DRAFTED allow policy must not get from it, and what the key's own type must not let
// in. A page reaches neither the key nor a policy (a gate key: not model-writable, not in ml.config()), so these rows
// are about the two things that can answer a call without the person, each with a positive control in the same test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runOn } from "./isolated-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";
import { shFacts } from "../src/shell/sh-call.ts";

const T = { timeout: 60000 };
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };
const NO_FETCH = { fetches: [] };

/** A script that runs `argv` through ml.sh and returns what it got, or what it threw. */
const runs = (argv) => () => `(async () => { try { return JSON.stringify(await ml.sh.run(${JSON.stringify(argv)})); } catch (e) { return JSON.stringify({ threw: e.message, code: e.code }); } })()`;

/** The value an exec returned, parsed from the result the model read (`value: <json>`). */
function valueOf(result) {
    const m = /^value: (.*)$/m.exec(result) ?? /^(\{.*\})$/m.exec(result);
    assert.ok(m, `no value in: ${result}`);
    return JSON.parse(m[1]);
}

/** Answer every nested ask this way, recording each one asked. */
function answering(decision) {
    const asked = [];
    return {
        asked,
        onStep: async (bg, ev) => {
            for (const a of ev.asks ?? []) {
                if (a.state !== "pending" || asked.some((x) => x.id === a.id)) continue;
                asked.push(a);
                if (decision !== null) void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, ask: a.id, decision } });
            }
        },
    };
}

const pol = (effect, source, label) => ({ id: `p-${label}`, scope: "global", consumer: "sh", effect, source, label, origin: "person", created: 1 });
const ALLOW_PS = '(c) => c.argv[0] === "ps"';

/** The person's `ps`, marked, reading a version, and claiming effects it cannot state: so nothing but an allow policy
 *  or the person can answer a call of it, which leaves the list's absence as the only question the gate decides. */
const storedPs = () => ({ ml_manifests_global: [{ id: "man-ps", scope: "global", origin: "person", created: 1,
    manifest: { program: "ps", version: { range: ">=3", args: ["--version"], pattern: "^ps (\\d+)" }, reveals: "processes",
        command: { effects: ["unknown"], paths: "none", flags: { "-e": {} } } },
    pin: { path: "/usr/bin/ps", fingerprint: "1:2:3:4", inRoot: false } }] });

// --- an allow policy cannot answer for the list ---

test("RED TEAM: an allow policy never frees a revealing call the person has not listed, and its probe is resolved but never started", T, async () => {
    const cases = [
        // An `allow` policy matching ps: the gate, not the policy, decides, and the card says why it is here.
        { label: "unlisted, an allow policy", allow: true, list: [], cards: 1, why: "reveals", probeStarted: false, approvedBy: "person" },
        // The control that the policy is what made the difference: without it the card carries no reveals cause (the
        // call asks on its own), and with the program listed the same policy runs it with no card at all.
        { label: "unlisted, no policy", allow: false, list: [], cards: 1, why: undefined, probeStarted: false, approvedBy: "person" },
        { label: "listed, an allow policy", allow: true, list: ["ps"], cards: 0, why: undefined, probeStarted: true, approvedBy: 'policy "allow ps"' },
    ];
    for (const c of cases) {
        const host = fakeNativeHost({ done: (_id, spawn) => spawn?.argv?.[1] === "--version" ? { out: "ps 4\n", err: "", code: 0 } : { out: "PID\n", err: "", code: 0 } });
        const ask = answering(true);
        const policies = c.allow ? [pol("allow", ALLOW_PS, "allow ps")] : [];
        const { results } = await runOn("userScripts", [runs(["ps", "-e"])], { ...NO_FETCH, onNative: host.onNative, configExtra: { ...ON, shellRevealsAllow: c.list }, localExtra: { ...storedPs(), ml_policies_global: policies }, onStep: ask.onStep });
        const r = valueOf(results[0]);
        assert.equal(r.ok, true, c.label);
        assert.equal(ask.asked.length, c.cards, c.label);
        assert.equal(r.approvedBy, c.approvedBy, c.label);
        const probe = host.calls.find((x) => x.call === "spawn" && x.args.argv[1] === "--version");
        assert.ok(probe, `${c.label}: the probe is resolved`);
        const started = new Set(host.calls.filter((x) => x.call === "start").map((x) => x.args.id));
        assert.equal(started.has(probe.id), c.probeStarted, `${c.label}: the probe starts only once ps is listed`);
        if (c.cards) {
            assert.equal(ask.asked[0].why?.cause, c.why, c.label);
            // Across the vm's realm the prototype differs, so the shape is compared as JSON (tests/ml-sh.test.mjs).
            assert.equal(JSON.stringify(ask.asked[0].facts.reveals), JSON.stringify({ what: "processes", program: "ps", allowed: false }), c.label);
        }
    }
});

// --- the marker comes from the manifest and the list, never from what was measured ---

const PS_FULL = { program: "ps", version: { range: ">=3", args: ["--version"], pattern: "^ps (\\d+)" }, reveals: "processes", command: { effects: ["unknown"], paths: "none", flags: { "-e": {}, "-f": {} } } };
const facts = () => ({
    id: "c1", argv: ["ps", "-e", "-f"], program: { path: "/usr/bin/ps", fingerprint: "1:2:3:4", inRoot: false }, cwd: { path: "/w", inRoot: true },
    env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: false, paths: [], effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox",
});

test("RED TEAM: a version, read or not, never stands in for the list: allowed is the list's answer alone", () => {
    for (const [label, version] of [["not read", null], ["in range", "4"], ["out of range", "2"]]) {
        const f = shFacts(facts(), version, { roots: ["/w"], manifests: [PS_FULL], revealsAllow: [] });
        assert.deepEqual(f.reveals, { what: "processes", program: "ps", allowed: false }, label);
    }
    assert.deepEqual(shFacts(facts(), "4", { roots: ["/w"], manifests: [PS_FULL], revealsAllow: ["ps"] }).reveals, { what: "processes", program: "ps", allowed: true }, "the control: listed, it is allowed");
    assert.equal(shFacts(facts(), "4", { roots: ["/w"], manifests: [PS_FULL], revealsAllow: ["lsof"] }).reveals.allowed, false, "one program listed frees no other");
});

// --- the key's own type ---

// Failing-first at 1514c3d5: `shFacts` decided `allowed` with `(revealsAllow ?? []).includes(program)`, and every reader
// hands it whatever `chrome.storage.sync` holds, so `shellRevealsAllow: "ps"` made `"ps".includes("ps")` true and an
// unlisted ps ran unasked. The repair (9c81c8a8) puts every reader through `revealsAllowOf` (src/shell/sh-call.ts): an
// array of strings, else an empty list. The row passes at 64bf1f5d; its controls below are what keep it non-vacuous.
test("RED TEAM: a gate key of the wrong type never lists a program", T, () => {
    const base = { roots: ["/w"], manifests: [PS_FULL] };
    assert.equal(shFacts(facts(), null, { ...base, revealsAllow: ["ps"] }).reveals.allowed, true, "the control: an array of names lists ps");
    for (const [label, value] of [["a plain string", "ps"], ["an object", { ps: true }], ["a nested array", [["ps"]]], ["[null]", [null]], ["[123]", [123]]]) {
        assert.equal(shFacts(facts(), null, { ...base, revealsAllow: value }).reveals.allowed, false, label);
    }
});
