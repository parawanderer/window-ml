// ml-sh.test.mjs — `ml.sh` from an approved exec of a worker-built run (src/sw/sw-shell-call.ts): the script names it, the
// exec runs in an isolated world, and each call goes to the worker over that world's channel. The worker resolves it
// through the process host (tests/fake-native-host.mjs), lets a policy or the built-in default answer, or asks the
// person inside the running step, judges it again before the start, and hands back each output's head and pointer.
// What no page may reach is in tests/redteam.test.js and tests/ml-sh-redteam.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runOn } from "./isolated-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";

const T = { timeout: Number(process.env.ML_SH_T) || 60000 };
const ON = { shellEnabled: true, shellRoots: ["/w/proj"] };
const NO_FETCH = { fetches: [] };

/** The value an exec returned, parsed from the result the model read (`value: <json>`). */
function valueOf(result) {
    const m = /^value: (.*)$/m.exec(result) ?? /^(\{.*\})$/m.exec(result);
    assert.ok(m, `no value in: ${result}`);
    return JSON.parse(m[1]);
}

/** A script that runs `argv` through ml.sh and returns what it got, or what it threw. */
const runs = (argv, opts) => () => `(async () => { try { return JSON.stringify(await ml.sh.run(${JSON.stringify(argv)}${opts ? `, ${JSON.stringify(opts)}` : ""})); } catch (e) { return JSON.stringify({ threw: e.message, code: e.code }); } })()`;

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

// --- a call no one needs to be asked about ---

