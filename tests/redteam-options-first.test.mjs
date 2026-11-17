// redteam-options-first.test.mjs — the OPTIONS-FIRST repair (window-ml#1951, branch manifests/options-first at c870f47b):
// a flag placed AFTER an operand, and every spelling of it, must never be described as a flag and then read by the
// program as a file name the host never resolved. `cat f -n`, with `-n` a symlink to `.env`, printed the secret on
// macOS while main described it as reading `f` alone. The lane's own rows (tests/program-manifest.test.mjs,
// AFTER_OPERAND) pin one shape per shipped manifest; these enumerate the spellings, the terminator, the paths that only
// LOOK like flags, the ten manifests left without `optionsFirst`, a stored copy of the old shape, and one call made
// through ml.sh in an isolated world and in the read-only dialect.
//
// Section A also MEASURES the sibling gap the repair did not close: a lone `-` is a FILE NAME for macOS `head`, `tail`,
// `wc` and `ls` (GNU head/tail/wc read stdin, ls names the file on both), and no manifest sets `dashIsPath` for them, so
// `head f -` and `wc -` are described as reading `f` or nothing while the file named `-` is opened. That row is written
// as the property and reds at c870f47b: it is a finding for the lane, not a passing check.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runOn } from "./isolated-harness.mjs";
import { fakeNativeHost } from "./fake-native-host.mjs";

const { describeCall } = await import("../src/shell/program-manifest.ts");
const { planSpawn, shFacts, manifestFor, manifestsFor, SHIPPED_MANIFESTS } = await import("../src/shell/sh-call.ts");
const { parseShRun } = await import("../src/shell/sh-call.ts");
const { storeRefusal, validStored } = await import("../src/shell/stored-manifests.ts");

const T = { timeout: Number(process.env.ML_SH_T) || 60000 };
const FIVE = ["cat", "head", "tail", "wc", "ls"];
const MANIFESTS = new URL("../src/shell/manifests/", import.meta.url);
const FIXTURES = new URL("./fixtures/program-calls/", import.meta.url);
const OLD = new URL("./fixtures/manifests-before-options-first/", import.meta.url);
const manifests = Object.fromEntries(fs.readdirSync(MANIFESTS).filter((f) => f.endsWith(".json")).map((f) =>
    [path.basename(f, ".json"), JSON.parse(fs.readFileSync(new URL(f, MANIFESTS), "utf8"))]));
const fixtures = Object.fromEntries(fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).map((f) =>
    [path.basename(f, ".json"), JSON.parse(fs.readFileSync(new URL(f, FIXTURES), "utf8"))]));
const oldShape = (name) => JSON.parse(fs.readFileSync(new URL(`${name}.json`, OLD), "utf8"));
/** The version a call of this program reports, so a manifest with a range parses instead of answering "not reported". */
const V = (name) => ({ version: fixtures[name].version });
/** Every command of a manifest with its subcommand path: [path, spec]. */
function commands(cmd, at = []) {
    return [[at, cmd], ...Object.entries(cmd.subcommands ?? {}).flatMap(([n, s]) => commands(s, [...at, n]))];
}
/** The first flag of a command that takes no value, else one that takes one: a spelling to put after an operand. */
function aFlag(c) {
    const flags = Object.keys(c.flags ?? {});
    const f = flags.find((x) => !c.flags[x].value && !c.flags[x].optionalValue) ?? flags.find((x) => c.flags[x].value);
    return f === undefined ? null : { flag: f, takesValue: !!c.flags[f].value, optional: !!c.flags[f].optionalValue, clusters: !!c.clusters, numeric: !!c.numericFlag };
}
/** What the manifest's own words are: the refusal every post-operand dash argument gets. */
const AFTER = /follows an operand/;

// --- A: the five repaired manifests, every spelling of a post-operand flag ---

