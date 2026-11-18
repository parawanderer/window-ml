// redteam-flavours.test.mjs — program-manifest FLAVOURS (window-ml#1963, branch manifests/flavours at 11c832e1),
// adversarially: what a manifest's declaration of `flavours`, its probe and its per-flavour overlays must NOT buy.
// PROGRAM_MANIFEST.md, "Flavours". The lane's own rows (tests/ml-sh.test.mjs) pin the asked call's hardened argv and
// the fingerprint swap; these measure the four cases where the flavour is NOT read (a stored manifest, `other`, a plain
// host, an in-root program), the free call's card, `argOrder: "stop"` (a post-operand flag the manifest DECLARES must
// ask), the bsd route a stored manifest still reaches, the approval card and its note, a flags-only overlay against
// the core, `isShipped`'s identity rule, and the probe's own argv, which the manifest chooses.
//
// At 775a0365 a stored manifest's gnu probe RAN and its overlay then applied, and a stop overlay dropped a declared
// write after an operand; 11c832e1 removed both (`flavourOf` takes `shipped`, `stopShadow` asks). The rows that
// measured the old behaviour as a finding are, below, the properties that now hold, each saying what it replaced.
//
// One `// ---` section per property. A row written as the property and MEASURED red says so in its comment and is a
// finding for the lane, not a passing check.
//
// Known gap: no SHIPPED manifest declares `flavours` yet (src/shell/manifests/*.json), so the gnu re-spawn (a probe
// that decides, then `flavourReplan`) has no end-to-end row here; `flavourOf`'s ordering for a shipped manifest is
// measured pure, and the harness cannot register a shipped fixture (`SHIPPED_MANIFESTS` is the imported bytes).

import { test } from "node:test";
import assert from "node:assert/strict";
import { runOn } from "./isolated-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";
import { describeCall, flavourOf, shippedOnlyRefusal } from "../src/shell/program-manifest.ts";
import { SHIPPED_MANIFESTS, isShipped, shCardLines, shFacts } from "../src/shell/sh-call.ts";
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
/** Every argv the host was told to spawn, in order. */
const spawnedArgvs = (host) => host.calls.filter((c) => c.call === "spawn").map((c) => c.args.argv);
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
/** A draft entry for `m`, as the approval card is built from. */
const draftOf = (m) => ({ manifest: m, pin: { path: "/usr/local/bin/tool", fingerprint: "1:2:3:4", inRoot: false }, scope: "global", origin: "person" });
/** Which flavour `flavourOf` names for a stored manifest, given what a probe would have read. */
const storedFlavour = (m, probed = "4.9") => flavourOf(m, { path: "/usr/local/bin/tool", inRoot: false }, "macos", probed, false);

// --- A. a flavour the manifest does not hold is never the free one ---

// At 775a0365 this row measured the probe read a version outside the range; at 11c832e1 a stored manifest's probe is
// never run at all, so the same call is undetected for a stronger reason and the overlay's flag asks. What the row
// keeps: nothing of the declaration is executed, and the card says why in the rule's own words.
test("RED TEAM: a stored manifest's gnu probe never spawns, and the flag only its overlay declares asks", T, async () => {
    const Call = ["/usr/local/bin/tool", "--gnu-only", "a.txt"];
    const host = fakeNativeHost({ done: probeSays("tool (GNU tool) 4.9"), facts: factsOf() });
    const ask = answering(host);
    const { results } = await runOn("userScripts", [runs(Call)], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: storedGlobal() });
    assert.ok(ask.asked.length >= 1, `a gnu-only flag ran free with the flavour undetected: ${JSON.stringify(results?.[0] ?? null).slice(0, 400)}`);
    assert.equal(ask.asked[0].facts.flavour?.name ?? null, null, `the card claims a flavour: ${JSON.stringify(ask.asked[0].facts.flavour)}`);
    assert.match(String(ask.asked[0].facts.flavour?.how ?? ""), /a stored manifest's gnu probe is never run/, "the card does not say why the flavour is not read");
    assert.equal(ask.startsAt[0], 0, "the call started before the person answered");
    assert.deepEqual(startedArgvs(host), [Call], "the approved call did not start as written, unhardened");
    assert.ok(!spawnedArgvs(host).some((a) => a.includes("--version")), `the manifest's own probe args were spawned: ${JSON.stringify(spawnedArgvs(host))}`);
});