test("a described call inside the roots, under the sandbox, runs without a card: its head and pointer come back", T, async () => {
    const host = fakeNativeHost({ done: () => ({ out: "a.txt\nb.txt\n", err: "", code: 0 }) });
    const ask = answering(true);
    const { results } = await runOn("userScripts", [runs(["ls"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    const r = valueOf(results[0]);
    assert.equal(r.ok, true);
    assert.equal(r.stdout.text, "a.txt\nb.txt\n");
    assert.match(r.stdout.token, /^@tool:[0-9a-f]{7}$/);
    // Read from the host's own record: the harness's server is named `host`, which the model-facing scrub rewrites.
    assert.equal(host.calls.find((c) => c.call === "configure").args.sandbox, true);
    assert.match(r.ran, /-sandbox$/);
    assert.equal(r.approvedBy, "builtin");
    assert.equal(ask.asked.length, 0, "no card");
    assert.deepEqual(host.names().filter((n) => n !== "read" && n !== "release"), ["hello", "configure", "spawn", "start"]);
    assert.match(results[0], /it runs programs through ml\.sh/, "the exec ran in an isolated world for it");
});

// --- a call the person is asked about ---

test("an undescribed program asks inside the running step, showing the host's facts; allowed, it runs and says it waited", T, async () => {
    const host = fakeNativeHost();
    const ask = answering(true);
    const { results } = await runOn("userScripts", [runs(["python3", "x.py"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    assert.equal(ask.asked.length, 1);
    const a = ask.asked[0];
    assert.equal(a.kind, "sh");
    assert.equal(JSON.stringify(a.facts.argv), JSON.stringify(["python3", "x.py"]));
    assert.equal(a.facts.program.path, "/usr/bin/python3");
    assert.equal(a.facts.effects, "unknown");
    assert.equal(a.facts.placement, "host-sandbox");
    const r = valueOf(results[0]);
    assert.deepEqual([r.ok, r.approvedBy], [true, "person"]);
    assert.equal(typeof r.waitedMs, "number");
    assert.ok(host.names().includes("start"));
});

test("declined, the call throws Denied in the script, and the host discards it without starting anything", T, async () => {
    const host = fakeNativeHost();
    const ask = answering(false);
    const { results } = await runOn("userScripts", [runs(["python3", "x.py"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    const r = valueOf(results[0]);
    assert.equal(r.code, "Denied");
    assert.match(r.threw, /declined/);
    assert.ok(host.names().includes("discard"));
    assert.ok(!host.names().includes("start"), "nothing started");
});

test("a write inside the roots is free under the sandbox, and asks on the plain host, where nothing bounds it", T, async () => {
    for (const sandbox of [true, false]) {
        const host = fakeNativeHost({ sandbox });
        const ask = answering(true);
        // Below the top level: `find src -delete` would remove the top-level `src`, a name claim that asks (K3c, #783).
        const { results } = await runOn("userScripts", [runs(["find", "src/gen", "-delete"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
        assert.equal(ask.asked.length, sandbox ? 0 : 1, `sandbox ${sandbox}`);
        if (!sandbox) assert.equal(ask.asked[0].facts.placement, "host-plain");
        assert.equal(valueOf(results[0]).approvedBy, sandbox ? "builtin" : "person");
    }
});

test("K3c: removing a top-level name of a root asks even under the sandbox, and the card names it", T, async () => {
    const host = fakeNativeHost({ sandbox: true });
    const ask = answering(true);
    const { results } = await runOn("userScripts", [runs(["find", "src", "-delete"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    assert.equal(ask.asked.length, 1, "a names write on a top-level entry is outside the sandbox's bound");
    assert.equal(ask.asked[0].facts.placement, "host-sandbox");
    assert.ok(ask.asked[0].facts.paths.some((p) => p.topLevel === true), "the facts say which path is top-level");
    assert.equal(valueOf(results[0]).approvedBy, "person");
});

test("reads inside the roots are free even on the plain host (EFFECTS.md: effects within bound ∪ ReadsInRoots)", T, async () => {
    const host = fakeNativeHost({ sandbox: false });
    const ask = answering(true);
    const { results } = await runOn("userScripts", [runs(["ls"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    assert.equal(ask.asked.length, 0);
    assert.equal(valueOf(results[0]).approvedBy, "builtin");
});

// --- policies ---

test("a saved deny refuses the call without a card, naming the policy; the host discards it", T, async () => {
    const host = fakeNativeHost();
    const ask = answering(true);
    const deny = { id: "p1", scope: "global", consumer: "sh", effect: "deny", source: "(c) => c.argv[0] === \"ls\"", label: "never ls" };
    const { results } = await runOn("userScripts", [runs(["ls"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep, localExtra: { ml_policies_global: [deny] } });
    const r = valueOf(results[0]);
    assert.equal(r.code, "Denied");
    assert.match(r.threw, /never ls/);
    assert.equal(ask.asked.length, 0);
    assert.ok(host.names().includes("discard") && !host.names().includes("start"));
});

// --- the version probe (the coordinator's ruling) ---

test("git under the sandbox: its version is probed once with the manifest's own args, the call is described, and the probe is cached", T, async () => {
    const host = fakeNativeHost({ done: (_id, spawn) => spawn?.argv?.[1] === "--version" ? { out: "git version 2.44.0\n", err: "", code: 0 } : { out: "", err: "", code: 0 } });
    const ask = answering(true);
    const { results } = await runOn("userScripts", [runs(["git", "status"]), runs(["git", "status"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    const probes = host.calls.filter((c) => c.call === "spawn" && c.args.argv[1] === "--version");
    assert.equal(probes.length, 1, "probed once; the second call read the cache");
    assert.deepEqual(probes[0].args.argv, ["/usr/bin/git", "--version"], "the resolved program, never a PATH lookup again");
    assert.equal(probes[0].args.timeoutMs, 2000);
    for (const res of results) assert.equal(valueOf(res).ok, true);
    assert.equal(ask.asked.length, 0, "described and inside the roots: no card");
});

test("git on the plain host: no probe is raised, so the call is undescribed and asks", T, async () => {
    const host = fakeNativeHost({ sandbox: false });
    const ask = answering(true);
    await runOn("userScripts", [runs(["git", "status"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    assert.equal(host.calls.filter((c) => c.call === "spawn").length, 1, "only the call itself");
    assert.equal(ask.asked.length, 1);
    assert.equal(ask.asked[0].facts.program.version, null);
    assert.match(ask.asked[0].facts.why.join(" "), /version was not reported/);
});

test("a git inside the workspace roots is never probed: the script could have written it", T, async () => {
    const host = fakeNativeHost({ facts: (args) => ({ argv: args.argv, program: { path: "/w/proj/bin/git", inRoot: true, fingerprint: "9:9:9:9" }, cwd: { path: args.cwd, inRoot: true }, env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: null, paths: [], effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox" }) });
    const ask = answering(true);
    await runOn("userScripts", [runs(["git", "status"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    assert.equal(host.calls.filter((c) => c.call === "spawn").length, 1);
    assert.equal(ask.asked.length, 1, "undescribed: asks");
});

// --- outputs past their head ---

test("an output past its head stays held: ml.sh.read reads a range of it, and a short one is released at once", T, async () => {
    const big = "x".repeat(70000) + "TAIL";
    const host = fakeNativeHost({ done: () => ({ out: big, err: "e\n", code: 0 }) });
    const script = () => `(async () => { const r = await ml.sh.run(["ls"]); const part = await ml.sh.read(r.stdout.token, { offset: 70000, length: 10 }); return JSON.stringify({ complete: r.stdout.complete, size: r.stdout.size, part, errComplete: r.stderr.complete }); })()`;
    const { results } = await runOn("userScripts", [script], { ...NO_FETCH, onNative: host.onNative, configExtra: ON });
    const v = valueOf(results[0]);
    assert.deepEqual([v.complete, v.size, v.errComplete], [false, 70004, true]);
    assert.deepEqual([v.part.text, v.part.offset, v.part.eof], ["TAIL", 70000, true]);
    const released = host.calls.filter((c) => c.call === "release").map((c) => c.args.ptr);
    assert.equal(released.length, 1, "the short stderr was released; the long stdout is held");
});

// --- every call has an owner and a memory bound (SHELL.md, Root L) ---

test("each spawn names its run and step as its owner; a script cannot name one", T, async () => {
    const host = fakeNativeHost({ done: () => ({ out: "", err: "", code: 0 }) });
    const { results, hash } = await runOn("userScripts", [runs(["ls"], { owner: { run: "someone-else" } }), runs(["ls"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON });
    assert.equal(valueOf(results[0]).code, "BadRequest", "an owner option is refused before anything is spawned");
    const spawns = host.calls.filter((c) => c.call === "spawn");
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].args.owner?.run, hash, JSON.stringify(spawns[0].args));
    assert.equal(typeof spawns[0].args.owner?.seq, "number");
});

test("a call the host killed past its memory bound is a result with killed oom and its peak, and the run log says so", T, async () => {
    const host = fakeNativeHost({ done: () => ({ out: "", err: "", code: 0, killed: "oom", peakFootprint: 140 << 20, memoryBound: 128 << 20 }) });
    const { results, bg, hash } = await runOn("userScripts", [runs(["ls"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON });
    const r = valueOf(results[0]);
    assert.equal(r.ok, false);
    assert.equal(r.killed, "oom");
    assert.equal(r.peakFootprint, 140 << 20);
    assert.equal(r.memoryBound, 128 << 20);
    assert.match(r.error, /memory bound/);
    const ran = (await bg.context.__mlRunLog.all()).filter((x) => x.run === hash && x.subsystem === "shell" && x.kind === "run");
    assert.equal(ran.length, 1);
    assert.equal(ran[0].level, "warn");
    assert.deepEqual([ran[0].detail.killed, ran[0].detail.peakFootprint], ["oom", 140 << 20]);
});

test("an older host's done (no footprint fields) still makes a result, with none of them", T, async () => {
    const host = fakeNativeHost({ done: () => ({ out: "", err: "", code: 0 }) });
    const { results } = await runOn("userScripts", [runs(["ls"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON });
    const r = valueOf(results[0]);
    assert.equal(r.ok, true);
    assert.deepEqual([r.killed, r.peakFootprint, r.memoryBound], [undefined, undefined, undefined]);
});

// --- the event lane gets each call's footprint on the step that made it ---

test("the finished step carries its ml.sh calls with peak and bound; a killed one says so; an older host's carries neither", T, async () => {
    for (const [done, expect] of [
        [{ peakFootprint: 300 * 1048576, memoryBound: 4096 * 1048576 }, { peakFootprint: 300 * 1048576, memoryBound: 4096 * 1048576 }],
        [{ killed: "oom", peakFootprint: 5000 * 1048576, memoryBound: 4096 * 1048576 }, { killed: "oom", peakFootprint: 5000 * 1048576, memoryBound: 4096 * 1048576 }],
        [{}, {}],
    ]) {
        const host = fakeNativeHost({ done: () => ({ out: "", err: "", code: 0, ...done }) });
        const seen = [];
        await runOn("userScripts", [runs(["/usr/bin/ls"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: (bg, ev) => { if (ev.shCalls) seen.push(ev); } });
        assert.equal(seen.length, 1, JSON.stringify(done));
        assert.equal(seen[0].shCalls.length, 1);
        const { durationMs, ...rest } = seen[0].shCalls[0];
        assert.equal(typeof durationMs, "number");
        assert.deepEqual(rest, { program: "ls", ...expect }, "the basename, and only the fields the host sent");
    }
});

// --- a pinned script that changed after its facts were read (root K, rulings of 2026-10-19) ---

/** Facts for `python3 x.py` whose script the host hashed, to `hashes[n]` on the n-th spawn (1-based). */
const hashedFacts = (hashes) => {
    let n = 0;
    return (args) => {
        n++;
        return {
            argv: args.argv, program: { path: "/usr/bin/python3", inRoot: false, fingerprint: "1:2:3:4" }, cwd: { path: args.cwd, inRoot: true },
            env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: null,
            paths: [{ arg: 1, given: "x.py", path: `${args.cwd}/x.py`, inRoot: true, secret: false, exists: true, sha256: hashes[n - 1] }],
            effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox",
        };
    };
};

test("PinChanged on a call no person approved: it is described again from fresh facts and judged afresh, once", T, async () => {
    const host = fakeNativeHost({ startError: (_id, n) => n === 0 ? "PinChanged" : undefined });
    const ask = answering(true);
    const { results } = await runOn("userScripts", [runs(["ls"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    const r = valueOf(results[0]);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(host.calls.filter((c) => c.call === "spawn").length, 2, "fresh facts");
    assert.equal(host.calls.filter((c) => c.call === "start").length, 2);
    // a second change, on the fresh call, is not retried a third time
    const twice = fakeNativeHost({ startError: () => "PinChanged" });
    const again = await runOn("userScripts", [runs(["ls"])], { ...NO_FETCH, onNative: twice.onNative, configExtra: ON, onStep: answering(true).onStep });
    assert.equal(valueOf(again.results[0]).code, "Denied");
    assert.equal(twice.calls.filter((c) => c.call === "start").length, 2, "no third attempt");
});

test("PinChanged on a call the PERSON approved is refused, naming both hashes, never a card to re-approve, and the run log has both", T, async () => {
    const A = "a".repeat(64), B = "b".repeat(64);
    const host = fakeNativeHost({ facts: hashedFacts([A, B]), startError: () => "PinChanged" });
    const ask = answering(true);
    const { results, bg, hash } = await runOn("userScripts", [runs(["python3", "x.py"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    const r = valueOf(results[0]);
    assert.equal(r.code, "Denied");
    assert.match(r.threw, new RegExp(`x\\.py changed between approval and start \\(sha256 ${A} approved, now ${B}\\): not run`));
    assert.equal(ask.asked.length, 1, "the one card the person answered; none to re-approve");
    assert.equal(host.calls.filter((c) => c.call === "start").length, 1, "nothing started after the change");
    assert.ok(host.calls.filter((c) => c.call === "discard").length >= 1, "the fresh facts are discarded");
    const log = (await bg.context.__mlRunLog.all()).filter((x) => x.run === hash && x.subsystem === "shell" && x.kind === "pin-changed");
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].detail.approved, log[0].detail.now], [A, B]);
});

// --- the sandbox envelope (K3): sent only to a sandboxed call on a host that can hold it ---

test("K3: an unsandboxed call is sent no envelope — the host refuses one — and still runs", T, async () => {
    const host = fakeNativeHost({ sandbox: false, landlockAbi: null });
    const { results } = await runOn("userScripts", [runs(["ls"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON });
    const r = valueOf(results[0]);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.ran, /-plain$/);
    const start = host.calls.find((c) => c.call === "start");
    assert.ok(start, "the call started");
    assert.equal("envelope" in start.args, false, "no envelope key on an unsandboxed call");
});

test("K3: a bwrap host without Landlock is sent no envelope — it cannot hold program-only — and still runs", T, async () => {
    const host = fakeNativeHost({ sandboxKind: "bwrap", landlockAbi: null });
    const { results } = await runOn("userScripts", [runs(["ls"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON });
    const r = valueOf(results[0]);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.ran, /-sandbox$/);
    const start = host.calls.find((c) => c.call === "start");
    assert.ok(start, "the call started");
    assert.equal("envelope" in start.args, false, "no envelope key when Landlock is unavailable");
});

test("K3: a K3 host is sent the envelope on start, and done reports what applied", T, async () => {
    for (const [sandboxKind, landlockAbi] of [["seatbelt", null], ["bwrap", 4]]) {
        const host = fakeNativeHost({
            sandboxKind, landlockAbi,
            done: () => ({ out: "x\n", err: "", code: 0, envelope: { write: "none", exec: "program-only" } }),
        });
        const { results } = await runOn("userScripts", [runs(["ls"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON });
        const r = valueOf(results[0]);
        assert.equal(r.ok, true, `${sandboxKind}: ${JSON.stringify(r)}`);
        const start = host.calls.find((c) => c.call === "start");
        assert.deepEqual(start.args.envelope, { write: "none", exec: "program-only" }, sandboxKind);
        assert.deepEqual(r.envelope, { write: "none", exec: "program-only" }, sandboxKind);
    }
});

// --- what the script is and is not given ---

test("a script that does not name ml.sh gets none, even in an isolated world reached by another key", T, async () => {
    const host = fakeNativeHost();
    const script = () => `(async () => { void ml.current; try { return JSON.stringify(await ml["s" + "h"].run(["ls"])); } catch (e) { return JSON.stringify({ threw: e.message }); } })()`;
    const { results } = await runOn("userScripts", [script], { ...NO_FETCH, onNative: host.onNative, configExtra: ON });
    assert.match(valueOf(results[0]).threw, /ml\.sh is not available/);
    assert.deepEqual(host.calls.filter((c) => c.call === "spawn"), [], "nothing reached the host");
});

test("with ml.sh off in Settings, the call is refused and the host is never started", T, async () => {
    const host = fakeNativeHost();
    const { results, bg } = await runOn("userScripts", [runs(["ls"])], { ...NO_FETCH, onNative: host.onNative });
    const r = valueOf(results[0]);
    assert.equal(r.code, "Refused");
    assert.match(r.threw, /turned off/);
    assert.deepEqual(bg.nativeConnects, []);
});


// --- the envelope the worker sends (K3, ruled 2026-10-19): derived from the APPROVED claims, never the script's word ---
// The envelope rides on `start` (both keys required; a missing one is BadRequest). A hello without
// `sandbox.landlockAbi` is pre-K3 and gets none. The floor is NO envelope, not an envelope missing `write`.
// A runner (`exec(process)` approved) gets NO envelope: both keys must derive, and a runner's writes derive from
// no manifest. Ruled in SHELL.md's envelope bullet and EFFECTS.md's exec row (window-ml #805).

test("hello.sandbox.landlockAbi gates the envelope: absent (pre-K3) gets none, null (macOS) gets one", { todo: "OPEN (K3 envelope, 2026-10-19): the builder gates on hello.sandbox.landlockAbi being PRESENT (a number on Linux, null on macOS). A pre-K3 host has no such key and silently ignores an envelope on start, so sending one would let the card claim a bound that never applied. fakeNativeHost's hello now supports opts.landlockAbi (default: the key's ABSENCE). The second assertion fails first: HostStart has no envelope field (src/shell/host-protocol.ts:240)." }, T, async () => {
    // Pre-K3: hello carries no landlockAbi → the worker sends no envelope.
    const old = fakeNativeHost();
    await runOn("userScripts", [runs(["ls"])], { ...NO_FETCH, onNative: old.onNative, configExtra: ON });
    const oldStart = old.calls.find((c) => c.call === "start");
    assert.equal("envelope" in (oldStart?.args ?? {}), false, "a pre-K3 hello gets no envelope on start");
    // K3 macOS: hello carries landlockAbi: null → the worker sends one.
    const mac = fakeNativeHost({ landlockAbi: null });
    await runOn("userScripts", [runs(["ls"])], { ...NO_FETCH, onNative: mac.onNative, configExtra: ON });
    const macStart = mac.calls.find((c) => c.call === "start");
    assert.ok(macStart?.args.envelope, "a K3 hello (landlockAbi: null) gets an envelope on start");
});

test("the write envelope is derived from the approved claims: none / roots / NO envelope for a top-level claim", { todo: `OPEN (K3 envelope, 2026-10-19): HostStart carries no envelope field (src/shell/host-protocol.ts:240: start(id) sends { id }). SHELL.md's envelope bullet and EFFECTS.md's B row: write: "none" when the claims carry no write(fs); write: "roots" when every write is nested and in-root; and a claim on a top-level NAME (absent entry, write-names at the top level, or on the root) that the person APPROVED gets NO envelope — the floor — since both keys are required and write would be the floor. The card says the floor applies. Envelope rides start, not spawn (PROTOCOL.md).` }, T, async () => {
    const host = fakeNativeHost({ landlockAbi: null });
    const ask = answering(true);
    const three = () => `(async () => {
        const a = await ml.sh.run(["ls"]).catch((e) => ({ threw: e.message }));
        const b = await ml.sh.run(["find", "src/gen", "-delete"]).catch((e) => ({ threw: e.message }));
        const c = await ml.sh.run(["find", "src", "-delete"]).catch((e) => ({ threw: e.message }));
        return JSON.stringify({ a: a.threw ?? "ran", b: b.threw ?? "ran", c: c.threw ?? "ran" });
    })()`;
    await runOn("userScripts", [three], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    const starts = host.calls.filter((c) => c.call === "start");
    assert.equal(starts.length, 3, "all three calls reached start");
    // No write claims: ls is read-only. Both keys derive → envelope sent.
    assert.deepEqual(starts[0].args.envelope, { write: "none", exec: "program-only" }, "a read-only call gets write: none");
    // Only nested in-root writes: find src/gen -delete is a names-write below a top-level directory.
    assert.deepEqual(starts[1].args.envelope, { write: "roots", exec: "program-only" }, "a nested in-root write gets write: roots");
    // A claim on a top-level NAME the person approved: find src -delete unlinks the top-level `src`.
    // The floor is NO envelope — both keys are required, and write would be the floor.
    assert.equal("envelope" in starts[2].args, false, "a top-level name claim gets the floor: no envelope at all");
});

test("a runner gets NO envelope: both keys must derive, and a runner's writes derive from no manifest", { todo: "OPEN (K3 envelope, 2026-10-19): ruled 2026-10-19 (window-ml #805). A call whose approved claims carry exec(process) (a RUNNER: find -exec, xargs, npm run) gets NO envelope at all: the envelope's two keys are both required, a runner starts programs no manifest describes, and find . -exec rm claims no write of its own. Under #805, exec: \"any\" with an envelope is NEVER sent — a runner gets none. General rule: the worker sends an envelope only when BOTH keys derive from the approved claims; when either does not, it sends none and the floor applies." }, T, async () => {
    const host = fakeNativeHost({ landlockAbi: null });
    const ask = answering(true);
    const two = () => `(async () => {
        const a = await ml.sh.run(["ls"]).catch((e) => ({ threw: e.message }));
        const b = await ml.sh.run(["find", ".", "-exec", "rm", "{}", ";"]).catch((e) => ({ threw: e.message }));
        return JSON.stringify({ a: a.threw ?? "ran", b: b.threw ?? "ran" });
    })()`;
    await runOn("userScripts", [two], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    const starts = host.calls.filter((c) => c.call === "start");
    assert.equal(starts.length, 2, "both calls reached start");
    // Correlate by order: the k-th spawn is answered c<k>. Assert both lookups are defined (never vacuous).
    const spawns = host.calls.filter((c) => c.call === "spawn");
    assert.equal(spawns.length, 2, "both calls reached spawn");
    // Non-runner, no exec(process): both keys derive → envelope sent.
    assert.deepEqual(starts[0].args.envelope, { write: "none", exec: "program-only" }, "a non-runner is spawned with both keys derived");
    // Runner (exec(process) approved): NO envelope — a runner's writes derive from no manifest.
    assert.equal("envelope" in starts[1].args, false, "a runner gets NO envelope: both keys must derive");
    // Under #805, no start ever carries exec: "any".
    for (const s of starts) assert.notEqual(s.args.envelope?.exec, "any", "exec: \"any\" is never sent under #805");
});

test("the script cannot set, widen or remove the envelope: an envelope key in options, env or argv never reaches start as a wider one", { todo: "OPEN (K3 envelope, 2026-10-19): rule 4 (sender, never message) — authority comes from what the worker verifies about who sent a call, never from a field in it. The envelope is derived from the APPROVED ShFacts and what the worker SENDS on start is that, whatever the script put in ml.sh.run's options, its env or its argv. parseShRun refuses an unknown option by name (sh-call.ts:130, safe: nothing sent). The env and argv legs are ignored by construction. Assert on start, not spawn (envelope rides start/pipe)." }, T, async () => {
    const host = fakeNativeHost({ landlockAbi: null });
    const three = () => `(async () => {
        const a = await ml.sh.run(["ls"], { envelope: { write: "roots", exec: "any" } }).catch((e) => ({ threw: e.message }));
        const b = await ml.sh.run(["ls"], { env: { envelope: "roots" } }).catch((e) => ({ threw: e.message }));
        const c = await ml.sh.run(["ls", "envelope=roots"]).catch((e) => ({ threw: e.message }));
        return JSON.stringify({ a: a.threw ?? "ran", b: b.threw ?? "ran", c: c.threw ?? "ran" });
    })()`;
    await runOn("userScripts", [three], { ...NO_FETCH, onNative: host.onNative, configExtra: ON });
    const starts = host.calls.filter((c) => c.call === "start");
    // The options leg is refused by parseShRun (safe: nothing sent); the env and argv legs reach start.
    assert.ok(starts.length >= 2, `the env and argv legs reach start (got ${starts.length} starts)`);
    for (const [i, s] of starts.entries()) {
        assert.deepEqual(s.args.envelope, { write: "none", exec: "program-only" }, `call ${i}: the derived envelope is sent, never the script's`);
        assert.notEqual(s.args.envelope?.write, "roots", `call ${i}: the script's "roots" never widens the envelope`);
        assert.notEqual(s.args.envelope?.exec, "any", `call ${i}: the script's "any" never widens the exec envelope`);
    }
});

test("done.envelope is compared against what was sent: the record carries the host's applied envelope; absent is null", { todo: "OPEN (K3 envelope, 2026-10-19): HostDone carries no envelope (host-protocol.ts:104-121) and shResult (sh-call.ts:407-418) reads none. The ruled shape is ShResult.envelope: HostDoneEnvelope | null — required and null-able, where null means the host reported none. Assert r.envelope verbatim. For the mismatch (host reports wider than sent, or write: \"today\" when \"roots\" was sent), the card or the run log names both sent and applied — drop the separate marker until a field is ruled. The absent case is assert.strictEqual(r2.envelope, null) — not r2.envelope ?? \"unknown\", which also passes when the field is missing altogether." }, T, async () => {
    // The host reports write: "today" (the floor) when the worker sent write: "roots" for a nested write: a mismatch.
    const host = fakeNativeHost({ landlockAbi: null, done: () => ({ out: "", err: "", code: 0, envelope: { write: "today", exec: "program-only" } }) });
    const { results } = await runOn("userScripts", [runs(["find", "src/gen", "-delete"])], {
        ...NO_FETCH, onNative: host.onNative, configExtra: ON,
    });
    const r = valueOf(results[0]);
    // The record carries what the host APPLIED, not what was sent: the mismatch is visible.
    assert.deepEqual(r.envelope, { write: "today", exec: "program-only" }, "the host's applied envelope is what the record carries");
    assert.notEqual(r.envelope?.write, "roots", "…never silently rewritten to what was sent");
    // Absent envelope on done = pre-K3 host = null (the field is present and null-able).
    const old = fakeNativeHost({ landlockAbi: null });
    const r2 = valueOf((await runOn("userScripts", [runs(["ls"])], { ...NO_FETCH, onNative: old.onNative, configExtra: ON })).results[0]);
    assert.strictEqual(r2.envelope, null, "an absent envelope on done is null, never undefined or missing");
});

test("the same script and the same approval derive the same envelope wherever the call is issued and however it is judged", { todo: "OPEN (K3 envelope, 2026-10-19): rule 5 (placement is unobservable) — the same script gives the same result wherever it runs. The envelope is a function of the APPROVED ShFacts alone, so an ml.sh call issued from exec, the same call issued from python_exec, and the same call re-judged after a policy is stored all derive one envelope. Read start, not spawn (envelope rides start/pipe). The python_exec leg is not reachable from this harness; it is named so the builder routes python_exec through one sw-shell-call.ts derivation, not a second." }, T, async () => {
    // Issuer 1: a free call from exec (the built-in allow).
    const host = fakeNativeHost({ landlockAbi: null });
    await runOn("userScripts", [runs(["ls"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON });
    const first = host.calls.find((c) => c.call === "start")?.args.envelope;
    // Issuer 3: the same call re-judged after a policy is stored (a remembered allow changes what asks, never what is sent).
    const allow = { id: "p-envelopes", scope: "global", consumer: "sh", effect: "allow", source: "(c) => c.argv[0] === \"ls\"", label: "always ls" };
    await runOn("userScripts", [runs(["ls"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, localExtra: { ml_policies_global: [allow] } });
    const rejudged = host.calls.filter((c) => c.call === "start").at(-1)?.args.envelope;
    assert.deepEqual(rejudged, first, "a stored policy's allow changes what asks, never what is sent");
    // Issuer 2 (python_exec): the derivation is one path in sw-shell-call.ts.
    assert.ok(first, "there is a derived envelope to compare across issuers");
});