test("every listed flag, in every spelling it can take, is unknown after an operand — and the operands it saw are still named", T, () => {
    // MUTATION: `optionsFirst` dropped from any of the five reds that manifest's rows here, at the first spelling.
    for (const name of FIVE) {
        const m = manifests[name];
        assert.equal(m.command.optionsFirst, true, `${name}.json is one of the repaired five`);
        for (const [flag, spec] of Object.entries(m.command.flags)) {
            const spellings = [[flag, ...(spec.value ? ["v"] : [])]];
            if (flag.startsWith("--")) { if (spec.value) spellings.push([`${flag}=v`]); }
            else if (spec.value) spellings.push([`${flag}v`]);
            else if (m.command.clusters) spellings.push([`${flag}${Object.keys(m.command.flags).find((f) => f !== flag && f.startsWith("-") && !f.startsWith("--") && !m.command.flags[f].value)?.slice(1) ?? ""}`]);
            for (const s of spellings) {
                const argv = [name, "f", ...s];
                const d = describeCall(argv, m, V(name));
                assert.equal(d.described, false, `${argv.join(" ")}: described as ${JSON.stringify(d.effects)}`);
                assert.ok(d.why.some((w) => AFTER.test(w)), `${argv.join(" ")}: unknown for another reason: ${d.why.join("; ")}`);
                // The operands it SAW are still named, so the person reads which paths the call is about (`v`, a flag's
                // value, is one the scanner counted as an operand: when the call is undescribed that is information only).
                const at = d.pathArgs.map((p) => p.arg);
                assert.ok(at.includes(1), `${argv.join(" ")}: the operand it did see is not named`);
                assert.ok(!at.some((i) => argv[i].startsWith("-")), `${argv.join(" ")}: a dash argument is a path the host resolves: ${at.map((i) => argv[i]).join(", ")}`);
            }
        }
        if (m.command.numericFlag) for (const n of ["-5", "-20"]) {
            const d = describeCall([name, "f", n], m, V(name));
            assert.equal(d.described, false, `${name} f ${n}: a numeric flag after an operand was described`);
            assert.ok(d.why.some((w) => AFTER.test(w)), `${name} f ${n}: ${d.why.join("; ")}`);
        }
    }
});

test("the terminator: before any operand it makes a dash argument a PATH, after one it is unknown", T, () => {
    for (const name of FIVE) {
        // `cat -- -n`: both parsers read `-n` as a file name, so the host must resolve exactly that.
        const d = describeCall([name, "--", "-n"], manifests[name], V(name));
        assert.equal(d.described, true, `${name} -- -n: ${d.why.join("; ")}`);
        assert.deepEqual(d.pathArgs.map((p) => p.arg), [2], `${name} -- -n: the file named -n is not the path the host resolves`);
        // `cat f -- -n`: BSD reads `--` itself as a file name and GNU stops at it, so the two disagree: unknown.
        const after = describeCall([name, "f", "--", "-n"], manifests[name], V(name));
        assert.equal(after.described, false, `${name} f -- -n: described as ${JSON.stringify(after.effects)}`);
        assert.ok(after.why.some((w) => AFTER.test(w)), `${name} f -- -n: ${after.why.join("; ")}`);
        // The terminator this command does not honour is unknown wherever it stands.
        assert.equal(describeCall([name, "f", "--end-of-options"], manifests[name], V(name)).described, false, `${name} f --end-of-options`);
    }
});

test("an operand that LOOKS like a flag stays a path operand, before and after another operand, and after --", T, () => {
    // The repair must not push `./-n` into the refusal: both parsers read it as a file name, and the host must resolve it.
    for (const name of FIVE) {
        for (const [argv, at] of [[[name, "./-n"], [1]], [[name, "f", "./-n"], [1, 2]], [[name, "--", "./-n"], [2]]]) {
            const d = describeCall(argv, manifests[name], V(name));
            assert.equal(d.described, true, `${argv.join(" ")}: ${d.why.join("; ")}`);
            assert.deepEqual(d.pathArgs.map((p) => p.arg), at, `${argv.join(" ")}: the path it names`);
        }
    }
});

test("a flag after a SECOND operand is unknown too, and both operands it saw are named", T, () => {
    for (const name of FIVE) {
        const f = aFlag(manifests[name].command);
        const argv = [name, "f", "g", f.flag, ...(f.takesValue ? ["v"] : [])];
        const d = describeCall(argv, manifests[name], V(name));
        assert.equal(d.described, false, `${argv.join(" ")}: described as ${JSON.stringify(d.effects)}`);
        assert.ok(d.why.some((w) => AFTER.test(w)), `${argv.join(" ")}: ${d.why.join("; ")}`);
        const at = d.pathArgs.map((p) => p.arg);
        assert.ok(at.includes(1) && at.includes(2), `${argv.join(" ")}: the operands it did see are not both named`);
        assert.ok(!at.some((i) => argv[i].startsWith("-")), `${argv.join(" ")}: the flag, or a dash argument, is a path the host resolves: ${at.map((i) => argv[i]).join(", ")}`);
    }
});

