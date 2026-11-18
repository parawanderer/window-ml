// redteam-flavours.test.mjs — program-manifest FLAVOURS (window-ml#1963, branch manifests/flavours at 775a0365),
// adversarially: what a manifest's declaration of `flavours`, its probe and its per-flavour overlays must NOT buy.
// PROGRAM_MANIFEST.md, "Flavours". The lane's own rows (tests/ml-sh.test.mjs) pin the asked call's hardened argv and
// the fingerprint swap; these measure the four cases where the flavour is NOT read (undetected, `other`, a plain host,
// an in-root program), the free call's card, `argOrder: "stop"`, what the approval card can and cannot show, a
// flags-only overlay against the same flags in the core, and the probe's own argv, which the manifest chooses.
//
// One `// ---` section per property. A row written as the property and MEASURED red says so in its comment and is a
// finding for the lane, not a passing check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runOn } from "./isolated-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";
import { describeCall, flavourOf, hardenArgv } from "../src/shell/program-manifest.ts";
import { shCardLines, shFacts } from "../src/shell/sh-call.ts";
import { draftNote } from "../src/shell/manifest-proposal.ts";

const T = { timeout: Number(process.env.ML_SH_T) || 60000 };
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };
const NO_FETCH = { fetches: [] };
/** The roots the host resolved, and a call's cwd inside them. */
const ROOTS = ["/w/proj"];
const CWD = "/w/proj";

/** The value an exec returned, parsed from the result the model read (`value: <json>`). */
function valueOf(result) {
    const m = /^value: (.*)$/m.exec(result) ?? /^(\{.*\})$/m.exec(result);
    assert.ok(m, `no value in: ${result}`);
    return JSON.parse(m[1]);
}
/** A script that runs `argv` through ml.sh and returns what it got, or what it threw. */
const runs = (argv) => () => `(async () => { try { return JSON.stringify(await ml.sh.run(${JSON.stringify(argv)})); } catch (e) { return JSON.stringify({ threw: e.message, code: e.code }); } })()`;
/** Answer every nested ask this way, recording each one asked and how many starts the host had made when it arrived. */
function answering(host, decision = true) {
    const asked = [], startsAt = [];
    return {
        asked, startsAt,
        onStep: async (bg, ev) => {
            for (const a of ev.asks ?? []) {
                if (a.state !== "pending" || asked.some((x) => x.id === a.id)) continue;
                asked.push(a);
                startsAt.push(host.names().filter((n) => n === "start").length);
                if (decision !== null) void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, ask: a.id, decision } });
            }
        },
    };
}
/** Every argv the host was told to start, resolved back through its spawn records. */
const startedArgvs = (host) => {
    const spawns = host.calls.filter((c) => c.call === "spawn").map((c) => ({ id: c.id, argv: c.args.argv }));
    return host.calls.filter((c) => c.call === "start").map((c) => spawns.find((x) => x.id === c.args.id)?.argv);
};
/** A program's facts as the fake host answers them, holding `fingerprint` and the argv the worker sent. */
const factsOf = (fingerprint = "1:2:3:4", over = {}) => (args) => ({
    argv: args.argv, program: { path: args.argv[0].startsWith("/") ? args.argv[0] : `/usr/local/bin/${args.argv[0]}`, inRoot: false, fingerprint },
    cwd: { path: args.cwd ?? CWD, inRoot: true }, env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: null,
    paths: (args.pathArgs ?? []).map((p) => ({ arg: p.arg, given: args.argv[p.arg], path: `${args.cwd ?? CWD}/${args.argv[p.arg]}`, inRoot: true, secret: false, exists: true })),
    effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox", ...over,
});

// A stored manifest for `tool`, held by the GNU flavour it declares: `--gnu-only` reads, `--write-all` writes, and the
// gnu overlay hardens every call with `--gnu-only`.
const manifest = (over = {}, command = {}) => ({
    program: "tool",
    version: { range: "*", args: [], pattern: "" },
    flavours: {
        gnu: { probe: { args: ["--version"], pattern: "^tool \\(GNU tool\\) (\\d+\\.\\d+)", range: ">=4.3 <5" } },
        bsd: { system: "macos" },
    },
    command: {
        effects: ["read"], paths: "operands", flags: {},
        flavour: { gnu: { flags: { "--gnu-only": { effects: ["read"] }, "--write-all": { effects: ["write"] } }, harden: ["--gnu-only"] } },
        ...command,
    },
    ...over,
});
/** That manifest as a stored global entry pinned to the file the fake host resolves. */
const storedGlobal = (m = manifest(), pin = { path: "/usr/local/bin/tool", fingerprint: "1:2:3:4", inRoot: false }) =>
    ({ ml_manifests_global: [{ id: "man-rt", scope: "global", origin: "person", created: 1, manifest: m, pin }] });