// The ordering `flavourOf` applies to a SHIPPED manifest, pure: not read means "run the probe", a read outside the
// range is undetected and says the range, and a read inside it is gnu. This is the case a stored manifest can no
// longer reach, kept so the rule it lost is still pinned.
test("RED TEAM: for a shipped manifest the probe decides, and only a version in its range is gnu", T, () => {
    const m = manifest();
    assert.deepEqual(flavourOf(m, { path: "/usr/local/bin/tool", inRoot: false }, "macos", undefined, true), { flavour: null, how: "not detected (its version was not read)", probe: true });
    const out = flavourOf(m, { path: "/usr/local/bin/tool", inRoot: false }, "macos", "4.2", true);
    assert.equal(out.flavour, null);
    assert.match(out.how, /version 4\.2 is outside >=4\.3 <5/);
    assert.equal(flavourOf(m, { path: "/usr/local/bin/tool", inRoot: false }, "macos", "4.9", true).flavour, "gnu");
    // And the same four readings for a stored manifest: never gnu, never a probe, whatever it would have read.
    for (const probed of [undefined, null, "4.2", "4.9"]) {
        const s = storedFlavour(m, probed);
        assert.equal(s.flavour, null, `a stored manifest was flavoured gnu from ${String(probed)}`);
        assert.equal(s.probe, false, "a stored manifest asked for its probe to be run");
        assert.match(s.how, /a stored manifest's gnu probe is never run/);
    }
});

// At 775a0365 this row measured the probe's argv being the manifest's (`flavours.gnu.probe.args`), so a stored
// manifest could make the program print the very line its anchored pattern read. At 11c832e1 the probe is never run
// for stored bytes, so the argument is never passed to the program at all.
test("RED TEAM: a stored probe's own argv is never spawned, so its pattern cannot be satisfied from it", T, async () => {
    const echo = {
        program: "tool", version: { range: "*", args: [], pattern: "" },
        flavours: { gnu: { probe: { args: ["tool (GNU tool) 4.9"], pattern: "^tool \\(GNU tool\\) (\\d+\\.\\d+)", range: ">=4.3 <5" } } },
        command: { effects: ["read"], paths: "operands", flags: {}, flavour: { gnu: { flags: { "--gnu-only": { effects: ["read"] } } } } },
    };
    // The program prints each argument on its own line: had the probe run, the pattern would read the echo back.
    const host = fakeNativeHost({ done: (id, args) => ({ out: args.argv.slice(1).join("\n") + "\n", err: "", code: 0 }), facts: factsOf() });
    const ask = answering(host, false);
    const { results } = await runOn("userScripts", [runs(["/usr/local/bin/tool", "--gnu-only", "a.txt"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: storedGlobal(echo) });
    assert.ok(!spawnedArgvs(host).some((a) => a.includes("tool (GNU tool) 4.9")), `the probe's chosen argv reached the program: ${JSON.stringify(spawnedArgvs(host))}`);
    assert.ok(ask.asked.length >= 1, `the overlay's flag was free: ${JSON.stringify(results?.[0] ?? null).slice(0, 400)}`);
    assert.ok(!host.names().includes("start"), "a call started although the card was denied");
});

// The other half of that measurement, and why it is not new: a stored manifest reads the same free probe out of its
// `version.args` (whatever the range), so a flavoured manifest buys no execution a core-only one could not ask for.
test("the probe-args surface is the version-args one: a core-only stored manifest gets the same free probe spawn", T, async () => {
    const viaVersion = { program: "tool", version: { range: ">=1", args: ["--version"], pattern: "^tool \\(GNU tool\\) (\\d+\\.\\d+)" }, command: { effects: ["read"], paths: "operands", flags: {} } };
    const host = fakeNativeHost({ done: probeSays("tool (GNU tool) 4.9"), facts: factsOf() });
    const ask = answering(null);
    const { results } = await runOn("userScripts", [runs(["/usr/local/bin/tool", "a.txt"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: storedGlobal(viaVersion) });
    assert.equal(valueOf(results[0]).ok, true);
    assert.deepEqual(spawnedArgvs(host), [["/usr/local/bin/tool", "a.txt"], ["/usr/local/bin/tool", "--version"]],
        "the core-only manifest's probe is not the same free spawn");
    assert.equal(ask.asked.length, 0, "the version probe asked");
});

test("RED TEAM: a multicall file (`other`) asks even with no flag at all, and its probe is never run", T, async () => {
    const other = factsOf("1:2:3:4", { program: { path: "/usr/local/bin/busybox", inRoot: false, fingerprint: "1:2:3:4" } });
    const host = fakeNativeHost({ done: probeSays("tool (GNU tool) 4.9"), facts: other });
    const ask = answering(host);
    const { results } = await runOn("userScripts", [runs(["/usr/local/bin/tool", "a.txt"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: storedGlobal() });
    assert.ok(ask.asked.length >= 1, `an implementation the manifest does not describe ran free: ${JSON.stringify(results?.[0] ?? null).slice(0, 400)}`);
    assert.equal(ask.asked[0].facts.flavour?.name, "other", `the facts do not say other: ${JSON.stringify(ask.asked[0].facts.flavour)}`);
    assert.equal(ask.startsAt[0], 0, "the call started before the person answered");
    assert.ok(!spawnedArgvs(host).some((a) => a.includes("--version")), "the gnu probe ran for a file of another name");
});

test("RED TEAM: on a host with no sandbox (the person allowed it), the gnu probe never runs and the flag still asks", T, async () => {
    const host = fakeNativeHost({ sandbox: false, done: probeSays("tool (GNU tool) 4.9"), facts: factsOf("1:2:3:4", { sandboxed: false, placement: "host-plain" }) });
    const ask = answering(host);
    const { results } = await runOn("userScripts", [runs(["/usr/local/bin/tool", "--gnu-only", "a.txt"])], { ...NO_FETCH, onNative: host.onNative, configExtra: { ...ON, shellSandbox: false }, onStep: ask.onStep, localExtra: storedGlobal() });
    assert.ok(ask.asked.length >= 1, `a gnu-only flag ran free on a plain host: ${JSON.stringify(results?.[0] ?? null).slice(0, 400)}`);
    assert.equal(ask.startsAt[0], 0, "the call started before the person answered");
    assert.ok(!spawnedArgvs(host).some((a) => a.includes("--version")), "the probe ran on a host with no sandbox to hold it");
});

test("RED TEAM: an in-root program is never flavoured: no probe, and the gnu-only flag asks", T, async () => {
    const inRoot = factsOf("1:2:3:4", { program: { path: "/w/proj/bin/tool", inRoot: true, fingerprint: "1:2:3:4" } });
    const host = fakeNativeHost({ done: probeSays("tool (GNU tool) 4.9"), facts: inRoot });
    const ask = answering(host);
    const entry = { id: "man-rt-w", scope: "workspace", root: "/w/proj", origin: "person", created: 1, manifest: manifest(), pin: { path: "/w/proj/bin/tool", fingerprint: "1:2:3:4", inRoot: true } };
    const { results } = await runOn("userScripts", [runs(["/w/proj/bin/tool", "--gnu-only", "a.txt"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: { ml_manifests_workspace: { "/w/proj": [entry] } } });
    assert.ok(ask.asked.length >= 1, `a gnu-only flag ran free for an in-root program: ${JSON.stringify(results?.[0] ?? null).slice(0, 400)}`);
    assert.equal(flavourOf(manifest(), { path: "/w/proj/bin/tool", inRoot: true }, "macos", "4.9", true).flavour, null, "flavourOf flavoured an in-root program");
    assert.equal(ask.startsAt[0], 0, "the call started before the person answered");
    assert.ok(!spawnedArgvs(host).some((a) => a.includes("--version")), "the probe ran for a program the workspace could have written");
});

// --- B. a stored manifest's overlay buys nothing: the argv as written starts, and the card says why ---

// At 775a0365 this row measured the call started hardened with `--gnu-only` and the card named the flavour. At
// 11c832e1 the overlay is never applied to a stored manifest and nothing probes for it: one spawn, the argv as
// written, and the Program line names the rule that kept it undetected.
test("RED TEAM: a stored manifest's gnu overlay is never applied, and the card says the probe was not run", T, async () => {
    const seen = [];
    const host = fakeNativeHost({ done: probeSays("tool (GNU tool) 4.9"), facts: (args) => { const f = factsOf()(args); seen.push(f); return f; } });
    const ask = answering(null);
    const { results } = await runOn("userScripts", [runs(["/usr/local/bin/tool", "a.txt"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: storedGlobal() });
    const r = valueOf(results[0]);
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    assert.equal(ask.asked.length, 0, "a call that needs no flag of the overlay asked");
    assert.deepEqual(spawnedArgvs(host), [["/usr/local/bin/tool", "a.txt"]], "the call was probed, hardened or re-spawned for a stored manifest");
    const place = { roots: ROOTS, stored: storedGlobal().ml_manifests_global, platform: "macos" };
    const lines = shCardLines(shFacts(seen.at(-1), null, place));
    assert.equal(lines[0].label, "Runs");
    assert.equal(lines[0].value, "/usr/local/bin/tool a.txt", `the card does not show the argv that starts: ${lines[0].value}`);
    assert.match(lines.find((l) => l.label === "Program").value, /not detected \(a stored manifest's gnu probe is never run/);
    // Even given a version, a stored manifest's flavour is not read, so no card can claim GNU for it.
    assert.equal(shFacts(seen.at(-1), "4.9", place).flavour.name, null, "a version handed to a stored manifest's facts made it gnu");
});

// --- C. `argOrder: "stop"`: a post-operand flag the manifest DECLARES asks ---

// At 775a0365 this row measured stop dropping the write `--write-all` carries (the operand was a path, free). At
// 11c832e1 the declaration wins: a flag that does more than read, met after an operand, is a contradiction the
// describer refuses, so the call asks and the card says which flag.
test("RED TEAM: stop makes a declared post-operand flag ask, naming it; a read-only one stays a path", T, () => {
    const stop = manifest({}, { flags: { "--write-all": { effects: ["write"] } }, flavour: { gnu: { argOrder: "stop" } } });
    const argv = ["tool", "f.txt", "--write-all"];
    const d = describeCall(argv, stop, { flavour: "gnu" });
    assert.equal(d.described, false, "a stop call with a declared write after an operand was described free");
    assert.match(d.why.join(" "), /--write-all follows an operand: this flavour reads it as a file name, but --write-all is a flag that does more than read/);
    // The write the flag carries is never claimed as a read path while the call asks: the refusal is the whole answer.
    assert.equal(d.pathArgs.some((p) => argv[p.arg] === "--write-all" && p.role === "read" && d.described), false);
    // Under permute the same flag writes, so the declaration is what was judged, not the order alone.
    const permute = manifest({}, { flags: { "--write-all": { effects: ["write"] } }, flavour: { gnu: { argOrder: "permute" } } });
    assert.ok(JSON.stringify(describeCall(argv, permute, { flavour: "gnu" }).effects).includes('"write"'), "permute lost the write the flag carries");
    // A declared flag that only reads is still a path after an operand (stop is a claim about the program's parse).
    const read = manifest({}, { flags: { "--count": { effects: ["read"] } }, flavour: { gnu: { argOrder: "stop" } } });
    const r = describeCall(["tool", "f.txt", "--count"], read, { flavour: "gnu" });
    assert.equal(r.described, true, `a read-only flag after an operand was refused: ${JSON.stringify(r.why)}`);
    assert.deepEqual(r.pathArgs.map((p) => [["tool", "f.txt", "--count"][p.arg], p.role]), [["f.txt", "read"], ["--count", "read"]]);
    // Undetected, the same manifest asks whatever argOrder it claims.
    assert.equal(describeCall(argv, stop, {}).described, false, "an undetected flavour described a post-operand flag");
    // A flag-like operand the manifest does NOT declare stays a read path: under stop the program reads it as a file
    // name, and nothing in the manifest says otherwise.
    assert.equal(describeCall(["tool", "f.txt", "--nobody-declared-this"], stop, { flavour: "gnu" }).described, true);
});

// The spellings the shadow check has to see through, and the one terminator that still ends options: a `--` the
// command honours, given before any operand, is not a post-operand token at all.
test("RED TEAM: stop's refusal catches every spelling of a declared flag, and an honoured -- still ends options", T, () => {
    const m = manifest({}, {
        flags: { "--write": { effects: ["write"] }, "-w": { effects: ["write"] }, "--out": { value: true, valueIsPath: "write" }, "-o": { value: true, valueIsPath: "write" } },
        flavour: { gnu: { argOrder: "stop" } },
    });
    for (const argv of [
        ["tool", "f.txt", "--write"], ["tool", "f.txt", "--write=v"], ["tool", "f.txt", "-w"], ["tool", "f.txt", "-xw"],
        ["tool", "f.txt", "-wv"], ["tool", "f.txt", "--out", "o.txt"], ["tool", "f.txt", "--out=o.txt"], ["tool", "f.txt", "-ofile"],
    ]) {
        const d = describeCall(argv, m, { flavour: "gnu" });
        assert.equal(d.described, false, `${argv.join(" ")} was described free`);
        assert.match(d.why.join(" "), /follows an operand: this flavour reads it as a file name, but /, `${argv.join(" ")}: no shadow reason`);
    }
    const honoured = manifest({}, { terminator: "--", flags: { "--write": { effects: ["write"] } }, flavour: { gnu: { argOrder: "stop" } } });
    const h = describeCall(["tool", "--", "--write", "f.txt"], honoured, { flavour: "gnu" });
    assert.equal(h.described, true, `an honoured -- did not end options: ${JSON.stringify(h.why)}`);
    assert.deepEqual(h.pathArgs.map((p) => [p.arg, p.role]), [[2, "read"], [3, "read"]], "the arguments after -- are not both operands");
    // A `--` the command does NOT honour is said so, and the call asks.
    const n = describeCall(["tool", "--", "--write", "f.txt"], m, { flavour: "gnu" });
    assert.equal(n.described, false, "a -- this command does not honour was taken as a terminator");
    assert.match(n.why.join(" "), /-- is not a terminator this command honours/);
});

// At 775a0365 this row measured the stop call running free with the host resolving `--write-all` as a path. At
// 11c832e1 it asks: one card, the argv as written, and the call starts only once answered.
test("RED TEAM: a stop call through ml.sh asks with the argv as written, and starts it only once answered", T, async () => {
    const stop = manifest({}, { flags: { "--write-all": { effects: ["write"] } }, flavour: { gnu: { argOrder: "stop" } } });
    const call = ["/usr/local/bin/tool", "f.txt", "--write-all"];
    const host = fakeNativeHost({ done: probeSays("tool (GNU tool) 4.9"), facts: factsOf() });
    const ask = answering(host);
    const { results } = await runOn("userScripts", [runs(call)], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: storedGlobal(stop) });
    assert.equal(ask.asked.length, 1, `the stop call did not ask once: ${JSON.stringify(results?.[0] ?? null).slice(0, 300)}`);
    assert.equal(ask.startsAt[0], 0, "something started before the person answered");
    assert.equal(ask.asked[0].facts.described, false, "the card's facts describe a call the describer refused");
    assert.equal(ask.asked[0].facts.flavour?.name ?? null, null, `the card claims a flavour: ${JSON.stringify(ask.asked[0].facts.flavour)}`);
    assert.deepEqual(startedArgvs(host), [call], "the approved call did not start as written");
    assert.ok(!spawnedArgvs(host).some((a) => a.includes("--version")), "the stored manifest's probe ran");
});

// MEASURED at 11c832e1, and it holds: the card a person approves a draft on is the key, the pin, and this run's calls
// DERIVED through the draft — and the draft's version is never read ("its version is read only once it is approved"),
// so `flavourOf` detects nothing and `argOrder: "stop"` cannot make a draft's own call look free. What the card cannot
// show is the manifest BODY's parsing claims; the reading stop produces exists only once the version is read, and
// with 11c832e1 that is only for shipped bytes, whose body the person is not approving.
test("RED TEAM: the approval card never shows a flavoured free reading of a draft, whose version it has not read", T, async () => {
    const stop = manifest({}, { flags: { "--write-all": { effects: ["write"] } }, flavour: { gnu: { argOrder: "stop" } } });
    let seen = null;
    const facts = factsOf();
    const host = fakeNativeHost({ done: probeSays("tool (GNU tool) 4.9"), facts: (a) => { const f = facts(a); if (a.argv.includes("--write-all")) seen = f; return f; } });
    const ask = answering(host, false);
    const { results } = await runOn("userScripts", [runs(["/usr/local/bin/tool", "f.txt", "--write-all"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: storedGlobal(stop) });
    assert.ok(seen, `the stop call was never resolved: ${JSON.stringify(results?.[0] ?? null).slice(0, 300)}`);
    const f = shFacts(seen, null, { roots: ROOTS, stored: storedGlobal(stop).ml_manifests_global, platform: "macos" });
    assert.equal(f.described, false, "a draft, whose version nothing read, was described with a flavour");
    const note = draftNote(draftOf(stop), undefined, [{ argv: seen.argv, facts: f, free: f.described }], true);
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

// --- E. the bsd route a stored manifest still reaches ---

// A stored manifest IS read as bsd when its file sits in the macOS system directory: the claim is about where the file
// is, not about a probe, so `flavourOf` makes it running nothing — and the stop rule holds there too.
test("RED TEAM: a stored manifest in the macOS system directory is bsd with no probe, and its stop write asks", T, async () => {
    const bsd = {
        program: "tool", version: { range: "*", args: [], pattern: "" }, flavours: { bsd: { system: "macos" } },
        command: { effects: ["read"], paths: "operands", flags: { "--write": { effects: ["write"] }, "--read": { effects: ["read"] } }, flavour: { bsd: { argOrder: "stop" } } },
    };
    assert.deepEqual(flavourOf(bsd, { path: "/usr/bin/tool", inRoot: false }, "macos", undefined, false), { flavour: "bsd", how: "BSD (the macOS system program)", probe: false });
    assert.equal(describeCall(["tool", "f.txt", "--write"], bsd, { flavour: "bsd" }).described, false, "the bsd stop rule did not catch a declared write after an operand");
    const call = ["/usr/bin/tool", "f.txt", "--write"];
    const host = fakeNativeHost({ done: () => ({ out: "ok\n", err: "", code: 0 }), facts: factsOf() });
    const ask = answering(host);
    const { results } = await runOn("userScripts", [runs(call)], {
        ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep,
        localExtra: { ml_manifests_global: [{ id: "man-b", scope: "global", origin: "person", created: 1, manifest: bsd, pin: { path: "/usr/bin/tool", fingerprint: "1:2:3:4", inRoot: false } }] },
    });
    assert.equal(ask.asked.length, 1, `the bsd stop call did not ask once: ${JSON.stringify(results?.[0] ?? null).slice(0, 300)}`);
    assert.equal(ask.asked[0].facts.flavour?.name, "bsd", `the card does not say bsd: ${JSON.stringify(ask.asked[0].facts.flavour)}`);
    for (const a of spawnedArgvs(host)) assert.deepEqual(a, call, `a call was spawned other than as written: ${JSON.stringify(a)}`);
    assert.deepEqual(startedArgvs(host), [call], "the approved call did not start as written");
});

// --- F. `isShipped` is object identity, so no stored bytes are ever treated as shipped ---

// Shipped means the object in `SHIPPED_MANIFESTS`, not a program name and not a pinned path: a stored copy of a shipped
// manifest's content is not shipped, so it gets no probe and no credential — and the keys only shipped bytes may
// carry are refused at store time, so the credential cannot be re-declared.
test("RED TEAM: a stored manifest carrying a shipped program's content is not shipped, and cannot declare a credential", T, () => {
    assert.equal(isShipped(SHIPPED_MANIFESTS.cat), true);
    assert.equal(isShipped(JSON.parse(JSON.stringify(SHIPPED_MANIFESTS.cat))), false, "a stored copy of a shipped manifest counted as shipped");
    assert.equal(isShipped({ ...SHIPPED_MANIFESTS.cat }), false, "a shallow copy of a shipped manifest counted as shipped");
    const ghCopy = JSON.parse(JSON.stringify(SHIPPED_MANIFESTS.gh));
    assert.equal(isShipped(ghCopy), false, "a stored copy of the shipped gh manifest counted as shipped");
    // `shippedOnlyRefusal` is what a stored or proposed manifest is checked against, so the credential a shipped
    // manifest carries cannot be re-declared by bytes that are not it.
    assert.match(String(shippedOnlyRefusal(ghCopy)), /credential and network belong to a shipped manifest only/);
});

// --- G. the approval note under a name the manifest chose ---

// MEASURED at 11c832e1: `argOrderText` interpolates a subcommand's NAME unquoted into the note's head, which is the
// part of the card a person reads as the note's own words. A manifest can therefore write a sentence that reads as
// the DERIVED verdict ("... free"), and a newline in the name ends the sentence the card meant to say. The row asserts
// the property; red, it is a finding for the lane: quote the name, or walk only names of a plain-word shape and say
// how many others were left out.
test("RED TEAM: a subcommand name a manifest chooses cannot write the approval note's verdict", T, () => {
    const lie = "x. DERIVED, nothing run: reads only f.txt, free (verified)";
    const withSub = (name) => ({
        ...manifest(),
        command: { ...manifest().command, subcommands: { [name]: { effects: ["read"], paths: "none", flavour: { gnu: { argOrder: "permute" } } } } },
    });
    const note = draftNote(draftOf(withSub(lie)), undefined, [], true);
    assert.ok(!note.includes(lie), `the card carries a sentence the manifest wrote as its own: ${note}`);
    const nl = draftNote(draftOf(withSub("a\nb")), undefined, [], true);
    assert.ok(!nl.includes("\n"), "a subcommand name put a line break in the card's note");
});