test("the shapes the repair must NOT change: a flag before any operand, operands alone, and the lone dash for cat", T, () => {
    for (const name of FIVE) {
        const f = aFlag(manifests[name].command);
        const first = describeCall([name, f.flag, ...(f.takesValue ? ["v"] : []), "f"], manifests[name], V(name));
        assert.equal(first.described, true, `${name}: a flag before an operand is refused: ${first.why.join("; ")}`);
        assert.deepEqual(first.pathArgs.map((p) => p.arg), [f.takesValue ? 3 : 2], `${name}: the operand after a flag`);
        const plain = describeCall([name, "f", "g"], manifests[name], V(name));
        assert.equal(plain.described, true, `${name}: two operands and no flag`);
        assert.deepEqual(plain.pathArgs.map((p) => p.arg), [1, 2], name);
    }
    // cat's `-` is stdin on both platforms, so it is not a path and the call stays described: the control for the row below.
    for (const argv of [["cat", "f", "-"], ["cat", "-"]]) {
        const d = describeCall(argv, manifests.cat, V("cat"));
        assert.equal(d.described, true, `${argv.join(" ")}: ${d.why.join("; ")}`);
        assert.ok(!d.pathArgs.some((p) => argv[p.arg] === "-"), `${argv.join(" ")}: cat's - was resolved as a path`);
    }
});

// MEASURED at c870f47b, macOS 26.7, in a directory holding `f`, `.env` and a symlink `-` → `.env`:
//   /usr/bin/head f -        prints SECRETLINE       /usr/bin/head -        prints SECRETLINE
//   /usr/bin/tail f -        prints SECRETLINE       /usr/bin/wc f -        counts the target (11 bytes)
//   /bin/ls f -              lists the link          /usr/bin/wc -          counts the target
//   /bin/cat f -             reads stdin (nothing of the target)
// GNU head, tail and wc read STDIN for `-`; GNU ls names the file, as BSD does. So for ls both platforms agree it is a
// path, and for head/tail/wc they disagree and only `unknown` is safe. `head f -` is the same defect as `cat f -n`: a
// path the host never resolved, opened by the program that the card says reads `f` (or nothing).
test("RED TEAM: a lone `-` is a FILE for head, tail, wc and ls on macOS, so it must be resolved or the call must ask", T, () => {
    // MUTATION for the fix: `dashIsPath: true` on head/tail/wc/ls (or a refusal of a lone `-` for them) greens this row,
    // because the host then resolves the file the program opens. cat keeps stdin: it is the row's control above.
    const stdin = new Set(["cat"]);
    for (const name of FIVE) {
        for (const argv of [[name, "f", "-"], [name, "-"], [name, "--", "-"]]) {
            const d = describeCall(argv, manifests[name], V(name));
            const resolved = d.pathArgs.some((p) => argv[p.arg] === "-");
            if (stdin.has(name)) { assert.ok(!resolved && d.described, `${argv.join(" ")}: cat's - must stay stdin`); continue; }
            assert.ok(!d.described || resolved, `${argv.join(" ")}: described as ${JSON.stringify(d.effects)} with no path for \`-\`, and macOS opens the file named - (head/tail print it, wc counts it, ls lists it)`);
        }
    }
});

// --- B: the ten manifests the repair left without optionsFirst ---

test("the ten: find refuses a post-operand option, rg, jq, git and gh parse it as the flag it is, and none reads it as a path", T, () => {
    // find's own grammar: after the paths, `-L` is an expression, and the manifest lists no such primary.
    const fd = describeCall(["find", ".", "-L"], manifests.find, V("find"));
    assert.equal(fd.described, false, "find . -L was described");
    // ... while the primaries it DOES list are judged here, which is why find needs no optionsFirst.
    const fn = describeCall(["find", ".", "-name", "x"], manifests.find, V("find"));
    assert.equal(fn.described, true, `find . -name x: ${fn.why.join("; ")}`);
    assert.ok(!fn.pathArgs.some((p) => [".", "-name", "x"][p.arg - 0] === "-name" && p.arg > 1), "find judged its own primary as a path");
    // The four whose binaries parse their own argv: the flag is a flag wherever it stands, so the facts do not move.
    for (const [name, first, last] of [
        ["rg", ["rg", "-n", "a", "f"], ["rg", "a", "f", "-n"]],
        ["jq", ["jq", "-c", ".", "f"], ["jq", ".", "f", "-c"]],
        ["git", ["git", "status", "-s"], ["git", "status", "README.md", "-s"]],
        ["gh", ["gh", "pr", "view", "--comments", "12"], ["gh", "pr", "view", "12", "--comments"]],
    ]) {
        const a = describeCall(first, manifests[name], V(name));
        const b = describeCall(last, manifests[name], V(name));
        assert.equal(b.described, true, `${last.join(" ")}: ${b.why.join("; ")}`);
        assert.deepEqual(b.effects, a.effects, `${last.join(" ")}: the facts differ from ${first.join(" ")}`);
    }
});