/** The probe answers `version`; every other call exits 0 with "ok". */
const probeSays = (version) => (id, args) => args?.argv.includes("--version") ? { out: `${version}\n`, err: "", code: 0 } : { out: "ok\n", err: "", code: 0 };

// --- A. a flavour the manifest does not hold is never the free one ---

test("RED TEAM: undetected (the probe read a version outside the range), a gnu-only flag still asks", T, async () => {
    const Call = ["/usr/local/bin/tool", "--gnu-only", "a.txt"];
    const host = fakeNativeHost({ done: probeSays("tool (GNU tool) 4.2"), facts: factsOf() });
    const ask = answering(host);
    const { results } = await runOn("userScripts", [runs(Call)], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: storedGlobal() });
    assert.ok(ask.asked.length >= 1, `a gnu-only flag ran free with the flavour undetected: ${JSON.stringify(results?.[0] ?? null).slice(0, 400)}`);
    assert.equal(ask.asked[0].facts.flavour?.name ?? null, null, `the card claims a flavour: ${JSON.stringify(ask.asked[0].facts.flavour)}`);
    assert.match(String(ask.asked[0].facts.flavour?.how ?? ""), /outside >=4\.3 <5/, "the card does not say why the flavour is not read");
    // Only the probe had started when the card arrived: the call waited for the answer.
    assert.equal(ask.startsAt[0], 1, "the call started before the person answered");
    assert.deepEqual(startedArgvs(host), [["/usr/local/bin/tool", "--version"], Call], "the approved call did not start as written, unhardened");
    // The control: the same argv with no gnu-only flag is described and runs free, so the ask above is the flag's.
    const ctl = fakeNativeHost({ done: probeSays("tool (GNU tool) 4.2"), facts: factsOf() });
    const free = answering(ctl);
    const alt = await runOn("userScripts", [runs(["/usr/local/bin/tool", "a.txt"])], { ...NO_FETCH, onNative: ctl.onNative, configExtra: ON, onStep: free.onStep, localExtra: storedGlobal() });
    assert.equal(free.asked.length, 0, `the control asked: ${JSON.stringify(alt.results?.[0] ?? null).slice(0, 300)}`);
    assert.deepEqual(startedArgvs(ctl), [["/usr/local/bin/tool", "--version"], ["/usr/local/bin/tool", "a.txt"]], "the control never started the call, with its probe");
});