test("no shipped manifest, at any level, ever reads a post-operand flag as a path (enumerate every leaf command)", T, () => {
    let shapes = 0;
    for (const [name, m] of Object.entries(manifests)) {
        for (const [at, c] of commands(m.command)) {
            // A command that is itself a subcommand group selects one with its first operand; a find expression is not
            // options-then-operands. Both are judged by their own level, which the rows above cover.
            if (c.subcommands || c.syntax === "find") continue;
            const f = aFlag(c);
            if (!f) continue;
            const argv = [m.program, ...at, "f", f.flag, ...(f.takesValue ? ["v"] : [])];
            const flagAt = argv.indexOf(f.flag, 1 + at.length);
            const d = describeCall(argv, m, V(name));
            assert.ok(!d.pathArgs.some((p) => p.arg === flagAt), `${argv.join(" ")}: the flag was read as a path`);
            if (c.optionsFirst) assert.equal(d.described, false, `${argv.join(" ")}: optionsFirst did not refuse it`);
            shapes++;
        }
    }
    assert.ok(shapes >= 30, `the enumeration is over every leaf command, and it saw ${shapes}: the manifest shape changed`);
});

// --- C: a stored copy of the OLD shape is never the one read ---

/** A stored entry for the old (pre-repair) bytes of a program: what a machine that stored it before the repair holds. */
const oldEntry = (name, over = {}) => ({ id: `man-${name}-old`, scope: "global", manifest: oldShape(name), origin: "person", created: 1,
    pin: { path: `/bin/${name}`, fingerprint: "1:2:3:4", inRoot: false }, ...over });

test("the store refuses a manifest for a shipped program, in whatever shape: the old bytes, the current ones, or a script naming it", T, () => {
    for (const name of FIVE) {
        for (const manifest of [oldShape(name), manifests[name]]) {
            const why = storeRefusal({ scope: "global", manifest, origin: "person" }, [], SHIPPED_MANIFESTS);
            assert.match(String(why), /does not replace/, `${name}: a stored copy of the shipped manifest was accepted`);
        }
        const script = { program: name, entrypoint: { path: "tool.js", sha256: "0".repeat(64) },
            command: { effects: ["read"], paths: "operands", flags: {} } };
        assert.match(String(storeRefusal({ scope: "workspace", root: "/w", manifest: script, origin: "proposed" }, [], SHIPPED_MANIFESTS)),
            /does not replace/, `${name}: a workspace script manifest shadowed the shipped program`);
    }
    // The control: a program with no shipped manifest is still storable, so the refusals above are about the key.
    const mine = { program: "mytool", version: { range: "*", args: [], pattern: "" }, command: { effects: ["read"], paths: "operands", flags: {} } };
    assert.equal(storeRefusal({ scope: "global", manifest: mine, origin: "person", pin: { path: "/opt/mytool", fingerprint: "1:2:3:4", inRoot: false } }, [], SHIPPED_MANIFESTS), undefined);
});