test("RED TEAM: a multicall file (`other`) asks even with no flag at all, and its probe is never run", T, async () => {
    const other = factsOf("1:2:3:4", { program: { path: "/usr/local/bin/busybox", inRoot: false, fingerprint: "1:2:3:4" } });
    const host = fakeNativeHost({ done: probeSays("tool (GNU tool) 4.9"), facts: other });
    const ask = answering(host);
    const { results } = await runOn("userScripts", [runs(["/usr/local/bin/tool", "a.txt"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: storedGlobal() });
    assert.ok(ask.asked.length >= 1, `an implementation the manifest does not describe ran free: ${JSON.stringify(results?.[0] ?? null).slice(0, 400)}`);
    assert.equal(ask.asked[0].facts.flavour?.name, "other", `the facts do not say other: ${JSON.stringify(ask.asked[0].facts.flavour)}`);
    assert.equal(ask.startsAt[0], 0, "the call started before the person answered");
    assert.ok(!host.calls.some((c) => c.call === "spawn" && c.args.argv.includes("--version")), "the gnu probe ran for a file of another name");
});

test("RED TEAM: on a host with no sandbox (the person allowed it), the gnu probe never runs and the flag still asks", T, async () => {
    const host = fakeNativeHost({ sandbox: false, done: probeSays("tool (GNU tool) 4.9"), facts: factsOf("1:2:3:4", { sandboxed: false, placement: "host-plain" }) });
    const ask = answering(host);
    const { results } = await runOn("userScripts", [runs(["/usr/local/bin/tool", "--gnu-only", "a.txt"])], { ...NO_FETCH, onNative: host.onNative, configExtra: { ...ON, shellSandbox: false }, onStep: ask.onStep, localExtra: storedGlobal() });
    assert.ok(ask.asked.length >= 1, `a gnu-only flag ran free on a plain host: ${JSON.stringify(results?.[0] ?? null).slice(0, 400)}`);
    assert.equal(ask.startsAt[0], 0, "the call started before the person answered");
    assert.ok(!host.calls.some((c) => c.call === "spawn" && c.args.argv.includes("--version")), "the probe ran on a host with no sandbox to hold it");
});

test("RED TEAM: an in-root program is never flavoured: no probe, and the gnu-only flag asks", T, async () => {
    const inRoot = factsOf("1:2:3:4", { program: { path: "/w/proj/bin/tool", inRoot: true, fingerprint: "1:2:3:4" } });
    const host = fakeNativeHost({ done: probeSays("tool (GNU tool) 4.9"), facts: inRoot });
    const ask = answering(host);
    const entry = { id: "man-rt-w", scope: "workspace", root: "/w/proj", origin: "person", created: 1, manifest: manifest(), pin: { path: "/w/proj/bin/tool", fingerprint: "1:2:3:4", inRoot: true } };
    const { results } = await runOn("userScripts", [runs(["/w/proj/bin/tool", "--gnu-only", "a.txt"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: { ml_manifests_workspace: { "/w/proj": [entry] } } });
    assert.ok(ask.asked.length >= 1, `a gnu-only flag ran free for an in-root program: ${JSON.stringify(results?.[0] ?? null).slice(0, 400)}`);
    assert.equal(flavourOf(manifest(), { path: "/w/proj/bin/tool", inRoot: true }, "macos").flavour, null, "flavourOf flavoured an in-root program");
    assert.equal(ask.startsAt[0], 0, "the call started before the person answered");
    assert.ok(!host.calls.some((c) => c.call === "spawn" && c.args.argv.includes("--version")), "the probe ran for a program the workspace could have written");
});

// --- B. the argv that starts is the hardened one, and the card is that argv, when nobody was asked ---

test("RED TEAM: a FREE call is started hardened, and the card built from the host's own facts shows that argv", T, async () => {
    const seen = [];
    const host = fakeNativeHost({ done: probeSays("tool (GNU tool) 4.9"), facts: (args) => { const f = factsOf()(args); seen.push(f); return f; } });
    const ask = answering(null);
    const { results } = await runOn("userScripts", [runs(["/usr/local/bin/tool", "a.txt"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: storedGlobal() });
    const r = valueOf(results[0]);
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    assert.equal(ask.asked.length, 0, "the call was asked about, so this row measured the asked case instead");
    const spawns = host.calls.filter((c) => c.call === "spawn").map((c) => ({ id: c.id, argv: c.args.argv }));
    assert.deepEqual(spawns.map((x) => x.argv), [["/usr/local/bin/tool", "a.txt"], ["/usr/local/bin/tool", "--version"], ["/usr/local/bin/tool", "--gnu-only", "a.txt"]],
        "the call, its probe, then the hardened call");
    const started = host.calls.filter((c) => c.call === "start").map((c) => spawns.find((x) => x.id === c.args.id)?.argv);
    assert.deepEqual(started, [["/usr/local/bin/tool", "--version"], ["/usr/local/bin/tool", "--gnu-only", "a.txt"]], "only the probe and the hardened call started");
    const hardened = seen.filter((f) => f.argv.includes("a.txt")).at(-1);
    const lines = shCardLines(shFacts(hardened, "4.9", { roots: ROOTS, stored: storedGlobal().ml_manifests_global, platform: "macos" }));
    assert.equal(lines[0].label, "Runs");
    assert.equal(lines[0].value, "/usr/local/bin/tool --gnu-only a.txt", `the card does not show the argv that starts: ${lines[0].value}`);
    assert.match(lines.find((l) => l.label === "Program").value, /GNU, by its version output/);
});

// --- C. `argOrder: "stop"`: a flag-looking operand is an operand, and it is JUDGED ---

test("RED TEAM: stop makes a post-operand flag an operand, which the facts name as a path — never unjudged", T, () => {
    const stop = manifest({}, { flags: { "--write-all": { effects: ["write"] } }, flavour: { gnu: { argOrder: "stop" } } });
    const permute = manifest({}, { flags: { "--write-all": { effects: ["write"] } }, flavour: { gnu: { argOrder: "permute" } } });
    const argv = ["tool", "f.txt", "--write-all"];
    const d = describeCall(argv, stop, { flavour: "gnu" });
    assert.equal(d.described, true, `a stop call was not described: ${JSON.stringify(d.why)}`);
    assert.deepEqual(d.pathArgs.map((p) => [argv[p.arg], p.role]), [["f.txt", "read"], ["--write-all", "read"]],
        "a flag-looking operand after the first is not resolved as a path");
    // What the core cannot express, measured: under permute the same argv claims the WRITE the flag carries; under stop
    // that write is not claimed at all, because the program is said to see a file name. The manifest is the only source
    // of this claim, so the row pins that the operand is at least judged, not that the effect is the right one.
    const p = describeCall(argv, permute, { flavour: "gnu" });
    assert.ok(JSON.stringify(p.effects).includes('"write"'), `permute lost the write: ${JSON.stringify(p.effects)}`);
    assert.ok(!JSON.stringify(d.effects).includes('"write"'), `stop still claimed the write: ${JSON.stringify(d.effects)}`);
    // Undetected, the same manifest asks (the operand is read as a whole call).
    assert.equal(describeCall(argv, stop, {}).described, false, "an undetected flavour described a post-operand flag");
});

test("RED TEAM: a stop call through ml.sh has the host resolve the flag-looking operand, so it is judged end to end", T, async () => {
    const stop = manifest({}, { flags: { "--write-all": { effects: ["write"] } }, flavour: { gnu: { argOrder: "stop" } } });
    const host = fakeNativeHost({ done: probeSays("tool (GNU tool) 4.9"), facts: factsOf() });
    const ask = answering(null);
    const { results } = await runOn("userScripts", [runs(["/usr/local/bin/tool", "f.txt", "--write-all"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: storedGlobal(stop) });
    const r = valueOf(results[0]);
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    const hardened = host.calls.filter((c) => c.call === "spawn").map((c) => c.args).filter((a) => a.argv.includes("f.txt")).at(-1);
    assert.deepEqual(hardened.pathArgs.map((p) => p.arg), [1, 2], `the host was not asked to resolve the flag-looking operand: ${JSON.stringify(hardened.pathArgs)}`);
    assert.equal(ask.asked.length, 0, "the stop call asked, so the row measured a card instead");
});

// MEASURED at 775a0365, and it holds: the card a person approves a draft on is the key, the pin, and this run's calls
// DERIVED through the draft — and the draft's version is never read ("its version is read only once it is approved"),
// so `flavourOf` detects nothing and `argOrder: "stop"` cannot make a draft's own call look free. The same manifest
// whose `flags` give `--write-all` a write reads "unknown, asks" on its approval card, which is the safe direction.
// What the card cannot show is the manifest BODY's parsing claims; the free reading stop produces exists only once the
// version is read, i.e. after approval, and then there is no card.
test("RED TEAM: the approval card never shows a flavoured free reading of a draft, whose version it has not read", T, async () => {
    const stop = manifest({}, { flags: { "--write-all": { effects: ["write"] } }, flavour: { gnu: { argOrder: "stop" } } });
    let seen = null;
    const facts = factsOf();
    const host = fakeNativeHost({ done: probeSays("tool (GNU tool) 4.9"), facts: (a) => { const f = facts(a); if (a.argv.includes("--write-all")) seen = f; return f; } });
    const ask = answering(null);
    const { results } = await runOn("userScripts", [runs(["/usr/local/bin/tool", "f.txt", "--write-all"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: storedGlobal(stop) });
    assert.ok(seen, `the stop call was never resolved: ${JSON.stringify(results?.[0] ?? null).slice(0, 300)}`);
    // The draft's own reading: the version null, exactly what `draftCardNote` passes.
    const f = shFacts(seen, null, { roots: ROOTS, stored: storedGlobal(stop).ml_manifests_global, platform: "macos" });
    assert.equal(f.described, false, "a draft, whose version nothing read, was described with a flavour");
    const note = draftNote({ manifest: stop, pin: { path: "/usr/local/bin/tool", fingerprint: "1:2:3:4", inRoot: false }, scope: "global", origin: "person" }, undefined, [{ argv: seen.argv, facts: f, free: f.described }], true);
    const derived = note.slice(note.indexOf("DERIVED, nothing run:"), note.indexOf("Approved, it describes"));
    assert.ok(derived.includes("--write-all"), `the derived reading does not name the argument: ${derived}`);
    assert.ok(derived.includes("asks") && !derived.includes(", free"), `the approval card showed a free reading for an undetected draft: ${derived}`);
});

// --- D. a stored manifest's overlays buy nothing a core-only manifest would not ---

test("RED TEAM: a flags-only gnu overlay describes every argv exactly as the same flags declared in the core", T, () => {
    const flags = { "-w": { effects: ["write"] }, "--gnu-only": { effects: ["read"] }, "--out": { value: true, valueIsPath: "write" } };
    const overlay = manifest({}, { flags: { "-i": { effects: ["write"] } }, flavour: { gnu: { flags } } });
    const core = { program: "tool", version: { range: "*", args: [], pattern: "" }, command: { effects: ["read"], paths: "operands", flags: { "-i": { effects: ["write"] }, ...flags } } };
    const pick = (d) => JSON.stringify({ described: d.described, why: d.why, pathArgs: d.pathArgs, effects: d.effects });
    for (const argv of [
        ["tool", "f.txt"], ["tool", "-i", "f.txt"], ["tool", "--gnu-only", "f.txt"], ["tool", "--out", "o.txt", "f.txt"],
        ["tool", "--out=o.txt", "f.txt"], ["tool", "-w", "f.txt"], ["tool", "f.txt", "-w"], ["tool", "-x", "f.txt"],
    ]) assert.equal(pick(describeCall(argv, overlay, { flavour: "gnu" })), pick(describeCall(argv, core, {})), `the overlay described ${argv.join(" ")} differently from the core`);
});

// MEASURED at 775a0365: the probe's argv is the manifest's (`flavours.gnu.probe.args`), so a stored manifest can make
// the program print the very line its anchored pattern reads — the argument, echoed at a line start — and `flavourOf`
// then reports GNU for any file the run could call. The row asserts the property; red, it is a finding for the lane:
// detection is the manifest's claim, not a measurement of the program.
test("RED TEAM: an anchored probe pattern cannot be satisfied by a line the program prints from the probe's own argv", T, async () => {
    const echo = {
        program: "tool", version: { range: "*", args: [], pattern: "" },
        flavours: { gnu: { probe: { args: ["tool (GNU tool) 4.9"], pattern: "^tool \\(GNU tool\\) (\\d+\\.\\d+)", range: ">=4.3 <5" } } },
        command: { effects: ["read"], paths: "operands", flags: {}, flavour: { gnu: { flags: { "--gnu-only": { effects: ["read"] } } } } },
    };
    // The program prints each argument on its own line: the manifest chose the argument, so the pattern reads it back.
    const host = fakeNativeHost({ done: (id, args) => ({ out: args.argv.slice(1).join("\n") + "\n", err: "", code: 0 }), facts: factsOf() });
    const ask = answering(null);
    const { results } = await runOn("userScripts", [runs(["/usr/local/bin/tool", "--gnu-only", "a.txt"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: storedGlobal(echo) });
    assert.ok(ask.asked.length >= 1, `the probe's own argv satisfied its pattern, so the overlay's flag was free: ${JSON.stringify(results?.[0] ?? null).slice(0, 400)}`);
    assert.ok(!host.names().includes("start"), "a call started before the person answered");
});

// The other half of that measurement, and why it is not new: a stored manifest reads the same free probe out of its
// `version.args` (whatever the range), so a flavoured manifest buys no execution a core-only one could not ask for.
test("the probe-args surface is the version-args one: a core-only stored manifest gets the same free probe spawn", T, async () => {
    const viaVersion = { program: "tool", version: { range: ">=1", args: ["--version"], pattern: "^tool \\(GNU tool\\) (\\d+\\.\\d+)" }, command: { effects: ["read"], paths: "operands", flags: {} } };
    const host = fakeNativeHost({ done: probeSays("tool (GNU tool) 4.9"), facts: factsOf() });
    const ask = answering(null);
    const { results } = await runOn("userScripts", [runs(["/usr/local/bin/tool", "a.txt"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: storedGlobal(viaVersion) });
    assert.equal(valueOf(results[0]).ok, true);
    assert.deepEqual(host.calls.filter((c) => c.call === "spawn").map((c) => c.args.argv), [["/usr/local/bin/tool", "a.txt"], ["/usr/local/bin/tool", "--version"]],
        "the core-only manifest's probe is not the same free spawn");
    assert.equal(ask.asked.length, 0, "the version probe asked");
});