test("an old copy read back from storage is dropped, and the call is still described by the shipped file, all the way to the facts", T, () => {
    for (const name of FIVE) {
        const entry = oldEntry(name);
        assert.equal(validStored(entry, "global", SHIPPED_MANIFESTS), false, `${name}: an old stored copy loaded`);
        assert.equal(validStored({ ...entry, scope: "workspace", root: "/w" }, "workspace", SHIPPED_MANIFESTS), false, `${name}: as a workspace entry`);
        const { list } = manifestsFor([entry], ["/w"]);
        assert.ok(!list.includes(entry.manifest), `${name}: the old object is in the list the call is described from`);
        assert.equal(manifestFor([name, "f", "-n"], { cwd: "/w", roots: ["/w"] }, list), SHIPPED_MANIFESTS[name], `${name}: the call was not described by the shipped file`);
        // The two call sites that take stored entries: the plan the host is sent, and the facts a policy judges.
        const p = planSpawn(parseShRun([[name, "f", "-n"]]), { cwd: "/w", roots: ["/w"], stored: [entry] });
        assert.equal(p.description?.described, false, `${name}: planSpawn described the call from the old copy`);
        assert.deepEqual(p.spawn.argv, [name, "f", "-n"], `${name}: the spawn is the call as written`);
        const facts = {
            argv: [name, "f", "-n"], program: { path: `/bin/${name}`, fingerprint: "1:2:3:4", inRoot: false },
            cwd: { path: "/w", inRoot: true }, env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: null,
            paths: [{ arg: 1, given: "f", path: "/w/f", inRoot: true, secret: false, exists: true }],
            effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox",
        };
        const f2 = shFacts(facts, fixtures[name].version, { roots: ["/w"], stored: [entry] });
        assert.equal(f2.described, false, `${name}: the facts described the call from the old copy`);
        assert.ok(f2.why.some((w) => AFTER.test(w)), `${name}: the facts' why is not the post-operand refusal: ${f2.why.join("; ")}`);
    }
});

// --- D: the same call through ml.sh, in an isolated world and in the read-only dialect ---

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
/** Answer every nested ask this way (`true`/`false`), or never (`null`), recording each one asked. */
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

// MUTATION: `optionsFirst` dropped from cat.json reds the first row (no ask) and greens nothing; the lone-dash gap above
// is why the pair below is worth having — the ask is the call's, and the same harness runs a described call free.
test("RED TEAM: a flag after an operand reached through ml.sh asks, and nothing starts until the person answers", T, async () => {
    const host = fakeNativeHost();
    const ask = answering(null);
    const { results } = await runOn("userScripts", [runs(["cat", "f", "-n"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    assert.ok(ask.asked.length >= 1, `no nested ask for a flag after an operand: ${JSON.stringify(results?.[0] ?? null).slice(0, 300)}`);
    assert.ok(!host.names().includes("start"), "the call started before the person answered");
    const spawn = host.calls.find((c) => c.call === "spawn");
    assert.ok(spawn, "the host was asked for the facts, so the card has them");
    assert.deepEqual(spawn.args.argv, ["cat", "f", "-n"], "the facts are for the call as written");
});

test("RED TEAM: declined, the post-operand call never starts and the script is told why", T, async () => {
    const host = fakeNativeHost();
    const ask = answering(false);
    const { results } = await runOn("userScripts", [runs(["cat", "f", "-n"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    assert.equal(ask.asked.length, 1, `exactly one card for the call: ${JSON.stringify(results?.[0] ?? null).slice(0, 300)}`);
    const r = valueOf(results[0]);
    assert.equal(r.code, "Denied", `the script saw ${JSON.stringify(r)}`);
    assert.ok(!host.names().includes("start"), "a declined call started");
});

test("the control: the same harness runs a described call with no card and a start", T, async () => {
    const host = fakeNativeHost({ done: () => ({ out: "out\n", err: "", code: 0 }) });
    const ask = answering(null);
    const { results } = await runOn("userScripts", [runs(["cat", "f"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON, onStep: ask.onStep });
    assert.equal(ask.asked.length, 0, `a described read asked: ${JSON.stringify(results?.[0] ?? null).slice(0, 300)}`);
    assert.ok(host.names().includes("start"), "the described call never started");
});

test("RED TEAM: a read-only dialect script that names ml.sh never runs it in the page's own world", T, async () => {
    // The survey is auto-approved and never prompts; a script naming ml.sh must therefore leave it, and with no isolated
    // world available the call is refused rather than run beside the page.
    const host = fakeNativeHost();
    const { results } = await runOn("readonly", [runs(["cat", "f", "-n"])], { ...NO_FETCH, onNative: host.onNative, configExtra: ON });
    assert.match(String(results[0] ?? ""), /isolated world/, `the survey ran it anyway: ${String(results[0] ?? "").slice(0, 300)}`);
    assert.ok(!host.names().includes("spawn") && !host.names().includes("start"), `the host was asked to run a survey script's call: ${JSON.stringify(host.names())}`);
});
